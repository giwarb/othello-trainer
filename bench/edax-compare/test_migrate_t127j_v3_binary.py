#!/usr/bin/env python3
"""T127j 移行(`migrate_t127j_v3_binary.py`)の回帰テスト。

v3バイナリ切替(`edaxExe: "wEdax-x86-64-v3.exe"`)への切り替えmigrationが、
(1) jsonl(レコード本体)を1バイトも変更しないこと、(2) 削除・切り詰めの経路を
一切持たないこと、(3) 2回実行しても安全(冪等)であり、方式境界の
`beforeRecordCount`が2回目以降も動かないこと、(4) 不整合(base不一致・
positionId重複・planに存在しないpositionId・想定外のSHAドリフト)を検出したら
書き換えずにエラー停止すること、を固定する。実サイズのexpanded1mコーパス
(base 200,000件・8シャード)は使わず、軽量なトイデータ(base 4件・2シャード)で
検証する(`test_migrate_t127h_warm_batch.py`のトイ環境様式を踏襲)。
"""

from __future__ import annotations

import contextlib
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import importlib.util

HERE = Path(__file__).resolve().parent

MIGRATE_SPEC = importlib.util.spec_from_file_location(
    "migrate_t127j_v3_binary", HERE / "migrate_t127j_v3_binary.py"
)
assert MIGRATE_SPEC and MIGRATE_SPEC.loader
migrate = importlib.util.module_from_spec(MIGRATE_SPEC)
MIGRATE_SPEC.loader.exec_module(migrate)
# `migrate_t127j_v3_binary.py`が内部で読み込んだ`gen_teacher_corpus`モジュール
# インスタンスをそのまま使う(T114/T127hのテストと同じ理由: 別インスタンスを
# importlibで読み込むと`mock.patch.object(gen, ...)`が`migrate`側の参照に
# 反映されない)。
gen = migrate.gen

TOY_NUM_SHARDS = 2
TOY_BASE_COUNT = 4


def _plan_meta(num_shards: int = TOY_NUM_SHARDS) -> dict:
    return {
        "selectionStats": {"incrementalSelected": 100},
        "selectionPlanSha256": "master-sha",
        "shardPlanSha256": [f"shard-{i}" for i in range(num_shards)],
        "provenance": {
            "baseCorpus": {"jsonlSha256": "base-sha", "manifestSha256": "manifest-sha"},
            "incrementalGeneration": {
                "generatorSha256": "stale-planned-sha",
                "teacherCandidatesToolSha256": "current",
                "edaxSha256": "current",
                "edaxEvalDataSha256": "current",
                "candidatePoolSha256": "pool",
                "selectionPlanSha256": "master-sha",
            },
        },
    }


class SettingsAndMetaForShardTests(unittest.TestCase):
    def test_patches_generator_sha_only_and_does_not_mutate_input(self) -> None:
        plan_meta = _plan_meta(1)
        original = copy.deepcopy(plan_meta)
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, run_key, meta = migrate.settings_and_meta_for_shard(0, plan_meta)
        self.assertEqual(settings["edaxParentsPerProcess"], 32)
        self.assertEqual(settings["edaxExe"], gen.CORPUS_SETS["expanded1m"]["edaxExe"])
        self.assertEqual(json.dumps(settings, sort_keys=True), run_key)
        self.assertEqual(meta["harnessSha256"], "current")
        self.assertEqual(meta["edaxExeSha256"], "current")
        # 呼び出し元が渡したplan_metaの実体は変更されない(メモリ上の複製にのみ適用)。
        self.assertEqual(plan_meta, original)


class CheckPlanExecutionShaGateTests(unittest.TestCase):
    def test_generator_only_mismatch_is_accepted_and_reported(self) -> None:
        plan_meta = _plan_meta(1)
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            result = migrate.check_plan_execution_sha_gate(plan_meta)
        self.assertEqual(result["mismatchedKeys"], ["generatorSha256"])
        self.assertTrue(result["generatorShaMismatch"])

    def test_no_mismatch_is_reported_cleanly(self) -> None:
        plan_meta = _plan_meta(1)
        plan_meta["provenance"]["incrementalGeneration"]["generatorSha256"] = "current"
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            result = migrate.check_plan_execution_sha_gate(plan_meta)
        self.assertEqual(result["mismatchedKeys"], [])
        self.assertFalse(result["generatorShaMismatch"])

    def test_unexpected_drift_beyond_generator_sha_raises(self) -> None:
        """teacher_candidates/Edax(既定バイナリ)/評価データのSHAが不一致なのは
        未知のドリフトであり、黙って通さずエラー停止する(T114/T127h堅牢化の流儀)。"""
        plan_meta = _plan_meta(1)
        plan_meta["provenance"]["incrementalGeneration"]["edaxSha256"] = "stale-edax"
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            with self.assertRaises(RuntimeError):
                migrate.check_plan_execution_sha_gate(plan_meta)


class EdaxExeBoundaryForShardTests(unittest.TestCase):
    def test_computes_boundary_when_absent(self) -> None:
        boundary = migrate.edax_exe_boundary_for_shard(
            existing_meta_doc={},
            old_settings={},
            new_settings={"edaxExe": "wEdax-x86-64-v3.exe"},
            record_count=36_672,
        )
        self.assertEqual(boundary["before"], gen.vs_edax.EDAX_EXE.name)
        self.assertEqual(boundary["after"], "wEdax-x86-64-v3.exe")
        self.assertEqual(boundary["beforeRecordCount"], 36_672)
        self.assertTrue(boundary["valuesIdentical"])
        self.assertEqual(boundary["evidence"], "t127i_edax_v3_ab_report.md")

    def test_preserves_existing_boundary_across_reapplies(self) -> None:
        """2回目以降のmigrateではrecord_countが増えていても、既に記録済みの
        beforeRecordCountは動かない(方式境界は切替の瞬間のスナップショットで
        あるべき)。"""
        existing_meta_doc = {
            "edaxExeBoundary": {
                "before": gen.vs_edax.EDAX_EXE.name,
                "after": "wEdax-x86-64-v3.exe",
                "beforeRecordCount": 36_672,
                "valuesIdentical": True,
                "evidence": "t127i_edax_v3_ab_report.md",
            }
        }
        boundary = migrate.edax_exe_boundary_for_shard(
            existing_meta_doc=existing_meta_doc,
            old_settings={"edaxExe": "wEdax-x86-64-v3.exe"},
            new_settings={"edaxExe": "wEdax-x86-64-v3.exe"},
            record_count=40_000,  # 再開後にレコードが増えた想定
        )
        self.assertEqual(boundary, existing_meta_doc["edaxExeBoundary"])


def _write_jsonl_line(fh, obj: dict) -> None:
    fh.write(json.dumps(obj) + "\n")


class _ToyEnv:
    """base 4件・2シャードのトイデータ環境を一時ディレクトリに構築する。

    shard `i` は base positionId {i, i+2} を再利用(reuse)し、incremental
    positionId {4+i} を1件だけ完了済み(部分生成の再現)として持つ。
    """

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.base_path = data_dir / "corpus_expanded200k.jsonl"
        self.jsonl_paths: dict[int, Path] = {}
        self.meta_paths: dict[int, Path] = {}
        self.plan_paths: dict[int, Path] = {}
        self._build()

    def _build(self) -> None:
        with self.base_path.open("w", encoding="utf-8", newline="\n") as fh:
            for pid in range(TOY_BASE_COUNT):
                _write_jsonl_line(fh, {"positionId": pid, "canonicalKey": [pid, 0, 0]})
        base_lines = self.base_path.read_text(encoding="utf-8").splitlines(keepends=True)
        base_by_id = {json.loads(line)["positionId"]: line for line in base_lines}

        for shard_index in range(TOY_NUM_SHARDS):
            plan_path = self.data_dir / f"corpus_expanded1m_shard{shard_index}of8.plan.jsonl"
            with plan_path.open("w", encoding="utf-8", newline="\n") as fh:
                _write_jsonl_line(fh, {"kind": "reuse", "positionId": shard_index})
                _write_jsonl_line(fh, {"kind": "reuse", "positionId": shard_index + 2})
                _write_jsonl_line(fh, {"kind": "incremental", "positionId": 4 + shard_index})
            self.plan_paths[shard_index] = plan_path

            jsonl_path = self.data_dir / f"corpus_expanded1m_shard{shard_index}of8.jsonl"
            with jsonl_path.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(base_by_id[shard_index])
                fh.write(base_by_id[shard_index + 2])
                _write_jsonl_line(fh, {"positionId": 4 + shard_index})
            self.jsonl_paths[shard_index] = jsonl_path

            # 旧方式(T127h移行後): edaxParentsPerProcess=32はあるがedaxExeは無い
            # (=既定バイナリ、これがT127j移行の「before」状態)。
            old_settings = {
                "setName": "expanded1m",
                "shardIndex": shard_index,
                "numShards": TOY_NUM_SHARDS,
                "seed": 1,
                "edaxParentsPerProcess": 32,
                "elapsedMsPolicy": "cross-parent-level-batch-averaged",
            }
            meta_path = self.data_dir / f"corpus_expanded1m_shard{shard_index}of8.meta.json"
            meta_doc = {
                "schemaVersion": 2,
                "runKey": json.dumps(old_settings, sort_keys=True),
                "meta": {key: "old" for key in gen.PROVENANCE_IDENTITY_KEYS},
                "settings": old_settings,
                "reusedRecordCount": 2,
                "progress": {"done": 3, "total": 3},
            }
            meta_path.write_text(json.dumps(meta_doc, indent=2) + "\n", encoding="utf-8")
            self.meta_paths[shard_index] = meta_path


@contextlib.contextmanager
def _patched_toy_env():
    with tempfile.TemporaryDirectory() as temp_dir:
        data_dir = Path(temp_dir)
        env = _ToyEnv(data_dir)
        with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir), mock.patch.object(
            gen, "BASE_CORPUS_PATH", env.base_path
        ), mock.patch.object(gen, "EXPANDED1M_NUM_SHARDS", TOY_NUM_SHARDS), mock.patch.object(
            gen, "EXPANDED1M_BASE_COUNT", TOY_BASE_COUNT
        ), mock.patch.object(gen, "sha256_of_file", return_value="current"), mock.patch.object(
            gen.vs_edax, "git_commit_hash", return_value="head"
        ):
            yield env


class VerifyBaseImportIntegrityTests(unittest.TestCase):
    def test_passes_for_consistent_shards(self) -> None:
        with _patched_toy_env():
            results = migrate.verify_base_import_integrity()
        self.assertEqual(len(results), TOY_NUM_SHARDS)
        for result in results:
            self.assertEqual(result["baseStripeVerified"], 2)

    def test_detects_corrupted_base_record(self) -> None:
        with _patched_toy_env() as env:
            lines = env.jsonl_paths[0].read_text(encoding="utf-8").splitlines()
            tampered = json.loads(lines[0])
            tampered["canonicalKey"][0] += 999
            lines[0] = json.dumps(tampered)
            env.jsonl_paths[0].write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            with self.assertRaises(RuntimeError):
                migrate.verify_base_import_integrity()


class CountAndValidateShardRecordsTests(unittest.TestCase):
    def test_counts_base_and_incremental_correctly(self) -> None:
        with _patched_toy_env():
            stats = migrate.count_and_validate_shard_records(0)
        self.assertEqual(stats["totalRecords"], 3)
        self.assertEqual(stats["baseRecords"], 2)
        self.assertEqual(stats["incrementalRecords"], 1)

    def test_rejects_duplicate_position_id(self) -> None:
        with _patched_toy_env() as env:
            with env.jsonl_paths[0].open("a", encoding="utf-8", newline="\n") as fh:
                _write_jsonl_line(fh, {"positionId": 4})  # 既存のincrementalと重複
            with self.assertRaises(RuntimeError):
                migrate.count_and_validate_shard_records(0)

    def test_rejects_position_id_outside_plan(self) -> None:
        with _patched_toy_env() as env:
            with env.jsonl_paths[0].open("a", encoding="utf-8", newline="\n") as fh:
                _write_jsonl_line(fh, {"positionId": 999})  # planに存在しない
            with self.assertRaises(RuntimeError):
                migrate.count_and_validate_shard_records(0)

    def test_rejects_missing_base_record(self) -> None:
        with _patched_toy_env() as env:
            lines = env.jsonl_paths[0].read_text(encoding="utf-8").splitlines()
            del lines[0]  # base positionId=0を欠落させる
            env.jsonl_paths[0].write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            with self.assertRaises(RuntimeError):
                migrate.count_and_validate_shard_records(0)


class MigrateShardTests(unittest.TestCase):
    def test_apply_updates_settings_and_preserves_jsonl_bytes(self) -> None:
        with _patched_toy_env() as env:
            jsonl_before = env.jsonl_paths[0].read_bytes()
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            stats = migrate.migrate_shard(0, plan_meta, apply=True)

            self.assertTrue(stats["runKeyChanged"])
            self.assertFalse(stats["hadEdaxExe"])
            self.assertEqual(env.jsonl_paths[0].read_bytes(), jsonl_before)

            meta_doc = json.loads(env.meta_paths[0].read_text(encoding="utf-8"))
            self.assertEqual(meta_doc["settings"]["edaxParentsPerProcess"], 32)
            self.assertEqual(meta_doc["settings"]["edaxExe"], gen.CORPUS_SETS["expanded1m"]["edaxExe"])
            self.assertEqual(meta_doc["runKey"], json.dumps(meta_doc["settings"], sort_keys=True))
            self.assertEqual(meta_doc["progress"]["done"], 3)
            self.assertEqual(meta_doc["reusedRecordCount"], 2)
            self.assertNotEqual(meta_doc["meta"]["harnessSha256"], "old")
            self.assertEqual(meta_doc["meta"]["edaxExeSha256"], "current")

            boundary = meta_doc["edaxExeBoundary"]
            self.assertEqual(boundary["before"], gen.vs_edax.EDAX_EXE.name)
            self.assertEqual(boundary["after"], gen.CORPUS_SETS["expanded1m"]["edaxExe"])
            self.assertEqual(boundary["beforeRecordCount"], 3)
            self.assertTrue(boundary["valuesIdentical"])
            self.assertEqual(boundary["evidence"], "t127i_edax_v3_ab_report.md")

    def test_dry_run_does_not_modify_meta_or_jsonl(self) -> None:
        with _patched_toy_env() as env:
            jsonl_before = env.jsonl_paths[0].read_bytes()
            meta_before = env.meta_paths[0].read_bytes()
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            stats = migrate.migrate_shard(0, plan_meta, apply=False)

            self.assertTrue(stats["runKeyChanged"])  # 計算上は変わるはず、と分かるが書き込みはしない
            self.assertEqual(env.jsonl_paths[0].read_bytes(), jsonl_before)
            self.assertEqual(env.meta_paths[0].read_bytes(), meta_before)

    def test_idempotent_across_two_applies(self) -> None:
        with _patched_toy_env() as env:
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            jsonl_before = env.jsonl_paths[0].read_bytes()

            first = migrate.migrate_shard(0, plan_meta, apply=True)
            meta_after_first = json.loads(env.meta_paths[0].read_text(encoding="utf-8"))

            # 2回目のapply前に、この移行が実際に生成再開後を想定してjsonlへ
            # レコードが増えたケースを模す(方式境界は動いてはいけない)。
            with env.jsonl_paths[0].open("a", encoding="utf-8", newline="\n") as fh:
                _write_jsonl_line(fh, {"positionId": 4})  # このシャードのplan外だが
                # count_and_validate_shard_records は migrate_shard 内から呼ばれない
                # ため、migrate_shard自体は影響を受けない(record_countのみ変わる)。

            second = migrate.migrate_shard(0, plan_meta, apply=True)
            meta_after_second = json.loads(env.meta_paths[0].read_text(encoding="utf-8"))

            self.assertEqual(first["newRunKey"], second["newRunKey"])
            self.assertFalse(second["runKeyChanged"])  # 2回目はもう変化しない
            self.assertEqual(meta_after_first["settings"], meta_after_second["settings"])
            # 方式境界(切替時点のスナップショット)は1回目のまま維持される。
            self.assertEqual(meta_after_first["edaxExeBoundary"], meta_after_second["edaxExeBoundary"])
            self.assertEqual(meta_after_second["progress"]["done"], 4)
            # jsonlの元の3件分は2回のapplyを経ても一切変更されない(4件目は本テストが
            # 追記した分であり、migrate自身が書いたものではない)。
            self.assertEqual(env.jsonl_paths[0].read_bytes()[: len(jsonl_before)], jsonl_before)

    def test_migrate_shard_module_has_no_jsonl_write_mode_opens(self) -> None:
        """削除・切り詰めの経路が無いことをソースレベルでも固定する
        (jsonlファイルへの書き込みモードopenが本モジュールに一切無いことを確認)。"""
        source = (HERE / "migrate_t127j_v3_binary.py").read_text(encoding="utf-8")
        for forbidden in ('open("w"', "open('w'", 'open("a"', "open('a'", ".truncate(", ".unlink("):
            self.assertNotIn(forbidden, source, f"unexpected write/delete pattern found: {forbidden!r}")


class PostSwitchRerunGuardTests(unittest.TestCase):
    """redo#1(2026-07-18): 切替後(settings.edaxExeは付いているが、生成再開で
    TeacherCorpusCheckpoint._write_metaがedaxExeBoundaryを捨てた後)の再実行を
    検出し、境界を再計算せず拒否することを固定する。"""

    @staticmethod
    def _simulate_post_switch_boundary_loss(env, shard_index: int) -> dict:
        """このシャードのmetaを「切替は完了したがedaxExeBoundaryが失われた」
        状態に書き換える(実地で観測された`_write_meta`の挙動の再現)。"""
        meta_doc = json.loads(env.meta_paths[shard_index].read_text(encoding="utf-8"))
        meta_doc["settings"]["edaxExe"] = gen.CORPUS_SETS["expanded1m"]["edaxExe"]
        meta_doc["settings"]["edaxParentsPerProcess"] = 32
        meta_doc.pop("edaxExeBoundary", None)
        env.meta_paths[shard_index].write_text(
            json.dumps(meta_doc, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        return meta_doc

    def test_refuses_dry_run_when_boundary_already_lost(self) -> None:
        with _patched_toy_env() as env:
            meta_before = self._simulate_post_switch_boundary_loss(env, 0)
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            with self.assertRaisesRegex(RuntimeError, "edaxExeBoundary"):
                migrate.migrate_shard(0, plan_meta, apply=False)
            self.assertEqual(
                json.loads(env.meta_paths[0].read_text(encoding="utf-8")), meta_before
            )

    def test_refuses_apply_when_boundary_already_lost(self) -> None:
        with _patched_toy_env() as env:
            meta_before = self._simulate_post_switch_boundary_loss(env, 0)
            jsonl_before = env.jsonl_paths[0].read_bytes()
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            with self.assertRaisesRegex(RuntimeError, "corpus_expanded1m_method_boundaries.json"):
                migrate.migrate_shard(0, plan_meta, apply=True)
            # ガードが書き込みより前に発火し、meta/jsonlとも一切変更されていない。
            self.assertEqual(
                json.loads(env.meta_paths[0].read_text(encoding="utf-8")), meta_before
            )
            self.assertEqual(env.jsonl_paths[0].read_bytes(), jsonl_before)

    def test_does_not_refuse_when_boundary_present(self) -> None:
        """通常の冪等再実行(edaxExeBoundaryが既にある=本スクリプト自身が書いた
        直後の状態)ではガードは発火しない。"""
        with _patched_toy_env() as env:
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            first = migrate.migrate_shard(0, plan_meta, apply=True)
            second = migrate.migrate_shard(0, plan_meta, apply=True)  # 例外にならない
            self.assertEqual(first["newRunKey"], second["newRunKey"])

    def test_does_not_refuse_before_any_switch(self) -> None:
        """切替前(settings.edaxExeが無い=通常の初回実行)ではガードは発火しない。"""
        with _patched_toy_env():
            plan_meta = _plan_meta(TOY_NUM_SHARDS)
            migrate.migrate_shard(0, plan_meta, apply=False)  # 例外にならない


class BackupShardFilesTests(unittest.TestCase):
    def test_copies_all_files_then_skips_on_rerun(self) -> None:
        with _patched_toy_env() as env:
            copied = migrate.backup_shard_files()
            self.assertEqual(len(copied), TOY_NUM_SHARDS * 2)
            for dest in copied:
                self.assertTrue(dest.exists())

            # 2回目は既に全ファイルが揃っているためスキップされる(冪等)。
            copied_again = migrate.backup_shard_files()
            self.assertEqual(len(copied_again), len(copied))

            backup_dir = migrate.backup_dir()
            for shard_index in range(TOY_NUM_SHARDS):
                self.assertEqual(
                    (backup_dir / env.jsonl_paths[shard_index].name).read_bytes(),
                    env.jsonl_paths[shard_index].read_bytes(),
                )

    def test_refuses_partial_overwrite_without_force(self) -> None:
        with _patched_toy_env() as env:
            backup_dir = migrate.backup_dir()
            backup_dir.mkdir(parents=True, exist_ok=True)
            # 1ファイルだけ手動で先に置いておく(壊れかけのバックアップを模す)。
            only_one = backup_dir / env.jsonl_paths[0].name
            only_one.write_bytes(b"stale-partial-backup")

            with self.assertRaises(RuntimeError):
                migrate.backup_shard_files()

            # --force-backup相当のforce=Trueなら上書きして完走する。
            copied = migrate.backup_shard_files(force=True)
            self.assertEqual(len(copied), TOY_NUM_SHARDS * 2)
            self.assertEqual(only_one.read_bytes(), env.jsonl_paths[0].read_bytes())


class MethodBoundariesSidecarSchemaTests(unittest.TestCase):
    """redo#1(2026-07-18)対応: `teacher_manifests/corpus_expanded1m_method_boundaries.json`
    (T127h/T127jの方式境界を`_write_meta`の消失から守るサイドカー、コミット対象)の
    スキーマを固定する。このファイル自体はテスト対象コードではなく静的データなので、
    本テストは書き換えを一切行わず読み取り専用で検証する。"""

    SIDECAR_PATH = HERE / "teacher_manifests" / "corpus_expanded1m_method_boundaries.json"
    REQUIRED_BOUNDARY_KEYS = {"sequence", "change", "totalRecordsBefore", "perShard", "valuesIdentical", "evidence"}

    def _load(self) -> dict:
        self.assertTrue(self.SIDECAR_PATH.exists(), f"sidecar not found: {self.SIDECAR_PATH}")
        return json.loads(self.SIDECAR_PATH.read_text(encoding="utf-8"))

    def test_top_level_shape(self) -> None:
        doc = self._load()
        self.assertEqual(doc["corpus"], "expanded1m")
        self.assertIsInstance(doc["boundaries"], list)
        self.assertGreaterEqual(len(doc["boundaries"]), 2)

    def test_each_boundary_has_required_keys(self) -> None:
        doc = self._load()
        for boundary in doc["boundaries"]:
            missing = self.REQUIRED_BOUNDARY_KEYS - boundary.keys()
            self.assertFalse(missing, f"boundary {boundary.get('sequence')} missing keys: {missing}")
            self.assertTrue(boundary["valuesIdentical"] is True)
            self.assertIsInstance(boundary["evidence"], str)
            self.assertTrue(boundary["evidence"])

    def test_per_shard_sums_match_total_when_present(self) -> None:
        """`perShard`が捏造されていないことの最低限のチェック:
        指定されていれば合計が`totalRecordsBefore`と一致すること
        (`null`+`note`で「記録なし」を明示する側は対象外)。"""
        doc = self._load()
        for boundary in doc["boundaries"]:
            per_shard = boundary["perShard"]
            if per_shard is None:
                self.assertIn("note", boundary, f"boundary {boundary['sequence']}: perShard=null needs a note")
                continue
            self.assertEqual(
                sum(per_shard.values()),
                boundary["totalRecordsBefore"],
                f"boundary {boundary['sequence']}: perShard does not sum to totalRecordsBefore",
            )

    def test_boundary_sequence_2_matches_orchestrator_confirmed_v3_switch_values(self) -> None:
        """T127jのredo#1フィードバックに書かれたオーケストレーター確定値
        (総件数493,703・シャード別内訳)をそのまま固定する(再計算しない)。"""
        doc = self._load()
        boundary = next(b for b in doc["boundaries"] if b["sequence"] == 2)
        self.assertEqual(boundary["change"], "edaxExe: wEdax-x86-64.exe -> wEdax-x86-64-v3.exe")
        self.assertEqual(boundary["totalRecordsBefore"], 493_703)
        self.assertEqual(
            boundary["perShard"],
            {
                "0": 61760,
                "1": 61608,
                "2": 61831,
                "3": 61655,
                "4": 61795,
                "5": 61625,
                "6": 61670,
                "7": 61759,
            },
        )
        self.assertEqual(boundary["evidence"], "t127i_edax_v3_ab_report.md")

    def test_boundary_sequence_1_matches_t127h_worklog_total(self) -> None:
        """T127h切替時点の合計292,679件(tasks/T127h-warm-batch-switch.mdの作業ログの
        シャード別レコード数表)を固定する。"""
        doc = self._load()
        boundary = next(b for b in doc["boundaries"] if b["sequence"] == 1)
        self.assertEqual(boundary["totalRecordsBefore"], 292_679)
        self.assertEqual(boundary["evidence"], "t127g_warm_tt_ab_report.md")


if __name__ == "__main__":
    unittest.main()

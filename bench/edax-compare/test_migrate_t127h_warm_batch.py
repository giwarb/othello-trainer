#!/usr/bin/env python3
"""T127h フェーズ2移行(`migrate_t127h_warm_batch.py`)の回帰テスト。

親またぎバッチ方式(`edaxParentsPerProcess: 32`)への切り替えmigrationが、
(1) jsonl(レコード本体)を1バイトも変更しないこと、(2) 削除・切り詰めの経路を
一切持たないこと、(3) 2回実行しても安全(冪等)であること、(4) 不整合(base
不一致・positionId重複・planに存在しないpositionId・想定外のSHAドリフト)を
検出したら書き換えずにエラー停止すること、を固定する。実サイズのexpanded1m
コーパス(base 200,000件・8シャード)は使わず、軽量なトイデータ(base 4件・2シャード)
で検証する。
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
    "migrate_t127h_warm_batch", HERE / "migrate_t127h_warm_batch.py"
)
assert MIGRATE_SPEC and MIGRATE_SPEC.loader
migrate = importlib.util.module_from_spec(MIGRATE_SPEC)
MIGRATE_SPEC.loader.exec_module(migrate)
# `migrate_t127h_warm_batch.py`が内部で読み込んだ`gen_teacher_corpus`モジュール
# インスタンスをそのまま使う(T114のテストと同じ理由: 別インスタンスをimportlibで
# 読み込むと`mock.patch.object(gen, ...)`が`migrate`側の参照に反映されない)。
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
        self.assertEqual(settings["elapsedMsPolicy"], "cross-parent-level-batch-averaged")
        self.assertEqual(json.dumps(settings, sort_keys=True), run_key)
        self.assertEqual(meta["harnessSha256"], "current")
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
        """teacher_candidates/Edax/評価データのSHAが不一致なのは未知のドリフトであり、
        黙って通さずエラー停止する(T114堅牢化の流儀)。"""
        plan_meta = _plan_meta(1)
        plan_meta["provenance"]["incrementalGeneration"]["edaxSha256"] = "stale-edax"
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            with self.assertRaises(RuntimeError):
                migrate.check_plan_execution_sha_gate(plan_meta)


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

            old_settings = {
                "setName": "expanded1m",
                "shardIndex": shard_index,
                "numShards": TOY_NUM_SHARDS,
                "seed": 1,
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
        with _patched_toy_env() as env:
            results = migrate.verify_base_import_integrity()
        self.assertEqual(len(results), TOY_NUM_SHARDS)
        for result in results:
            self.assertEqual(result["baseStripeVerified"], 2)

    def test_detects_corrupted_base_record(self) -> None:
        with _patched_toy_env() as env:
            # shard0の先頭レコード(base positionId=0)を破損させる。
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
            self.assertEqual(env.jsonl_paths[0].read_bytes(), jsonl_before)

            meta_doc = json.loads(env.meta_paths[0].read_text(encoding="utf-8"))
            self.assertEqual(meta_doc["settings"]["edaxParentsPerProcess"], 32)
            self.assertEqual(meta_doc["settings"]["elapsedMsPolicy"], "cross-parent-level-batch-averaged")
            self.assertEqual(meta_doc["runKey"], json.dumps(meta_doc["settings"], sort_keys=True))
            self.assertEqual(meta_doc["progress"]["done"], 3)
            self.assertEqual(meta_doc["reusedRecordCount"], 2)
            self.assertNotEqual(meta_doc["meta"]["harnessSha256"], "old")

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

            second = migrate.migrate_shard(0, plan_meta, apply=True)
            meta_after_second = json.loads(env.meta_paths[0].read_text(encoding="utf-8"))

            self.assertEqual(first["newRunKey"], second["newRunKey"])
            self.assertFalse(second["runKeyChanged"])  # 2回目はもう変化しない
            self.assertEqual(meta_after_first["settings"], meta_after_second["settings"])
            self.assertEqual(meta_after_first["progress"]["done"], meta_after_second["progress"]["done"])
            # jsonlは2回のapplyを経ても一切変更されない。
            self.assertEqual(env.jsonl_paths[0].read_bytes(), jsonl_before)

    def test_migrate_shard_module_has_no_jsonl_write_mode_opens(self) -> None:
        """削除・切り詰めの経路が無いことをソースレベルでも固定する
        (jsonlファイルへの書き込みモードopenが本モジュールに一切無いことを確認)。"""
        source = (HERE / "migrate_t127h_warm_batch.py").read_text(encoding="utf-8")
        for forbidden in ('open("w"', "open('w'", 'open("a"', "open('a'", ".truncate(", ".unlink("):
            self.assertNotIn(forbidden, source, f"unexpected write/delete pattern found: {forbidden!r}")


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


if __name__ == "__main__":
    unittest.main()

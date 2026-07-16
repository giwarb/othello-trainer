#!/usr/bin/env python3
"""T090a teacher corpus pipeline regression tests (no Edax calls)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gen_teacher_corpus", HERE / "gen_teacher_corpus.py")
assert SPEC and SPEC.loader
gen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen)
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_teacher_corpus", HERE / "verify_teacher_corpus.py")
assert VERIFY_SPEC and VERIFY_SPEC.loader
verify = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(verify)


class TeacherCorpusTests(unittest.TestCase):
    @staticmethod
    def valid_corpus_record(
        board: str = "---------------------------OX------XO---------------------------", side: str = "black"
    ) -> dict:
        base = {"board": board, "sideToMove": side}
        legal = verify.compute_children([base])[0]["moves"]
        canonical = verify.compute_canonical_keys([base])[0]
        children = []
        for index, move in enumerate(legal):
            value = float(index)
            children.append(
                {
                    "move": move["move"],
                    "value": value,
                    "diffFromBest": float(len(legal) - 1 - index),
                    "exact": False,
                    "level": 16,
                    "edaxDepth": 16,
                    "elapsedMs": 1.0,
                }
            )
        return {
            "positionId": 0,
            "board": board,
            "sideToMove": side,
            "empties": board.count("-"),
            "source": "engineLoss",
            "phaseBin": None,
            "hasXcLegalMove": None,
            "openingKey": None,
            "priorityLoss": 4.0,
            "canonicalKey": canonical,
            "children": children,
            "bestMove": children[-1]["move"],
            "bestValue": children[-1]["value"],
            "generatedAt": "2026-07-15T00:00:00+00:00",
        }

    def assert_verifier_rejects(self, records: list[dict]) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8", newline="\n"
            )
            count = len(records)
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": count, "total": count}}) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                with mock.patch.object(verify.sys, "argv", ["verify_teacher_corpus.py", "smoke"]):
                    with self.assertRaises(SystemExit) as raised:
                        verify.main()
            self.assertEqual(raised.exception.code, 1)

    def test_edax_batch_parser_validates_problem_order_and_count(self) -> None:
        positions = [
            {"board": "board-one", "sideToMove": "black"},
            {"board": "board-two", "sideToMove": "white"},
        ]
        output = """*** problem # 1 ***
 depth|score| time | nodes | N/s | principal variation
    3   +04        0:00.001       10       10 d3
*** problem # 2 ***
 depth|score| time | nodes | N/s | principal variation
    5   -06        0:00.001       20       20 H8
"""
        parsed = gen.vs_edax._parse_edax_batch_output(output, positions, 16, 7, "ignored")
        self.assertEqual(
            parsed,
            [
                {"depth": 3, "discDiff": 4.0, "move": "d3"},
                {"depth": 5, "discDiff": -6.0, "move": "h8"},
            ],
        )
        for corrupt in (output.replace("problem # 2", "problem # 3"), output.split("*** problem # 2 ***")[0]):
            with self.assertRaisesRegex(RuntimeError, "ordering/count mismatch"):
                gen.vs_edax._parse_edax_batch_output(corrupt, positions, 16, 0, "")

    def test_label_position_batches_by_level_and_preserves_child_order(self) -> None:
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "engineLoss"}
        children_info = {
            "empties": 25,
            "moves": [
                {
                    "move": "a1",
                    "childBoard": "A" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 25,
                    "childIsTerminal": False,
                },
                {
                    "move": "b2",
                    "childBoard": "B" * 64,
                    "childSideToMove": "black",
                    "childEmpties": 24,
                    "childIsTerminal": False,
                },
                {
                    "move": "c3",
                    "childBoard": "C" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 25,
                    "childIsTerminal": False,
                },
            ],
        }
        calls = []

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            calls.append((level, [row["board"] for row in positions]))
            if level == gen.DEFAULT_EDAX_LEVEL:
                return [
                    {"depth": 16, "discDiff": -2.0, "move": "a1"},
                    {"depth": 16, "discDiff": 1.0, "move": "c3"},
                ]
            return [{"depth": 24, "discDiff": 5.0, "move": "b2"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            record = gen.label_position(9, position, children_info)

        self.assertEqual(calls, [(16, ["A" * 64, "C" * 64]), (60, ["B" * 64])])
        self.assertEqual([child["move"] for child in record["children"]], ["a1", "b2", "c3"])
        self.assertEqual([child["value"] for child in record["children"]], [2.0, 5.0, -1.0])
        self.assertEqual(record["bestValue"], 5.0)
        self.assertEqual(record["children"][0]["elapsedMs"], record["children"][2]["elapsedMs"])

    def test_label_position_respects_explicit_exact_empties_threshold(self) -> None:
        """T114移行(exactEmptiesThreshold 24→20 のexpanded200k版): `label_position`に
        既定(24)と異なる`exact_empties_threshold`を明示的に渡すと、その値で
        exact/level判定が行われることを確認する(childEmpties=21は閾値20超なので
        level=16、閾値24以下なので旧既定ではlevel=60になっていたはず)。"""
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "engineLoss"}
        children_info = {
            "empties": 22,
            "moves": [
                {
                    "move": "a1",
                    "childBoard": "A" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 21,
                    "childIsTerminal": False,
                },
            ],
        }

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            self.assertEqual(level, gen.DEFAULT_EDAX_LEVEL)
            return [{"depth": 16, "discDiff": 3.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            record = gen.label_position(0, position, children_info, exact_empties_threshold=20)

        self.assertEqual(record["children"][0]["exact"], False)
        self.assertEqual(record["children"][0]["level"], gen.DEFAULT_EDAX_LEVEL)

    def test_corpus_sets_exact_empties_threshold_is_set_specific(self) -> None:
        """T114移行: `CORPUS_SETS`のexactEmptiesThreshold上書きはexpanded200kのみで、
        smoke/primaryは既定(グローバル定数24)のまま=settings/runKeyが不変であることを
        確認する(`generate()`と同じ`cfg.get(..., EXACT_EMPTIES_THRESHOLD)`パターン)。"""
        self.assertNotIn("exactEmptiesThreshold", gen.CORPUS_SETS["smoke"])
        self.assertNotIn("exactEmptiesThreshold", gen.CORPUS_SETS["primary"])
        self.assertEqual(
            gen.CORPUS_SETS["smoke"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 24
        )
        self.assertEqual(
            gen.CORPUS_SETS["primary"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 24
        )
        self.assertEqual(gen.CORPUS_SETS["expanded200k"]["exactEmptiesThreshold"], 20)
        self.assertEqual(
            gen.CORPUS_SETS["expanded200k"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 20
        )

    def test_phase_allocation_and_xc_opening_constraints(self) -> None:
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        selected, stats = gen.select_positions({"positions": positions}, [], 60, 7)
        self.assertEqual(len(selected), 60)
        for phase in range(6):
            rows = [row for row in selected if row["phaseBin"] == phase]
            self.assertGreaterEqual(sum(bool(row["hasXcLegalMove"]) for row in rows), 5)
        self.assertLessEqual(stats["maxOpeningCountSelected"], stats["openingMaxCount"])

    def test_select_positions_excludes_oracle_keys(self) -> None:
        """T114: `excluded_keys`(t096 oracleのcanonicalKey集合)に含まれる候補は
        優先層・WTHOR層のいずれからも除外され、統計に`oracleExclusion`が記録される。"""
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        excluded_pool_row = positions[0]
        excluded_pool_key = gen.canonical_key_of_position(excluded_pool_row["board"], excluded_pool_row["sideToMove"])
        priority_row = {
            "board": positions[1]["board"],
            "sideToMove": positions[1]["sideToMove"],
            "source": "engineLoss",
            "priorityLoss": 5.0,
        }
        priority_key = gen.canonical_key_of_position(priority_row["board"], priority_row["sideToMove"])

        selected, stats = gen.select_positions(
            {"positions": positions},
            [priority_row],
            60,
            7,
            excluded_keys={excluded_pool_key, priority_key},
        )
        selected_keys = {gen.canonical_key_of_position(row["board"], row["sideToMove"]) for row in selected}
        self.assertNotIn(excluded_pool_key, selected_keys)
        self.assertNotIn(priority_key, selected_keys)
        self.assertEqual(stats["oracleExclusion"]["excludedKeyCount"], 2)
        self.assertEqual(stats["oracleExclusion"]["priorityPositionsExcluded"], 1)
        self.assertGreaterEqual(stats["oracleExclusion"]["poolPositionsExcluded"], 1)

    def test_select_positions_without_excluded_keys_is_unchanged(self) -> None:
        """excluded_keysを渡さない(=smoke/primaryの既存呼び出し)場合、statsに
        `oracleExclusion`が一切追加されないことを確認する(settings/runKey不変の保証)。"""
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        _, stats = gen.select_positions({"positions": positions}, [], 60, 7)
        self.assertNotIn("oracleExclusion", stats)

    def test_python_rust_d4_agree(self) -> None:
        board = "X------O" + "-" * 48 + "O------X"
        proc = subprocess.run(
            [str(gen.TEACHER_CANDIDATES_TOOL), "canonical"],
            input=json.dumps([{"board": board, "sideToMove": "white"}]),
            capture_output=True,
            text=True,
            check=True,
        )
        rust_key = json.loads(proc.stdout)[0]
        self.assertEqual(rust_key, list(gen.canonical_key_of_position(board, "white")))

    def test_resume_truncates_malformed_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n{"positionId":')
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, provenance)
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(jsonl.read_bytes(), b'{"positionId": 0}\n')
            self.assertEqual(checkpoint.done_ids, {0})
            remaining = [position_id for position_id in range(3) if not checkpoint.is_done(position_id)]
            self.assertEqual(remaining, [1, 2])
            for position_id in remaining:
                checkpoint.append({"positionId": position_id})
            checkpoint.close()
            self.assertEqual(
                [json.loads(line)["positionId"] for line in jsonl.read_text(encoding="utf-8").splitlines()],
                [0, 1, 2],
            )

    def test_resume_ignores_gitcommit_change(self) -> None:
        """T114 resume堅牢化: `gitCommit`はPROVENANCE_IDENTITY_KEYSから除外済みのため、
        無関係コミットでHEADが進んだだけ(gitCommitのみ変化)ではresumeを拒否しない
        (2026-07-16のresume失敗事故の再発防止)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            provenance["gitCommit"] = "abc123"
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n')
            changed = dict(provenance)
            changed["gitCommit"] = "different-head"
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(checkpoint.done_ids, {0})
            self.assertEqual(jsonl.read_bytes(), b'{"positionId": 0}\n')

    def test_resume_raises_on_provenance_mismatch_without_flags(self) -> None:
        """T114 resume堅牢化: identity不一致は既定で切り詰めではなくRuntimeErrorで
        停止し、既存jsonlの内容は一切変更されない。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n{"positionId": 1}\n'
            jsonl.write_bytes(original_bytes)
            changed = dict(provenance)
            changed["edaxSha256"] = "different-edax-sha"
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            with self.assertRaisesRegex(RuntimeError, "provenance identity mismatch"):
                rejected.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_resume_raises_on_run_key_mismatch_without_flags(self) -> None:
        """T114 resume堅牢化: runKey不一致も既定でRuntimeErrorで停止する
        (切り詰めは発生しない)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n'
            jsonl.write_bytes(original_bytes)
            other_settings = {"setName": "test", "targetCount": 999}
            other_run_key = json.dumps(other_settings, sort_keys=True)
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, other_run_key, other_settings, provenance)
            with self.assertRaisesRegex(RuntimeError, "runKey mismatch"):
                rejected.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_resume_start_fresh_flag_allows_truncation_on_mismatch(self) -> None:
        """T114 resume堅牢化: `--start-fresh`(start_fresh_allowed=True)を明示した
        ときだけ、不一致時にtry_resume()がFalseを返し(切り詰めが起きる旧来の
        呼び出しパターン`if not checkpoint.try_resume(): checkpoint.start_fresh()`
        が働く)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n')
            changed = dict(provenance)
            changed["edaxSha256"] = "different-edax-sha"
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, run_key, settings, changed, start_fresh_allowed=True
            )
            self.assertFalse(checkpoint.try_resume())
            checkpoint.start_fresh()
            self.assertEqual(jsonl.read_bytes(), b"")
            self.assertEqual(checkpoint.done_ids, set())

    def test_resume_adopt_provenance_flag_resumes_despite_mismatch(self) -> None:
        """T114 resume堅牢化: `--adopt-provenance`(adopt_provenance=True)は
        provenance identity不一致でも既存checkpointを正としてresumeし、jsonlを
        切り詰めない(既存の29,008局面消失事故のような損失を防ぐための移行経路)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n{"positionId": 1}\n'
            jsonl.write_bytes(original_bytes)
            changed = dict(provenance)
            changed["harnessSha256"] = "different-harness-sha"
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, run_key, settings, changed, adopt_provenance=True
            )
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(checkpoint.done_ids, {0, 1})
            self.assertEqual(jsonl.read_bytes(), original_bytes)
            # meta引数(=現環境の値)がそのままself.metaとして保持され、以降の
            # write_progress()はこの新しいidentityで書き込む(=identityの更新)。
            self.assertEqual(checkpoint.meta, changed)

    def test_resume_adopt_provenance_does_not_override_run_key_mismatch(self) -> None:
        """T114 resume堅牢化: `--adopt-provenance`はprovenance identityの不一致にしか
        効かず、runKey(生成設定そのもの)の不一致は引き続きRuntimeErrorで停止する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n'
            jsonl.write_bytes(original_bytes)
            other_settings = {"setName": "test", "targetCount": 999}
            other_run_key = json.dumps(other_settings, sort_keys=True)
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, other_run_key, other_settings, provenance, adopt_provenance=True
            )
            with self.assertRaisesRegex(RuntimeError, "runKey mismatch"):
                checkpoint.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_merge_rejects_mismatched_shard_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            common = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            for index in range(2):
                settings = {"setName": "test", "targetCount": 2, "numShards": 2, "shardIndex": index}
                meta = {
                    "runKey": json.dumps(settings, sort_keys=True),
                    "meta": dict(common),
                    "settings": settings,
                }
                if index == 1:
                    meta["meta"]["edaxSha256"] = "mismatch"
                (data_dir / f"corpus_test_shard{index}of2.meta.json").write_text(json.dumps(meta), encoding="utf-8")
                (data_dir / f"corpus_test_shard{index}of2.jsonl").write_text(
                    json.dumps({"positionId": index}) + "\n", encoding="utf-8"
                )
            with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                with self.assertRaisesRegex(RuntimeError, "provenance mismatch"):
                    gen.merge_shards("test", 2, 2)

    def test_verifier_rejects_legal_move_missing_and_extra(self) -> None:
        missing = self.valid_corpus_record()
        missing["children"].pop(0)
        self.assert_verifier_rejects([missing])

        extra = self.valid_corpus_record()
        extra["children"].append(
            {
                "move": "a1",
                "value": -1.0,
                "diffFromBest": extra["bestValue"] + 1.0,
                "exact": False,
                "level": 16,
                "edaxDepth": 16,
            }
        )
        self.assert_verifier_rejects([extra])

    def test_verifier_rejects_diff_and_exact_threshold_corruption(self) -> None:
        bad_diff = self.valid_corpus_record()
        bad_diff["children"][0]["diffFromBest"] += 1
        self.assert_verifier_rejects([bad_diff])

        bad_exact = self.valid_corpus_record()
        bad_exact["children"][0].update({"exact": True, "level": 60, "edaxDepth": 59})
        self.assert_verifier_rejects([bad_exact])

    def test_verifier_rejects_canonical_tamper_and_d4_duplicate(self) -> None:
        tampered = self.valid_corpus_record()
        tampered["canonicalKey"][0] += 1
        self.assert_verifier_rejects([tampered])

        initial = self.valid_corpus_record()
        first_move = verify.compute_children([initial])[0]["moves"][0]
        first = self.valid_corpus_record(first_move["childBoard"], first_move["childSideToMove"])
        second = self.valid_corpus_record(first["board"][::-1], first["sideToMove"])
        second["positionId"] = 1
        self.assert_verifier_rejects([first, second])

    def test_verifier_rejects_missing_required_field(self) -> None:
        record = self.valid_corpus_record()
        del record["openingKey"]
        self.assert_verifier_rejects([record])

    def test_verifier_rejects_oracle_contaminated_position(self) -> None:
        """T114: t096独立oracleのcanonicalKeyと一致する局面は、他のフィールドが
        すべて正しくても`ORACLE_KEYS`との一致だけでexit 1になることを確認する。"""
        record = self.valid_corpus_record()
        oracle_key = tuple(record["canonicalKey"])
        with mock.patch.object(verify, "ORACLE_KEYS", {oracle_key}):
            self.assert_verifier_rejects([record])

    def test_verifier_accepts_clean_position_when_oracle_keys_disjoint(self) -> None:
        """対照テスト: `ORACLE_KEYS`に一致しない局面はオラクル起因では拒否されない
        (上記テストが「常にexit 1になる」偽陽性でないことの確認)。"""
        record = self.valid_corpus_record()
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8", newline="\n")
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": 1, "total": 1}}) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            unrelated_key = (1, 2, 0)
            with mock.patch.object(verify, "ORACLE_KEYS", {unrelated_key}):
                with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                    with mock.patch.object(verify.sys, "argv", ["verify_teacher_corpus.py", "smoke"]):
                        with self.assertRaises(SystemExit) as raised:
                            verify.main()
            self.assertEqual(raised.exception.code, 0)


if __name__ == "__main__":
    unittest.main()

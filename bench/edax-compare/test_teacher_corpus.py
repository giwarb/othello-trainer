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
FINALIZE_SPEC = importlib.util.spec_from_file_location("finalize_teacher_corpus", HERE / "finalize_teacher_corpus.py")
assert FINALIZE_SPEC and FINALIZE_SPEC.loader
finalize = importlib.util.module_from_spec(FINALIZE_SPEC)
FINALIZE_SPEC.loader.exec_module(finalize)


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

    def test_cross_parent_batch_matches_cold_values_and_aggregates_by_level(self) -> None:
        board = "---------------------------OX------XO---------------------------"
        parents = []
        for position_id, prefix in ((10, "A"), (11, "B")):
            position = {"board": board, "sideToMove": "black", "source": "wthor"}
            children = {
                "empties": 22,
                "moves": [
                    {"move": "a1", "childBoard": prefix * 64, "childSideToMove": "white",
                     "childEmpties": 21, "childIsTerminal": False},
                    {"move": "b2", "childBoard": prefix.lower() * 64, "childSideToMove": "white",
                     "childEmpties": 19, "childIsTerminal": False},
                ],
            }
            parents.append((position_id, position, children))

        calls = []

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            calls.append((level, [row["board"] for row in positions]))
            return [
                {"depth": 19 if level == 60 else 16,
                 "discDiff": float(ord(row["board"][0]) % 7), "move": "a1"}
                for row in positions
            ]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            cold = [gen.label_position(*parent, exact_empties_threshold=20) for parent in parents]
            batched = gen.label_positions_across_parents(parents, exact_empties_threshold=20)
        for records in (cold, batched):
            for record in records:
                record.pop("generatedAt")
                for child in record["children"]:
                    child.pop("elapsedMs")
        self.assertEqual(batched, cold)
        self.assertEqual(calls[-2][0], 16)
        self.assertEqual(calls[-1][0], 60)
        self.assertEqual(len(calls[-2][1]), 2)
        self.assertEqual(len(calls[-1][1]), 2)

    def test_expanded1m_bundle_checkpoints_each_parent_in_plan_order(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        with mock.patch.object(gen, "label_positions_across_parents", return_value=records):
            fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint)
        self.assertFalse(fell_back)
        self.assertEqual(checkpoint.append.call_args_list, [mock.call(records[0]), mock.call(records[1])])

    def test_expanded1m_bundle_falls_back_to_individual_parents_before_checkpoint(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        with mock.patch.object(gen, "label_positions_across_parents", side_effect=RuntimeError("batch failed")):
            with mock.patch.object(gen, "label_position", side_effect=records) as individual:
                fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint)
        self.assertTrue(fell_back)
        self.assertEqual([call.args[0] for call in individual.call_args_list], [7, 15])
        self.assertEqual(checkpoint.append.call_args_list, [mock.call(records[0]), mock.call(records[1])])

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


    def test_expanded1m_config_is_k4_and_nested(self) -> None:
        cfg = gen.CORPUS_SETS["expanded1m"]
        self.assertEqual(cfg["targetCount"], 1_000_000)
        self.assertEqual(cfg["years"], "2000-2024")
        self.assertEqual(cfg["perBinCap"], 4)
        self.assertEqual(cfg["perGameCap"], 24)
        self.assertEqual(cfg["baseSet"], "expanded200k")
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["smoke"])
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["primary"])
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["expanded200k"])

    def test_expanded1m_run_settings_include_plan_sha_and_two_layer_provenance(self) -> None:
        plan_meta = {
            "selectionStats": {"incrementalSelected": 800_000},
            "selectionPlanSha256": "master-sha",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {
                    "jsonlSha256": gen.BASE_CORPUS_SHA256,
                    "manifestSha256": gen.BASE_MANIFEST_SHA256,
                },
                "incrementalGeneration": {
                    "generatorSha256": "current",
                    "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current",
                    "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                    "selectionPlanSha256": "master-sha",
                },
            },
        }
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(
                    3, plan_meta, gen.CORPUS_SETS["expanded1m"]["edaxParentsPerProcess"]
                )
        self.assertEqual(settings["selectionPlanSha256"], "master-sha")
        self.assertEqual(settings["shardSelectionPlanSha256"], "shard-3")
        self.assertEqual(settings["perBinCap"], 4)
        self.assertEqual(settings["edaxParentsPerProcess"], 32)
        self.assertEqual(settings["elapsedMsPolicy"], "cross-parent-level-batch-averaged")
        self.assertIn("baseCorpus", meta)
        self.assertIn("incrementalGeneration", meta)
        self.assertEqual(meta["harnessSha256"], "current")

    def test_expanded1m_legacy_run_key_is_unchanged_when_parent_batch_field_is_absent(self) -> None:
        plan_meta = {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"s{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {},
                "incrementalGeneration": {
                    "generatorSha256": "current", "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current", "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                },
            },
        }
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, _ = gen._expanded1m_settings_and_meta(0, plan_meta)
        expected_run_key = (
            '{"defaultEdaxLevel": 16, "edaxTasksPerProcess": 1, "elapsedMsPolicy": "batch-averaged", '
            '"exactEdaxLevel": 60, "exactEmptiesThreshold": 20, "numPhaseBins": 6, "numShards": 8, '
            '"openingKeyPlies": 8, "openingMaxFraction": 0.02, "perBinCap": 4, "perGameCap": 24, '
            '"seed": 90104, "selectionPlanSha256": "master", "selectionStats": {}, "setName": '
            '"expanded1m", "shardIndex": 0, "shardSelectionPlanSha256": "s0", "targetCount": '
            '1000000, "xcQuotaFraction": 0.5, "years": "2000-2024"}'
        )
        self.assertNotIn("edaxParentsPerProcess", settings)
        self.assertEqual(json.dumps(settings, sort_keys=True), expected_run_key)

    def test_expanded1m_rejects_execution_sha_changed_since_plan(self) -> None:
        incremental = {
            "generatorSha256": "planned",
            "teacherCandidatesToolSha256": "current",
            "edaxSha256": "current",
            "edaxEvalDataSha256": "current",
            "candidatePoolSha256": "pool",
        }
        plan_meta = {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {"baseCorpus": {}, "incrementalGeneration": incremental},
        }
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            with self.assertRaisesRegex(RuntimeError, "execution SHA mismatch.*resume refused"):
                gen._expanded1m_settings_and_meta(0, plan_meta)

    def test_streaming_merge_orders_records_and_uses_atomic_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            common = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            for shard_index, ids in enumerate(([0, 2], [1, 3])):
                settings = {"setName": "test", "targetCount": 4, "numShards": 2, "shardIndex": shard_index}
                meta = {
                    "runKey": json.dumps(settings, sort_keys=True),
                    "meta": dict(common),
                    "settings": settings,
                }
                (data_dir / f"corpus_test_shard{shard_index}of2.meta.json").write_text(
                    json.dumps(meta), encoding="utf-8"
                )
                lines = [json.dumps({"positionId": position_id}, separators=(",", ":")) + "\n" for position_id in ids]
                (data_dir / f"corpus_test_shard{shard_index}of2.jsonl").write_text(
                    "".join(lines), encoding="utf-8", newline="\n"
                )
            with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                gen.merge_shards("test", 2, 4)
            merged = (data_dir / "corpus_test.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual([json.loads(line)["positionId"] for line in merged], [0, 1, 2, 3])
            self.assertFalse((data_dir / "corpus_test.jsonl.merge.tmp").exists())


    def test_expanded1m_target_shortfall_is_immediate_error(self) -> None:
        base = {
            "canonicalKeys": set(),
            "phaseCounts": [0] * 6,
            "phaseXcCounts": [0] * 6,
            "openingCounts": {},
        }
        with mock.patch.object(gen, "EXPANDED1M_BASE_COUNT", 0):
            with mock.patch.object(gen, "EXPANDED1M_INCREMENTAL_COUNT", 4):
                with mock.patch.object(gen, "EXPANDED1M_ENGINE_LOSS_COUNT", 0):
                    with self.assertRaisesRegex(RuntimeError, "target unavailable"):
                        gen.select_expanded1m_incremental({"positions": []}, base, set(), 7)

    def test_expanded1m_synthetic_selection_enforces_final_union_constraints(self) -> None:
        base = {
            "canonicalKeys": {(998, 0, 0)},
            "phaseCounts": [1, 1, 0, 0, 0, 0],
            "phaseXcCounts": [0, 1, 0, 0, 0, 0],
            "openingCounts": {"shared": 2},
        }
        positions = []
        board_id = 100
        for phase in range(6):
            for offset in range(6):
                positions.append(
                    {
                        "board": str(board_id),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": offset % 2 == 0,
                        "openingKey": "shared" if offset < 2 else f"opening-{board_id}",
                        "year": 2024,
                        "gameIndex": board_id,
                    }
                )
                board_id += 1
        positions.extend(
            [
                {**positions[0]},
                {**positions[0], "board": "998"},
                {**positions[0], "board": "999"},
            ]
        )

        with mock.patch.object(gen, "EXPANDED1M_BASE_COUNT", 2):
            with mock.patch.object(gen, "EXPANDED1M_INCREMENTAL_COUNT", 12):
                with mock.patch.object(gen, "EXPANDED1M_ENGINE_LOSS_COUNT", 0):
                    with mock.patch.object(gen, "OPENING_MAX_FRACTION", 0.25):
                        with mock.patch.object(
                            gen,
                            "canonical_key_of_position",
                            side_effect=lambda board, _side: (int(board), 0, 0),
                        ):
                            selected, stats = gen.select_expanded1m_incremental(
                                {"positions": positions, "totalCandidatesAfterDedup": len(positions)},
                                base,
                                {(999, 0, 0)},
                                17,
                            )

        self.assertEqual(len(selected), 12)
        self.assertEqual(sum(stats["finalBinAllocation"]), 14)
        self.assertEqual(sum(stats["incrementalBinAllocation"]), 12)
        self.assertEqual(stats["baseExcluded"], 1)
        self.assertEqual(stats["oracleExcluded"], 1)
        self.assertEqual(stats["incrementalDuplicateExcluded"], 1)
        self.assertLessEqual(stats["maxOpeningCountSelected"], stats["openingMaxCount"])
        for phase, final_count in enumerate(stats["finalBinAllocation"]):
            self.assertGreaterEqual(stats["finalPhaseXcCounts"][phase], (final_count + 1) // 2)
        selected_keys = {int(row["board"]) for row in selected}
        self.assertEqual(len(selected_keys), len(selected))
        self.assertNotIn(998, selected_keys)
        self.assertNotIn(999, selected_keys)

    def test_base_shard_copy_preserves_record_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "base.jsonl"
            target = root / "shard.jsonl"
            lines = [
                '{"positionId":0, "payload":"a"}\n',
                '{"positionId":1,"payload":"b"}\n',
                '{"positionId":2, "payload":"c"}\n',
                '{"positionId":3,"payload":"d"}\n',
            ]
            source.write_text("".join(lines), encoding="utf-8", newline="\n")
            copied = gen.copy_base_records_for_shard(source, target, 1, 2)
            self.assertEqual(copied, 2)
            self.assertEqual(target.read_bytes(), (lines[1] + lines[3]).encode("utf-8"))

    def test_expanded1m_verifier_uses_fixed_counts_prefix_and_artifact_shas(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "teacher"
            data_dir.mkdir()
            artifacts = {
                "manifest": root / "base.meta.json",
                "candidate": data_dir / "candidates_expanded1m.json",
                "plan": data_dir / "corpus_expanded1m_selection_plan.jsonl",
                "generator": root / "gen.py",
                "tool": root / "teacher_candidates.exe",
                "oracle": root / "oracle.json",
                "edax": root / "edax.exe",
                "eval": root / "eval.dat",
            }
            for name, path in artifacts.items():
                path.write_text(f"{name}\n", encoding="utf-8", newline="\n")
            artifacts["manifest"].write_text(
                json.dumps({"meta": {"edaxSha256": "base-edax", "edaxEvalDataSha256": "base-eval"}}),
                encoding="utf-8",
            )

            def record(position_id: int) -> dict:
                return {
                    "positionId": position_id,
                    "children": [
                        {"move": "a1", "value": 0, "diffFromBest": 0, "exact": False, "level": 16}
                    ],
                    "bestMove": "a1",
                    "bestValue": 0,
                    "canonicalKey": [position_id + 1, 0, 0],
                }

            base_lines = [json.dumps(record(i), separators=(",", ":")) + "\n" for i in range(2)]
            base_path = data_dir / "corpus_expanded200k.jsonl"
            base_path.write_text("".join(base_lines), encoding="utf-8", newline="\n")
            corpus_path = data_dir / "corpus_expanded1m.jsonl"
            corpus_path.write_text(
                "".join(base_lines) + json.dumps(record(2), separators=(",", ":")) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            shard_shas = []
            for shard_index in range(8):
                shard_path = data_dir / f"corpus_expanded1m_shard{shard_index}of8.plan.jsonl"
                shard_path.write_text(f"{shard_index}\n", encoding="utf-8", newline="\n")
                shard_shas.append(verify.sha256_of_file(shard_path))

            base_sha = verify.sha256_of_file(base_path)
            manifest_sha = verify.sha256_of_file(artifacts["manifest"])
            provenance = {
                "baseCorpus": {
                    "path": "train/data/teacher/corpus_expanded200k.jsonl",
                    "recordCount": 2,
                    "jsonlSha256": base_sha,
                    "manifestPath": "bench/edax-compare/teacher_manifests/corpus_expanded200k.meta.json",
                    "manifestSha256": manifest_sha,
                    "edaxSha256": "base-edax",
                    "edaxEvalDataSha256": "base-eval",
                },
                "incrementalGeneration": {
                    "recordCount": 1,
                    "candidatePoolPath": "train/data/teacher/candidates_expanded1m.json",
                    "candidatePoolSha256": verify.sha256_of_file(artifacts["candidate"]),
                    "selectionPlanPath": "train/data/teacher/corpus_expanded1m_selection_plan.jsonl",
                    "selectionPlanSha256": verify.sha256_of_file(artifacts["plan"]),
                    "generatorSha256": verify.sha256_of_file(artifacts["generator"]),
                    "teacherCandidatesToolSha256": verify.sha256_of_file(artifacts["tool"]),
                    "edaxSha256": verify.sha256_of_file(artifacts["edax"]),
                    "edaxEvalDataSha256": verify.sha256_of_file(artifacts["eval"]),
                    "t096OracleSha256": verify.sha256_of_file(artifacts["oracle"]),
                    "shardPlanSha256": shard_shas,
                },
            }
            meta = {
                "schemaVersion": 2,
                "settings": {"exactEmptiesThreshold": 24},
                "progress": {"done": 3, "total": 3},
                "reusedRecordCount": 2,
                "provenance": provenance,
            }
            (data_dir / "corpus_expanded1m.meta.json").write_text(json.dumps(meta), encoding="utf-8")

            patches = {
                "TEACHER_DATA_DIR": data_dir,
                "TOOL": artifacts["tool"],
                "T096_ORACLE_POSITIONS_PATH": artifacts["oracle"],
                "EXPANDED1M_GENERATOR_PATH": artifacts["generator"],
                "EXPANDED1M_BASE_PATH": base_path,
                "EXPANDED1M_BASE_MANIFEST_PATH": artifacts["manifest"],
                "EXPANDED1M_CANDIDATE_POOL_PATH": artifacts["candidate"],
                "EXPANDED1M_SELECTION_PLAN_PATH": artifacts["plan"],
                "EXPANDED1M_BASE_COUNT": 2,
                "EXPANDED1M_TOTAL_COUNT": 3,
                "EXPANDED1M_BASE_SHA256": base_sha,
                "EXPANDED1M_BASE_MANIFEST_SHA256": manifest_sha,
                "ORACLE_KEYS": set(),
            }
            legal = lambda records: [
                {"moves": [{"move": "a1", "childEmpties": 30, "childIsTerminal": False}]} for _ in records
            ]
            canonical = lambda records: [rec["canonicalKey"] for rec in records]
            with mock.patch.multiple(verify, **patches):
                with mock.patch.object(verify.vs_edax, "EDAX_EXE", artifacts["edax"]):
                    with mock.patch.object(verify.vs_edax, "EDAX_EVAL_DATA", artifacts["eval"]):
                        with mock.patch.object(verify, "schema_errors", return_value=[]):
                            with mock.patch.object(verify, "compute_children", side_effect=legal):
                                with mock.patch.object(verify, "compute_canonical_keys", side_effect=canonical):
                                    count, errors = verify.verify_one("expanded1m")
            self.assertEqual((count, errors), (3, 0))

            tampered = json.loads((data_dir / "corpus_expanded1m.meta.json").read_text(encoding="utf-8"))
            tampered["provenance"]["incrementalGeneration"]["selectionPlanSha256"] = "tampered"
            self.assertTrue(verify.expanded1m_provenance_errors(tampered))

            # T127c: 実データのtrain/data/teacher/corpus_expanded1m.meta.jsonは
            # Windows上のPath(os.sep=`\\`)でシリアライズされたためbaseCorpus.path等が
            # 例えば"train\\data\\teacher\\corpus_expanded200k.jsonl"のように記録されて
            # いた。区切り文字の差だけを理由に誤検知しないことを確認する(パス自体が
            # 誤っている場合=別ディレクトリ名等は引き続き検出されること、も併せて確認)。
            with mock.patch.multiple(verify, **patches):
                with mock.patch.object(verify.vs_edax, "EDAX_EXE", artifacts["edax"]):
                    with mock.patch.object(verify.vs_edax, "EDAX_EVAL_DATA", artifacts["eval"]):
                        windows_style = json.loads(json.dumps(provenance))
                        windows_style["baseCorpus"]["path"] = "train\\data\\teacher\\corpus_expanded200k.jsonl"
                        windows_style["baseCorpus"]["manifestPath"] = (
                            "bench\\edax-compare\\teacher_manifests\\corpus_expanded200k.meta.json"
                        )
                        windows_style["incrementalGeneration"]["candidatePoolPath"] = (
                            "train\\data\\teacher\\candidates_expanded1m.json"
                        )
                        windows_style["incrementalGeneration"]["selectionPlanPath"] = (
                            "train\\data\\teacher\\corpus_expanded1m_selection_plan.jsonl"
                        )
                        windows_style_errors = verify.expanded1m_provenance_errors({"provenance": windows_style})
                        self.assertEqual(windows_style_errors, [])

                        wrong_path = json.loads(json.dumps(provenance))
                        wrong_path["baseCorpus"]["path"] = "train\\data\\teacher\\corpus_wrong200k.jsonl"
                        wrong_path_errors = verify.expanded1m_provenance_errors({"provenance": wrong_path})
                        self.assertTrue(any("baseCorpus.path" in message for message in wrong_path_errors))

    def test_verify_checkpoint_round_trip_and_set_name_mismatch_is_ignored(self) -> None:
        """T127c: 長時間実行ルール(チャンク進捗+resume)対応で追加した
        save_verify_checkpoint/load_verify_checkpointの基本契約を確認する。
        setNameが異なるcheckpointは取り違え防止のため無視されること、
        原子的置換(.tmp書き→os.replace)で本体ファイルが残ることも確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint_path = Path(temp_dir) / "expanded1m.verify-checkpoint.json"
            seen = {(1, 2, 3): 0, (4, 5, 6): 1}
            verify.save_verify_checkpoint(checkpoint_path, "expanded1m", 2, 0, seen)
            self.assertFalse(checkpoint_path.with_suffix(".json.tmp").exists())
            loaded = verify.load_verify_checkpoint(checkpoint_path, "expanded1m")
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded["recordCount"], 2)
            self.assertEqual(loaded["errors"], 0)
            self.assertEqual(
                {(row[0], row[1], row[2]): row[3] for row in loaded["seenCanonical"]}, seen
            )
            self.assertIsNone(verify.load_verify_checkpoint(checkpoint_path, "expanded200k"))

    def test_verify_one_resumes_from_checkpoint_and_skips_recomputation(self) -> None:
        """T127c: checkpointにrecordCountが記録済みの区間はcompute_children/
        compute_canonical_keys(subprocess経由の重い再検証)を呼ばずスキップし、
        seenCanonicalを引き継いだ上で残り区間だけを検証することを確認する。"""
        record = self.valid_corpus_record()
        second_move = verify.compute_children([record])[0]["moves"][0]
        second = self.valid_corpus_record(second_move["childBoard"], second_move["childSideToMove"])
        second["positionId"] = 1
        records = [record, second]
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(
                "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8", newline="\n"
            )
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": 2, "total": 2}}),
                encoding="utf-8",
                newline="\n",
            )
            checkpoint_path = data_dir / "smoke.verify-checkpoint.json"
            first_key = tuple(record["canonicalKey"])
            verify.save_verify_checkpoint(checkpoint_path, "smoke", 1, 0, {first_key: 0})

            call_count = {"children": 0, "canonical": 0}
            real_children = verify.compute_children
            real_canonical = verify.compute_canonical_keys

            def counting_children(recs):
                call_count["children"] += 1
                return real_children(recs)

            def counting_canonical(recs):
                call_count["canonical"] += 1
                return real_canonical(recs)

            with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                with mock.patch.object(verify, "BATCH_SIZE", 1):
                    with mock.patch.object(verify, "compute_children", side_effect=counting_children):
                        with mock.patch.object(verify, "compute_canonical_keys", side_effect=counting_canonical):
                            count, errors = verify.verify_one(
                                "smoke", progress_every=1, checkpoint_path=checkpoint_path
                            )
            self.assertEqual((count, errors), (2, 0))
            # positionId=0はcheckpointでresume_record_count=1未満なのでbatchへ
            # 積まれず、children/canonicalの再計算は最後の1件分(positionId=1)
            # だけで済む(BATCH_SIZE=1なので1回呼ばれる)。
            self.assertEqual(call_count["children"], 1)
            self.assertEqual(call_count["canonical"], 1)
            final_checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(final_checkpoint["recordCount"], 2)
            self.assertEqual(len(final_checkpoint["seenCanonical"]), 2)


class T127cFinalizeExpanded1mTests(unittest.TestCase):
    """T127c: `finalize_teacher_corpus.py`に追加したexpanded1m集計・manifest確定の
    回帰テスト。実データ(1M件)は使わず、既知の値を計算できる小さな合成JSONLで
    集計ロジック自体を検証する。"""

    @staticmethod
    def _synthetic_records() -> list[dict]:
        return [
            {
                "positionId": 0,
                "source": "wthor",
                "canonicalKey": [1, 0, 0],
                "phaseBin": 0,
                "hasXcLegalMove": True,
                "openingKey": "op1",
                "year": 2001,
                "gameIndex": 5,
                "children": [
                    {"move": "a1", "exact": True, "level": None, "elapsedMs": 1.0},
                    {"move": "b2", "exact": False, "level": 16, "elapsedMs": 2.0},
                ],
            },
            {
                "positionId": 1,
                "source": "wthor",
                "canonicalKey": [2, 0, 0],
                "phaseBin": 0,
                "hasXcLegalMove": False,
                "openingKey": "op1",
                "year": 2001,
                "gameIndex": 5,
                "children": [{"move": "c3", "exact": True, "level": 60, "elapsedMs": 3.0}],
            },
            {
                "positionId": 2,
                "source": "wthor",
                "canonicalKey": [3, 0, 0],
                "phaseBin": 1,
                "hasXcLegalMove": True,
                "openingKey": "op2",
                "year": 2002,
                "gameIndex": 9,
                "children": [{"move": "d4", "exact": False, "level": 16, "elapsedMs": 4.0}],
            },
            {
                "positionId": 3,
                "source": "engineLoss",
                "canonicalKey": [999, 0, 0],
                "phaseBin": None,
                "hasXcLegalMove": None,
                "openingKey": None,
                "year": None,
                "gameIndex": None,
                "children": [{"move": "e5", "exact": False, "level": 16, "elapsedMs": 5.0}],
            },
        ]

    def test_expanded1m_corpus_stats_aggregates_counts_and_histograms(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            jsonl_path = Path(temp_dir) / "corpus_expanded1m.jsonl"
            jsonl_path.write_text(
                "".join(json.dumps(r) + "\n" for r in self._synthetic_records()), encoding="utf-8", newline="\n"
            )
            oracle_keys = {(999, 0, 0)}
            stats, audit, oracle_report = finalize.expanded1m_corpus_stats(jsonl_path, oracle_keys)

        self.assertEqual(stats["records"], 4)
        self.assertEqual(stats["sourceCounts"], {"wthor": 3, "engineLoss": 1})
        self.assertEqual(stats["phaseCountsWthor"], {"0": 2, "1": 1})
        self.assertEqual(stats["yearCountsWthor"], {"2001": 2, "2002": 1})
        self.assertEqual(stats["children"], 5)
        self.assertEqual(stats["exactChildren"], 2)
        self.assertEqual(stats["terminalChildren"], 1)
        self.assertAlmostEqual(stats["averageElapsedMsPerEdaxCall"], 3.0)

        self.assertEqual(audit["phaseXcCoverage"]["0"], {"total": 2, "xc": 1, "xcCoverage": 0.5})
        self.assertEqual(audit["phaseXcCoverage"]["1"], {"total": 1, "xc": 1, "xcCoverage": 1.0})
        self.assertEqual(audit["openingMatched"], 3)
        self.assertEqual(audit["openingUnmatched"], 0)
        self.assertEqual(audit["distinctOpeningKeys"], 2)
        self.assertEqual(audit["maxOpeningKey"], "op1")
        self.assertEqual(audit["maxOpeningCount"], 2)
        self.assertAlmostEqual(audit["maxOpeningShareOfWthor"], 2 / 3)
        self.assertEqual(audit["distinctGamesRepresented"], 2)
        self.assertEqual(audit["positionsPerGameHistogram"], {"1": 1, "2": 1})
        self.assertEqual(audit["failedXcPhaseBins"], [])

        self.assertEqual(oracle_report["oracleKeyCount"], 1)
        self.assertEqual(oracle_report["contaminatedRecordsFound"], 1)

    def test_finalize_expanded1m_writes_manifest_with_method_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "teacher"
            manifest_dir = root / "manifests"
            data_dir.mkdir()
            manifest_dir.mkdir()

            jsonl_path = data_dir / "corpus_expanded1m.jsonl"
            jsonl_path.write_text(
                "".join(json.dumps(r) + "\n" for r in self._synthetic_records()), encoding="utf-8", newline="\n"
            )
            live_meta = {
                "schemaVersion": 2,
                "runKey": None,
                "meta": {"gitCommit": "abc123"},
                "settings": {"setName": "expanded1m", "targetCount": 4},
                "mergedFromShards": 8,
                "progress": {"done": 4, "total": 4},
                "reusedRecordCount": 2,
                "provenance": {"baseCorpus": {"recordCount": 2}, "incrementalGeneration": {"recordCount": 2}},
            }
            (data_dir / "corpus_expanded1m.meta.json").write_text(json.dumps(live_meta), encoding="utf-8")

            boundaries_path = manifest_dir / "corpus_expanded1m_method_boundaries.json"
            boundaries_path.write_text(
                json.dumps({"boundaries": [{"sequence": 1, "change": "test-switch"}], "note": "synthetic note"}),
                encoding="utf-8",
            )

            oracle_path = root / "oracle.json"
            oracle_path.write_text(json.dumps({"positions": [{"canonicalKey": [999, 0, 0]}]}), encoding="utf-8")

            patches = {
                "DATA_DIR": data_dir,
                "MANIFEST_DIR": manifest_dir,
                "T096_ORACLE_POSITIONS_PATH": oracle_path,
                "EXPANDED1M_METHOD_BOUNDARIES_PATH": boundaries_path,
            }
            verification = {"verifiedAt": "2026-07-19", "command": "verify_teacher_corpus.py expanded1m", "result": "ok"}
            with mock.patch.multiple(finalize, **patches):
                doc = finalize.finalize_expanded1m(verification)

            self.assertEqual(doc["corpusStats"]["records"], 4)
            self.assertEqual(doc["reusedRecordCount"], 2)
            self.assertEqual(doc["provenance"]["methodBoundaries"], [{"sequence": 1, "change": "test-switch"}])
            self.assertEqual(doc["provenance"]["methodBoundariesNote"], "synthetic note")
            self.assertEqual(doc["verification"], verification)
            self.assertEqual(doc["oracleNonContamination"]["contaminatedRecordsFound"], 1)

            written = json.loads((manifest_dir / "corpus_expanded1m.meta.json").read_text(encoding="utf-8"))
            self.assertEqual(written, doc)


class VsEdaxSolveBatchCommandTests(unittest.TestCase):
    """T127i: `_edax_solve_batch`に追加した`edax_exe`引数の回帰テスト。

    `subprocess.run`をモックしてコマンド列だけを検証する(実際のEdaxは
    起動しない)。OBF一時ファイルの書き込み先も一時ディレクトリへ差し替え、
    走行中の`edax-extract`ディレクトリには一切触れない。
    """

    @staticmethod
    def _fake_completed_process(positions: list[dict]) -> subprocess.CompletedProcess:
        blocks = [
            f"*** problem # {i} ***\n  1  +04         0:00.01          1          100  d3\n"
            for i in range(1, len(positions) + 1)
        ]
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="\n".join(blocks), stderr="")

    def _run_with_captured_command(self, temp_edax_dir: Path, **kwargs) -> list[str]:
        positions = [{"board": "-" * 64, "sideToMove": "black"}]
        captured: dict = {}

        def fake_run(command, **run_kwargs):
            captured["command"] = list(command)
            return self._fake_completed_process(positions)

        with mock.patch.object(gen.vs_edax, "EDAX_DIR", temp_edax_dir):
            with mock.patch.object(gen.vs_edax.subprocess, "run", side_effect=fake_run):
                gen.vs_edax._edax_solve_batch(positions, level=16, n_tasks=1, **kwargs)
        return captured["command"]

    def test_default_command_unchanged_when_edax_exe_unspecified(self) -> None:
        """`edax_exe`未指定時、コマンド列は従来どおり`EDAX_EXE`(ベースライン
        バイナリ)を使い、`-h`も付与されない(既存のedax_hash_bits未指定時と
        同じ「加算引数は挙動を変えない」契約)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            command = self._run_with_captured_command(Path(temp_dir))
        self.assertEqual(command[0], str(gen.vs_edax.EDAX_EXE))
        self.assertNotIn("-h", command)
        self.assertEqual(command[3], "-l")
        self.assertEqual(command[4], "16")
        self.assertEqual(command[5], "-n")
        self.assertEqual(command[6], "1")
        self.assertEqual(
            command[7:],
            ["-eval-file", str(gen.vs_edax.EDAX_EVAL_DATA), "-book-usage", "off", "-vv"],
        )

    def test_edax_exe_override_replaces_only_the_binary_path(self) -> None:
        """`edax_exe`指定時は実行ファイルパスだけが差し替わり、他の引数列は
        未指定時と同一である(T127i v3バイナリA/B用)。"""
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with tempfile.TemporaryDirectory() as temp_dir:
            default_command = self._run_with_captured_command(Path(temp_dir))
            override_command = self._run_with_captured_command(Path(temp_dir), edax_exe=override)
        self.assertEqual(override_command[0], str(override))
        self.assertNotEqual(override_command[0], default_command[0])
        # 実行ファイルパスとOBF一時ファイルパス(呼び出しごとに一意)を除いた
        # 引数列は完全一致する。
        self.assertEqual(override_command[1], default_command[1])
        self.assertEqual(override_command[3:], default_command[3:])


class T127jEdaxExeSwitchTests(unittest.TestCase):
    """T127j: v3バイナリ乗り換え準備で`label_position`系/`_expanded1m_settings_and_meta`
    に追加した`edax_exe`引数の配線を検証する(実際のEdax起動・plan/checkpointの
    読み書きは一切行わない)。低レベルの`_edax_solve_batch`のコマンド列自体は
    T127iの`VsEdaxSolveBatchCommandTests`で既に固定済み。"""

    def test_edax_solve_batch_forwards_edax_exe_to_low_level_call(self) -> None:
        captured: dict = {}

        def fake_low_level(positions, level, n_tasks=None, edax_hash_bits=None, edax_exe=None):
            captured["edax_exe"] = edax_exe
            captured["n_tasks"] = n_tasks
            return [{"depth": 1, "discDiff": 0.0, "move": "a1"}]

        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen.vs_edax, "_edax_solve_batch", side_effect=fake_low_level):
            gen.vs_edax.edax_solve_batch(
                [{"board": "-" * 64, "sideToMove": "black"}], 16, edax_exe=override
            )
        self.assertEqual(captured["edax_exe"], override)
        self.assertEqual(captured["n_tasks"], gen.vs_edax.EDAX_BATCH_TASKS)

    def test_edax_solve_batch_unspecified_edax_exe_forwards_none(self) -> None:
        captured: dict = {}

        def fake_low_level(positions, level, n_tasks=None, edax_hash_bits=None, edax_exe=None):
            captured["edax_exe"] = edax_exe
            return [{"depth": 1, "discDiff": 0.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "_edax_solve_batch", side_effect=fake_low_level):
            gen.vs_edax.edax_solve_batch([{"board": "-" * 64, "sideToMove": "black"}], 16)
        self.assertIsNone(captured["edax_exe"])

    @staticmethod
    def _one_parent_bundle() -> tuple[dict, dict]:
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "wthor"}
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
        return position, children_info

    def test_label_position_omits_edax_exe_kwarg_when_unspecified(self) -> None:
        """未指定時は`vs_edax.edax_solve_batch`へ`edax_exe`キーワード自体を渡さない。
        渡っていれば下の固定シグネチャ`solve_batch(positions, level)`はTypeErrorで
        失敗するはずなので、完走すること自体が証拠になる(既存コーパス生成経路
        =primary/smoke/expanded200kのコマンド列不変性の裏付け)。"""
        position, children_info = self._one_parent_bundle()

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            return [{"depth": 21, "discDiff": 1.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            gen.label_position(0, position, children_info, exact_empties_threshold=20)

    def test_label_position_passes_edax_exe_when_specified(self) -> None:
        position, children_info = self._one_parent_bundle()
        captured: dict = {}
        override = Path("C:/fake/wEdax-x86-64-v3.exe")

        def solve_batch(positions: list[dict], level: int, edax_exe=None) -> list[dict]:
            captured["edax_exe"] = edax_exe
            return [{"depth": 21, "discDiff": 1.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            gen.label_position(0, position, children_info, exact_empties_threshold=20, edax_exe=override)
        self.assertEqual(captured["edax_exe"], override)

    def test_checkpoint_bundle_forwards_edax_exe_to_batch_path(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen, "label_positions_across_parents", return_value=records) as batch_call:
            fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint, edax_exe=override)
        self.assertFalse(fell_back)
        self.assertEqual(batch_call.call_args.kwargs.get("edax_exe"), override)

    def test_checkpoint_bundle_forwards_edax_exe_to_fallback_path(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen, "label_positions_across_parents", side_effect=RuntimeError("batch failed")):
            with mock.patch.object(gen, "label_position", side_effect=records) as individual:
                fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint, edax_exe=override)
        self.assertTrue(fell_back)
        for call in individual.call_args_list:
            self.assertEqual(call.kwargs.get("edax_exe"), override)

    @staticmethod
    def _legacy_plan_meta() -> dict:
        return {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {},
                "incrementalGeneration": {
                    "generatorSha256": "current",
                    "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current",
                    "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                },
            },
        }

    def test_expanded1m_settings_and_meta_records_edax_exe_when_specified(self) -> None:
        plan_meta = self._legacy_plan_meta()
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(
                    0, plan_meta, edax_parents_per_process=32, edax_exe_name="wEdax-x86-64-v3.exe"
                )
        self.assertEqual(settings["edaxExe"], "wEdax-x86-64-v3.exe")
        self.assertEqual(meta["edaxExeSha256"], "current")
        # SHAゲート対象の`edaxSha256`はあくまで既定バイナリ(`vs_edax.EDAX_EXE`)を
        # 指し続け、`edaxExe`設定の有無で変わらない。
        self.assertEqual(meta["edaxSha256"], "current")

    def test_expanded1m_settings_and_meta_omits_edax_exe_when_unspecified(self) -> None:
        plan_meta = self._legacy_plan_meta()
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(0, plan_meta)
        self.assertNotIn("edaxExe", settings)
        self.assertNotIn("edaxExeSha256", meta)

    def test_corpus_sets_expanded1m_edax_exe_points_at_existing_v3_binary(self) -> None:
        """CORPUS_SETSの設定値自体(T127j乗り換え準備の本体)を固定する。バイナリ
        実体の存在確認のみ行い、Edaxは起動しない。"""
        edax_exe_name = gen.CORPUS_SETS["expanded1m"]["edaxExe"]
        self.assertEqual(edax_exe_name, "wEdax-x86-64-v3.exe")
        self.assertTrue((gen.vs_edax.EDAX_DIR / edax_exe_name).exists())


if __name__ == "__main__":
    unittest.main()

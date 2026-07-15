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

    def test_resume_truncates_malformed_tail_and_rejects_provenance(self) -> None:
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
            changed = dict(provenance)
            changed["gitCommit"] = "different"
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            self.assertFalse(rejected.try_resume())

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


if __name__ == "__main__":
    unittest.main()

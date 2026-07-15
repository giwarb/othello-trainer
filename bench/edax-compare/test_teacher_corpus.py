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

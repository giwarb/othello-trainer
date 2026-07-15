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


class TeacherCorpusTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

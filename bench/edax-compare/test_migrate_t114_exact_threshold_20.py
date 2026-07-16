#!/usr/bin/env python3
"""T114移行(2026-07-16 20:4xユーザー裁定): `migrate_t114_exact_threshold_20.py`の
回帰テスト(Edax呼び出しなし)。閾値24→20への移行で「影響レコードだけ」が除去され、
meta(runKey/settings/provenance)が新方針で正しく更新され、移行後のcheckpointが
除去済みpositionIdを再計算対象として扱うことを確認する。
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent

MIGRATE_SPEC = importlib.util.spec_from_file_location(
    "migrate_t114_exact_threshold_20", HERE / "migrate_t114_exact_threshold_20.py"
)
assert MIGRATE_SPEC and MIGRATE_SPEC.loader
migrate = importlib.util.module_from_spec(MIGRATE_SPEC)
MIGRATE_SPEC.loader.exec_module(migrate)
# `migrate_t114_exact_threshold_20.py`が内部で読み込んだ`gen_teacher_corpus`モジュール
# インスタンスをそのまま使う(自前で`importlib`により別インスタンスを読み込むと、
# `mock.patch.object(gen, "TEACHER_DATA_DIR", ...)`が`migrate.migrate_shard`の
# 参照する側に反映されず、テストが常に本物の`train/data/teacher/`を見てしまう)。
gen = migrate.gen


def _child(move: str, empties: int, *, exact: bool, level: int | None, value: float = 0.0) -> dict:
    return {
        "move": move,
        "value": value,
        "diffFromBest": 0.0,
        "exact": exact,
        "level": level,
        "edaxDepth": level,
        "childEmpties": empties,
    }


def _record(position_id: int, empties: int, children: list[dict]) -> dict:
    best = max(children, key=lambda c: c["value"])
    return {
        "positionId": position_id,
        "board": "-" * 64,
        "sideToMove": "black",
        "empties": empties,
        "source": "wthor",
        "phaseBin": 0,
        "hasXcLegalMove": False,
        "openingKey": "opening-0",
        "priorityLoss": None,
        "canonicalKey": [0, 0, 0],
        "children": children,
        "bestMove": best["move"],
        "bestValue": best["value"],
        "generatedAt": "2026-07-16T00:00:00+00:00",
    }


class RecordIsAffectedTests(unittest.TestCase):
    def test_exact_level60_childempties_21_is_affected(self) -> None:
        record = _record(0, 22, [_child("a1", 21, exact=True, level=60)])
        self.assertTrue(migrate.record_is_affected(record))

    def test_exact_level60_childempties_24_is_affected(self) -> None:
        record = _record(0, 25, [_child("a1", 24, exact=True, level=60)])
        self.assertTrue(migrate.record_is_affected(record))

    def test_boundary_childempties_20_is_not_affected(self) -> None:
        """childEmpties==20は新方針(閾値20)でも引き続きexact=true/level=60の
        はずであり、旧方針でも同じ結果になっているため除去対象ではない。"""
        record = _record(0, 21, [_child("a1", 20, exact=True, level=60)])
        self.assertFalse(migrate.record_is_affected(record))

    def test_terminal_child_is_ignored_even_with_high_empties(self) -> None:
        """終局子(level is None)は常にexact=TrueだがEdaxを呼んでおらず閾値ポリシーの
        対象外のため、childEmptiesが21以上でも影響レコード扱いしない。"""
        record = _record(0, 30, [_child("a1", 30, exact=True, level=None)])
        self.assertFalse(migrate.record_is_affected(record))

    def test_heuristic_level16_child_is_not_affected(self) -> None:
        record = _record(0, 30, [_child("a1", 29, exact=False, level=16)])
        self.assertFalse(migrate.record_is_affected(record))

    def test_one_affected_child_among_several_flags_whole_record(self) -> None:
        record = _record(
            0,
            25,
            [
                _child("a1", 29, exact=False, level=16),
                _child("b2", 22, exact=True, level=60),
                _child("c3", 0, exact=True, level=None),
            ],
        )
        self.assertTrue(migrate.record_is_affected(record))


class MigrateShardTests(unittest.TestCase):
    def _write_shard(self, data_dir: Path, records: list[dict], exact_empties_threshold: int = 24) -> tuple[Path, Path]:
        jsonl_path = data_dir / "corpus_test_shard0of1.jsonl"
        meta_path = data_dir / "corpus_test_shard0of1.meta.json"
        with jsonl_path.open("w", encoding="utf-8", newline="\n") as fh:
            for record in records:
                fh.write(json.dumps(record) + "\n")
        settings = {
            "setName": "test",
            "targetCount": len(records),
            "seed": 1,
            "exactEmptiesThreshold": exact_empties_threshold,
            "numShards": 1,
            "shardIndex": 0,
        }
        meta_doc = {
            "schemaVersion": 2,
            "runKey": json.dumps(settings, sort_keys=True),
            "meta": {key: f"old-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS},
            "settings": settings,
            "progress": {"done": len(records), "total": len(records)},
        }
        meta_path.write_text(json.dumps(meta_doc, indent=2) + "\n", encoding="utf-8")
        return jsonl_path, meta_path

    def test_dry_run_does_not_modify_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            records = [
                _record(0, 22, [_child("a1", 21, exact=True, level=60)]),  # affected
                _record(1, 30, [_child("a1", 29, exact=False, level=16)]),  # kept
            ]
            jsonl_path, meta_path = self._write_shard(data_dir, records)
            jsonl_before = jsonl_path.read_bytes()
            meta_before = meta_path.read_bytes()

            with mock.patch.object(migrate, "SET_NAME", "test"), mock.patch.object(migrate, "NUM_SHARDS", 1):
                with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                    stats = migrate.migrate_shard(0, apply=False)

            self.assertEqual(stats["removed"], 1)
            self.assertEqual(stats["kept"], 1)
            self.assertEqual(jsonl_path.read_bytes(), jsonl_before)
            self.assertEqual(meta_path.read_bytes(), meta_before)

    def test_apply_removes_only_affected_records_and_updates_meta(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            affected = _record(0, 22, [_child("a1", 21, exact=True, level=60)])
            kept_heuristic = _record(1, 30, [_child("a1", 29, exact=False, level=16)])
            kept_boundary = _record(2, 21, [_child("a1", 20, exact=True, level=60)])
            kept_terminal = _record(3, 30, [_child("a1", 30, exact=True, level=None)])
            records = [affected, kept_heuristic, kept_boundary, kept_terminal]
            jsonl_path, meta_path = self._write_shard(data_dir, records)

            with mock.patch.object(migrate, "SET_NAME", "test"), mock.patch.object(migrate, "NUM_SHARDS", 1):
                with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                    stats = migrate.migrate_shard(0, apply=True)

            self.assertEqual(stats["removed"], 1)
            self.assertEqual(stats["kept"], 3)
            self.assertEqual(stats["removedPositionIds"], [0])
            self.assertEqual(stats["removedParentEmptiesDistribution"], [22])

            remaining_ids = [json.loads(line)["positionId"] for line in jsonl_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(remaining_ids, [1, 2, 3])

            meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertEqual(meta_doc["settings"]["exactEmptiesThreshold"], 20)
            self.assertEqual(meta_doc["runKey"], json.dumps(meta_doc["settings"], sort_keys=True))
            self.assertEqual(meta_doc["progress"]["done"], 3)
            # 選定に関わる他フィールド(除去対象外)は変更されない。
            self.assertEqual(meta_doc["settings"]["seed"], 1)
            self.assertEqual(meta_doc["settings"]["targetCount"], 4)
            # provenance identityは現環境の値に更新される(旧ダミー値のままではない)。
            self.assertNotEqual(meta_doc["meta"]["harnessSha256"], "old-harnessSha256")

    def test_migrated_checkpoint_resumes_and_removed_ids_become_todo(self) -> None:
        """移行後のmetaで`TeacherCorpusCheckpoint.try_resume()`が正常にTrueを返し、
        除去されたpositionId(0)が`done_ids`に含まれない(=次回resumeで再計算対象に
        なる)ことを確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            affected = _record(0, 22, [_child("a1", 21, exact=True, level=60)])
            kept = _record(1, 30, [_child("a1", 29, exact=False, level=16)])
            jsonl_path, meta_path = self._write_shard(data_dir, [affected, kept])

            with mock.patch.object(migrate, "SET_NAME", "test"), mock.patch.object(migrate, "NUM_SHARDS", 1):
                with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                    migrate.migrate_shard(0, apply=True)

            meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl_path,
                meta_path,
                run_key=meta_doc["runKey"],
                settings=meta_doc["settings"],
                meta=meta_doc["meta"],
            )
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(checkpoint.done_ids, {1})
            self.assertNotIn(0, checkpoint.done_ids)
            # positionId=0は次回のtodo_indices計算(is_done判定)で再計算対象になる。
            self.assertFalse(checkpoint.is_done(0))
            self.assertTrue(checkpoint.is_done(1))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""`eval_opening_book.py`(T151ステージ2)のチェックポイント/再開ロジックの回帰テスト。

実際のEdaxプロセスは起動せず、`vs_edax.edax_solve_batch`をモックして
(1) 初回実行で全局面が評価されチェックポイントに保存されること、
(2) 2回目の実行では既に完了した`positionKey`をスキップし、Edaxを再度呼ばないこと
(決定的なn_tasks=1前提での再開安全性、受け入れ基準3)、
(3) バッチの途中(1回目のEdax呼び出しが返る前)で例外が起きても、
    それまでに保存済みのチェックポイントは壊れずに残ること、
を確認する。
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent

SPEC = importlib.util.spec_from_file_location("eval_opening_book", HERE / "eval_opening_book.py")
assert SPEC and SPEC.loader
eob = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eob)


def _fake_input(tmp_path: Path, n: int) -> Path:
    positions = [
        {"key": f"pos-{i}", "board": "-" * 64, "side": "black" if i % 2 == 0 else "white"}
        for i in range(n)
    ]
    input_path = tmp_path / "opening-book-eval-input.json"
    input_path.write_text(json.dumps({"positions": positions}), encoding="utf-8")
    return input_path


def _fake_edax_solve_batch(positions, level, edax_exe=None):
    # `discDiff`は呼び出し順のインデックスに基づく決定的な値にする(検証しやすいよう)。
    return [{"discDiff": float(i), "depth": level} for i, _ in enumerate(positions)]


@contextlib.contextmanager
def tempdir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


class RunTests(unittest.TestCase):
    def test_first_run_evaluates_all_positions_and_saves_checkpoint(self) -> None:
        with mock.patch.object(eob, "EDAX_EXE") as mock_exe, tempdir() as tmp_path:
            mock_exe.exists.return_value = True
            mock_exe.name = "wEdax-x86-64-v3.exe"
            input_path = _fake_input(tmp_path, 25)
            checkpoint_path = tmp_path / "opening-book-eval-checkpoint.json"

            with mock.patch.object(eob, "INPUT_PATH", input_path), mock.patch.object(
                eob, "CHECKPOINT_PATH", checkpoint_path
            ), mock.patch.object(eob.vs_edax, "edax_solve_batch", side_effect=_fake_edax_solve_batch) as solve, mock.patch.object(
                eob.vs_edax, "sha256_of_file", return_value="fake-sha"
            ):
                eob.run(batch_size=10)

            self.assertTrue(checkpoint_path.exists())
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(len(checkpoint["results"]), 25)
            self.assertEqual(checkpoint["meta"]["completedPositions"], 25)
            self.assertEqual(checkpoint["meta"]["totalPositions"], 25)
            self.assertEqual(checkpoint["meta"]["edaxSha256"], "fake-sha")
            # バッチサイズ10・25局面 -> 3回のEdax呼び出し(10, 10, 5)。
            self.assertEqual(solve.call_count, 3)

    def test_second_run_skips_already_completed_positions(self) -> None:
        with mock.patch.object(eob, "EDAX_EXE") as mock_exe, tempdir() as tmp_path:
            mock_exe.exists.return_value = True
            mock_exe.name = "wEdax-x86-64-v3.exe"
            input_path = _fake_input(tmp_path, 25)
            checkpoint_path = tmp_path / "opening-book-eval-checkpoint.json"

            with mock.patch.object(eob, "INPUT_PATH", input_path), mock.patch.object(
                eob, "CHECKPOINT_PATH", checkpoint_path
            ), mock.patch.object(eob.vs_edax, "edax_solve_batch", side_effect=_fake_edax_solve_batch), mock.patch.object(
                eob.vs_edax, "sha256_of_file", return_value="fake-sha"
            ):
                eob.run(batch_size=10)
                checkpoint_after_first = json.loads(checkpoint_path.read_text(encoding="utf-8"))

            # 2回目: 既に全件完了しているため、Edaxは一度も呼ばれない(再開の要)。
            with mock.patch.object(eob, "INPUT_PATH", input_path), mock.patch.object(
                eob, "CHECKPOINT_PATH", checkpoint_path
            ), mock.patch.object(
                eob.vs_edax, "edax_solve_batch", side_effect=_fake_edax_solve_batch
            ) as solve_second, mock.patch.object(
                eob.vs_edax, "sha256_of_file", return_value="fake-sha"
            ):
                eob.run(batch_size=10)

            solve_second.assert_not_called()
            checkpoint_after_second = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(checkpoint_after_first["results"], checkpoint_after_second["results"])

    def test_partial_progress_survives_a_later_failure(self) -> None:
        """1回目のバッチが成功して保存された後、2回目のバッチでEdax呼び出しが
        例外を投げても、1回目の分のチェックポイントは失われない(要件2:
        「局面単位でチェックポイント保存」の中断安全性)。"""
        with mock.patch.object(eob, "EDAX_EXE") as mock_exe, tempdir() as tmp_path:
            mock_exe.exists.return_value = True
            mock_exe.name = "wEdax-x86-64-v3.exe"
            input_path = _fake_input(tmp_path, 20)
            checkpoint_path = tmp_path / "opening-book-eval-checkpoint.json"

            call_count = {"n": 0}

            def flaky_solve(positions, level, edax_exe=None):
                call_count["n"] += 1
                if call_count["n"] == 2:
                    raise RuntimeError("simulated Edax crash")
                return _fake_edax_solve_batch(positions, level, edax_exe)

            with mock.patch.object(eob, "INPUT_PATH", input_path), mock.patch.object(
                eob, "CHECKPOINT_PATH", checkpoint_path
            ), mock.patch.object(eob.vs_edax, "edax_solve_batch", side_effect=flaky_solve), mock.patch.object(
                eob.vs_edax, "sha256_of_file", return_value="fake-sha"
            ):
                with self.assertRaises(RuntimeError):
                    eob.run(batch_size=10)

            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            # 1バッチ目(10局面)は保存済み、2バッチ目は失敗して未保存のまま。
            self.assertEqual(len(checkpoint["results"]), 10)

            # 再実行すれば残り10局面から再開できる。
            with mock.patch.object(eob, "INPUT_PATH", input_path), mock.patch.object(
                eob, "CHECKPOINT_PATH", checkpoint_path
            ), mock.patch.object(
                eob.vs_edax, "edax_solve_batch", side_effect=_fake_edax_solve_batch
            ) as solve_resume, mock.patch.object(
                eob.vs_edax, "sha256_of_file", return_value="fake-sha"
            ):
                eob.run(batch_size=10)

            self.assertEqual(solve_resume.call_count, 1)  # 残り10局面のみ1バッチで完了
            checkpoint_final = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(len(checkpoint_final["results"]), 20)


if __name__ == "__main__":
    unittest.main()

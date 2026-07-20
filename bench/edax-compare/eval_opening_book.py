#!/usr/bin/env python3
"""T151(拡張ブック生成 フェーズ2/2、ステージ2): `bookgen/opening-book-eval-input.json`
の`positions[]`(拡張定石ブック統合DAGの全ノード・全合法手の着手後局面、重複排除済み。
`app/src/joseki/generateOpeningBookEvalInput.ts` が生成)をEdax level16・n_tasks=1
(決定的)で評価し、`bookgen/opening-book-eval-checkpoint.json` に結果を保存する。

長時間実行タスクの運用ルール(CLAUDE.md)により、1バッチ(既定20局面)を解くたびに
チェックポイントファイルへ追記保存し、進捗をstdoutへ出力する。既に評価済みの
`positionKey`はスキップして再開できる(中断・クラッシュ後の再実行が安全)。

実行: `python bench/edax-compare/eval_opening_book.py [--batch-size 20]`
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import vs_edax

COMPARE_DIR = Path(__file__).resolve().parent
REPO_ROOT = COMPARE_DIR.parent.parent
INPUT_PATH = REPO_ROOT / "bookgen" / "opening-book-eval-input.json"
CHECKPOINT_PATH = REPO_ROOT / "bookgen" / "opening-book-eval-checkpoint.json"
EDAX_EXE_NAME = "wEdax-x86-64-v3.exe"
EDAX_EXE = vs_edax.EDAX_DIR / EDAX_EXE_NAME
LEVEL = 16


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
    return {"meta": {}, "results": {}}


def save_checkpoint(checkpoint: dict) -> None:
    """壊れた途中状態を残さないよう、一時ファイルに書いてから置き換える
    (途中でプロセスが落ちても`CHECKPOINT_PATH`は常に直前の完全な状態を保つ)。"""
    tmp_path = CHECKPOINT_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(
        json.dumps(checkpoint, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(CHECKPOINT_PATH)


def run(batch_size: int) -> None:
    if not EDAX_EXE.exists():
        raise FileNotFoundError(f"Edaxバイナリが見つかりません: {EDAX_EXE}")

    data = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    positions = data["positions"]
    total = len(positions)

    checkpoint = load_checkpoint()
    results: dict = checkpoint.setdefault("results", {})
    meta: dict = checkpoint.setdefault("meta", {})
    meta["edaxLevel"] = LEVEL
    meta["nTasks"] = 1
    meta["edaxExe"] = EDAX_EXE_NAME
    meta["edaxSha256"] = vs_edax.sha256_of_file(EDAX_EXE)
    meta.setdefault("startedAt", _now_iso())
    meta["totalPositions"] = total

    pending = [p for p in positions if p["key"] not in results]
    already_done = total - len(pending)
    print(
        f"[eval_opening_book] total={total} already_done={already_done} pending={len(pending)} "
        f"batch_size={batch_size} edax={EDAX_EXE_NAME} level={LEVEL}",
        flush=True,
    )

    done_count = already_done
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        edax_positions = [{"board": p["board"], "sideToMove": p["side"]} for p in batch]
        batch_t0 = time.time()
        solved = vs_edax.edax_solve_batch(edax_positions, LEVEL, edax_exe=EDAX_EXE)
        batch_elapsed = time.time() - batch_t0

        if len(solved) != len(batch):
            raise RuntimeError(
                f"edax_solve_batch returned {len(solved)} results for {len(batch)} positions"
            )
        for position, solved_entry in zip(batch, solved):
            results[position["key"]] = {
                "discDiff": solved_entry["discDiff"],
                "depth": solved_entry["depth"],
            }

        done_count += len(batch)
        meta["updatedAt"] = _now_iso()
        meta["completedPositions"] = done_count
        save_checkpoint(checkpoint)

        pct = done_count * 100 // total if total else 100
        print(
            f"[eval_opening_book] progress {done_count}/{total} ({pct}%) "
            f"batch={len(batch)} elapsed={batch_elapsed:.2f}s",
            flush=True,
        )

    print(f"[eval_opening_book] done. {done_count}/{total} positions evaluated.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=20,
        help="1回のEdax呼び出し(1プロセス)で解く局面数。呼び出しごとにチェックポイント保存する。",
    )
    args = parser.parse_args()
    run(args.batch_size)


if __name__ == "__main__":
    main()

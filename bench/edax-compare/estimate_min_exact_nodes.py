#!/usr/bin/env python3
"""T107要件1: `estimated_min_exact_nodes`(search.rsのP75テーブル)を
新ソルバー(T099-T105採用後)の実測で作り直す。

方法はコメントに残っているT085の手法を踏襲する: 各空きマス数について
`eval_cli gen`で4局面を生成し(seed=85100+empties)、`eval_cli best
--depth 1 --exact-from-empties 30`で無制限に完全読みしてノード数を
記録、nearest-rank P75(4件中3番目に大きい値)を採用する。

Usage:
  python estimate_min_exact_nodes.py [--min-empties 10] [--max-empties 26]
                                     [--checkpoint PATH]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"
DEFAULT_CHECKPOINT = ROOT / "bench" / "edax-compare" / "endgame-results" / "t107-estimated-min-exact-nodes.json"


def run(cmd: list[str], input_text: str | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstderr={result.stderr}")
    return result.stdout


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            json.dump(data, tmp, indent=2, sort_keys=True)
            tmp.write("\n")
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def gen_positions(empties: int, count: int, seed: int) -> list[dict]:
    cmd = [
        str(EVAL_CLI), "gen", "--category", "t107-estimate",
        "--min-empties", str(empties), "--max-empties", str(empties),
        "--count", str(count), "--seed", str(seed),
    ]
    out = run(cmd)
    return json.loads(out)


def solve_nodes_unconstrained(board: str, side: str) -> int:
    cmd = [
        str(EVAL_CLI), "best", "--depth", "1", "--exact-from-empties", "30",
        "--pattern-weights", str(WEIGHTS),
    ]
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run(cmd, input_text=input_json)
    parsed = json.loads(out)
    assert parsed["score"]["type"] == "exact", (
        f"expected an unconstrained root solve to be exact, got {parsed['score']['type']}"
    )
    return parsed["nodes"]


def nearest_rank_p75(values: list[int]) -> int:
    values_sorted = sorted(values)
    n = len(values_sorted)
    rank = max(1, math.ceil(0.75 * n))
    return values_sorted[rank - 1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--min-empties", type=int, default=10)
    parser.add_argument("--max-empties", type=int, default=26)
    parser.add_argument("--count", type=int, default=4)
    parser.add_argument("--checkpoint", default=str(DEFAULT_CHECKPOINT))
    args = parser.parse_args()

    checkpoint_path = Path(args.checkpoint)
    if checkpoint_path.exists():
        data = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        print(f"[resume] loaded {len(data.get('perEmpties', {}))} empties levels", flush=True)
    else:
        data = {"perEmpties": {}}

    for empties in range(args.min_empties, args.max_empties + 1):
        key = str(empties)
        if key in data["perEmpties"]:
            continue
        seed = 85100 + empties
        positions = gen_positions(empties, args.count, seed)
        node_counts = []
        for pos in positions:
            nodes = solve_nodes_unconstrained(pos["board"], pos["side_to_move"])
            node_counts.append(nodes)
        p75 = nearest_rank_p75(node_counts)
        data["perEmpties"][key] = {"nodeCounts": node_counts, "p75": p75}
        atomic_write_json(checkpoint_path, data)
        print(f"[empties={empties}] nodeCounts={node_counts} p75={p75}", flush=True)

    print("[estimate_min_exact_nodes] complete", flush=True)
    # Rustの定数配列に貼り付けやすい形でも出力する。
    max_key = max(int(k) for k in data["perEmpties"])
    table = []
    for i in range(0, max_key + 1):
        entry = data["perEmpties"].get(str(i))
        table.append(entry["p75"] if entry else None)
    print("Rust P75 table (index=empties, None=not measured, keep existing value):")
    print(table)


if __name__ == "__main__":
    main()

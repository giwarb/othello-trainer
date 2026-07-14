#!/usr/bin/env python3
"""T087: fixed-corpus Edax-oracle regret for PWV3 candidate vs PWV3 v2."""

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "target" / "release" / "eval_cli.exe"
EDAX_DIR = ROOT / "bench" / "edax-compare" / "edax-extract"
EDAX = EDAX_DIR / "wEdax-x86-64.exe"
EVAL_DATA = EDAX_DIR / "data" / "eval.dat"
CORPUS = ROOT / "bench" / "edax-compare" / "t085_exact_positions.json"
ROW = re.compile(r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s")


def run(command, input_value=None, cwd=None):
    result = subprocess.run(command, input=json.dumps(input_value) if input_value is not None else None,
                            text=True, capture_output=True, cwd=cwd)
    if result.returncode:
        raise RuntimeError(f"failed: {command}\n{result.stderr}")
    return result.stdout


def engine_move(position, weights):
    output = run([str(EVAL), "best", "--depth", "8", "--exact-from-empties", "0",
                  "--pattern-weights", str(weights)], position)
    return json.loads(output)["move"]


def apply_move(position, move):
    output = run([str(EVAL), "apply", "--move", move], position)
    return json.loads(output)


def edax_exact(position):
    side = "X" if position["side_to_move"] == "black" else "O"
    temp = EDAX_DIR / "_t087_oracle_tmp.obf"
    try:
        temp.write_text(f'{position["board"]} {side};\n', encoding="ascii")
        output = run([str(EDAX), "-solve", str(temp), "-l", "60", "-eval-file", str(EVAL_DATA),
                      "-book-usage", "off", "-vv"], cwd=EDAX_DIR)
    finally:
        temp.unlink(missing_ok=True)
    scores = [int(match.group(2)) for line in output.splitlines() if (match := ROW.match(line))]
    if not scores:
        raise RuntimeError(f"failed to parse Edax output:\n{output}")
    return scores[-1]


def evaluate(label, weights, positions):
    rows = []
    for index, position in enumerate(positions, 1):
        move = engine_move(position, weights)
        child = apply_move(position, move)
        child_score = edax_exact(child)
        move_value = child_score if child["side_to_move"] == position["side_to_move"] else -child_score
        regret = position["oracleScore"] - move_value
        rows.append({"id": position["id"], "move": move, "moveValue": move_value, "regret": regret})
        print(f"{label} {index}/{len(positions)} {position['id']} move={move} value={move_value} regret={regret}", flush=True)
    return {"label": label, "weights": str(weights), "meanRegret": sum(r["regret"] for r in rows) / len(rows), "rows": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    positions = [p for p in json.loads(CORPUS.read_text(encoding="utf-8"))["positions"] if "oracleScore" in p]
    results = [evaluate("v2", args.v2, positions), evaluate("candidate", args.candidate, positions)]
    args.output.write_text(json.dumps({"depth": 8, "positions": len(positions), "results": results}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({r["label"]: r["meanRegret"] for r in results}))


if __name__ == "__main__":
    main()

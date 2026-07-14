#!/usr/bin/env python3
"""Checkpointed fixed-corpus Edax-oracle regret comparison for pattern weights."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_tree():
    return run(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT).strip()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def engine_move(position, weights):
    output = run([str(EVAL), "best", "--depth", "8", "--exact-from-empties", "0",
                  "--pattern-weights", str(weights)], position)
    return json.loads(output)["move"]


def apply_move(position, move):
    return json.loads(run([str(EVAL), "apply", "--move", move], position))


def edax_exact(position):
    side = "X" if position["side_to_move"] == "black" else "O"
    handle = tempfile.NamedTemporaryFile(prefix="t087-oracle-", suffix=".obf",
                                         dir=EDAX_DIR, delete=False, mode="w", encoding="ascii")
    temp = Path(handle.name)
    try:
        with handle:
            handle.write(f'{position["board"]} {side};\n')
        output = run([str(EDAX), "-solve", str(temp), "-l", "60", "-eval-file", str(EVAL_DATA),
                      "-book-usage", "off", "-vv"], cwd=EDAX_DIR)
    finally:
        temp.unlink(missing_ok=True)
    scores = [int(match.group(2)) for line in output.splitlines() if (match := ROW.match(line))]
    if not scores:
        raise RuntimeError(f"failed to parse Edax output:\n{output}")
    return scores[-1]


def metadata(v2, candidate):
    return {
        "schema": 2, "depth": 8, "gitTree": git_tree(),
        "v2Sha256": digest(v2), "candidateSha256": digest(candidate),
        "evalCliSha256": digest(EVAL), "edaxSha256": digest(EDAX),
        "edaxEvalSha256": digest(EVAL_DATA), "corpusSha256": digest(CORPUS),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stop-after", type=int)
    args = parser.parse_args()
    positions = [p for p in json.loads(CORPUS.read_text(encoding="utf-8"))["positions"]
                 if "oracleScore" in p]
    identity = metadata(args.v2, args.candidate)
    state = {"metadata": identity, "positions": len(positions), "results": [
        {"label": "v2", "weights": str(args.v2), "rows": []},
        {"label": "candidate", "weights": str(args.candidate), "rows": []},
    ]}
    if args.output.exists():
        state = json.loads(args.output.read_text(encoding="utf-8"))
        if state.get("metadata") != identity:
            raise RuntimeError("resume identity mismatch; refusing stale checkpoint")
    processed = 0
    for result, weights in zip(state["results"], (args.v2, args.candidate)):
        completed = {row["id"] for row in result["rows"]}
        for position in positions:
            if position["id"] in completed:
                continue
            move = engine_move(position, weights)
            child = apply_move(position, move)
            child_score = edax_exact(child)
            move_value = child_score if child["side_to_move"] == position["side_to_move"] else -child_score
            regret = position["oracleScore"] - move_value
            result["rows"].append({"id": position["id"], "move": move,
                                   "moveValue": move_value, "regret": regret})
            result["meanRegret"] = sum(row["regret"] for row in result["rows"]) / len(result["rows"])
            atomic_json(args.output, state)
            processed += 1
            print(f'{result["label"]} {len(result["rows"])}/{len(positions)} '
                  f'{position["id"]} move={move} value={move_value} regret={regret}', flush=True)
            if args.stop_after is not None and processed >= args.stop_after:
                print("intentional checkpoint stop", flush=True)
                return
    print(json.dumps({r["label"]: r["meanRegret"] for r in state["results"]}))


if __name__ == "__main__":
    main()

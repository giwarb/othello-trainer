#!/usr/bin/env python3
"""T087: 20-game paired smoke match between candidate and v2 weights."""

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "target" / "release" / "eval_cli.exe"


def run(command, value=None):
    result = subprocess.run(command, input=json.dumps(value) if value is not None else None,
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def best(position, weights, depth):
    return run([str(EVAL), "best", "--depth", str(depth), "--exact-from-empties", "0",
                "--pattern-weights", str(weights)], position)["move"]


def play(start, candidate_black, candidate, v2, depth):
    position = {"board": start["board"], "side_to_move": start["side_to_move"]}
    no_move = 0
    for _ in range(120):
        side = position["side_to_move"]
        candidate_turn = (side == "black") == candidate_black
        move = best(position, candidate if candidate_turn else v2, depth)
        if move is None:
            no_move += 1
            if no_move == 2:
                break
            position["side_to_move"] = "white" if side == "black" else "black"
            continue
        no_move = 0
        position = run([str(EVAL), "apply", "--move", move], position)
    black, white = position["board"].count("X"), position["board"].count("O")
    return (black - white) if candidate_black else (white - black)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--depth", type=int, default=4)
    args = parser.parse_args()
    starts = run([str(EVAL), "gen", "--category", "t087-smoke", "--min-empties", "44",
                  "--max-empties", "50", "--count", "10", "--seed", "87087"])
    rows = []
    for start in starts:
        for candidate_black in (True, False):
            margin = play(start, candidate_black, args.candidate, args.v2, args.depth)
            rows.append({"start": start["id"], "candidateBlack": candidate_black, "margin": margin})
            print(f"game {len(rows)}/20 start={start['id']} candidate_black={candidate_black} margin={margin:+d}", flush=True)
    summary = {"games": 20, "depth": args.depth, "candidateWins": sum(r["margin"] > 0 for r in rows),
               "v2Wins": sum(r["margin"] < 0 for r in rows), "draws": sum(r["margin"] == 0 for r in rows),
               "meanCandidateMargin": sum(r["margin"] for r in rows) / len(rows), "rows": rows}
    args.output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "rows"}))


if __name__ == "__main__":
    main()

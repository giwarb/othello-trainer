#!/usr/bin/env python3
"""Checkpointed 20-game paired smoke match between candidate and v2 weights."""

import argparse
import hashlib
import json
import os
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_tree():
    result = subprocess.run(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT,
                            text=True, capture_output=True, check=True)
    return result.stdout.strip()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


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
    parser.add_argument("--stop-after", type=int)
    args = parser.parse_args()
    starts = run([str(EVAL), "gen", "--category", "t087-smoke", "--min-empties", "44",
                  "--max-empties", "50", "--count", "10", "--seed", "87087"])
    starts_hash = hashlib.sha256(json.dumps(starts, sort_keys=True).encode()).hexdigest()
    identity = {
        "schema": 2, "depth": args.depth, "gitTree": git_tree(),
        "v2Sha256": digest(args.v2), "candidateSha256": digest(args.candidate),
        "evalCliSha256": digest(EVAL), "startsSha256": starts_hash,
    }
    state = {"metadata": identity, "games": 20, "rows": []}
    if args.output.exists():
        state = json.loads(args.output.read_text(encoding="utf-8"))
        if state.get("metadata") != identity:
            raise RuntimeError("resume identity mismatch; refusing stale checkpoint")
    completed = {(row["start"], row["candidateBlack"]) for row in state["rows"]}
    processed = 0
    for start in starts:
        for candidate_black in (True, False):
            key = (start["id"], candidate_black)
            if key in completed:
                continue
            margin = play(start, candidate_black, args.candidate, args.v2, args.depth)
            state["rows"].append({"start": start["id"], "candidateBlack": candidate_black,
                                  "margin": margin})
            rows = state["rows"]
            state["candidateWins"] = sum(r["margin"] > 0 for r in rows)
            state["v2Wins"] = sum(r["margin"] < 0 for r in rows)
            state["draws"] = sum(r["margin"] == 0 for r in rows)
            state["meanCandidateMargin"] = sum(r["margin"] for r in rows) / len(rows)
            atomic_json(args.output, state)
            processed += 1
            print(f'game {len(rows)}/20 start={start["id"]} '
                  f'candidate_black={candidate_black} margin={margin:+d}', flush=True)
            if args.stop_after is not None and processed >= args.stop_after:
                print("intentional checkpoint stop", flush=True)
                return
    print(json.dumps({k: v for k, v in state.items() if k not in ("rows", "metadata")}))


if __name__ == "__main__":
    main()

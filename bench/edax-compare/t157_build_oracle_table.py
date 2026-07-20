#!/usr/bin/env python3
"""Build a full-legal-move Edax exact-value oracle table for the T157 180-position
corpus (T096's 60 + T157's +120 extension).

For every position, records:
  - oracleScore: Edax exact score of the position itself (root, -l 60, book off)
  - moves: {move: value} for every legal move, where value is the Edax exact
    score of the resulting child position, expressed from the *original*
    position's side-to-move perspective (same sign convention as
    compare_pattern_v3.py's engine_move/apply_move/edax_exact pipeline).
  - consistency: best move value from the table must equal oracleScore
    (Edax's root score is by definition the best achievable value).

This lets any number of candidate weight files be re-scored later by a single
cheap eval_cli move lookup per position, without re-invoking Edax per weight.

Checkpointed per-position (atomic write after each position's moves complete),
resumable, deterministic (uses only the Edax exact -l 60 book-off pipeline
already established by T096's compare_pattern_v3.py).
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bench" / "edax-compare"))
from compare_pattern_v3 import EVAL, EDAX, EVAL_DATA, run, digest, git_tree, edax_exact, apply_move  # noqa: E402

DEFAULT_CORPUS = ROOT / "bench/edax-compare/t157_oracle_positions.json"
DEFAULT_OUTPUT = ROOT / "bench/edax-compare/t157_oracle_labels.json"
# Arbitrary fixed weights, used only to enumerate legal moves via `eval_cli moves`.
# Move legality does not depend on pattern weights, so any valid weights file works;
# fixed here for determinism/reproducibility of the exact CLI invocation.
MOVES_WEIGHTS = ROOT / "train/weights/pattern_v2.bin"


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def legal_moves(position):
    payload = {"board": position["board"], "side_to_move": position["side_to_move"]}
    output = run([str(EVAL), "moves", "--depth", "8", "--exact-from-empties", "0",
                 "--pattern-weights", str(MOVES_WEIGHTS)], payload)
    return [m["move"] for m in json.loads(output)["moves"]]


def metadata(corpus):
    # NOTE: deliberately excludes `git rev-parse HEAD^{tree}` from the resume
    # identity (T096 known issue: unrelated concurrent commits elsewhere in the
    # repo change HEAD^{tree} and would otherwise make a valid checkpoint look
    # stale). Identity is scoped to the files this script actually reads.
    return {
        "schema": 1,
        "corpusSha256": digest(corpus),
        "movesWeightsSha256": digest(MOVES_WEIGHTS),
        "evalCliSha256": digest(EVAL), "edaxSha256": digest(EDAX),
        "edaxEvalSha256": digest(EVAL_DATA),
        "oracleMethod": "Edax -l 60 -book-usage off, same pipeline as T096 compare_pattern_v3.py",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--stop-after", type=int, help="stop after N positions processed this run (checkpoint test)")
    args = parser.parse_args()

    positions = json.loads(args.corpus.read_text(encoding="utf-8"))["positions"]
    identity = metadata(args.corpus)
    state = {"metadata": identity, "gitTreeAtLastWrite": git_tree(),
            "totalPositions": len(positions), "rows": []}
    if args.output.exists():
        state = json.loads(args.output.read_text(encoding="utf-8"))
        if state.get("metadata") != identity:
            raise RuntimeError("resume identity mismatch; refusing stale checkpoint "
                               f"(existing={state.get('metadata')}, expected={identity})")
        state["gitTreeAtLastWrite"] = git_tree()

    completed = {row["id"] for row in state["rows"]}
    start = time.time()
    processed_this_run = 0
    for index, position in enumerate(positions, 1):
        if position["id"] in completed:
            continue
        moves = legal_moves(position)
        move_values = {}
        for move in moves:
            child = apply_move(position, move)
            child_score = edax_exact(child)
            value = child_score if child["side_to_move"] == position["side_to_move"] else -child_score
            move_values[move] = value
        oracle_score = edax_exact(position)
        best_from_moves = max(move_values.values()) if move_values else None
        consistent = (best_from_moves == oracle_score) if move_values else None
        state["rows"].append({
            "id": position["id"], "empties": position["empties"], "cohort": position.get("cohort"),
            "oracleScore": oracle_score, "moves": move_values,
            "bestMoveFromTable": best_from_moves, "consistentWithRoot": consistent,
        })
        atomic_json(args.output, state)
        processed_this_run += 1
        elapsed = time.time() - start
        print(f"[{index}/{len(positions)}] id={position['id']} empties={position['empties']} "
              f"moves={len(moves)} oracleScore={oracle_score} consistent={consistent} "
              f"elapsed={elapsed:.1f}s", flush=True)
        if args.stop_after is not None and processed_this_run >= args.stop_after:
            print("intentional checkpoint stop", flush=True)
            return

    inconsistent = [row["id"] for row in state["rows"] if row["consistentWithRoot"] is False]
    print(f"done: {len(state['rows'])}/{len(positions)} positions, "
          f"inconsistent root-vs-best-move={len(inconsistent)}", flush=True)
    if inconsistent:
        print(f"WARNING inconsistent ids: {inconsistent}", flush=True)


if __name__ == "__main__":
    main()

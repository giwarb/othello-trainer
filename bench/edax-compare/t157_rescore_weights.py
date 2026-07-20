#!/usr/bin/env python3
"""T157: bulk re-score existing pattern weight files against the 180-position
oracle table (T096's 60 + T157's +120 extension), without any re-training.

For each weight file, computes per-position regret via a single eval_cli
`best` call (depth 8, exact-from-empties 0 -- identical method to T096's
compare_pattern_v3.py engine_move) and looks the resulting move's exact value
up in the pre-built t157_oracle_labels.json table (no further Edax calls
needed). Aggregates mean regret + position-level bootstrap CI for three
position-count views: existing 60 (cohort t096), new 120 (cohort t157ext),
and combined 180.

Checkpointed per (weight, position); resumable; deterministic.
"""

import argparse
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bench" / "edax-compare"))
from compare_pattern_v3 import EVAL, EDAX, EVAL_DATA, run, digest, git_tree  # noqa: E402

DEFAULT_CORPUS = ROOT / "bench/edax-compare/t157_oracle_positions.json"
DEFAULT_LABELS = ROOT / "bench/edax-compare/t157_oracle_labels.json"
DEFAULT_OUTPUT = ROOT / "bench/edax-compare/t157_rescore_results.json"

WEIGHTS = [
    {"label": "v2", "path": "train/weights/pattern_v2.bin",
     "desc": "v2 baseline (production before T122)"},
    {"label": "v3", "path": "train/weights/pattern_v3.bin",
     "desc": "v3 (T121 adopted candidate = train/data/t087/v3-seed-3.bin), production before T147"},
    {"label": "v4_prod", "path": "train/weights/pattern_v4.bin",
     "desc": "v4 production (T124 seed-3, adopted T125/T147), == train/data/t124/wthor-v4/v4-seed-3.bin"},
    {"label": "t124_seed1", "path": "train/data/t124/wthor-v4/v4-seed-1.bin",
     "desc": "T124 v4xWTHOR seed 1 (part of the 3-seed 1.111 average)"},
    {"label": "t124_seed2", "path": "train/data/t124/wthor-v4/v4-seed-2.bin",
     "desc": "T124 v4xWTHOR seed 2 (part of the 3-seed 1.111 average)"},
    {"label": "t154_runB", "path": "train/data/t154/egaroucid-v4/teacher-only-seed-1/final.bin",
     "desc": "T154 Run B: v4 x Egaroucid @4,431,504 (t090_distillation.rs trainer)"},
    {"label": "t155_e1_seed1", "path": "train/data/t155/egaroucid-v4-e1/v4-seed-1.bin",
     "desc": "T155 E1 seed 1: v4 x Egaroucid @4,431,504 (train_patterns_v3 trainer)"},
    {"label": "t155_e1_seed2", "path": "train/data/t155/egaroucid-v4-e1/v4-seed-2.bin",
     "desc": "T155 E1 seed 2"},
    {"label": "t155_e1_seed3", "path": "train/data/t155/egaroucid-v4-e1/v4-seed-3.bin",
     "desc": "T155 E1 seed 3"},
    {"label": "t155_e2_seed1", "path": "train/data/t155/egaroucid-v4-e2/v4-seed-1.bin",
     "desc": "T155 E2 seed 1 (reference, @8,000,000)"},
]

# Known point estimates from prior tasks, all measured on the *original* T096
# 60-position oracle. Used as an independent cross-check: the cohort=="t096"
# subset of this task's re-scoring must reproduce every one of these exactly,
# not just the v2 M2 guard.
KNOWN_60_REGRET = {
    "v2": 1.5666666666666667,
    "v3": 1.4000000000000001,  # T121: 84/60
    "v4_prod": 0.9666666666666667,  # T124 seed3: 58/60
    "t124_seed1": 0.7,  # 42/60
    "t124_seed2": 1.6666666666666667,  # 100/60
    "t154_runB": 1.2333333333333334,  # 74/60
    "t155_e1_seed1": 1.5333333333333334,  # 92/60
    "t155_e1_seed2": 1.4666666666666666,  # 88/60
    "t155_e1_seed3": 1.6666666666666667,  # 100/60
    "t155_e2_seed1": 1.3666666666666667,  # 82/60
}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def engine_move(position, weights):
    output = run([str(EVAL), "best", "--depth", "8", "--exact-from-empties", "0",
                 "--pattern-weights", str(weights)],
                {"board": position["board"], "side_to_move": position["side_to_move"]})
    return json.loads(output)["move"]


def bootstrap_ci(values, seed, samples):
    if not values:
        return None
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(rng.choice(values) for _ in range(n)) / n for _ in range(samples))

    def percentile(fraction):
        return means[round(fraction * (len(means) - 1))]

    return {"seed": seed, "samples": samples, "n": n,
            "mean": sum(values) / n, "ci95": [percentile(0.025), percentile(0.975)]}


def paired_bootstrap_ci(diffs, seed, samples):
    if not diffs:
        return None
    rng = random.Random(seed)
    n = len(diffs)
    means = sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(samples))

    def percentile(fraction):
        return means[round(fraction * (len(means) - 1))]

    lower, upper = percentile(0.025), percentile(0.975)
    classification = ("worse" if lower > 0 else "improved" if upper < 0 else "no_significant_difference")
    return {"seed": seed, "samples": samples, "n": n,
            "meanDifference": sum(diffs) / n, "ci95": [lower, upper],
            "classification": classification}


def metadata(corpus, labels):
    # NOTE: deliberately excludes `git rev-parse HEAD^{tree}` from the resume
    # identity (T096 known issue: unrelated concurrent commits elsewhere in the
    # repo change HEAD^{tree} and would otherwise make a valid checkpoint look
    # stale). Identity is scoped to the files this script actually reads.
    return {
        "schema": 1,
        "corpusSha256": digest(corpus), "labelsSha256": digest(labels),
        "evalCliSha256": digest(EVAL), "edaxSha256": digest(EDAX), "edaxEvalSha256": digest(EVAL_DATA),
        "weightsSha256": {w["label"]: digest(ROOT / w["path"]) for w in WEIGHTS
                          if (ROOT / w["path"]).exists()},
    }


def run_weight(state, weight, positions, labels_by_id, output_path, stop_after, processed_counter):
    entry = next((r for r in state["results"] if r["label"] == weight["label"]), None)
    if entry is None:
        entry = {"label": weight["label"], "path": weight["path"], "rows": []}
        state["results"].append(entry)
    completed = {row["id"] for row in entry["rows"]}
    for position in positions:
        if position["id"] in completed:
            continue
        label_row = labels_by_id[position["id"]]
        move = engine_move(position, ROOT / weight["path"])
        if move not in label_row["moves"]:
            raise RuntimeError(f"move {move} not found in oracle label table for {position['id']} "
                              f"(available: {sorted(label_row['moves'])})")
        move_value = label_row["moves"][move]
        regret = label_row["oracleScore"] - move_value
        entry["rows"].append({"id": position["id"], "cohort": position.get("cohort"),
                              "move": move, "moveValue": move_value, "regret": regret})
        atomic_json(output_path, state)
        processed_counter[0] += 1
        print(f'{weight["label"]} {len(entry["rows"])}/{len(positions)} {position["id"]} '
              f'move={move} regret={regret}', flush=True)
        if stop_after is not None and processed_counter[0] >= stop_after:
            print("intentional checkpoint stop", flush=True)
            return False
    return True


def summarize(state, bootstrap_seed, bootstrap_samples):
    by_label = {r["label"]: {row["id"]: row for row in r["rows"]} for r in state["results"]}
    v2_rows = by_label.get("v2")
    summary = {}
    for weight in WEIGHTS:
        label = weight["label"]
        rows_by_id = by_label.get(label)
        if rows_by_id is None or len(rows_by_id) < state["totalPositions"]:
            continue
        cohorts = {"n60": "t096", "n120": "t157ext"}
        entry = {"label": label, "path": weight["path"], "desc": weight["desc"]}
        for key, cohort in cohorts.items():
            values = [row["regret"] for row in rows_by_id.values() if row["cohort"] == cohort]
            entry[key] = bootstrap_ci(values, bootstrap_seed, bootstrap_samples)
        all_values = [row["regret"] for row in rows_by_id.values()]
        entry["n180"] = bootstrap_ci(all_values, bootstrap_seed, bootstrap_samples)
        if v2_rows is not None and label != "v2":
            common_ids = sorted(set(rows_by_id) & set(v2_rows))
            diffs180 = [rows_by_id[i]["regret"] - v2_rows[i]["regret"] for i in common_ids]
            entry["vsV2_n180"] = paired_bootstrap_ci(diffs180, bootstrap_seed + 1, bootstrap_samples)
        known = KNOWN_60_REGRET.get(label)
        if known is not None and entry["n60"] is not None:
            entry["knownN60CrossCheck"] = {"expected": known, "actual": entry["n60"]["mean"],
                                           "match": abs(entry["n60"]["mean"] - known) < 1e-9}
        summary[label] = entry
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--bootstrap-seed", type=int, default=157002)
    parser.add_argument("--bootstrap-samples", type=int, default=100000)
    parser.add_argument("--stop-after", type=int, help="stop after N eval_cli calls this run (checkpoint test)")
    args = parser.parse_args()

    corpus_doc = json.loads(args.corpus.read_text(encoding="utf-8"))
    positions = corpus_doc["positions"]
    labels_doc = json.loads(args.labels.read_text(encoding="utf-8"))
    labels_by_id = {row["id"]: row for row in labels_doc["rows"]}
    if len(labels_by_id) != len(positions):
        raise RuntimeError(f"labels incomplete: {len(labels_by_id)}/{len(positions)}")
    inconsistent = [row["id"] for row in labels_doc["rows"] if row["consistentWithRoot"] is False]
    if inconsistent:
        raise RuntimeError(f"oracle label table has inconsistent rows: {inconsistent}")

    identity = metadata(args.corpus, args.labels)
    state = {"metadata": identity, "gitTreeAtLastWrite": git_tree(),
            "totalPositions": len(positions), "results": []}
    if args.output.exists():
        state = json.loads(args.output.read_text(encoding="utf-8"))
        if state.get("metadata") != identity:
            raise RuntimeError("resume identity mismatch; refusing stale checkpoint")
        state["gitTreeAtLastWrite"] = git_tree()

    processed_counter = [0]
    for weight in WEIGHTS:
        weight_file = ROOT / weight["path"]
        if not weight_file.exists():
            print(f'SKIP {weight["label"]}: weight file not found at {weight["path"]}', flush=True)
            continue
        completed_ok = run_weight(state, weight, positions, labels_by_id, args.output,
                                  args.stop_after, processed_counter)
        if not completed_ok:
            return

    summary = summarize(state, args.bootstrap_seed, args.bootstrap_samples)
    state["summary"] = summary
    atomic_json(args.output, state)
    print(json.dumps({label: {"n60": s["n60"]["mean"] if s.get("n60") else None,
                              "n120": s["n120"]["mean"] if s.get("n120") else None,
                              "n180": s["n180"]["mean"] if s.get("n180") else None}
                      for label, s in summary.items()}, indent=2))


if __name__ == "__main__":
    main()

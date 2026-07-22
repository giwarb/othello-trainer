#!/usr/bin/env python3
"""T194: 深さ10・MPC t=1.0 vs Edax lv10(60局)を、T175 P2(深さ12・MPC t=1.5
暗黙・vs lv10、同一開幕セット60局)とpaired比較する。

T175/T176と同一の統計手法(paired bootstrap・符号検定、開幕単位n=30・局単位
n=60、配列順は開幕番号昇順→黒番→白番)を踏襲する。T176の
`t176_confirmation_compare.py`をベースにしているが、本タスクは意図的に
`engine_depth`(12→10)と`engine_mpc_margin_t`(暗黙1.5→明示1.0)の2点を
差分として持つため、設定一致検証(`validate_settings_match`)からこの2キーを
除外している(T176は「t以外は完全一致」を前提にしていたが、本タスクは
「深さ10どうしの比較」が目的でMPC tもT176選定値に合わせているため)。
"""
import argparse
import hashlib
import json
import random
import statistics
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                     encoding="utf-8", newline="\n")
    temp.replace(path)


def percentile(values, probability):
    ordered = sorted(values)
    index = (len(ordered) - 1) * probability
    lo, hi = int(index), min(int(index) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo)


def upper95(values):
    return percentile(values, 0.975)


def lower95(values):
    return percentile(values, 0.025)


def bootstrap_ci(values, samples, seed):
    rng = random.Random(seed)
    n = len(values)
    means = []
    for _ in range(samples):
        chosen = [values[rng.randrange(n)] for _ in range(n)]
        means.append(sum(chosen) / n)
    return lower95(means), upper95(means)


def sign_test_p(diffs):
    nonzero = [d for d in diffs if d != 0]
    n = len(nonzero)
    if n == 0:
        return 1.0
    improved = sum(1 for d in nonzero if d > 0)
    p = 0.5
    mean = n * p
    var = n * p * (1 - p)
    if var == 0:
        return 1.0
    z = (improved - mean) / (var ** 0.5)
    import math
    def norm_cdf(x):
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return 2 * (1 - norm_cdf(abs(z)))


# T176由来の設定一致ガード。本タスクは engine_depth と engine_mpc_margin_t が
# 意図的に異なる(深さ12→10、MPC t暗黙1.5→明示1.0)ため、この2キーは
# REQUIRED_MATCHING_SETTINGSから除外する。それ以外は完全一致を要求する。
REQUIRED_MATCHING_SETTINGS = [
    "engine_exact_from_empties", "engine_time_ms", "engine_max_nodes",
    "engine_exact_quota_percent", "unlimited_exact_empties", "engine_tt_mb", "weights",
    "engine_enable_mpc", "opening_set", "opening_count", "openings_sha256",
]

# 差分として許容する(検証はするが不一致を許す)キー。
EXPECTED_DIFFERING_SETTINGS = ["engine_depth", "engine_mpc_margin_t"]


def validate_settings(baseline_doc, candidate_doc):
    baseline_settings = baseline_doc.get("settings", {})
    candidate_settings = candidate_doc.get("settings", {})
    mismatches = []
    for key in REQUIRED_MATCHING_SETTINGS:
        baseline_value = baseline_settings.get(key)
        candidate_value = candidate_settings.get(key)
        if baseline_value != candidate_value:
            mismatches.append(f"settings.{key}: baseline={baseline_value!r} candidate={candidate_value!r}")
    baseline_weights_sha = baseline_doc.get("meta", {}).get("weightsSha256")
    candidate_weights_sha = candidate_doc.get("meta", {}).get("weightsSha256")
    if baseline_weights_sha != candidate_weights_sha:
        mismatches.append(
            f"meta.weightsSha256: baseline={baseline_weights_sha!r} candidate={candidate_weights_sha!r}"
        )
    baseline_edax_sha = baseline_doc.get("meta", {}).get("edaxSha256")
    candidate_edax_sha = candidate_doc.get("meta", {}).get("edaxSha256")
    if baseline_edax_sha != candidate_edax_sha:
        mismatches.append(
            f"meta.edaxSha256: baseline={baseline_edax_sha!r} candidate={candidate_edax_sha!r}"
        )
    if mismatches:
        raise ValueError(
            "baseline/candidate settings mismatch beyond the expected depth/mpc_margin_t diff "
            "(confounded comparison, refusing to aggregate):\n  " + "\n  ".join(mismatches)
        )
    differing = {}
    for key in EXPECTED_DIFFERING_SETTINGS:
        differing[key] = (baseline_settings.get(key), candidate_settings.get(key))
    return differing


def by_opening_id(games, first_n):
    by_id = {}
    for game in games:
        by_id.setdefault(game["start_id"], []).append(game)
    ids = sorted(by_id, key=lambda s: int(s.split("-")[-1]))[:first_n]
    return {i: by_id[i] for i in ids}


def opening_margin_mean(games_for_opening):
    return statistics.mean(game["margin_engine_minus_edax"] for game in games_for_opening)


def engine_move_records(game):
    return [move["engine"] for move in game["moves"] if move.get("mover") == "engine" and "engine" in move]


def analyze(baseline_games, candidate_games, first_n, samples, seed):
    baseline_by_opening = by_opening_id(baseline_games, first_n)
    candidate_by_opening = by_opening_id(candidate_games, first_n)
    if set(baseline_by_opening) != set(candidate_by_opening):
        raise ValueError("opening id sets differ between baseline and candidate")

    opening_ids = sorted(baseline_by_opening, key=lambda s: int(s.split("-")[-1]))
    baseline_opening_means = [opening_margin_mean(baseline_by_opening[i]) for i in opening_ids]
    candidate_opening_means = [opening_margin_mean(candidate_by_opening[i]) for i in opening_ids]
    opening_diffs = [c - b for b, c in zip(baseline_opening_means, candidate_opening_means)]

    baseline_flat = [g for i in opening_ids for g in baseline_by_opening[i]]
    candidate_flat = [g for i in opening_ids for g in candidate_by_opening[i]]
    baseline_game_margins = [g["margin_engine_minus_edax"] for g in baseline_flat]
    candidate_game_margins = [g["margin_engine_minus_edax"] for g in candidate_flat]
    baseline_by_key = {(g["start_id"], g["engine_is_black"]): g for g in baseline_flat}
    candidate_by_key = {(g["start_id"], g["engine_is_black"]): g for g in candidate_flat}
    if set(baseline_by_key) != set(candidate_by_key):
        raise ValueError("game key sets differ between baseline and candidate")
    game_keys = sorted(baseline_by_key, key=lambda k: (int(k[0].split("-")[-1]), not k[1]))
    game_diffs = [
        candidate_by_key[k]["margin_engine_minus_edax"] - baseline_by_key[k]["margin_engine_minus_edax"]
        for k in game_keys
    ]

    opening_ci = bootstrap_ci(opening_diffs, samples, seed)
    game_ci = bootstrap_ci(game_diffs, samples, seed + 1)

    def win_draw_loss(games):
        w = sum(1 for g in games if g["winner"] == "engine")
        d = sum(1 for g in games if g["winner"] == "draw")
        loss = sum(1 for g in games if g["winner"] == "edax")
        return w, d, loss

    baseline_wdl = win_draw_loss(baseline_flat)
    candidate_wdl = win_draw_loss(candidate_flat)

    baseline_moves = [m for g in baseline_flat for m in engine_move_records(g)]
    candidate_moves = [m for g in candidate_flat for m in engine_move_records(g)]
    baseline_times = [m["elapsedMs"] for m in baseline_moves]
    candidate_times = [m["elapsedMs"] for m in candidate_moves]
    baseline_nodes = [m["nodes"] for m in baseline_moves]
    candidate_nodes = [m["nodes"] for m in candidate_moves]
    baseline_wall = [g["wallClockSec"] for g in baseline_flat]
    candidate_wall = [g["wallClockSec"] for g in candidate_flat]

    def timing_pctiles(values):
        s = sorted(values)
        return {
            "mean": statistics.mean(values),
            "p50": percentile(s, 0.50),
            "p90": percentile(s, 0.90),
            "max": max(values),
        }

    baseline_node_limit_hits = sum(1 for m in baseline_moves if m.get("nodeLimitHit"))
    candidate_node_limit_hits = sum(1 for m in candidate_moves if m.get("nodeLimitHit"))
    baseline_wall_insurance = sum(
        1 for m in baseline_moves if m.get("timedOut") and not m.get("nodeLimitHit")
    )
    candidate_wall_insurance = sum(
        1 for m in candidate_moves if m.get("timedOut") and not m.get("nodeLimitHit")
    )

    return {
        "openingLevel": {
            "n": len(opening_ids), "meanDiff": statistics.mean(opening_diffs),
            "ci95": list(opening_ci), "signTestP": sign_test_p(opening_diffs),
            "baselineMean": statistics.mean(baseline_opening_means),
            "candidateMean": statistics.mean(candidate_opening_means),
            "improved": sum(1 for d in opening_diffs if d > 0),
            "worsened": sum(1 for d in opening_diffs if d < 0),
            "tied": sum(1 for d in opening_diffs if d == 0),
        },
        "gameLevel": {
            "n": len(game_keys), "meanDiff": statistics.mean(game_diffs),
            "ci95": list(game_ci), "signTestP": sign_test_p(game_diffs),
            "baselineMean": statistics.mean(baseline_game_margins),
            "candidateMean": statistics.mean(candidate_game_margins),
            "improved": sum(1 for d in game_diffs if d > 0),
            "worsened": sum(1 for d in game_diffs if d < 0),
            "tied": sum(1 for d in game_diffs if d == 0),
        },
        "wdl": {"baseline": baseline_wdl, "candidate": candidate_wdl},
        "timing": {
            "baselineMoveMs": timing_pctiles(baseline_times),
            "candidateMoveMs": timing_pctiles(candidate_times),
            "baselineMoveNodes": timing_pctiles(baseline_nodes),
            "candidateMoveNodes": timing_pctiles(candidate_nodes),
            "baselineWallClockSecMean": statistics.mean(baseline_wall),
            "candidateWallClockSecMean": statistics.mean(candidate_wall),
            "baselineWallClockSecMin": min(baseline_wall),
            "candidateWallClockSecMin": min(candidate_wall),
            "baselineWallClockSecMax": max(baseline_wall),
            "candidateWallClockSecMax": max(candidate_wall),
            "baselineMoveCount": len(baseline_times),
            "candidateMoveCount": len(candidate_times),
            "baselineNodeLimitHits": baseline_node_limit_hits,
            "candidateNodeLimitHits": candidate_node_limit_hits,
            "baselineWallInsuranceFired": baseline_wall_insurance,
            "candidateWallInsuranceFired": candidate_wall_insurance,
        },
        "openingIds": opening_ids,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", type=Path, required=True, help="T175 P2 60-game results (depth12, vs lv10)")
    p.add_argument("--candidate", type=Path, required=True, help="T194 60-game results (depth10, vs lv10)")
    p.add_argument("--first-n-openings", type=int, default=30)
    p.add_argument("--bootstrap-samples", type=int, default=100000)
    p.add_argument("--bootstrap-seed", type=int, default=194004)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    baseline_doc, candidate_doc = load(args.baseline), load(args.candidate)
    differing_settings = validate_settings(baseline_doc, candidate_doc)
    result = analyze(
        baseline_doc["games"], candidate_doc["games"], args.first_n_openings,
        args.bootstrap_samples, args.bootstrap_seed,
    )
    meta = {
        "schemaVersion": 1,
        "task": "T194",
        "analysis": "depth10+MPC(t=1.0) vs Edax lv10, paired vs T175 P2 (depth12+MPC implicit t=1.5, vs Edax lv10)",
        "bootstrapSamples": args.bootstrap_samples, "bootstrapSeed": args.bootstrap_seed,
        "settingsGuard": {
            "requiredMatchingKeys": REQUIRED_MATCHING_SETTINGS + ["meta.weightsSha256", "meta.edaxSha256"],
            "passed": True,
            "expectedDiffering": differing_settings,
        },
        "inputs": {
            "baseline": {"path": args.baseline.as_posix(), "sha256": digest(args.baseline)},
            "candidate": {"path": args.candidate.as_posix(), "sha256": digest(args.candidate)},
        },
        "result": result,
    }
    atomic_json(args.out, meta)
    print(json.dumps({
        "openingMeanDiff": result["openingLevel"]["meanDiff"],
        "openingCi95": result["openingLevel"]["ci95"],
        "gameMeanDiff": result["gameLevel"]["meanDiff"],
        "candidateWdl": result["wdl"]["candidate"],
        "candidateOpeningMean": result["openingLevel"]["candidateMean"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()

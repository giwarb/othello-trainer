#!/usr/bin/env python3
"""T176要件1-3: 確認対局(深さベース+MPC(選定t) vs Edax lv12、30局、T175 P1と
同一開幕の前半15ペア)の結果を、T175 P1(t=1.5、同じ15開幕の部分集合)との
paired比較で評価する。あわせて1局あたり時間の短縮を実測する。

同一手法(paired bootstrap・符号検定、開幕単位n=15・局単位n=30)をT175/T156d/
T166/T169と共通化。配列順は開幕番号昇順→黒番→白番(T175と同じ規約)。
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


def atomic_text(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(value, encoding="utf-8", newline="\n")
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
    # 両側二項検定(正規近似、既存レポート踏襲の簡易p値)。
    p = 0.5
    mean = n * p
    var = n * p * (1 - p)
    if var == 0:
        return 1.0
    z = (improved - mean) / (var ** 0.5)
    # 標準正規分布の両側p値(誤差関数近似、外部ライブラリ非依存)。
    import math
    def norm_cdf(x):
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return 2 * (1 - norm_cdf(abs(z)))


# T176 redo#1: baseline/candidateが実は同じ探索条件で対局していなかった
# (candidateが`--engine-exact-from-empties`の渡し忘れで既定18のままbaseline
# の16と食い違い、「tだけを変えた対照実験」の前提が崩れていた)ことがverifier
# で検出された。再発防止として、比較対象2ファイルの主要settingsキー
# (t以外は同一であるべきもの)が一致するかを実際に比較する前に機械検証し、
# 不一致ならエラーで拒否する(黙って交絡した比較を行わない)。
REQUIRED_MATCHING_SETTINGS = [
    "engine_depth", "engine_exact_from_empties", "engine_time_ms", "engine_max_nodes",
    "engine_exact_quota_percent", "unlimited_exact_empties", "engine_tt_mb", "weights",
]


def validate_settings_match(baseline_doc, candidate_doc):
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
    if mismatches:
        raise ValueError(
            "baseline/candidate settings mismatch (confounded comparison, refusing to aggregate):\n  "
            + "\n  ".join(mismatches)
        )


def by_opening_id(games, first_n):
    by_id = {}
    for game in games:
        by_id.setdefault(game["start_id"], []).append(game)
    ids = sorted(by_id, key=lambda s: int(s.split("-")[-1]))[:first_n]
    return {i: by_id[i] for i in ids}


def opening_margin_mean(games_for_opening):
    return statistics.mean(game["margin_engine_minus_edax"] for game in games_for_opening)


def engine_move_times_ms(game):
    return [
        move["engine"]["elapsedMs"]
        for move in game["moves"]
        if move.get("mover") == "engine" and "engine" in move
    ]


def engine_move_nodes(game):
    return [
        move["engine"]["nodes"]
        for move in game["moves"]
        if move.get("mover") == "engine" and "engine" in move
    ]


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
    # 局単位は(start_id, engine_is_black)でペアリングする(黒番同士・白番同士)。
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

    baseline_move_times = [t for g in baseline_flat for t in engine_move_times_ms(g)]
    candidate_move_times = [t for g in candidate_flat for t in engine_move_times_ms(g)]
    baseline_wall = [g["wallClockSec"] for g in baseline_flat]
    candidate_wall = [g["wallClockSec"] for g in candidate_flat]
    baseline_move_nodes = [n for g in baseline_flat for n in engine_move_nodes(g)]
    candidate_move_nodes = [n for g in candidate_flat for n in engine_move_nodes(g)]

    return {
        "openingLevel": {
            "n": len(opening_ids), "meanDiff": statistics.mean(opening_diffs),
            "ci95": list(opening_ci), "signTestP": sign_test_p(opening_diffs),
            "baselineMean": statistics.mean(baseline_opening_means),
            "candidateMean": statistics.mean(candidate_opening_means),
        },
        "gameLevel": {
            "n": len(game_keys), "meanDiff": statistics.mean(game_diffs),
            "ci95": list(game_ci), "signTestP": sign_test_p(game_diffs),
            "baselineMean": statistics.mean(baseline_game_margins),
            "candidateMean": statistics.mean(candidate_game_margins),
        },
        "timing": {
            "baselineMoveMsMean": statistics.mean(baseline_move_times),
            "candidateMoveMsMean": statistics.mean(candidate_move_times),
            "moveMsReductionPercent": (
                100.0 * (1 - statistics.mean(candidate_move_times) / statistics.mean(baseline_move_times))
            ),
            "baselineMoveCount": len(baseline_move_times),
            "candidateMoveCount": len(candidate_move_times),
            "baselineWallClockSecMean": statistics.mean(baseline_wall),
            "candidateWallClockSecMean": statistics.mean(candidate_wall),
            "wallClockReductionPercent": (
                100.0 * (1 - statistics.mean(candidate_wall) / statistics.mean(baseline_wall))
            ),
            "note": (
                "elapsedMs/wallClockSecは壁時計ベースで、baseline(T175 P1)とcandidate"
                "(本タスク)は別々のプロセス実行(実行時刻・システム負荷が異なりうる)のため、"
                "マシン負荷変動の影響を受ける参考値に留める。決定的で比較に適した指標は"
                "moveNodesMean/nodeReductionPercent(ノード数、壁時計に依存しない)。"
            ),
            "baselineMoveNodesMean": statistics.mean(baseline_move_nodes),
            "candidateMoveNodesMean": statistics.mean(candidate_move_nodes),
            "nodeReductionPercent": (
                100.0 * (1 - statistics.mean(candidate_move_nodes) / statistics.mean(baseline_move_nodes))
            ),
        },
        "openingIds": opening_ids,
    }


def report(meta):
    r = meta["result"]
    lines = ["# T176 確認対局: t=1.0 vs T175 P1(t=1.5)ベースライン、前半15開幕", "",
             "## 結論", "",
             f"- 開幕単位(n={r['openingLevel']['n']}) 平均差(candidate-baseline): "
             f"{r['openingLevel']['meanDiff']:+.4f}石、95%CI[{r['openingLevel']['ci95'][0]:+.4f}, "
             f"{r['openingLevel']['ci95'][1]:+.4f}]、符号検定p={r['openingLevel']['signTestP']:.4f}",
             f"- 局単位(n={r['gameLevel']['n']}) 平均差: {r['gameLevel']['meanDiff']:+.4f}石、"
             f"95%CI[{r['gameLevel']['ci95'][0]:+.4f}, {r['gameLevel']['ci95'][1]:+.4f}]、"
             f"符号検定p={r['gameLevel']['signTestP']:.4f}",
             f"- **1手あたりノード数(壁時計非依存、決定的な速度指標)**: baseline(t=1.5) "
             f"{r['timing']['baselineMoveNodesMean']:.0f} → candidate(t=1.0) "
             f"{r['timing']['candidateMoveNodesMean']:.0f} "
             f"({r['timing']['nodeReductionPercent']:+.2f}%削減)",
             f"- 1手あたり時間(壁時計、参考値): baseline(t=1.5) {r['timing']['baselineMoveMsMean']:.1f}ms → "
             f"candidate(t=1.0) {r['timing']['candidateMoveMsMean']:.1f}ms "
             f"({r['timing']['moveMsReductionPercent']:+.2f}%短縮)",
             f"- 1局あたり所要時間(壁時計、参考値): baseline {r['timing']['baselineWallClockSecMean']:.2f}s → "
             f"candidate {r['timing']['candidateWallClockSecMean']:.2f}s "
             f"({r['timing']['wallClockReductionPercent']:+.2f}%短縮)",
             "", f"**注意**: {r['timing']['note']}", "", "## 判定基準への当てはめ", "",
             "T175 P1とのpaired比較で「大きな悪化(平均-2石超かつCI全体マイナス)」がないこと:", ""]
    ci = r["openingLevel"]["ci95"]
    big_regression = r["openingLevel"]["meanDiff"] < -2.0 and ci[1] < 0
    lines.append(
        f"- 開幕単位平均差{r['openingLevel']['meanDiff']:+.4f}石、CI上限{ci[1]:+.4f} → "
        f"{'大きな悪化あり(基準未達)' if big_regression else '大きな悪化なし(基準内)'}"
    )
    lines += ["", "## 開幕一覧", "", ", ".join(r["openingIds"])]
    return "\n".join(lines)


def self_test():
    matching_settings = {
        "engine_depth": 12, "engine_exact_from_empties": 16, "engine_time_ms": 15000,
        "engine_max_nodes": 100000000, "engine_exact_quota_percent": 60,
        "unlimited_exact_empties": 20, "engine_tt_mb": 64, "weights": "train/weights/pattern_v6.bin",
    }
    baseline_doc = {"settings": matching_settings, "meta": {"weightsSha256": "abc"}}
    candidate_doc = {"settings": dict(matching_settings), "meta": {"weightsSha256": "abc"}}
    validate_settings_match(baseline_doc, candidate_doc)  # should not raise

    mismatched_candidate = {"settings": {**matching_settings, "engine_exact_from_empties": 18},
                             "meta": {"weightsSha256": "abc"}}
    try:
        validate_settings_match(baseline_doc, mismatched_candidate)
        raise AssertionError("expected ValueError for exact_from_empties mismatch")
    except ValueError as e:
        assert "engine_exact_from_empties" in str(e)

    mismatched_weights = {"settings": dict(matching_settings), "meta": {"weightsSha256": "different"}}
    try:
        validate_settings_match(baseline_doc, mismatched_weights)
        raise AssertionError("expected ValueError for weightsSha256 mismatch")
    except ValueError as e:
        assert "weightsSha256" in str(e)

    print("self-test passed")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", type=Path, help="T175 P1 60-game results (t=1.5)")
    p.add_argument("--candidate", type=Path, help="T176 confirmation results (selected t)")
    p.add_argument("--first-n-openings", type=int, default=15)
    p.add_argument("--bootstrap-samples", type=int, default=100000)
    p.add_argument("--bootstrap-seed", type=int, default=176004)
    p.add_argument("--out", type=Path)
    p.add_argument("--report", type=Path)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return
    if any(x is None for x in (args.baseline, args.candidate, args.out, args.report)):
        p.error("--baseline, --candidate, --out, and --report are required (unless --self-test)")
    baseline_doc, candidate_doc = load(args.baseline), load(args.candidate)
    validate_settings_match(baseline_doc, candidate_doc)
    result = analyze(
        baseline_doc["games"], candidate_doc["games"], args.first_n_openings,
        args.bootstrap_samples, args.bootstrap_seed,
    )
    meta = {
        "schemaVersion": 1,
        "task": "T176",
        "analysis": "confirmation match: selected t vs T175 P1 baseline (t=1.5), first N openings",
        "bootstrapSamples": args.bootstrap_samples, "bootstrapSeed": args.bootstrap_seed,
        "settingsGuard": {
            "checkedKeys": REQUIRED_MATCHING_SETTINGS + ["meta.weightsSha256"],
            "passed": True,
        },
        "inputs": {
            "baseline": {"path": args.baseline.as_posix(), "sha256": digest(args.baseline)},
            "candidate": {"path": args.candidate.as_posix(), "sha256": digest(args.candidate)},
        },
        "result": result,
    }
    atomic_json(args.out, meta)
    atomic_text(args.report, report(meta))
    print(json.dumps({
        "openingMeanDiff": result["openingLevel"]["meanDiff"],
        "moveMsReductionPercent": result["timing"]["moveMsReductionPercent"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()

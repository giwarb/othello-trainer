#!/usr/bin/env python3
"""T176要件1-2: MPC積極化の事前登録スクリーニング(既存測定データを流用、
新規のengine探索は行わない)。

方法(T156b Gate1の`proxy()`〔held-out root NWS[-1,0)近似〕を一般化):
`t172_v6_pilot_measurements.json`(v6・320局面pilot・depths
[2,3,4,6,8,10,12]の実測shallow/deepスコア+ノード数)と
`t172_v6_pilot_stats.json`(同コーパスのaffine回帰係数・sigma、calibration
splitでfit)を使い、held-out(tuning+test)split上で、候補4ペア
(d,D)=(3,6),(4,8),(2,10),(4,12)×4空き帯について、tごとに
margin=ceil(t*sigma)を適用した「もしこの局面がNWS `[-1,0)` でのroot探索
だったら」という近似ウィンドウでMPCのfail-high/fail-low判定を再現する。

指標:
- cutRate: 判定が発火した割合
- wrongCutRate: 発火した判定が実際のdeepスコアの符号と矛盾した割合
  (=「間違ったcut」、真の値と逆側を切ってしまうケース)
- agreementRate: 1 - (全体に対するwrongCutの割合)。「MPC-offの判断と
  一致したとみなせる」局面の割合の近似(cutが起きなければ自明に一致、
  wrongCutのときだけ不一致とみなす)
- meanEvalError: wrongCutが起きた局面についてのみ|deepScore|/100(石)を
  カウントし、全局面数で平均した値(石差換算の期待誤差)
- estimatedNodeImprovement: T156b と同じ粗い収支
  (savedDeepNodes - probeNodes) / deepNodes

**注意(レポートにも明記)**: これは実際の探索木のノード予算・分岐構造を
再現するライブ計測ではなく、単一ノードを「たまたま親のNWS `[-1,0)`
プローブ対象だった」と仮定する静的近似(T156bのGate 1と同じ手法)。
事前登録の選定規準(要件1-2)を満たすtの絞り込みに使い、実際の妥当性は
要件1-3の確認対局(実際のeval_cli探索、Edax対局)で検証する。
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

CANDIDATE_PAIRS = [(3, 6), (4, 8), (2, 10), (4, 12)]
BUCKETS = ["21-28", "29-36", "37-44", "45-52"]
T_VALUES = [1.5, 1.3, 1.2, 1.1, 1.0]
HELD_OUT_SPLITS = ("tuning", "test")


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


def group_key(g):
    return (g["emptyBucket"], g["shallowDepth"], g["deepDepth"])


def screen_pair_bucket(records, shallow, deep, slope, intercept, sigma, t):
    """1つの(bucket, shallow, deep)グループについて、指定tでの
    proxy統計を計算する。`records`はheld-outsplitに属する
    (shallow, deep両方が測定済みの)行のみを渡すこと。"""
    margin = math.ceil(t * sigma)
    n = 0
    cuts = 0
    wrong_cuts = 0
    eval_error_sum = 0.0
    saved_deep_nodes = 0
    probe_nodes_sum = 0
    deep_nodes_sum = 0
    for row in records:
        values = {item["depth"]: item for item in row["results"]}
        if shallow not in values or deep not in values:
            continue
        shallow_item, deep_item = values[shallow], values[deep]
        n += 1
        predicted = slope * shallow_item["score"] + intercept
        hi = predicted - margin >= 0
        lo = predicted + margin <= -1
        deep_score = deep_item["score"]
        probe_nodes_sum += shallow_item["nodes"]
        deep_nodes_sum += deep_item["nodes"]
        if hi or lo:
            cuts += 1
            wrong = (hi and deep_score < 0) or (lo and deep_score >= 0)
            if wrong:
                wrong_cuts += 1
                eval_error_sum += abs(deep_score) / 100.0
            else:
                saved_deep_nodes += deep_item["nodes"]
    if n == 0:
        return None
    return {
        "n": n, "cuts": cuts, "wrongCuts": wrongCutsVal(wrong_cuts),
        "cutRate": cuts / n, "wrongCutRate": (wrong_cuts / cuts) if cuts else 0.0,
        "agreementRate": 1.0 - (wrong_cuts / n), "meanEvalError": eval_error_sum / n,
        "estimatedNodeImprovement": (
            (saved_deep_nodes - probe_nodes_sum) / deep_nodes_sum if deep_nodes_sum else 0.0
        ),
        "margin": margin,
    }


def wrongCutsVal(x):
    return x


def screen(measurements, stats):
    by_key = {group_key(g): g for g in stats["groups"]}
    held_out_records = [row for row in measurements["records"] if row["split"] in HELD_OUT_SPLITS]
    results = {}
    for t in T_VALUES:
        pair_bucket_rows = []
        for shallow, deep in CANDIDATE_PAIRS:
            for bucket in BUCKETS:
                group = by_key[(bucket, shallow, deep)]
                bucket_records = [row for row in held_out_records if row["emptyBucket"] == bucket]
                stat = screen_pair_bucket(
                    bucket_records, shallow, deep, group["slope"], group["intercept"],
                    group["residualSigma"], t,
                )
                if stat is None:
                    continue
                pair_bucket_rows.append({
                    "emptyBucket": bucket, "shallowDepth": shallow, "deepDepth": deep, **stat,
                })
        total_n = sum(row["n"] for row in pair_bucket_rows)
        total_cuts = sum(row["cuts"] for row in pair_bucket_rows)
        total_wrong = sum(row["wrongCuts"] for row in pair_bucket_rows)
        total_error = sum(row["meanEvalError"] * row["n"] for row in pair_bucket_rows)
        agreement_rate = 1.0 - (total_wrong / total_n) if total_n else None
        mean_eval_error = total_error / total_n if total_n else None
        results[str(t)] = {
            "rows": pair_bucket_rows,
            "aggregate": {
                "n": total_n, "cuts": total_cuts, "wrongCuts": total_wrong,
                "cutRate": total_cuts / total_n if total_n else None,
                "agreementRate": agreement_rate, "meanEvalError": mean_eval_error,
            },
        }
    return results


def apply_criterion(results, baseline_t="1.5"):
    """事前登録規準: 一致率の低下が2pp以内かつ評価値誤差増が+0.05石以内の
    範囲で最も積極的な(t値が最も小さい)t。"""
    baseline = results[baseline_t]["aggregate"]
    candidates = []
    for t in T_VALUES:
        agg = results[str(t)]["aggregate"]
        agreement_drop = baseline["agreementRate"] - agg["agreementRate"]
        error_increase = agg["meanEvalError"] - baseline["meanEvalError"]
        passes = agreement_drop <= 0.02 and error_increase <= 0.05
        candidates.append({
            "t": t, "agreementRate": agg["agreementRate"], "meanEvalError": agg["meanEvalError"],
            "agreementDrop": agreement_drop, "errorIncrease": error_increase, "passes": passes,
        })
    passing = [c for c in candidates if c["passes"]]
    selected = min(passing, key=lambda c: c["t"]) if passing else None
    return candidates, selected


def report(meta):
    lines = ["# T176 MPC積極化 事前登録スクリーニング(proxy)", "", "## 方法", "",
             "T156b Gate 1のproxy手法(held-out root NWS `[-1,0)`近似)を一般化。既存測定データ"
             "(`t172_v6_pilot_measurements.json`・`t172_v6_pilot_stats.json`)のみを使い、"
             "新規のengine探索は行っていない。候補4ペア(d,D)=(3,6),(4,8),(2,10),(4,12)×4空き帯、"
             "held-out(tuning+test)split。", "",
             "**注意**: 実際の探索木でのライブ計測ではない近似(単一ノードがたまたまNWS `[-1,0)` "
             "プローブ対象だったと仮定)。選定の一次スクリーニングとして使い、妥当性は要件1-3の"
             "確認対局(実際のeval_cli探索)で検証する。", "",
             "## t別集計(全16グループ合算)", "",
             "| t | n | cutRate | agreementRate | meanEvalError(石) | 一致率低下(pp) | 誤差増(石) | 事前登録規準 |",
             "|---:|---:|---:|---:|---:|---:|---:|:---:|"]
    candidates, selected = apply_criterion(meta["results"])
    for c in candidates:
        lines.append(
            f"| {c['t']} | {meta['results'][str(c['t'])]['aggregate']['n']} | "
            f"{meta['results'][str(c['t'])]['aggregate']['cutRate']:.4f} | "
            f"{c['agreementRate']:.4f} | {c['meanEvalError']:.4f} | "
            f"{c['agreementDrop'] * 100:.2f} | {c['errorIncrease']:.4f} | "
            f"{'合格' if c['passes'] else '不合格'} |"
        )
    lines += ["", "## 選定結果", ""]
    if selected is not None:
        lines.append(f"**選定: t={selected['t']}**(規準を満たす最も積極的なt)。確認対局(要件1-3)へ進む。")
    else:
        lines.append("**該当なし。t=1.5を維持(撤退)。** これも正当な結果。")
    lines += ["", "## t=1.5(現行)からの詳細(帯別・ペア別)", ""]
    lines += ["| t | 空き帯 | shallow | deep | margin | cutRate | agreementRate | meanEvalError |",
              "|---:|:---:|---:|---:|---:|---:|---:|---:|"]
    for t in T_VALUES:
        for row in meta["results"][str(t)]["rows"]:
            lines.append(
                f"| {t} | {row['emptyBucket']} | {row['shallowDepth']} | {row['deepDepth']} | "
                f"{row['margin']} | {row['cutRate']:.4f} | {row['agreementRate']:.4f} | "
                f"{row['meanEvalError']:.4f} |"
            )
    lines.append("")
    return "\n".join(lines), selected


def self_test():
    measurements = {
        "records": [
            {
                "id": f"p{i}", "empties": 27, "emptyBucket": "21-28", "split": "tuning",
                "gameId": f"g{i}",
                "results": [
                    {"depth": 3, "score": 10 * i, "nodes": 100},
                    {"depth": 6, "score": 20 * i, "nodes": 1000},
                    {"depth": 4, "score": 10 * i, "nodes": 100},
                    {"depth": 8, "score": 20 * i, "nodes": 1000},
                    {"depth": 2, "score": 10 * i, "nodes": 100},
                    {"depth": 10, "score": 20 * i, "nodes": 1000},
                    {"depth": 12, "score": 20 * i, "nodes": 1000},
                ],
            }
            for i in range(-5, 6)
        ],
    }
    stats = {
        "groups": [
            {"emptyBucket": b, "shallowDepth": s, "deepDepth": d, "slope": 2.0, "intercept": 0.0,
             "residualSigma": 1.0}
            for (s, d) in CANDIDATE_PAIRS for b in BUCKETS
        ],
    }
    results = screen(measurements, stats)
    assert "1.5" in results
    candidates, selected = apply_criterion(results)
    assert len(candidates) == len(T_VALUES)
    print("self-test passed")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--measurements", type=Path)
    p.add_argument("--stats", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--report", type=Path)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return
    measurements, stats = load(args.measurements), load(args.stats)
    results = screen(measurements, stats)
    meta = {
        "schemaVersion": 1,
        "candidatePairs": CANDIDATE_PAIRS,
        "buckets": BUCKETS,
        "tValues": T_VALUES,
        "heldOutSplits": list(HELD_OUT_SPLITS),
        "results": results,
        "inputs": {
            "measurements": {"path": args.measurements.as_posix(), "sha256": digest(args.measurements)},
            "stats": {"path": args.stats.as_posix(), "sha256": digest(args.stats)},
        },
    }
    candidates, selected = apply_criterion(results)
    meta["selectionCriterion"] = {
        "candidates": candidates,
        "selected": selected,
        "rule": "agreementDrop<=0.02 and errorIncrease<=0.05, most aggressive (smallest) t among passing",
    }
    atomic_json(args.out, meta)
    report_text, _ = report(meta)
    atomic_text(args.report, report_text)
    print(json.dumps({"selectedT": selected["t"] if selected else None}, sort_keys=True))


if __name__ == "__main__":
    main()

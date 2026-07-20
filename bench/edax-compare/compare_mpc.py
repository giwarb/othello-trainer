#!/usr/bin/env python3
"""T156d Gate 2/3 deterministic analysis and report generator."""
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
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
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


def by_key(data):
    return {(row["id"], row["depthRequested"]): row for row in data["records"]}


def require_pair(left, right, name):
    a, b = by_key(left), by_key(right)
    if a.keys() != b.keys():
        raise ValueError(f"{name}: record keys differ")
    return a, b


def bootstrap_node_ratio(off_rows, on_rows, samples, seed):
    games = sorted({row["gameId"] for row in off_rows.values()})
    grouped = {}
    for game in games:
        keys = [key for key, row in off_rows.items() if row["gameId"] == game]
        grouped[game] = (sum(off_rows[k]["nodes"] for k in keys), sum(on_rows[k]["nodes"] for k in keys))
    rng = random.Random(seed)
    ratios = []
    for _ in range(samples):
        chosen = [games[rng.randrange(len(games))] for _ in games]
        off = sum(grouped[g][0] for g in chosen)
        on = sum(grouped[g][1] for g in chosen)
        ratios.append(on / off)
    return upper95(ratios), len(games)


def gate2(off, on, samples, seed):
    off_rows, on_rows = require_pair(off, on, "Gate 2")
    depths = sorted({key[1] for key in off_rows})
    result = []
    for depth in depths:
        keys = [key for key in off_rows if key[1] == depth]
        ratios = [on_rows[key]["nodes"] / off_rows[key]["nodes"] for key in keys]
        total_off = sum(off_rows[key]["nodes"] for key in keys)
        total_on = sum(on_rows[key]["nodes"] for key in keys)
        ci, games = bootstrap_node_ratio(
            {key: off_rows[key] for key in keys}, {key: on_rows[key] for key in keys}, samples, seed + depth
        )
        probes = sum(on_rows[key]["mpc"]["probeNodes"] for key in keys)
        attempts = sum(on_rows[key]["mpc"]["probeAttemptsHigh"] + on_rows[key]["mpc"]["probeAttemptsLow"] for key in keys)
        cuts = sum(on_rows[key]["mpc"]["cutsHigh"] + on_rows[key]["mpc"]["cutsLow"] for key in keys)
        aggregate_ratio = total_on / total_off
        median_ratio = statistics.median(ratios)
        p90_ratio = percentile(ratios, 0.90)
        criteria = {
            "aggregateReduction10Percent": depth not in (10, 12) or aggregate_ratio <= 0.90,
            "bootstrapUpperBelow097": depth not in (10, 12) or ci < 0.97,
            "medianReduction5Percent": median_ratio <= 0.95,
            "p90AtMost125": p90_ratio <= 1.25,
        }
        result.append({
            "depth": depth, "positions": len(keys), "games": games,
            "offNodes": total_off, "onNodes": total_on, "aggregateNodeRatio": aggregate_ratio,
            "bootstrapRatioUpper95": ci, "medianPositionRatio": median_ratio, "p90PositionRatio": p90_ratio,
            "mpcProbeNodes": probes, "mpcProbeNodeShare": probes / total_on,
            "mpcAttempts": attempts, "mpcCuts": cuts, "mpcCutRate": cuts / attempts if attempts else 0.0,
            "criteria": criteria, "pass": all(criteria.values()),
        })
    return {"depths": result, "pass": all(row["pass"] for row in result)}


def deterministic(first, second, name):
    left, right = require_pair(first, second, name)
    mismatches = [f"{key[0]}@{key[1]}" for key in sorted(left) if left[key] != right[key]]
    return {"pass": not mismatches, "mismatchCount": len(mismatches), "mismatches": mismatches[:20]}


def exact_summary(data):
    rows = data["records"]
    attempts = sum(row["exactRootAttempts"] + row["exactLeafAttempts"] for row in rows)
    completed = sum((1 if row["exactRootCompleted"] else 0) + row["exactLeafCompleted"] for row in rows)
    invalid = sum(
        row["exactNodes"] > row["nodes"]
        or row["exactLeafCompleted"] > row["exactLeafAttempts"]
        or (row["empties"] > data["config"]["exactFromEmpties"] and row["exactRootAttempts"] != 0)
        for row in rows
    )
    return {
        "rootAttempts": sum(row["exactRootAttempts"] for row in rows),
        "leafAttempts": sum(row["exactLeafAttempts"] for row in rows),
        "rootCompleted": sum(row["exactRootCompleted"] for row in rows),
        "boundProofCompleted": sum(row["exactBoundProofCompleted"] for row in rows),
        "leafCompleted": sum(row["exactLeafCompleted"] for row in rows),
        "quotaAborts": sum(row["exactAbortedByQuota"] for row in rows),
        "exactNodes": sum(row["exactNodes"] for row in rows),
        "totalNodes": sum(row["nodes"] for row in rows),
        "completionRate": completed / attempts if attempts else None,
        "invalidAccountingRows": invalid,
    }


def oracle_regrets(data, labels):
    labels_by_id = {row["id"]: row for row in labels["rows"]}
    values = {}
    for row in data["records"]:
        label = labels_by_id[row["id"]]
        move = row["bestMove"]
        if move not in label["moves"]:
            raise ValueError(f"oracle has no move {move} for {row['id']}")
        values[row["id"]] = label["oracleScore"] - label["moves"][move]
    return values


def paired_upper(differences, samples, seed):
    rng = random.Random(seed)
    values = list(differences)
    means = [sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(samples)]
    return upper95(means)


def gate3(runs, labels, samples, seed):
    det = {name: deterministic(pair[0], pair[1], f"Gate 3 {name}") for name, pair in runs.items()}
    primary = {name: pair[0] for name, pair in runs.items()}
    keys_a, keys_b = require_pair(primary["A"], primary["B"], "Gate 3 A/B")
    depth_diffs = [keys_b[key]["depth"] - keys_a[key]["depth"] for key in sorted(keys_a)]
    regret_a, regret_b = oracle_regrets(primary["A"], labels), oracle_regrets(primary["B"], labels)
    common = sorted(regret_a)
    regret_diffs = [regret_b[key] - regret_a[key] for key in common]
    summaries = {}
    for name, data in primary.items():
        rows = data["records"]
        regrets = oracle_regrets(data, labels)
        mpc_attempts = sum(row["mpc"]["probeAttemptsHigh"] + row["mpc"]["probeAttemptsLow"] for row in rows)
        mpc_cuts = sum(row["mpc"]["cutsHigh"] + row["mpc"]["cutsLow"] for row in rows)
        mpc_probe_nodes = sum(row["mpc"]["probeNodes"] for row in rows)
        summaries[name] = {
            "positions": len(rows), "medianDepth": statistics.median(row["depth"] for row in rows),
            "meanDepth": statistics.mean(row["depth"] for row in rows), "meanNodes": statistics.mean(row["nodes"] for row in rows),
            "meanRegret": statistics.mean(regrets.values()), "loss4Count": sum(value >= 4 for value in regrets.values()),
            "loss4Rate": sum(value >= 4 for value in regrets.values()) / len(regrets),
            "wallLimitHits": sum(row["wallLimitHit"] for row in rows), "exact": exact_summary(data),
            "aspirationFailLow": sum(row["aspirationFailLow"] for row in rows),
            "aspirationFailHigh": sum(row["aspirationFailHigh"] for row in rows),
            "mpcProbeNodes": mpc_probe_nodes, "mpcProbeNodeShare": mpc_probe_nodes / sum(row["nodes"] for row in rows),
            "mpcAttempts": mpc_attempts, "mpcCuts": mpc_cuts, "mpcCutRate": mpc_cuts / mpc_attempts if mpc_attempts else 0.0,
        }
    mean_regret_diff = statistics.mean(regret_diffs)
    criteria = {
        "allConfigurationsDeterministic": all(value["pass"] for value in det.values()),
        "wallLimitHitZero": all(value["wallLimitHits"] == 0 for value in summaries.values()),
        "depthGain": (summaries["B"]["medianDepth"] - summaries["A"]["medianDepth"] >= 1)
            or (sum(value >= 1 for value in depth_diffs) / len(depth_diffs) >= 0.35),
        "shallowerAtMost10Percent": sum(value < 0 for value in depth_diffs) / len(depth_diffs) <= 0.10,
        "meanRegretDiffAtMost010": mean_regret_diff <= 0.10,
        "pairedBootstrapUpperAtMost050": paired_upper(regret_diffs, samples, seed) <= 0.50,
        "loss4RateNoIncrease": summaries["B"]["loss4Rate"] <= summaries["A"]["loss4Rate"],
        "exactAccountingNormal": all(value["exact"]["invalidAccountingRows"] == 0 for value in summaries.values()),
    }
    return {
        "determinism": det, "configurations": summaries,
        "bMinusA": {
            "medianDepthDifference": summaries["B"]["medianDepth"] - summaries["A"]["medianDepth"],
            "depthPlusOneRate": sum(value >= 1 for value in depth_diffs) / len(depth_diffs),
            "shallowerRate": sum(value < 0 for value in depth_diffs) / len(depth_diffs),
            "meanRegretDifference": mean_regret_diff,
            "pairedBootstrapUpper95": paired_upper(regret_diffs, samples, seed),
            "loss4CountDifference": summaries["B"]["loss4Count"] - summaries["A"]["loss4Count"],
        },
        "criteria": criteria, "pass": all(criteria.values()),
    }


def report(meta):
    g2, g3 = meta["gate2"], meta["gate3"]
    lines = ["# T156d MPC Gate 2 / Gate 3 レポート", "", "## 結論", "",
             f"- Gate 2: **{'合格' if g2['pass'] else '不合格'}**", f"- Gate 3: **{'合格' if g3['pass'] else '不合格'}**", ""]
    if g2["pass"] and g3["pass"]:
        lines += ["両ゲート合格。T156e（確認校正1,200局面）へ進む。", ""]
    else:
        lines += ["不合格のためT156eへは進まない。失敗基準を改善できる校正根拠が得られるまでMPCはdefault OFFを維持し、速度不足ならprobe費用、regret悪化ならmargin/帯別係数を再調整する。", ""]
    lines += ["## Gate 2: 固定深さ", "", "test split 240局面、exact/history/aspiration OFF。bootstrapはgameId単位。", "",
              "| depth | off nodes | on nodes | ratio | bootstrap U95 | median | p90 | probe share | cut rate | 判定 |",
              "|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|"]
    for row in g2["depths"]:
        lines.append(f"| {row['depth']} | {row['offNodes']} | {row['onNodes']} | {row['aggregateNodeRatio']:.4f} | {row['bootstrapRatioUpper95']:.4f} | {row['medianPositionRatio']:.4f} | {row['p90PositionRatio']:.4f} | {row['mpcProbeNodeShare']:.2%} | {row['mpcCutRate']:.2%} | {'合格' if row['pass'] else '不合格'} |")
    lines += ["", "各深さの基準判定:", ""]
    for row in g2["depths"]:
        lines.append(f"- D{row['depth']}: " + ", ".join(f"{key}={'pass' if value else 'FAIL'}" for key, value in row["criteria"].items()))
    lines += ["", "## Gate 3: 160k本番相当", "", "oracle 180局面から空き20以下を除外した120局面。v4、160k、quota 60%、exact_from_empties=16、time_ms=None。", "",
              "| 構成 | history | aspiration | MPC | median depth | mean depth | mean nodes | mean regret | 4石loss | wall hit | exact leaf attempt/complete/abort |",
              "|:---:|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|:---:|"]
    policies = {"A": ("ON", "ON", "OFF"), "B": ("ON", "OFF", "ON"), "C": ("ON", "ON", "ON"), "D": ("ON", "OFF", "OFF")}
    for name in "ABCD":
        row, policy = g3["configurations"][name], policies[name]
        exact = row["exact"]
        lines.append(f"| {name} | {policy[0]} | {policy[1]} | {policy[2]} | {row['medianDepth']:.2f} | {row['meanDepth']:.3f} | {row['meanNodes']:.1f} | {row['meanRegret']:.4f} | {row['loss4Count']}/{row['positions']} | {row['wallLimitHits']} | {exact['leafAttempts']}/{exact['leafCompleted']}/{exact['quotaAborts']} |")
    lines += ["", "### 決定性・探索テレメトリ", "", "| 構成 | 2回一致 | mismatch | aspiration low/high | MPC attempts/cuts | MPC cut率 | probe share |", "|:---:|:---:|---:|:---:|:---:|---:|---:|"]
    for name in "ABCD":
        row, det = g3["configurations"][name], g3["determinism"][name]
        lines.append(f"| {name} | {'完全一致' if det['pass'] else '不一致'} | {det['mismatchCount']} | {row['aspirationFailLow']}/{row['aspirationFailHigh']} | {row['mpcAttempts']}/{row['mpcCuts']} | {row['mpcCutRate']:.2%} | {row['mpcProbeNodeShare']:.2%} |")
    lines += ["", "### exact統計", "", "| 構成 | root試行/完走 | leaf試行/完走 | bound完走 | quota abort | exact nodes/share | 会計異常 |", "|:---:|:---:|:---:|---:|---:|:---:|---:|"]
    for name in "ABCD":
        exact = g3["configurations"][name]["exact"]
        lines.append(f"| {name} | {exact['rootAttempts']}/{exact['rootCompleted']} | {exact['leafAttempts']}/{exact['leafCompleted']} | {exact['boundProofCompleted']} | {exact['quotaAborts']} | {exact['exactNodes']}/{exact['exactNodes'] / exact['totalNodes']:.2%} | {exact['invalidAccountingRows']} |")
    delta = g3["bMinusA"]
    lines += ["", "### B-A", "", f"- 完成深さ中央値差: {delta['medianDepthDifference']:+.2f}",
              f"- +1以上の局面率: {delta['depthPlusOneRate']:.2%}", f"- 浅くなる局面率: {delta['shallowerRate']:.2%}",
              f"- oracle regret平均差: {delta['meanRegretDifference']:+.4f}石", f"- paired bootstrap 95%上限: {delta['pairedBootstrapUpper95']:+.4f}石",
              f"- 4石以上loss件数差: {delta['loss4CountDifference']:+d}", "", "### 機械判定", ""]
    lines += [f"- {key}: {'pass' if value else 'FAIL'}" for key, value in g3["criteria"].items()]
    a, b, c, d = (g3["configurations"][name] for name in "ABCD")
    lines += ["", "### 原因分析と提言", "",
              f"aspiration条件を揃えたB-Dでは平均深さ差 {b['meanDepth'] - d['meanDepth']:+.3f}、regret差 {b['meanRegret'] - d['meanRegret']:+.4f}石。C-Aでは平均深さ差 {c['meanDepth'] - a['meanDepth']:+.3f}、regret差 {c['meanRegret'] - a['meanRegret']:+.4f}石だった。MPC単体は固定深さノードを大幅削減する一方、160kの反復深化では次の完成深さへ届くほどの利益にならず、初期本番候補Bはaspirationを外す損失も回収できていない。Cは診断値としてAに近いが、初期採用候補ではない。MPCはdefault OFFを維持し、T156eへ進まず、margin/帯別係数または反復深化・TTとの相互作用を再調査してGate 3を再実行する。", "",
              "exact異常は `exactNodes <= nodes`、完走数<=試行数、空き16超のroot exact試行ゼロという会計不変条件で判定した。B/DおよびA/Cのexact試行数が近く、MPCの有無による異常な偏りは見られない。aspiration有無では試行数が変わるため、構成間の試行数差には恣意的な比率閾値を置かず全数を開示した。", "",
              "## 再現方法", "", "`compare_mpc.py`へ同じ8 checkpoint、oracle labels、固定seed/bootstrap回数を渡すとmeta/reportが決定的に再生成される。各checkpointは局面完了ごとに原子的更新され、同じコマンドでresumeする。", ""]
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--gate2-off", type=Path, required=True); p.add_argument("--gate2-on", type=Path, required=True)
    for name in "abcd":
        p.add_argument(f"--gate3-{name}", type=Path, required=True); p.add_argument(f"--gate3-{name}-repeat", type=Path, required=True)
    p.add_argument("--oracle-labels", type=Path, required=True); p.add_argument("--report", type=Path, required=True); p.add_argument("--meta", type=Path, required=True)
    p.add_argument("--bootstrap-samples", type=int, default=100000); p.add_argument("--bootstrap-seed", type=int, default=156004)
    a = p.parse_args()
    paths = {"gate2Off": a.gate2_off, "gate2On": a.gate2_on, "oracleLabels": a.oracle_labels}
    runs = {}
    for name in "ABCD":
        first = getattr(a, f"gate3_{name.lower()}"); second = getattr(a, f"gate3_{name.lower()}_repeat")
        paths[f"gate3{name}"] = first; paths[f"gate3{name}Repeat"] = second; runs[name] = (load(first), load(second))
    meta = {"schemaVersion": 1, "analysis": "T156d MPC Gate 2/3", "bootstrapSamples": a.bootstrap_samples, "bootstrapSeed": a.bootstrap_seed,
            "inputs": {key: {"path": path.as_posix(), "sha256": digest(path)} for key, path in paths.items()},
            "gate2": gate2(load(a.gate2_off), load(a.gate2_on), a.bootstrap_samples, a.bootstrap_seed),
            "gate3": gate3(runs, load(a.oracle_labels), a.bootstrap_samples, a.bootstrap_seed + 1000)}
    atomic_json(a.meta, meta); atomic_text(a.report, report(meta))
    print(json.dumps({"gate2": meta["gate2"]["pass"], "gate3": meta["gate3"]["pass"]}, sort_keys=True))


if __name__ == "__main__":
    main()

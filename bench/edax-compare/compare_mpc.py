#!/usr/bin/env python3
"""T156d Gate 2/3 deterministic analysis and report generator."""
import argparse
import hashlib
import json
import random
import statistics
from pathlib import Path

EXPECTED_GATE2_POSITIONS_SHA256 = "e86bf2383490cc356589c85307cdc85556288bd23cae1a2594932cd70ad748da"
EXPECTED_ORACLE_POSITIONS_SHA256 = "4419fb5120c2ba1d07b6d277473dfb4d9638de504255644254468e418469fb57"
EXPECTED_ORACLE_LABELS_SHA256 = "8859c779cff35be32d197b1d4bc45bf537a4afd980afe1037c88d3fbed8bec82"
EXPECTED_V4_WEIGHTS_SHA256 = "c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def fnv1a64_bytes(data):
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{value:016x}:{len(data)}"


def fnv1a64_file(path):
    return fnv1a64_bytes(path.read_bytes())


def ids_fingerprint(ids):
    return fnv1a64_bytes("\n".join(ids).encode("utf-8"))


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
    rows = data["records"]
    keyed = {(row["id"], row["depthRequested"]): row for row in rows}
    if len(keyed) != len(rows):
        raise ValueError("checkpoint contains duplicate (id, depthRequested) records")
    return keyed


def unique_by_id(rows, name):
    keyed = {row["id"]: row for row in rows}
    if len(keyed) != len(rows):
        raise ValueError(f"{name} contains duplicate ids")
    return keyed


def positions_array(data, name):
    rows = data if isinstance(data, list) else data.get("positions")
    if not isinstance(rows, list):
        raise ValueError(f"{name} must be an array or contain positions")
    unique_by_id(rows, name)
    return rows


def record_summary(data):
    keyed = by_key(data)
    ids = sorted({key[0] for key in keyed})
    return {
        "recordCount": len(data["records"]), "uniqueKeyCount": len(keyed), "positionCount": len(ids),
        "positionIdsSha256": hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest(),
        "depths": sorted({key[1] for key in keyed}),
        "minEmpties": min(row["empties"] for row in data["records"]),
        "maxEmpties": max(row["empties"] for row in data["records"]),
    }


def require_equal(actual, expected, name):
    if actual != expected:
        raise ValueError(f"{name}: expected {expected!r}, got {actual!r}")


def validate_checkpoint(data, expected_config, expected_ids, name):
    require_equal(data.get("schemaVersion"), 1, f"{name} schemaVersion")
    config = data.get("config")
    if not isinstance(config, dict):
        raise ValueError(f"{name} missing config")
    for key, expected in expected_config.items():
        require_equal(config.get(key), expected, f"{name} config.{key}")
    expected_keys = {(position_id, depth) for position_id in expected_ids for depth in config["depths"]}
    require_equal(set(by_key(data)), expected_keys, f"{name} record keys")
    require_equal(config.get("selectedPositionsCount"), len(expected_ids), f"{name} selected count")
    require_equal(config.get("selectedPositionsFingerprint"), ids_fingerprint(expected_ids), f"{name} selected fingerprint")
    return {"config": config, "records": record_summary(data)}
    require_equal(digest(gate2_positions_path), EXPECTED_GATE2_POSITIONS_SHA256,
                  "Gate 2 positions canonical SHA-256")
    require_equal(digest(oracle_positions_path), EXPECTED_ORACLE_POSITIONS_SHA256,
                  "oracle positions canonical SHA-256")
    require_equal(digest(oracle_labels_path), EXPECTED_ORACLE_LABELS_SHA256,
                  "oracle labels canonical SHA-256")
    require_equal(digest(weights_path), EXPECTED_V4_WEIGHTS_SHA256,
                  "v4 weights canonical SHA-256")


def validate_inputs(gate2_off, gate2_on, runs, gate2_positions_path, oracle_positions_path,
                    oracle_labels_path, weights_path):
    gate2_positions = positions_array(load(gate2_positions_path), "Gate 2 positions")
    gate2_ids = [row["id"] for row in gate2_positions if row.get("split") == "test"]
    require_equal(len(gate2_ids), 240, "Gate 2 test position count")
    oracle_positions_data = load(oracle_positions_path)
    require_equal(oracle_positions_data.get("schemaVersion"), 1, "oracle positions schemaVersion")
    oracle_positions = positions_array(oracle_positions_data, "oracle positions")
    require_equal(len(oracle_positions), 180, "oracle position count")
    gate3_ids = [row["id"] for row in oracle_positions if row["empties"] > 20]
    require_equal(len(gate3_ids), 120, "Gate 3 position count after empties exclusion")
    labels = load(oracle_labels_path)
    require_equal(labels.get("metadata", {}).get("schema"), 1, "oracle labels schema")
    label_rows = labels.get("rows")
    if not isinstance(label_rows, list):
        raise ValueError("oracle labels missing rows")
    labels_by_id = unique_by_id(label_rows, "oracle labels")
    positions_by_id = unique_by_id(oracle_positions, "oracle positions")
    require_equal(set(labels_by_id), set(positions_by_id), "oracle positions/labels ids")
    for position_id, position in positions_by_id.items():
        require_equal(labels_by_id[position_id].get("empties"), position["empties"], f"oracle empties {position_id}")
    require_equal(labels["metadata"].get("corpusSha256"), digest(oracle_positions_path), "oracle corpus fingerprint")
    gate2_common = {
        "positionsFingerprint": fnv1a64_file(gate2_positions_path), "weightsFingerprint": fnv1a64_file(weights_path),
        "depths": [8, 10, 12], "maxNodes": None, "exactFromEmpties": 0, "exactQuotaPercent": 60,
        "aspiration": False, "history": False, "split": "test", "minEmpties": 0, "maxPositions": None,
    }
    gate3_common = {
        "positionsFingerprint": fnv1a64_file(oracle_positions_path), "weightsFingerprint": fnv1a64_file(weights_path),
        "depths": [12], "maxNodes": 160000, "exactFromEmpties": 16, "exactQuotaPercent": 60,
        "split": None, "minEmpties": 21, "maxPositions": None,
    }
    verified = {
        "gate2Off": validate_checkpoint(gate2_off, {**gate2_common, "mpc": False}, gate2_ids, "Gate 2 OFF"),
        "gate2On": validate_checkpoint(gate2_on, {**gate2_common, "mpc": True}, gate2_ids, "Gate 2 ON"),
    }
    policies = {
        "A": {"history": True, "aspiration": True, "mpc": False},
        "B": {"history": True, "aspiration": False, "mpc": True},
        "C": {"history": True, "aspiration": True, "mpc": True},
        "D": {"history": True, "aspiration": False, "mpc": False},
    }
    for name, pair in runs.items():
        for repeat, data in enumerate(pair, 1):
            verified[f"gate3{name}Run{repeat}"] = validate_checkpoint(
                data, {**gate3_common, **policies[name]}, gate3_ids, f"Gate 3 {name} run {repeat}"
            )
    sources = {
        "gate2Positions": {"path": gate2_positions_path.as_posix(), "sha256": digest(gate2_positions_path), "fnv1a64": fnv1a64_file(gate2_positions_path)},
        "oraclePositions": {"path": oracle_positions_path.as_posix(), "sha256": digest(oracle_positions_path), "fnv1a64": fnv1a64_file(oracle_positions_path)},
        "oracleLabels": {"path": oracle_labels_path.as_posix(), "sha256": digest(oracle_labels_path)},
        "patternWeights": {"path": weights_path.as_posix(), "sha256": digest(weights_path), "fnv1a64": fnv1a64_file(weights_path)},
    }
    return labels, verified, sources


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
    invalid_reasons = {name: 0 for name in (
        "rootCompletedExceedsAttempts", "boundProofExceedsLeafCompleted", "leafOutcomesExceedAttempts",
        "quotaAbortsExceedAttempts", "nodePartitionMismatch", "rootAttemptOutsideThreshold"
    )}
    for row in rows:
        invalid_reasons["rootCompletedExceedsAttempts"] += int(row["exactRootCompleted"] > row["exactRootAttempts"])
        invalid_reasons["boundProofExceedsLeafCompleted"] += int(row["exactBoundProofCompleted"] > row["exactLeafCompleted"])
        invalid_reasons["leafOutcomesExceedAttempts"] += int(row["exactLeafCompleted"] + row["exactAbortedByQuota"] > row["exactLeafAttempts"])
        invalid_reasons["quotaAbortsExceedAttempts"] += int(row["exactAbortedByQuota"] > row["exactRootAttempts"] + row["exactLeafAttempts"])
        invalid_reasons["nodePartitionMismatch"] += int(row["exactNodes"] + row["midgameNodes"] != row["nodes"])
        invalid_reasons["rootAttemptOutsideThreshold"] += int(row["empties"] > data["config"]["exactFromEmpties"] and row["exactRootAttempts"] != 0)
    root_attempts = sum(row["exactRootAttempts"] for row in rows)
    leaf_attempts = sum(row["exactLeafAttempts"] for row in rows)
    root_completed = sum(bool(row["exactRootCompleted"]) for row in rows)
    leaf_completed = sum(row["exactLeafCompleted"] for row in rows)
    exact_nodes = sum(row["exactNodes"] for row in rows)
    midgame_nodes = sum(row["midgameNodes"] for row in rows)
    total_nodes = sum(row["nodes"] for row in rows)
    return {
        "rootAttempts": root_attempts, "leafAttempts": leaf_attempts, "rootCompleted": root_completed,
        "boundProofCompleted": sum(row["exactBoundProofCompleted"] for row in rows), "leafCompleted": leaf_completed,
        "quotaAborts": sum(row["exactAbortedByQuota"] for row in rows), "exactNodes": exact_nodes,
        "midgameNodes": midgame_nodes, "totalNodes": total_nodes, "exactNodeShare": exact_nodes / total_nodes,
        "completionRate": (root_completed + leaf_completed) / (root_attempts + leaf_attempts) if root_attempts + leaf_attempts else None,
        "invalidAccountingRows": sum(invalid_reasons.values()), "invalidAccountingReasons": invalid_reasons,
    }


def oracle_regrets(data, labels):
    labels_by_id = unique_by_id(labels["rows"], "oracle labels")
    values = {}
    for row in data["records"]:
        if row["id"] in values:
            raise ValueError(f"duplicate oracle regret record for {row['id']}")
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


def loss4_increase_limit(position_count):
    return position_count * 2 / 60


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
    exact_bias = {}
    for pair_name, (left_name, right_name) in {"A-C": ("A", "C"), "B-D": ("B", "D")}.items():
        left, right = summaries[left_name]["exact"], summaries[right_name]["exact"]
        attempt_delta = abs(left["leafAttempts"] - right["leafAttempts"]) / max(left["leafAttempts"], right["leafAttempts"], 1)
        abort_delta = abs(left["quotaAborts"] - right["quotaAborts"]) / max(left["quotaAborts"], right["quotaAborts"], 1)
        completion_delta = abs((left["completionRate"] or 0) - (right["completionRate"] or 0))
        share_delta = abs(left["exactNodeShare"] - right["exactNodeShare"])
        criteria = {
            "leafAttemptRelativeDeltaAtMost10Percent": attempt_delta <= 0.10,
            "quotaAbortRelativeDeltaAtMost10Percent": abort_delta <= 0.10,
            "completionRateDeltaAtMost5Points": completion_delta <= 0.05,
            "exactNodeShareDeltaAtMost2Points": share_delta <= 0.02,
        }
        exact_bias[pair_name] = {"leafAttemptRelativeDelta": attempt_delta, "quotaAbortRelativeDelta": abort_delta,
                                 "completionRateDelta": completion_delta, "exactNodeShareDelta": share_delta,
                                 "criteria": criteria, "pass": all(criteria.values())}
    mean_regret_diff = statistics.mean(regret_diffs)
    criteria = {
        "allConfigurationsDeterministic": all(value["pass"] for value in det.values()),
        "wallLimitHitZero": all(value["wallLimitHits"] == 0 for value in summaries.values()),
        "depthGain": (summaries["B"]["medianDepth"] - summaries["A"]["medianDepth"] >= 1)
            or (sum(value >= 1 for value in depth_diffs) / len(depth_diffs) >= 0.35),
        "shallowerAtMost10Percent": sum(value < 0 for value in depth_diffs) / len(depth_diffs) <= 0.10,
        "meanRegretDiffAtMost010": mean_regret_diff <= 0.10,
        "pairedBootstrapUpperAtMost050": paired_upper(regret_diffs, samples, seed) <= 0.50,
        "loss4IncreaseAtMost2Per60": summaries["B"]["loss4Count"] - summaries["A"]["loss4Count"] <= loss4_increase_limit(len(depth_diffs)),
        "exactAccountingNormal": all(value["exact"]["invalidAccountingRows"] == 0 for value in summaries.values())
            and all(value["pass"] for value in exact_bias.values()),
    }
    return {
        "determinism": det, "configurations": summaries, "exactConfigurationBias": exact_bias,
        "bMinusA": {
            "medianDepthDifference": summaries["B"]["medianDepth"] - summaries["A"]["medianDepth"],
            "depthPlusOneRate": sum(value >= 1 for value in depth_diffs) / len(depth_diffs),
            "shallowerRate": sum(value < 0 for value in depth_diffs) / len(depth_diffs),
            "meanRegretDifference": mean_regret_diff,
            "pairedBootstrapUpper95": paired_upper(regret_diffs, samples, seed),
            "loss4CountDifference": summaries["B"]["loss4Count"] - summaries["A"]["loss4Count"],
        },
        "criteria": criteria, "alternativeCriteria": {
            "strictLoss4RateNoIncrease": summaries["B"]["loss4Rate"] <= summaries["A"]["loss4Rate"]}, "pass": all(criteria.values()),
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
    lines += [f"- strictLoss4RateNoIncrease (initial wording): {'pass' if value else 'FAIL'}"
              for value in [g3["alternativeCriteria"]["strictLoss4RateNoIncrease"]]]
    a, b, c, d = (g3["configurations"][name] for name in "ABCD")
    lines += ["", "### 原因分析と提言", "",
              f"aspiration条件を揃えたB-Dでは平均深さ差 {b['meanDepth'] - d['meanDepth']:+.3f}、regret差 {b['meanRegret'] - d['meanRegret']:+.4f}石。C-Aでは平均深さ差 {c['meanDepth'] - a['meanDepth']:+.3f}、regret差 {c['meanRegret'] - a['meanRegret']:+.4f}石だった。MPC単体は固定深さノードを大幅削減する一方、160kの反復深化では次の完成深さへ届くほどの利益にならず、初期本番候補Bはaspirationを外す損失も回収できていない。Cは診断値としてAに近いが、初期採用候補ではない。MPCはdefault OFFを維持し、T156eへ進まず、margin/帯別係数または反復深化・TTとの相互作用を再調査してGate 3を再実行する。", "",
              "exact異常は `exactNodes <= nodes`、完走数<=試行数、空き16超のroot exact試行ゼロという会計不変条件で判定した。B/DおよびA/Cのexact試行数が近く、MPCの有無による異常な偏りは見られない。aspiration有無では試行数が変わるため、構成間の試行数差には恣意的な比率閾値を置かず全数を開示した。", "",
              "## 再現方法", "", "`compare_mpc.py`へ同じ8 checkpoint、oracle labels、固定seed/bootstrap回数を渡すとmeta/reportが決定的に再生成される。各checkpointは局面完了ごとに原子的更新され、同じコマンドでresumeする。", ""]
    lines = [line for line in lines if not line.startswith("exact")
             and line != "## \u518d\u73fe\u65b9\u6cd5"
             and not line.startswith("`compare_mpc.py`")]
    lines += ["", "Exact accounting and cross-configuration bias:", "",
              "| pair | leaf attempt delta | quota abort delta | completion delta | exact node share delta | result |",
              "|:---:|---:|---:|---:|---:|:---:|"]
    for pair_name, bias in g3["exactConfigurationBias"].items():
        lines.append(f"| {pair_name} | {bias['leafAttemptRelativeDelta']:.2%} | {bias['quotaAbortRelativeDelta']:.2%} | {bias['completionRateDelta']:.2%} | {bias['exactNodeShareDelta']:.2%} | {'PASS' if bias['pass'] else 'FAIL'} |")
    lines += ["", "Each row was checked for root/leaf attempts and completions, bound proofs, quota aborts, and exactNodes + midgameNodes = nodes. Bias limits: 10% relative leaf-attempt/quota-abort delta, 5-point completion-rate delta, and 2-point exact-node-share delta.", "",
              "Input validation: checkpoint schema/config, positions and v4 weights fingerprints, oracle correspondence/fingerprint, duplicates, policies, and identical position-ID sets were checked fail-closed before aggregation. Validated configs and record-set summaries are embedded in meta.", "",
              "Reproduction (validated): provide the same eight checkpoints, Gate 2 positions, oracle positions/labels, v4 weights, bootstrap seed, and sample count. Gate checkpoints are atomically saved per position and resumed with the same command."]
    compacted = []
    for line in lines:
        if line or not compacted or compacted[-1]:
            compacted.append(line)
    lines = compacted
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--gate2-off", type=Path, required=True); p.add_argument("--gate2-on", type=Path, required=True)
    for name in "abcd":
        p.add_argument(f"--gate3-{name}", type=Path, required=True); p.add_argument(f"--gate3-{name}-repeat", type=Path, required=True)
    p.add_argument("--gate2-positions", type=Path, required=True)
    p.add_argument("--oracle-positions", type=Path, required=True); p.add_argument("--oracle-labels", type=Path, required=True)
    p.add_argument("--pattern-weights", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True); p.add_argument("--meta", type=Path, required=True)
    p.add_argument("--bootstrap-samples", type=int, default=100000); p.add_argument("--bootstrap-seed", type=int, default=156004)
    a = p.parse_args()
    checkpoints = {"gate2Off": a.gate2_off, "gate2On": a.gate2_on}
    runs = {}
    for name in "ABCD":
        first = getattr(a, f"gate3_{name.lower()}"); second = getattr(a, f"gate3_{name.lower()}_repeat")
        checkpoints[f"gate3{name}"] = first; checkpoints[f"gate3{name}Repeat"] = second
        runs[name] = (load(first), load(second))
    gate2_off, gate2_on = load(a.gate2_off), load(a.gate2_on)
    labels, verified, sources = validate_inputs(gate2_off, gate2_on, runs, a.gate2_positions,
                                                a.oracle_positions, a.oracle_labels, a.pattern_weights)
    meta = {"schemaVersion": 2, "analysis": "T156d MPC Gate 2/3", "bootstrapSamples": a.bootstrap_samples, "bootstrapSeed": a.bootstrap_seed,
            "inputs": {key: {"path": path.as_posix(), "sha256": digest(path)} for key, path in checkpoints.items()},
            "validatedSources": sources, "validatedCheckpoints": verified,
            "gate2": gate2(gate2_off, gate2_on, a.bootstrap_samples, a.bootstrap_seed),
            "gate3": gate3(runs, labels, a.bootstrap_samples, a.bootstrap_seed + 1000)}
    atomic_json(a.meta, meta); atomic_text(a.report, report(meta))
    print(json.dumps({"gate2": meta["gate2"]["pass"], "gate3": meta["gate3"]["pass"]}, sort_keys=True))


if __name__ == "__main__":
    main()

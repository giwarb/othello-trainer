#!/usr/bin/env python3
"""T172要件1: v4校正時(T156b pilot statsで選定された(d,D)候補)とv6再校正時の
残差sigma比較表を作る。

- 入力はT156aで既に生成済みの `t156_mpc_pilot_stats.json`(v4、320局面pilot、
  深さ1-12全域)と、本タスクで新規生成した `t172_v6_pilot_stats.json`(v6、
  同じ320局面pilot、深さ[2,3,4,6,8,10,12])。どちらも同じ
  `bench/edax-compare/t156_mpc_stats.py`(T156a作成のaffine回帰スクリプト、
  無変更)が生成したもので、群のキー(emptyBucket, shallowDepth, deepDepth)・
  フィールド名は共通。
- 比較対象は、T156bのGate 1で選定された候補(d,D)=(3,6),(4,8),(2,10),(4,12)
  (4空き帯×4ペア=16行)のみ。これ以外のペアはv6側で測定していない
  (T172は候補選定をやり直すのではなく、既存候補でのσ改善有無だけを
  検証するため測定範囲を絞った。作業ログ参照)。
- 「σが縮んだ」の定義: 同じ(bucket, shallow, deep)についてv6の
  calibration split residualSigmaがv4より小さい(ratio = v6/v4 < 1)。
"""
import argparse
import hashlib
import json
from pathlib import Path

CANDIDATE_PAIRS = [(3, 6), (4, 8), (2, 10), (4, 12)]
BUCKETS = ["21-28", "29-36", "37-44", "45-52"]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def group_by_key(stats):
    return {
        (g["emptyBucket"], g["shallowDepth"], g["deepDepth"]): g
        for g in stats["groups"]
    }


def atomic_json(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    temp.replace(path)


def atomic_text(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(value, encoding="utf-8", newline="\n")
    temp.replace(path)


def compare(v4_stats, v6_stats, v4_positions_fp, v6_positions_fp):
    if v4_positions_fp != v6_positions_fp:
        raise ValueError(
            f"positions fingerprint mismatch: v4={v4_positions_fp} v6={v6_positions_fp} "
            "(comparison requires the identical 320-position pilot corpus)"
        )
    v4_by_key = group_by_key(v4_stats)
    v6_by_key = group_by_key(v6_stats)
    rows = []
    for shallow, deep in CANDIDATE_PAIRS:
        for bucket in BUCKETS:
            key = (bucket, shallow, deep)
            if key not in v4_by_key:
                raise ValueError(f"v4 stats missing group {key}")
            if key not in v6_by_key:
                raise ValueError(f"v6 stats missing group {key}")
            v4_group, v6_group = v4_by_key[key], v6_by_key[key]
            v4_sigma, v6_sigma = v4_group["residualSigma"], v6_group["residualSigma"]
            ratio = v6_sigma / v4_sigma
            v4_node_ratio = v4_group["summaries"]["all"]["shallowDeepNodeRatioMedian"]
            v6_node_ratio = v6_group["summaries"]["all"]["shallowDeepNodeRatioMedian"]
            rows.append({
                "emptyBucket": bucket, "shallowDepth": shallow, "deepDepth": deep,
                "v4ResidualSigma": v4_sigma, "v6ResidualSigma": v6_sigma,
                "sigmaRatioV6OverV4": ratio, "sigmaShrunk": ratio < 1.0,
                "v4Slope": v4_group["slope"], "v6Slope": v6_group["slope"],
                "v4Intercept": v4_group["intercept"], "v6Intercept": v6_group["intercept"],
                "v4NodeRatioMedianAll": v4_node_ratio, "v6NodeRatioMedianAll": v6_node_ratio,
                "v4FitN": v4_group["fitN"], "v6FitN": v6_group["fitN"],
            })
    shrunk_count = sum(row["sigmaShrunk"] for row in rows)
    ratios = [row["sigmaRatioV6OverV4"] for row in rows]
    mean_ratio = sum(ratios) / len(ratios)
    return {
        "schemaVersion": 1,
        "candidatePairs": CANDIDATE_PAIRS,
        "buckets": BUCKETS,
        "rows": rows,
        "rowCount": len(rows),
        "shrunkCount": shrunk_count,
        "shrunkRate": shrunk_count / len(rows),
        "meanSigmaRatioV6OverV4": mean_ratio,
        "allShrunk": shrunk_count == len(rows),
        "majorityShrunk": shrunk_count > len(rows) / 2,
        "noneShrunk": shrunk_count == 0,
    }


def report(meta):
    lines = ["# T172 sigma比較(v4校正時 vs v6校正時)", "", "## 結論", ""]
    verdict = (
        "全16行でsigma縮小" if meta["allShrunk"] else
        "sigma縮小なし(0/16)" if meta["noneShrunk"] else
        f"一部縮小({meta['shrunkCount']}/{meta['rowCount']}行)"
    )
    lines.append(f"- {verdict}(平均比 v6/v4 = {meta['meanSigmaRatioV6OverV4']:.4f})")
    lines.append("")
    lines += [
        "| 空き帯 | shallow | deep | v4 sigma | v6 sigma | 比(v6/v4) | 縮小? | v4ノード比中央値 | v6ノード比中央値 |",
        "|:---:|---:|---:|---:|---:|---:|:---:|---:|---:|",
    ]
    for row in meta["rows"]:
        lines.append(
            f"| {row['emptyBucket']} | {row['shallowDepth']} | {row['deepDepth']} | "
            f"{row['v4ResidualSigma']:.2f} | {row['v6ResidualSigma']:.2f} | "
            f"{row['sigmaRatioV6OverV4']:.4f} | {'○' if row['sigmaShrunk'] else '×'} | "
            f"{row['v4NodeRatioMedianAll']:.4f} | {row['v6NodeRatioMedianAll']:.4f} |"
        )
    lines.append("")
    return "\n".join(lines)


def self_test():
    v4 = {
        "sourcePositionsFingerprint": "p", "sourceWeightsFingerprint": "w4",
        "groups": [
            {"emptyBucket": b, "shallowDepth": s, "deepDepth": d, "residualSigma": 100.0,
             "slope": 1.0, "intercept": 0.0, "fitN": 10,
             "summaries": {"all": {"shallowDeepNodeRatioMedian": 0.1}}}
            for (s, d) in CANDIDATE_PAIRS for b in BUCKETS
        ],
    }
    v6 = json.loads(json.dumps(v4))
    v6["sourceWeightsFingerprint"] = "w6"
    for g in v6["groups"]:
        g["residualSigma"] = 50.0
    result = compare(v4, v6, v4["sourcePositionsFingerprint"], v6["sourcePositionsFingerprint"])
    assert result["allShrunk"]
    assert result["rowCount"] == 16
    assert abs(result["meanSigmaRatioV6OverV4"] - 0.5) < 1e-12
    print("self-test passed")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--v4-stats", type=Path)
    p.add_argument("--v6-stats", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--report", type=Path)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return
    v4_stats, v6_stats = load(args.v4_stats), load(args.v6_stats)
    meta = compare(
        v4_stats, v6_stats,
        v4_stats["sourcePositionsFingerprint"], v6_stats["sourcePositionsFingerprint"],
    )
    meta["inputs"] = {
        "v4Stats": {"path": args.v4_stats.as_posix(), "sha256": digest(args.v4_stats)},
        "v6Stats": {"path": args.v6_stats.as_posix(), "sha256": digest(args.v6_stats)},
    }
    atomic_json(args.out, meta)
    atomic_text(args.report, report(meta))
    print(json.dumps({"allShrunk": meta["allShrunk"], "shrunkCount": meta["shrunkCount"],
                       "rowCount": meta["rowCount"], "meanRatio": meta["meanSigmaRatioV6OverV4"]},
                      sort_keys=True))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""T176要件1-1: t172_v6_pilot_stats.json(既存データ、再計測不要)から、
t in {1.5(現行), 1.3, 1.2, 1.1, 1.0}のマージン表を機械生成する。

`margin = ceil(t * residualSigma)`という埋め込み式(T172/T156cで確立、
`engine/src/mpc.rs`の`calibration_with_margin_t`と同一の式)を、
T156b選定の候補4ペア(d,D)=(3,6),(4,8),(2,10),(4,12) × 4空き帯 = 16行に
適用する。本スクリプト自体は engine を一切呼ばない(純粋なデータ変換)。
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

CANDIDATE_PAIRS = [(3, 6), (4, 8), (2, 10), (4, 12)]
BUCKETS = ["21-28", "29-36", "37-44", "45-52"]
T_VALUES = [1.5, 1.3, 1.2, 1.1, 1.0]


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


def build(stats):
    by_key = {(g["emptyBucket"], g["shallowDepth"], g["deepDepth"]): g for g in stats["groups"]}
    rows = []
    for shallow, deep in CANDIDATE_PAIRS:
        for bucket in BUCKETS:
            group = by_key[(bucket, shallow, deep)]
            sigma = group["residualSigma"]
            margins = {str(t): math.ceil(t * sigma) for t in T_VALUES}
            rows.append({
                "emptyBucket": bucket, "shallowDepth": shallow, "deepDepth": deep,
                "residualSigma": sigma, "margins": margins,
            })
    return {
        "schemaVersion": 1,
        "candidatePairs": CANDIDATE_PAIRS,
        "buckets": BUCKETS,
        "tValues": T_VALUES,
        "formula": "margin = ceil(t * residualSigma), t=1.5 reproduces engine/src/mpc.rs CALIBRATIONS exactly",
        "rows": rows,
    }


def report(meta):
    lines = ["# T176 マージン表(t=1.5, 1.3, 1.2, 1.1, 1.0)", "",
             "式: `margin = ceil(t * residualSigma)`(t=1.5は本番`engine/src/mpc.rs`のCALIBRATIONS表と完全一致)。", "",
             "| 空き帯 | shallow | deep | sigma | t=1.5 | t=1.3 | t=1.2 | t=1.1 | t=1.0 |",
             "|:---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for row in meta["rows"]:
        m = row["margins"]
        lines.append(
            f"| {row['emptyBucket']} | {row['shallowDepth']} | {row['deepDepth']} | "
            f"{row['residualSigma']:.2f} | {m['1.5']} | {m['1.3']} | {m['1.2']} | {m['1.1']} | {m['1.0']} |"
        )
    lines.append("")
    return "\n".join(lines)


def self_test():
    stats = {
        "groups": [
            {"emptyBucket": b, "shallowDepth": s, "deepDepth": d, "residualSigma": 100.0}
            for (s, d) in CANDIDATE_PAIRS for b in BUCKETS
        ],
    }
    meta = build(stats)
    assert len(meta["rows"]) == 16
    assert meta["rows"][0]["margins"]["1.5"] == 150
    assert meta["rows"][0]["margins"]["1.0"] == 100
    print("self-test passed")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--stats", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--report", type=Path)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return
    stats = load(args.stats)
    meta = build(stats)
    meta["inputs"] = {"stats": {"path": args.stats.as_posix(), "sha256": digest(args.stats)}}
    atomic_json(args.out, meta)
    atomic_text(args.report, report(meta))
    print(json.dumps({"rowCount": len(meta["rows"])}, sort_keys=True))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""T156a MPC measurements: affine fits and directional residual tails."""

import argparse
import json
import math
import statistics
from pathlib import Path


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * q
    lo, hi = math.floor(at), math.ceil(at)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - at) + ordered[hi] * (at - lo)


def fit_affine(rows, shallow_depth, deep_depth):
    points = []
    for row in rows:
        values = {item["depth"]: item for item in row["results"]}
        if shallow_depth in values and deep_depth in values:
            points.append((values[shallow_depth]["score"], values[deep_depth]["score"]))
    if len(points) < 3:
        raise ValueError("affine fit needs at least three points")
    mean_x = statistics.fmean(x for x, _ in points)
    mean_y = statistics.fmean(y for _, y in points)
    ss_x = sum((x - mean_x) ** 2 for x, _ in points)
    if ss_x == 0:
        raise ValueError("zero shallow-score variance")
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / ss_x
    intercept = mean_y - slope * mean_x
    residuals = [y - (slope * x + intercept) for x, y in points]
    sigma = math.sqrt(sum(r * r for r in residuals) / (len(residuals) - 2))
    return slope, intercept, sigma


def summarize(rows, shallow_depth, deep_depth, slope, intercept, sigma):
    residuals, node_ratios = [], []
    for row in rows:
        values = {item["depth"]: item for item in row["results"]}
        if shallow_depth not in values or deep_depth not in values:
            continue
        shallow, deep = values[shallow_depth], values[deep_depth]
        residuals.append(deep["score"] - (slope * shallow["score"] + intercept))
        if deep["nodes"]:
            node_ratios.append(shallow["nodes"] / deep["nodes"])
    positive = [r for r in residuals if r > 0]
    negative = [-r for r in residuals if r < 0]
    tails = {}
    for threshold in (1.5, 1.75, 2.0):
        margin = threshold * sigma
        tails[str(threshold)] = {
            "highCount": sum(r >= margin for r in residuals),
            "highRate": sum(r >= margin for r in residuals) / len(residuals),
            "lowCount": sum(r <= -margin for r in residuals),
            "lowRate": sum(r <= -margin for r in residuals) / len(residuals),
        }
    return {
        "n": len(residuals),
        "residualMean": statistics.fmean(residuals),
        "residualRmse": math.sqrt(statistics.fmean(r * r for r in residuals)),
        "positiveTailP90": percentile(positive, 0.90),
        "positiveTailP95": percentile(positive, 0.95),
        "negativeTailP90": percentile(negative, 0.90),
        "negativeTailP95": percentile(negative, 0.95),
        "shallowDeepNodeRatioMedian": statistics.median(node_ratios),
        "sigmaTailExceedance": tails,
    }


def calculate(document):
    rows = document["records"]
    buckets = sorted({row["emptyBucket"] for row in rows})
    splits = ("calibration", "tuning", "test")
    groups = []
    for bucket in buckets:
        bucket_rows = [row for row in rows if row["emptyBucket"] == bucket]
        fit_rows = [row for row in bucket_rows if row["split"] == "calibration"]
        available = sorted({item["depth"] for row in bucket_rows for item in row["results"]})
        for deep in available:
            for shallow in (d for d in available if d < deep):
                slope, intercept, sigma = fit_affine(fit_rows, shallow, deep)
                summaries = {
                    split: summarize(
                        [row for row in bucket_rows if row["split"] == split],
                        shallow, deep, slope, intercept, sigma,
                    )
                    for split in splits
                }
                summaries["all"] = summarize(
                    bucket_rows, shallow, deep, slope, intercept, sigma
                )
                groups.append({
                    "emptyBucket": bucket,
                    "deepDepth": deep,
                    "shallowDepth": shallow,
                    "fitSplit": "calibration",
                    "fitN": len(fit_rows),
                    "slope": slope,
                    "intercept": intercept,
                    "residualSigma": sigma,
                    "summaries": summaries,
                })
    return {
        "schemaVersion": 1,
        "sourcePositionsFingerprint": document["positionsFingerprint"],
        "sourceWeightsFingerprint": document["weightsFingerprint"],
        "depths": document["depths"],
        "recordCount": len(rows),
        "groups": groups,
    }


def self_test():
    rows = []
    for split in ("calibration", "tuning", "test"):
        for x in (0, 10, 20, 30):
            rows.append({"emptyBucket": "21-28", "split": split, "results": [
                {"depth": 1, "score": x, "nodes": 10},
                {"depth": 2, "score": 2 * x + 5, "nodes": 100},
            ]})
    result = calculate({"records": rows, "positionsFingerprint": "p",
                        "weightsFingerprint": "w", "depths": [1, 2]})
    group = result["groups"][0]
    assert abs(group["slope"] - 2) < 1e-12
    assert abs(group["intercept"] - 5) < 1e-12
    assert group["residualSigma"] == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("self-test passed")
        return
    if args.input is None or args.out is None:
        parser.error("--input and --out are required")
    result = calculate(json.loads(args.input.read_text(encoding="utf-8")))
    temp = args.out.with_name(f".{args.out.name}.tmp")
    temp.write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf-8", newline="\n")
    temp.replace(args.out)
    print(f"wrote {len(result['groups'])} groups to {args.out}")


if __name__ == "__main__":
    main()

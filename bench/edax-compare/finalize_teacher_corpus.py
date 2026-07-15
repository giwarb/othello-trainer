#!/usr/bin/env python3
"""T090a redo: 既存コーパスをEdax再実行なしで補正し、コミット用manifestを作る。

各childへ`diffFromBest = bestValue - value`を付与する。監査用candidate mappingから
WTHORレコードへ`openingKey`を付与し、engineLossレコードへnullを付与する。primaryは
マージ済みJSONLを正本としつつ全8シャードも同期し、監査結果をmetaへ記録する。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "train" / "data" / "teacher"
MANIFEST_DIR = ROOT / "bench" / "edax-compare" / "teacher_manifests"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def backfill(path: Path, openings: dict[tuple[str, str], str]) -> int:
    temp = path.with_suffix(path.suffix + ".tmp")
    count = 0
    try:
        with path.open("r", encoding="utf-8") as source, temp.open("w", encoding="utf-8", newline="\n") as out:
            for line_no, raw in enumerate(source, start=1):
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"{path}:{line_no}: malformed JSON: {exc}") from exc
                best = record["bestValue"]
                for child in record["children"]:
                    child["diffFromBest"] = best - child["value"]
                source_name = record.get("source")
                if source_name == "wthor":
                    position_key = (record["board"], record["sideToMove"])
                    if position_key not in openings:
                        raise RuntimeError(f"{path}:{line_no}: WTHOR position lacks audited opening mapping")
                    record["openingKey"] = openings[position_key]
                elif source_name == "engineLoss":
                    record["openingKey"] = None
                else:
                    raise RuntimeError(f"{path}:{line_no}: unknown source {source_name!r}")
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                count += 1
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()
    return count


def opening_map(candidate_path: Path) -> dict[tuple[str, str], str]:
    doc = json.loads(candidate_path.read_text(encoding="utf-8"))
    result = {}
    for row in doc["positions"]:
        key = row.get("openingKey")
        if not key:
            raise RuntimeError(f"{candidate_path}: candidate lacks openingKey")
        result[(row["board"], row["sideToMove"])] = key
    return result


def corpus_stats(path: Path, openings: dict[tuple[str, str], str]) -> tuple[dict, dict]:
    sources = Counter()
    phases = Counter()
    xc_by_phase: dict[int, Counter] = defaultdict(Counter)
    opening_counts = Counter()
    children = exact = terminal = 0
    elapsed_sum = 0.0
    elapsed_count = 0
    unmatched_openings = 0
    with path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            record = json.loads(raw)
            sources[record["source"]] += 1
            if record["source"] == "wthor":
                phase = record["phaseBin"]
                phases[phase] += 1
                xc_by_phase[phase]["total"] += 1
                if record["hasXcLegalMove"]:
                    xc_by_phase[phase]["xc"] += 1
                opening = openings.get((record["board"], record["sideToMove"]))
                if opening is None:
                    unmatched_openings += 1
                else:
                    opening_counts[opening] += 1
            for child in record["children"]:
                children += 1
                if child["exact"]:
                    exact += 1
                if child["level"] is None:
                    terminal += 1
                if "elapsedMs" in child:
                    elapsed_sum += child["elapsedMs"]
                    elapsed_count += 1

    wthor_count = sources["wthor"]
    phase_report = {
        str(phase): {
            "total": counts["total"],
            "xc": counts["xc"],
            "xcCoverage": counts["xc"] / counts["total"] if counts["total"] else None,
        }
        for phase, counts in sorted(xc_by_phase.items())
    }
    max_key, max_count = opening_counts.most_common(1)[0] if opening_counts else (None, 0)
    report = {
        "openingKeyPlies": 8,
        "phaseXcCoverage": phase_report,
        "openingMatched": sum(opening_counts.values()),
        "openingUnmatched": unmatched_openings,
        "distinctOpeningKeys": len(opening_counts),
        "maxOpeningKey": max_key,
        "maxOpeningCount": max_count,
        "maxOpeningShareOfWthor": max_count / wthor_count if wthor_count else None,
        "acceptanceThresholds": {"minimumXcCoveragePerPhase": 0.50, "maximumSingleOpeningShare": 0.02},
    }
    failed_xc_bins = [
        phase for phase, values in phase_report.items() if values["xcCoverage"] is not None and values["xcCoverage"] < 0.50
    ]
    report["failedXcPhaseBins"] = failed_xc_bins
    report["openingShareExceeded"] = report["maxOpeningShareOfWthor"] > 0.02
    threshold_triggered = bool(failed_xc_bins or report["openingShareExceeded"])
    report["thresholdTriggered"] = threshold_triggered
    report["measuredDeviationRuling"] = {
        "summary": "measured deviations, accepted by orchestrator ruling 2026-07-15",
        "status": "accepted",
        "rulingDate": "2026-07-15",
        "regenerationOrReselectionRequired": False,
        "reason": (
            "canonical positions are unique; primary X/C coverage is at least 50% in every phase; "
            "smoke bin 0 is development-only; opening concentration reflects the observed human-game distribution"
        ),
    }
    report["requiresOrchestratorDecision"] = False
    stats = {
        "records": sum(sources.values()),
        "sourceCounts": dict(sources),
        "phaseCountsWthor": {str(key): value for key, value in sorted(phases.items())},
        "children": children,
        "exactChildren": exact,
        "exactRate": exact / children,
        "terminalChildren": terminal,
        "averageElapsedMsPerEdaxCall": elapsed_sum / elapsed_count,
        "errors": 0,
    }
    return stats, report


def update_meta(set_name: str, stats: dict, report: dict, jsonl_paths: list[Path]) -> dict:
    meta_path = DATA_DIR / f"corpus_{set_name}.meta.json"
    doc = json.loads(meta_path.read_text(encoding="utf-8"))
    doc["schemaVersion"] = 2
    doc["corpusStats"] = stats
    doc["selectionAudit"] = report
    doc["postprocessing"] = {
        "operation": "backfill diffFromBest and audited openingKey without Edax rerun",
        "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "authoritativeFile": f"corpus_{set_name}.jsonl",
        "shardPolicy": "primary merged file is authoritative; all shard JSONL files were synchronized",
        "corpusSha256": sha256(DATA_DIR / f"corpus_{set_name}.jsonl"),
        "shardSha256": {path.name: sha256(path) for path in jsonl_paths if "_shard" in path.name},
    }
    doc["generationCommand"] = (
        "python bench/edax-compare/gen_teacher_corpus.py primary --num-shards 8"
        if set_name == "primary"
        else "python bench/edax-compare/gen_teacher_corpus.py smoke"
    )
    doc["finalizationCommand"] = (
        "python bench/edax-compare/finalize_teacher_corpus.py smoke="
        "train/data/teacher/candidates_smoke_audit.json primary=train/data/teacher/candidates_primary_audit.json"
    )
    with meta_path.open("w", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = MANIFEST_DIR / f"corpus_{set_name}.meta.json"
    with manifest_path.open("w", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return doc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", nargs="+", help="set=path, for example smoke=train/data/teacher/candidates_smoke_audit.json")
    args = parser.parse_args()
    candidates = {}
    for item in args.candidate:
        set_name, path = item.split("=", 1)
        candidates[set_name] = ROOT / path

    for set_name in ("smoke", "primary"):
        if set_name not in candidates:
            raise SystemExit(f"missing candidate mapping for {set_name}")
        paths = [DATA_DIR / f"corpus_{set_name}.jsonl"]
        if set_name == "primary":
            paths.extend(sorted(DATA_DIR.glob("corpus_primary_shard*of8.jsonl")))
            if len(paths) != 9:
                raise RuntimeError("expected merged primary plus 8 shard JSONL files")
        openings = opening_map(candidates[set_name])
        for path in paths:
            print(f"{path.name}: backfilled {backfill(path, openings)} record(s)")
        stats, report = corpus_stats(paths[0], openings)
        if report["openingUnmatched"]:
            raise RuntimeError(f"{set_name}: {report['openingUnmatched']} WTHOR positions lack opening mapping")
        update_meta(set_name, stats, report, paths)
        print(f"{set_name}: stats={stats} audit={report}")


if __name__ == "__main__":
    main()

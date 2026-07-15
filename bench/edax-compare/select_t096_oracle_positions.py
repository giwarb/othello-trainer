#!/usr/bin/env python3
"""Select the independent, stratified WTHOR position set used by T096."""

import argparse
import hashlib
import json
import random
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AUDIT = ROOT / "train/data/teacher/candidates_primary_audit.json"
DEFAULT_TEACHER = ROOT / "train/data/teacher/corpus_primary.jsonl"
DEFAULT_TOOL = ROOT / "target/release/teacher_candidates.exe"
DEFAULT_OUTPUT = ROOT / "bench/edax-compare/t096_oracle_positions.json"
STRATA = ((18, 20, 20), (21, 23, 20), (24, 26, 20))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_keys(tool, positions):
    payload = [{"board": p["board"], "sideToMove": p["sideToMove"]} for p in positions]
    result = subprocess.run([str(tool), "canonical"], input=json.dumps(payload), text=True,
                            capture_output=True, check=True)
    return [tuple(key) for key in json.loads(result.stdout)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--teacher", type=Path, default=DEFAULT_TEACHER)
    parser.add_argument("--canonical-tool", type=Path, default=DEFAULT_TOOL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed", type=int, default=96001)
    args = parser.parse_args()

    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    pool = [p for p in audit["positions"] if p.get("source") == "wthor" and 18 <= p["empties"] <= 26]
    keys = canonical_keys(args.canonical_tool, pool)
    teacher_keys = set()
    with args.teacher.open(encoding="utf-8") as handle:
        for line in handle:
            teacher_keys.add(tuple(json.loads(line)["canonicalKey"]))

    unique = {}
    overlap_count = 0
    duplicate_count = 0
    for source_index, (position, key) in enumerate(zip(pool, keys)):
        if key in teacher_keys:
            overlap_count += 1
            continue
        if key in unique:
            duplicate_count += 1
            continue
        unique[key] = (source_index, position)

    rng = random.Random(args.seed)
    selected = []
    strata_audit = []
    for lower, upper, quota in STRATA:
        eligible = [(key, value) for key, value in unique.items()
                    if lower <= value[1]["empties"] <= upper]
        eligible.sort(key=lambda item: (item[1][1]["year"], item[1][1]["gameIndex"],
                                        item[1][1]["empties"], item[1][1]["board"],
                                        item[1][1]["sideToMove"]))
        if len(eligible) < quota:
            raise RuntimeError(f"stratum {lower}-{upper}: need {quota}, found {len(eligible)}")
        chosen = rng.sample(eligible, quota)
        strata_audit.append({"emptiesMin": lower, "emptiesMax": upper,
                             "eligibleAfterExclusion": len(eligible), "selected": quota})
        selected.extend(chosen)

    selected.sort(key=lambda item: (item[1][1]["empties"], item[1][1]["year"],
                                    item[1][1]["gameIndex"], item[1][1]["board"]))
    positions = []
    for number, (key, (source_index, p)) in enumerate(selected, 1):
        positions.append({
            "id": f"t096-exact-{number:02d}", "board": p["board"],
            "side_to_move": p["sideToMove"], "empties": p["empties"],
            "canonicalKey": list(key), "source": "wthor", "year": p["year"],
            "gameIndex": p["gameIndex"], "auditFilteredIndex": source_index,
        })

    write_manifest(args, pool, teacher_keys, overlap_count, duplicate_count,
                   strata_audit, positions)


def write_manifest(args, pool, teacher_keys, overlap_count, duplicate_count,
                   strata_audit, positions):
    empties_counts = Counter(p["empties"] for p in positions)
    document = {
        "schemaVersion": 1,
        "purpose": "T096 independent exact-oracle regret gate; Edax -l 60 only",
        "selection": {
            "seed": args.seed, "rng": "Python random.Random (MT19937)",
            "source": "WTHOR 2015-2024 positions in candidates_primary_audit.json",
            "procedure": [
                "Keep source=wthor and empties 18..26 from the audit array in source order.",
                "Compute D4 canonicalKey with the Rust teacher_candidates canonical command.",
                "Remove every key present in corpus_primary.jsonl, then canonical duplicates (first wins).",
                "Sort each empties stratum by year, gameIndex, empties, board, sideToMove and sample without replacement.",
                "Select 20 positions from each of 18-20, 21-23, and 24-26 empties; sort output deterministically.",
            ],
            "command": "cargo build --release -p train --bin teacher_candidates; python bench/edax-compare/select_t096_oracle_positions.py",
            "sourceAuditSha256": digest(args.audit),
            "teacherCorpusSha256": digest(args.teacher),
            "canonicalToolProtocol": "teacher_candidates canonical (Rust train::experiment::canonicalize)",
            "inputInRange": len(pool), "teacherCanonicalKeys": len(teacher_keys),
            "excludedTeacherOverlap": overlap_count,
            "excludedCanonicalDuplicatesAfterTeacher": duplicate_count,
            "verifiedSelectedTeacherOverlap": sum(tuple(p["canonicalKey"]) in teacher_keys for p in positions),
            "existingT085PositionsIncluded": 0,
            "existingPositionPolicy": "Not included: the new WTHOR-only sample is larger and avoids inherited engineLoss/teacher overlap.",
            "newPositions": len(positions), "strata": strata_audit,
        },
        "oracle": {"kind": "exact", "edaxLevel": 60, "bookUsage": "off",
                   "primaryDecisionSeries": True},
        "counts": {"total": len(positions), "byEmpties": dict(sorted(empties_counts.items()))},
        "positions": positions,
    }
    args.output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}: {len(positions)} positions, teacher overlap=0")


if __name__ == "__main__":
    main()

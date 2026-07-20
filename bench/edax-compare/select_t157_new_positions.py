#!/usr/bin/env python3
"""Select +120 new WTHOR oracle positions extending T096's 60-position set to 180.

Follows the T096 stratification exactly (18-20 / 21-23 / 24-26 empties, WTHOR
2015-2024 pool from candidates_primary_audit.json, teacher-corpus canonical
exclusion) but additionally excludes the existing T096 60 positions and the
T156 MPC calibration 1,200 positions so the combined 180-position set has zero
canonical-key overlap across all three corpora.
"""

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
DEFAULT_T096 = ROOT / "bench/edax-compare/t096_oracle_positions.json"
DEFAULT_T156 = ROOT / "bench/edax-compare/t156_mpc_positions.json"
DEFAULT_OUTPUT = ROOT / "bench/edax-compare/t157_new_positions.json"
STRATA = ((18, 20, 40), (21, 23, 40), (24, 26, 40))


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
    parser.add_argument("--t096", type=Path, default=DEFAULT_T096)
    parser.add_argument("--t156", type=Path, default=DEFAULT_T156)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed", type=int, default=157001)
    args = parser.parse_args()

    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    pool = [p for p in audit["positions"] if p.get("source") == "wthor" and 18 <= p["empties"] <= 26]
    keys = canonical_keys(args.canonical_tool, pool)

    teacher_keys = set()
    with args.teacher.open(encoding="utf-8") as handle:
        for line in handle:
            teacher_keys.add(tuple(json.loads(line)["canonicalKey"]))

    t096_doc = json.loads(args.t096.read_text(encoding="utf-8"))
    t096_keys = {tuple(p["canonicalKey"]) for p in t096_doc["positions"]}
    if len(t096_keys) != len(t096_doc["positions"]):
        raise RuntimeError("t096 corpus itself contains duplicate canonical keys")

    t156_positions = json.loads(args.t156.read_text(encoding="utf-8"))
    t156_keys = set(canonical_keys(args.canonical_tool, t156_positions))
    if len(t156_keys) != len(t156_positions):
        raise RuntimeError("t156 corpus itself contains duplicate canonical keys (unexpected, investigate)")

    excluded_keys = teacher_keys | t096_keys | t156_keys

    unique = {}
    overlap_teacher = 0
    overlap_t096 = 0
    overlap_t156 = 0
    duplicate_count = 0
    for source_index, (position, key) in enumerate(zip(pool, keys)):
        if key in teacher_keys:
            overlap_teacher += 1
            continue
        if key in t096_keys:
            overlap_t096 += 1
            continue
        if key in t156_keys:
            overlap_t156 += 1
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
    for number, (key, (source_index, p)) in enumerate(selected, 61):
        positions.append({
            "id": f"t157-exact-{number:03d}", "board": p["board"],
            "side_to_move": p["sideToMove"], "empties": p["empties"],
            "canonicalKey": list(key), "source": "wthor", "year": p["year"],
            "gameIndex": p["gameIndex"], "auditFilteredIndex": source_index,
            "cohort": "t157ext",
        })

    selected_keys = {tuple(p["canonicalKey"]) for p in positions}
    if len(selected_keys) != len(positions):
        raise RuntimeError("newly selected positions contain duplicate canonical keys")
    if selected_keys & excluded_keys:
        raise RuntimeError("newly selected positions overlap an excluded corpus (teacher/t096/t156)")

    write_manifest(args, pool, teacher_keys, t096_keys, t156_keys,
                   overlap_teacher, overlap_t096, overlap_t156, duplicate_count,
                   strata_audit, positions)


def write_manifest(args, pool, teacher_keys, t096_keys, t156_keys,
                   overlap_teacher, overlap_t096, overlap_t156, duplicate_count,
                   strata_audit, positions):
    empties_counts = Counter(p["empties"] for p in positions)
    document = {
        "schemaVersion": 1,
        "purpose": "T157 extension: +120 new WTHOR positions, independent of T096's 60, "
                   "the training teacher corpus, and the T156 MPC calibration 1,200; "
                   "exact-oracle regret gate, Edax -l 60 only.",
        "selection": {
            "seed": args.seed, "rng": "Python random.Random (MT19937)",
            "source": "WTHOR 2015-2024 positions in candidates_primary_audit.json",
            "procedure": [
                "Keep source=wthor and empties 18..26 from the audit array in source order.",
                "Compute D4 canonicalKey with the Rust teacher_candidates canonical command.",
                "Exclude keys present in corpus_primary.jsonl (teacher corpus).",
                "Exclude keys present in t096_oracle_positions.json (existing 60).",
                "Exclude keys present in t156_mpc_positions.json (MPC calibration 1,200).",
                "Remove remaining canonical duplicates (first wins).",
                "Sort each empties stratum by year, gameIndex, empties, board, sideToMove and sample without replacement.",
                "Select 40 positions from each of 18-20, 21-23, and 24-26 empties; sort output deterministically.",
            ],
            "command": "cargo build --release -p train --bin teacher_candidates; "
                       "python bench/edax-compare/select_t157_new_positions.py",
            "sourceAuditSha256": digest(args.audit),
            "teacherCorpusSha256": digest(args.teacher),
            "t096CorpusSha256": digest(args.t096),
            "t156CorpusSha256": digest(args.t156),
            "canonicalToolProtocol": "teacher_candidates canonical (Rust train::experiment::canonicalize)",
            "inputInRange": len(pool),
            "teacherCanonicalKeys": len(teacher_keys),
            "t096CanonicalKeys": len(t096_keys),
            "t156CanonicalKeys": len(t156_keys),
            "excludedTeacherOverlap": overlap_teacher,
            "excludedT096Overlap": overlap_t096,
            "excludedT156Overlap": overlap_t156,
            "excludedCanonicalDuplicatesAfterExclusions": duplicate_count,
            "verifiedSelectedOverlapWithExcludedSets": 0,
            "newPositions": len(positions), "strata": strata_audit,
        },
        "oracle": {"kind": "exact", "edaxLevel": 60, "bookUsage": "off",
                   "primaryDecisionSeries": True},
        "counts": {"total": len(positions), "byEmpties": dict(sorted(empties_counts.items()))},
        "positions": positions,
    }
    args.output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}: {len(positions)} positions, "
          f"teacher/t096/t156 overlap all verified 0")


if __name__ == "__main__":
    main()

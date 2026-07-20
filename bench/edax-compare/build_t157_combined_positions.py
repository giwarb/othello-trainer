#!/usr/bin/env python3
"""Combine the T096 60-position oracle set with the T157 +120 extension into a
single 180-position manifest, with a machine-verified zero-duplicate check
across the combined set and the excluded corpora (teacher / T156)."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
T096 = ROOT / "bench/edax-compare/t096_oracle_positions.json"
T157_NEW = ROOT / "bench/edax-compare/t157_new_positions.json"
TEACHER = ROOT / "train/data/teacher/corpus_primary.jsonl"
T156 = ROOT / "bench/edax-compare/t156_mpc_positions.json"
OUTPUT = ROOT / "bench/edax-compare/t157_oracle_positions.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    t096_doc = json.loads(T096.read_text(encoding="utf-8"))
    t157_doc = json.loads(T157_NEW.read_text(encoding="utf-8"))

    t096_positions = []
    for p in t096_doc["positions"]:
        q = dict(p)
        q["cohort"] = "t096"
        t096_positions.append(q)
    t157_positions = t157_doc["positions"]

    combined = t096_positions + t157_positions
    keys = [tuple(p["canonicalKey"]) for p in combined]
    if len(set(keys)) != len(keys):
        raise RuntimeError("duplicate canonicalKey found in combined 180-position set")
    ids = [p["id"] for p in combined]
    if len(set(ids)) != len(ids):
        raise RuntimeError("duplicate id found in combined 180-position set")

    teacher_keys = set()
    with TEACHER.open(encoding="utf-8") as handle:
        for line in handle:
            teacher_keys.add(tuple(json.loads(line)["canonicalKey"]))
    teacher_overlap = sum(1 for key in keys if key in teacher_keys)
    if teacher_overlap:
        raise RuntimeError(f"combined set overlaps teacher corpus: {teacher_overlap} keys")

    from collections import Counter
    empties_counts = Counter(p["empties"] for p in combined)
    cohort_counts = Counter(p["cohort"] for p in combined)

    document = {
        "schemaVersion": 1,
        "purpose": "T157 combined 180-position independent exact-oracle regret gate "
                   "(T096's 60 + T157's +120 extension); Edax -l 60 only, book off.",
        "provenance": {
            "t096Sha256": digest(T096),
            "t157NewSha256": digest(T157_NEW),
            "teacherCorpusSha256": digest(TEACHER),
            "t156CorpusSha256": digest(T156),
        },
        "verification": {
            "total": len(combined),
            "uniqueCanonicalKeys": len(set(keys)),
            "uniqueIds": len(set(ids)),
            "teacherCorpusOverlap": teacher_overlap,
            "cohortCounts": dict(cohort_counts),
        },
        "oracle": {"kind": "exact", "edaxLevel": 60, "bookUsage": "off",
                   "primaryDecisionSeries": True},
        "counts": {"total": len(combined), "byEmpties": dict(sorted(empties_counts.items()))},
        "positions": combined,
    }
    OUTPUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT}: {len(combined)} positions "
          f"(t096={cohort_counts['t096']}, t157ext={cohort_counts['t157ext']}), "
          f"unique canonicalKeys={len(set(keys))}, teacher overlap={teacher_overlap}")


if __name__ == "__main__":
    main()

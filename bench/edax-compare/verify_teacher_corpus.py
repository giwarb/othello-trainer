#!/usr/bin/env python3
"""T090a教師コーパスの厳密検証。

全件についてRustの`engine::bitboard::Board`を利用する`teacher_candidates children`
を呼び、盤面の全合法手集合と`children[].move`を完全照合する。JSONL/metaの完全性、
positionId、D4重複、best/diff、exact深さも検証し、欠落ファイルやmalformed行を含む
いずれかの不整合でexit 1を返す。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEACHER_DATA_DIR = ROOT / "train" / "data" / "teacher"
TOOL = ROOT / "target" / "release" / "teacher_candidates.exe"
BATCH_SIZE = 500


def report(set_name: str, message: str) -> None:
    print(f"[{set_name}] {message}", file=sys.stderr)


def compute_children(records: list[dict]) -> list[dict]:
    payload = [{"board": rec.get("board"), "sideToMove": rec.get("sideToMove")} for rec in records]
    proc = subprocess.run(
        [str(TOOL), "children"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"teacher_candidates children failed: {proc.stderr}")
    result = json.loads(proc.stdout)
    if len(result) != len(records):
        raise RuntimeError(f"children batch size mismatch: {len(result)} != {len(records)}")
    return result


def verify_one(set_name: str) -> tuple[int, int]:
    jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    errors = 0
    if not jsonl_path.exists():
        report(set_name, f"ERROR: {jsonl_path} not found")
        return 0, 1
    if not meta_path.exists():
        report(set_name, f"ERROR: {meta_path} not found")
        return 0, 1
    if not TOOL.exists():
        report(set_name, f"ERROR: {TOOL} not found; build teacher_candidates first")
        return 0, 1

    try:
        meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report(set_name, f"ERROR: malformed meta: {exc}")
        return 0, 1
    expected_total = (meta_doc.get("progress") or {}).get("total")
    expected_done = (meta_doc.get("progress") or {}).get("done")
    if not isinstance(expected_total, int) or not isinstance(expected_done, int):
        report(set_name, "ERROR: meta progress.total/done must be integers")
        errors += 1

    records: list[dict] = []
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            if not raw.strip():
                report(set_name, f"line {line_no}: malformed blank JSONL line")
                errors += 1
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                report(set_name, f"line {line_no}: malformed JSON ({exc})")
                errors += 1
                continue
            if not isinstance(value, dict):
                report(set_name, f"line {line_no}: record is not an object")
                errors += 1
                continue
            records.append(value)

    if expected_total != len(records) or expected_done != len(records):
        report(
            set_name,
            f"meta count mismatch: records={len(records)} progress.done={expected_done} progress.total={expected_total}",
        )
        errors += 1

    ids = [rec.get("positionId") for rec in records]
    expected_ids = list(range(expected_total)) if isinstance(expected_total, int) and expected_total >= 0 else []
    if ids != expected_ids:
        missing = sorted(set(expected_ids) - {pid for pid in ids if isinstance(pid, int)})
        duplicates = len(ids) - len(set(map(str, ids)))
        report(set_name, f"positionId sequence mismatch: missing={len(missing)} duplicates={duplicates}")
        errors += 1

    seen_canonical: dict[tuple, int] = {}
    for start in range(0, len(records), BATCH_SIZE):
        batch = records[start : start + BATCH_SIZE]
        try:
            legal_info = compute_children(batch)
        except Exception as exc:  # noqa: BLE001
            report(set_name, f"ERROR: legal move recomputation failed at record {start}: {exc}")
            return len(records), errors + 1

        for rec, info in zip(batch, legal_info):
            pos_id = rec.get("positionId")
            children = rec.get("children")
            if not isinstance(children, list) or not children:
                report(set_name, f"positionId={pos_id}: children must be a non-empty list")
                errors += 1
                continue
            try:
                corpus_moves = [child["move"] for child in children]
                legal_moves = [child["move"] for child in info["moves"]]
            except (KeyError, TypeError) as exc:
                report(set_name, f"positionId={pos_id}: malformed children: {exc}")
                errors += 1
                continue
            if len(corpus_moves) != len(set(corpus_moves)) or set(corpus_moves) != set(legal_moves):
                report(
                    set_name,
                    f"positionId={pos_id}: legal move mismatch corpus={sorted(corpus_moves)} board={sorted(legal_moves)}",
                )
                errors += 1

            by_move = {child["move"]: child for child in info["moves"]}
            try:
                max_value = max(child["value"] for child in children)
                if rec.get("bestValue") != max_value:
                    raise ValueError(f"bestValue={rec.get('bestValue')} max={max_value}")
                best_move = rec.get("bestMove")
                if best_move not in corpus_moves or next(c["value"] for c in children if c["move"] == best_move) != max_value:
                    raise ValueError(f"bestMove={best_move} is not maximal")
                for child in children:
                    expected_diff = max_value - child["value"]
                    if child.get("diffFromBest") != expected_diff:
                        raise ValueError(
                            f"move={child['move']} diffFromBest={child.get('diffFromBest')} expected={expected_diff}"
                        )
                    actual = by_move.get(child["move"])
                    if actual is None:
                        continue
                    if child.get("childEmpties") not in (None, actual["childEmpties"]):
                        raise ValueError(f"move={child['move']} childEmpties mismatch")
                    if actual["childIsTerminal"]:
                        if not child.get("exact") or child.get("level") is not None:
                            raise ValueError(f"terminal move={child['move']} must be exact with level=null")
                    elif child.get("exact"):
                        if child.get("level") != 60 or not isinstance(child.get("edaxDepth"), int):
                            raise ValueError(f"exact move={child['move']} requires level=60 and integer edaxDepth")
                        if child["edaxDepth"] < actual["childEmpties"]:
                            raise ValueError(
                                f"exact move={child['move']} depth={child['edaxDepth']} < empties={actual['childEmpties']}"
                            )
                    elif child.get("level") != 16:
                        raise ValueError(f"non-exact move={child['move']} requires level=16")
            except (KeyError, TypeError, ValueError, StopIteration) as exc:
                report(set_name, f"positionId={pos_id}: {exc}")
                errors += 1

            key_value = rec.get("canonicalKey")
            if not isinstance(key_value, list) or len(key_value) != 3:
                report(set_name, f"positionId={pos_id}: malformed canonicalKey")
                errors += 1
            else:
                key = tuple(key_value)
                if key in seen_canonical:
                    report(set_name, f"positionId={pos_id}: canonicalKey duplicates {seen_canonical[key]}")
                    errors += 1
                else:
                    seen_canonical[key] = pos_id

    print(f"[{set_name}] verified {len(records)} record(s), {errors} error(s)")
    return len(records), errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_names", nargs="+", choices=["smoke", "primary"])
    args = parser.parse_args()
    total_records = total_errors = 0
    for set_name in args.set_names:
        count, errors = verify_one(set_name)
        total_records += count
        total_errors += errors
    print(f"TOTAL: {total_records} record(s) verified, {total_errors} error(s)")
    raise SystemExit(1 if total_errors else 0)


if __name__ == "__main__":
    main()

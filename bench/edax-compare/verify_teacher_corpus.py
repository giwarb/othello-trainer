#!/usr/bin/env python3
"""T090a教師コーパスの厳密検証。

全件についてRustの`engine::bitboard::Board`を利用する`teacher_candidates children`
を呼び、盤面の全合法手集合と`children[].move`を完全照合する。JSONL/metaの完全性、
positionId、D4重複、best/diff、exact深さも検証し、欠落ファイルやmalformed行を含む
いずれかの不整合でexit 1を返す。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEACHER_DATA_DIR = ROOT / "train" / "data" / "teacher"
TOOL = ROOT / "target" / "release" / "teacher_candidates.exe"
BATCH_SIZE = 500
EXACT_EMPTIES_THRESHOLD = 24
# T114: t096独立oracle(60局面)の非混入を全setで機械検証する(混入すると
# 独立評価指標が自己参照になるため)。各局面は既にD4正準化済みcanonicalKeyを
# 持つので、対称形の展開は不要(このキーとの一致チェックだけで足りる)。
T096_ORACLE_POSITIONS_PATH = ROOT / "bench" / "edax-compare" / "t096_oracle_positions.json"


def load_oracle_keys() -> set[tuple[int, int, int]]:
    if not T096_ORACLE_POSITIONS_PATH.exists():
        raise RuntimeError(
            f"{T096_ORACLE_POSITIONS_PATH} not found; oracle non-contamination check cannot be skipped silently"
        )
    doc = json.loads(T096_ORACLE_POSITIONS_PATH.read_text(encoding="utf-8"))
    return {tuple(p["canonicalKey"]) for p in doc["positions"]}


ORACLE_KEYS = load_oracle_keys()
REQUIRED_RECORD_FIELDS = {
    "positionId",
    "board",
    "sideToMove",
    "empties",
    "source",
    "phaseBin",
    "hasXcLegalMove",
    "openingKey",
    "priorityLoss",
    "canonicalKey",
    "children",
    "bestMove",
    "bestValue",
    "generatedAt",
}
REQUIRED_CHILD_FIELDS = {"move", "value", "diffFromBest", "exact", "level", "edaxDepth"}


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


def compute_canonical_keys(records: list[dict]) -> list[list[int]]:
    payload = [{"board": rec.get("board"), "sideToMove": rec.get("sideToMove")} for rec in records]
    proc = subprocess.run(
        [str(TOOL), "canonical"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"teacher_candidates canonical failed: {proc.stderr}")
    result = json.loads(proc.stdout)
    if len(result) != len(records):
        raise RuntimeError(f"canonical batch size mismatch: {len(result)} != {len(records)}")
    return result


def schema_errors(record: dict) -> list[str]:
    errors = []
    missing = sorted(REQUIRED_RECORD_FIELDS - record.keys())
    if missing:
        errors.append(f"missing required field(s): {', '.join(missing)}")
    board = record.get("board")
    if not isinstance(board, str) or len(board) != 64 or set(board) - {"X", "O", "-"}:
        errors.append("board must be a 64-character X/O/- string")
    if record.get("sideToMove") not in {"black", "white"}:
        errors.append("sideToMove must be black or white")
    if isinstance(board, str) and len(board) == 64 and record.get("empties") != board.count("-"):
        errors.append("empties does not match board")

    source = record.get("source")
    if source == "wthor":
        if not isinstance(record.get("phaseBin"), int) or not 0 <= record["phaseBin"] < 6:
            errors.append("wthor phaseBin must be an integer in [0, 5]")
        if not isinstance(record.get("hasXcLegalMove"), bool):
            errors.append("wthor hasXcLegalMove must be boolean")
        if not isinstance(record.get("openingKey"), str) or not record["openingKey"]:
            errors.append("wthor openingKey must be a non-empty string")
        if record.get("priorityLoss") is not None:
            errors.append("wthor priorityLoss must be null")
    elif source == "engineLoss":
        if record.get("phaseBin") is not None or record.get("hasXcLegalMove") is not None:
            errors.append("engineLoss phaseBin/hasXcLegalMove must be null")
        if record.get("openingKey") is not None:
            errors.append("engineLoss openingKey must be null")
        loss = record.get("priorityLoss")
        if not isinstance(loss, (int, float)) or isinstance(loss, bool) or loss < 4:
            errors.append("engineLoss priorityLoss must be numeric and >= 4")
    else:
        errors.append("source must be wthor or engineLoss")

    children = record.get("children")
    if isinstance(children, list):
        for index, child in enumerate(children):
            if not isinstance(child, dict):
                errors.append(f"children[{index}] must be an object")
                continue
            child_missing = sorted(REQUIRED_CHILD_FIELDS - child.keys())
            if child_missing:
                errors.append(f"children[{index}] missing required field(s): {', '.join(child_missing)}")
    return errors


def verify_one(set_name: str) -> tuple[int, int]:
    jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    errors = 0
    if not jsonl_path.exists() or not meta_path.exists():
        report(set_name, f"ERROR: corpus/meta pair not found: {jsonl_path}, {meta_path}")
        return 0, 1
    if not TOOL.exists():
        report(set_name, f"ERROR: {TOOL} not found; build teacher_candidates first")
        return 0, 1
    try:
        meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report(set_name, f"ERROR: malformed meta: {exc}")
        return 0, 1

    exact_empties_threshold = (meta_doc.get("settings") or {}).get(
        "exactEmptiesThreshold", EXACT_EMPTIES_THRESHOLD
    )
    expected_total = (meta_doc.get("progress") or {}).get("total")
    expected_done = (meta_doc.get("progress") or {}).get("done")
    if meta_doc.get("schemaVersion") != 2:
        report(set_name, f"ERROR: meta schemaVersion must be 2, got {meta_doc.get('schemaVersion')!r}")
        errors += 1
    if not isinstance(expected_total, int) or not isinstance(expected_done, int):
        report(set_name, "ERROR: meta progress.total/done must be integers")
        errors += 1
    if set_name == "expanded1m":
        provenance = meta_doc.get("provenance") or {}
        if not isinstance(provenance.get("baseCorpus"), dict) or not isinstance(
            provenance.get("incrementalGeneration"), dict
        ):
            report(set_name, "ERROR: expanded1m requires baseCorpus/incrementalGeneration provenance")
            errors += 1

    seen_canonical: dict[tuple, int] = {}
    record_count = 0
    batch: list[dict] = []

    def verify_batch(records: list[dict], start_index: int) -> int:
        batch_errors = 0
        try:
            legal_info = compute_children(records)
            canonical_keys = compute_canonical_keys(records)
        except Exception as exc:  # noqa: BLE001
            report(set_name, f"ERROR: board recomputation failed at record {start_index}: {exc}")
            return 1
        for rec, info, recomputed_key in zip(records, legal_info, canonical_keys):
            pos_id = rec.get("positionId")
            children = rec.get("children")
            if not isinstance(children, list) or not children:
                report(set_name, f"positionId={pos_id}: children must be a non-empty list")
                batch_errors += 1
                continue
            try:
                corpus_moves = [child["move"] for child in children]
                legal_moves = [child["move"] for child in info["moves"]]
            except (KeyError, TypeError) as exc:
                report(set_name, f"positionId={pos_id}: malformed children: {exc}")
                batch_errors += 1
                continue
            if len(corpus_moves) != len(set(corpus_moves)) or set(corpus_moves) != set(legal_moves):
                report(
                    set_name,
                    f"positionId={pos_id}: legal move mismatch corpus={sorted(corpus_moves)} board={sorted(legal_moves)}",
                )
                batch_errors += 1

            by_move = {child["move"]: child for child in info["moves"]}
            try:
                max_value = max(child["value"] for child in children)
                if rec.get("bestValue") != max_value:
                    raise ValueError(f"bestValue={rec.get('bestValue')} max={max_value}")
                best_move = rec.get("bestMove")
                if best_move not in corpus_moves or next(
                    child["value"] for child in children if child["move"] == best_move
                ) != max_value:
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
                        if child.get("exact") is not True or child.get("level") is not None:
                            raise ValueError(f"terminal move={child['move']} must be exact with level=null")
                        if child.get("edaxDepth") is not None:
                            raise ValueError(f"terminal move={child['move']} requires edaxDepth=null")
                    elif actual["childEmpties"] <= exact_empties_threshold:
                        if child.get("exact") is not True or child.get("level") != 60:
                            raise ValueError(
                                f"move={child['move']} empties={actual['childEmpties']} requires exact=true/level=60"
                            )
                        if not isinstance(child.get("edaxDepth"), int):
                            raise ValueError(f"exact move={child['move']} requires integer edaxDepth")
                        if child["edaxDepth"] < actual["childEmpties"]:
                            raise ValueError(
                                f"exact move={child['move']} depth={child['edaxDepth']} "
                                f"< empties={actual['childEmpties']}"
                            )
                    elif child.get("exact") is not False or child.get("level") != 16:
                        raise ValueError(
                            f"move={child['move']} empties={actual['childEmpties']} requires exact=false/level=16"
                        )
            except (KeyError, TypeError, ValueError, StopIteration) as exc:
                report(set_name, f"positionId={pos_id}: {exc}")
                batch_errors += 1

            key_value = rec.get("canonicalKey")
            if (
                not isinstance(key_value, list)
                or len(key_value) != 3
                or any(not isinstance(value, int) or isinstance(value, bool) for value in key_value)
            ):
                report(set_name, f"positionId={pos_id}: malformed canonicalKey")
                batch_errors += 1
            else:
                if key_value != recomputed_key:
                    report(
                        set_name,
                        f"positionId={pos_id}: canonicalKey mismatch stored={key_value} board={recomputed_key}",
                    )
                    batch_errors += 1
                key = tuple(recomputed_key)
                if key in seen_canonical:
                    report(set_name, f"positionId={pos_id}: recomputed D4 key duplicates {seen_canonical[key]}")
                    batch_errors += 1
                else:
                    seen_canonical[key] = pos_id
                if key in ORACLE_KEYS:
                    report(set_name, f"positionId={pos_id}: canonicalKey matches a t096 independent-oracle position")
                    batch_errors += 1
        return batch_errors

    base_fh = None
    prefix_hash = None
    if set_name == "expanded1m":
        base_path = TEACHER_DATA_DIR / "corpus_expanded200k.jsonl"
        if not base_path.exists():
            report(set_name, "ERROR: expanded200k base missing; prefix identity cannot be verified")
            errors += 1
        else:
            base_fh = base_path.open("r", encoding="utf-8", newline="")
            prefix_hash = hashlib.sha256()

    with jsonl_path.open("r", encoding="utf-8", newline="") as fh:
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
            if value.get("positionId") != record_count:
                report(
                    set_name,
                    f"positionId sequence mismatch at record {record_count}: got {value.get('positionId')}",
                )
                errors += 1
            if base_fh is not None and record_count < 200_000:
                base_raw = base_fh.readline()
                if raw != base_raw:
                    report(set_name, f"positionId={record_count}: expanded200k prefix byte mismatch")
                    errors += 1
                if prefix_hash is not None:
                    prefix_hash.update(raw.encode("utf-8"))
            for message in schema_errors(value):
                report(set_name, f"positionId={value.get('positionId')}: {message}")
                errors += 1
            batch.append(value)
            record_count += 1
            if len(batch) >= BATCH_SIZE:
                errors += verify_batch(batch, record_count - len(batch))
                batch.clear()
    if batch:
        errors += verify_batch(batch, record_count - len(batch))
    if base_fh is not None:
        base_fh.close()
        if record_count >= 200_000 and prefix_hash is not None:
            expected_sha = ((meta_doc.get("provenance") or {}).get("baseCorpus") or {}).get("jsonlSha256")
            if prefix_hash.hexdigest() != expected_sha:
                report(set_name, "ERROR: expanded200k prefix SHA-256 mismatch")
                errors += 1

    if expected_total != record_count or expected_done != record_count:
        report(
            set_name,
            f"meta count mismatch: records={record_count} progress.done={expected_done} progress.total={expected_total}",
        )
        errors += 1
    print(f"[{set_name}] verified {record_count} record(s), {errors} error(s)")
    return record_count, errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_names", nargs="+", choices=["smoke", "primary", "expanded200k", "expanded1m"])
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

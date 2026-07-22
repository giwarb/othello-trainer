#!/usr/bin/env python3
"""T192: Logistello book curated sample(100局面)を`eval_cli solve`
(フルウィンドウ・制限なし)で完全読みし、`logistello_wld_sample_labels.json`の
期待値(仮説)と照合する。

長時間実行ルール(CLAUDE.md)適用: 24空きの完全読みは1局面あたり
数秒〜数十秒かかり得るため、局面単位でチェックポイントに逐次保存し、
中断→再実行時は完了済み局面をスキップして再開する。

使い方:
    python bench/logistello/verify_wld.py run
    python bench/logistello/verify_wld.py report

`run`はチェックポイント(既定 `bench/logistello/verify-results/t192-checkpoint.json`、
.gitignore対象)に1局面ごとの結果を逐次書き込む。`report`は完了済み
チェックポイントを集計し、`bench/logistello/verify_summary.json`
(コミット対象、小さい集計結果のみ)を書き出す。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPARE = ROOT / "bench" / "logistello"
EVAL_CLI = Path(os.environ.get("T192_EVAL_CLI", ROOT / "target" / "release" / "eval_cli.exe"))
POSITIONS = COMPARE / "logistello_wld_sample_positions.json"
LABELS = COMPARE / "logistello_wld_sample_labels.json"
DEFAULT_CHECKPOINT = COMPARE / "verify-results" / "t192-checkpoint.json"
DEFAULT_SUMMARY = COMPARE / "verify_summary.json"
SOLVER_VERSION = "baseline-t052-alpha-beta-tt-v1"
NODE_DEFINITION_VERSION = "logical-negamax-invocation-v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    os.replace(temp, path)


def ensure_tools() -> None:
    if not EVAL_CLI.exists():
        raise RuntimeError(f"missing {EVAL_CLI}; run cargo build --release -p engine --bin eval_cli")


def solve(position: dict) -> dict:
    command = [str(EVAL_CLI), "solve", "--alpha", "-64", "--beta", "64", "--tt-mb", "64"]
    payload = {"board": position["board"], "side_to_move": position["side_to_move"]}
    result = subprocess.run(
        command, input=json.dumps(payload), text=True, capture_output=True
    )
    if result.returncode:
        raise RuntimeError(
            f"eval_cli solve failed ({result.returncode}) for {position['id']}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    value = json.loads(result.stdout)
    if value["solverVersion"] != SOLVER_VERSION:
        raise RuntimeError(f"unexpected solver version: {value['solverVersion']}")
    if value["nodeDefinitionVersion"] != NODE_DEFINITION_VERSION:
        raise RuntimeError(f"unexpected node definition: {value['nodeDefinitionVersion']}")
    return value


class Checkpoint:
    def __init__(self, path: Path, identity: dict):
        self.path = path
        self.value = {"schemaVersion": 1, "identity": identity, "rows": {}}
        if path.exists():
            existing = read_json(path)
            existing_identity = existing.get("identity", {})
            if existing_identity != identity:
                raise RuntimeError(
                    "checkpoint identity mismatch; refusing stale resume "
                    f"(existing={existing_identity}, expected={identity})"
                )
            self.value = existing

    def rows(self) -> dict:
        return self.value.setdefault("rows", {})

    def put(self, key: str, value: dict) -> None:
        self.rows()[key] = value
        atomic_json(self.path, self.value)


def checkpoint_identity() -> dict:
    return {
        "harnessSha256": sha256(Path(__file__)),
        "evalCliSha256": sha256(EVAL_CLI),
        "positionsSha256": sha256(POSITIONS),
        "labelsSha256": sha256(LABELS),
        "solverVersion": SOLVER_VERSION,
        "nodeDefinitionVersion": NODE_DEFINITION_VERSION,
        "ttMiB": 64,
    }


def run(checkpoint_path: Path, stop_after: int | None) -> None:
    ensure_tools()
    positions = {p["id"]: p for p in read_json(POSITIONS)["positions"]}
    labels = {row["id"]: row for row in read_json(LABELS)["rows"]}
    if set(positions) != set(labels):
        raise RuntimeError("positions/labels id mismatch")

    identity = checkpoint_identity()
    checkpoint = Checkpoint(checkpoint_path, identity)
    done = checkpoint.rows()
    ordered_ids = sorted(positions)  # 決定的な処理順(id文字列昇順)。
    total = len(ordered_ids)
    processed = 0
    for index, position_id in enumerate(ordered_ids, 1):
        if position_id in done:
            print(f"[verify] resume skip {index}/{total} {position_id}", flush=True)
            continue
        position = positions[position_id]
        label = labels[position_id]
        result = solve(position)
        score_match = result["completed"] and result["score"] == label["expectedScoreSideToMove"]
        if result["completed"]:
            if result["score"] > 0:
                actual_wld = "win"
            elif result["score"] < 0:
                actual_wld = "loss"
            else:
                actual_wld = "draw"
        else:
            actual_wld = None
        wld_match = result["completed"] and actual_wld == label["expectedWldSideToMove"]
        row = {
            "id": position_id,
            "category": position["category"],
            "expectedScoreSideToMove": label["expectedScoreSideToMove"],
            "expectedWldSideToMove": label["expectedWldSideToMove"],
            "nativeScore": result["score"],
            "nativeBound": result["bound"],
            "nativeCompleted": result["completed"],
            "nativeWld": actual_wld,
            "scoreMatch": score_match,
            "wldMatch": wld_match,
            "nodes": result["nodes"],
            "elapsedUs": result["elapsedUs"],
        }
        checkpoint.put(position_id, row)
        processed += 1
        print(
            f"[verify] saved {len(checkpoint.rows())}/{total} {position_id} "
            f"scoreMatch={score_match} wldMatch={wld_match} "
            f"nodes={result['nodes']} elapsedUs={result['elapsedUs']}",
            flush=True,
        )
        if stop_after is not None and processed >= stop_after:
            print("intentional checkpoint stop", flush=True)
            break

    if len(checkpoint.rows()) == total:
        print(f"verification complete: {total} positions", flush=True)


def write_report(checkpoint_path: Path, output: Path, allow_partial: bool) -> None:
    checkpoint = read_json(checkpoint_path)
    rows = list(checkpoint.get("rows", {}).values())
    positions = read_json(POSITIONS)["positions"]
    if not allow_partial and len(rows) != len(positions):
        raise RuntimeError(
            f"incomplete checkpoint: expected {len(positions)} rows, have {len(rows)}"
        )

    score_matches = sum(bool(row["scoreMatch"]) for row in rows)
    wld_matches = sum(bool(row["wldMatch"]) for row in rows)
    completed = sum(bool(row["nativeCompleted"]) for row in rows)
    mismatches = [row for row in rows if not row["scoreMatch"]]

    by_category = {}
    for row in rows:
        bucket = by_category.setdefault(
            row["category"], {"total": 0, "scoreMatches": 0, "wldMatches": 0}
        )
        bucket["total"] += 1
        bucket["scoreMatches"] += int(bool(row["scoreMatch"]))
        bucket["wldMatches"] += int(bool(row["wldMatch"]))

    summary = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "provenance": {
            **checkpoint["identity"],
            "platform": platform.platform(),
            "processor": platform.processor(),
        },
        "totalPositions": len(rows),
        "totalExpected": len(positions),
        "completed": completed,
        "scoreMatchRate": score_matches / len(rows) if rows else None,
        "wldMatchRate": wld_matches / len(rows) if rows else None,
        "byCategory": by_category,
        "mismatches": mismatches,
        "rows": sorted(rows, key=lambda row: row["id"]),
    }
    atomic_json(output, summary)
    print(f"wrote {output}: scoreMatchRate={summary['scoreMatchRate']} wldMatchRate={summary['wldMatchRate']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run/resume the exact-solve verification")
    run_parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    run_parser.add_argument("--stop-after", type=int, default=None)

    report_parser = subparsers.add_parser("report", help="aggregate a checkpoint into a summary")
    report_parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    report_parser.add_argument("--output", type=Path, default=DEFAULT_SUMMARY)
    report_parser.add_argument("--allow-partial", action="store_true")

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "run":
        run(args.checkpoint, args.stop_after)
    elif args.command == "report":
        write_report(args.checkpoint, args.output, args.allow_partial)


if __name__ == "__main__":
    main()

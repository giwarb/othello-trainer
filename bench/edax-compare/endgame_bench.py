#!/usr/bin/env python3
"""T098 endgame benchmark contract (C1/C2/C3) with atomic resume."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import statistics
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPARE = ROOT / "bench" / "edax-compare"
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
EDAX_DIR = COMPARE / "edax-extract"
EDAX_EXE = EDAX_DIR / "wEdax-x86-64.exe"
EDAX_EVAL = EDAX_DIR / "data" / "eval.dat"
T096 = COMPARE / "t096_oracle_positions.json"
POSITIONS = COMPARE / "endgame_positions.json"
FFO = ROOT / "bench" / "ffo_positions.json"
C3_POSITIONS = COMPARE / "t085_exact_positions.json"
C3_ORACLE = COMPARE / "t085_node_budget_calibration.json"
DEFAULT_WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"
DEFAULT_CHECKPOINT = COMPARE / "endgame-results" / "t098-checkpoint.json"
DEFAULT_REPORT = COMPARE / "endgame_baseline.json"
SOLVER_VERSION = "baseline-t052-alpha-beta-tt-v1"
NODE_DEFINITION_VERSION = "logical-negamax-invocation-v1"
EDAX_HASH_BITS_64_MIB = 22

EDAX_HEADING = re.compile(r"^\*\*\* problem # (\d+) \*\*\*$")
EDAX_ROW = re.compile(
    r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s+"
    r"(\d+):(\d+\.\d{3})\s+(\d+)(?:\s|$)"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def run(command: list[str], *, input_value: dict | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(
        command,
        input=json.dumps(input_value) if input_value is not None else None,
        cwd=cwd,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {command}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def ensure_tools(*, edax: bool = False) -> None:
    if not EVAL_CLI.exists():
        raise RuntimeError(f"missing {EVAL_CLI}; run cargo build --release -p engine --bin eval_cli")
    if edax and (not EDAX_EXE.exists() or not EDAX_EVAL.exists()):
        raise RuntimeError("Edax is unavailable; run bench/edax-compare/download-edax.ps1")


def position_for_cli(position: dict) -> dict:
    return {"board": position["board"], "side_to_move": position["side_to_move"]}


def solve_engine(position: dict, alpha: int, beta: int, max_nodes: int | None, tt_mb: int = 64) -> dict:
    command = [
        str(EVAL_CLI), "solve", "--alpha", str(alpha), "--beta", str(beta),
        "--tt-mb", str(tt_mb),
    ]
    if max_nodes is not None:
        command += ["--max-nodes", str(max_nodes)]
    value = json.loads(run(command, input_value=position_for_cli(position)).stdout)
    if value["solverVersion"] != SOLVER_VERSION:
        raise RuntimeError(f"unexpected solver version: {value['solverVersion']}")
    if value["nodeDefinitionVersion"] != NODE_DEFINITION_VERSION:
        raise RuntimeError(f"unexpected node definition: {value['nodeDefinitionVersion']}")
    return value


def best_engine(position: dict, weights: Path) -> dict:
    command = [
        str(EVAL_CLI), "best", "--depth", "10", "--exact-from-empties", "18",
        "--max-nodes", "160000", "--time-ms", "1500", "--tt-mb", "64",
        "--pattern-weights", str(weights),
    ]
    return json.loads(run(command, input_value=position_for_cli(position)).stdout)


def parse_edax_output(output: str, positions: list[dict]) -> list[dict]:
    lines = output.splitlines()
    headings = []
    for index, line in enumerate(lines):
        match = EDAX_HEADING.match(line.strip())
        if match:
            headings.append((int(match.group(1)), index))
    expected = list(range(1, len(positions) + 1))
    if [number for number, _ in headings] != expected:
        raise RuntimeError(f"Edax batch ordering mismatch: expected={expected}, headings={headings}")
    parsed = []
    for index, ((_, start), position) in enumerate(zip(headings, positions)):
        end = headings[index + 1][1] if index + 1 < len(headings) else len(lines)
        rows = [EDAX_ROW.match(line) for line in lines[start:end]]
        rows = [match for match in rows if match]
        if not rows:
            raise RuntimeError(f"no Edax search row for {position['id']}")
        row = rows[-1]
        elapsed = int(row.group(3)) * 60.0 + float(row.group(4))
        parsed.append({
            "id": position["id"],
            "score": int(row.group(2)),
            "elapsedSeconds": elapsed,
            "nodes": int(row.group(5)),
        })
    return parsed


def edax_batch(positions: list[dict]) -> list[dict]:
    if not positions:
        return []
    handle = tempfile.NamedTemporaryFile(
        dir=EDAX_DIR, prefix="_t098_batch_", suffix=".obf", delete=False,
        mode="w", encoding="ascii",
    )
    path = Path(handle.name)
    try:
        with handle:
            for position in positions:
                side = "X" if position["side_to_move"] == "black" else "O"
                handle.write(f"{position['board']} {side};\n")
        command = [
            str(EDAX_EXE), "-solve", str(path), "-l", "60", "-n", "1",
            "-h", str(EDAX_HASH_BITS_64_MIB), "-eval-file", str(EDAX_EVAL),
            "-book-usage", "off", "-vv",
        ]
        result = subprocess.run(command, cwd=EDAX_DIR, text=True, capture_output=True)
        return parse_edax_output(result.stdout, positions)
    finally:
        path.unlink(missing_ok=True)


class Checkpoint:
    def __init__(self, path: Path, identity: dict, *, allow_harness_mismatch: bool = False):
        self.path = path
        self.value = {"schemaVersion": 1, "identity": identity, "sections": {}}
        if path.exists():
            existing = read_json(path)
            existing_identity = existing.get("identity", {})
            differing = {
                key for key in set(existing_identity) | set(identity)
                if existing_identity.get(key) != identity.get(key)
            }
            if differing and not (allow_harness_mismatch and differing == {"harnessSha256"}):
                raise RuntimeError("checkpoint identity mismatch; refusing stale resume")
            self.value = existing

    def section(self, name: str) -> dict:
        return self.value.setdefault("sections", {}).setdefault(name, {})

    def put(self, section: str, key: str, value: dict) -> None:
        self.section(section)[key] = value
        atomic_json(self.path, self.value)


def execute_jobs(checkpoint: Checkpoint, section: str, jobs: list[dict], worker, stop_after: int | None) -> int:
    completed = checkpoint.section(section)
    processed = 0
    for index, job in enumerate(jobs, 1):
        key = job["key"]
        if key in completed:
            print(f"[{section}] resume skip {index}/{len(jobs)} {key}", flush=True)
            continue
        result = worker(job)
        checkpoint.put(section, key, result)
        processed += 1
        print(f"[{section}] saved {len(checkpoint.section(section))}/{len(jobs)} {key}", flush=True)
        if stop_after is not None and processed >= stop_after:
            print("intentional checkpoint stop", flush=True)
            break
    return processed


def checkpoint_identity(weights: Path) -> dict:
    return {
        "harnessSha256": sha256(Path(__file__)),
        "evalCliSha256": sha256(EVAL_CLI),
        "positionsSha256": sha256(POSITIONS),
        "ffoSha256": sha256(FFO),
        "c3PositionsSha256": sha256(C3_POSITIONS),
        "weightsSha256": sha256(weights),
        "solverVersion": SOLVER_VERSION,
        "nodeDefinitionVersion": NODE_DEFINITION_VERSION,
        "ttMiB": 64,
    }


def create_manifest(path: Path, batch_size: int, stop_after: int | None) -> None:
    ensure_tools(edax=True)
    source = read_json(T096)
    source_positions = source["positions"]
    existing_rows = {}
    verification = {"nativeFullWindow": []}
    if path.exists():
        existing = read_json(path)
        existing_rows = {row["id"]: row for row in existing.get("positions", [])}
        verification = existing.get("signConventionVerification", verification)
    pending = [position for position in source_positions if position["id"] not in existing_rows]
    processed = 0
    while pending:
        allowed = batch_size
        if stop_after is not None:
            allowed = min(allowed, stop_after - processed)
        if allowed <= 0:
            break
        batch = pending[:allowed]
        for result, position in zip(edax_batch(batch), batch):
            row = dict(position)
            row["exactScore"] = result["score"]
            row["scorePerspective"] = "side_to_move"
            existing_rows[row["id"]] = row
            processed += 1
            document = {
                "schemaVersion": 1,
                "purpose": "T098 C2 independent endgame benchmark truth manifest",
                "source": {
                    "path": "bench/edax-compare/t096_oracle_positions.json",
                    "sha256": sha256(T096),
                },
                "oracle": {
                    "engine": "Edax 4.6",
                    "level": 60,
                    "bookUsage": "off",
                    "tasks": 1,
                    "hashTableMiB": 64,
                    "hashBits": EDAX_HASH_BITS_64_MIB,
                    "scorePerspective": "side_to_move",
                },
                "positions": [existing_rows[p["id"]] for p in source_positions if p["id"] in existing_rows],
                "signConventionVerification": verification,
            }
            atomic_json(path, document)
            print(f"[manifest] saved {len(existing_rows)}/{len(source_positions)} {row['id']}", flush=True)
        pending = [position for position in source_positions if position["id"] not in existing_rows]
    if len(existing_rows) == len(source_positions):
        print(f"manifest complete: {len(existing_rows)} positions", flush=True)


def verify_manifest_sign(path: Path, count: int) -> None:
    ensure_tools()
    document = read_json(path)
    positions = sorted(document["positions"], key=lambda row: (row["empties"], row["id"]))[:count]
    verification = document.setdefault("signConventionVerification", {}).setdefault("nativeFullWindow", [])
    done = {row["id"] for row in verification}
    for index, position in enumerate(positions, 1):
        if position["id"] in done:
            print(f"[sign] resume skip {position['id']}", flush=True)
            continue
        result = solve_engine(position, -64, 64, None)
        if result["score"] != position["exactScore"] or result["bound"] != "exact":
            raise RuntimeError(
                f"sign verification failed for {position['id']}: "
                f"native={result['score']} Edax={position['exactScore']}"
            )
        verification.append({
            "id": position["id"], "empties": position["empties"],
            "nativeScore": result["score"], "edaxScore": position["exactScore"],
            "nodes": result["nodes"], "matched": True,
        })
        atomic_json(path, document)
        print(f"[sign] saved {index}/{len(positions)} {position['id']}", flush=True)


def c1_jobs(heavy_cap: int) -> list[dict]:
    positions = read_json(FFO)["positions"]
    return [
        {
            "key": f"ffo-{position['id']}",
            "position": position,
            "maxNodes": None if position["id"] <= 44 else heavy_cap,
        }
        for position in positions if 40 <= position["id"] <= 49
    ]


def run_c1(checkpoint: Checkpoint, heavy_cap: int, stop_after: int | None) -> None:
    def worker(job: dict) -> dict:
        position = job["position"]
        result = solve_engine(position, -64, 64, job["maxNodes"])
        correct = result["score"] == position["expected_score"] if result["completed"] else None
        if correct is False:
            raise RuntimeError(f"FFO #{position['id']} score mismatch")
        return {
            "id": position["id"], "empties": position["board"].count("-"),
            "expectedScore": position["expected_score"], "maxNodes": job["maxNodes"],
            "correct": correct, "run": result,
        }

    execute_jobs(checkpoint, "c1", c1_jobs(heavy_cap), worker, stop_after)


def c2_jobs() -> list[dict]:
    jobs = []
    for position in read_json(POSITIONS)["positions"]:
        score = position["exactScore"]
        for budget in (64000, 160000, 512000):
            for window, alpha, beta in (
                ("fail_high", score - 1, score),
                ("fail_low", score, score + 1),
                ("full", -64, 64),
            ):
                jobs.append({
                    "key": f"{position['id']}:{budget}:{window}",
                    "position": position, "budget": budget, "window": window,
                    "alpha": alpha, "beta": beta,
                })
    return jobs


def run_c2(checkpoint: Checkpoint, stop_after: int | None) -> None:
    def worker(job: dict) -> dict:
        result = solve_engine(
            job["position"], job["alpha"], job["beta"], job["budget"]
        )
        expected_bound = {"fail_high": "lower", "fail_low": "upper", "full": "exact"}[job["window"]]
        if result["completed"] and result["bound"] != expected_bound:
            raise RuntimeError(
                f"wrong bound for {job['key']}: {result['bound']} != {expected_bound}"
            )
        return {
            "id": job["position"]["id"], "empties": job["position"]["empties"],
            "oracleScore": job["position"]["exactScore"], "budget": job["budget"],
            "windowKind": job["window"], "expectedBound": expected_bound, "run": result,
        }

    execute_jobs(checkpoint, "c2", c2_jobs(), worker, stop_after)


def deterministic_identity(result: dict) -> dict:
    ignored = {"elapsedMs", "nps"}
    return {key: value for key, value in result.items() if key not in ignored}


def run_c3(checkpoint: Checkpoint, weights: Path, stop_after: int | None) -> None:
    positions = read_json(C3_POSITIONS)["positions"]
    oracle = read_json(C3_ORACLE)["oracle"]
    jobs = [{"key": position["id"], "position": position} for position in positions]

    def worker(job: dict) -> dict:
        position = job["position"]
        first = best_engine(position, weights)
        second = best_engine(position, weights)
        same = deterministic_identity(first) == deterministic_identity(second)
        selected = first.get("move")
        truth = oracle[position["id"]]
        if selected not in truth["childValues"]:
            raise RuntimeError(f"C3 returned illegal/unscored move {selected!r} for {position['id']}")
        regret = truth["bestValue"] - truth["childValues"][selected]
        wall = bool(first.get("wallLimitHit") and not first.get("nodeLimitHit"))
        wall = wall or bool(second.get("wallLimitHit") and not second.get("nodeLimitHit"))
        return {
            "id": position["id"], "empties": position["board"].count("-"),
            "oracleMove": truth["bestMove"], "oracleValue": truth["bestValue"],
            "selectedMove": selected, "selectedValue": truth["childValues"][selected],
            "oracleRegret": regret, "deterministic": same,
            "wallInsuranceFired": wall, "run1": first, "run2": second,
        }

    execute_jobs(checkpoint, "c3", jobs, worker, stop_after)


def speed_positions() -> list[dict]:
    return [
        position for position in read_json(POSITIONS)["positions"]
        if 20 <= position["empties"] <= 24
    ]


def run_speed(checkpoint: Checkpoint, repetitions: int, stop_after: int | None) -> None:
    if repetitions < 1:
        raise ValueError("speed measurement requires at least one repetition")
    ensure_tools(edax=True)
    positions = speed_positions()
    if not positions:
        raise RuntimeError("no speed positions in empties 20..24")
    warmup = checkpoint.section("speed_warmup")
    if "complete" not in warmup:
        warmup_position = min(read_json(POSITIONS)["positions"], key=lambda row: (row["empties"], row["id"]))
        engine = solve_engine(warmup_position, -64, 64, None)
        edax = edax_batch([warmup_position])[0]
        checkpoint.put("speed_warmup", "complete", {"engine": engine, "edax": edax})
        print("[speed] warmup complete", flush=True)

    processed = 0
    for repetition in range(repetitions):
        ordered = positions if repetition % 2 == 0 else list(reversed(positions))
        engines_first = repetition % 2 == 1

        def engine_pass() -> bool:
            nonlocal processed
            for position in ordered:
                key = f"engine:{repetition}:{position['id']}"
                if key in checkpoint.section("speed"):
                    print(f"[speed] resume skip {key}", flush=True)
                    continue
                result = solve_engine(position, -64, 64, None)
                if result["score"] != position["exactScore"]:
                    raise RuntimeError(f"native speed score mismatch for {position['id']}")
                checkpoint.put("speed", key, {
                    "implementation": "engine", "repetition": repetition,
                    "id": position["id"], "empties": position["empties"], "run": result,
                })
                processed += 1
                print(f"[speed] saved {key}", flush=True)
                if stop_after is not None and processed >= stop_after:
                    return False
            return True

        def edax_pass() -> bool:
            nonlocal processed
            pending = [
                position for position in ordered
                if f"edax:{repetition}:{position['id']}" not in checkpoint.section("speed")
            ]
            if not pending:
                return True
            results = edax_batch(pending)
            for position, result in zip(pending, results):
                if result["score"] != position["exactScore"]:
                    raise RuntimeError(f"Edax speed score mismatch for {position['id']}")
                key = f"edax:{repetition}:{position['id']}"
                checkpoint.put("speed", key, {
                    "implementation": "edax", "repetition": repetition,
                    "id": position["id"], "empties": position["empties"], "run": result,
                })
                processed += 1
                print(f"[speed] saved {key}", flush=True)
                if stop_after is not None and processed >= stop_after:
                    return False
            return True

        passes = (engine_pass, edax_pass) if engines_first else (edax_pass, engine_pass)
        for operation in passes:
            if not operation():
                print("intentional checkpoint stop", flush=True)
                return


def completion_rate(rows: list[dict]) -> float | None:
    return sum(bool(row["run"]["completed"]) for row in rows) / len(rows) if rows else None


def percentile90(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[math.ceil(0.9 * len(ordered)) - 1]


def e50(rows: list[dict], budget: int, exact: bool) -> int | None:
    relevant = [row for row in rows if row["budget"] == budget]
    by_position = {}
    for row in relevant:
        by_position.setdefault(row["id"], {})[row["windowKind"]] = row
    by_empties = {}
    for position_rows in by_position.values():
        if "fail_high" not in position_rows or "fail_low" not in position_rows:
            continue
        high = position_rows["fail_high"]["run"]
        low = position_rows["fail_low"]["run"]
        if exact:
            solved = high["completed"] and low["completed"] and high["nodes"] + low["nodes"] <= budget
        else:
            solved = high["completed"] or low["completed"]
        empties = position_rows["fail_high"]["empties"]
        by_empties.setdefault(empties, []).append(bool(solved))
    eligible = [
        empties for empties, values in by_empties.items()
        if values and sum(values) / len(values) >= 0.5
    ]
    return max(eligible) if eligible else None


def aggregate(checkpoint: Checkpoint) -> dict:
    sections = checkpoint.value.get("sections", {})
    c1 = list(sections.get("c1", {}).values())
    c2 = list(sections.get("c2", {}).values())
    c3 = list(sections.get("c3", {}).values())
    speed = list(sections.get("speed", {}).values())

    c2_rates = []
    for budget in (64000, 160000, 512000):
        for window in ("fail_high", "fail_low", "full"):
            group = [row for row in c2 if row["budget"] == budget and row["windowKind"] == window]
            c2_rates.append({
                "budget": budget, "windowKind": window, "completed": sum(row["run"]["completed"] for row in group),
                "total": len(group), "completionRate": completion_rate(group),
            })

    expected_speed_ids = {position["id"] for position in speed_positions()}
    speed_ids_by_run = {}
    for row in speed:
        key = (row["repetition"], row["implementation"])
        speed_ids_by_run.setdefault(key, set()).add(row["id"])
    repetitions = sorted({row["repetition"] for row in speed})
    complete_repetitions = [
        repetition for repetition in repetitions
        if speed_ids_by_run.get((repetition, "engine"), set()) == expected_speed_ids
        and speed_ids_by_run.get((repetition, "edax"), set()) == expected_speed_ids
    ]
    partial_repetitions = [
        repetition for repetition in repetitions if repetition not in complete_repetitions
    ]
    accepted_speed = [row for row in speed if row["repetition"] in complete_repetitions]

    speed_by_position = {}
    for row in accepted_speed:
        speed_by_position.setdefault(row["id"], {}).setdefault(row["implementation"], []).append(row)
    ratios = []
    speed_rows = []
    for position_id, implementations in sorted(speed_by_position.items()):
        engine_rows = implementations.get("engine", [])
        edax_rows = implementations.get("edax", [])
        if not engine_rows or not edax_rows:
            continue
        engine_seconds = statistics.median(row["run"]["elapsedUs"] / 1_000_000 for row in engine_rows)
        edax_seconds = statistics.median(row["run"]["elapsedSeconds"] for row in edax_rows)
        ratio = engine_seconds / edax_seconds if edax_seconds > 0 else None
        speed_rows.append({
            "id": position_id, "empties": engine_rows[0]["empties"],
            "engineMedianSeconds": engine_seconds, "edaxMedianSeconds": edax_seconds,
            "ratio": ratio,
        })
        if ratio is not None and ratio > 0:
            ratios.append(ratio)

    mean_regret = sum(row["oracleRegret"] for row in c3) / len(c3) if c3 else None
    deterministic_rate = sum(row["deterministic"] for row in c3) / len(c3) if c3 else None
    wall_rate = sum(row["wallInsuranceFired"] for row in c3) / len(c3) if c3 else None
    minimum_c2_empties = min((row["empties"] for row in c2), default=None)
    return {
        "c1": {
            "completed": sum(row["run"]["completed"] for row in c1), "total": len(c1),
            "correctCompleted": sum(row["correct"] is True for row in c1), "rows": c1,
        },
        "c2": {
            "rates": c2_rates,
            "E50Exact160k": e50(c2, 160000, True),
            "E50Bound64k": e50(c2, 64000, False),
            "nullE50MeansBelowCorpusMinimum": minimum_c2_empties,
            "rowsCompleted": len(c2), "rowsExpected": 60 * 3 * 3,
        },
        "c3": {
            "meanOracleRegret": mean_regret, "deterministicRate": deterministic_rate,
            "wallInsuranceRate": wall_rate, "rowsCompleted": len(c3), "rowsExpected": 48,
        },
        "speed20To24": {
            "positionRows": speed_rows,
            "geometricMeanRatio": math.exp(sum(math.log(value) for value in ratios) / len(ratios)) if ratios else None,
            "p90Ratio": percentile90(ratios), "completedPositions": len(ratios),
            "corpus": "C2 independent positions with 20..24 empties",
            "completeRepetitionsUsed": complete_repetitions,
            "partialRepetitionsExcluded": partial_repetitions,
            "repetitionCountUsed": len(complete_repetitions),
            "protocol": (
                "native and Edax internal wall time; one warmup; per-position median; "
                "T098 2026-07-15 waiver permits completed repetitions (minimum one); "
                "partial repetitions are excluded; full warmup+3 alternating-order protocol deferred to T108"
            ),
        },
    }


def write_report(checkpoint: Checkpoint, output: Path) -> None:
    manifest = read_json(POSITIONS)
    report = {
        "schemaVersion": 1,
        "title": "T098 endgame solver baseline",
        "generatedAt": utc_now(),
        "status": "baseline",
        "contract": {
            "C1": "FFO #40-49 full window; #45-49 may use a recorded node cap",
            "C2": "60 independent positions; fail-high [S-1,S], fail-low [S,S+1], full [-64,64]",
            "C3": "eval_cli best --max-nodes 160000 --time-ms 1500 --tt-mb 64",
            "E50Bound": "largest empties where >=50% complete at least one standard proof window",
            "E50Exact": "largest empties where >=50% complete both proofs with summed nodes <= budget",
        },
        "provenance": {
            **checkpoint.value["identity"],
            "reportHarnessSha256": sha256(Path(__file__)),
            "platform": platform.platform(),
            "processor": platform.processor(),
            "edaxSha256": sha256(EDAX_EXE) if EDAX_EXE.exists() else None,
            "edaxEvalSha256": sha256(EDAX_EVAL) if EDAX_EVAL.exists() else None,
            "manifestSha256": sha256(POSITIONS),
        },
        "signConventionVerification": manifest.get("signConventionVerification"),
        "summary": aggregate(checkpoint),
    }
    atomic_json(output, report)
    print(f"wrote {output}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    manifest = subparsers.add_parser("manifest", help="generate/resume the Edax truth manifest")
    manifest.add_argument("--output", type=Path, default=POSITIONS)
    manifest.add_argument("--batch-size", type=int, default=10)
    manifest.add_argument("--stop-after", type=int)

    verify = subparsers.add_parser("verify-sign", help="cross-check Edax side-to-move scores with native full-window solves")
    verify.add_argument("--manifest", type=Path, default=POSITIONS)
    verify.add_argument("--count", type=int, default=3)

    benchmark = subparsers.add_parser("run", help="run/resume one or more benchmark suites")
    benchmark.add_argument("--suite", choices=("c1", "c2", "c3", "speed", "all"), default="all")
    benchmark.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    benchmark.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    benchmark.add_argument("--heavy-cap", type=int, default=5_000_000)
    benchmark.add_argument("--repetitions", type=int, default=3)
    benchmark.add_argument("--stop-after", type=int)

    report = subparsers.add_parser("report", help="aggregate a completed checkpoint")
    report.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    report.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    report.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "manifest":
        if args.batch_size <= 0:
            raise ValueError("--batch-size must be positive")
        create_manifest(args.output, args.batch_size, args.stop_after)
        return
    if args.command == "verify-sign":
        verify_manifest_sign(args.manifest, args.count)
        return

    ensure_tools(edax=args.command == "run" and args.suite in ("speed", "all"))
    if not POSITIONS.exists() or len(read_json(POSITIONS).get("positions", [])) != 60:
        raise RuntimeError("endgame_positions.json is incomplete; run the manifest command first")
    identity = checkpoint_identity(args.weights)
    checkpoint = Checkpoint(
        args.checkpoint,
        identity,
        allow_harness_mismatch=args.command == "report",
    )
    if args.command == "report":
        write_report(checkpoint, args.output)
        return

    suites = ("c1", "c2", "c3", "speed") if args.suite == "all" else (args.suite,)
    for suite in suites:
        if suite == "c1":
            run_c1(checkpoint, args.heavy_cap, args.stop_after)
        elif suite == "c2":
            run_c2(checkpoint, args.stop_after)
        elif suite == "c3":
            run_c3(checkpoint, args.weights, args.stop_after)
        else:
            run_speed(checkpoint, args.repetitions, args.stop_after)


if __name__ == "__main__":
    main()

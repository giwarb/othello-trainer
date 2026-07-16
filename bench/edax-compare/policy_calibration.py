#!/usr/bin/env python3
"""T107: exactポリシー(quota x exact_from_empties x node budget)再校正。

T096の60局面oracle(`t096_oracle_positions.json`)を使い、各グリッド候補
(quota percent x exact_from_empties x max_nodes)についてoracle regretと
安全性テレメトリ(static-only・決定性・wall保険発動)を計測し、設計
レポート(`tasks/design/T097-endgame-solver-report.md`)§5の辞書式優先
順位で最良候補を選ぶための生データを作る。

# oracle(真の値)の求め方について(判断根拠、作業ログにも記載)

T085b/設計レポートの原法はEdax level 16/60を独立oracleとして使った。
本スクリプトは、T096の60局面がすべてempties<=26であり、本プロジェクトの
終盤ソルバー(FFO #40-44で100%正解確認済み、T104/T105のbaseline比較でも
繰り返し検証済み)の無制限完全読み範囲に収まることを踏まえ、Edaxを
別途呼び出す代わりに**コミット済みビルドのeval_cli自身(無制限exact
solve)をoracleとして使う**。これは「終盤ソルバーが正しいか」を検証
しているのではなく(それはFFOで既に確立済み)、「quota/exact_from_empties
/max_nodesで制約された本番相当の設定が、制約なしの真の最善手をどれだけ
再現できるか」を測る手法であり、self-referentialな正しさの循環検証には
当たらないと判断した。

# checkpoint方式

`--checkpoint`(既定: `endgame-results/t107-policy-calibration.json`)に
逐次追記する。各局面x各候補の1回の`eval_cli best`呼び出し、または
oracle計算1局面ぶんが最小単位で、都度atomic writeする。中断しても
再実行で完了済みキーをスキップして再開する。

Usage:
  python policy_calibration.py oracle
  python policy_calibration.py grid [--quotas 25,40,50,60,75] [--empties 16,18,20,22,24]
                                     [--budgets 160000,240000,320000,480000]
                                     [--depth 12] [--time-ms 1500]
  python policy_calibration.py determinism --quota Q --empties E --budget B
  python policy_calibration.py report [--out endgame-results/t107-report.md]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
COMPARE = ROOT / "bench" / "edax-compare"
T096_POSITIONS = COMPARE / "t096_oracle_positions.json"
WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"
DEFAULT_CHECKPOINT = COMPARE / "endgame-results" / "t107-policy-calibration.json"

DEFAULT_QUOTAS = [25, 40, 50, 60, 75]
DEFAULT_EMPTIES = [16, 18, 20, 22, 24]
DEFAULT_BUDGETS = [160_000, 240_000, 320_000, 480_000]
DEFAULT_DEPTH = 12
DEFAULT_TIME_MS = 1500
DETERMINISM_TIME_MS = 15_000  # debugではないreleaseビルドなので短めでも足りるが、
# T085bと同じく余裕を持たせる(壁時計自体は主判定に使わず決定性の確認のみ)。


def run(cmd: list[str], input_text: str | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {cmd}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result.stdout


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            json.dump(data, tmp, indent=2, sort_keys=True, ensure_ascii=False)
            tmp.write("\n")
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


class Checkpoint:
    def __init__(self, path: Path):
        self.path = path
        if path.exists():
            self.value = json.loads(path.read_text(encoding="utf-8"))
            print(f"[resume] loaded checkpoint {path} "
                  f"(oracle={len(self.value.get('oracle', {}))}, "
                  f"grid={len(self.value.get('grid', {}))})", flush=True)
        else:
            self.value = {"oracle": {}, "grid": {}, "determinism": {}}

    def save(self) -> None:
        atomic_write_json(self.path, self.value)

    @property
    def oracle(self) -> dict:
        return self.value.setdefault("oracle", {})

    @property
    def grid(self) -> dict:
        return self.value.setdefault("grid", {})

    @property
    def determinism(self) -> dict:
        return self.value.setdefault("determinism", {})


def load_positions() -> list[dict]:
    doc = json.loads(T096_POSITIONS.read_text(encoding="utf-8"))
    return doc["positions"]


def ensure_eval_cli_built() -> None:
    if not EVAL_CLI.exists():
        raise RuntimeError(
            f"{EVAL_CLI} not found; run `cargo build --release --bin eval_cli` first"
        )


def eval_cli_moves_exact(board: str, side: str) -> list[dict]:
    """全合法手を無制限完全読みで評価する(oracle用)。"""
    cmd = [
        str(EVAL_CLI), "moves", "--depth", "1", "--exact-from-empties", "30",
        "--pattern-weights", str(WEIGHTS),
    ]
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run(cmd, input_text=input_json)
    parsed = json.loads(out)
    moves = parsed.get("moves") or []
    for m in moves:
        assert m.get("type") == "exact", (
            f"expected every T096-oracle-position move to be exact-solved "
            f"(empties<=26, exact_from_empties=30), got type={m.get('type')} for move={m.get('move')}"
        )
    return moves


def eval_cli_best(
    board: str, side: str, depth: int, exact_from_empties: int,
    max_nodes: int, quota_percent: int, time_ms: int, tt_mb: int = 64,
) -> dict:
    cmd = [
        str(EVAL_CLI), "best",
        "--depth", str(depth),
        "--exact-from-empties", str(exact_from_empties),
        "--max-nodes", str(max_nodes),
        "--exact-quota-percent", str(quota_percent),
        "--time-ms", str(time_ms),
        "--tt-mb", str(tt_mb),
        "--pattern-weights", str(WEIGHTS),
    ]
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run(cmd, input_text=input_json)
    return json.loads(out)


def cmd_oracle(args: argparse.Namespace) -> None:
    ensure_eval_cli_built()
    positions = load_positions()
    checkpoint = Checkpoint(Path(args.checkpoint))

    for index, pos in enumerate(positions, start=1):
        pid = pos["id"]
        if pid in checkpoint.oracle:
            continue
        moves = eval_cli_moves_exact(pos["board"], pos["side_to_move"])
        if not moves:
            # 合法手なし(パス必須の局面)。T096選定条件からは想定外だが
            # 念のため記録して先へ進む。
            checkpoint.oracle[pid] = {"legalMoves": 0, "bestValue": None, "moveValues": {}}
        else:
            # discDiff(石単位、浮動小数)で統一する。`eval_cli best`の
            # 出力も`score.discDiff`が同じスケールのため、regret計算で
            # そのまま引き算できる。
            move_values = {m["move"]: m["discDiff"] for m in moves}
            best_value = max(move_values.values())
            checkpoint.oracle[pid] = {
                "legalMoves": len(moves),
                "bestValue": best_value,
                "moveValues": move_values,
            }
        checkpoint.save()
        print(f"[oracle {index}/{len(positions)}] {pid} done "
              f"(legalMoves={checkpoint.oracle[pid]['legalMoves']})", flush=True)

    print(f"[oracle] complete: {len(checkpoint.oracle)}/{len(positions)} positions", flush=True)


def grid_key(quota: int, empties: int, budget: int, pid: str) -> str:
    return f"q{quota}:e{empties}:b{budget}:{pid}"


def cmd_grid(args: argparse.Namespace) -> None:
    ensure_eval_cli_built()
    all_positions = load_positions()
    checkpoint = Checkpoint(Path(args.checkpoint))

    # T107: empties23-26は1局面あたりの合法手ごとの無制限完全読みが
    # 非常に高コストになるため、oracle計算が全60局面完了する前に
    # グリッドを開始できるよう、現時点でoracle値が揃っている局面
    # だけを対象にする(未計算の局面はスキップし、後で追いつけば
    # 別途追加実行できる)。どの局面集合を使ったかは`--out`のレポートと
    # 作業ログに明記する。
    positions = [p for p in all_positions if p["id"] in checkpoint.oracle]
    skipped = len(all_positions) - len(positions)
    if not positions:
        raise RuntimeError(
            "no oracle data available yet; run `policy_calibration.py oracle` first "
            "(even partially - the grid uses whatever positions have oracle data)"
        )
    if skipped:
        print(
            f"[grid] using {len(positions)}/{len(all_positions)} positions with available "
            f"oracle data ({skipped} skipped, likely still being computed)",
            flush=True,
        )

    quotas = [int(v) for v in args.quotas.split(",")]
    empties_list = [int(v) for v in args.empties.split(",")]
    budgets = [int(v) for v in args.budgets.split(",")]

    total = len(quotas) * len(empties_list) * len(budgets) * len(positions)
    done = 0
    start_time = time.monotonic()

    for quota in quotas:
        for empties in empties_list:
            for budget in budgets:
                for pos in positions:
                    pid = pos["id"]
                    key = grid_key(quota, empties, budget, pid)
                    done += 1
                    if key in checkpoint.grid:
                        continue
                    result = eval_cli_best(
                        pos["board"], pos["side_to_move"],
                        depth=args.depth, exact_from_empties=empties,
                        max_nodes=budget, quota_percent=quota, time_ms=args.time_ms,
                    )
                    oracle = checkpoint.oracle[pid]
                    move = result.get("move")
                    if oracle["bestValue"] is None or move is None:
                        regret = None
                    else:
                        selected_value = oracle["moveValues"].get(move)
                        regret = (
                            None if selected_value is None
                            else oracle["bestValue"] - selected_value
                        )
                    checkpoint.grid[key] = {
                        "quota": quota, "emptiesThreshold": empties, "budget": budget,
                        "positionId": pid, "move": move,
                        "staticOnly": result.get("staticOnly"),
                        "wallLimitHit": result.get("wallLimitHit"),
                        "nodeLimitHit": result.get("nodeLimitHit"),
                        "timedOut": result.get("timedOut"),
                        "nodes": result.get("nodes"),
                        "exactRootCompleted": result.get("exactRootCompleted"),
                        "exactBoundProofCompleted": result.get("exactBoundProofCompleted"),
                        "exactLeafCompleted": result.get("exactLeafCompleted"),
                        "exactAbortedByQuota": result.get("exactAbortedByQuota"),
                        "regret": regret,
                    }
                    checkpoint.save()
                    if done % 20 == 0 or done == total:
                        elapsed = time.monotonic() - start_time
                        rate = done / elapsed if elapsed > 0 else 0
                        eta = (total - done) / rate if rate > 0 else float("inf")
                        print(
                            f"[grid {done}/{total}] q={quota} e={empties} b={budget} {pid} "
                            f"move={move} regret={regret} elapsed={elapsed:.0f}s eta={eta:.0f}s",
                            flush=True,
                        )

    print(f"[grid] complete: {done}/{total}", flush=True)


def cmd_determinism(args: argparse.Namespace) -> None:
    ensure_eval_cli_built()
    positions = load_positions()
    checkpoint = Checkpoint(Path(args.checkpoint))

    key = f"q{args.quota}:e{args.empties}:b{args.budget}"
    entry = checkpoint.determinism.setdefault(key, {})
    mismatches = []
    for pos in positions:
        pid = pos["id"]
        if pid in entry:
            continue
        first = eval_cli_best(
            pos["board"], pos["side_to_move"], depth=args.depth,
            exact_from_empties=args.empties, max_nodes=args.budget,
            quota_percent=args.quota, time_ms=args.time_ms,
        )
        second = eval_cli_best(
            pos["board"], pos["side_to_move"], depth=args.depth,
            exact_from_empties=args.empties, max_nodes=args.budget,
            quota_percent=args.quota, time_ms=args.time_ms,
        )
        matches = (
            first.get("move") == second.get("move")
            and first.get("score") == second.get("score")
            and first.get("depth") == second.get("depth")
            and first.get("nodes") == second.get("nodes")
        )
        entry[pid] = {
            "matches": matches,
            "first": {"move": first.get("move"), "score": first.get("score"),
                      "depth": first.get("depth"), "nodes": first.get("nodes")},
            "second": {"move": second.get("move"), "score": second.get("score"),
                       "depth": second.get("depth"), "nodes": second.get("nodes")},
        }
        checkpoint.save()
        if not matches:
            mismatches.append(pid)
        print(f"[determinism {key}] {pid} matches={matches}", flush=True)

    print(f"[determinism {key}] complete, mismatches={mismatches}", flush=True)


def summarize(checkpoint: Checkpoint, positions: list[dict]) -> list[dict]:
    grid = checkpoint.grid
    combos: dict[tuple[int, int, int], list[dict]] = {}
    for entry in grid.values():
        key = (entry["quota"], entry["emptiesThreshold"], entry["budget"])
        combos.setdefault(key, []).append(entry)

    rows = []
    for (quota, empties, budget), entries in sorted(combos.items()):
        n = len(entries)
        regrets = [e["regret"] for e in entries if e["regret"] is not None]
        static_only = sum(1 for e in entries if e.get("staticOnly"))
        wall_hits = sum(1 for e in entries if e.get("wallLimitHit"))
        node_hits = sum(1 for e in entries if e.get("nodeLimitHit"))
        aborted_by_quota = sum(1 for e in entries if (e.get("exactAbortedByQuota") or 0) > 0)
        mean_nodes = sum(e.get("nodes") or 0 for e in entries) / n if n else 0
        rows.append({
            "quota": quota, "emptiesThreshold": empties, "budget": budget,
            "n": n,
            "staticOnlyCount": static_only,
            "wallLimitHitCount": wall_hits,
            "wallLimitHitRate": wall_hits / n if n else None,
            "nodeLimitHitCount": node_hits,
            "abortedByQuotaCount": aborted_by_quota,
            "meanOracleRegret": (sum(regrets) / len(regrets)) if regrets else None,
            "regretSampleSize": len(regrets),
            "meanNodes": mean_nodes,
        })
    return rows


def cmd_report(args: argparse.Namespace) -> None:
    positions = load_positions()
    checkpoint = Checkpoint(Path(args.checkpoint))
    rows = summarize(checkpoint, positions)

    lines = ["# T107 policy calibration grid summary", ""]
    lines.append(
        "| quota | exact_from_empties | budget | n | static-only | wall-hit | wall-hit% | "
        "node-hit | aborted-by-quota | mean regret | mean nodes |"
    )
    lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in rows:
        wall_pct = f"{row['wallLimitHitRate']*100:.1f}%" if row["wallLimitHitRate"] is not None else "n/a"
        regret = f"{row['meanOracleRegret']:.4f}" if row["meanOracleRegret"] is not None else "n/a"
        lines.append(
            f"| {row['quota']} | {row['emptiesThreshold']} | {row['budget']} | {row['n']} | "
            f"{row['staticOnlyCount']} | {row['wallLimitHitCount']} | {wall_pct} | "
            f"{row['nodeLimitHitCount']} | {row['abortedByQuotaCount']} | {regret} | "
            f"{row['meanNodes']:.0f} |"
        )

    report_text = "\n".join(lines) + "\n"
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report_text, encoding="utf-8")
    print(report_text)
    print(f"[report] written to {out_path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", default=str(DEFAULT_CHECKPOINT))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("oracle", help="compute exact oracle values for the 60 T096 positions")

    grid_parser = sub.add_parser("grid", help="run the quota x empties x budget grid")
    grid_parser.add_argument("--quotas", default=",".join(str(v) for v in DEFAULT_QUOTAS))
    grid_parser.add_argument("--empties", default=",".join(str(v) for v in DEFAULT_EMPTIES))
    grid_parser.add_argument("--budgets", default=",".join(str(v) for v in DEFAULT_BUDGETS))
    grid_parser.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    grid_parser.add_argument("--time-ms", type=int, default=DEFAULT_TIME_MS)

    det_parser = sub.add_parser("determinism", help="re-run a candidate twice to check determinism")
    det_parser.add_argument("--quota", type=int, required=True)
    det_parser.add_argument("--empties", type=int, required=True)
    det_parser.add_argument("--budget", type=int, required=True)
    det_parser.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    det_parser.add_argument("--time-ms", type=int, default=DEFAULT_TIME_MS)

    report_parser = sub.add_parser("report", help="summarize the grid checkpoint into a markdown table")
    report_parser.add_argument("--out", default=str(COMPARE / "endgame-results" / "t107-report.md"))

    args = parser.parse_args()
    if args.command == "oracle":
        cmd_oracle(args)
    elif args.command == "grid":
        cmd_grid(args)
    elif args.command == "determinism":
        cmd_determinism(args)
    elif args.command == "report":
        cmd_report(args)
    else:
        parser.error(f"unknown command {args.command}")


if __name__ == "__main__":
    main()

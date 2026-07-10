#!/usr/bin/env python3
"""T048: MPC(Multi-ProbCut)有効/無効での自己対戦による棋力比較。

`bench/edax-compare/selfplay.py`(T024)・`selfplay_pattern_eval.py`(T043/T044)
と同じ設計(`eval_cli moves`の最上位手を選び続ける、開始局面を複数用意して
先後入れ替えで対局)を踏襲するが、比較対象が「同じ`eval_cli`バイナリを
MPC有効/無効のどちらのCargoフィーチャでビルドしたか」という違いになる
(MPCは`engine/Cargo.toml`の`mpc_enabled`フィーチャによるコンパイル時
切り替えのため、実行時フラグではなく2つの別バイナリを用意する必要がある。
既定(フィーチャなし)ではMPCは無効。実測の結果ノード数・到達深さの
いずれも改善しなかったため、既定を無効にしている。`engine/src/mpc.rs`
冒頭のドキュメント・T048作業ログ参照)。

両者とも同じパターン評価v2の重み(`train/weights/pattern_v2.bin`、本番の
`Engine`が実際に使う評価関数と同じもの)を使う(重みの違いではなく、MPCの
有無だけを比較したいため)。

事前準備(リポジトリルートから):
    cargo build --release -p engine --bin eval_cli --features mpc_enabled
    cp target/release/eval_cli.exe bench/edax-compare/eval_cli_mpc_on.exe
    cargo build --release -p engine --bin eval_cli
    cp target/release/eval_cli.exe bench/edax-compare/eval_cli_mpc_off.exe

使い方:
    python bench/edax-compare/selfplay_mpc.py --starts 12 --depth 8
"""

from __future__ import annotations

import argparse
import functools
import json
import subprocess
import sys
from pathlib import Path

print = functools.partial(print, flush=True)

ROOT = Path(__file__).resolve().parents[2]
COMPARE_DIR = Path(__file__).resolve().parent
MPC_ON_EXE = COMPARE_DIR / "eval_cli_mpc_on.exe"
MPC_OFF_EXE = COMPARE_DIR / "eval_cli_mpc_off.exe"
DEFAULT_PATTERN_WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"


def run(cmd: list[str], input_text: str | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstderr={result.stderr}")
    return result.stdout


def best_move(exe: Path, weights_path: Path, board: str, side: str, depth: int) -> dict | None:
    input_json = json.dumps({"board": board, "side_to_move": side})
    cmd = [
        str(exe),
        "moves",
        "--depth",
        str(depth),
        "--exact-from-empties",
        "0",
        "--pattern-weights",
        str(weights_path),
    ]
    out = run(cmd, input_text=input_json)
    moves = json.loads(out)["moves"]
    if not moves:
        return None
    return max(moves, key=lambda m: m["score"])


def apply_move(exe: Path, board: str, side: str, move: str) -> dict:
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run([str(exe), "apply", "--move", move], input_text=input_json)
    return json.loads(out)


def count_discs(board: str) -> tuple[int, int]:
    return board.count("X"), board.count("O")


def gen_start_positions(count: int, seed: int, min_empties: int = 44, max_empties: int = 50) -> list[dict]:
    """多様な開始局面を生成する(`selfplay.py`と同じ理由: 両エンジンとも探索は
    決定的なので、開始局面を複数用意しないと意味のあるサンプル数にならない)。"""
    out = run(
        [
            str(MPC_ON_EXE),
            "gen",
            "--category",
            "selfplay-mpc-start",
            "--min-empties",
            str(min_empties),
            "--max-empties",
            str(max_empties),
            "--count",
            str(count),
            "--seed",
            str(seed),
        ]
    )
    return json.loads(out)


def play_game(
    mpc_is_black: bool,
    weights_path: Path,
    depth: int,
    start_board: str,
    start_side: str,
    max_plies: int = 200,
) -> tuple[int, int]:
    """指定した開始局面から1局対局し、(黒石数, 白石数)を返す。"""
    board = start_board
    side = start_side
    exes = {"black": MPC_ON_EXE if mpc_is_black else MPC_OFF_EXE, "white": MPC_OFF_EXE if mpc_is_black else MPC_ON_EXE}
    consecutive_no_move = 0
    plies = 0
    while consecutive_no_move < 2 and plies < max_plies:
        mv = best_move(exes[side], weights_path, board, side, depth)
        if mv is None:
            consecutive_no_move += 1
            side = "white" if side == "black" else "black"
            continue
        consecutive_no_move = 0
        # `apply`は探索を行わないただの着手適用なので、どちらのバイナリを
        # 使っても結果は同じ(MPC_ON_EXEで統一する)。
        result = apply_move(MPC_ON_EXE, board, side, mv["move"])
        board = result["board"]
        side = result["side_to_move"]
        plies += 1
    return count_discs(board)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--starts", type=int, default=12, help="開始局面の種類数(この2倍が総対局数になる)")
    ap.add_argument("--depth", type=int, default=8, help="探索深さ(両者共通、MPCが発動するにはmpc::MIN_DEPTH以上が必要)")
    ap.add_argument("--seed", type=int, default=48480, help="開始局面生成の乱数シード")
    ap.add_argument("--weights", type=Path, default=DEFAULT_PATTERN_WEIGHTS, help="両者共通で使うパターン評価の重みファイル")
    ap.add_argument("--output", type=Path, default=None, help="結果JSONの出力先")
    args = ap.parse_args()

    if not MPC_ON_EXE.exists() or not MPC_OFF_EXE.exists():
        raise RuntimeError(
            f"{MPC_ON_EXE.name} / {MPC_OFF_EXE.name} の両方が必要です。"
            "本ファイル冒頭のdocstringの手順でビルドしてください。"
        )
    if not args.weights.exists():
        raise RuntimeError(f"{args.weights} not found.")

    output_path = args.output or (COMPARE_DIR / "selfplay_mpc_results.json")

    print(f"Generating {args.starts} diverse start positions (seed={args.seed})...")
    starts = gen_start_positions(args.starts, args.seed)
    print(f"  {len(starts)} start positions generated")
    print(f"Pattern weights (both sides): {args.weights}")
    print(f"Depth: {args.depth}")

    total_games = len(starts) * 2
    results = []
    n_mpc_wins = 0
    n_nompc_wins = 0
    n_draws = 0
    total_mpc_disc_margin = 0

    game_no = 0
    for start in starts:
        for mpc_is_black in (True, False):
            game_no += 1
            black_discs, white_discs = play_game(
                mpc_is_black, args.weights, args.depth, start["board"], start["side_to_move"]
            )
            mpc_discs = black_discs if mpc_is_black else white_discs
            nompc_discs = white_discs if mpc_is_black else black_discs
            margin = mpc_discs - nompc_discs
            total_mpc_disc_margin += margin

            if margin > 0:
                n_mpc_wins += 1
                outcome = "mpc"
            elif margin < 0:
                n_nompc_wins += 1
                outcome = "no_mpc"
            else:
                n_draws += 1
                outcome = "draw"

            results.append(
                {
                    "game": game_no,
                    "start_id": start.get("id"),
                    "mpc_is_black": mpc_is_black,
                    "black_discs": black_discs,
                    "white_discs": white_discs,
                    "mpc_discs": mpc_discs,
                    "no_mpc_discs": nompc_discs,
                    "margin_mpc_minus_no_mpc": margin,
                    "winner": outcome,
                }
            )
            print(
                f"game {game_no:2d} (start={start.get('id')}): mpc={'black' if mpc_is_black else 'white'} "
                f"black={black_discs:2d} white={white_discs:2d} -> winner={outcome} (margin={margin:+d})"
            )

    print()
    print(f"total games: {total_games}")
    print(f"mpc wins: {n_mpc_wins}, no_mpc wins: {n_nompc_wins}, draws: {n_draws}")
    print(f"average disc margin (mpc - no_mpc): {total_mpc_disc_margin / total_games:+.2f}")

    output_path.write_text(
        json.dumps(
            {
                "weights": str(args.weights),
                "depth": args.depth,
                "games": total_games,
                "mpc_wins": n_mpc_wins,
                "no_mpc_wins": n_nompc_wins,
                "draws": n_draws,
                "avg_disc_margin_mpc_minus_no_mpc": total_mpc_disc_margin / total_games,
                "results": results,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {output_path.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

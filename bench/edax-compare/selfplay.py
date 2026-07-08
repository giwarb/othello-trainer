#!/usr/bin/env python3
"""T024: 較正前(baseline)と較正後(new)の重みでの自己対戦による棋力比較。

`eval_cli_baseline.exe`(較正前、`MOBILITY_WEIGHT=10`/`CORNER_WEIGHT=2500`/
`STABLE_WEIGHT=1500`)と `eval_cli_new.exe`(較正後、T024の回帰で求めた重み)を
それぞれ別プロセスとして起動し、`eval_cli moves`(全合法手ランキング、既存の
`Engine::analyze` 経由)の最上位手を選び続けることで対局をシミュレートする。

較正は評価関数の「重み比率」を変える(=探索の手選択が変わりうる)較正なので、
較正後のエンジンが較正前に対して明確に弱くなっていないかを確認するのが目的。
既存のsolve_exact(終盤完全読み)には依存しない、探索depth固定の対局で十分
(=どちらの重みでも同じ探索アルゴリズムを使い、リーフの静的評価だけが異なる、
という条件を揃えるのが目的なので、終局まで固定depthで対局させて最終石差を見る)。

使い方(リポジトリルートから):
    python bench/edax-compare/selfplay.py --games 24 --depth 6
"""

from __future__ import annotations

import argparse
import functools
import json
import subprocess
import sys
from pathlib import Path

print = functools.partial(print, flush=True)

COMPARE_DIR = Path(__file__).resolve().parent
BASELINE_EXE = COMPARE_DIR / "eval_cli_baseline.exe"
NEW_EXE = COMPARE_DIR / "eval_cli_new.exe"

def run(cmd: list[str], input_text: str | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstderr={result.stderr}")
    return result.stdout


def best_move(exe: Path, board: str, side: str, depth: int) -> dict | None:
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run([str(exe), "moves", "--depth", str(depth), "--exact-from-empties", "0"], input_text=input_json)
    moves = json.loads(out)["moves"]
    if not moves:
        return None
    return max(moves, key=lambda m: m["score"])


def apply_move(board: str, side: str, move: str) -> dict:
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run([str(BASELINE_EXE), "apply", "--move", move], input_text=input_json)
    return json.loads(out)


def count_discs(board: str) -> tuple[int, int]:
    return board.count("X"), board.count("O")


def gen_start_positions(count: int, seed: int, min_empties: int = 44, max_empties: int = 50) -> list[dict]:
    """多様な開始局面を生成する(`eval_cli gen`、`bench/edax-compare/run-comparison.py`と
    同じランダム自己対戦ベースの生成方式)。

    両エンジンとも探索は決定的(乱数要素なし、`search_all_moves`が常に同じ順位を返す)
    なので、常に初期局面から対局を始めると「先後を入れ替えた2パターン」しか
    得られず、`--games`を増やしても同じ対局を繰り返すだけになってしまう
    (実際に4局試したところ2種類の結果しか出なかった)。そのため、開始局面自体を
    複数用意し、対局ごとに異なる開始局面 x 先後の組み合わせで対局させることで、
    意味のあるサンプル数を確保する。"""
    out = run(
        [
            str(BASELINE_EXE),
            "gen",
            "--category",
            "selfplay-start",
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


def play_game(black_exe: Path, white_exe: Path, depth: int, start_board: str, start_side: str, max_plies: int = 200) -> tuple[int, int]:
    """指定した開始局面から1局対局し、(黒石数, 白石数)を返す。"""
    board = start_board
    side = start_side
    exes = {"black": black_exe, "white": white_exe}
    consecutive_no_move = 0
    plies = 0
    while consecutive_no_move < 2 and plies < max_plies:
        mv = best_move(exes[side], board, side, depth)
        if mv is None:
            consecutive_no_move += 1
            side = "white" if side == "black" else "black"
            continue
        consecutive_no_move = 0
        result = apply_move(board, side, mv["move"])
        board = result["board"]
        side = result["side_to_move"]
        plies += 1
    return count_discs(board)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--starts", type=int, default=12, help="開始局面の種類数(この2倍が総対局数になる)")
    ap.add_argument("--depth", type=int, default=6, help="探索深さ(両者共通)")
    ap.add_argument("--seed", type=int, default=9000, help="開始局面生成の乱数シード")
    args = ap.parse_args()

    if not BASELINE_EXE.exists() or not NEW_EXE.exists():
        raise RuntimeError("eval_cli_baseline.exe / eval_cli_new.exe の両方が必要です。先にビルドしてください。")

    print(f"Generating {args.starts} diverse start positions (seed={args.seed})...")
    starts = gen_start_positions(args.starts, args.seed)
    print(f"  {len(starts)} start positions generated")

    total_games = len(starts) * 2
    results = []
    n_new_wins = 0
    n_baseline_wins = 0
    n_draws = 0
    total_new_disc_margin = 0

    game_no = 0
    for start in starts:
        for new_is_black in (True, False):
            game_no += 1
            if new_is_black:
                black_exe, white_exe = NEW_EXE, BASELINE_EXE
            else:
                black_exe, white_exe = BASELINE_EXE, NEW_EXE

            black_discs, white_discs = play_game(
                black_exe, white_exe, args.depth, start["board"], start["side_to_move"]
            )
            new_discs = black_discs if new_is_black else white_discs
            baseline_discs = white_discs if new_is_black else black_discs
            margin = new_discs - baseline_discs
            total_new_disc_margin += margin

            if margin > 0:
                n_new_wins += 1
                outcome = "new"
            elif margin < 0:
                n_baseline_wins += 1
                outcome = "baseline"
            else:
                n_draws += 1
                outcome = "draw"

            results.append(
                {
                    "game": game_no,
                    "start_id": start.get("id"),
                    "new_is_black": new_is_black,
                    "black_discs": black_discs,
                    "white_discs": white_discs,
                    "new_discs": new_discs,
                    "baseline_discs": baseline_discs,
                    "margin_new_minus_baseline": margin,
                    "winner": outcome,
                }
            )
            print(
                f"game {game_no:2d} (start={start.get('id')}): new={'black' if new_is_black else 'white'} "
                f"black={black_discs:2d} white={white_discs:2d} -> winner={outcome} (margin={margin:+d})"
            )

    print()
    print(f"total games: {total_games}")
    print(f"new wins: {n_new_wins}, baseline wins: {n_baseline_wins}, draws: {n_draws}")
    print(f"average disc margin (new - baseline): {total_new_disc_margin / total_games:+.2f}")

    (COMPARE_DIR / "selfplay_results.json").write_text(
        json.dumps(
            {
                "depth": args.depth,
                "games": total_games,
                "new_wins": n_new_wins,
                "baseline_wins": n_baseline_wins,
                "draws": n_draws,
                "avg_disc_margin_new_minus_baseline": total_new_disc_margin / total_games,
                "results": results,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print("Wrote selfplay_results.json")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

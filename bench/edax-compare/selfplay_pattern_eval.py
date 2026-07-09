#!/usr/bin/env python3
"""T043/T044: パターン評価(T041の`pattern_v1.bin`、T044の対称重み共有
`pattern_v2.bin`)と旧3項ヒューリスティック評価の自己対戦による棋力比較。

`bench/edax-compare/selfplay.py`(T024、較正前後のヒューリスティック評価同士の
自己対戦)と同じ設計(`eval_cli moves`の最上位手を選び続ける、開始局面を複数
用意して先後入れ替えで対局)を踏襲するが、比較対象が「同じ`eval_cli`バイナリに
`--pattern-weights`フラグを付けるかどうか」という違いになった点が異なる
(T024時点では重みがRustのconstだったため2つの別バイナリをビルドする必要が
あったが、T043では重みが実行時にファイルから読み込まれるため1つのバイナリで
比較できる)。

T044で`--weights`オプションを追加し、比較対象のパターン重みファイルを
選べるようにした(デフォルトは`pattern_v2.bin`)。`--weights`に
`pattern_v1.bin`を指定すればT043と同じv1 vs 旧ヒューリスティックの比較も
そのまま再現できる。

使い方(リポジトリルートから):
    python bench/edax-compare/selfplay_pattern_eval.py --games 24 --depth 6
    python bench/edax-compare/selfplay_pattern_eval.py --weights train/weights/pattern_v1.bin
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
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
DEFAULT_PATTERN_WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"


def run(cmd: list[str], input_text: str | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstderr={result.stderr}")
    return result.stdout


def best_move(use_pattern: bool, weights_path: Path, board: str, side: str, depth: int) -> dict | None:
    input_json = json.dumps({"board": board, "side_to_move": side})
    cmd = [str(EVAL_CLI), "moves", "--depth", str(depth), "--exact-from-empties", "0"]
    if use_pattern:
        cmd += ["--pattern-weights", str(weights_path)]
    out = run(cmd, input_text=input_json)
    moves = json.loads(out)["moves"]
    if not moves:
        return None
    return max(moves, key=lambda m: m["score"])


def apply_move(board: str, side: str, move: str) -> dict:
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run([str(EVAL_CLI), "apply", "--move", move], input_text=input_json)
    return json.loads(out)


def count_discs(board: str) -> tuple[int, int]:
    return board.count("X"), board.count("O")


def gen_start_positions(count: int, seed: int, min_empties: int = 44, max_empties: int = 50) -> list[dict]:
    """多様な開始局面を生成する(`selfplay.py`と同じ理由: 両エンジンとも探索は
    決定的なので、開始局面を複数用意しないと意味のあるサンプル数にならない)。"""
    out = run(
        [
            str(EVAL_CLI),
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


def play_game(
    pattern_is_black: bool, weights_path: Path, depth: int, start_board: str, start_side: str, max_plies: int = 200
) -> tuple[int, int]:
    """指定した開始局面から1局対局し、(黒石数, 白石数)を返す。"""
    board = start_board
    side = start_side
    use_pattern = {"black": pattern_is_black, "white": not pattern_is_black}
    consecutive_no_move = 0
    plies = 0
    while consecutive_no_move < 2 and plies < max_plies:
        mv = best_move(use_pattern[side], weights_path, board, side, depth)
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
    ap.add_argument(
        "--weights",
        type=Path,
        default=DEFAULT_PATTERN_WEIGHTS,
        help="パターン評価側が使う重みファイル(既定: pattern_v2.bin、T044)。"
        "pattern_v1.binを指定すればT043と同じv1 vs 旧ヒューリスティック比較を再現できる。",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=None,
        help="結果JSONの出力先(既定: selfplay_pattern_eval_results_<重みファイル名の拡張子抜き>.json)",
    )
    args = ap.parse_args()

    if not EVAL_CLI.exists():
        raise RuntimeError(f"{EVAL_CLI} not found. Run `cargo build --release -p engine --bin eval_cli` first.")
    if not args.weights.exists():
        raise RuntimeError(f"{args.weights} not found. Run train_patterns first.")

    output_path = args.output or (COMPARE_DIR / f"selfplay_pattern_eval_results_{args.weights.stem}.json")

    print(f"Generating {args.starts} diverse start positions (seed={args.seed})...")
    starts = gen_start_positions(args.starts, args.seed)
    print(f"  {len(starts)} start positions generated")
    print(f"Pattern eval weights: {args.weights}")

    total_games = len(starts) * 2
    results = []
    n_pattern_wins = 0
    n_heuristic_wins = 0
    n_draws = 0
    total_pattern_disc_margin = 0

    game_no = 0
    for start in starts:
        for pattern_is_black in (True, False):
            game_no += 1
            black_discs, white_discs = play_game(
                pattern_is_black, args.weights, args.depth, start["board"], start["side_to_move"]
            )
            pattern_discs = black_discs if pattern_is_black else white_discs
            heuristic_discs = white_discs if pattern_is_black else black_discs
            margin = pattern_discs - heuristic_discs
            total_pattern_disc_margin += margin

            if margin > 0:
                n_pattern_wins += 1
                outcome = "pattern"
            elif margin < 0:
                n_heuristic_wins += 1
                outcome = "heuristic"
            else:
                n_draws += 1
                outcome = "draw"

            results.append(
                {
                    "game": game_no,
                    "start_id": start.get("id"),
                    "pattern_is_black": pattern_is_black,
                    "black_discs": black_discs,
                    "white_discs": white_discs,
                    "pattern_discs": pattern_discs,
                    "heuristic_discs": heuristic_discs,
                    "margin_pattern_minus_heuristic": margin,
                    "winner": outcome,
                }
            )
            print(
                f"game {game_no:2d} (start={start.get('id')}): pattern={'black' if pattern_is_black else 'white'} "
                f"black={black_discs:2d} white={white_discs:2d} -> winner={outcome} (margin={margin:+d})"
            )

    print()
    print(f"total games: {total_games}")
    print(f"pattern wins: {n_pattern_wins}, heuristic wins: {n_heuristic_wins}, draws: {n_draws}")
    print(f"average disc margin (pattern - heuristic): {total_pattern_disc_margin / total_games:+.2f}")

    output_path.write_text(
        json.dumps(
            {
                "weights": str(args.weights),
                "depth": args.depth,
                "games": total_games,
                "pattern_wins": n_pattern_wins,
                "heuristic_wins": n_heuristic_wins,
                "draws": n_draws,
                "avg_disc_margin_pattern_minus_heuristic": total_pattern_disc_margin / total_games,
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

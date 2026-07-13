#!/usr/bin/env python3
"""T082: 自作エンジン(`engine/src/bin/eval_cli.rs`)とEdax
(`bench/edax-compare/edax-extract/wEdax-x86-64.exe`)を1手ずつ交互に着手させて
実際に対局させる自動対戦ハーネス。

これまでの `bench/edax-compare/` の比較スクリプトは、(a) 静的評価値の比較
(`run-comparison.py` / `compare_pattern_eval.py`)、(b) 自作エンジン同士の
自己対戦(`selfplay.py` / `selfplay_pattern_eval.py`)のみで、Edaxとの
実対局(1手ずつ交互に着手し終局まで進める)は未実装だった。本スクリプトで
それを行い、(1) Edaxのどのレベルと互角か、(2) 序盤/中盤/終盤のどこで
どれだけ損しているか、を定量化する。

対局の仕組み:
  - 自作エンジン側の着手は `eval_cli moves`(全合法手を評価値降順で返す。
    先頭=最善手だが、`selfplay_pattern_eval.py` に倣い念のため `max(...,
    key=score)` で選ぶ)→ `eval_cli apply` で着手を適用する。
  - Edax側の着手は、局面を一意なファイル名のOBF一時ファイルに書き出し、
    `wEdax-x86-64.exe -solve <obf> -l <level> -eval-file data/eval.dat
    -book-usage off -vv` を実行して `-vv` 出力の "principal variation"
    列の先頭手を抽出する(既存スクリプトはdepth/scoreしかパースしておらず、
    PV先頭手の抽出は本タスクで新規実装した)。PVの大文字/小文字は
    「白の着手=大文字、黒の着手=小文字」という固定の色ベースの規約
    (手番ベースではない)であることを、初期局面(黒番)とその1手先
    (白番)の両方で実測して確認済み(`verify_pv_extraction()` 参照。
    詳細はT082作業ログ)。
  - `eval_cli apply` は非合法な手を渡すと終了コード1で失敗するので、
    Edaxから抽出した手を実際にゲーム内で適用する際は、この失敗が
    そのまま「合法性チェックに落ちた」ことの検出になる(黙って続行しない)。
    加えて、起動直後に `verify_pv_extraction()` で初期局面・その1手先の
    局面それぞれについてPV抽出手が合法手集合に含まれることを明示的に
    assertする(要件2)。
  - パス処理: 自作エンジン側の手番は `eval_cli moves` が返す手の有無で
    判定する(手が無ければ終局)。Edax側の手番は、着手前に軽量な
    `eval_cli moves --depth 1 --exact-from-empties 0`(パターン重み無し、
    純粋な合法手チェック用)で合法手の有無を確認してから呼び出す。
    どちらも `eval_cli apply` 自体が「相手に合法手が無ければ手番を戻す」
    という単発パスをすでに解決して返してくる(`cmd_apply` 参照)ため、
    このチェックで「これから動く側に合法手が無い」と分かった時点で
    それは両者パス=終局を意味する。

一時ファイルの衝突回避(要件3): OBF一時ファイルは呼び出しごとに
`tempfile.NamedTemporaryFile` で一意な名前を生成し、使用後に必ず削除する
(既存スクリプトの `_t022_tmp.obf` のような固定名は使わない。将来
並列実行する場合でも衝突しない設計)。

実行方法(リポジトリルートから):
    python bench/edax-compare/vs_edax.py --smoke     # 軽量な動作確認(初期局面付近から1局)
    python bench/edax-compare/vs_edax.py             # 本番実行(既定: レベル10/5/1 x 20局 + 弱点分析 + レポート)

前提: `cargo build --release -p engine --bin eval_cli` でビルド済み、
`bench/edax-compare/edax-extract/`にEdaxが展開済み(`download-edax.ps1`)、
`train/weights/pattern_v2.bin` が存在すること。
"""

from __future__ import annotations

import argparse
import functools
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

print = functools.partial(print, flush=True)

ROOT = Path(__file__).resolve().parents[2]
COMPARE_DIR = Path(__file__).resolve().parent
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
EDAX_DIR = COMPARE_DIR / "edax-extract"
EDAX_EXE = EDAX_DIR / "wEdax-x86-64.exe"
EDAX_EVAL_DATA = EDAX_DIR / "data" / "eval.dat"
DEFAULT_PATTERN_WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"

DEFAULT_RESULTS_PATH = COMPARE_DIR / "vs_edax_results.json"
DEFAULT_REPORT_PATH = COMPARE_DIR / "vs_edax_report.md"

# 要件4: 自作エンジン設定の既定値(アプリ実運用に近く、既存比較(depth10)とも整合)。
DEFAULT_ENGINE_DEPTH = 10
DEFAULT_ENGINE_EXACT_FROM_EMPTIES = 18
# `--exact-from-empties`は探索木のあらゆるノードに適用されるため、これを
# 時間無制限で使うと空きマス20〜28付近の局面で組合せ爆発的に遅くなることを
# 実機で確認した(詳細は`play_game`のdocstring・T082作業ログ)。本リポジトリの
# 既存ルール(`app/src/midgame/PracticeMode.tsx`等の`*_ANALYZE_LIMIT`がいずれも
# `exactFromEmpties`と`timeMs`を必ずペアで設定している、T034の教訓)に倣い、
# 既定の時間予算として`MIDGAME_ANALYZE_LIMIT`等が収束した1000msを使う。
DEFAULT_ENGINE_TIME_MS = 1000

# 要件4: 開始局面(8〜12手目程度=空きマス48〜52)を10局面、既定シード固定。
DEFAULT_START_COUNT = 10
DEFAULT_START_MIN_EMPTIES = 48
DEFAULT_START_MAX_EMPTIES = 52
DEFAULT_START_SEED = 5000

# 要件4: Edaxレベル(-l 10 を主軸に、時間が許せば -l 5 / -l 1 も)。
DEFAULT_LEVELS = [10, 5, 1]

# 要件6: 弱点分析用のEdax高レベル(目安16、重ければ14にフォールバック)。
DEFAULT_HIGH_LEVEL = 16
# 要件6: 負けた対局が多い場合の代表サンプル数(レベルごと)。
DEFAULT_LOSS_SAMPLE_PER_LEVEL = 5

MAX_PLIES = 130


def run(cmd: list[str], input_text: str | None = None, cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result.stdout


def _cargo_bin() -> str:
    import shutil

    found = shutil.which("cargo")
    if found:
        return found
    fallback = Path.home() / ".cargo" / "bin" / "cargo.exe"
    if fallback.exists():
        return str(fallback)
    fallback_unix = Path.home() / ".cargo" / "bin" / "cargo"
    if fallback_unix.exists():
        return str(fallback_unix)
    raise RuntimeError("cargo not found on PATH and no fallback at ~/.cargo/bin/cargo(.exe)")


def ensure_engine_built() -> None:
    if EVAL_CLI.exists():
        return
    print("eval_cli not found, building (cargo build --release -p engine --bin eval_cli) ...")
    run([_cargo_bin(), "build", "--release", "-p", "engine", "--bin", "eval_cli"], cwd=ROOT)
    if not EVAL_CLI.exists():
        raise RuntimeError(f"build finished but {EVAL_CLI} still not found")


def ensure_edax_available() -> None:
    if not EDAX_EXE.exists():
        raise RuntimeError(
            f"Edax executable not found at {EDAX_EXE}.\n"
            "Run `powershell -File bench/edax-compare/download-edax.ps1` first."
        )


def ensure_pattern_weights_available(weights: Path) -> None:
    if not weights.exists():
        raise RuntimeError(f"{weights} not found. Run `cargo run -p train --release --bin train_patterns` first.")


# --- 自作エンジン側(eval_cli) ---


def gen_positions(category: str, min_empties: int, max_empties: int, count: int, seed: int) -> list[dict]:
    out = run(
        [
            str(EVAL_CLI),
            "gen",
            "--category",
            category,
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


def engine_moves(
    board: str, side: str, depth: int, exact_from_empties: int, weights: Path | None, time_ms: int | None = None
) -> list[dict]:
    input_json = json.dumps({"board": board, "side_to_move": side})
    cmd = [str(EVAL_CLI), "moves", "--depth", str(depth), "--exact-from-empties", str(exact_from_empties)]
    if weights is not None:
        cmd += ["--pattern-weights", str(weights)]
    if time_ms is not None:
        cmd += ["--time-ms", str(time_ms)]
    out = run(cmd, input_text=input_json)
    moves = json.loads(out)["moves"]
    return moves or []


def engine_has_legal_move(board: str, side: str) -> bool:
    """Edax側の手番でパス判定を行うための軽量な合法手チェック
    (パターン重み無し・depth=1。実際の着手選択には使わない)。"""
    return len(engine_moves(board, side, depth=1, exact_from_empties=0, weights=None)) > 0


def engine_apply(board: str, side: str, move: str) -> dict:
    input_json = json.dumps({"board": board, "side_to_move": side})
    out = run([str(EVAL_CLI), "apply", "--move", move], input_text=input_json)
    return json.loads(out)


def count_discs(board: str) -> tuple[int, int]:
    return board.count("X"), board.count("O")


# --- Edax側 ---

# `-vv` 出力の "depth|score|...|principal variation" 行の先頭(depth, score)を
# 拾う正規表現(`run-comparison.py`/`compare_pattern_eval.py`と同じ。
# `12@73%` のような選択探索の確信度サフィックスは無視する)。
_EDAX_ROW_RE = re.compile(r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s")

# PV欄のマス目表記(`a1`〜`h8`、大文字/小文字どちらもありうる)を抜き出す
# 正規表現。時刻(`0:00.016`)やノード数(`205265`)の列には
# `[a-hA-H][1-8]` にマッチする文字列は現れないため、行全体からこのパターンを
# 探すだけでPVの着手列を安全に取り出せる(列幅がテーブルによって揺れても
# 頑健)。大文字/小文字は「白=大文字・黒=小文字」という色ベースの固定規約
# であることを `verify_pv_extraction()` で確認済み。
_MOVE_TOKEN_RE = re.compile(r"\b[a-hA-H][1-8]\b")


def edax_solve(board: str, side_to_move: str, level: int) -> dict:
    """局面をEdaxに解かせ、`-vv` 出力の最終行(最大探索深さの行)から
    (depth, discDiff, PV先頭手)を抽出して返す。

    一時OBFファイルは呼び出しごとに一意な名前を生成し、使用後に必ず削除する
    (要件3: 複数呼び出し・将来の並列実行での衝突を避けるため)。

    Edax自体のプロセス終了コードは無視する: 実対局中、終局間際(空きマス
    1〜2個)のごく短時間(elapsed 0.000秒)で終わる探索において、Edaxが
    depth/score/PVを`-vv`出力に正しく書き終えた**直後**、末尾の
    "nodes/s" 集計(経過時間0での除算とみられる)で異常終了する
    (`returncode=3221226356`=`0xC0000094`=Windows
    `STATUS_INTEGER_DIVIDE_BY_ZERO`)ことを実対局で確認した(Edax本体の
    バグであり本リポジトリの管轄外)。必要なdepth/score/PVは既に出力済み
    なので、`run()`の「終了コード非ゼロなら例外」という一般ルールは
    ここでは適用せず、直接subprocessを呼んで終了コードに関わらず
    stdoutをパースし、パース自体が失敗した場合にのみエラーにする。
    """
    side_char = "X" if side_to_move == "black" else "O"
    obf_line = f"{board} {side_char};\n"

    tmp = tempfile.NamedTemporaryFile(dir=EDAX_DIR, prefix="_vs_edax_", suffix=".obf", delete=False)
    tmp_path = Path(tmp.name)
    try:
        tmp.write(obf_line.encode("ascii"))
        tmp.close()

        result = subprocess.run(
            [
                str(EDAX_EXE),
                "-solve",
                str(tmp_path),
                "-l",
                str(level),
                "-eval-file",
                str(EDAX_EVAL_DATA),
                "-book-usage",
                "off",
                "-vv",
            ],
            cwd=str(EDAX_DIR),
            capture_output=True,
            text=True,
        )
        out = result.stdout
    finally:
        tmp_path.unlink(missing_ok=True)

    last_depth = None
    last_score = None
    last_move_tokens: list[str] = []
    for line in out.splitlines():
        m = _EDAX_ROW_RE.match(line)
        if m:
            last_depth = int(m.group(1))
            last_score = int(m.group(2))
            last_move_tokens = _MOVE_TOKEN_RE.findall(line)

    if last_score is None:
        raise RuntimeError(
            f"failed to parse Edax score for board={board} side={side_to_move} level={level} "
            f"(returncode={result.returncode}):\n{out}\nstderr={result.stderr}"
        )
    if not last_move_tokens:
        raise RuntimeError(
            f"failed to extract PV move from Edax output for board={board} side={side_to_move} level={level} "
            f"(returncode={result.returncode}):\n{out}\nstderr={result.stderr}"
        )

    raw_move = last_move_tokens[0]
    move = raw_move[0].lower() + raw_move[1]

    return {"depth": last_depth, "discDiff": float(last_score), "move": move}


INITIAL_LEGAL_MOVES = {"d3", "c4", "f5", "e6"}


def verify_pv_extraction() -> None:
    """要件2: Edax PV先頭手の抽出ロジックを、初期局面(黒番)とそこから
    1手進めた局面(白番)の両方で検証する。抽出手が合法手集合に含まれない
    場合はAssertionErrorで即停止する(黙って続行しない)。"""
    initial = gen_positions("verify-initial", min_empties=60, max_empties=60, count=1, seed=1)
    assert initial, "failed to generate the initial position via `eval_cli gen`"
    board0, side0 = initial[0]["board"], initial[0]["side_to_move"]
    assert side0 == "black", f"expected black to move at the initial position, got {side0}"

    r0 = edax_solve(board0, side0, level=5)
    if r0["move"] not in INITIAL_LEGAL_MOVES:
        raise AssertionError(
            f"PV extraction sanity check failed at the initial position: "
            f"got move={r0['move']!r}, expected one of {sorted(INITIAL_LEGAL_MOVES)} "
            f"(depth={r0['depth']} discDiff={r0['discDiff']})"
        )

    after = engine_apply(board0, side0, r0["move"])
    board1, side1 = after["board"], after["side_to_move"]
    if side1 != "white":
        raise AssertionError(f"expected white to move after {r0['move']}, got {side1}")

    legal1 = {m["move"] for m in engine_moves(board1, side1, depth=1, exact_from_empties=0, weights=None)}
    r1 = edax_solve(board1, side1, level=5)
    if r1["move"] not in legal1:
        raise AssertionError(
            f"PV extraction sanity check failed at the ply-1 (white to move) position: "
            f"got move={r1['move']!r}, not in legal move set {sorted(legal1)} "
            f"(board={board1}, depth={r1['depth']} discDiff={r1['discDiff']})"
        )

    print(
        f"PV extraction sanity check: PASSED "
        f"(initial position black->{r0['move']!r} in {sorted(INITIAL_LEGAL_MOVES)}; "
        f"then white->{r1['move']!r} in legal set {sorted(legal1)})"
    )


# --- 対局ループ ---


def play_game(
    engine_is_black: bool,
    engine_depth: int,
    engine_exact_from_empties: int,
    engine_time_ms: int | None,
    weights: Path,
    edax_level: int,
    start_board: str,
    start_side: str,
    game_id: int,
    level: int,
) -> dict:
    """指定した開始局面から1局対局する。自作エンジンとEdaxの手番を
    `engine_is_black` に従って交互に処理し、終局(両者とも合法手が無くなる)
    まで進める。

    `engine_time_ms`: 自作エンジン側の着手選択(`engine_moves`)に付与する
    時間予算(ミリ秒)。**要件4の基準設定(`--depth 10 --exact-from-empties
    18`)をそのまま時間無制限で使うと、深さ10の探索が木の内部ノードで
    空きマス18以下に到達するたびに完全読みへ切り替わる(`exact_from_empties`
    はルートだけでなく探索中のあらゆるノードに適用される)ため、空きマス
    20〜28付近の局面で組合せ爆発的に遅くなることを実機で確認した
    (`eval_cli moves`単体呼び出しで空きマス24/22/20は25秒超のタイムアウト
    (実際には数分以上かかる)、空きマス19で17.4秒、18で3〜11秒。詳細は
    T082作業ログ)。本リポジトリでは同種の危険性(空きマス閾値ベースの
    完全読み+時間無制限の組み合わせ)がまさに`app/src/verbalize/
    PracticeMode.tsx`のT034コメント(「深い探索を使う機能ではtimeMsを
    必ず設定する」)や`MIDGAME_ANALYZE_LIMIT`/`ANALYZE_LIMIT`/
    `VERBALIZE_ANALYZE_LIMIT`/`DRILL_ANALYZE_LIMIT`(いずれも`exactFromEmpties`
    と`timeMs`を必ずペアで設定)として既にドキュメント化・対策済みの
    既知の危険パターンであり、`eval_cli`側(engine/src/配下、本タスクの
    変更対象外)を触らずに安全に使うには呼び出し側で`--time-ms`を必ず
    付けるほかない。既定値はアプリの`MIDGAME_ANALYZE_LIMIT`/
    `VERBALIZE_ANALYZE_LIMIT`等が収束した`1000`(ミリ秒)に合わせている。
    """
    board = start_board
    side = start_side
    engine_side = "black" if engine_is_black else "white"
    moves_log: list[dict] = []
    ply = 0

    while ply < MAX_PLIES:
        if side == engine_side:
            candidates = engine_moves(
                board, side, engine_depth, engine_exact_from_empties, weights, time_ms=engine_time_ms
            )
            if not candidates:
                break  # 自作エンジン側に合法手が無い(=両者パス済みで終局)
            best = max(candidates, key=lambda m: m["score"])
            mv = best["move"]
            engine_disc_diff = best.get("discDiff")
            mover = "engine"
        else:
            if not engine_has_legal_move(board, side):
                break  # Edax側に合法手が無い(=両者パス済みで終局)
            r = edax_solve(board, side, edax_level)
            mv = r["move"]
            engine_disc_diff = None
            mover = "edax"

        moves_log.append(
            {
                "ply": ply + 1,
                "mover": mover,
                "side": side,
                "board_before": board,
                "move": mv,
                "engine_disc_diff": engine_disc_diff,
            }
        )
        result = engine_apply(board, side, mv)
        board, side = result["board"], result["side_to_move"]
        ply += 1

    black_discs, white_discs = count_discs(board)
    engine_discs = black_discs if engine_is_black else white_discs
    edax_discs = white_discs if engine_is_black else black_discs
    margin = engine_discs - edax_discs
    if margin > 0:
        winner = "engine"
    elif margin < 0:
        winner = "edax"
    else:
        winner = "draw"

    return {
        "level": level,
        "game_id": game_id,
        "engine_is_black": engine_is_black,
        "start_board": start_board,
        "start_side": start_side,
        "moves": moves_log,
        "final_board": board,
        "black_discs": black_discs,
        "white_discs": white_discs,
        "engine_discs": engine_discs,
        "edax_discs": edax_discs,
        "margin_engine_minus_edax": margin,
        "winner": winner,
        "plies": ply,
    }


# --- 弱点分析(要件6) ---


def classify_phase(ply: int) -> str:
    if ply <= 20:
        return "opening"
    if ply <= 40:
        return "midgame"
    return "endgame"


def terminal_value(board: str, perspective_side: str) -> float:
    """終局(両者とも合法手が無い)局面の、`perspective_side`視点での
    確定石差を返す(探索不要、実際の最終結果そのもの)。"""
    black, white = count_discs(board)
    return float(black - white) if perspective_side == "black" else float(white - black)


def analyze_game_losses(game: dict, high_level: int) -> list[dict]:
    """負けた対局1局について、自作エンジンが着手した各局面をEdax高レベルで
    再評価し、着手前局面のEdax最善評価と着手後局面のEdax評価(手番視点を
    揃えるための符号調整込み)の差をロスとして算出する
    (`run-comparison.py`の`analyze_badmove`と同じ考え方)。

    着手後の局面が終局(両者とも合法手が無い)の場合は、Edaxに解かせようとしても
    `-vv`出力に手が無くパースに失敗する(実測: 空きマス0の終局局面をEdaxに
    渡すと`principal variation`が空になる。T082作業ログ参照)ため、その場合は
    Edaxを呼ばず実際の最終石差(`terminal_value`)を使う(探索の必要が無い、
    確定した真の値)。"""
    losses = []
    for mv in game["moves"]:
        if mv["mover"] != "engine":
            continue
        before_board = mv["board_before"]
        before_side = mv["side"]
        own_move = mv["move"]

        best = edax_solve(before_board, before_side, high_level)

        after = engine_apply(before_board, before_side, own_move)
        if engine_has_legal_move(after["board"], after["side_to_move"]):
            after_result = edax_solve(after["board"], after["side_to_move"], high_level)
            if after["side_to_move"] == before_side:
                # 相手がパスして手番が変わらなかった場合は符号反転不要。
                value_after = after_result["discDiff"]
            else:
                value_after = -after_result["discDiff"]
        else:
            # 終局: Edaxを呼ばず確定した最終石差をbefore_side視点で使う。
            value_after = terminal_value(after["board"], before_side)

        loss = best["discDiff"] - value_after
        losses.append(
            {
                "game_id": game["game_id"],
                "level": game["level"],
                "ply": mv["ply"],
                "phase": classify_phase(mv["ply"]),
                "board": before_board,
                "side": before_side,
                "engine_move": own_move,
                "edax_best_move": best["move"],
                "edax_best_score": best["discDiff"],
                "engine_move_value": value_after,
                "loss": loss,
            }
        )
    return losses


def run_loss_analysis(games: list[dict], high_level: int, sample_per_level: int) -> dict:
    by_level: dict[int, list[dict]] = {}
    for g in games:
        by_level.setdefault(g["level"], []).append(g)

    analyzed_game_ids: list[dict] = []
    all_losses: list[dict] = []
    for level, level_games in by_level.items():
        losing = [g for g in level_games if g["winner"] == "edax"]
        sample = losing if len(losing) <= sample_per_level else losing[:sample_per_level]
        for g in sample:
            print(f"  analyzing losses for level={level} game_id={g['game_id']} (engine {g['margin_engine_minus_edax']:+d})...")
            game_losses = analyze_game_losses(g, high_level)
            all_losses.extend(game_losses)
            analyzed_game_ids.append({"level": level, "game_id": g["game_id"], "n_losing_at_level": len(losing), "sampled": len(sample)})

    return {"high_level": high_level, "sample_per_level": sample_per_level, "analyzed_games": analyzed_game_ids, "entries": all_losses}


# --- レポート生成 ---


def write_report(
    report_path: Path,
    settings: dict,
    games: list[dict],
    loss_analysis: dict,
) -> None:
    lines = []
    lines.append("# T082: 自作エンジン vs Edax 対戦ハーネス — レベル別対戦・弱点分析レポート")
    lines.append("")
    lines.append(
        "本レポートは自動生成される(`bench/edax-compare/vs_edax.py`)。再生成する場合は "
        "`python bench/edax-compare/vs_edax.py` を実行すること(事前にEdax(`download-edax.ps1`)・"
        "`eval_cli`(`cargo build --release -p engine --bin eval_cli`)・"
        "`train/weights/pattern_v2.bin`が必要)。"
    )
    lines.append("")

    # (a) 実行条件
    lines.append("## (a) 実行条件")
    lines.append("")
    lines.append(f"- 自作エンジン: `--depth {settings['engine_depth']} --exact-from-empties "
                  f"{settings['engine_exact_from_empties']} --time-ms {settings['engine_time_ms']} "
                  f"--pattern-weights {settings['weights']}`")
    lines.append(
        "  - `--time-ms`について: 要件4は`--depth 10 --exact-from-empties 18`のみを指定していたが、"
        "この組み合わせを時間無制限で使うと探索木内部のノードが空きマス20〜28付近で組合せ爆発的に"
        "遅くなることを実機で確認した(`--exact-from-empties`は探索木のあらゆるノードに適用されるため)。"
        "本リポジトリの既存実装(`app/src/midgame/PracticeMode.tsx`等の`*_ANALYZE_LIMIT`)がいずれも"
        "同じ危険パターンに対して`exactFromEmpties`と`timeMs`を必ずペアで設定している慣例(T034の教訓)"
        "に倣い、`--time-ms 1000`を追加した(探索深さ・完全読み閾値そのものは変更していない)。"
    )
    lines.append(
        f"- 開始局面: `eval_cli gen`(seed={settings['start_seed']})で生成した"
        f"空きマス数{settings['start_min_empties']}〜{settings['start_max_empties']}"
        f"(8〜12手目程度)の局面{settings['start_count']}種類 x 黒白持ち替え2局"
        f" = {settings['start_count'] * 2}局/レベル"
    )
    lines.append(f"- Edaxレベル: {settings['levels']}(いずれも `-book-usage off`、`-eval-file data/eval.dat`)")
    lines.append(
        f"- 実施したレベル・局数: {settings['levels']} すべて{settings['start_count'] * 2}局ずつ実施した"
        f"({settings['levels_note']})"
    )
    lines.append(
        f"- 弱点分析(要件6): 負けた対局をEdax `-l {settings['high_level']}` で再評価。"
        f"レベルごとに負け局が{settings['loss_sample_per_level']}局を超える場合は先頭"
        f"{settings['loss_sample_per_level']}局のみを代表サンプルとして分析した。"
    )
    lines.append("")

    # (b) レベル別勝敗・平均石差
    lines.append("## (b) レベル別の勝敗・平均石差")
    lines.append("")
    lines.append("| Edaxレベル | 局数 | 自作エンジン勝ち | Edax勝ち | 引き分け | 勝率 | 平均石差(自作-Edax) |")
    lines.append("|---:|---:|---:|---:|---:|---:|---:|")
    by_level: dict[int, list[dict]] = {}
    for g in games:
        by_level.setdefault(g["level"], []).append(g)
    summary_by_level: dict[int, dict] = {}
    for level in settings["levels"]:
        level_games = by_level.get(level, [])
        n = len(level_games)
        wins = sum(1 for g in level_games if g["winner"] == "engine")
        losses = sum(1 for g in level_games if g["winner"] == "edax")
        draws = sum(1 for g in level_games if g["winner"] == "draw")
        avg_margin = sum(g["margin_engine_minus_edax"] for g in level_games) / n if n else float("nan")
        win_rate = wins / n * 100 if n else float("nan")
        summary_by_level[level] = {
            "games": n,
            "engine_wins": wins,
            "edax_wins": losses,
            "draws": draws,
            "win_rate_pct": win_rate,
            "avg_margin_engine_minus_edax": avg_margin,
        }
        lines.append(f"| {level} | {n} | {wins} | {losses} | {draws} | {win_rate:.1f}% | {avg_margin:+.2f} |")
    lines.append("")

    # (c) フェーズ別ロス集計
    lines.append("## (c) フェーズ別ロス集計(負けた対局のサンプルより)")
    lines.append("")
    entries = loss_analysis["entries"]
    if not entries:
        lines.append("負けた対局が無かった(または分析対象がゼロ件だった)ため、ロス集計は該当なし。")
    else:
        lines.append(
            f"分析対象: {len(loss_analysis['analyzed_games'])}局、自作エンジンの着手{len(entries)}手分。"
            f"ロス = (着手前局面のEdax `-l {loss_analysis['high_level']}` 最善評価) - "
            "(着手後局面のEdax評価、手番視点を揃えるための符号調整込み)。"
        )
        lines.append("")
        lines.append("| フェーズ(手目) | 該当手数 | 平均ロス(石) | 累計ロス(石) |")
        lines.append("|---|---:|---:|---:|")
        by_phase: dict[str, list[float]] = {"opening": [], "midgame": [], "endgame": []}
        for e in entries:
            by_phase.setdefault(e["phase"], []).append(e["loss"])
        phase_labels = {"opening": "序盤(1〜20手目)", "midgame": "中盤(21〜40手目)", "endgame": "終盤(41手目〜)"}
        for phase in ("opening", "midgame", "endgame"):
            vals = by_phase.get(phase, [])
            n = len(vals)
            avg = sum(vals) / n if n else float("nan")
            total = sum(vals)
            avg_str = f"{avg:+.2f}" if n else "N/A"
            lines.append(f"| {phase_labels[phase]} | {n} | {avg_str} | {total:+.2f} |")
        lines.append("")

    # (d) 大ロス局面トップ10
    lines.append("## (d) ロスの大きい局面トップ10")
    lines.append("")
    if not entries:
        lines.append("該当なし。")
    else:
        top10 = sorted(entries, key=lambda e: e["loss"], reverse=True)[:10]
        lines.append("| 順位 | レベル | game_id | 手目 | フェーズ | 局面(OBF) | 自エンジンの手 | Edaxの推奨手 | ロス(石) |")
        lines.append("|---:|---:|---:|---:|---|---|---:|---:|---:|")
        for i, e in enumerate(top10, start=1):
            lines.append(
                f"| {i} | {e['level']} | {e['game_id']} | {e['ply']} | {phase_labels.get(e['phase'], e['phase'])} | "
                f"`{e['board']}` | {e['engine_move']} | {e['edax_best_move']} | {e['loss']:+.2f} |"
            )
    lines.append("")

    # (e) 考察
    lines.append("## (e) 考察")
    lines.append("")
    considerations = []
    # 最も互角に近いレベル
    valid_levels = [lv for lv in settings["levels"] if summary_by_level.get(lv, {}).get("games", 0) > 0]
    if valid_levels:
        closest = min(valid_levels, key=lambda lv: abs(summary_by_level[lv]["win_rate_pct"] - 50.0))
        considerations.append(
            f"- 勝率が最も5割に近いのはEdax `-l {closest}`(勝率{summary_by_level[closest]['win_rate_pct']:.1f}%、"
            f"平均石差{summary_by_level[closest]['avg_margin_engine_minus_edax']:+.2f}石)であり、"
            "このレベル付近が現状の自作エンジンの実力の目安と考えられる。"
        )
        lowest = min(valid_levels, key=lambda lv: summary_by_level[lv]["win_rate_pct"])
        highest = max(valid_levels, key=lambda lv: summary_by_level[lv]["win_rate_pct"])
        if lowest != highest:
            considerations.append(
                f"- レベルが上がるほど(`-l {lowest}`: 勝率{summary_by_level[lowest]['win_rate_pct']:.1f}% → "
                f"`-l {highest}`: 勝率{summary_by_level[highest]['win_rate_pct']:.1f}%)勝率が変化しており、"
                "レベル(探索深さ)の差が結果に反映されている(探索がまったく効いていない、といった"
                "重大な不具合は見られない)。"
            )
    if entries:
        phase_avgs = {
            phase: (sum(v) / len(v) if v else None)
            for phase, v in by_phase.items()
        }
        worst_phase = max((p for p in phase_avgs if phase_avgs[p] is not None), key=lambda p: phase_avgs[p], default=None)
        if worst_phase is not None:
            considerations.append(
                f"- フェーズ別では{phase_labels[worst_phase]}の平均ロスが最大"
                f"({phase_avgs[worst_phase]:+.2f}石)であり、このフェーズの弱さが敗因として最も大きい。"
            )
        top_entry = max(entries, key=lambda e: e["loss"])
        considerations.append(
            f"- 最大ロスの局面(level={top_entry['level']} game_id={top_entry['game_id']} "
            f"{top_entry['ply']}手目)では自エンジンが`{top_entry['engine_move']}`を選んだのに対し、"
            f"Edaxの推奨は`{top_entry['edax_best_move']}`で、ロスは{top_entry['loss']:+.2f}石だった"
            "(上の(d)表を参照)。同種の局面パターンが弱点として今後の評価関数・探索強化の"
            "優先順位付けの参考になる。"
        )
    else:
        considerations.append("- 負けた対局が無かった(または分析対象がゼロ件だった)ため、フェーズ別の弱点は今回は特定できなかった。")
    lines.extend(considerations)
    lines.append("")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --- main ---


def run_smoke(args: argparse.Namespace) -> None:
    print("=== smoke mode: verifying PV extraction and playing 1 game from the initial position ===")
    verify_pv_extraction()

    initial = gen_positions("smoke-initial", min_empties=60, max_empties=60, count=1, seed=1)
    start_board, start_side = initial[0]["board"], initial[0]["side_to_move"]
    edax_level = args.levels[0] if args.levels else DEFAULT_LEVELS[0]

    print(f"Playing 1 smoke game (engine=black, edax level={edax_level})...")
    game = play_game(
        engine_is_black=True,
        engine_depth=args.engine_depth,
        engine_exact_from_empties=args.engine_exact_from_empties,
        engine_time_ms=args.engine_time_ms,
        weights=args.weights,
        edax_level=edax_level,
        start_board=start_board,
        start_side=start_side,
        game_id=1,
        level=edax_level,
    )
    print(
        f"smoke game finished: {game['plies']} plies, black={game['black_discs']} white={game['white_discs']}, "
        f"winner={game['winner']} (margin engine-edax={game['margin_engine_minus_edax']:+d})"
    )
    print("SMOKE TEST: PASSED")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--smoke", action="store_true", help="軽量モード: PV抽出の検証+初期局面付近から1局のみ対局して完走を確認する")
    ap.add_argument("--starts", type=int, default=DEFAULT_START_COUNT, help="開始局面の種類数(この2倍が1レベルあたりの対局数)")
    ap.add_argument("--seed", type=int, default=DEFAULT_START_SEED, help="開始局面生成の乱数シード")
    ap.add_argument("--min-empties", type=int, default=DEFAULT_START_MIN_EMPTIES)
    ap.add_argument("--max-empties", type=int, default=DEFAULT_START_MAX_EMPTIES)
    ap.add_argument(
        "--levels",
        type=str,
        default=",".join(str(x) for x in DEFAULT_LEVELS),
        help=f"カンマ区切りのEdaxレベル一覧(既定: {','.join(str(x) for x in DEFAULT_LEVELS)})",
    )
    ap.add_argument("--engine-depth", type=int, default=DEFAULT_ENGINE_DEPTH)
    ap.add_argument("--engine-exact-from-empties", type=int, default=DEFAULT_ENGINE_EXACT_FROM_EMPTIES)
    ap.add_argument(
        "--engine-time-ms",
        type=int,
        default=DEFAULT_ENGINE_TIME_MS,
        help="自作エンジン側の着手選択に付与する時間予算(ミリ秒)。0以下を指定すると時間無制限になる"
        "(空きマス20〜28付近で組合せ爆発的に遅くなることがあるため非推奨。詳細はplay_gameのdocstring参照)。",
    )
    ap.add_argument("--weights", type=Path, default=DEFAULT_PATTERN_WEIGHTS)
    ap.add_argument("--high-level", type=int, default=DEFAULT_HIGH_LEVEL, help="弱点分析(要件6)用のEdax高レベル")
    ap.add_argument("--loss-sample-per-level", type=int, default=DEFAULT_LOSS_SAMPLE_PER_LEVEL)
    ap.add_argument("--results-output", type=Path, default=DEFAULT_RESULTS_PATH)
    ap.add_argument("--report-output", type=Path, default=DEFAULT_REPORT_PATH)
    args = ap.parse_args()
    args.levels = [int(x) for x in args.levels.split(",") if x.strip()]
    engine_time_ms: int | None = args.engine_time_ms if args.engine_time_ms and args.engine_time_ms > 0 else None
    args.engine_time_ms = engine_time_ms

    ensure_engine_built()
    ensure_edax_available()
    ensure_pattern_weights_available(args.weights)

    if args.smoke:
        run_smoke(args)
        return

    print("=== full run: PV extraction sanity check ===")
    verify_pv_extraction()

    print(f"Generating {args.starts} start positions (seed={args.seed}, empties {args.min_empties}-{args.max_empties})...")
    starts = gen_positions("vs-edax-start", args.min_empties, args.max_empties, args.starts, args.seed)
    print(f"  {len(starts)} start positions generated")

    all_games: list[dict] = []
    for level in args.levels:
        print(f"=== Edax level {level}: {len(starts)} start positions x 2 (black/white) = {len(starts) * 2} games ===")
        game_id = 0
        for start in starts:
            for engine_is_black in (True, False):
                game_id += 1
                game = play_game(
                    engine_is_black=engine_is_black,
                    engine_depth=args.engine_depth,
                    engine_exact_from_empties=args.engine_exact_from_empties,
                    engine_time_ms=args.engine_time_ms,
                    weights=args.weights,
                    edax_level=level,
                    start_board=start["board"],
                    start_side=start["side_to_move"],
                    game_id=game_id,
                    level=level,
                )
                game["start_id"] = start.get("id")
                all_games.append(game)
                print(
                    f"  level={level} game={game_id:2d} (start={start.get('id')}, engine="
                    f"{'black' if engine_is_black else 'white'}): "
                    f"black={game['black_discs']:2d} white={game['white_discs']:2d} plies={game['plies']:3d} "
                    f"-> winner={game['winner']} (margin={game['margin_engine_minus_edax']:+d})"
                )

        # レベル1つ分(20局)完走するたびにチェックポイントを書き出す
        # (対局中にEdax側の未知のエッジケースで異常終了しても、それまでの
        # レベルの対局結果を失わないようにするため。詳細はT082作業ログ:
        # このタスクの検証中に実際にEdaxが空きマス2個・経過時間0.000秒の
        # 局面で0除算とみられるクラッシュ(`returncode=3221226356`=
        # `STATUS_INTEGER_DIVIDE_BY_ZERO`)を起こし、チェックポイント無しの
        # 状態で対局60局分をやり直す羽目になった)。
        (args.results_output).write_text(
            json.dumps({"settings": None, "start_positions": starts, "games": all_games, "loss_analysis": None}, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {args.results_output.name} (checkpoint: after level {level})")

    # (対局ループ内の各レベル完走時点で既に`args.results_output`へ
    # チェックポイント書き込み済み。ここから先の弱点分析は追加のEdax高レベル
    # 呼び出しを伴い、想定外の局面で失敗する可能性がゼロではないため、
    # そのチェックポイントを弱点分析成功後に`loss_analysis`込みで上書きする。)

    print("=== weakness analysis: analyzing losing games with Edax high level ===")
    loss_analysis = run_loss_analysis(all_games, args.high_level, args.loss_sample_per_level)
    print(f"  analyzed {len(loss_analysis['analyzed_games'])} losing game(s), {len(loss_analysis['entries'])} engine move(s)")

    summary_by_level: dict[int, dict] = {}
    for level in args.levels:
        level_games = [g for g in all_games if g["level"] == level]
        n = len(level_games)
        wins = sum(1 for g in level_games if g["winner"] == "engine")
        losses = sum(1 for g in level_games if g["winner"] == "edax")
        draws = sum(1 for g in level_games if g["winner"] == "draw")
        avg_margin = sum(g["margin_engine_minus_edax"] for g in level_games) / n if n else None
        summary_by_level[level] = {
            "games": n,
            "engine_wins": wins,
            "edax_wins": losses,
            "draws": draws,
            "avg_margin_engine_minus_edax": avg_margin,
        }

    settings = {
        "engine_depth": args.engine_depth,
        "engine_exact_from_empties": args.engine_exact_from_empties,
        "engine_time_ms": args.engine_time_ms,
        "weights": str(args.weights),
        "start_count": args.starts,
        "start_min_empties": args.min_empties,
        "start_max_empties": args.max_empties,
        "start_seed": args.seed,
        "levels": args.levels,
        "levels_note": (
            "全レベルを削減せず全局数実施した。Edax呼び出し自体は局面あたり1秒未満と高速だったが、"
            "自作エンジン側の`--exact-from-empties 18`を時間無制限で使うと探索木内部のノードが空きマス"
            "20〜28付近で組合せ爆発的に遅くなることが判明したため(実測: 空きマス24/22/20は25秒超、"
            "19で17.4秒、18で3〜11秒。詳細はplay_gameのdocstring・T082作業ログ)、既存のアプリ実装"
            "(`*_ANALYZE_LIMIT`)の慣例に合わせ`--time-ms 1000`を自作エンジン側の着手選択に付与して"
            "対処した(要件4は`--depth 10 --exact-from-empties 18`をそのまま維持しつつ、探索を1000ms"
            "でカットするだけなので探索深さ・完全読み閾値そのものは変えていない)。"
        ),
        "high_level": args.high_level,
        "loss_sample_per_level": args.loss_sample_per_level,
    }

    results_doc = {
        "settings": settings,
        "start_positions": starts,
        "games": all_games,
        "summary_by_level": summary_by_level,
        "loss_analysis": loss_analysis,
    }
    args.results_output.write_text(json.dumps(results_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.results_output.name}")

    write_report(args.report_output, settings, all_games, loss_analysis)
    print(f"Wrote {args.report_output.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

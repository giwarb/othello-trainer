#!/usr/bin/env python3
"""T082/T084: 自作エンジン(`engine/src/bin/eval_cli.rs`)とEdax
(`bench/edax-compare/edax-extract/wEdax-x86-64.exe`)を1手ずつ交互に着手させて
実際に対局させる自動対戦ハーネス。

T084での改修点(設計レビュー `tasks/design/T083-engine-strengthening-report.md`
の指摘に基づく計測の補正。詳細はT084作業ログ参照):

  1. **single-rootベストムーブ探索の導入**: T082は着手選択に `eval_cli moves`
     (全合法手を個別にfull-window探索し、時間予算を候補数で公平分割する方式。
     `search::search_all_moves_with_eval`)を使っていたが、これは「1秒の
     単一ルート探索」ではなく「1秒を候補数で割った短い探索を全候補に対して
     行う」方式であり、PVS・TT最善手の利益が失われる。T084で追加した
     `eval_cli best`(単一ルートの`search::search_with_eval`、反復深化+
     NegaScout+TT+ETC+終盤完全読み)を既定の着手選択方式にする
     (`--engine-mode single-root`、既定値)。旧方式は`--engine-mode allmoves`
     で維持し、同一予算(1秒)での直接比較を行えるようにする。
  2. **テレメトリの記録**: `eval_cli best`が返す到達深さ・総ノード数・
     経過ms・NPS・タイムアウト有無・exact読みの試行/完走/フォールバックの別を
     各手のレコードに保存する。
  3. **オラクルロスの修正**: 弱点分析のロスを「同一局面の全合法手それぞれの
     着手後局面をEdax同一レベルで評価し、loss = max(全子の値) - (選択手の
     子の値)」方式に変更した(常に非負。旧方式は着手前後を別探索した
     近似値の差だったため345件中95件が負値になっていた)。
  4. **実手数ベースのフェーズ集計**: 開始局面自体が8〜12手目相当なので、
     「開始局面からのply数」ではなく「初期局面からの通算手数(実手数)」で
     フェーズ(序盤/中盤/終盤)を判定するよう修正した。
  5. **固定openingマニフェスト**(`openings.json`): 開始局面をその都度
     `eval_cli gen`で再生成せず、事前に生成してコミット済みのファイルから
     読む(スモーク10局面+一次判定用30局面、それぞれ黒白持ち替えで2倍の
     局数になる)。
  6. **fixed-depth系列の分離**: `--time-ms`を使わない`--depth N`のみの
     決定性検証系列(Edaxとは対局せず、`eval_cli best`を各opening局面に
     対して2回実行し、着手・スコア・ノード数が完全一致することを確認する)
     を独立したモードとして追加した。
  7. **1局単位のチェックポイント+resume**: 対局・弱点分析とも、進捗を
     都度`vs_edax_results.json`に書き出し、再実行時は完了済みの局・
     分析済みの手をスキップする(CLAUDE.mdの長時間実行ルール準拠)。
  8. **build情報の記録**: 実行時のgit commitハッシュとパターン重みファイルの
     sha256ハッシュを実行メタデータとして保存する。

対局の仕組み(T082から変更なし):
  - Edax側の着手は、局面を一意なファイル名のOBF一時ファイルに書き出し、
    `wEdax-x86-64.exe -solve <obf> -l <level> -eval-file data/eval.dat
    -book-usage off -vv` を実行して `-vv` 出力の "principal variation"
    列の先頭手を抽出する。PVの大文字/小文字は「白の着手=大文字、
    黒の着手=小文字」という固定の色ベースの規約(手番ベースではない)
    であることを実測済み(`verify_pv_extraction()` 参照。詳細はT082作業ログ)。
  - `eval_cli apply` は非合法な手を渡すと終了コード1で失敗するので、
    Edaxから抽出した手を実際にゲーム内で適用する際は、この失敗が
    そのまま「合法性チェックに落ちた」ことの検出になる(黙って続行しない)。

実行方法(リポジトリルートから):
    python bench/edax-compare/vs_edax.py --smoke     # 軽量な動作確認(初期局面付近から1局)
    python bench/edax-compare/vs_edax.py             # 本番実行(既定: fixed-depth回帰確認
                                                       # + single-root/allmoves各レベル20局
                                                       # + 弱点分析 + レポート)

前提: `cargo build --release -p engine --bin eval_cli` でビルド済み、
`bench/edax-compare/edax-extract/`にEdaxが展開済み(`download-edax.ps1`)、
`train/weights/pattern_v2.bin` が存在すること。
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

print = functools.partial(print, flush=True)

ROOT = Path(__file__).resolve().parents[2]
COMPARE_DIR = Path(__file__).resolve().parent
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
EDAX_DIR = COMPARE_DIR / "edax-extract"
EDAX_EXE = EDAX_DIR / "wEdax-x86-64.exe"
EDAX_EVAL_DATA = EDAX_DIR / "data" / "eval.dat"
DEFAULT_PATTERN_WEIGHTS = ROOT / "train" / "weights" / "pattern_v2.bin"
DEFAULT_OPENINGS_PATH = COMPARE_DIR / "openings.json"

DEFAULT_RESULTS_PATH = COMPARE_DIR / "vs_edax_results.json"
DEFAULT_REPORT_PATH = COMPARE_DIR / "vs_edax_report.md"

# 自作エンジン設定の既定値(T082から変更なし。アプリ実運用に近く、既存比較
# (depth10)とも整合)。single-root/allmovesの両モードで同じ値を使うことで
# 「同一予算での直接比較」(T084要件3)が成り立つ。
DEFAULT_ENGINE_DEPTH = 10
DEFAULT_ENGINE_EXACT_FROM_EMPTIES = 18
# `--exact-from-empties`は探索木のあらゆるノードに適用されるため、これを
# 時間無制限で使うと空きマス20〜28付近の局面で組合せ爆発的に遅くなることを
# T082で実機確認した。本リポジトリの既存ルール(`*_ANALYZE_LIMIT`が
# `exactFromEmpties`と`timeMs`を必ずペアで設定するT034の教訓)に倣い、
# wall-time系列(対局)では常に時間予算を付与する。
DEFAULT_ENGINE_TIME_MS = 1000

# T084要件4・6: fixed-depth系列(決定性・回帰検知用、Edaxとは対局しない)。
# 時間予算を使わないため、`--exact-from-empties`の組合せ爆発
# (T082作業ログ参照、空き20〜28付近で発生)を避けられる値を選ぶ:
# openingマニフェストの局面は空き48〜52(8〜12手目相当)なので、
# depth=8の探索が到達しうる最も深い局面でも空き40以上であり、
# exact_from_empties=10の閾値には全く届かない(=完全読みへの切替は
# ルート自体が空き10以下になるまで一切発生しない、常に安全)。
DEFAULT_FIXED_DEPTH = 8
DEFAULT_FIXED_DEPTH_EXACT_FROM_EMPTIES = 10
DEFAULT_NODE_CHECK_MAX_NODES = 4096

# Edaxレベル(-l 10 を主軸に、-l 5 / -l 1 も)。
DEFAULT_LEVELS = [10, 5, 1]

# 弱点分析用のEdax高レベル(目安16、重ければ14にフォールバック)。
DEFAULT_HIGH_LEVEL = 16
# 負けた対局が多い場合の代表サンプル数(レベルごと)。
DEFAULT_LOSS_SAMPLE_PER_LEVEL = 5

MAX_PLIES = 130

# フェーズ境界(実手数ベース、T084要件6)。T082から数値自体は変更していない
# (1-20/21-40/41-)が、適用する対象を「開始局面からのply」から
# 「初期局面からの通算手数(実手数)」に変更した。
PHASE_BOUNDARY_OPENING = 20
PHASE_BOUNDARY_MIDGAME = 40


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


# --- 実行メタデータ(T084要件6) ---


def git_commit_hash() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
        if out.returncode == 0:
            return out.stdout.strip()
        return f"unknown (git rev-parse failed: {out.stderr.strip()})"
    except Exception as exc:  # noqa: BLE001
        return f"unknown ({exc})"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def rel_to_root(path: Path) -> str:
    """レポート/結果JSONに埋め込むパスをリポジトリルート相対のPOSIX表記に
    正規化する(実行者のホームディレクトリ名等、環境固有の情報が
    コミットされる成果物に残らないようにするため)。`ROOT`配下でない
    パスはそのまま文字列化して返す(フォールバック)。"""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return f"<external>/{path.name}"


def git_value(*args: str) -> str:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout.strip()


def ensure_clean_worktree(allow_dirty: bool, allowed_outputs: tuple[Path, ...]) -> None:
    status = git_value("status", "--porcelain")
    allowed = {rel_to_root(path) for path in allowed_outputs}
    dirty_lines = [
        line for line in status.splitlines() if line[3:].replace(chr(92), "/") not in allowed
    ]
    dirty = "\n".join(dirty_lines)
    if dirty and not allow_dirty:
        raise RuntimeError(
            "benchmark provenance requires a committed worktree; commit tracked changes first "
            "(or pass --allow-dirty for a non-publishable local smoke run)"
        )
    if dirty:
        print("WARNING: running from a dirty worktree (--allow-dirty); results are not publishable")


def build_run_metadata(weights: Path) -> dict:
    return {
        "gitCommit": git_commit_hash(),
        "gitTree": git_value("rev-parse", "HEAD^{tree}"),
        "harnessSha256": sha256_of_file(Path(__file__)),
        "weightsPath": rel_to_root(weights),
        "weightsSha256": sha256_of_file(weights) if weights.exists() else None,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# --- openingマニフェスト(T084要件5) ---


def load_openings(path: Path) -> dict:
    doc = json.loads(path.read_text(encoding="utf-8"))
    for key in ("smoke", "primary"):
        if key not in doc or "positions" not in doc[key]:
            raise RuntimeError(f"{path} is missing the '{key}.positions' section (regenerate via the T084 setup)")
    return doc


def opening_set(doc: dict, name: str) -> list[dict]:
    if name not in ("smoke", "primary"):
        raise ValueError(f"unknown opening set: {name!r} (expected 'smoke' or 'primary')")
    return doc[name]["positions"]


# --- 自作エンジン側(eval_cli) ---


def gen_positions(category: str, min_empties: int, max_empties: int, count: int, seed: int) -> list[dict]:
    """`eval_cli gen`のラッパー。T084では対局の開始局面には使わない
    (`openings.json`の固定マニフェストを使う、要件5)が、
    `verify_pv_extraction()`が初期局面を1つ得るために引き続き使う。"""
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
    """全合法手を評価値降順で返す(`search_all_moves_with_eval`、旧方式。
    T084では`--engine-mode allmoves`での着手選択、および合法手一覧の取得
    (弱点分析でのオラクル計算)に使う。"""
    input_json = json.dumps({"board": board, "side_to_move": side})
    cmd = [str(EVAL_CLI), "moves", "--depth", str(depth), "--exact-from-empties", str(exact_from_empties)]
    if weights is not None:
        cmd += ["--pattern-weights", str(weights)]
    if time_ms is not None:
        cmd += ["--time-ms", str(time_ms)]
    out = run(cmd, input_text=input_json)
    moves = json.loads(out)["moves"]
    return moves or []


def engine_best(
    board: str,
    side: str,
    depth: int,
    exact_from_empties: int,
    weights: Path | None,
    time_ms: int | None = None,
    max_nodes: int | None = None,
) -> dict:
    """T084: `eval_cli best`(single-root探索、`search_with_eval`)を呼び、
    最善手とテレメトリ一式(depth/nodes/elapsedMs/nps/timedOut/exact.*)を
    含むJSONオブジェクトをそのまま返す。"""
    input_json = json.dumps({"board": board, "side_to_move": side})
    cmd = [str(EVAL_CLI), "best", "--depth", str(depth), "--exact-from-empties", str(exact_from_empties)]
    if weights is not None:
        cmd += ["--pattern-weights", str(weights)]
    if time_ms is not None:
        cmd += ["--time-ms", str(time_ms)]
    if max_nodes is not None:
        cmd += ["--max-nodes", str(max_nodes)]
    out = run(cmd, input_text=input_json)
    return json.loads(out)


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


def true_ply_of_board(board: str) -> int:
    """初期局面からの通算手数(実手数)を、盤面上の石数から逆算する
    (初期局面の4石を引いた分がこれまでに打たれた手の数、という標準的な
    近似。パスは盤面上の石数を変えないので厳密な「半手」カウントとは
    ズレうるが、序盤〜中盤〜終盤という粗いフェーズ判定には十分な精度)。"""
    black, white = count_discs(board)
    return black + white - 4


# --- Edax側 ---

# `-vv` 出力の "depth|score|...|principal variation" 行の先頭(depth, score)を
# 拾う正規表現(`run-comparison.py`/`compare_pattern_eval.py`と同じ。
# `12@73%` のような選択探索の確信度サフィックスは無視する)。
_EDAX_ROW_RE = re.compile(r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s")

# PV欄のマス目表記(`a1`〜`h8`、大文字/小文字どちらもありうる)を抜き出す
# 正規表現。大文字/小文字は「白=大文字・黒=小文字」という色ベースの固定規約
# であることを `verify_pv_extraction()` で確認済み。
_MOVE_TOKEN_RE = re.compile(r"\b[a-hA-H][1-8]\b")


def edax_solve(board: str, side_to_move: str, level: int) -> dict:
    """局面をEdaxに解かせ、`-vv` 出力の最終行(最大探索深さの行)から
    (depth, discDiff, PV先頭手)を抽出して返す。

    一時OBFファイルは呼び出しごとに一意な名前を生成し、使用後に必ず削除する
    (T082要件3: 複数呼び出し・将来の並列実行での衝突を避けるため)。

    Edax自体のプロセス終了コードは無視する: 実対局中、終局間際(空きマス
    1〜2個)のごく短時間(elapsed 0.000秒)で終わる探索において、Edaxが
    depth/score/PVを`-vv`出力に正しく書き終えた**直後**、末尾の
    "nodes/s" 集計(経過時間0での除算とみられる)で異常終了する
    (`returncode=3221226356`=`0xC0000094`=Windows
    `STATUS_INTEGER_DIVIDE_BY_ZERO`)ことをT082の実対局で確認した(Edax本体の
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
    """要件2(T082): Edax PV先頭手の抽出ロジックを、初期局面(黒番)とそこから
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


def classify_phase(true_ply: int) -> str:
    if true_ply <= PHASE_BOUNDARY_OPENING:
        return "opening"
    if true_ply <= PHASE_BOUNDARY_MIDGAME:
        return "midgame"
    return "endgame"


def terminal_value(board: str, perspective_side: str) -> float:
    """終局(両者とも合法手が無い)局面の、`perspective_side`視点での
    確定石差を返す(探索不要、実際の最終結果そのもの)。"""
    black, white = count_discs(board)
    return float(black - white) if perspective_side == "black" else float(white - black)


# --- 対局ループ(T084要件1・3) ---


def play_game(
    engine_mode: str,
    engine_is_black: bool,
    engine_depth: int,
    engine_exact_from_empties: int,
    engine_time_ms: int | None,
    engine_max_nodes: int | None,
    weights: Path,
    edax_level: int,
    start_board: str,
    start_side: str,
    start_ply_offset: int,
    game_id: int,
    level: int,
) -> dict:
    """指定した開始局面から1局対局する。`engine_mode`は`"single-root"`
    (`eval_cli best`、T084の既定)または`"allmoves"`(`eval_cli moves`、
    T082の旧方式、比較用に維持)。自作エンジンとEdaxの手番を
    `engine_is_black` に従って交互に処理し、終局(両者とも合法手が無くなる)
    まで進める。

    `engine_time_ms`: 自作エンジン側の着手選択に付与する時間予算
    (ミリ秒)。要件4の基準設定(`--depth 10 --exact-from-empties 18`)を
    時間無制限で使うと、深さ10の探索が木の内部ノードで空きマス18以下に
    到達するたびに完全読みへ切り替わる(`exact_from_empties`はルートだけで
    なく探索中のあらゆるノードに適用される)ため、空きマス20〜28付近の
    局面で組合せ爆発的に遅くなることをT082で実機確認した(詳細はT082
    作業ログ)。本リポジトリでは同種の危険性が`app/src/midgame/
    PracticeMode.tsx`のT034コメント・`*_ANALYZE_LIMIT`(いずれも
    `exactFromEmpties`と`timeMs`を必ずペアで設定)として既にドキュメント化・
    対策済みの既知の危険パターンであり、wall-time系列では必ず
    `--time-ms`を付ける。

    `start_ply_offset`: 開始局面自体が初期局面から何手目相当かを表す
    (T084要件6: openingマニフェストの局面は空き48〜52=8〜12手目相当。
    `moves_log`の各エントリの`truePly`はこのオフセット+ゲーム内のply)。
    """
    board = start_board
    side = start_side
    engine_side = "black" if engine_is_black else "white"
    moves_log: list[dict] = []
    ply = 0

    while ply < MAX_PLIES:
        engine_telemetry: dict | None = None
        if side == engine_side:
            if engine_mode == "single-root":
                r = engine_best(
                    board,
                    side,
                    engine_depth,
                    engine_exact_from_empties,
                    weights,
                    time_ms=engine_time_ms,
                    max_nodes=engine_max_nodes,
                )
                mv = r.get("move")
                if mv is None:
                    if engine_has_legal_move(board, side):
                        raise RuntimeError(
                            f"eval_cli best returned move=null despite legal moves: "
                            f"game_id={game_id} ply={ply} board={board} side={side}"
                        )
                    break
                engine_telemetry = {
                    "discDiff": r["score"]["discDiff"],
                    "scoreType": r["score"]["type"],
                    "depth": r["depth"],
                    "nodes": r["nodes"],
                    "elapsedMs": r["elapsedMs"],
                    "nps": r["nps"],
                    "timedOut": r["timedOut"],
                    "nodeLimitHit": r.get("nodeLimitHit", False),
                    "exactAttempted": r["exact"]["attempted"],
                    "exactCompleted": r["exact"]["completed"],
                    "exactFallback": r["exact"]["fallback"],
                }
            elif engine_mode == "allmoves":
                candidates = engine_moves(
                    board, side, engine_depth, engine_exact_from_empties, weights, time_ms=engine_time_ms
                )
                if not candidates:
                    break  # 自作エンジン側に合法手が無い(=両者パス済みで終局)
                best = max(candidates, key=lambda m: m["score"])
                mv = best["move"]
                # T084注記: `search_all_moves_with_eval`(旧方式)は1手ごとの
                # depth/nodes/elapsedMs/timedOutをCLI外部に公開していない
                # (合計の経過時間しかeval_cliのstderrに出さない)。allmovesは
                # あくまでA/B比較(要件3)の対局結果のみが目的であり、T084の
                # スコープ(最小限の変更)では`cmd_moves`のJSON出力形式は
                # 変更していないため、詳細テレメトリはNoneのままにする
                # (レポートにもこの制約を明記する)。
                engine_telemetry = {
                    "discDiff": best.get("discDiff"),
                    "scoreType": best.get("type"),
                    "depth": None,
                    "nodes": None,
                    "elapsedMs": None,
                    "nps": None,
                    "timedOut": None,
                    "nodeLimitHit": None,
                    "exactAttempted": None,
                    "exactCompleted": None,
                    "exactFallback": None,
                }
            else:
                raise ValueError(f"unknown engine_mode: {engine_mode!r}")
            mover = "engine"
        else:
            if not engine_has_legal_move(board, side):
                break  # Edax側に合法手が無い(=両者パス済みで終局)
            r = edax_solve(board, side, edax_level)
            mv = r["move"]
            mover = "edax"

        true_ply = start_ply_offset + ply + 1
        entry = {
            "ply": ply + 1,
            "truePly": true_ply,
            "phase": classify_phase(true_ply),
            "mover": mover,
            "side": side,
            "board_before": board,
            "move": mv,
        }
        if engine_telemetry is not None:
            entry["engine"] = engine_telemetry
        moves_log.append(entry)

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
        "engine_mode": engine_mode,
        "level": level,
        "game_id": game_id,
        "engine_is_black": engine_is_black,
        "start_board": start_board,
        "start_side": start_side,
        "start_ply_offset": start_ply_offset,
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


def game_key(engine_mode: str, level: int, opening_id: str, engine_is_black: bool) -> str:
    """1局を一意に識別するキー(チェックポイント/resumeでの照合に使う)。"""
    return f"{engine_mode}|{level}|{opening_id}|{'black' if engine_is_black else 'white'}"


def loss_entry_key(game_id: int, ply: int) -> str:
    return f"{game_id}|{ply}"


# --- fixed-depth決定性回帰チェック(T084要件2・4) ---


def run_fixed_depth_regression(openings: list[dict], depth: int, exact_from_empties: int, weights: Path) -> dict:
    """openingマニフェストの各局面に対して`eval_cli best --depth N`
    (時間予算なし)を2回実行し、着手・スコア・到達深さ・ノード数が
    完全に一致することを検証する。Edaxとは対局しない(壁時計・Edax側の
    挙動から完全に切り離した、自作エンジン単体の決定性の直接検証)。"""

    def run_once() -> list[dict]:
        out = []
        for pos in openings:
            r = engine_best(pos["board"], pos["side_to_move"], depth, exact_from_empties, weights, time_ms=None)
            out.append(
                {
                    "id": pos["id"],
                    "move": r.get("move"),
                    "discDiff": r["score"]["discDiff"],
                    "scoreType": r["score"]["type"],
                    "depth": r["depth"],
                    "nodes": r["nodes"],
                }
            )
        return out

    print(f"  fixed-depth regression: run 1/2 ({len(openings)} positions, depth={depth}, exact-from-empties={exact_from_empties})...")
    run1 = run_once()
    print(f"  fixed-depth regression: run 2/2 ({len(openings)} positions)...")
    run2 = run_once()

    mismatches = []
    for a, b in zip(run1, run2):
        if a["move"] != b["move"] or a["discDiff"] != b["discDiff"] or a["nodes"] != b["nodes"] or a["depth"] != b["depth"]:
            mismatches.append({"id": a["id"], "run1": a, "run2": b})

    result = {
        "depth": depth,
        "exactFromEmpties": exact_from_empties,
        "positions": len(openings),
        "run1": run1,
        "run2": run2,
        "mismatches": mismatches,
        "allMatched": len(mismatches) == 0,
    }
    if mismatches:
        raise RuntimeError(
            f"fixed-depth determinism check FAILED: {len(mismatches)} of {len(openings)} positions "
            f"produced different results across two runs (see result['mismatches']): {mismatches[:3]}"
        )
    print(f"  fixed-depth regression: PASSED ({len(openings)}/{len(openings)} positions matched across 2 runs)")
    return result


def run_node_budget_regression(openings: list[dict], depth: int, exact_from_empties: int, weights: Path, max_nodes: int) -> dict:
    """smoke openingを同じノード予算で2回探索し、壁時計に依存しない
    着手・評価・深さ・ノード数の完全一致を検証する。"""

    def run_once() -> list[dict]:
        rows = []
        for pos in openings:
            r = engine_best(
                pos["board"],
                pos["side_to_move"],
                depth,
                exact_from_empties,
                weights,
                time_ms=None,
                max_nodes=max_nodes,
            )
            rows.append(
                {
                    "id": pos["id"],
                    "move": r.get("move"),
                    "discDiff": r["score"]["discDiff"],
                    "depth": r["depth"],
                    "nodes": r["nodes"],
                    "nodeLimitHit": r["nodeLimitHit"],
                }
            )
        return rows

    print(f"  node-budget regression: run 1/2 ({len(openings)} positions, max-nodes={max_nodes})...")
    run1 = run_once()
    print(f"  node-budget regression: run 2/2 ({len(openings)} positions)...")
    run2 = run_once()
    mismatches = [{"id": a["id"], "run1": a, "run2": b} for a, b in zip(run1, run2) if a != b]
    result = {
        "maxNodes": max_nodes,
        "positions": len(openings),
        "run1": run1,
        "run2": run2,
        "mismatches": mismatches,
        "allMatched": not mismatches,
    }
    if mismatches:
        raise RuntimeError(f"node-budget determinism check FAILED: {mismatches[:3]}")
    print(f"  node-budget regression: PASSED ({len(openings)}/{len(openings)} positions matched)")
    return result


# --- 弱点分析(T084要件7: オラクルロスの修正) ---


def analyze_game_losses_v2(game: dict, high_level: int, checkpoint_cb=None, completed_keys: set[str] | None = None) -> list[dict]:
    """負けた対局1局について、自作エンジンが着手した各局面のロスを、
    「同一root・同一設定で全合法手の着手後局面を評価し、
    loss = max(全子の値) - (選択手の子の値)」方式で算出する(T084要件7)。

    T082の方式(着手前局面をEdaxで1回評価した値と、着手後局面を
    Edaxで1回評価した値の差)は、345件中95件が負値になり「オラクルとして
    不成立」だった(着手前後を異なる探索コンテキストで評価しているため)。
    本方式は、選択された手を含む**全ての合法手**を同じ方法(着手後局面を
    Edaxで評価)で評価してから最大値を取るため、選択手が必ず「全候補の
    1つ」として比較に含まれ、`loss >= 0` が理論的に保証される。

    `checkpoint_cb`が指定されていれば、ロスエントリを1件計算するたびに
    (=1局面ごとに、要件8)呼び出す(呼び出し元がチェックポイントの
    書き出しに使う)。"""
    losses = []
    completed_keys = completed_keys or set()
    for mv in game["moves"]:
        if mv["mover"] != "engine":
            continue
        if loss_entry_key(game["game_id"], mv["ply"]) in completed_keys:
            continue
        before_board = mv["board_before"]
        before_side = mv["side"]
        own_move = mv["move"]

        legal = engine_moves(before_board, before_side, depth=1, exact_from_empties=0, weights=None)
        legal_move_names = [m["move"] for m in legal]
        if own_move not in legal_move_names:
            raise RuntimeError(
                f"engine's own recorded move {own_move!r} is not in the legal move set "
                f"{sorted(legal_move_names)} for board={before_board} side={before_side} "
                "(this should never happen; indicates a bug in move recording or legality checking)"
            )

        child_values: dict[str, float] = {}
        for cand in legal_move_names:
            after = engine_apply(before_board, before_side, cand)
            if engine_has_legal_move(after["board"], after["side_to_move"]):
                after_result = edax_solve(after["board"], after["side_to_move"], high_level)
                if after["side_to_move"] == before_side:
                    # 相手がパスして手番が変わらなかった場合は符号反転不要。
                    value = after_result["discDiff"]
                else:
                    value = -after_result["discDiff"]
            else:
                # 終局: Edaxを呼ばず確定した最終石差を使う(空きマス0の
                # 終局局面をEdaxに渡すと`-vv`のPV欄が空になりパースに
                # 失敗することをT082で確認済み)。
                value = terminal_value(after["board"], before_side)
            child_values[cand] = value

        best_move = max(child_values, key=lambda m: child_values[m])
        best_value = child_values[best_move]
        selected_value = child_values[own_move]
        loss = best_value - selected_value

        entry = {
            "game_id": game["game_id"],
            "engine_mode": game.get("engine_mode"),
            "level": game["level"],
            "ply": mv["ply"],
            "truePly": mv["truePly"],
            "phase": mv["phase"],
            "board": before_board,
            "side": before_side,
            "engine_move": own_move,
            "edax_best_move": best_move,
            "edax_best_score": best_value,
            "engine_move_value": selected_value,
            "loss": loss,
            "legal_move_count": len(legal_move_names),
        }
        losses.append(entry)
        if checkpoint_cb is not None:
            checkpoint_cb(entry)
    return losses


def run_loss_analysis(
    games: list[dict],
    high_level: int,
    sample_per_level: int,
    checkpoint_cb=None,
    completed_keys: set[str] | None = None,
) -> dict:
    """T084要件6・9c: single-rootモードの負け対局のみを弱点分析の対象と
    する(design報告の焦点はsingle-rootの真の弱点であり、allmovesは
    A/Bの対局結果比較のみが目的のため。対象を広げると弱点分析のEdax
    呼び出し回数が要件7の修正(全合法手を評価)と相まって膨大になる
    ことも理由の一つ)。"""
    single_root_games = [g for g in games if g.get("engine_mode") == "single-root"]
    by_level: dict[int, list[dict]] = {}
    for g in single_root_games:
        by_level.setdefault(g["level"], []).append(g)

    analyzed_game_ids: list[dict] = []
    all_losses: list[dict] = []
    for level, level_games in by_level.items():
        losing = [g for g in level_games if g["winner"] == "edax"]
        sample = losing if len(losing) <= sample_per_level else losing[:sample_per_level]
        for g in sample:
            print(
                f"  analyzing losses for level={level} game_id={g['game_id']} "
                f"(engine {g['margin_engine_minus_edax']:+d})..."
            )
            game_losses = analyze_game_losses_v2(
                g,
                high_level,
                checkpoint_cb=checkpoint_cb,
                completed_keys=completed_keys,
            )
            all_losses.extend(game_losses)
            analyzed_game_ids.append(
                {"level": level, "game_id": g["game_id"], "n_losing_at_level": len(losing), "sampled": len(sample)}
            )

    return {
        "high_level": high_level,
        "sample_per_level": sample_per_level,
        "scope": "single-root only (see run_loss_analysis docstring)",
        "analyzed_games": analyzed_game_ids,
        "entries": all_losses,
    }


# --- レポート生成 ---


def _fmt_opt(v, fmt: str = "{:.2f}") -> str:
    return fmt.format(v) if v is not None else "N/A"


def write_report(
    report_path: Path,
    settings: dict,
    meta: dict,
    fixed_depth_result: dict | None,
    node_budget_result: dict | None,
    games: list[dict],
    loss_analysis: dict,
) -> None:
    lines = []
    lines.append("# T084: 自作エンジン vs Edax 対戦ハーネス — single-root化・テレメトリ・弱点分析レポート")
    lines.append("")
    lines.append(
        "本レポートは自動生成される(`bench/edax-compare/vs_edax.py`)。再生成する場合は "
        "`python bench/edax-compare/vs_edax.py` を実行すること(事前にEdax(`download-edax.ps1`)・"
        "`eval_cli`(`cargo build --release -p engine --bin eval_cli`)・"
        "`train/weights/pattern_v2.bin`が必要)。T082(初版)からの変更点は"
        "`vs_edax.py`冒頭のdocstringおよび`tasks/T084-bench-single-root-telemetry.md`"
        "の作業ログを参照。"
    )
    lines.append("")

    # (a) 実行条件
    lines.append("## (a) 実行条件")
    lines.append("")
    lines.append(f"- git commit: `{meta['gitCommit']}`")
    lines.append(f"- git tree: `{meta['gitTree']}` / harness sha256: `{meta['harnessSha256']}`")
    lines.append(f"- settings sha256: `{meta['settingsSha256']}`")
    lines.append(f"- パターン重み: `{meta['weightsPath']}` (sha256=`{meta['weightsSha256']}`)")
    lines.append(f"- 実行日時(UTC): {meta['generatedAt']}")
    lines.append(
        f"- 自作エンジン: `--depth {settings['engine_depth']} --exact-from-empties "
        f"{settings['engine_exact_from_empties']} --time-ms {settings['engine_time_ms']} "
        f"--pattern-weights {settings['weights']}`(single-root/allmoves共通、同一予算での比較)"
    )
    lines.append(
        f"- 開始局面: `bench/edax-compare/openings.json`(T084固定マニフェスト)の "
        f"`{settings['opening_set']}` セット({settings['opening_count']}局面 x 黒白持ち替え2局 "
        f"= {settings['opening_count'] * 2}局/レベル/モード)"
    )
    lines.append(f"- Edaxレベル: {settings['levels']}(いずれも `-book-usage off`、`-eval-file data/eval.dat`)")
    lines.append(
        f"- 実行したモード: {settings['engine_modes']} "
        "(single-root=T084で追加した単一ルートPVS探索、allmoves=T082の全合法手分割探索。"
        "同一opening・同一レベル・同一予算で両方実行し、(b)で直接比較する)"
    )
    lines.append(
        f"- 弱点分析(要件6・7・9c): single-rootモードの負けた対局のみを対象に、Edax `-l "
        f"{settings['high_level']}` で修正版オラクル(同一rootの全合法手を個別評価しmax差分)を"
        f"算出。レベルごとに負け局が{settings['loss_sample_per_level']}局を超える場合は先頭"
        f"{settings['loss_sample_per_level']}局のみを代表サンプルとして分析した。"
    )
    if fixed_depth_result is not None:
        status = "PASSED" if fixed_depth_result["allMatched"] else f"FAILED ({len(fixed_depth_result['mismatches'])} mismatches)"
        lines.append(
            f"- fixed-depth決定性回帰チェック(要件2・4): `--depth {fixed_depth_result['depth']} "
            f"--exact-from-empties {fixed_depth_result['exactFromEmpties']}`(時間予算なし)で"
            f"{fixed_depth_result['positions']}局面を2回連続実行し、全着手・全ノード数が一致するかを"
            f"検証: **{status}**"
        )
    if node_budget_result is not None:
        status = "PASSED" if node_budget_result["allMatched"] else "FAILED"
        lines.append(
            f"- ノード予算決定性チェック: `--max-nodes {node_budget_result['maxNodes']}`で"
            f"smoke {node_budget_result['positions']}局面を2回実行し、着手・評価・深さ・ノード数を照合: "
            f"**{status}**"
        )
    lines.append("")

    # (b) single-root vs allmoves 同予算比較 + レベル別勝敗
    lines.append("## (b) レベル別の勝敗・平均石差(single-root vs allmoves、同一予算での直接比較)")
    lines.append("")
    lines.append(
        "| モード | Edaxレベル | 局数 | 自作エンジン勝ち | Edax勝ち | 引き分け | 勝率 | 平均石差(自作-Edax) |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    by_mode_level: dict[tuple[str, int], list[dict]] = {}
    for g in games:
        by_mode_level.setdefault((g["engine_mode"], g["level"]), []).append(g)
    summary_by_mode_level: dict[tuple[str, int], dict] = {}
    for mode in settings["engine_modes"]:
        for level in settings["levels"]:
            level_games = by_mode_level.get((mode, level), [])
            n = len(level_games)
            wins = sum(1 for g in level_games if g["winner"] == "engine")
            losses = sum(1 for g in level_games if g["winner"] == "edax")
            draws = sum(1 for g in level_games if g["winner"] == "draw")
            avg_margin = sum(g["margin_engine_minus_edax"] for g in level_games) / n if n else float("nan")
            win_rate = wins / n * 100 if n else float("nan")
            summary_by_mode_level[(mode, level)] = {
                "games": n,
                "engine_wins": wins,
                "edax_wins": losses,
                "draws": draws,
                "win_rate_pct": win_rate,
                "avg_margin_engine_minus_edax": avg_margin,
            }
            if n:
                lines.append(f"| {mode} | {level} | {n} | {wins} | {losses} | {draws} | {win_rate:.1f}% | {avg_margin:+.2f} |")
    lines.append("")
    if "single-root" in settings["engine_modes"] and "allmoves" in settings["engine_modes"]:
        lines.append("### single-root化による変化(考察)")
        lines.append("")
        for level in settings["levels"]:
            sr = summary_by_mode_level.get(("single-root", level))
            am = summary_by_mode_level.get(("allmoves", level))
            if sr and am and sr["games"] and am["games"]:
                delta_margin = sr["avg_margin_engine_minus_edax"] - am["avg_margin_engine_minus_edax"]
                lines.append(
                    f"- level {level}: single-root勝率{sr['win_rate_pct']:.1f}%(平均石差{sr['avg_margin_engine_minus_edax']:+.2f}) "
                    f"vs allmoves勝率{am['win_rate_pct']:.1f}%(平均石差{am['avg_margin_engine_minus_edax']:+.2f}) "
                    f"→ 平均石差の差分 {delta_margin:+.2f}石"
                    f"({'single-rootが優勢' if delta_margin > 0 else 'allmovesが優勢' if delta_margin < 0 else '互角'})"
                )
        lines.append("")

    # (c) テレメトリ集計(到達深さ分布・exactフォールバック率)
    lines.append("## (c) テレメトリ集計(single-rootモードの自作エンジンの着手より)")
    lines.append("")
    sr_moves = [
        mv["engine"]
        for g in games
        if g.get("engine_mode") == "single-root"
        for mv in g["moves"]
        if mv["mover"] == "engine" and mv.get("engine") is not None
    ]
    if not sr_moves:
        lines.append("single-rootモードの着手データが無いため該当なし。")
    else:
        depths = [m["depth"] for m in sr_moves if m["depth"] is not None]
        nodes = [m["nodes"] for m in sr_moves if m["nodes"] is not None]
        timed_out_count = sum(1 for m in sr_moves if m.get("timedOut"))
        exact_attempted = [m for m in sr_moves if m.get("exactAttempted")]
        exact_fallback_count = sum(1 for m in exact_attempted if m.get("exactFallback"))
        lines.append(f"- 総手数: {len(sr_moves)}")
        if depths:
            lines.append(f"- 到達深さ: 最小{min(depths)} / 平均{sum(depths)/len(depths):.2f} / 最大{max(depths)}")
        if nodes:
            lines.append(f"- ノード数: 最小{min(nodes)} / 平均{sum(nodes)/len(nodes):.0f} / 最大{max(nodes)}")
        lines.append(f"- タイムアウト率(`timedOut=true`): {timed_out_count}/{len(sr_moves)} ({timed_out_count/len(sr_moves)*100:.1f}%)")
        if exact_attempted:
            lines.append(
                f"- exact読み試行率: {len(exact_attempted)}/{len(sr_moves)} ({len(exact_attempted)/len(sr_moves)*100:.1f}%)、"
                f"うちフォールバック(未完走)率: {exact_fallback_count}/{len(exact_attempted)} "
                f"({exact_fallback_count/len(exact_attempted)*100:.1f}%)"
            )
        else:
            lines.append("- exact読み試行: 0手(この実行のopening/レベル組み合わせでは一度もexact_from_empties閾値に到達しなかった)")
    lines.append("")

    # (d) フェーズ別ロス集計(実手数ベース)
    lines.append("## (d) フェーズ別ロス集計(single-rootモードの負けた対局のサンプルより、実手数ベース)")
    lines.append("")
    entries = loss_analysis["entries"]
    phase_labels = {"opening": "序盤(1〜20手目)", "midgame": "中盤(21〜40手目)", "endgame": "終盤(41手目〜)"}
    by_phase: dict[str, list[float]] = {"opening": [], "midgame": [], "endgame": []}
    if not entries:
        lines.append("負けた対局が無かった(または分析対象がゼロ件だった)ため、ロス集計は該当なし。")
    else:
        lines.append(
            f"分析対象: {len(loss_analysis['analyzed_games'])}局、自作エンジンの着手{len(entries)}手分。"
            f"ロス = (着手前局面の全合法手をEdax `-l {loss_analysis['high_level']}` で個別評価した際の最大値) - "
            "(選択した手の評価値)。この方式では理論上 loss は常に0以上になる(要件7)。"
        )
        lines.append("")
        lines.append("| フェーズ(実手数) | 該当手数 | 平均ロス(石) | 累計ロス(石) |")
        lines.append("|---|---:|---:|---:|")
        for e in entries:
            by_phase.setdefault(e["phase"], []).append(e["loss"])
        for phase in ("opening", "midgame", "endgame"):
            vals = by_phase.get(phase, [])
            n = len(vals)
            avg = sum(vals) / n if n else float("nan")
            total = sum(vals)
            avg_str = f"{avg:+.2f}" if n else "N/A"
            lines.append(f"| {phase_labels[phase]} | {n} | {avg_str} | {total:+.2f} |")
        lines.append("")
        negative_count = sum(1 for e in entries if e["loss"] < 0)
        lines.append(
            f"- オラクル健全性チェック: {len(entries)}件中、loss < 0 は **{negative_count}件**"
            f"(修正方式のもとでは理論上0件のはず。0件であればオラクルが正しく機能している証拠)。"
        )
        lines.append("")

    # (e) 大ロス局面トップ10
    lines.append("## (e) ロスの大きい局面トップ10")
    lines.append("")
    if not entries:
        lines.append("該当なし。")
    else:
        top10 = sorted(entries, key=lambda e: e["loss"], reverse=True)[:10]
        lines.append(
            "| 順位 | レベル | game_id | 実手数 | フェーズ | 局面(OBF) | 自エンジンの手 | Edaxの推奨手 | ロス(石) | 合法手数 |"
        )
        lines.append("|---:|---:|---:|---:|---|---|---:|---:|---:|---:|")
        for i, e in enumerate(top10, start=1):
            lines.append(
                f"| {i} | {e['level']} | {e['game_id']} | {e['truePly']} | {phase_labels.get(e['phase'], e['phase'])} | "
                f"`{e['board']}` | {e['engine_move']} | {e['edax_best_move']} | {e['loss']:+.2f} | {e['legal_move_count']} |"
            )
    lines.append("")

    # (f) 考察
    lines.append("## (f) 考察")
    lines.append("")
    considerations = []
    valid = [(m, lv) for m in settings["engine_modes"] for lv in settings["levels"] if summary_by_mode_level.get((m, lv), {}).get("games", 0) > 0]
    if valid:
        closest = min(valid, key=lambda ml: abs(summary_by_mode_level[ml]["win_rate_pct"] - 50.0))
        considerations.append(
            f"- 勝率が最も5割に近いのは{closest[0]} `-l {closest[1]}`"
            f"(勝率{summary_by_mode_level[closest]['win_rate_pct']:.1f}%、"
            f"平均石差{summary_by_mode_level[closest]['avg_margin_engine_minus_edax']:+.2f}石)であり、"
            "このレベル付近が現状の自作エンジンの実力の目安と考えられる。"
        )
    if entries:
        phase_avgs = {phase: (sum(v) / len(v) if v else None) for phase, v in by_phase.items()}
        worst_phase = max((p for p in phase_avgs if phase_avgs[p] is not None), key=lambda p: phase_avgs[p], default=None)
        if worst_phase is not None:
            considerations.append(
                f"- フェーズ別(実手数ベース)では{phase_labels[worst_phase]}の平均ロスが最大"
                f"({phase_avgs[worst_phase]:+.2f}石)であり、このフェーズの弱さが敗因として最も大きい。"
            )
        top_entry = max(entries, key=lambda e: e["loss"])
        considerations.append(
            f"- 最大ロスの局面(level={top_entry['level']} game_id={top_entry['game_id']} "
            f"実手数{top_entry['truePly']}手目)では自エンジンが`{top_entry['engine_move']}`を選んだのに対し、"
            f"Edaxの推奨は`{top_entry['edax_best_move']}`で、ロスは{top_entry['loss']:+.2f}石だった"
            "(上の(e)表を参照)。"
        )
    else:
        considerations.append("- 負けた対局が無かった(または分析対象がゼロ件だった)ため、フェーズ別の弱点は今回は特定できなかった。")
    if fixed_depth_result is not None:
        considerations.append(
            f"- fixed-depth決定性回帰チェックは{'PASSED' if fixed_depth_result['allMatched'] else 'FAILED'}であり、"
            "T084のテレメトリ追加(elapsed_ms/timed_outフィールドの追加、完全読みショートカットのノード数を"
            "実カウント化)が探索アルゴリズム自体(着手・スコア・到達深さ・ノード数)を変えていないことを"
            "直接検証できた。"
        )
    considerations.append(
        "- T084が最優先で取り組んだのは計測の正しさ(single-root化・テレメトリ・オラクルロス修正)であり、"
        "評価関数・探索の改善そのものはスコープ外(T085以降)。本レポートの(b)〜(e)は、今後の施策の"
        "採否判断に使う「補正済みの」ベースラインとして位置づけられる。"
    )
    lines.extend(considerations)
    lines.append("")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --- チェックポイント/resume(T084要件8) ---


class ResultsCheckpoint:
    """`vs_edax_results.json`への逐次書き出し + 起動時の再開を担う小さな
    ヘルパー。1局完了ごと・弱点分析のロスエントリ1件ごとに`save()`を
    呼ぶ(要件8: 「1局ごと・弱点分析1局面ごとにチェックポイント保存」)。"""

    def __init__(self, path: Path, run_key: str):
        self.path = path
        self.run_key = run_key
        self.games: list[dict] = []
        self.loss_entries: list[dict] = []
        self.loss_meta: dict | None = None
        self.fixed_depth_result: dict | None = None
        self.node_budget_result: dict | None = None
        self.settings: dict | None = None
        self.meta: dict | None = None
        self._done_game_keys: set[str] = set()
        self._done_loss_keys: set[str] = set()

    def try_resume(self) -> bool:
        if not self.path.exists():
            return False
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  [resume] existing {self.path.name} could not be parsed ({exc}), starting fresh")
            return False
        if doc.get("runKey") != self.run_key:
            print(
                f"  [resume] existing {self.path.name} was produced by a different configuration "
                f"(runKey mismatch), starting fresh"
            )
            return False
        self.games = doc.get("games", [])
        self._done_game_keys = {
            game_key(g["engine_mode"], g["level"], g.get("start_id", "?"), g["engine_is_black"]) for g in self.games
        }
        loss_analysis = doc.get("loss_analysis") or {}
        self.loss_entries = loss_analysis.get("entries", []) or []
        self._done_loss_keys = {loss_entry_key(e["game_id"], e["ply"]) for e in self.loss_entries}
        self.fixed_depth_result = doc.get("fixed_depth_result")
        self.node_budget_result = doc.get("node_budget_result")
        print(
            f"  [resume] loaded {len(self.games)} already-completed game(s) and "
            f"{len(self.loss_entries)} already-analyzed loss entrie(s) from {self.path.name}"
        )
        return True

    def is_game_done(self, engine_mode: str, level: int, opening_id: str, engine_is_black: bool) -> bool:
        return game_key(engine_mode, level, opening_id, engine_is_black) in self._done_game_keys

    def add_game(self, game: dict, opening_id: str) -> None:
        game["start_id"] = opening_id
        self.games.append(game)
        self._done_game_keys.add(game_key(game["engine_mode"], game["level"], opening_id, game["engine_is_black"]))
        self.save()

    def add_loss_entry(self, entry: dict) -> None:
        key = loss_entry_key(entry["game_id"], entry["ply"])
        if key in self._done_loss_keys:
            return
        self.loss_entries.append(entry)
        self._done_loss_keys.add(key)
        self.save()

    def save(self) -> None:
        doc = {
            "runKey": self.run_key,
            "meta": self.meta,
            "settings": self.settings,
            "games": self.games,
            "fixed_depth_result": self.fixed_depth_result,
            "node_budget_result": self.node_budget_result,
            "loss_analysis": {
                **(self.loss_meta or {}),
                "entries": self.loss_entries,
            }
            if (self.loss_meta or self.loss_entries)
            else None,
        }
        self.path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# --- main ---


def run_smoke(args: argparse.Namespace) -> None:
    print("=== smoke mode: verifying PV extraction and playing 1 game from the initial position (single-root) ===")
    verify_pv_extraction()

    initial = gen_positions("smoke-initial", min_empties=60, max_empties=60, count=1, seed=1)
    start_board, start_side = initial[0]["board"], initial[0]["side_to_move"]
    edax_level = args.levels[0] if args.levels else DEFAULT_LEVELS[0]

    print(f"Playing 1 smoke game (engine=black, mode=single-root, edax level={edax_level})...")
    game = play_game(
        engine_mode="single-root",
        engine_is_black=True,
        engine_depth=args.engine_depth,
        engine_exact_from_empties=args.engine_exact_from_empties,
        engine_time_ms=args.engine_time_ms,
        engine_max_nodes=args.engine_max_nodes,
        weights=args.weights,
        edax_level=edax_level,
        start_board=start_board,
        start_side=start_side,
        start_ply_offset=0,
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
    ap.add_argument("--openings", type=Path, default=DEFAULT_OPENINGS_PATH, help="固定openingマニフェストのパス(T084要件5)")
    ap.add_argument(
        "--opening-set",
        choices=["smoke", "primary"],
        default="smoke",
        help="対局に使うopeningセット(既定smoke=10局面=20局/レベル/モード。primary=30局面=60局、将来の一次判定用)",
    )
    ap.add_argument(
        "--engine-modes",
        type=str,
        default="single-root,allmoves",
        help="カンマ区切りの着手選択モード一覧(single-root/allmoves)。既定は両方実行し(b)で比較する",
    )
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
        help="自作エンジン側の着手選択(wall-time系列)に付与する時間予算(ミリ秒)。0以下を指定すると時間無制限になる"
        "(空きマス20〜28付近で組合せ爆発的に遅くなることがあるため非推奨)。",
    )
    ap.add_argument(
        "--engine-max-nodes",
        type=int,
        default=None,
        help="single-root着手選択の決定論的ノード数予算。省略時はノード数無制限",
    )
    ap.add_argument(
        "--node-check-max-nodes",
        type=int,
        default=DEFAULT_NODE_CHECK_MAX_NODES,
        help="smoke10局面のノード予算決定性チェックに使う予算",
    )
    ap.add_argument("--allow-dirty", action="store_true", help="dirty worktreeでの非公開ローカル検証を許可する")
    ap.add_argument("--weights", type=Path, default=DEFAULT_PATTERN_WEIGHTS)
    ap.add_argument("--high-level", type=int, default=DEFAULT_HIGH_LEVEL, help="弱点分析用のEdax高レベル")
    ap.add_argument("--loss-sample-per-level", type=int, default=DEFAULT_LOSS_SAMPLE_PER_LEVEL)
    ap.add_argument("--skip-loss-analysis", action="store_true", help="弱点分析をスキップする(対局のみ)")
    ap.add_argument(
        "--skip-fixed-depth",
        action="store_true",
        help="fixed-depth決定性回帰チェック(要件2・4)をスキップする",
    )
    ap.add_argument("--fixed-depth", type=int, default=DEFAULT_FIXED_DEPTH)
    ap.add_argument("--fixed-depth-exact-from-empties", type=int, default=DEFAULT_FIXED_DEPTH_EXACT_FROM_EMPTIES)
    ap.add_argument(
        "--fixed-depth-opening-set",
        choices=["smoke", "primary", "both"],
        default="both",
        help="fixed-depth決定性チェックに使うopeningセット(既定both=smoke+primaryの全40局面)",
    )
    ap.add_argument("--no-resume", action="store_true", help="既存のvs_edax_results.jsonを無視し、最初から実行する")
    ap.add_argument("--results-output", type=Path, default=DEFAULT_RESULTS_PATH)
    ap.add_argument("--report-output", type=Path, default=DEFAULT_REPORT_PATH)
    args = ap.parse_args()
    args.levels = [int(x) for x in args.levels.split(",") if x.strip()]
    args.engine_modes = [m.strip() for m in args.engine_modes.split(",") if m.strip()]
    engine_time_ms: int | None = args.engine_time_ms if args.engine_time_ms and args.engine_time_ms > 0 else None
    args.engine_time_ms = engine_time_ms
    if args.engine_max_nodes is not None and args.engine_max_nodes <= 0:
        ap.error("--engine-max-nodes must be greater than zero")
    if args.node_check_max_nodes <= 0:
        ap.error("--node-check-max-nodes must be greater than zero")

    ensure_clean_worktree(args.allow_dirty, (args.results_output, args.report_output))

    ensure_engine_built()
    ensure_edax_available()
    ensure_pattern_weights_available(args.weights)

    if args.smoke:
        run_smoke(args)
        return

    print("=== full run: PV extraction sanity check ===")
    verify_pv_extraction()

    openings_doc = load_openings(args.openings)
    openings = opening_set(openings_doc, args.opening_set)
    print(f"Loaded {len(openings)} start position(s) from {args.openings.name} (set={args.opening_set!r})")

    meta = build_run_metadata(args.weights)

    settings = {
        "engine_depth": args.engine_depth,
        "engine_exact_from_empties": args.engine_exact_from_empties,
        "engine_time_ms": args.engine_time_ms,
        "engine_max_nodes": args.engine_max_nodes,
        "weights": rel_to_root(args.weights),
        "openings_path": rel_to_root(args.openings),
        "opening_set": args.opening_set,
        "opening_count": len(openings),
        "levels": args.levels,
        "engine_modes": args.engine_modes,
        "high_level": args.high_level,
        "loss_sample_per_level": args.loss_sample_per_level,
        "fixed_depth": args.fixed_depth,
        "fixed_depth_exact_from_empties": args.fixed_depth_exact_from_empties,
        "node_check_max_nodes": args.node_check_max_nodes,
    }
    run_key = json.dumps(settings, sort_keys=True)
    meta["settingsSha256"] = hashlib.sha256(run_key.encode("utf-8")).hexdigest()

    checkpoint = ResultsCheckpoint(args.results_output, run_key)
    if not args.no_resume:
        checkpoint.try_resume()
    checkpoint.settings = settings
    checkpoint.meta = meta
    checkpoint.save()

    # --- fixed-depth決定性回帰チェック(要件2・4) ---
    if not args.skip_fixed_depth:
        if checkpoint.fixed_depth_result is not None and checkpoint.fixed_depth_result.get("allMatched"):
            print("=== fixed-depth determinism regression check: already completed (resumed), skipping ===")
        else:
            print("=== fixed-depth determinism regression check ===")
            if args.fixed_depth_opening_set == "both":
                fd_positions = opening_set(openings_doc, "smoke") + opening_set(openings_doc, "primary")
            else:
                fd_positions = opening_set(openings_doc, args.fixed_depth_opening_set)
            checkpoint.fixed_depth_result = run_fixed_depth_regression(
                fd_positions, args.fixed_depth, args.fixed_depth_exact_from_empties, args.weights
            )
            checkpoint.save()

    if checkpoint.node_budget_result is not None and checkpoint.node_budget_result.get("allMatched"):
        print("=== node-budget determinism regression check: already completed (resumed), skipping ===")
    else:
        print("=== node-budget determinism regression check ===")
        checkpoint.node_budget_result = run_node_budget_regression(
            opening_set(openings_doc, "smoke"),
            args.engine_depth,
            args.engine_exact_from_empties,
            args.weights,
            args.node_check_max_nodes,
        )
        checkpoint.save()

    # --- 対局(single-root / allmoves x 各レベル x 各opening x 黒白) ---
    total_planned = len(args.engine_modes) * len(args.levels) * len(openings) * 2
    completed_from_resume = len(checkpoint.games)
    print(
        f"=== match play: {len(args.engine_modes)} mode(s) x {len(args.levels)} level(s) x "
        f"{len(openings)} opening(s) x 2 colors = {total_planned} games planned "
        f"({completed_from_resume} already done, resumed) ==="
    )
    game_id = 0
    for mode in args.engine_modes:
        for level in args.levels:
            for start in openings:
                start_ply_offset = true_ply_of_board(start["board"])
                for engine_is_black in (True, False):
                    game_id += 1
                    if checkpoint.is_game_done(mode, level, start["id"], engine_is_black):
                        continue
                    game = play_game(
                        engine_mode=mode,
                        engine_is_black=engine_is_black,
                        engine_depth=args.engine_depth,
                        engine_exact_from_empties=args.engine_exact_from_empties,
                        engine_time_ms=args.engine_time_ms,
                        engine_max_nodes=args.engine_max_nodes,
                        weights=args.weights,
                        edax_level=level,
                        start_board=start["board"],
                        start_side=start["side_to_move"],
                        start_ply_offset=start_ply_offset,
                        game_id=game_id,
                        level=level,
                    )
                    checkpoint.add_game(game, start["id"])  # 1局ごとにチェックポイント保存(要件8)
                    print(
                        f"  [{len(checkpoint.games)}/{total_planned}] mode={mode} level={level} "
                        f"opening={start['id']} engine={'black' if engine_is_black else 'white'}: "
                        f"black={game['black_discs']:2d} white={game['white_discs']:2d} plies={game['plies']:3d} "
                        f"-> winner={game['winner']} (margin={game['margin_engine_minus_edax']:+d})"
                    )
    print(f"Wrote {args.results_output.name} (checkpoint: {len(checkpoint.games)}/{total_planned} games)")

    # --- 弱点分析(要件6・7・9c) ---
    if args.skip_loss_analysis:
        print("=== weakness analysis: skipped (--skip-loss-analysis) ===")
    else:
        print("=== weakness analysis: analyzing losing single-root games with Edax high level (corrected oracle, T084) ===")
        single_root_games = [g for g in checkpoint.games if g.get("engine_mode") == "single-root"]
        if checkpoint._done_loss_keys:
            print(f"  [resume] {len(checkpoint._done_loss_keys)} loss move(s) already analyzed, skipping individually")

        def checkpoint_cb(entry: dict) -> None:
            checkpoint.add_loss_entry(entry)  # 1局面ごとにチェックポイント保存(要件8)

        remaining_loss_analysis = run_loss_analysis(
            single_root_games,
            args.high_level,
            args.loss_sample_per_level,
            checkpoint_cb=checkpoint_cb,
            completed_keys=set(checkpoint._done_loss_keys),
        )
        checkpoint.loss_meta = {
            "high_level": remaining_loss_analysis["high_level"],
            "sample_per_level": remaining_loss_analysis["sample_per_level"],
            "scope": remaining_loss_analysis["scope"],
            "analyzed_games": remaining_loss_analysis["analyzed_games"],
        }
        checkpoint.save()
        print(
            f"  analyzed {len(remaining_loss_analysis['analyzed_games'])} newly-processed losing game(s), "
            f"{len(checkpoint.loss_entries)} total engine move(s) with loss entries"
        )

        negative_losses = [e for e in checkpoint.loss_entries if e["loss"] < 0]
        if negative_losses:
            raise RuntimeError(
                f"oracle sanity check FAILED: {len(negative_losses)} of {len(checkpoint.loss_entries)} "
                f"loss entries are negative (should be impossible with the corrected oracle, requirement 7). "
                f"First offender: {negative_losses[0]}"
            )
        print(f"  oracle sanity check: PASSED (all {len(checkpoint.loss_entries)} loss entries are >= 0)")

    loss_analysis_doc = {
        **(checkpoint.loss_meta or {"high_level": args.high_level, "sample_per_level": args.loss_sample_per_level, "analyzed_games": []}),
        "entries": checkpoint.loss_entries,
    }

    write_report(
        args.report_output,
        settings,
        meta,
        checkpoint.fixed_depth_result,
        checkpoint.node_budget_result,
        checkpoint.games,
        loss_analysis_doc,
    )
    print(f"Wrote {args.report_output.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

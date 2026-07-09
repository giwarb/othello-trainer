#!/usr/bin/env python3
"""T043: パターン評価(T041で学習した`train/weights/pattern_v1.bin`)と
旧3項ヒューリスティック評価(`engine/src/eval.rs`)を、それぞれEdaxの評価値との
近さで比較する検証スクリプト。

T022/T024(`run-comparison.py`)で整備した比較基盤(`eval_cli gen`による局面生成、
Edaxの`-solve`実行・出力パース)を再利用しつつ、`eval_cli eval`
(T043で追加した`--pattern-weights PATH`オプション)を使って
「旧3項評価」「新パターン評価」「Edax」の3系統の評価値を同一局面セットで比較する。

やること:
  1. `eval_cli gen`でopening/midgame局面を生成する(`run-comparison.py`と
     同じ生成方式・パラメータ)。
  2. 各局面について、探索深さを揃えた(depth-limited)評価値を
     (a) 旧3項ヒューリスティック評価(`eval_cli eval`、`--pattern-weights`無し)
     (b) 新パターン評価(`eval_cli eval --pattern-weights train/weights/pattern_v1.bin`)
     (c) Edax(`wEdax-x86-64.exe -solve -l MIDGAME_DEPTH`)
     の3系統で計算する。
  3. Edaxとの平均絶対誤差(MAE)・符号一致率を(a)(b)それぞれについて集計し、
     `pattern_eval_report.md`に書き出す(要件4: 「Edaxに近づいたか」の直接測定)。

前提: `bench/edax-compare/edax-extract/`にEdaxが展開済み(`download-edax.ps1`)、
`cargo build --release -p engine --bin eval_cli`でビルド済みであること
(未ビルドなら自動でビルドする)。`train/weights/pattern_v1.bin`が存在すること
(T041で生成済み)。

実行方法(リポジトリルートから):
    python bench/edax-compare/compare_pattern_eval.py
"""

from __future__ import annotations

import functools
import json
import re
import subprocess
import sys
from pathlib import Path

print = functools.partial(print, flush=True)

ROOT = Path(__file__).resolve().parents[2]
COMPARE_DIR = Path(__file__).resolve().parent
EVAL_CLI = ROOT / "target" / "release" / "eval_cli.exe"
EDAX_DIR = COMPARE_DIR / "edax-extract"
EDAX_EXE = EDAX_DIR / "wEdax-x86-64.exe"
EDAX_EVAL_DATA = EDAX_DIR / "data" / "eval.dat"
PATTERN_WEIGHTS = ROOT / "train" / "weights" / "pattern_v1.bin"

# run-comparison.py(T022/T024)と同じ探索深さ・局面生成パラメータを使い、
# 過去の結果と直接比較できるようにする。
MIDGAME_DEPTH = 10

OPENING_MIN_EMPTIES = 55
OPENING_MAX_EMPTIES = 59
OPENING_COUNT = 8
OPENING_SEED = 1000

MIDGAME_MIN_EMPTIES = 20
MIDGAME_MAX_EMPTIES = 40
MIDGAME_COUNT = 20
MIDGAME_SEED = 2000


def run(cmd: list[str], input_text: str | None = None, cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstderr={result.stderr}")
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


def ensure_pattern_weights_available() -> None:
    if not PATTERN_WEIGHTS.exists():
        raise RuntimeError(
            f"{PATTERN_WEIGHTS} not found. Run `cargo run -p train --release --bin train_patterns` first (T041)."
        )


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


def engine_eval(positions: list[dict], depth: int, pattern_weights: bool) -> list[dict]:
    if not positions:
        return []
    input_json = json.dumps(positions)
    cmd = [str(EVAL_CLI), "eval", "--depth", str(depth), "--exact-from-empties", "0"]
    if pattern_weights:
        cmd += ["--pattern-weights", str(PATTERN_WEIGHTS)]
    out = run(cmd, input_text=input_json)
    return json.loads(out)


# Edaxの `-solve -vv` 出力から、最後の "depth score ... nodes ... PV" 行の
# depthとscoreを取り出す正規表現(`run-comparison.py`と同じ)。
_EDAX_ROW_RE = re.compile(r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s")


def edax_solve(board: str, side_to_move: str, level: int) -> dict:
    side_char = "X" if side_to_move == "black" else "O"
    obf_line = f"{board} {side_char};\n"

    tmp_obf = EDAX_DIR / "_t043_tmp.obf"
    tmp_obf.write_text(obf_line, encoding="ascii")

    out = run(
        [
            str(EDAX_EXE),
            "-solve",
            str(tmp_obf),
            "-l",
            str(level),
            "-eval-file",
            str(EDAX_EVAL_DATA),
            "-book-usage",
            "off",
            "-vv",
        ],
        cwd=EDAX_DIR,
    )

    last_depth = None
    last_score = None
    for line in out.splitlines():
        m = _EDAX_ROW_RE.match(line)
        if m:
            last_depth = int(m.group(1))
            last_score = int(m.group(2))

    if last_score is None:
        raise RuntimeError(f"failed to parse Edax output for board={board}:\n{out}")

    return {"depth": last_depth, "discDiff": float(last_score)}


def sign(x: float) -> int:
    if x > 0:
        return 1
    if x < 0:
        return -1
    return 0


def main() -> None:
    ensure_engine_built()
    ensure_edax_available()
    ensure_pattern_weights_available()

    print("Generating opening positions...")
    opening = gen_positions("opening", OPENING_MIN_EMPTIES, OPENING_MAX_EMPTIES, OPENING_COUNT, OPENING_SEED)
    print(f"  {len(opening)} positions")

    print("Generating midgame positions...")
    midgame = gen_positions("midgame", MIDGAME_MIN_EMPTIES, MIDGAME_MAX_EMPTIES, MIDGAME_COUNT, MIDGAME_SEED)
    print(f"  {len(midgame)} positions")

    all_positions = opening + midgame

    print("Evaluating with heuristic (3-feature) eval...")
    heuristic_results = {r["id"]: r for r in engine_eval(all_positions, MIDGAME_DEPTH, pattern_weights=False)}

    print("Evaluating with pattern eval (T041 weights)...")
    pattern_results = {r["id"]: r for r in engine_eval(all_positions, MIDGAME_DEPTH, pattern_weights=True)}

    print("Evaluating with Edax...")
    edax_results: dict[str, dict] = {}
    for p in all_positions:
        edax_results[p["id"]] = edax_solve(p["board"], p["side_to_move"], MIDGAME_DEPTH)

    comparison = []
    for p in all_positions:
        pid = p["id"]
        h = heuristic_results.get(pid, {})
        pt = pattern_results.get(pid, {})
        x = edax_results.get(pid, {})
        heuristic_diff = h.get("searchDiscDiff")
        pattern_diff = pt.get("searchDiscDiff")
        edax_diff = x.get("discDiff")
        comparison.append(
            {
                "id": pid,
                "category": p["category"],
                "empties": h.get("empties"),
                "heuristic_disc_diff": heuristic_diff,
                "pattern_disc_diff": pattern_diff,
                "edax_disc_diff": edax_diff,
                "heuristic_abs_err": abs(heuristic_diff - edax_diff) if heuristic_diff is not None and edax_diff is not None else None,
                "pattern_abs_err": abs(pattern_diff - edax_diff) if pattern_diff is not None and edax_diff is not None else None,
                "heuristic_sign_agree": sign(heuristic_diff) == sign(edax_diff) if heuristic_diff is not None and edax_diff is not None else None,
                "pattern_sign_agree": sign(pattern_diff) == sign(edax_diff) if pattern_diff is not None and edax_diff is not None else None,
            }
        )

    (COMPARE_DIR / "pattern_eval_raw_results.json").write_text(
        json.dumps({"settings": {"midgame_depth": MIDGAME_DEPTH}, "comparison": comparison}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print("Wrote pattern_eval_raw_results.json")

    write_report(comparison)
    print("Wrote pattern_eval_report.md")


def write_report(comparison: list[dict]) -> None:
    lines = []
    lines.append("# T043: パターン評価 vs 旧3項ヒューリスティック評価 — Edax(v4.6)との近さ比較")
    lines.append("")
    lines.append(
        "本レポートは自動生成される(`bench/edax-compare/compare_pattern_eval.py`)。"
        "再生成する場合は `python bench/edax-compare/compare_pattern_eval.py` を実行すること"
        "(事前に `train/weights/pattern_v1.bin`(T041)と Edax(`download-edax.ps1`)が必要)。"
    )
    lines.append("")
    lines.append(
        f"局面セットは`run-comparison.py`(T022/T024)と同じopening({OPENING_COUNT}局面)"
        f"/midgame({MIDGAME_COUNT}局面)生成パラメータを使用(探索深さ{MIDGAME_DEPTH}手読み、"
        "本エンジン・Edax共通)。"
    )
    lines.append("")

    valid = [c for c in comparison if c["heuristic_abs_err"] is not None and c["pattern_abs_err"] is not None]
    n = len(valid)
    heuristic_mae = sum(c["heuristic_abs_err"] for c in valid) / n if n else float("nan")
    pattern_mae = sum(c["pattern_abs_err"] for c in valid) / n if n else float("nan")
    heuristic_agree = sum(1 for c in valid if c["heuristic_sign_agree"])
    pattern_agree = sum(1 for c in valid if c["pattern_sign_agree"])

    lines.append("## Edaxとの平均絶対誤差(MAE)・符号一致率")
    lines.append("")
    lines.append("| 評価関数 | 局面数 | Edaxとの平均絶対誤差(石) | 符号一致 | 符号一致率 |")
    lines.append("|---|---:|---:|---:|---:|")
    lines.append(f"| 旧3項ヒューリスティック評価 | {n} | {heuristic_mae:.2f} | {heuristic_agree} | {heuristic_agree / n * 100:.1f}% |" if n else "| 旧3項ヒューリスティック評価 | 0 | N/A | N/A | N/A |")
    lines.append(f"| 新パターン評価(T041) | {n} | {pattern_mae:.2f} | {pattern_agree} | {pattern_agree / n * 100:.1f}% |" if n else "| 新パターン評価(T041) | 0 | N/A | N/A | N/A |")
    lines.append("")

    lines.append("## カテゴリ別")
    lines.append("")
    lines.append("| カテゴリ | 局面数 | 旧評価MAE | 新評価MAE | 旧評価符号一致率 | 新評価符号一致率 |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for cat in ["opening", "midgame"]:
        items = [c for c in valid if c["category"] == cat]
        m = len(items)
        if m == 0:
            lines.append(f"| {cat} | 0 | N/A | N/A | N/A | N/A |")
            continue
        h_mae = sum(c["heuristic_abs_err"] for c in items) / m
        p_mae = sum(c["pattern_abs_err"] for c in items) / m
        h_agree = sum(1 for c in items if c["heuristic_sign_agree"]) / m * 100
        p_agree = sum(1 for c in items if c["pattern_sign_agree"]) / m * 100
        lines.append(f"| {cat} | {m} | {h_mae:.2f} | {p_mae:.2f} | {h_agree:.1f}% | {p_agree:.1f}% |")
    lines.append("")

    lines.append("## 局面ごとの詳細")
    lines.append("")
    lines.append("| id | 空きマス数 | 旧評価 | 新評価 | Edax | 旧誤差 | 新誤差 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for c in comparison:
        lines.append(
            f"| {c['id']} | {c['empties']} | {c['heuristic_disc_diff']} | {c['pattern_disc_diff']} | "
            f"{c['edax_disc_diff']} | {c['heuristic_abs_err']} | {c['pattern_abs_err']} |"
        )
    lines.append("")

    lines.append("## 結論")
    lines.append("")
    if n:
        if pattern_mae < heuristic_mae:
            lines.append(
                f"- 新パターン評価はEdaxとの平均絶対誤差が**{pattern_mae:.2f}石**であり、"
                f"旧3項評価の{heuristic_mae:.2f}石より小さい(Edaxに近づいた)。"
            )
        else:
            lines.append(
                f"- 新パターン評価のEdaxとの平均絶対誤差は{pattern_mae:.2f}石であり、"
                f"旧3項評価の{heuristic_mae:.2f}石を下回っていない(悪化または同水準)。"
            )
        lines.append(
            f"- 符号一致率は旧評価{heuristic_agree / n * 100:.1f}% -> 新評価{pattern_agree / n * 100:.1f}%。"
        )
    lines.append("")

    (COMPARE_DIR / "pattern_eval_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

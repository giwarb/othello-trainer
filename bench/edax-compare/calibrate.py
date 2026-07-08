#!/usr/bin/env python3
"""T024: 評価関数の重み較正 — Edaxの評価値への線形回帰。

やること:
  1. T022の `positions.json`(opening 8 + midgame 20)に加え、
     `eval_cli_baseline.exe gen` で追加のopening/midgame局面を生成し、
     計70局面前後(opening/midgameバランスよく)のデータセットを作る。
  2. 各局面について、本エンジンの生の特徴量差分(モビリティ差・隅差・安定石差、
     黒視点、`eval_cli_baseline.exe eval` の `featureDiffs`)を取得する。
  3. 同じ局面をEdax(`-l 12`)で評価し、side_to_move視点の評価値を取得、
     黒視点に変換する(featureDiffsも黒視点なので、targetを黒視点に揃える)。
  4. 最小二乗法(numpy.linalg.lstsq)で
     edax_black_diff ≈ a*mobility_diff + b*corner_diff + c*stable_diff
     を解き、新しい重み(centi-disc単位、x100して丸め)を求める。
  5. 較正データセット・回帰結果を `calibration_data.json` に保存する。

`eval_cli_baseline.exe` は較正前(重み変更前)にビルド済みのバイナリを使う
(重み変更後にビルドし直した `eval_cli.exe` ではなく、この時点では両者とも
同一の生の特徴量を返すはずだが、featureDiffsは重みに依存しない値なので
どちらを使っても結果は同じ。baselineを使うことで「重み変更前のデータで
較正した」という経緯を明確にする)。

実行方法(リポジトリルートから):
    python bench/edax-compare/calibrate.py
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
EVAL_CLI = COMPARE_DIR / "eval_cli_baseline.exe"
EDAX_DIR = COMPARE_DIR / "edax-extract"
EDAX_EXE = EDAX_DIR / "wEdax-x86-64.exe"
EDAX_EVAL_DATA = EDAX_DIR / "data" / "eval.dat"

EDAX_LEVEL = 12  # T022のMIDGAME_DEPTH(10)よりやや深く、質を上げる。


def run(cmd: list[str], input_text: str | None = None, cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, input=input_text, capture_output=True, text=True, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {cmd}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result.stdout


def gen_positions(category: str, min_empties: int, max_empties: int, count: int, seed: int) -> list[dict]:
    out = run([str(EVAL_CLI), "gen", "--category", category, "--min-empties", str(min_empties),
               "--max-empties", str(max_empties), "--count", str(count), "--seed", str(seed)])
    return json.loads(out)


def engine_features(positions: list[dict]) -> dict[str, dict]:
    if not positions:
        return {}
    input_json = json.dumps(positions)
    out = run([str(EVAL_CLI), "eval", "--depth", "1", "--exact-from-empties", "0"], input_text=input_json)
    results = json.loads(out)
    return {r["id"]: r for r in results}


_EDAX_ROW_RE = re.compile(r"^\s*(\d+)(?:@\d+%)?\s+([+-]?\d+)\s")


def edax_solve(board: str, side_to_move: str, level: int) -> float:
    side_char = "X" if side_to_move == "black" else "O"
    obf_line = f"{board} {side_char};\n"
    tmp_obf = EDAX_DIR / "_t024_tmp.obf"
    tmp_obf.write_text(obf_line, encoding="ascii")
    out = run(
        [str(EDAX_EXE), "-solve", str(tmp_obf), "-l", str(level), "-eval-file", str(EDAX_EVAL_DATA),
         "-book-usage", "off", "-vv"],
        cwd=EDAX_DIR,
    )
    last_score = None
    for line in out.splitlines():
        m = _EDAX_ROW_RE.match(line)
        if m:
            last_score = int(m.group(2))
    if last_score is None:
        raise RuntimeError(f"failed to parse Edax output for board={board}:\n{out}")
    return float(last_score)


def main() -> None:
    if not EVAL_CLI.exists():
        raise RuntimeError(f"{EVAL_CLI} not found. Build baseline eval_cli.exe first (see task T024 notes).")
    if not EDAX_EXE.exists():
        raise RuntimeError(f"Edax not found at {EDAX_EXE}. Run download-edax.ps1 first.")

    print("Loading T022 positions.json (opening+midgame)...")
    t022 = json.loads((COMPARE_DIR / "positions.json").read_text(encoding="utf-8"))
    reused = [p for p in t022["positions"] if p["category"] in ("opening", "midgame")]
    print(f"  reused {len(reused)} positions from T022")

    print("Generating additional opening positions...")
    opening2 = gen_positions("opening2", 45, 59, 20, seed=5000)
    print(f"  {len(opening2)} positions")

    print("Generating additional midgame positions...")
    midgame2 = gen_positions("midgame2", 16, 44, 32, seed=6000)
    print(f"  {len(midgame2)} positions")

    all_positions = reused + opening2 + midgame2
    print(f"Total dataset: {len(all_positions)} positions")

    print("Computing engine feature diffs...")
    feat = engine_features(all_positions)

    print("Evaluating with Edax (this can take a while)...")
    rows = []
    for i, p in enumerate(all_positions):
        f = feat.get(p["id"])
        if f is None or f.get("featureDiffs") is None:
            continue
        edax_stm = edax_solve(p["board"], p["side_to_move"], EDAX_LEVEL)
        edax_black = edax_stm if p["side_to_move"] == "black" else -edax_stm
        row = {
            "id": p["id"],
            "category": p["category"],
            "empties": f.get("empties"),
            "side_to_move": p["side_to_move"],
            "mobility_diff": f["featureDiffs"]["mobility"],
            "corner_diff": f["featureDiffs"]["corner"],
            "stable_diff": f["featureDiffs"]["stable"],
            "edax_disc_diff_stm": edax_stm,
            "edax_disc_diff_black": edax_black,
        }
        rows.append(row)
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(all_positions)} done")

    print(f"Collected {len(rows)} rows with valid features+Edax value.")

    (COMPARE_DIR / "calibration_data.json").write_text(
        json.dumps({"edax_level": EDAX_LEVEL, "rows": rows}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print("Wrote calibration_data.json")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""T192: Logistello book(24空き局面)の全件抽出から、固定シードで層化サンプリング
した100局面のcuratedセットを選ぶ。

入力: `train::bin::logistello_extract`が書き出す全件JSON
      (既定 `bench/logistello/data/logistello_24empty_positions.json`。
      生データ由来のためコミット対象外)。
出力: `bench/logistello/logistello_wld_sample_positions.json` +
      `bench/logistello/logistello_wld_sample_labels.json`
      (t157形式に準拠したpositions/labels分離形式。コミット対象)。

層化: `theoreticalScore`(黒視点の最終石数、0..64)から黒石差
`2*theoreticalScore-64`を計算し、符号で `black_win` / `black_loss` / `draw`
の3カテゴリに分ける。件数比例配分(最大剰余法)し、`draw`は最低5局面を確保する。

`expectedScoreSideToMove`/`expectedWldSideToMove`は、
「theoreticalScoreは黒の最終石数であり、このbookの全ラインは24空き以降が
確定的に最適継続されている」という仮説に基づく期待値であり、
`verify_wld.py`によるeval_cli solveでの照合(このタスクの本題)より前の
時点では未検証(labelsファイルの`metadata.verified`は`false`のまま出力する)。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from random import Random

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EXTRACTION = ROOT / "bench/logistello/data/logistello_24empty_positions.json"
DEFAULT_WTB = ROOT / "bench/logistello/data/logbook.wtb"
DEFAULT_WTB_GZ = ROOT / "bench/logistello/data/logbook.wtb.gz"
DEFAULT_POSITIONS_OUT = ROOT / "bench/logistello/logistello_wld_sample_positions.json"
DEFAULT_LABELS_OUT = ROOT / "bench/logistello/logistello_wld_sample_labels.json"

SEED = "logistello-t192"
TOTAL = 100
MIN_DRAW = 5
CATEGORIES = ("black_win", "black_loss", "draw")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def category_of(theoretical_score: int) -> str:
    diff = 2 * theoretical_score - 64
    if diff > 0:
        return "black_win"
    if diff < 0:
        return "black_loss"
    return "draw"


def largest_remainder_quotas(counts: dict[str, int], total: int, min_draw: int) -> dict[str, int]:
    """カテゴリごとの母集団件数に比例した割当を、合計がちょうど`total`になる
    よう最大剰余法で決める。`draw`だけ最低`min_draw`を保証し、その分は
    残り2カテゴリから比例的に差し引く。
    """
    grand_total = sum(counts.values())
    raw = {category: total * count / grand_total for category, count in counts.items()}
    quotas = {category: int(value) for category, value in raw.items()}
    remainders = sorted(
        counts.keys(), key=lambda category: raw[category] - quotas[category], reverse=True
    )
    remaining = total - sum(quotas.values())
    for category in remainders:
        if remaining <= 0:
            break
        quotas[category] += 1
        remaining -= 1

    if quotas.get("draw", 0) < min_draw:
        shortfall = min_draw - quotas.get("draw", 0)
        quotas["draw"] = min_draw
        donors = sorted(
            (c for c in counts if c != "draw"), key=lambda c: quotas[c], reverse=True
        )
        for category in donors:
            if shortfall <= 0:
                break
            take = min(shortfall, max(quotas[category] - 1, 0))
            quotas[category] -= take
            shortfall -= take
        if shortfall > 0:
            raise RuntimeError("could not free up enough quota from non-draw categories for min_draw")

    for category, quota in quotas.items():
        if quota > counts[category]:
            raise RuntimeError(
                f"stratum {category}: need {quota}, only {counts[category]} eligible"
            )
    assert sum(quotas.values()) == total
    return quotas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extraction", type=Path, default=DEFAULT_EXTRACTION)
    parser.add_argument("--wtb", type=Path, default=DEFAULT_WTB)
    parser.add_argument("--wtb-gz", type=Path, default=DEFAULT_WTB_GZ)
    parser.add_argument("--positions-out", type=Path, default=DEFAULT_POSITIONS_OUT)
    parser.add_argument("--labels-out", type=Path, default=DEFAULT_LABELS_OUT)
    parser.add_argument("--total", type=int, default=TOTAL)
    parser.add_argument("--min-draw", type=int, default=MIN_DRAW)
    args = parser.parse_args()

    extraction = read_json(args.extraction)
    all_positions = extraction["positions"]
    # 抽出ツール(logistello_extract)の出力順(=lineIndex昇順)で固定する。
    all_positions = sorted(all_positions, key=lambda p: p["lineIndex"])

    by_category: dict[str, list[dict]] = {category: [] for category in CATEGORIES}
    for position in all_positions:
        by_category[category_of(position["theoreticalScore"])].append(position)

    eligible_counts = {category: len(rows) for category, rows in by_category.items()}
    quotas = largest_remainder_quotas(eligible_counts, args.total, args.min_draw)

    rng = Random(SEED)
    selected: list[dict] = []
    strata_audit = []
    for category in CATEGORIES:
        quota = quotas[category]
        chosen = rng.sample(by_category[category], quota)
        strata_audit.append({
            "category": category,
            "eligible": eligible_counts[category],
            "selected": quota,
        })
        for position in chosen:
            selected.append({**position, "category": category})

    selected.sort(key=lambda p: p["lineIndex"])

    positions_out = []
    for number, position in enumerate(selected, 1):
        positions_out.append({
            "id": f"t192-logistello-{number:03d}",
            "board": position["board"],
            "side_to_move": position["side_to_move"],
            "empties": position["empties"],
            "lineIndex": position["lineIndex"],
            "fullGameMoveCount": position["fullGameMoveCount"],
            "category": position["category"],
        })

    stats = extraction["stats"]
    positions_doc = {
        "schemaVersion": 1,
        "purpose": (
            "T192 Logistello book independent WLD/exact-score cross-check "
            "(third-party self-play games, verified 24-ply-empty WLD-correct by the book's author)"
        ),
        "provenance": {
            "sourceUrl": "https://skatgame.net/mburo/logbook.wtb.gz",
            "sourcePage": "https://skatgame.net/mburo/log.html",
            "license": "GPL (Michael Buro)",
            "wtbSha256": sha256(args.wtb) if args.wtb.exists() else None,
            "wtbGzSha256": sha256(args.wtb_gz) if args.wtb_gz.exists() else None,
            "extractionCommand": (
                "cargo run -p train --release --bin logistello_extract -- "
                "--input bench/logistello/data/logbook.wtb "
                "--out bench/logistello/data/logistello_24empty_positions.json"
            ),
            "fullExtractionStats": stats,
        },
        "selection": {
            "seed": SEED,
            "rng": "Python random.Random, seeded with the literal string above (MT19937)",
            "procedure": [
                "Sort all extracted 24-empty positions by lineIndex (extraction order, deterministic).",
                "Categorize by sign of 2*theoreticalScore-64: black_win / black_loss / draw.",
                "Allocate 100 slots proportionally to category population via largest-remainder "
                "rounding, with draw floored at 5 (borrowing from the other two categories).",
                "random.Random(seed).sample() without replacement within each category.",
                "Sort the final selection by lineIndex for a deterministic output order.",
            ],
            "strata": strata_audit,
        },
        "counts": {
            "total": len(positions_out),
            "byCategory": dict(Counter(p["category"] for p in positions_out)),
        },
        "positions": positions_out,
    }

    args.positions_out.parent.mkdir(parents=True, exist_ok=True)
    positions_text = json.dumps(positions_doc, indent=2, ensure_ascii=False) + "\n"
    args.positions_out.write_text(positions_text, encoding="utf-8", newline="\n")

    rows = []
    for position in selected:
        theo = position["theoreticalScore"]
        black_diff = 2 * theo - 64
        side = position["side_to_move"]
        expected_score_side_to_move = black_diff if side == "black" else -black_diff
        if expected_score_side_to_move > 0:
            expected_wld = "win"
        elif expected_score_side_to_move < 0:
            expected_wld = "loss"
        else:
            expected_wld = "draw"
        id_ = next(p["id"] for p in positions_out if p["lineIndex"] == position["lineIndex"])
        rows.append({
            "id": id_,
            "theoreticalScore": theo,
            "blackDiscCountAtGameEnd": position["blackDiscCountAtGameEnd"],
            "expectedScoreSideToMove": expected_score_side_to_move,
            "expectedWldSideToMove": expected_wld,
        })

    labels_doc = {
        "schemaVersion": 1,
        "metadata": {
            "positionsSha256": hashlib.sha256(positions_text.encode("utf-8")).hexdigest(),
            "labelDefinition": (
                "theoreticalScore/blackDiscCountAtGameEnd are verbatim from the WTHOR-format "
                "record (both fields are byte-identical across all ~37.7k lines in this book, "
                "confirmed empirically -- see t192_verification_report.md). "
                "expectedScoreSideToMove/expectedWldSideToMove below are a HYPOTHESIS, not yet "
                "independently verified by exact search."
            ),
            "hypothesis": (
                "theoreticalScore is Black's final disc count (0..64) under the line's "
                "confirmed-optimal continuation from 24 empties onward, so the exact score "
                "of the extracted 24-empty position, from the side-to-move's perspective, is "
                "expectedScoreSideToMove = (2*theoreticalScore-64) if side_to_move == 'black' "
                "else -(2*theoreticalScore-64)."
            ),
            "verified": False,
            "verificationTool": "bench/logistello/verify_wld.py (eval_cli solve, full window)",
        },
        "totalPositions": len(rows),
        "rows": rows,
    }
    args.labels_out.write_text(
        json.dumps(labels_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )

    print(f"wrote {args.positions_out}: {len(positions_out)} positions")
    print(f"wrote {args.labels_out}: {len(rows)} labels")
    print(f"strata: {strata_audit}")


if __name__ == "__main__":
    main()

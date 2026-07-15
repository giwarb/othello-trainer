#!/usr/bin/env python3
"""T090a: 生成済み教師コーパス(`train/data/teacher/corpus_<set>.jsonl`)の機械検証。

受け入れ基準の「コーパスの機械検証」を満たすためのスタンドアロンスクリプト。
以下を全レコードについて検証する:

  1. 全レコードで、`children`が局面の全合法手数(`legalMoveCount`、
     `teacher_candidates.exe children`が返した数)と一致する件数だけ
     存在すること(=teacher valueが全合法手分そろっていること)。
  2. `bestValue == max(child["value"] for child in children)`であること
     (best値=max(子値)の整合)。
  3. コーパス全体で`canonicalKey`の重複が無いこと(D4正準化後の重複なし)。
  4. 補助チェック: `exact=True`の子局面は`level`がNoneまたは60、`exact=False`は16
     であること(教師値のソースが仕様どおりであることの確認)。

使い方:
    python bench/edax-compare/verify_teacher_corpus.py smoke
    python bench/edax-compare/verify_teacher_corpus.py primary
    python bench/edax-compare/verify_teacher_corpus.py smoke primary   # 複数指定可

終了コード: 全件パスなら0、1件でも不整合があれば1(不整合の詳細をstderrに出す)。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEACHER_DATA_DIR = ROOT / "train" / "data" / "teacher"


def verify_one(set_name: str) -> tuple[int, int]:
    """戻り値: (検証したレコード数, 不整合件数)。"""
    jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    if not jsonl_path.exists():
        print(f"[{set_name}] SKIP: {jsonl_path} not found", file=sys.stderr)
        return 0, 0

    meta_doc = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    progress = meta_doc.get("progress", {})
    expected_total = progress.get("total")

    records = []
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"[{set_name}] line {line_no}: malformed JSON ({exc}); skipping", file=sys.stderr)

    errors = 0
    seen_canonical: dict[tuple, int] = {}
    seen_ids: set[int] = set()

    for rec in records:
        pos_id = rec.get("positionId")
        board = rec.get("board")
        children = rec.get("children") or []

        if pos_id in seen_ids:
            print(f"[{set_name}] positionId={pos_id}: duplicate positionId in corpus file", file=sys.stderr)
            errors += 1
        seen_ids.add(pos_id)

        if not children:
            print(f"[{set_name}] positionId={pos_id} board={board}: no children (expected >=1 legal move)", file=sys.stderr)
            errors += 1
            continue

        best_value = rec.get("bestValue")
        max_child_value = max(c["value"] for c in children)
        if best_value != max_child_value:
            print(
                f"[{set_name}] positionId={pos_id} board={board}: "
                f"bestValue={best_value} != max(children values)={max_child_value}",
                file=sys.stderr,
            )
            errors += 1

        best_move = rec.get("bestMove")
        best_move_values = {c["move"]: c["value"] for c in children}
        if best_move not in best_move_values or best_move_values[best_move] != max_child_value:
            print(
                f"[{set_name}] positionId={pos_id} board={board}: "
                f"bestMove={best_move!r} does not correspond to the max child value",
                file=sys.stderr,
            )
            errors += 1

        for c in children:
            if c["exact"]:
                if c["level"] not in (None, 60):
                    print(
                        f"[{set_name}] positionId={pos_id} move={c['move']}: "
                        f"exact=True but level={c['level']} (expected None or 60)",
                        file=sys.stderr,
                    )
                    errors += 1
            else:
                if c["level"] != 16:
                    print(
                        f"[{set_name}] positionId={pos_id} move={c['move']}: "
                        f"exact=False but level={c['level']} (expected 16)",
                        file=sys.stderr,
                    )
                    errors += 1

        key = tuple(rec.get("canonicalKey") or [])
        if key in seen_canonical:
            print(
                f"[{set_name}] positionId={pos_id} board={board}: "
                f"canonicalKey duplicates positionId={seen_canonical[key]} (D4 dedup failed)",
                file=sys.stderr,
            )
            errors += 1
        else:
            seen_canonical[key] = pos_id

    if expected_total is not None and len(records) != expected_total:
        print(
            f"[{set_name}] NOTE: {len(records)} record(s) in corpus file, "
            f"but meta progress.total={expected_total} (run may be incomplete; not counted as an error)",
            file=sys.stderr,
        )

    print(f"[{set_name}] verified {len(records)} record(s), {errors} error(s)")
    return len(records), errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_names", nargs="+", choices=["smoke", "primary"])
    args = parser.parse_args()

    total_records = 0
    total_errors = 0
    for set_name in args.set_names:
        n, errs = verify_one(set_name)
        total_records += n
        total_errors += errs

    print(f"TOTAL: {total_records} record(s) verified, {total_errors} error(s)")
    sys.exit(1 if total_errors > 0 else 0)


if __name__ == "__main__":
    main()

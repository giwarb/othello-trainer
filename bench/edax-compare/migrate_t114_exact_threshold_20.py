#!/usr/bin/env python3
"""T114移行: expanded200kの完全読みライン(EXACT_EMPTIES_THRESHOLD)を24→20へ
変更するための一回限りの移行スクリプト。

# 背景

`tasks/T114-teacher-corpus-200k.md`作業ログ「2026-07-16 20:4x — ユーザー裁定」節。
expanded200kが空き20-29帯で生成ペース約0.7局面/sまで低下し、完走ETAが遅延した。
ユーザー裁定: 「空き21以上はEdax推定値(level 16)でもよかった。既にやってしまった
空き21-24(の完全読みぶん)はいったん捨てて、まだ評価していないもの+今捨てたものを
新方針で評価しなおす」= コーパス全体を閾値20の均一ポリシーにする(混在させない)。

`gen_teacher_corpus.py`側は既にCORPUS_SETS["expanded200k"]["exactEmptiesThreshold"]=20
へのset別上書きに対応済み(smoke/primaryは24のまま不変)。本スクリプトは、既に
旧方針(閾値24)でEdaxラベル済みの`corpus_expanded200k_shard*of8.jsonl`から、新方針と
食い違うレコードだけを除去し、meta(runKey/settings/provenance identity)を新方針の
値へ書き換える。除去されたpositionIdは、次回`gen_teacher_corpus.py`のresumeで
自動的に(is_doneがFalseになるため)新方針で再計算される。

# 「影響レコード」の判定

保存済みレコードのうち、**いずれかの子局面が exact==True かつ level is not None
(=Edaxの`-l 60`完全読みで解かれた非終局子。level is Noneの終局子は閾値ポリシーの
対象外なので除外する)かつ childEmpties >= 21** であるものを「影響レコード」とし、
親レコードごと(そのレコードの全子局面ごと)除去する。1つの子だけを差し替えることは
しない(`label_position`は1レコード=1回のEdax呼び出しバッチで全子局面を再ラベルする
設計のため、部分修正は整合性を壊す)。

# 実行方法(リポジトリルートから)

    # まず統計だけ確認(ファイルは一切書き換えない、既定動作):
    python bench/edax-compare/migrate_t114_exact_threshold_20.py

    # 実際に書き換える(事前にtrain/data/teacher/配下のバックアップを
    # 別ディレクトリへ取得済みであることを前提とする。このスクリプト自体は
    # バックアップを取らない):
    python bench/edax-compare/migrate_t114_exact_threshold_20.py --apply

# meta更新の設計(runKey不一致を避けつつ新方針を反映する)

`select_positions`による局面選定(候補プール・優先層・oracle除外・層化サンプリング)は
`EXACT_EMPTIES_THRESHOLD`と無関係(選定後のラベリング段階でのみ使われる値)。そのため
`settings`のうち`exactEmptiesThreshold`以外の全フィールド(selectionStats・
phaseBinLowerBounds等)は新方針でも旧方針でも完全に同一になる(同一seed・同一
candidates.jsonのため決定的)。本スクリプトは既存meta.jsonの`settings`を土台にして
`exactEmptiesThreshold`だけを20へ書き換え、`runKey = json.dumps(settings, sort_keys=True)`
を再計算する。これは`gen_teacher_corpus.py`が実際に生成するrunKeyと一致するため、
移行後の`--adopt-provenance`無しでもrunKey不一致エラーは発生しない(runKeyは
`TeacherCorpusCheckpoint.try_resume()`で`adopt_provenance`の影響を受けない不一致系統
であるため、ここで一致させておくことが必須)。`meta.meta`(provenance identity)は
`gen_teacher_corpus.build_run_metadata()`を呼び直して現環境の値に更新するが、実際の
再起動時刻までにさらにファイルが変わる可能性に備え、再開コマンドには念のため
`--adopt-provenance`を付けることを推奨する(不一致が無ければ無害なno-op)。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gen_teacher_corpus", HERE / "gen_teacher_corpus.py")
assert SPEC and SPEC.loader
gen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen)

SET_NAME = "expanded200k"
NUM_SHARDS = 8
NEW_EXACT_EMPTIES_THRESHOLD = 20
# 影響レコード判定の下限(NEW_EXACT_EMPTIES_THRESHOLDの1つ上)。
AFFECTED_MIN_CHILD_EMPTIES = NEW_EXACT_EMPTIES_THRESHOLD + 1


def record_is_affected(record: dict) -> bool:
    """新方針(exactEmptiesThreshold=20)と食い違うレコードかどうかを判定する。

    いずれかの子が (exact is True) かつ (level is not None、終局子=lvl Noneは
    閾値ポリシーの対象外なので除外) かつ (childEmpties >= AFFECTED_MIN_CHILD_EMPTIES)
    のとき True。level is Noneの終局子はexact=Trueが常に付与されるが、Edaxを
    一切呼んでおらず閾値とは無関係な値のため、誤って影響レコード扱いしない。
    """
    for child in record.get("children") or []:
        if (
            child.get("exact") is True
            and child.get("level") is not None
            and (child.get("childEmpties") or 0) >= AFFECTED_MIN_CHILD_EMPTIES
        ):
            return True
    return False


def migrate_shard(shard_index: int, apply: bool) -> dict:
    jsonl_path = gen.TEACHER_DATA_DIR / f"corpus_{SET_NAME}_shard{shard_index}of{NUM_SHARDS}.jsonl"
    meta_path = gen.TEACHER_DATA_DIR / f"corpus_{SET_NAME}_shard{shard_index}of{NUM_SHARDS}.meta.json"
    if not jsonl_path.exists() or not meta_path.exists():
        raise RuntimeError(f"shard {shard_index}: expected files not found ({jsonl_path}, {meta_path})")

    kept: list[dict] = []
    removed: list[dict] = []
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            record = json.loads(line)
            if record_is_affected(record):
                removed.append(record)
            else:
                kept.append(record)

    removed_parent_empties = sorted(r.get("empties") for r in removed)
    removed_position_ids = sorted(r.get("positionId") for r in removed)

    if apply:
        with jsonl_path.open("w", encoding="utf-8", newline="\n") as fh:
            for record in kept:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
        settings = dict(meta_doc.get("settings") or {})
        old_threshold = settings.get("exactEmptiesThreshold")
        settings["exactEmptiesThreshold"] = NEW_EXACT_EMPTIES_THRESHOLD
        new_run_key = json.dumps(settings, sort_keys=True)
        meta_doc["settings"] = settings
        meta_doc["runKey"] = new_run_key
        meta_doc["meta"] = gen.build_run_metadata(gen.CANDIDATES_PATH)
        progress = dict(meta_doc.get("progress") or {})
        progress["done"] = len(kept)
        meta_doc["progress"] = progress
        gen.vs_edax.atomic_write_text(meta_path, json.dumps(meta_doc, indent=2, ensure_ascii=False) + "\n")
    else:
        old_threshold = (json.loads(meta_path.read_text(encoding="utf-8")).get("settings") or {}).get(
            "exactEmptiesThreshold"
        )

    return {
        "shardIndex": shard_index,
        "totalBefore": len(kept) + len(removed),
        "kept": len(kept),
        "removed": len(removed),
        "oldExactEmptiesThreshold": old_threshold,
        "removedParentEmptiesDistribution": removed_parent_empties,
        "removedPositionIds": removed_position_ids,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually rewrite jsonl/meta files. Without this flag, runs as a dry-run "
        "(report statistics only, no writes). Take a backup of train/data/teacher/ before using this.",
    )
    args = parser.parse_args()

    apply = args.apply
    print(
        f"[migrate] mode={'APPLY' if apply else 'DRY-RUN'} set={SET_NAME} numShards={NUM_SHARDS} "
        f"newExactEmptiesThreshold={NEW_EXACT_EMPTIES_THRESHOLD}"
    )

    total_removed = 0
    total_before = 0
    for shard_index in range(NUM_SHARDS):
        stats = migrate_shard(shard_index, apply)
        total_removed += stats["removed"]
        total_before += stats["totalBefore"]
        print(
            f"  shard {shard_index}: total={stats['totalBefore']} kept={stats['kept']} "
            f"removed={stats['removed']} oldExactEmptiesThreshold={stats['oldExactEmptiesThreshold']} "
            f"removedParentEmpties={stats['removedParentEmptiesDistribution']}"
        )

    print(
        f"[migrate] TOTAL: {total_removed}/{total_before} record(s) removed across {NUM_SHARDS} shard(s) "
        f"({'applied' if apply else 'dry-run, no files modified'})"
    )
    if not apply:
        print("[migrate] this was a dry-run; re-run with --apply to actually rewrite the shard files")


if __name__ == "__main__":
    main()

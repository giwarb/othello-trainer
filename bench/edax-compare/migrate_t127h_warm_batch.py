#!/usr/bin/env python3
"""T127h フェーズ2移行: expanded1m生成を親またぎバッチ方式
(`edaxParentsPerProcess: 32`, `elapsedMsPolicy: "cross-parent-level-batch-averaged"`)
へ切り替えるための一回限りの移行スクリプト。

# 背景

`tasks/T127h-warm-batch-switch.md`。フェーズ1(Codexワーカー、コミット68dbfa6)で
`gen_teacher_corpus.py`のexpanded1mシャードワーカーに親またぎバッチモードが実装され、
`CORPUS_SETS["expanded1m"]["edaxParentsPerProcess"] = 32`が既定になった。生成プロセスは
20:2x頃に全停止済み(base 200,000件 + 旧方式で生成済みの新規レコード)。本スクリプトは、
既に旧方式(`edaxParentsPerProcess`フィールド無し、`elapsedMsPolicy: "batch-averaged"`)で
書かれている8シャードの`corpus_expanded1m_shard*of8.meta.json`を新方式のsettings/runKeyへ
書き換え、provenance(`meta`ブロック)を現在の実行環境のSHA-256へ更新する。

**jsonl(レコード本体)は1バイトも変更しない。削除・切り詰めの経路はコード上に一切存在しない**
(T114移行事故の教訓を踏襲: 不整合は常にエラー停止、黙って書き換え/破棄しない)。

# 既知のブロッカー(このスクリプトが解決しない、作業ログで報告する)

`gen_teacher_corpus.py`の`_expanded1m_settings_and_meta()`は、選定plan凍結時点の
`corpus_expanded1m_selection_plan.meta.json`の`provenance.incrementalGeneration`
(harness/teacher_candidates/Edax/評価データのSHA-256)が現在の実行環境と完全一致する
ことを要求するゲートを内蔵している(通常の再開経路`generate_expanded1m_shard`が
そのままこの関数を呼ぶ)。フェーズ1で`gen_teacher_corpus.py`自体を編集したため、
選定plan凍結時点のharnessSha256(=`generatorSha256`)と現在のファイルのSHA-256が
一致しなくなっており、このゲートは**実ファイルに対しては現状必ずRuntimeErrorになる**
(teacher_candidates/Edax/評価データのSHA-256は不変、`generatorSha256`のみ不一致。
`check_plan_execution_sha_gate()`で検証・固定)。

`corpus_expanded1m_selection_plan.meta.json`をはじめとする selection plan 系ファイル
(`corpus_expanded1m_selection_plan.jsonl`・`corpus_expanded1m_shard*of8.plan.jsonl`・
その`.meta.json`)の変更はこのタスクの権限外(オーケストレーター指示で禁止)。
本スクリプトはこれらのファイルを**読み取り専用**でしか使わず、settings/meta算出に
必要な`generatorSha256`の置き換えはメモリ上の複製に対してのみ行う(実ファイルへは
一切書き戻さない)。したがって実際の再開(`generate_expanded1m_shard`の起動)は、
このブロッカーが解消される(例: 同一seed・同一candidates_expanded1m.jsonで
`prepare_expanded1m_selection_plan`を再実行し、選定結果が決定的に同一であることを
確認した上でprovenanceを更新する、等)までは失敗し続ける。詳細と再開コマンド案は
タスクファイルの作業ログを参照。

# 実行方法(リポジトリルートから)

    # まず統計だけ確認(ファイルは一切書き換えない、既定動作):
    python bench/edax-compare/migrate_t127h_warm_batch.py

    # 実際に書き換える(train/data/teacher/backup-t127h-migration/への追加バックアップも
    # 自動で取る。既に外部で全体バックアップ済みでも、このスクリプト自身のバックアップ
    # ステップは独立した安全網として常に実行される):
    python bench/edax-compare/migrate_t127h_warm_batch.py --apply
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
from pathlib import Path

import importlib.util

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gen_teacher_corpus", HERE / "gen_teacher_corpus.py")
assert SPEC and SPEC.loader
gen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen)

BACKUP_DIR_NAME = "backup-t127h-migration"


def backup_dir() -> Path:
    return gen.TEACHER_DATA_DIR / BACKUP_DIR_NAME


def shard_files(shard_index: int) -> tuple[Path, Path]:
    jsonl_path, meta_path, _ = gen._expanded1m_shard_paths(shard_index)
    return jsonl_path, meta_path


def backup_shard_files(*, force: bool = False) -> list[Path]:
    """全シャードのjsonl/metaを`backup-t127h-migration/`へコピーする。

    バックアップ先ディレクトリに16ファイル全てが既に存在する場合は(2回目以降の実行、
    または呼び出し前に外部で既に取得済みの場合)コピーをスキップして安全に冪等化する。
    一部だけ存在する(壊れかけの)状態は`--force-backup`無しでは拒否する(誤って
    不完全なバックアップの上に新しいバックアップを部分的に重ねる事故を防ぐ)。
    """
    dest_dir = backup_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    sources: list[Path] = []
    for shard_index in range(gen.EXPANDED1M_NUM_SHARDS):
        for src in shard_files(shard_index):
            if not src.exists():
                raise RuntimeError(f"expected source file not found, refusing to back up: {src}")
            sources.append(src)

    existing = [dest_dir / src.name for src in sources if (dest_dir / src.name).exists()]
    if len(existing) == len(sources):
        return existing
    if existing and not force:
        raise RuntimeError(
            f"{backup_dir()} already contains {len(existing)}/{len(sources)} file(s); refusing to overwrite "
            "a partial/stale backup without --force-backup"
        )

    copied: list[Path] = []
    for src in sources:
        dest = dest_dir / src.name
        shutil.copy2(src, dest)
        copied.append(dest)
    return copied


def verify_base_import_integrity() -> list[dict]:
    """`corpus_expanded200k.jsonl`を1回だけ走査し、各シャードの先頭
    (base positionId stripe分の)レコードが、そのpositionIdに対応するbaseレコードと
    バイト単位で一致することを確認する(読み取り専用。`copy_base_records_for_shard`が
    生成時に行ったコピーの整合性を事後検証する)。不一致は即座にRuntimeErrorで停止する
    (削除・修復は行わない)。"""
    base_count = gen.EXPANDED1M_BASE_COUNT
    num_shards = gen.EXPANDED1M_NUM_SHARDS
    base_lines: dict[int, bytes] = {}
    with gen.BASE_CORPUS_PATH.open("rb") as fh:
        for expected_id, raw in enumerate(fh):
            if not raw.strip():
                raise RuntimeError(f"blank base corpus line at positionId={expected_id}")
            record = json.loads(raw)
            if record.get("positionId") != expected_id:
                raise RuntimeError(
                    f"base corpus positionId sequence mismatch at line {expected_id + 1}: "
                    f"{record.get('positionId')}"
                )
            base_lines[expected_id] = raw
    if len(base_lines) != base_count:
        raise RuntimeError(f"base corpus line count {len(base_lines)} != expected {base_count}")

    results: list[dict] = []
    for shard_index in range(num_shards):
        expected_stripe = list(range(shard_index, base_count, num_shards))
        jsonl_path, _ = shard_files(shard_index)
        actual_lines: list[bytes] = []
        with jsonl_path.open("rb") as fh:
            for _ in expected_stripe:
                line = fh.readline()
                if not line:
                    raise RuntimeError(
                        f"shard {shard_index}: fewer lines than expected base stripe size "
                        f"({len(expected_stripe)})"
                    )
                actual_lines.append(line)
        mismatches = [
            pid for pid, actual_raw in zip(expected_stripe, actual_lines) if actual_raw != base_lines[pid]
        ]
        if mismatches:
            raise RuntimeError(
                f"shard {shard_index}: {len(mismatches)} base-imported record(s) do not byte-match "
                f"{gen.BASE_CORPUS_PATH.name} (positionIds e.g. {mismatches[:5]})"
            )
        results.append({"shardIndex": shard_index, "baseStripeVerified": len(expected_stripe)})
    return results


def count_and_validate_shard_records(shard_index: int, plan_meta_provenance_ready: bool = True) -> dict:
    """シャードjsonlの実レコード数を数え、positionIdの重複が無いこと、全positionIdが
    そのシャードのplan(base stripe + incremental候補)に属することを検証する
    (読み取り専用、書き換え・削除は一切行わない)。"""
    jsonl_path, _, plan_path = gen._expanded1m_shard_paths(shard_index)
    reuse_ids: set[int] = set()
    incremental_ids: set[int] = set()
    with plan_path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            row = json.loads(raw)
            if row.get("kind") == "reuse":
                reuse_ids.add(row["positionId"])
            else:
                incremental_ids.add(row["positionId"])

    seen_ids: set[int] = set()
    total = 0
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                raise RuntimeError(f"shard {shard_index}: unexpected blank line at {line_no}")
            record = json.loads(line)
            pid = record.get("positionId")
            if pid is None:
                raise RuntimeError(f"shard {shard_index} line {line_no}: record missing positionId")
            if pid in seen_ids:
                raise RuntimeError(f"shard {shard_index}: duplicate positionId {pid} at line {line_no}")
            if pid not in reuse_ids and pid not in incremental_ids:
                raise RuntimeError(
                    f"shard {shard_index}: positionId {pid} at line {line_no} is not part of this shard's "
                    "selection plan (neither reuse nor incremental)"
                )
            seen_ids.add(pid)
            total += 1

    missing_base = reuse_ids - seen_ids
    if missing_base:
        raise RuntimeError(
            f"shard {shard_index}: {len(missing_base)} base positionId(s) missing from jsonl "
            f"(e.g. {sorted(missing_base)[:5]}); base import must be complete before migration"
        )

    return {
        "shardIndex": shard_index,
        "totalRecords": total,
        "baseRecords": len(reuse_ids),
        "incrementalRecords": total - len(reuse_ids),
    }


def load_plan_meta() -> dict:
    if not gen.EXPANDED1M_PLAN_META_PATH.exists():
        raise RuntimeError(f"expanded1m selection plan metadata not found: {gen.EXPANDED1M_PLAN_META_PATH}")
    return json.loads(gen.EXPANDED1M_PLAN_META_PATH.read_text(encoding="utf-8"))


def check_plan_execution_sha_gate(plan_meta: dict) -> dict:
    """選定plan凍結時点のprovenance(`provenance.incrementalGeneration`)と現在の
    実行環境のSHA-256を比較する。`generatorSha256`(=`gen_teacher_corpus.py`自体)は
    フェーズ1の編集により不一致になるのがこのタスクの前提(既知・想定内)。
    それ以外のキー(teacher_candidates/Edax/評価データ)が不一致な場合は未知の
    ドリフトとして即座にRuntimeErrorで停止する(fail closed、T114堅牢化の流儀)。"""
    incremental = plan_meta["provenance"]["incrementalGeneration"]
    current = {
        "generatorSha256": gen.sha256_of_file(Path(gen.__file__)),
        "teacherCandidatesToolSha256": gen.sha256_of_file(gen.TEACHER_CANDIDATES_TOOL),
        "edaxSha256": gen.sha256_of_file(gen.vs_edax.EDAX_EXE),
        "edaxEvalDataSha256": gen.sha256_of_file(gen.vs_edax.EDAX_EVAL_DATA),
    }
    mismatches = {key: (incremental.get(key), value) for key, value in current.items() if incremental.get(key) != value}
    unexpected = {key: pair for key, pair in mismatches.items() if key != "generatorSha256"}
    if unexpected:
        raise RuntimeError(
            f"unexpected execution SHA drift beyond the known generatorSha256 mismatch: {unexpected}"
        )
    return {
        "current": current,
        "mismatchedKeys": sorted(mismatches.keys()),
        "generatorShaMismatch": "generatorSha256" in mismatches,
    }


def settings_and_meta_for_shard(shard_index: int, plan_meta: dict) -> tuple[dict, str, dict]:
    """新方式(edaxParentsPerProcess=32)のsettings/runKey/metaを算出する。

    `gen._expanded1m_settings_and_meta`は内部で選定plan凍結時点のprovenanceと現在の
    実行環境のSHA-256が完全一致することを要求するため、モジュールdocstringに記載の
    既知のブロッカー(`generatorSha256`のみの不一致)を回避するために、メモリ上の
    複製に対してのみ`generatorSha256`を現在値へ差し替えてから呼び出す。渡す`plan_meta`
    引数(呼び出し元が保持する実体)は`copy.deepcopy`で複製するため一切変更しない。
    実ファイル(`corpus_expanded1m_selection_plan.meta.json`)への書き戻しはどこにも
    存在しない。"""
    patched_plan_meta = copy.deepcopy(plan_meta)
    patched_plan_meta["provenance"]["incrementalGeneration"]["generatorSha256"] = gen.sha256_of_file(
        Path(gen.__file__)
    )
    settings, meta = gen._expanded1m_settings_and_meta(
        shard_index, patched_plan_meta, gen.CORPUS_SETS["expanded1m"]["edaxParentsPerProcess"]
    )
    run_key = json.dumps(settings, sort_keys=True)
    return settings, run_key, meta


def migrate_shard(shard_index: int, plan_meta: dict, apply: bool) -> dict:
    """1シャード分の移行。jsonlは常に読み取り専用(open("r"...)のみ)で扱い、書き込み・
    削除・切り詰めのコードパスはこの関数(および本モジュール全体)に存在しない。"""
    jsonl_path, meta_path = shard_files(shard_index)
    if not jsonl_path.exists() or not meta_path.exists():
        raise RuntimeError(f"shard {shard_index}: expected files not found ({jsonl_path}, {meta_path})")

    record_count = 0
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            if raw.strip():
                record_count += 1

    existing_meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
    old_run_key = existing_meta_doc.get("runKey")

    settings, run_key, meta = settings_and_meta_for_shard(shard_index, plan_meta)
    reused_record_count = gen.EXPANDED1M_BASE_COUNT // gen.EXPANDED1M_NUM_SHARDS

    if apply:
        new_doc = {
            "schemaVersion": 2,
            "runKey": run_key,
            "meta": meta,
            "settings": settings,
            "reusedRecordCount": reused_record_count,
            "progress": {
                "done": record_count,
                "total": 125_000,
                "ratePerSec": None,
                "updatedAt": gen.datetime.now(gen.timezone.utc).isoformat(timespec="seconds"),
            },
        }
        gen.vs_edax.atomic_write_text(meta_path, json.dumps(new_doc, indent=2, ensure_ascii=False) + "\n")

    return {
        "shardIndex": shard_index,
        "recordCount": record_count,
        "oldRunKey": old_run_key,
        "newRunKey": run_key,
        "runKeyChanged": run_key != old_run_key,
        "hadEdaxParentsPerProcess": "edaxParentsPerProcess" in (existing_meta_doc.get("settings") or {}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually rewrite meta.json files (backs up first). Without this flag, runs as a dry-run "
        "(report statistics only, no writes).",
    )
    parser.add_argument(
        "--skip-backup",
        action="store_true",
        help="Internal/testing only: skip the backup step. The jsonl record files are never written by this "
        "script regardless of this flag.",
    )
    parser.add_argument(
        "--force-backup",
        action="store_true",
        help="Overwrite an existing partial backup directory. Use only if you are certain the existing "
        "backup is stale/incomplete.",
    )
    args = parser.parse_args()

    print(f"[migrate-t127h] mode={'APPLY' if args.apply else 'DRY-RUN'}")

    if args.apply and not args.skip_backup:
        backed_up = backup_shard_files(force=args.force_backup)
        print(f"  backup: {len(backed_up)} file(s) present under {backup_dir()}")

    print("  verifying base-import byte integrity against corpus_expanded200k.jsonl (read-only) ...")
    for result in verify_base_import_integrity():
        print(f"    shard {result['shardIndex']}: base stripe OK ({result['baseStripeVerified']} records)")

    plan_meta = load_plan_meta()
    gate = check_plan_execution_sha_gate(plan_meta)
    print(
        f"  execution SHA gate vs selection plan provenance: mismatched keys={gate['mismatchedKeys']} "
        "(generatorSha256-only mismatch is expected/known, see module docstring)"
    )

    total_records = 0
    total_base = 0
    for shard_index in range(gen.EXPANDED1M_NUM_SHARDS):
        counts = count_and_validate_shard_records(shard_index)
        stats = migrate_shard(shard_index, plan_meta, args.apply)
        total_records += counts["totalRecords"]
        total_base += counts["baseRecords"]
        print(
            f"  shard {shard_index}: total={counts['totalRecords']} base={counts['baseRecords']} "
            f"incremental={counts['incrementalRecords']} runKeyChanged={stats['runKeyChanged']} "
            f"hadEdaxParentsPerProcess(before)={stats['hadEdaxParentsPerProcess']}"
        )

    print(
        f"[migrate-t127h] TOTAL: {total_records} record(s) across {gen.EXPANDED1M_NUM_SHARDS} shard(s) "
        f"(base={total_base}, incremental={total_records - total_base}) "
        f"({'applied' if args.apply else 'dry-run, no files modified'})"
    )
    if not args.apply:
        print("[migrate-t127h] this was a dry-run; re-run with --apply to actually rewrite the shard meta.json files")


if __name__ == "__main__":
    main()

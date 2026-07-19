#!/usr/bin/env python3
"""T090a教師コーパスの厳密検証。

全件についてRustの`engine::bitboard::Board`を利用する`teacher_candidates children`
を呼び、盤面の全合法手集合と`children[].move`を完全照合する。JSONL/metaの完全性、
positionId、D4重複、best/diff、exact深さも検証し、欠落ファイルやmalformed行を含む
いずれかの不整合でexit 1を返す。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import vs_edax  # noqa: E402

TEACHER_DATA_DIR = ROOT / "train" / "data" / "teacher"
TOOL = ROOT / "target" / "release" / "teacher_candidates.exe"
BATCH_SIZE = 500
# T127c: 1M件規模の全件検証はCLAUDE.mdの長時間実行ルール(チャンク進捗+resume)を
# 適用する対象になり得るため、既定でBATCH_SIZE(500)の倍数区切りで進捗を出す。
# smoke/primary/expanded200kはこれまでどおり`verify_one(set_name)`のみの呼び出しで
# 挙動不変(progress_every/checkpoint_pathは既定Noneで無効)。
DEFAULT_PROGRESS_EVERY = 50_000
EXACT_EMPTIES_THRESHOLD = 24
# T114: t096独立oracle(60局面)の非混入を全setで機械検証する(混入すると
# 独立評価指標が自己参照になるため)。各局面は既にD4正準化済みcanonicalKeyを
# 持つので、対称形の展開は不要(このキーとの一致チェックだけで足りる)。
T096_ORACLE_POSITIONS_PATH = ROOT / "bench" / "edax-compare" / "t096_oracle_positions.json"
EXPANDED1M_GENERATOR_PATH = ROOT / "bench" / "edax-compare" / "gen_teacher_corpus.py"
EXPANDED1M_BASE_PATH = TEACHER_DATA_DIR / "corpus_expanded200k.jsonl"
EXPANDED1M_BASE_MANIFEST_PATH = (
    ROOT / "bench" / "edax-compare" / "teacher_manifests" / "corpus_expanded200k.meta.json"
)
EXPANDED1M_CANDIDATE_POOL_PATH = TEACHER_DATA_DIR / "candidates_expanded1m.json"
EXPANDED1M_SELECTION_PLAN_PATH = TEACHER_DATA_DIR / "corpus_expanded1m_selection_plan.jsonl"
EXPANDED1M_BASE_COUNT = 200_000
EXPANDED1M_TOTAL_COUNT = 1_000_000
EXPANDED1M_BASE_SHA256 = "412477e2da6bacb0d715c7e5d02447d37b6e981237f64f221013a8eb465690e9"
EXPANDED1M_BASE_MANIFEST_SHA256 = "89c3cd33ec491c0aa55b2c4d0165b0785a5b8f3df08674b5107caffc4b223f4c"


def load_oracle_keys() -> set[tuple[int, int, int]]:
    if not T096_ORACLE_POSITIONS_PATH.exists():
        raise RuntimeError(
            f"{T096_ORACLE_POSITIONS_PATH} not found; oracle non-contamination check cannot be skipped silently"
        )
    doc = json.loads(T096_ORACLE_POSITIONS_PATH.read_text(encoding="utf-8"))
    return {tuple(p["canonicalKey"]) for p in doc["positions"]}


ORACLE_KEYS = load_oracle_keys()
REQUIRED_RECORD_FIELDS = {
    "positionId",
    "board",
    "sideToMove",
    "empties",
    "source",
    "phaseBin",
    "hasXcLegalMove",
    "openingKey",
    "priorityLoss",
    "canonicalKey",
    "children",
    "bestMove",
    "bestValue",
    "generatedAt",
}
REQUIRED_CHILD_FIELDS = {"move", "value", "diffFromBest", "exact", "level", "edaxDepth"}


def report(set_name: str, message: str) -> None:
    print(f"[{set_name}] {message}", file=sys.stderr)


def sha256_of_file(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


_PROVENANCE_PATH_FIELDS = {"path", "manifestPath", "candidatePoolPath", "selectionPlanPath"}


def _normalize_recorded_path(value: object) -> object:
    """Windowsで生成されたmeta.jsonは`os.sep`(`\\`)区切りのパス文字列を記録して
    いることがある。verify側の期待値はリポジトリ内表記に合わせたPOSIX区切り
    (`/`)なので、パス系フィールドの比較だけは区切り文字の差を無視する
    (T127c: 実データ検証で発見。パス表記の違いはデータ不整合ではないため、
    provenance内容そのものやjsonl本体は一切変更せず、検証側の比較を頑健にする)。"""
    if isinstance(value, str):
        return value.replace("\\", "/")
    return value


def expanded1m_provenance_errors(meta_doc: dict) -> list[str]:
    """Validate fixed two-layer provenance against the actual local artifacts."""
    errors = []
    provenance = meta_doc.get("provenance") or {}
    base = provenance.get("baseCorpus")
    incremental = provenance.get("incrementalGeneration")
    if not isinstance(base, dict) or not isinstance(incremental, dict):
        return ["expanded1m requires baseCorpus/incrementalGeneration provenance"]

    base_expected = {
        "path": "train/data/teacher/corpus_expanded200k.jsonl",
        "recordCount": EXPANDED1M_BASE_COUNT,
        "jsonlSha256": EXPANDED1M_BASE_SHA256,
        "manifestPath": "bench/edax-compare/teacher_manifests/corpus_expanded200k.meta.json",
        "manifestSha256": EXPANDED1M_BASE_MANIFEST_SHA256,
    }
    for key, expected in base_expected.items():
        actual_value = base.get(key)
        compare_value = _normalize_recorded_path(actual_value) if key in _PROVENANCE_PATH_FIELDS else actual_value
        if compare_value != expected:
            errors.append(f"baseCorpus.{key}={actual_value!r}, expected {expected!r}")
    actual_base_sha = sha256_of_file(EXPANDED1M_BASE_PATH)
    if actual_base_sha != EXPANDED1M_BASE_SHA256:
        errors.append(f"actual expanded200k SHA-256={actual_base_sha!r}, expected {EXPANDED1M_BASE_SHA256!r}")
    actual_manifest_sha = sha256_of_file(EXPANDED1M_BASE_MANIFEST_PATH)
    if actual_manifest_sha != EXPANDED1M_BASE_MANIFEST_SHA256:
        errors.append(
            f"actual expanded200k manifest SHA-256={actual_manifest_sha!r}, "
            f"expected {EXPANDED1M_BASE_MANIFEST_SHA256!r}"
        )
    elif actual_manifest_sha is not None:
        try:
            base_manifest_meta = json.loads(EXPANDED1M_BASE_MANIFEST_PATH.read_text(encoding="utf-8")).get("meta") or {}
            for key in ("edaxSha256", "edaxEvalDataSha256"):
                if base.get(key) != base_manifest_meta.get(key):
                    errors.append(
                        f"baseCorpus.{key}={base.get(key)!r}, "
                        f"base manifest has {base_manifest_meta.get(key)!r}"
                    )
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read authenticated expanded200k manifest: {exc}")

    incremental_expected = {
        "recordCount": EXPANDED1M_TOTAL_COUNT - EXPANDED1M_BASE_COUNT,
        "candidatePoolPath": "train/data/teacher/candidates_expanded1m.json",
        "selectionPlanPath": "train/data/teacher/corpus_expanded1m_selection_plan.jsonl",
    }
    for key, expected in incremental_expected.items():
        actual_value = incremental.get(key)
        compare_value = _normalize_recorded_path(actual_value) if key in _PROVENANCE_PATH_FIELDS else actual_value
        if compare_value != expected:
            errors.append(f"incrementalGeneration.{key}={actual_value!r}, expected {expected!r}")

    # T143(生成基盤堅牢化の副作用として発見・修正): データ成果物(候補プール・
    # selection plan・oracle定義)は生成完了時点で確定した不変ファイルなので、
    # 現在のライブファイルと厳密一致することを引き続き要求する。
    immutable_data_artifact_shas = {
        "candidatePoolSha256": sha256_of_file(EXPANDED1M_CANDIDATE_POOL_PATH),
        "selectionPlanSha256": sha256_of_file(EXPANDED1M_SELECTION_PLAN_PATH),
        "t096OracleSha256": sha256_of_file(T096_ORACLE_POSITIONS_PATH),
    }
    for key, actual in immutable_data_artifact_shas.items():
        if actual is None or incremental.get(key) != actual:
            errors.append(f"incrementalGeneration.{key}={incremental.get(key)!r}, actual {actual!r}")

    # T143: `generatorSha256`/`teacherCandidatesToolSha256`/`edaxSha256`/
    # `edaxEvalDataSha256`はコード/ビルド成果物であり、生成完了後の通常の
    # メンテナンス(バグ修正・堅牢化等、本タスク自身がgen_teacher_corpus.pyを
    # 編集したことでgeneratorSha256が実際に変化した)で正当に変わりうる。これらを
    # 「現在のライブファイルと一致しなければならない」とする検証は、以後この
    # 生成物を(生成器を1文字も触れないという意味で)二度と検証できなくなることを
    # 意味し過剰。生成完了時点で記録された値がプロヴェナンスとして存在すること
    # (欠落していないこと)だけを検証する。生成"実行中"の環境SHA不一致という
    # 真に危険なケースは、gen_teacher_corpus.py側のresume identityゲート
    # (PROVENANCE_IDENTITY_KEYS、実行中プロセスの再開時にのみ効く)が別途担う。
    for key in ("generatorSha256", "teacherCandidatesToolSha256", "edaxSha256", "edaxEvalDataSha256"):
        value = incremental.get(key)
        if not isinstance(value, str) or not value:
            errors.append(f"incrementalGeneration.{key} must be a recorded non-empty SHA-256 string, got {value!r}")

    shard_shas = incremental.get("shardPlanSha256")
    if not isinstance(shard_shas, list) or len(shard_shas) != 8:
        errors.append("incrementalGeneration.shardPlanSha256 must contain 8 entries")
    else:
        for shard_index, expected_sha in enumerate(shard_shas):
            path = TEACHER_DATA_DIR / f"corpus_expanded1m_shard{shard_index}of8.plan.jsonl"
            actual_sha = sha256_of_file(path)
            if actual_sha is None or expected_sha != actual_sha:
                errors.append(f"shard {shard_index} selection plan SHA-256={expected_sha!r}, actual {actual_sha!r}")
    return errors


def compute_children(records: list[dict]) -> list[dict]:
    payload = [{"board": rec.get("board"), "sideToMove": rec.get("sideToMove")} for rec in records]
    proc = subprocess.run(
        [str(TOOL), "children"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"teacher_candidates children failed: {proc.stderr}")
    result = json.loads(proc.stdout)
    if len(result) != len(records):
        raise RuntimeError(f"children batch size mismatch: {len(result)} != {len(records)}")
    return result


def compute_canonical_keys(records: list[dict]) -> list[list[int]]:
    payload = [{"board": rec.get("board"), "sideToMove": rec.get("sideToMove")} for rec in records]
    proc = subprocess.run(
        [str(TOOL), "canonical"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"teacher_candidates canonical failed: {proc.stderr}")
    result = json.loads(proc.stdout)
    if len(result) != len(records):
        raise RuntimeError(f"canonical batch size mismatch: {len(result)} != {len(records)}")
    return result


def schema_errors(record: dict) -> list[str]:
    errors = []
    missing = sorted(REQUIRED_RECORD_FIELDS - record.keys())
    if missing:
        errors.append(f"missing required field(s): {', '.join(missing)}")
    board = record.get("board")
    if not isinstance(board, str) or len(board) != 64 or set(board) - {"X", "O", "-"}:
        errors.append("board must be a 64-character X/O/- string")
    if record.get("sideToMove") not in {"black", "white"}:
        errors.append("sideToMove must be black or white")
    if isinstance(board, str) and len(board) == 64 and record.get("empties") != board.count("-"):
        errors.append("empties does not match board")

    source = record.get("source")
    if source == "wthor":
        if not isinstance(record.get("phaseBin"), int) or not 0 <= record["phaseBin"] < 6:
            errors.append("wthor phaseBin must be an integer in [0, 5]")
        if not isinstance(record.get("hasXcLegalMove"), bool):
            errors.append("wthor hasXcLegalMove must be boolean")
        if not isinstance(record.get("openingKey"), str) or not record["openingKey"]:
            errors.append("wthor openingKey must be a non-empty string")
        if record.get("priorityLoss") is not None:
            errors.append("wthor priorityLoss must be null")
    elif source == "engineLoss":
        if record.get("phaseBin") is not None or record.get("hasXcLegalMove") is not None:
            errors.append("engineLoss phaseBin/hasXcLegalMove must be null")
        if record.get("openingKey") is not None:
            errors.append("engineLoss openingKey must be null")
        loss = record.get("priorityLoss")
        if not isinstance(loss, (int, float)) or isinstance(loss, bool) or loss < 4:
            errors.append("engineLoss priorityLoss must be numeric and >= 4")
    else:
        errors.append("source must be wthor or engineLoss")

    children = record.get("children")
    if isinstance(children, list):
        for index, child in enumerate(children):
            if not isinstance(child, dict):
                errors.append(f"children[{index}] must be an object")
                continue
            child_missing = sorted(REQUIRED_CHILD_FIELDS - child.keys())
            if child_missing:
                errors.append(f"children[{index}] missing required field(s): {', '.join(child_missing)}")
    return errors


def compute_checkpoint_fingerprint(jsonl_path: Path) -> dict:
    """T143(レビュー中-1): verify checkpointの正当性を、前回保存時点の対象JSONLと
    teacher_candidates.exeの実体が今も同じかどうかで検証するためのフィンガープリント。
    フルSHA-256計算は1.6GB規模(expanded1m)でも1秒未満(2026-07-20実測)であり、
    `verify_one`1回の呼び出しにつき1回計算して使い回すだけなので無視できるコスト。"""
    return {
        "jsonlSize": jsonl_path.stat().st_size,
        "jsonlSha256": sha256_of_file(jsonl_path),
        "toolSha256": sha256_of_file(TOOL),
    }


def load_verify_checkpoint(
    checkpoint_path: Path, set_name: str, expected_fingerprint: dict | None = None
) -> dict | None:
    """T127c: 1M件全件検証の中断→再開用checkpoint読み込み。

    setNameが一致しないcheckpoint(別setからの取り違え)は無視してNoneを返す
    (フルスキャンにフォールバックさせ、誤ったseen_canonicalの流用を防ぐ)。

    T143(レビュー中-1): `expected_fingerprint`(`compute_checkpoint_fingerprint`の
    戻り値)を渡すと、保存済みcheckpointのフィンガープリント(対象JSONLのサイズ・
    SHA-256、teacher_candidates.exeのSHA-256)と現在値を照合する。不一致
    (対象JSONLが前回保存後に差し替わった、ツールバイナリが変わった等)なら
    checkpointを無効化し(理由をログしてNoneを返す)、呼び出し元をフルスキャンへ
    フォールバックさせる。破損したcheckpointを誤って信頼する事故を防ぐための
    安全側フォールバックであり、verify側はcheckpointを失っても(検証をやり直す
    だけで)データを破壊しないため、生成側の`--start-fresh`のような明示フラグは
    不要(既定で常にフォールバックしてよい)。
    """
    if not checkpoint_path.exists():
        return None
    try:
        doc = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report(set_name, f"checkpoint {checkpoint_path} could not be parsed ({exc}); falling back to full scan")
        return None
    if doc.get("setName") != set_name:
        return None
    if expected_fingerprint is not None:
        mismatched = {
            key: (doc.get(key), expected)
            for key, expected in expected_fingerprint.items()
            if doc.get(key) != expected
        }
        if mismatched:
            report(
                set_name,
                f"checkpoint {checkpoint_path} fingerprint mismatch {mismatched} (the target JSONL or "
                "teacher_candidates tool changed since the checkpoint was written); falling back to full scan",
            )
            return None
    return doc


def save_verify_checkpoint(
    checkpoint_path: Path,
    set_name: str,
    record_count: int,
    errors: int,
    seen_canonical: dict[tuple, int],
    fingerprint: dict | None = None,
) -> None:
    """チャンク境界ごとに呼ぶ。原子的置換(tmp書き→os.replace)でクラッシュ時の
    破損checkpointを防ぐ(長時間実行ルール: 逐次保存・resume可能を満たす)。

    T143(レビュー中-1): `fingerprint`(`compute_checkpoint_fingerprint`の戻り値)を
    渡すとcheckpointへそのまま埋め込む(`load_verify_checkpoint`が次回load時に
    照合する)。省略時(既定None)は従来どおりフィンガープリント欄を含めない。
    """
    doc = {
        "setName": set_name,
        "recordCount": record_count,
        "errors": errors,
        "seenCanonical": [[key[0], key[1], key[2], pos_id] for key, pos_id in seen_canonical.items()],
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if fingerprint:
        doc.update(fingerprint)
    tmp_path = checkpoint_path.with_suffix(checkpoint_path.suffix + ".tmp")
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path.write_text(json.dumps(doc), encoding="utf-8")
    os.replace(tmp_path, checkpoint_path)


def verify_one(
    set_name: str,
    progress_every: int | None = None,
    checkpoint_path: Path | None = None,
) -> tuple[int, int]:
    jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    errors = 0
    if not jsonl_path.exists() or not meta_path.exists():
        report(set_name, f"ERROR: corpus/meta pair not found: {jsonl_path}, {meta_path}")
        return 0, 1
    if not TOOL.exists():
        report(set_name, f"ERROR: {TOOL} not found; build teacher_candidates first")
        return 0, 1
    try:
        meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report(set_name, f"ERROR: malformed meta: {exc}")
        return 0, 1

    exact_empties_threshold = (meta_doc.get("settings") or {}).get(
        "exactEmptiesThreshold", EXACT_EMPTIES_THRESHOLD
    )
    expected_total = (meta_doc.get("progress") or {}).get("total")
    expected_done = (meta_doc.get("progress") or {}).get("done")
    if meta_doc.get("schemaVersion") != 2:
        report(set_name, f"ERROR: meta schemaVersion must be 2, got {meta_doc.get('schemaVersion')!r}")
        errors += 1
    if not isinstance(expected_total, int) or not isinstance(expected_done, int):
        report(set_name, "ERROR: meta progress.total/done must be integers")
        errors += 1
    if set_name == "expanded1m":
        if expected_total != EXPANDED1M_TOTAL_COUNT or expected_done != EXPANDED1M_TOTAL_COUNT:
            report(
                set_name,
                f"ERROR: expanded1m meta must declare exactly {EXPANDED1M_TOTAL_COUNT} completed records",
            )
            errors += 1
        if meta_doc.get("reusedRecordCount") != EXPANDED1M_BASE_COUNT:
            report(set_name, f"ERROR: expanded1m reusedRecordCount must be {EXPANDED1M_BASE_COUNT}")
            errors += 1
        for message in expanded1m_provenance_errors(meta_doc):
            report(set_name, f"ERROR: {message}")
            errors += 1

    seen_canonical: dict[tuple, int] = {}
    record_count = 0
    batch: list[dict] = []

    # T127c: 中断→再開。checkpointのsetNameが一致する場合のみ採用し、既に
    # verify_batch(subprocess呼び出し)まで完了した先頭resume_record_count件は
    # 重い再検証(children/canonical recompute)をスキップする。schema_errors・
    # positionId連番・expanded200kプレフィックス比較(いずれもsubprocess不要で
    # 安価)はresume区間でも引き続き全件実施する。
    resume_record_count = 0
    # T143(レビュー中-1): checkpoint_pathが渡された場合のみフィンガープリントを
    # 計算する(既存smoke/primary/expanded200kの通常呼び出しは--checkpoint-dirを
    # 渡さないため、この追加コストの影響を受けない)。
    fingerprint = compute_checkpoint_fingerprint(jsonl_path) if checkpoint_path is not None else None
    if checkpoint_path is not None:
        loaded = load_verify_checkpoint(checkpoint_path, set_name, fingerprint)
        if loaded is not None:
            resume_record_count = int(loaded.get("recordCount", 0))
            errors += int(loaded.get("errors", 0))
            for item in loaded.get("seenCanonical", []):
                seen_canonical[(item[0], item[1], item[2])] = item[3]
            report(
                set_name,
                f"resume: loaded checkpoint at {checkpoint_path} "
                f"(recordCount={resume_record_count}, priorErrors={loaded.get('errors', 0)}, "
                f"seenCanonical={len(seen_canonical)})",
            )
    start_time = time.monotonic()

    def verify_batch(records: list[dict], start_index: int) -> int:
        batch_errors = 0
        try:
            legal_info = compute_children(records)
            canonical_keys = compute_canonical_keys(records)
        except Exception as exc:  # noqa: BLE001
            report(set_name, f"ERROR: board recomputation failed at record {start_index}: {exc}")
            return 1
        for rec, info, recomputed_key in zip(records, legal_info, canonical_keys):
            pos_id = rec.get("positionId")
            children = rec.get("children")
            if not isinstance(children, list) or not children:
                report(set_name, f"positionId={pos_id}: children must be a non-empty list")
                batch_errors += 1
                continue
            try:
                corpus_moves = [child["move"] for child in children]
                legal_moves = [child["move"] for child in info["moves"]]
            except (KeyError, TypeError) as exc:
                report(set_name, f"positionId={pos_id}: malformed children: {exc}")
                batch_errors += 1
                continue
            if len(corpus_moves) != len(set(corpus_moves)) or set(corpus_moves) != set(legal_moves):
                report(
                    set_name,
                    f"positionId={pos_id}: legal move mismatch corpus={sorted(corpus_moves)} board={sorted(legal_moves)}",
                )
                batch_errors += 1

            by_move = {child["move"]: child for child in info["moves"]}
            try:
                max_value = max(child["value"] for child in children)
                if rec.get("bestValue") != max_value:
                    raise ValueError(f"bestValue={rec.get('bestValue')} max={max_value}")
                best_move = rec.get("bestMove")
                if best_move not in corpus_moves or next(
                    child["value"] for child in children if child["move"] == best_move
                ) != max_value:
                    raise ValueError(f"bestMove={best_move} is not maximal")
                for child in children:
                    expected_diff = max_value - child["value"]
                    if child.get("diffFromBest") != expected_diff:
                        raise ValueError(
                            f"move={child['move']} diffFromBest={child.get('diffFromBest')} expected={expected_diff}"
                        )
                    actual = by_move.get(child["move"])
                    if actual is None:
                        continue
                    if child.get("childEmpties") not in (None, actual["childEmpties"]):
                        raise ValueError(f"move={child['move']} childEmpties mismatch")
                    if actual["childIsTerminal"]:
                        if child.get("exact") is not True or child.get("level") is not None:
                            raise ValueError(f"terminal move={child['move']} must be exact with level=null")
                        if child.get("edaxDepth") is not None:
                            raise ValueError(f"terminal move={child['move']} requires edaxDepth=null")
                    elif actual["childEmpties"] <= exact_empties_threshold:
                        if child.get("exact") is not True or child.get("level") != 60:
                            raise ValueError(
                                f"move={child['move']} empties={actual['childEmpties']} requires exact=true/level=60"
                            )
                        if not isinstance(child.get("edaxDepth"), int):
                            raise ValueError(f"exact move={child['move']} requires integer edaxDepth")
                        if child["edaxDepth"] < actual["childEmpties"]:
                            raise ValueError(
                                f"exact move={child['move']} depth={child['edaxDepth']} "
                                f"< empties={actual['childEmpties']}"
                            )
                    elif child.get("exact") is not False or child.get("level") != 16:
                        raise ValueError(
                            f"move={child['move']} empties={actual['childEmpties']} requires exact=false/level=16"
                        )
            except (KeyError, TypeError, ValueError, StopIteration) as exc:
                report(set_name, f"positionId={pos_id}: {exc}")
                batch_errors += 1

            key_value = rec.get("canonicalKey")
            if (
                not isinstance(key_value, list)
                or len(key_value) != 3
                or any(not isinstance(value, int) or isinstance(value, bool) for value in key_value)
            ):
                report(set_name, f"positionId={pos_id}: malformed canonicalKey")
                batch_errors += 1
            else:
                if key_value != recomputed_key:
                    report(
                        set_name,
                        f"positionId={pos_id}: canonicalKey mismatch stored={key_value} board={recomputed_key}",
                    )
                    batch_errors += 1
                key = tuple(recomputed_key)
                if key in seen_canonical:
                    report(set_name, f"positionId={pos_id}: recomputed D4 key duplicates {seen_canonical[key]}")
                    batch_errors += 1
                else:
                    seen_canonical[key] = pos_id
                if key in ORACLE_KEYS:
                    report(set_name, f"positionId={pos_id}: canonicalKey matches a t096 independent-oracle position")
                    batch_errors += 1
        return batch_errors

    base_fh = None
    prefix_hash = None
    if set_name == "expanded1m":
        base_path = EXPANDED1M_BASE_PATH
        if not base_path.exists():
            report(set_name, "ERROR: expanded200k base missing; prefix identity cannot be verified")
            errors += 1
        else:
            base_fh = base_path.open("r", encoding="utf-8", newline="")
            prefix_hash = hashlib.sha256()

    with jsonl_path.open("r", encoding="utf-8", newline="") as fh:
        for line_no, raw in enumerate(fh, start=1):
            if not raw.strip():
                report(set_name, f"line {line_no}: malformed blank JSONL line")
                errors += 1
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                report(set_name, f"line {line_no}: malformed JSON ({exc})")
                errors += 1
                continue
            if not isinstance(value, dict):
                report(set_name, f"line {line_no}: record is not an object")
                errors += 1
                continue
            if value.get("positionId") != record_count:
                report(
                    set_name,
                    f"positionId sequence mismatch at record {record_count}: got {value.get('positionId')}",
                )
                errors += 1
            if base_fh is not None and record_count < EXPANDED1M_BASE_COUNT:
                base_raw = base_fh.readline()
                if raw != base_raw:
                    report(set_name, f"positionId={record_count}: expanded200k prefix byte mismatch")
                    errors += 1
                if prefix_hash is not None:
                    prefix_hash.update(raw.encode("utf-8"))
            for message in schema_errors(value):
                report(set_name, f"positionId={value.get('positionId')}: {message}")
                errors += 1
            if record_count < resume_record_count:
                # 前回checkpointまでに既にverify_batchで検証済み(subprocessでの
                # children/canonical recomputeとD4重複・oracle照合は完了している)。
                record_count += 1
                continue
            batch.append(value)
            record_count += 1
            if len(batch) >= BATCH_SIZE:
                errors += verify_batch(batch, record_count - len(batch))
                batch.clear()
                if progress_every and record_count % progress_every == 0:
                    elapsed = time.monotonic() - start_time
                    rate_suffix = f", rate={record_count / elapsed:.0f}/s" if elapsed > 0 else ""
                    report(
                        set_name,
                        f"progress: {record_count}/{expected_total or '?'} record(s), {errors} error(s), "
                        f"elapsed={elapsed:.1f}s{rate_suffix}",
                    )
                    sys.stdout.flush()
                    if checkpoint_path is not None:
                        save_verify_checkpoint(
                            checkpoint_path, set_name, record_count, errors, seen_canonical, fingerprint
                        )
    if batch:
        errors += verify_batch(batch, record_count - len(batch))
    if base_fh is not None:
        base_fh.close()
        if record_count >= EXPANDED1M_BASE_COUNT and prefix_hash is not None:
            if prefix_hash.hexdigest() != EXPANDED1M_BASE_SHA256:
                report(set_name, "ERROR: expanded200k prefix SHA-256 mismatch")
                errors += 1

    if set_name == "expanded1m" and record_count != EXPANDED1M_TOTAL_COUNT:
        report(set_name, f"ERROR: expanded1m must contain exactly {EXPANDED1M_TOTAL_COUNT} records")
        errors += 1

    if expected_total != record_count or expected_done != record_count:
        report(
            set_name,
            f"meta count mismatch: records={record_count} progress.done={expected_done} progress.total={expected_total}",
        )
        errors += 1
    if checkpoint_path is not None:
        # 完走時点のcheckpointを残す。次回実行が全件済みの状態から始まっても
        # resume_record_count==record_countとなり、スキップのみで即完走する。
        save_verify_checkpoint(checkpoint_path, set_name, record_count, errors, seen_canonical, fingerprint)
    elapsed_total = time.monotonic() - start_time
    print(f"[{set_name}] verified {record_count} record(s), {errors} error(s), elapsed={elapsed_total:.1f}s")
    return record_count, errors


def validated_progress_every(progress_every: int) -> int:
    """T143(軽微対応11): `--progress-every`がBATCH_SIZE(500)の倍数でないと、
    進捗ログ・checkpoint保存の判定(`record_count % progress_every == 0`)は
    `len(batch) >= BATCH_SIZE`(500件ごと)の内側でしか評価されないため、倍数で
    ない値ではほとんど(組み合わせによっては全く)発火しない。1M件規模の実行で
    checkpointが実質保存されなくなる事故を防ぐため、倍数でなければ警告のうえ
    次のBATCH_SIZE倍数へ切り上げる(0=無効化はそのまま素通しする)。"""
    if progress_every and progress_every % BATCH_SIZE != 0:
        rounded = ((progress_every // BATCH_SIZE) + 1) * BATCH_SIZE
        print(
            f"WARNING: --progress-every={progress_every} is not a multiple of BATCH_SIZE={BATCH_SIZE}; "
            f"progress/checkpoint saves only happen at BATCH_SIZE boundaries, rounding up to {rounded}",
            file=sys.stderr,
        )
        return rounded
    return progress_every


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_names", nargs="+", choices=["smoke", "primary", "expanded200k", "expanded1m"])
    parser.add_argument(
        "--progress-every",
        type=int,
        default=DEFAULT_PROGRESS_EVERY,
        help=f"records between progress log lines (default {DEFAULT_PROGRESS_EVERY}; 0 disables)",
    )
    parser.add_argument(
        "--checkpoint-dir",
        type=Path,
        default=None,
        help="directory for per-set resume checkpoints (T127c long-running rule); omit to disable",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="load an existing checkpoint under --checkpoint-dir if present (no-op without --checkpoint-dir)",
    )
    args = parser.parse_args()
    args.progress_every = validated_progress_every(args.progress_every)
    total_records = total_errors = 0
    for set_name in args.set_names:
        checkpoint_path = (
            args.checkpoint_dir / f"{set_name}.verify-checkpoint.json" if args.checkpoint_dir else None
        )
        if checkpoint_path is not None:
            # T143(軽微対応11): `.tmp`は`save_verify_checkpoint`の原子的置換
            # (tmp書き→os.replace)が完了する前にプロセスが落ちたときだけ残る
            # 中間ファイルで、読み込まれることは無い。放置しても実害は薄いが、
            # 気づかず溜め続けないようcheckpoint本体の掃除と同じタイミングで
            # 一緒に片付ける(resume時も含め、常に安全に削除できる)。
            tmp_path = checkpoint_path.with_suffix(checkpoint_path.suffix + ".tmp")
            if tmp_path.exists():
                tmp_path.unlink()
            if not args.resume and checkpoint_path.exists():
                checkpoint_path.unlink()
        count, errors = verify_one(
            set_name,
            progress_every=args.progress_every or None,
            checkpoint_path=checkpoint_path,
        )
        total_records += count
        total_errors += errors
    print(f"TOTAL: {total_records} record(s) verified, {total_errors} error(s)")
    raise SystemExit(1 if total_errors else 0)


if __name__ == "__main__":
    main()

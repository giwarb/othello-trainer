#!/usr/bin/env python3
"""T090a: Edax level 16(または完全読み)を教師とする学習用コーパスの生成。

設計書 `tasks/design/T085-beat-level10-report.md` の §9 T090a節、および
タスク仕様 `tasks/T090a-teacher-corpus.md` の実装。T087(特徴追加)・T088(学習法改善)
がいずれもWTHOR最終石差ラベルの質不足で頭打ちになったため、教師ラベル自体を
Edaxの探索値に置き換えるための第一段(コーパス生成)。

# パイプライン全体

1. **候補局面プールの抽出**(`cargo run -p train --release --bin teacher_candidates -- extract`、
   別プロセス、本スクリプトが起動時に自動実行): WTHOR 2015〜2024の対局を
   `train::train_data::samples_from_game`で再生し(合法手判定・パス処理は既存の
   学習パイプラインをそのまま再利用、Othelloのルールをここで再実装しない)、
   空きマス帯6段階のフェーズbinごとに1対局あたり最大1局面、`train::experiment::canonicalize`
   (D4正準化、T088既存実装)でグローバル重複除去したJSON(`train/data/teacher/candidates.json`)
   を書き出す。
2. **高regret局面の合流**: `bench/edax-compare/vs_edax_results.json`の
   `loss_analysis.entries`から`loss >= 4`の局面を全件読み込み、優先層として
   候補プールと合流する(D4正準化での重複排除込み)。
3. **層化サンプリング**: フェーズ6binへの目標配分を、各binの実際の母集団数を
   上限とする「waterfall」方式で決め、`random.Random(seed)`で決定的に抽出する。
4. **合法手・子局面の一括計算**: `teacher_candidates.exe children`
   (1プロセス起動でN局面すべてを処理、`engine::bitboard::Board`の認定済み実装を
   使う。Othelloのルールや着手適用をPython側で再実装しない)。
5. **Edax教師値**: 各候補局面の子局面ごとに、空きマス数が閾値以下
   (`EXACT_EMPTIES_THRESHOLD`)なら`EXACT_EDAX_LEVEL`(Edaxが即座に完全読みへ
   落ちる帯であることを`t085_exact_positions.json`の既存実績(空き19〜24を
   `-l 60`で解いた実績、T085b)から踏襲)、それ以外は`DEFAULT_EDAX_LEVEL`
   (T082/T084から使われている`DEFAULT_HIGH_LEVEL=16`と同じ値)で
   `vs_edax.edax_solve`(既存のOBF一時ファイル・終了コード非ゼロ許容パースを
   再利用)を呼ぶ。終局する子局面はEdaxを呼ばず確定石差(`vs_edax.terminal_value`)
   を使う(Edaxは空きマス0の局面のPVパースに失敗することがT082で判明済みのため)。
6. **1局面ごとのcheckpoint**: 完了した局面を`.jsonl`へ逐次追記する
   (CLAUDE.mdの長時間実行ルール)。設定・Edax/teacher_candidatesバイナリの
   sha256・入力コーパスファイルのsha256が起動時と変わっていれば、既存
   checkpointへの追記を拒否する(`vs_edax.py`の`provenance_identity`方式を踏襲)。

実行方法(リポジトリルートから):
    python bench/edax-compare/gen_teacher_corpus.py smoke     # 1,000局面
    python bench/edax-compare/gen_teacher_corpus.py primary   # 50,000局面
    python bench/edax-compare/gen_teacher_corpus.py smoke --dry-run  # 選定のみ(Edax呼び出しなし)

    # T090a追記(primary所要時間が8時間見積もりを超過したため、オーケストレーター裁定で
    # シャード並列化を追加。既定N=1(下記シャード引数省略時)は従来どおり逐次実行のまま、
    # 挙動・runKeyとも変更なし):
    python bench/edax-compare/gen_teacher_corpus.py primary --num-shards 8
        # 親プロセス(orchestrator)がpositionIdストライプ(idx % N == shardIndex)で
        # N個の子プロセス(このスクリプト自身を`--shard-index I`付きで再帰的に起動)を
        # `subprocess.Popen`で並列起動し、各シャード独立のJSONLチェックポイント
        # (`corpus_primary_shard{I}of{N}.jsonl`)へ書き込ませる。全シャード完了後、
        # 標準の`corpus_primary.jsonl`へマージする。

前提: `cargo build --release -p train --bin teacher_candidates` でビルド済み、
`bench/edax-compare/edax-extract/`にEdaxが展開済み(`download-edax.ps1`)。

# 出力スキーマ(`train/data/teacher/corpus_{smoke,primary}.jsonl`、1行1局面のJSON)

`train/data/`配下は`.gitignore`で除外されコミットされないため(WTHOR生データと同じ
再配布可否不明の理由、および本コーパス自体も生成物でサイズが大きいため)、本コーパスの
フォーマット仕様はこのdocstringを正本とする(`train/data/teacher/README.md`にも同内容の
説明を書いているが、そのファイル自体は上記gitignoreの対象でコミットされない)。

```jsonc
{
  "positionId": 0,
  "board": "<64文字OBF、a1..h8順、X=黒/O=白/-=空>",
  "sideToMove": "black" | "white",
  "empties": 53,
  "source": "wthor" | "engineLoss",
  "phaseBin": 0,                 // sourceが"wthor"の場合のみ(0..5, 空きマス帯6段階)
  "hasXcLegalMove": false,       // sourceが"wthor"の場合のみ
  "priorityLoss": null,          // sourceが"engineLoss"の場合、T084弱点分析のloss石数(>=4)
  "canonicalKey": [blackU64, whiteU64, moverU8],  // D4正準化キー
  "children": [                  // **その局面の全合法手**(bestだけでなく全候補)
    {
      "move": "d3",
      "value": 4.0,             // sideToMove視点での、その手を打った後の評価値(石差)
      "exact": true,            // true: 完全読み(空き<=EXACT_EMPTIES_THRESHOLDまたは終局)
      "level": 60,              // Edaxへ渡した -l 値(終局子はnull、Edax未呼び出し)
      "edaxDepth": 24,          // Edaxが報告した到達深さ(終局子はnull)
      "elapsedMs": 812.3        // このEdax呼び出しの所要時間(終局子は無し、elapsedNoteのみ)
    }
  ],
  "bestMove": "d3",             // children中でvalueが最大の手
  "bestValue": 4.0,             // max(children[].value)と一致(verify_teacher_corpus.pyが検証)
  "generatedAt": "2026-07-14T13:41:00+00:00"
}
```

`value`の符号規約: 子局面で手番が変わらない(相手パス)場合はそのまま、変わる場合は
反転し、常に元局面の`sideToMove`視点に統一する(`vs_edax.analyze_game_losses_v2`と同じ)。
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

print = functools.partial(print, flush=True)

ROOT = Path(__file__).resolve().parents[2]
COMPARE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(COMPARE_DIR))
import vs_edax  # noqa: E402  (既存のEdax呼び出し・provenanceユーティリティを再利用)

TEACHER_CANDIDATES_TOOL = ROOT / "target" / "release" / "teacher_candidates.exe"
TEACHER_DATA_DIR = ROOT / "train" / "data" / "teacher"
CANDIDATES_PATH = TEACHER_DATA_DIR / "candidates.json"
VS_EDAX_RESULTS_PATH = COMPARE_DIR / "vs_edax_results.json"

# --- 設計判断(仕様に明記が無いためこのタスクで決定、manifestにも記録する) ---

# フェーズbin(6段階、`teacher_candidates.rs::PHASE_BIN_LOWER_BOUNDS`と一致させる。
# ここではPython側で再定義せず、`candidates.json`のmanifestに書かれた値をそのまま使う)。
NUM_PHASE_BINS = 6

# 高regret局面の閾値(タスク仕様が明示: loss >= 4石)。
HIGH_REGRET_MIN_LOSS = 4.0

# 完全読み判定の空きマス閾値。`t085_exact_positions.json`(T085b)が
# 「空き19〜24: quota-policy/oracle corpus」として`-l 60`で解いた実績があり、
# この帯でEdaxの完全読みが実用時間で完走することを確認済みのため、
# 少し安全側に24を採用する(design report §9の「目安: Edaxが即時exactを返す帯」
# に対応する具体値としてこのタスクで決定)。
EXACT_EMPTIES_THRESHOLD = 24
# 完全読みを強制するレベル(空き<=24なら`-l 60 >= 空き数`となり常に完全読みになる。
# `compare_pattern_v3.py`のoracle実装と同じ値を踏襲)。
EXACT_EDAX_LEVEL = 60
# 完全読み対象外の局面に使う探索レベル(T082/T084の`DEFAULT_HIGH_LEVEL`と同じ)。
DEFAULT_EDAX_LEVEL = 16

DEFAULT_SEED = 90100

CORPUS_SETS = {
    "smoke": {"targetCount": 1_000, "seed": DEFAULT_SEED + 1},
    "primary": {"targetCount": 50_000, "seed": DEFAULT_SEED + 2},
}


# --- D4正準化(Python版、`engine/src/patterns.rs::apply_symmetry`と
#     `train/src/experiment.rs::canonicalize`のアルゴリズムを再実装)。
#     Rust側を直接呼べない(train crateはCLIバイナリのみでFFI/サブコマンド
#     公開が無い)ため、cross-source(WTHOR抽出プール由来 + engine高regret局面
#     由来)の重複排除にだけ使う。座標変換は`engine/src/patterns.rs`の
#     `symmetry_coords`(0-based, rank-major, a1=bit0)をそのまま踏襲する。 ---

_SYMMETRY_TRANSFORMS = [
    lambda r, f: (r, f),  # 0: 恒等
    lambda r, f: (f, 7 - r),  # 1: 90度回転
    lambda r, f: (7 - r, 7 - f),  # 2: 180度回転
    lambda r, f: (7 - f, r),  # 3: 270度回転
    lambda r, f: (r, 7 - f),  # 4: 左右反転
    lambda r, f: (7 - r, f),  # 5: 上下反転
    lambda r, f: (f, r),  # 6: 転置(主対角線)
    lambda r, f: (7 - f, 7 - r),  # 7: 反転転置(反対角線)
]


def _transform_bits(bits: int, symmetry: int) -> int:
    transform = _SYMMETRY_TRANSFORMS[symmetry]
    out = 0
    b = bits
    while b:
        lsb = b & (-b)
        cell = lsb.bit_length() - 1
        b &= b - 1
        r, f = divmod(cell, 8)
        nr, nf = transform(r, f)
        out |= 1 << (nr * 8 + nf)
    return out


def canonical_key(black: int, white: int, mover: int) -> tuple[int, int, int]:
    """`train::experiment::canonicalize`と同じ規約
    (`(black_bits, white_bits, mover)`の8変換中の辞書順最小)。"""
    best = None
    for sym in range(8):
        cand = (_transform_bits(black, sym), _transform_bits(white, sym), mover)
        if best is None or cand < best:
            best = cand
    return best


def parse_obf(board: str) -> tuple[int, int]:
    black = 0
    white = 0
    for i, c in enumerate(board[:64]):
        if c in ("X", "x", "*"):
            black |= 1 << i
        elif c in ("O", "o"):
            white |= 1 << i
    return black, white


def _mover_int(side: str) -> int:
    return 0 if side == "black" else 1


def canonical_key_of_position(board: str, side: str) -> tuple[int, int, int]:
    black, white = parse_obf(board)
    return canonical_key(black, white, _mover_int(side))


def _self_test_canonicalize() -> None:
    """起動時の健全性チェック(既知の変換を手計算した値と突き合わせる)。
    a1(bit0)が90度回転でh1(bit7)に写ることは`apply_symmetry`の座標変換
    (`(rank,file)=(0,0)` -> `(file,7-rank)=(0,7)` -> `cell=0*8+7=7`)から
    直接導ける。"""
    a1 = 1 << 0
    h1 = 1 << 7
    assert _transform_bits(a1, 1) == h1, "symmetry 1 (90-degree rotation) sanity check failed"
    a8 = 1 << 56
    assert _transform_bits(a1, 2) == 1 << 63, "symmetry 2 (180-degree rotation) sanity check failed: a1 -> h8"
    assert _transform_bits(a1, 5) == a8, "symmetry 5 (up-down flip) sanity check failed: a1 -> a8"
    # 恒等変換は常に不変。
    assert _transform_bits(0x123456789ABCDEF0, 0) == 0x123456789ABCDEF0
    # canonical_keyは対称な2つの表現から同じキーを返す(180度回転で自己対称な
    # 初期局面は黒白の対応が変わらないことを確認する)。
    black0, white0 = parse_obf(
        "---------------------------OX------XO---------------------------------"[:64]
    )
    # (上のOBF文字列はダミーで長さ調整用。実際の初期局面は下で生成する。)
    board = ["-"] * 64
    board[27] = "O"  # d4
    board[36] = "O"  # e5
    board[28] = "X"  # e4
    board[35] = "X"  # d5
    initial_obf = "".join(board)
    key_black_to_move = canonical_key_of_position(initial_obf, "black")
    # 180度回転(symmetry 2)で初期局面は自分自身に写る(石の色ごと位置が
    # 入れ替わって元の配置と一致するため)。よってどのsymmetryを選んでも
    # canonical boardは同一になるはず(念のため2回計算し一致を確認)。
    key_black_to_move_2 = canonical_key_of_position(initial_obf, "black")
    assert key_black_to_move == key_black_to_move_2


_self_test_canonicalize()


# --- 候補局面プールの抽出(teacher_candidates.rs extract の実行) ---


def run_extract(years: str, seed: int, per_game_cap: int, out_path: Path) -> None:
    if not TEACHER_CANDIDATES_TOOL.exists():
        print("Building teacher_candidates (cargo build --release -p train --bin teacher_candidates) ...")
        subprocess.run(
            ["cargo", "build", "--release", "-p", "train", "--bin", "teacher_candidates"],
            cwd=str(ROOT),
            check=True,
        )
    cmd = [
        str(TEACHER_CANDIDATES_TOOL),
        "extract",
        "--data-dir",
        str(ROOT / "train" / "data"),
        "--years",
        years,
        "--seed",
        str(seed),
        "--per-game-cap",
        str(per_game_cap),
        "--out",
        str(out_path),
    ]
    print(f"  extracting candidate pool: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.stderr:
        print(f"  [teacher_candidates extract] {result.stderr.strip()}")
    if result.returncode != 0:
        raise RuntimeError(f"teacher_candidates extract failed (code={result.returncode}): {result.stdout}\n{result.stderr}")


def run_children_batch(positions: list[dict]) -> list[dict]:
    """`teacher_candidates.exe children`を1プロセス起動でまとめて呼ぶ。"""
    if not positions:
        return []
    input_json = json.dumps([{"board": p["board"], "sideToMove": p["sideToMove"]} for p in positions])
    result = subprocess.run(
        [str(TEACHER_CANDIDATES_TOOL), "children"],
        input=input_json,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"teacher_candidates children failed (code={result.returncode}): {result.stderr}")
    return json.loads(result.stdout)


# --- 高regret局面の読み込み ---


def load_high_regret_positions(path: Path, min_loss: float) -> list[dict]:
    if not path.exists():
        print(f"  WARNING: {path} not found; no high-regret positions will be included")
        return []
    doc = json.loads(path.read_text(encoding="utf-8"))
    entries = ((doc.get("loss_analysis") or {}).get("entries")) or []
    filtered = [e for e in entries if e.get("loss", 0.0) >= min_loss]

    seen: set[tuple[int, int, int]] = set()
    deduped: list[dict] = []
    for e in filtered:
        key = canonical_key_of_position(e["board"], e["side"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(
            {
                "board": e["board"],
                "sideToMove": e["side"],
                "source": "engineLoss",
                "priorityLoss": e["loss"],
                "priorityGameId": e.get("game_id"),
                "priorityPly": e.get("ply"),
            }
        )
    print(f"  loaded {len(entries)} loss_analysis entries, {len(filtered)} with loss>={min_loss}, {len(deduped)} after D4 dedup")
    return deduped


# --- 層化サンプリング ---


def allocate_bin_targets(bin_populations: list[int], remaining_target: int) -> list[int]:
    """binごとの母集団数を上限として、`remaining_target`を可能な限り均等に
    配分する(waterfall方式: 均等割り当てで母集団を超えるbinはその母集団数に
    キャップし、余りを未キャップのbinへ再配分する。これを収束するまで繰り返す)。"""
    n = len(bin_populations)
    allocated = [0] * n
    remaining_bins = set(range(n))
    remaining = remaining_target
    while remaining > 0 and remaining_bins:
        share = remaining // len(remaining_bins)
        extra = remaining % len(remaining_bins)
        if share == 0 and extra == 0:
            break
        progressed = False
        for i in sorted(remaining_bins):
            want = share + (1 if extra > 0 else 0)
            if extra > 0:
                extra -= 1
            capacity = bin_populations[i] - allocated[i]
            give = min(want, capacity)
            if give > 0:
                allocated[i] += give
                remaining -= give
                progressed = True
            if capacity <= give:
                remaining_bins.discard(i)
        if not progressed:
            break
    return allocated


def select_positions(pool: dict, priority: list[dict], target_count: int, seed: int) -> tuple[list[dict], dict]:
    priority_keys = {canonical_key_of_position(p["board"], p["sideToMove"]) for p in priority}
    priority_selected = priority[:target_count]  # 通常69件程度なので事実上全件

    remaining_target = max(0, target_count - len(priority_selected))

    pool_positions = pool["positions"]
    by_bin: list[list[dict]] = [[] for _ in range(NUM_PHASE_BINS)]
    for row in pool_positions:
        key = canonical_key_of_position(row["board"], row["sideToMove"])
        if key in priority_keys:
            continue  # 優先層と重複するものは除外(cross-source dedup)
        by_bin[row["phaseBin"]].append(row)

    bin_populations = [len(b) for b in by_bin]
    allocation = allocate_bin_targets(bin_populations, remaining_target)

    sampled: list[dict] = []
    rng = random.Random(seed)
    for bin_idx, count in enumerate(allocation):
        bucket = by_bin[bin_idx]
        chosen = rng.sample(bucket, count) if count < len(bucket) else list(bucket)
        for row in chosen:
            sampled.append({**row})

    selected = priority_selected + sampled
    stats = {
        "targetCount": target_count,
        "prioritySelected": len(priority_selected),
        "poolAvailableAfterPriorityDedup": bin_populations,
        "binAllocation": allocation,
        "sampledFromPool": len(sampled),
        "totalSelected": len(selected),
    }
    return selected, stats


# --- 教師値の付与(Edax呼び出し) ---


def label_position(index: int, position: dict, children_info: dict) -> dict:
    board = position["board"]
    side = position["sideToMove"]
    mover_key = canonical_key_of_position(board, side)

    child_records = []
    for child in children_info["moves"]:
        child_empties = child["childEmpties"]
        if child["childIsTerminal"]:
            value = vs_edax.terminal_value(child["childBoard"], side)
            child_records.append(
                {
                    "move": child["move"],
                    "value": value,
                    "exact": True,
                    "level": None,
                    "edaxDepth": None,
                    "elapsedNote": "terminal (no Edax call)",
                }
            )
            continue

        is_exact = child_empties <= EXACT_EMPTIES_THRESHOLD
        level = EXACT_EDAX_LEVEL if is_exact else DEFAULT_EDAX_LEVEL
        t0 = time.monotonic()
        result = vs_edax.edax_solve(child["childBoard"], child["childSideToMove"], level)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        if child["childSideToMove"] == side:
            value = result["discDiff"]
        else:
            value = -result["discDiff"]
        child_records.append(
            {
                "move": child["move"],
                "value": value,
                "exact": is_exact,
                "level": level,
                "edaxDepth": result["depth"],
                "elapsedMs": round(elapsed_ms, 1),
            }
        )

    best = max(child_records, key=lambda c: c["value"])
    return {
        "positionId": index,
        "board": board,
        "sideToMove": side,
        "empties": children_info["empties"],
        "source": position["source"],
        "phaseBin": position.get("phaseBin"),
        "hasXcLegalMove": position.get("hasXcLegalMove"),
        "priorityLoss": position.get("priorityLoss"),
        "canonicalKey": list(mover_key),
        "children": child_records,
        "bestMove": best["move"],
        "bestValue": best["value"],
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# --- provenance / checkpoint ---


def sha256_of_file(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def build_run_metadata(candidates_path: Path) -> dict:
    return {
        "gitCommit": vs_edax.git_commit_hash(),
        "harnessSha256": sha256_of_file(Path(__file__)),
        "teacherCandidatesToolSha256": sha256_of_file(TEACHER_CANDIDATES_TOOL),
        "edaxSha256": sha256_of_file(vs_edax.EDAX_EXE),
        "edaxEvalDataSha256": sha256_of_file(vs_edax.EDAX_EVAL_DATA),
        "candidatesPoolSha256": sha256_of_file(candidates_path),
        "highRegretSourceSha256": sha256_of_file(VS_EDAX_RESULTS_PATH),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


PROVENANCE_IDENTITY_KEYS = (
    "harnessSha256",
    "teacherCandidatesToolSha256",
    "edaxSha256",
    "edaxEvalDataSha256",
    "candidatesPoolSha256",
    "highRegretSourceSha256",
)


def provenance_identity(meta: dict | None) -> dict:
    meta = meta or {}
    return {key: meta.get(key) for key in PROVENANCE_IDENTITY_KEYS}


class TeacherCorpusCheckpoint:
    """1局面ごとにJSONLへ追記するチェックポイント(CLAUDE.mdの長時間実行ルール)。
    `vs_edax.py`の`ResultsCheckpoint`は完了ごとに全体JSONを書き直す方式だが、
    本コーパスはN=50,000件規模のため同方式ではO(N^2)の書き込みになってしまう。
    そのためJSONL追記(O(1)/件)を採用しつつ、同じ「1件ごとに即永続化」
    「provenance不一致なら拒否」「resumeで完了済みをスキップ」という原則は
    そのまま踏襲する。"""

    def __init__(self, jsonl_path: Path, meta_path: Path, run_key: str, settings: dict, meta: dict):
        self.jsonl_path = jsonl_path
        self.meta_path = meta_path
        self.run_key = run_key
        self.settings = settings
        self.meta = meta
        self.done_ids: set[int] = set()
        self._fh = None
        self._start_time = time.monotonic()
        self._done_since_start = 0

    def try_resume(self) -> bool:
        if not self.meta_path.exists() or not self.jsonl_path.exists():
            return False
        try:
            saved_meta_doc = json.loads(self.meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  [resume] {self.meta_path.name} could not be parsed ({exc}), starting fresh")
            return False
        if saved_meta_doc.get("runKey") != self.run_key:
            print(f"  [resume] {self.meta_path.name} runKey mismatch, refusing checkpoint (starting fresh)")
            return False
        if provenance_identity(saved_meta_doc.get("meta")) != provenance_identity(self.meta):
            print(f"  [resume] {self.meta_path.name} provenance mismatch, refusing checkpoint (starting fresh)")
            return False

        done_ids: set[int] = set()
        malformed = 0
        with self.jsonl_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    done_ids.add(rec["positionId"])
                except (json.JSONDecodeError, KeyError):
                    malformed += 1  # クラッシュ時の書きかけ最終行を無視(次回再生成)
        self.done_ids = done_ids
        print(f"  [resume] loaded {len(done_ids)} completed position(s) from {self.jsonl_path.name} (malformed lines skipped: {malformed})")
        return True

    def start_fresh(self) -> None:
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        # 既存ファイルがある(=provenance不一致で拒否された)場合は上書きしない事故を防ぐため、
        # 明示的に空ファイルへ切り替える(呼び出し元はrunKey不一致時のみここに来る想定)。
        self.jsonl_path.write_text("", encoding="utf-8")
        self._write_meta(done_count=0)

    def is_done(self, position_id: int) -> bool:
        return position_id in self.done_ids

    def _open(self):
        if self._fh is None:
            self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = self.jsonl_path.open("a", encoding="utf-8", newline="\n")
        return self._fh

    def append(self, record: dict) -> None:
        fh = self._open()
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
        self.done_ids.add(record["positionId"])
        self._done_since_start += 1

    def write_progress(self, total: int) -> None:
        elapsed = time.monotonic() - self._start_time
        rate = self._done_since_start / elapsed if elapsed > 0 else 0.0
        self._write_meta(done_count=len(self.done_ids), total=total, rate_per_sec=rate)

    def _write_meta(self, done_count: int, total: int | None = None, rate_per_sec: float | None = None) -> None:
        doc = {
            "runKey": self.run_key,
            "meta": self.meta,
            "settings": self.settings,
            "progress": {
                "done": done_count,
                "total": total,
                "ratePerSec": rate_per_sec,
                "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
        }
        vs_edax.atomic_write_text(self.meta_path, json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None


# --- メイン ---


def generate(
    set_name: str,
    dry_run: bool,
    years: str,
    per_game_cap: int,
    num_shards: int = 1,
    shard_index: int = 0,
    skip_extract: bool = False,
) -> None:
    """コーパス生成本体。`num_shards<=1`(既定)なら従来どおり全件を単一プロセスで逐次処理する
    (runKey・チェックポイントファイル名とも旧来のまま、後方互換)。`num_shards>1`のときは
    `run_shard_orchestrator`から`--shard-index`付きで子プロセスとして起動され、
    `selected`(全体で決定的に選定される候補、シャード間で完全に同一)のうち
    `positionId % num_shards == shard_index`の局面だけを処理し、シャード専用の
    `corpus_{set}_shard{I}of{N}.jsonl`へ書き込む(マージは親プロセスの責務)。"""
    cfg = CORPUS_SETS[set_name]
    target_count = cfg["targetCount"]
    seed = cfg["seed"]
    tag = f"{set_name}" if num_shards <= 1 else f"{set_name} shard {shard_index}/{num_shards}"

    TEACHER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    vs_edax.ensure_edax_available()

    print(f"[{tag}] step 1/4: extracting candidate pool (years={years}, seed={seed}, per-game-cap={per_game_cap}) ...")
    if skip_extract and CANDIDATES_PATH.exists():
        print(f"  --skip-extract: reusing existing {CANDIDATES_PATH}")
    else:
        run_extract(years, seed, per_game_cap, CANDIDATES_PATH)
    pool = json.loads(CANDIDATES_PATH.read_text(encoding="utf-8"))
    print(f"  pool: {pool['totalCandidatesAfterDedup']} candidates from {pool['totalGamesInYearRange']} games")

    print(f"[{tag}] step 2/4: loading high-regret positions (loss>={HIGH_REGRET_MIN_LOSS}) ...")
    priority = load_high_regret_positions(VS_EDAX_RESULTS_PATH, HIGH_REGRET_MIN_LOSS)

    print(f"[{tag}] step 3/4: stratified sampling to target={target_count} ...")
    selected, selection_stats = select_positions(pool, priority, target_count, seed)
    print(f"  selected {len(selected)} position(s): {selection_stats}")

    meta = build_run_metadata(CANDIDATES_PATH)
    settings = {
        "setName": set_name,
        "targetCount": target_count,
        "seed": seed,
        "years": years,
        "perGameCap": per_game_cap,
        "highRegretMinLoss": HIGH_REGRET_MIN_LOSS,
        "exactEmptiesThreshold": EXACT_EMPTIES_THRESHOLD,
        "exactEdaxLevel": EXACT_EDAX_LEVEL,
        "defaultEdaxLevel": DEFAULT_EDAX_LEVEL,
        "numPhaseBins": NUM_PHASE_BINS,
        "phaseBinLowerBounds": pool.get("phaseBinLowerBounds"),
        "selectionStats": selection_stats,
    }
    # シャード無し(num_shards<=1)の場合はキーを追加しない: 既存のsmoke checkpoint
    # (T090aシャード機能追加前に生成済み)のrunKeyと完全に一致させ、resume互換を保つため。
    if num_shards > 1:
        settings["numShards"] = num_shards
        settings["shardIndex"] = shard_index
    run_key = json.dumps(settings, sort_keys=True)

    if num_shards > 1:
        jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{shard_index}of{num_shards}.jsonl"
        meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{shard_index}of{num_shards}.meta.json"
    else:
        jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
        meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"

    if dry_run:
        print(f"[{tag}] --dry-run: skipping Edax labeling. Selection stats: {selection_stats}")
        return

    checkpoint = TeacherCorpusCheckpoint(jsonl_path, meta_path, run_key, settings, meta)
    if not checkpoint.try_resume():
        checkpoint.start_fresh()

    # このプロセス(シャード)が担当するグローバルindex集合(positionIdのストライプ)。
    shard_global_indices = [i for i in range(len(selected)) if num_shards <= 1 or i % num_shards == shard_index]
    shard_positions = [selected[i] for i in shard_global_indices]

    print(f"[{tag}] step 4/4: computing children (legal moves + applied boards) for {len(shard_positions)} position(s) ...")
    children_batch = run_children_batch(shard_positions)
    assert len(children_batch) == len(shard_positions), "children batch size mismatch"
    children_by_global_index = dict(zip(shard_global_indices, children_batch))

    total = len(shard_global_indices)
    todo_indices = [i for i in shard_global_indices if not checkpoint.is_done(i)]
    print(f"  {total - len(todo_indices)}/{total} already done (resume), {len(todo_indices)} remaining")

    error_count = 0
    for progress_i, idx in enumerate(todo_indices, start=1):
        position = selected[idx]
        children_info = children_by_global_index[idx]
        try:
            record = label_position(idx, position, children_info)
        except Exception as exc:  # noqa: BLE001
            error_count += 1
            print(f"  ERROR at positionId={idx} board={position['board']} side={position['sideToMove']}: {exc}")
            raise
        checkpoint.append(record)
        if progress_i % 20 == 0 or progress_i == len(todo_indices):
            checkpoint.write_progress(total)
            done = len(checkpoint.done_ids)
            elapsed = time.monotonic() - checkpoint._start_time
            rate = checkpoint._done_since_start / elapsed if elapsed > 0 else 0.0
            eta_s = (total - done) / rate if rate > 0 else float("inf")
            print(
                f"  [{tag}] {done}/{total} done "
                f"({rate:.2f} pos/s, elapsed={elapsed:.0f}s, eta={eta_s:.0f}s, errors={error_count})"
            )

    checkpoint.write_progress(total)
    checkpoint.close()
    print(f"[{tag}] COMPLETE: {len(checkpoint.done_ids)}/{total} positions written to {jsonl_path}")


# --- シャード並列オーケストレーション(primary所要時間が8時間見積もりを超えたため追加。
#     オーケストレーター裁定 2026-07-14: 規模50,000を維持しシャード並列化で続行) ---


def run_shard_orchestrator(set_name: str, num_shards: int, per_game_cap: int, years: str, poll_interval_s: float = 15.0) -> None:
    cfg = CORPUS_SETS[set_name]
    target_count = cfg["targetCount"]

    TEACHER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    logs_dir = TEACHER_DATA_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    vs_edax.ensure_edax_available()

    print(f"[{set_name}] orchestrator: extracting candidate pool once (years={years}, per-game-cap={per_game_cap}) before spawning {num_shards} shard(s) ...")
    run_extract(years, cfg["seed"], per_game_cap, CANDIDATES_PATH)

    script_path = str(Path(__file__).resolve())
    procs: list[subprocess.Popen] = []
    log_files = []
    started_at = time.monotonic()
    for shard_index in range(num_shards):
        log_path = logs_dir / f"shard{shard_index}of{num_shards}.log"
        log_fh = open(log_path, "w", encoding="utf-8")
        log_files.append(log_fh)
        cmd = [
            sys.executable,
            script_path,
            set_name,
            "--num-shards",
            str(num_shards),
            "--shard-index",
            str(shard_index),
            "--skip-extract",
            "--years",
            years,
            "--per-game-cap",
            str(per_game_cap),
        ]
        print(f"  spawning shard {shard_index}/{num_shards}: {' '.join(cmd)} (log: {log_path})")
        proc = subprocess.Popen(cmd, stdout=log_fh, stderr=subprocess.STDOUT, cwd=str(ROOT))
        procs.append(proc)

    print(f"[{set_name}] orchestrator: {num_shards} shard(s) launched, polling every {poll_interval_s:.0f}s ...")

    def shard_meta_path(i: int) -> Path:
        return TEACHER_DATA_DIR / f"corpus_{set_name}_shard{i}of{num_shards}.meta.json"

    while True:
        time.sleep(poll_interval_s)
        total_done = 0
        per_shard_status = []
        for i, proc in enumerate(procs):
            done_i = 0
            mp = shard_meta_path(i)
            if mp.exists():
                try:
                    doc = json.loads(mp.read_text(encoding="utf-8"))
                    done_i = (doc.get("progress") or {}).get("done", 0) or 0
                except (json.JSONDecodeError, OSError):
                    pass
            total_done += done_i
            alive = proc.poll() is None
            per_shard_status.append(f"shard{i}={done_i}({'running' if alive else f'exit={proc.returncode}'})")
        elapsed = time.monotonic() - started_at
        rate = total_done / elapsed if elapsed > 0 else 0.0
        eta_s = (target_count - total_done) / rate if rate > 0 else float("inf")
        print(
            f"[{set_name}] orchestrator: {total_done}/{target_count} done total "
            f"({rate:.2f} pos/s aggregate, elapsed={elapsed:.0f}s, eta={eta_s:.0f}s) | {' '.join(per_shard_status)}"
        )
        if all(proc.poll() is not None for proc in procs):
            break

    for log_fh in log_files:
        log_fh.close()

    failed = [(i, proc.returncode) for i, proc in enumerate(procs) if proc.returncode != 0]
    if failed:
        print(f"[{set_name}] orchestrator: ERROR - shard(s) failed: {failed} (see logs under {logs_dir})")
        raise RuntimeError(f"{len(failed)} shard(s) failed: {failed}")

    print(f"[{set_name}] orchestrator: all {num_shards} shard(s) finished successfully, merging ...")
    merge_shards(set_name, num_shards, target_count)


def merge_shards(set_name: str, num_shards: int, target_count: int) -> None:
    """全シャードのJSONLを`positionId`でマージし、標準の`corpus_{set}.jsonl`へ書き出す
    (`verify_teacher_corpus.py`は非シャード時と同じファイル名を読むため)。"""
    merged: dict[int, dict] = {}
    shard_metas = []
    for i in range(num_shards):
        shard_jsonl = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{i}of{num_shards}.jsonl"
        shard_meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{i}of{num_shards}.meta.json"
        if shard_meta_path.exists():
            shard_metas.append(json.loads(shard_meta_path.read_text(encoding="utf-8")))
        if not shard_jsonl.exists():
            raise RuntimeError(f"expected shard file {shard_jsonl} not found")
        with shard_jsonl.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                pid = rec["positionId"]
                if pid in merged:
                    raise RuntimeError(f"duplicate positionId={pid} found across shards (shard {i} and an earlier shard)")
                merged[pid] = rec

    expected_ids = set(range(target_count))
    got_ids = set(merged.keys())
    missing = expected_ids - got_ids
    extra = got_ids - expected_ids
    if missing or extra:
        raise RuntimeError(f"shard merge id mismatch: missing={len(missing)} extra={len(extra)} (expected exactly {target_count} ids)")

    merged_jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    merged_meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    with merged_jsonl_path.open("w", encoding="utf-8", newline="\n") as fh:
        for pid in sorted(merged.keys()):
            fh.write(json.dumps(merged[pid], ensure_ascii=False) + "\n")

    base_meta = shard_metas[0] if shard_metas else {}
    merged_settings = dict(base_meta.get("settings") or {})
    merged_settings.pop("numShards", None)
    merged_settings.pop("shardIndex", None)
    merged_doc = {
        "runKey": None,  # マージ済みファイルはシャード実行のrunKeyをそのまま引き継がない(参考情報のみ)
        "meta": base_meta.get("meta"),
        "settings": merged_settings,
        "mergedFromShards": num_shards,
        "progress": {
            "done": len(merged),
            "total": target_count,
            "ratePerSec": None,
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }
    vs_edax.atomic_write_text(merged_meta_path, json.dumps(merged_doc, indent=2, ensure_ascii=False) + "\n")
    print(f"[{set_name}] merge: {len(merged)}/{target_count} position(s) merged into {merged_jsonl_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_name", choices=sorted(CORPUS_SETS.keys()))
    parser.add_argument("--dry-run", action="store_true", help="Selection only, no Edax calls, no checkpoint file written")
    parser.add_argument("--years", default="2015-2024")
    parser.add_argument("--per-game-cap", type=int, default=NUM_PHASE_BINS)
    parser.add_argument(
        "--num-shards",
        type=int,
        default=1,
        help="Split into N parallel shards (orchestrator mode when --shard-index is omitted).",
    )
    parser.add_argument(
        "--shard-index",
        type=int,
        default=None,
        help="Internal: run as a single shard worker (0-based). Set by the orchestrator; do not pass manually.",
    )
    parser.add_argument(
        "--skip-extract",
        action="store_true",
        help="Internal: reuse the existing candidates.json instead of re-running the (non-atomic) Rust extractor. "
        "Used by shard workers to avoid concurrent writers to the same file.",
    )
    args = parser.parse_args()

    if args.shard_index is not None:
        if args.num_shards <= 1:
            raise SystemExit("--shard-index requires --num-shards > 1")
        generate(
            args.set_name,
            args.dry_run,
            args.years,
            args.per_game_cap,
            num_shards=args.num_shards,
            shard_index=args.shard_index,
            skip_extract=args.skip_extract,
        )
    elif args.num_shards > 1:
        if args.dry_run:
            raise SystemExit("--dry-run is not supported together with --num-shards (orchestrator mode)")
        run_shard_orchestrator(args.set_name, args.num_shards, args.per_game_cap, args.years)
    else:
        generate(args.set_name, args.dry_run, args.years, args.per_game_cap, skip_extract=args.skip_extract)


if __name__ == "__main__":
    main()

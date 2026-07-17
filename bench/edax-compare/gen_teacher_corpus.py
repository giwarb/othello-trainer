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
5. **Edax教師値**: 各候補局面の子局面を同一levelごとにまとめ、空きマス数が閾値以下
   (`EXACT_EMPTIES_THRESHOLD`)なら`EXACT_EDAX_LEVEL`(Edaxが即座に完全読みへ
   落ちる帯であることを`t085_exact_positions.json`の既存実績(空き19〜24を
   `-l 60`で解いた実績、T085b)から踏襲)、それ以外は`DEFAULT_EDAX_LEVEL`
   (T082/T084から使われている`DEFAULT_HIGH_LEVEL=16`と同じ値)で
   `vs_edax.edax_solve_batch`で1つの複数行OBF・1プロセスとして解く。教師値の
   決定性を優先してEdaxは`-n 1`に固定する。終局する子局面はEdaxを呼ばず
   確定石差(`vs_edax.terminal_value`)
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

    # T114追記(200,000局面への拡張): `primary`(2015-2024、pool約93k)は200kには
    # 届かないため、`expanded200k`setは`--years`で年範囲をWTHOR公式サイト提供分
    # まで拡張して呼び出す(候補プールの「1対局×1bin=1候補」という選定哲学自体は
    # 不変。対局数を増やして母集団を広げるだけ。オーケストレーター裁定 2026-07-16)。
    # `expanded200k`はCORPUS_SETSで`excludeT096Oracle=True`が設定されており、
    # t096 oracle 60局面(D4対称形込み)を選定段階で自動的に除外する
    # (smoke/primaryにはこのフラグが無く、除外ロジック自体が完全にno-opのため
    # 既存2setのsettings/runKey/resume挙動は不変)。
    python bench/edax-compare/gen_teacher_corpus.py expanded200k --years 2000-2024 --num-shards 8

    # T114追記(resume堅牢化、2026-07-16): resume時のrunKey/provenance不一致は
    # 既定でRuntimeErrorとなり停止する(不一致時に既存checkpointを黙って切り詰める
    # 事故が実際に発生したため)。無関係コミットでのHEAD変化はもう不一致要因にならない
    # (`gitCommit`はPROVENANCE_IDENTITY_KEYSから除外済み、meta記録としては残る)。
    #   --adopt-provenance : provenance(harness/tool/edax等のSHA-256)不一致でも
    #       既存checkpointのJSONLをそのまま採用してresumeし、metaのidentityだけ
    #       現環境の値へ更新する(runKey不一致には効かない)。
    #   --start-fresh       : runKey/provenanceいずれの不一致でも既存checkpointを
    #       意図的に破棄し、ゼロから再生成する(旧来の暗黙のstart_fresh相当)。
    python bench/edax-compare/gen_teacher_corpus.py expanded200k --years 2000-2024 --num-shards 8 --adopt-provenance

前提: `cargo build --release -p train --bin teacher_candidates` でビルド済み、
`bench/edax-compare/edax-extract/`にEdaxが展開済み(`download-edax.ps1`)。

# 出力スキーマ(`train/data/teacher/corpus_{smoke,primary,expanded200k}.jsonl`、1行1局面のJSON)

`train/data/`配下は`.gitignore`で除外されコミットされないため(WTHOR生データと同じ
再配布可否不明の理由、および本コーパス自体も生成物でサイズが大きいため)、本コーパスの
フォーマット仕様はこのdocstringを正本とする(`train/data/teacher/README.md`にも同内容の
説明を書いているが、そのファイル自体は上記gitignoreの対象でコミットされない)。

meta(`corpus_{set}.meta.json`)は`schemaVersion: 2`を直接出力する(T090aでは
別スクリプト`finalize_teacher_corpus.py`が事後的に付与していたが、`diffFromBest`/
`openingKey`は生成時点(`label_position`/`teacher_candidates extract`)で既に
正しく付与されているため、T114以降の新規生成setはfinalizeを経由せず`schemaVersion: 2`
を最初から書く)。

`excludeT096Oracle`(CORPUS_SETSのset別フラグ)が有効なsetでは、`bench/edax-compare/
t096_oracle_positions.json`の60局面(D4正準化済み`canonicalKey`)と一致する候補を
選定段階(`select_positions`)で除外し、settingsに`t096OracleSha256`を記録する。
smoke/primaryはこのフラグが無く、除外ロジック自体が完全にno-op(既存2setの
settings/runKey/resume挙動は不変)。

meta/manifestの`settings`には`edaxTasksPerProcess: 1`と
`elapsedMsPolicy: "batch-averaged"`を記録する。これらが無い既存コーパスは、
Edax既定マルチタスクで1子局面ずつ生成され、level 16ラベルに軽微な非決定性を含みうる
旧世代として区別できる。

```jsonc
{
  "positionId": 0,
  "board": "<64文字OBF、a1..h8順、X=黒/O=白/-=空>",
  "sideToMove": "black" | "white",
  "empties": 53,
  "source": "wthor" | "engineLoss",
  "phaseBin": 0,                 // source固有フィールドは非該当時null
  "hasXcLegalMove": false,
  "openingKey": "...",          // WTHOR対局の8プライ後D4正準化局面。非該当時null
  "priorityLoss": null,          // engineLossではT084弱点分析のloss石数(>=4)
  "canonicalKey": [blackU64, whiteU64, moverU8],  // D4正準化キー
  "children": [                  // **その局面の全合法手**(bestだけでなく全候補)
    {
      "move": "d3",
      "value": 4.0,             // sideToMove視点での、その手を打った後の評価値(石差)
      "diffFromBest": 0.0,      // bestValue - value
      "exact": true,            // true: 完全読み(空き<=EXACT_EMPTIES_THRESHOLDまたは終局)
      "level": 60,              // Edaxへ渡した -l 値(終局子はnull、Edax未呼び出し)
      "edaxDepth": 24,          // Edaxが報告した到達深さ(終局子はnull)
      "elapsedMs": 812.3        // 同levelバッチの合計時間を子局面数で均等割(終局子は無し)
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
import ctypes
import functools
import hashlib
import heapq
import json
import math
import os
import random
import shutil
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
# T114: t096独立oracle(60局面)の非混入を選定段階で保証するための除外ソース。
# `excludeT096Oracle`が有効なCORPUS_SETSエントリでのみ読み込む(smoke/primaryは無効のまま)。
T096_ORACLE_POSITIONS_PATH = COMPARE_DIR / "t096_oracle_positions.json"
EXPANDED1M_CANDIDATES_PATH = TEACHER_DATA_DIR / "candidates_expanded1m.json"
EXPANDED1M_PLAN_PATH = TEACHER_DATA_DIR / "corpus_expanded1m_selection_plan.jsonl"
EXPANDED1M_PLAN_META_PATH = TEACHER_DATA_DIR / "corpus_expanded1m_selection_plan.meta.json"
BASE_CORPUS_PATH = TEACHER_DATA_DIR / "corpus_expanded200k.jsonl"
BASE_MANIFEST_PATH = COMPARE_DIR / "teacher_manifests" / "corpus_expanded200k.meta.json"
BASE_CORPUS_SHA256 = "412477e2da6bacb0d715c7e5d02447d37b6e981237f64f221013a8eb465690e9"
BASE_MANIFEST_SHA256 = "89c3cd33ec491c0aa55b2c4d0165b0785a5b8f3df08674b5107caffc4b223f4c"
EXPANDED1M_BASE_COUNT = 200_000
EXPANDED1M_INCREMENTAL_COUNT = 800_000
EXPANDED1M_ENGINE_LOSS_COUNT = 65
EXPANDED1M_NUM_SHARDS = 8

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
# T114移行(2026-07-16 20:4xユーザー裁定): この値は全setの既定値。expanded200kの
# 生成ペースが空き20-29帯で低下しETAが遅延したため、expanded200kに限り
# `CORPUS_SETS["expanded200k"]["exactEmptiesThreshold"]`で20へ上書きする
# (smoke/primaryはこの値のままでsettings/runKeyとも不変。既存の`excludeT096Oracle`
# フラグと同じ「set別に上書き可、既定値はグローバル定数のまま」という流儀)。
EXACT_EMPTIES_THRESHOLD = 24
# 完全読みを強制するレベル(空き<=24なら`-l 60 >= 空き数`となり常に完全読みになる。
# `compare_pattern_v3.py`のoracle実装と同じ値を踏襲)。
EXACT_EDAX_LEVEL = 60
# 完全読み対象外の局面に使う探索レベル(T082/T084の`DEFAULT_HIGH_LEVEL`と同じ)。
DEFAULT_EDAX_LEVEL = 16

DEFAULT_SEED = 90100
XC_QUOTA_FRACTION = 0.50
OPENING_MAX_FRACTION = 0.02
OPENING_KEY_PLIES = 8

CORPUS_SETS = {
    "smoke": {"targetCount": 1_000, "seed": DEFAULT_SEED + 1},
    "primary": {"targetCount": 50_000, "seed": DEFAULT_SEED + 2},
    # T114: 200,000局面への拡張。primaryとは独立の新規抽出(別seed)とし、
    # 既存primaryの選定結果に対する明示的なcross-set重複除去は行わない
    # (smoke/primary自体も互いにこの重複除去を行っていない既存の設計を踏襲、
    # 理由はタスク作業ログに記録)。年範囲は`--years 2000-2024`をCLIで明示的に
    # 指定して起動する(候補プールがprimaryと同じ2015-2024だと母集団が
    # 約93,000にしかならず200,000に届かないため、オーケストレーター裁定で
    # WTHOR公式サイトの2000-2014分を追加ダウンロードし年範囲を拡張した)。
    # T114移行(2026-07-16 20:4xユーザー裁定): 生成ペース低下(空き20-29帯)による
    # ETA遅延のため、完全読みライン(EXACT_EMPTIES_THRESHOLD)をexpanded200kに限り
    # 24→20へ引き下げる。24で既に完全読み(level=60)ラベル済みの空き21-24局面は
    # `migrate_t114_exact_threshold_20.py`で破棄済み・20方針で再ラベルされる
    # (作業ログ参照)。smoke/primaryはこのキーが無いため`EXACT_EMPTIES_THRESHOLD`
    # (24)のまま=settings/runKey不変。
    "expanded200k": {
        "targetCount": 200_000,
        "seed": DEFAULT_SEED + 3,
        "excludeT096Oracle": True,
        "exactEmptiesThreshold": 20,
    },
    "expanded1m": {
        "targetCount": 1_000_000,
        "seed": DEFAULT_SEED + 4,
        "excludeT096Oracle": True,
        "exactEmptiesThreshold": 20,
        "years": "2000-2024",
        "perGameCap": 24,
        "perBinCap": 4,
        "baseSet": "expanded200k",
        # T127h microbench (未生成各30親): 8=1.195x, 16=1.213x, 32=1.292x、値不一致0。
        "edaxParentsPerProcess": 32,
    },
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
    # canonical_keyはD4変換した別表現から同じキーを返す。
    board = ["-"] * 64
    board[27] = "O"  # d4
    board[36] = "O"  # e5
    board[28] = "X"  # e4
    board[35] = "X"  # d5
    initial_obf = "".join(board)
    black, white = parse_obf(initial_obf)
    transformed_obf = []
    tb, tw = _transform_bits(black, 1), _transform_bits(white, 1)
    for cell in range(64):
        bit = 1 << cell
        transformed_obf.append("X" if tb & bit else "O" if tw & bit else "-")
    assert canonical_key_of_position(initial_obf, "black") == canonical_key_of_position(
        "".join(transformed_obf), "black"
    )


_self_test_canonicalize()


# --- 候補局面プールの抽出(teacher_candidates.rs extract の実行) ---


def run_extract(years: str, seed: int, per_game_cap: int, out_path: Path, per_bin_cap: int = 1) -> None:
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
    ]
    if per_bin_cap != 1:
        cmd.extend(["--per-bin-cap", str(per_bin_cap)])
    cmd.extend(["--out", str(out_path)])
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


# --- T114: t096独立oracleの除外(選定段階でのオラクル非混入保証) ---


def load_oracle_excluded_keys(path: Path) -> tuple[set[tuple[int, int, int]], str | None]:
    """`t096_oracle_positions.json`の各局面は既にD4正準化済みの`canonicalKey`を
    持つ(`select_t096_oracle_positions.py`が`teacher_candidates canonical`
    (Rust `train::experiment::canonicalize`)で計算したもの、本ファイルの
    `canonical_key_of_position`と同一アルゴリズムであることは
    `test_python_rust_d4_agree`で確認済み)。そのためD4対称形の展開は不要で、
    このキー集合との一致チェックだけで対称形込みの除外ができる。"""
    if not path.exists():
        raise RuntimeError(f"t096 oracle positions file not found: {path} (required for oracle exclusion)")
    doc = json.loads(path.read_text(encoding="utf-8"))
    keys = {tuple(p["canonicalKey"]) for p in doc["positions"]}
    return keys, sha256_of_file(path)


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


def select_positions(
    pool: dict,
    priority: list[dict],
    target_count: int,
    seed: int,
    excluded_keys: set[tuple[int, int, int]] | None = None,
) -> tuple[list[dict], dict]:
    """`excluded_keys`(T114: t096 oracleのcanonicalKey集合)が空集合の場合、
    以下の除外分岐は一切実行されず(`if key in excluded_keys`は空集合に対して
    常にFalse)、統計にも`oracleExclusion`キーを追加しない。そのためsmoke/primary
    (`excluded_keys`を渡さない呼び出し)は本変更前と完全に同じ`selection_stats`
    を返し、`settings`/`runKey`も不変(既存checkpointのresumeを壊さない)。"""
    excluded_keys = excluded_keys or set()

    priority_oracle_excluded = 0
    if excluded_keys:
        filtered_priority = []
        for p in priority:
            key = canonical_key_of_position(p["board"], p["sideToMove"])
            if key in excluded_keys:
                priority_oracle_excluded += 1
                continue
            filtered_priority.append(p)
        priority = filtered_priority

    priority_keys = {canonical_key_of_position(p["board"], p["sideToMove"]) for p in priority}
    priority_selected = priority[:target_count]  # 通常69件程度なので事実上全件

    remaining_target = max(0, target_count - len(priority_selected))

    pool_positions = pool["positions"]
    by_bin: list[list[dict]] = [[] for _ in range(NUM_PHASE_BINS)]
    pool_oracle_excluded = 0
    for row in pool_positions:
        key = canonical_key_of_position(row["board"], row["sideToMove"])
        if excluded_keys and key in excluded_keys:
            pool_oracle_excluded += 1
            continue  # T114: t096 oracle局面(D4対称形込み)を選定段階で除外
        if key in priority_keys:
            continue  # 優先層と重複するものは除外(cross-source dedup)
        by_bin[row["phaseBin"]].append(row)

    bin_populations = [len(b) for b in by_bin]
    allocation = allocate_bin_targets(bin_populations, remaining_target)

    sampled: list[dict] = []
    rng = random.Random(seed)
    opening_cap = max(1, math.ceil(target_count * OPENING_MAX_FRACTION))
    opening_counts: dict[str, int] = {}
    for bin_idx, count in enumerate(allocation):
        bucket = list(by_bin[bin_idx])
        rng.shuffle(bucket)
        xc = [row for row in bucket if row.get("hasXcLegalMove")]
        other = [row for row in bucket if not row.get("hasXcLegalMove")]
        rng.shuffle(xc)
        rng.shuffle(other)
        chosen: list[dict] = []

        def take(rows: list[dict], wanted: int) -> None:
            for row in rows:
                if len(chosen) >= wanted:
                    break
                opening_key = row.get("openingKey")
                if not opening_key:
                    raise RuntimeError("candidate missing openingKey; rebuild teacher_candidates output")
                if opening_counts.get(opening_key, 0) >= opening_cap:
                    continue
                chosen.append(row)
                opening_counts[opening_key] = opening_counts.get(opening_key, 0) + 1

        xc_target = math.ceil(count * XC_QUOTA_FRACTION)
        take(xc, xc_target)
        if len(chosen) < xc_target:
            raise RuntimeError(f"phase bin {bin_idx} cannot satisfy X/C quota {xc_target}/{count}")
        already = {id(row) for row in chosen}
        remainder = [row for row in bucket if id(row) not in already]
        take(remainder, count)
        if len(chosen) != count:
            raise RuntimeError(f"phase bin {bin_idx} cannot satisfy opening cap {opening_cap}: {len(chosen)}/{count}")
        for row in chosen:
            sampled.append({**row})

    selected = priority_selected + sampled
    stats = {
        "targetCount": target_count,
        "prioritySelected": len(priority_selected),
        "poolAvailableAfterPriorityDedup": bin_populations,
        "binAllocation": allocation,
        "sampledFromPool": len(sampled),
        "xcQuotaFraction": XC_QUOTA_FRACTION,
        "openingKeyPlies": OPENING_KEY_PLIES,
        "openingMaxFraction": OPENING_MAX_FRACTION,
        "openingMaxCount": opening_cap,
        "maxOpeningCountSelected": max(opening_counts.values(), default=0),
        "totalSelected": len(selected),
    }
    if excluded_keys:
        stats["oracleExclusion"] = {
            "excludedKeyCount": len(excluded_keys),
            "priorityPositionsExcluded": priority_oracle_excluded,
            "poolPositionsExcluded": pool_oracle_excluded,
        }
    return selected, stats




def measure_expanded1m_hardware_gate() -> dict:
    TEACHER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(TEACHER_DATA_DIR)
    memory = {"totalBytes": None, "availableBytes": None}
    if sys.platform == "win32":
        class MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memoryLoad", ctypes.c_ulong),
                ("totalPhys", ctypes.c_ulonglong),
                ("availPhys", ctypes.c_ulonglong),
                ("totalPageFile", ctypes.c_ulonglong),
                ("availPageFile", ctypes.c_ulonglong),
                ("totalVirtual", ctypes.c_ulonglong),
                ("availVirtual", ctypes.c_ulonglong),
                ("availExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MemoryStatusEx()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            memory = {"totalBytes": status.totalPhys, "availableBytes": status.availPhys}
    gate = {
        "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "diskFreeBytes": disk.free,
        "diskRequiredBytes": 8 * 1024**3,
        "ramTotalBytes": memory["totalBytes"],
        "ramAvailableBytes": memory["availableBytes"],
        "estimatedPeakRamBytes": 6 * 1024**3,
    }
    if disk.free < gate["diskRequiredBytes"]:
        raise RuntimeError(
            f"expanded1m hardware gate failed: disk free={disk.free} < required={gate['diskRequiredBytes']}"
        )
    return gate

# --- T127a: expanded1m nested selection plan / base import ---


def _atomic_jsonl_writer(path: Path):
    """Return (temporary path, text handle); caller fsyncs/closes and os.replace()s."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    return temp_path, temp_path.open("w", encoding="utf-8", newline="\n")


def validate_expanded1m_base() -> dict:
    """Validate the immutable expanded200k base before it can seed a new checkpoint."""
    corpus_sha = sha256_of_file(BASE_CORPUS_PATH)
    manifest_sha = sha256_of_file(BASE_MANIFEST_PATH)
    if corpus_sha != BASE_CORPUS_SHA256:
        raise RuntimeError(f"base corpus SHA-256 mismatch: {corpus_sha} != {BASE_CORPUS_SHA256}")
    if manifest_sha != BASE_MANIFEST_SHA256:
        raise RuntimeError(f"base manifest SHA-256 mismatch: {manifest_sha} != {BASE_MANIFEST_SHA256}")

    manifest = json.loads(BASE_MANIFEST_PATH.read_text(encoding="utf-8"))
    settings = manifest.get("settings") or {}
    required_settings = {
        "setName": "expanded200k",
        "targetCount": EXPANDED1M_BASE_COUNT,
        "years": "2000-2024",
        "perGameCap": 6,
        "exactEmptiesThreshold": 20,
        "defaultEdaxLevel": DEFAULT_EDAX_LEVEL,
        "exactEdaxLevel": EXACT_EDAX_LEVEL,
    }
    mismatches = {key: (settings.get(key), value) for key, value in required_settings.items() if settings.get(key) != value}
    if mismatches:
        raise RuntimeError(f"base manifest settings mismatch: {mismatches}")

    base_meta = manifest.get("meta") or {}
    current_edax_sha = sha256_of_file(vs_edax.EDAX_EXE)
    current_eval_sha = sha256_of_file(vs_edax.EDAX_EVAL_DATA)
    if current_edax_sha != base_meta.get("edaxSha256") or current_eval_sha != base_meta.get("edaxEvalDataSha256"):
        raise RuntimeError(
            "base Edax/eval provenance does not match the current generation environment: "
            f"edax={current_edax_sha}/{base_meta.get('edaxSha256')} "
            f"eval={current_eval_sha}/{base_meta.get('edaxEvalDataSha256')}"
        )

    keys: set[tuple[int, int, int]] = set()
    oracle_keys, _ = load_oracle_excluded_keys(T096_ORACLE_POSITIONS_PATH)
    phase_counts = [0] * NUM_PHASE_BINS
    phase_xc_counts = [0] * NUM_PHASE_BINS
    opening_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    with BASE_CORPUS_PATH.open("r", encoding="utf-8") as fh:
        for expected_id, raw in enumerate(fh):
            if not raw.strip():
                raise RuntimeError(f"blank base JSONL line at positionId={expected_id}")
            record = json.loads(raw)
            if record.get("positionId") != expected_id:
                raise RuntimeError(
                    f"base positionId sequence mismatch at line {expected_id + 1}: {record.get('positionId')}"
                )
            key_value = record.get("canonicalKey")
            if not isinstance(key_value, list) or len(key_value) != 3:
                raise RuntimeError(f"base positionId={expected_id} has malformed canonicalKey")
            key = tuple(key_value)
            if key in keys:
                raise RuntimeError(f"base canonicalKey duplicate at positionId={expected_id}")
            if key in oracle_keys:
                raise RuntimeError(f"base oracle contamination at positionId={expected_id}")
            keys.add(key)
            source = record.get("source")
            source_counts[source] = source_counts.get(source, 0) + 1
            if source == "wthor":
                phase = record.get("phaseBin")
                phase_counts[phase] += 1
                if record.get("hasXcLegalMove"):
                    phase_xc_counts[phase] += 1
                opening_key = record.get("openingKey")
                opening_counts[opening_key] = opening_counts.get(opening_key, 0) + 1
        record_count = expected_id + 1 if "expected_id" in locals() else 0

    if record_count != EXPANDED1M_BASE_COUNT:
        raise RuntimeError(f"base record count mismatch: {record_count} != {EXPANDED1M_BASE_COUNT}")
    if source_counts != {"engineLoss": 65, "wthor": 199_935}:
        raise RuntimeError(f"base source counts mismatch: {source_counts}")
    return {
        "recordCount": record_count,
        "canonicalKeys": keys,
        "phaseCounts": phase_counts,
        "phaseXcCounts": phase_xc_counts,
        "openingCounts": opening_counts,
        "sourceCounts": source_counts,
        "jsonlSha256": corpus_sha,
        "manifestSha256": manifest_sha,
        "edaxSha256": current_edax_sha,
        "edaxEvalDataSha256": current_eval_sha,
    }


def select_expanded1m_incremental(pool: dict, base: dict, oracle_keys: set[tuple[int, int, int]], seed: int):
    """Select exactly 800k WTHOR rows while enforcing constraints on the final 1M union."""
    by_bin: list[list[dict]] = [[] for _ in range(NUM_PHASE_BINS)]
    pool_oracle_excluded = pool_base_excluded = pool_duplicate_excluded = 0
    seen_incremental: set[tuple[int, int, int]] = set()
    base_keys = base["canonicalKeys"]
    for row in pool["positions"]:
        key = canonical_key_of_position(row["board"], row["sideToMove"])
        if key in oracle_keys:
            pool_oracle_excluded += 1
            continue
        if key in base_keys:
            pool_base_excluded += 1
            continue
        if key in seen_incremental:
            pool_duplicate_excluded += 1
            continue
        seen_incremental.add(key)
        row["_canonicalKey"] = key
        by_bin[row["phaseBin"]].append(row)

    # opening capをbin選定より先に全候補横断で適用する。bin順にcapを消費すると
    # 同一openingが多い後半binの実効母集団を過大評価するため、別seedの決定的shuffleで
    # 各openingの残り枠をbin横断配分してからwaterfall母集団を確定する。
    raw_incremental_populations = [len(rows) for rows in by_bin]
    by_opening: dict[str, list[dict]] = {}
    for bucket in by_bin:
        for row in bucket:
            by_opening.setdefault(row["openingKey"], []).append(row)
    cap_rng = random.Random(seed ^ 0x127A)
    capped_by_bin: list[list[dict]] = [[] for _ in range(NUM_PHASE_BINS)]
    opening_cap = math.ceil(
        (EXPANDED1M_BASE_COUNT + EXPANDED1M_INCREMENTAL_COUNT) * OPENING_MAX_FRACTION
    )
    for opening_key, rows in by_opening.items():
        cap_rng.shuffle(rows)
        remaining = max(0, opening_cap - base["openingCounts"].get(opening_key, 0))
        for row in rows[:remaining]:
            capped_by_bin[row["phaseBin"]].append(row)
    by_bin = capped_by_bin

    incremental_populations = [len(rows) for rows in by_bin]
    union_populations = [
        base["phaseCounts"][phase] + incremental_populations[phase] for phase in range(NUM_PHASE_BINS)
    ]
    final_wthor_target = (
        EXPANDED1M_BASE_COUNT + EXPANDED1M_INCREMENTAL_COUNT - EXPANDED1M_ENGINE_LOSS_COUNT
    )
    final_allocation = allocate_bin_targets(union_populations, final_wthor_target)
    incremental_allocation = [
        final_allocation[phase] - base["phaseCounts"][phase] for phase in range(NUM_PHASE_BINS)
    ]
    if any(count < 0 for count in incremental_allocation):
        raise RuntimeError(
            f"base phase counts exceed final waterfall allocation: base={base['phaseCounts']} final={final_allocation}"
        )
    if sum(incremental_allocation) != EXPANDED1M_INCREMENTAL_COUNT:
        raise RuntimeError(
            "expanded1m target unavailable after base/oracle exclusion: "
            f"incremental allocation={sum(incremental_allocation)}/{EXPANDED1M_INCREMENTAL_COUNT}, "
            f"union populations={union_populations}"
        )

    rng = random.Random(seed)
    opening_counts = dict(base["openingCounts"])
    selected: list[dict] = []
    selected_xc = [0] * NUM_PHASE_BINS
    for phase, count in enumerate(incremental_allocation):
        bucket = list(by_bin[phase])
        rng.shuffle(bucket)
        xc_needed = max(
            0,
            math.ceil(final_allocation[phase] * XC_QUOTA_FRACTION) - base["phaseXcCounts"][phase],
        )
        xc = [row for row in bucket if row.get("hasXcLegalMove")]
        other = [row for row in bucket if not row.get("hasXcLegalMove")]
        rng.shuffle(xc)
        rng.shuffle(other)
        chosen: list[dict] = []
        chosen_keys: set[tuple[int, int, int]] = set()

        def take(rows: list[dict], wanted: int) -> None:
            for row in rows:
                if len(chosen) >= wanted:
                    break
                opening_key = row.get("openingKey")
                if not opening_key:
                    raise RuntimeError("expanded1m candidate missing openingKey")
                key = row["_canonicalKey"]
                if key in chosen_keys or opening_counts.get(opening_key, 0) >= opening_cap:
                    continue
                chosen.append(row)
                chosen_keys.add(key)
                opening_counts[opening_key] = opening_counts.get(opening_key, 0) + 1

        take(xc, xc_needed)
        if len(chosen) < xc_needed:
            raise RuntimeError(f"phase bin {phase} cannot satisfy final-union X/C quota: {len(chosen)}/{xc_needed}")
        selected_xc[phase] = sum(bool(row.get("hasXcLegalMove")) for row in chosen)
        remainder = [row for row in bucket if row["_canonicalKey"] not in chosen_keys]
        take(remainder, count)
        if len(chosen) != count:
            raise RuntimeError(
                f"phase bin {phase} cannot satisfy final-union selection constraints: {len(chosen)}/{count}"
            )
        selected_xc[phase] = sum(bool(row.get("hasXcLegalMove")) for row in chosen)
        selected.extend(chosen)

    if len(selected) != EXPANDED1M_INCREMENTAL_COUNT:
        raise RuntimeError(f"expanded1m selection produced {len(selected)} incremental rows, expected 800000")
    final_xc = [base["phaseXcCounts"][i] + selected_xc[i] for i in range(NUM_PHASE_BINS)]
    for phase in range(NUM_PHASE_BINS):
        if final_xc[phase] < math.ceil(final_allocation[phase] * XC_QUOTA_FRACTION):
            raise RuntimeError(f"phase bin {phase} final X/C quota verification failed")
    selected_keys = {row["_canonicalKey"] for row in selected}
    if len(selected_keys) != len(selected) or selected_keys & base_keys or selected_keys & oracle_keys:
        raise RuntimeError("expanded1m incremental canonicalKey uniqueness/non-contamination verification failed")

    year_counts: dict[str, int] = {}
    selected_per_game: dict[tuple[int, int], int] = {}
    for row in selected:
        year_counts[str(row["year"])] = year_counts.get(str(row["year"]), 0) + 1
        game_key = (row["year"], row["gameIndex"])
        selected_per_game[game_key] = selected_per_game.get(game_key, 0) + 1
    per_game_histogram: dict[str, int] = {}
    for count in selected_per_game.values():
        per_game_histogram[str(count)] = per_game_histogram.get(str(count), 0) + 1

    stats = {
        "targetCount": EXPANDED1M_BASE_COUNT + EXPANDED1M_INCREMENTAL_COUNT,
        "baseRecordCount": EXPANDED1M_BASE_COUNT,
        "incrementalSelected": len(selected),
        "basePhaseCounts": base["phaseCounts"],
        "basePhaseXcCounts": base["phaseXcCounts"],
        "candidatePoolTotalAfterDedup": pool.get("totalCandidatesAfterDedup"),
        "rawIncrementalPoolPopulations": raw_incremental_populations,
        "incrementalPoolPopulations": incremental_populations,
        "unionPoolPopulations": union_populations,
        "finalBinAllocation": final_allocation,
        "incrementalBinAllocation": incremental_allocation,
        "finalPhaseXcCounts": final_xc,
        "cappedBins": [i for i, pop in enumerate(union_populations) if final_allocation[i] == pop],
        "waterfallCount": sum(max(0, final_allocation[i] - math.ceil(final_wthor_target / 6)) for i in range(6)),
        "openingMaxCount": opening_cap,
        "maxOpeningCountSelected": max(opening_counts.values(), default=0),
        "oracleExcluded": pool_oracle_excluded,
        "baseExcluded": pool_base_excluded,
        "incrementalDuplicateExcluded": pool_duplicate_excluded,
        "unselectedCandidates": sum(incremental_populations) - len(selected),
        "candidateMarginFraction": (sum(incremental_populations) - len(selected)) / len(selected),
        "incrementalYearCounts": year_counts,
        "incrementalSelectedPerGameHistogram": per_game_histogram,
    }
    selected = [{key: value for key, value in row.items() if key != "_canonicalKey"} for row in selected]
    return selected, stats


def prepare_expanded1m_selection_plan(years: str, per_game_cap: int, per_bin_cap: int, skip_extract: bool = False) -> dict:
    hardware_gate = measure_expanded1m_hardware_gate()
    if years != "2000-2024" or per_game_cap != 24 or per_bin_cap != 4:
        raise RuntimeError("expanded1m requires years=2000-2024, perGameCap=24, perBinCap=4")
    if skip_extract and EXPANDED1M_CANDIDATES_PATH.exists():
        print(f"  --skip-extract: reusing existing {EXPANDED1M_CANDIDATES_PATH}")
    else:
        run_extract(years, CORPUS_SETS["expanded1m"]["seed"], per_game_cap, EXPANDED1M_CANDIDATES_PATH, per_bin_cap)
    pool = json.loads(EXPANDED1M_CANDIDATES_PATH.read_text(encoding="utf-8"))
    if pool.get("perGameCap") != 24 or pool.get("perBinCap") != 4:
        raise RuntimeError("expanded1m candidate pool has incompatible K/per-game settings")

    base = validate_expanded1m_base()
    oracle_keys, oracle_sha = load_oracle_excluded_keys(T096_ORACLE_POSITIONS_PATH)
    selected, stats = select_expanded1m_incremental(pool, base, oracle_keys, CORPUS_SETS["expanded1m"]["seed"])

    master_tmp, master_fh = _atomic_jsonl_writer(EXPANDED1M_PLAN_PATH)
    shard_paths = [
        TEACHER_DATA_DIR / f"corpus_expanded1m_shard{i}of{EXPANDED1M_NUM_SHARDS}.plan.jsonl"
        for i in range(EXPANDED1M_NUM_SHARDS)
    ]
    shard_temp_handles = [_atomic_jsonl_writer(path) for path in shard_paths]
    try:
        for position_id in range(EXPANDED1M_BASE_COUNT):
            shard = position_id % EXPANDED1M_NUM_SHARDS
            shard_temp_handles[shard][1].write(
                json.dumps({"kind": "reuse", "positionId": position_id}, separators=(",", ":")) + "\n"
            )
        for offset, row in enumerate(selected):
            position_id = EXPANDED1M_BASE_COUNT + offset
            planned = {**row, "positionId": position_id}
            line = json.dumps(planned, ensure_ascii=False, separators=(",", ":")) + "\n"
            master_fh.write(line)
            shard_temp_handles[position_id % EXPANDED1M_NUM_SHARDS][1].write(line)
        master_fh.flush()
        os.fsync(master_fh.fileno())
        master_fh.close()
        os.replace(master_tmp, EXPANDED1M_PLAN_PATH)
        for (temp_path, fh), path in zip(shard_temp_handles, shard_paths):
            fh.flush()
            os.fsync(fh.fileno())
            fh.close()
            os.replace(temp_path, path)
    except Exception:
        master_fh.close()
        for _, fh in shard_temp_handles:
            fh.close()
        raise

    plan_sha = sha256_of_file(EXPANDED1M_PLAN_PATH)
    shard_shas = [sha256_of_file(path) for path in shard_paths]
    shard_counts = []
    shard_reused_counts = []
    for path in shard_paths:
        total = reused = 0
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                total += 1
                if json.loads(raw).get("kind") == "reuse":
                    reused += 1
        shard_counts.append(total)
        shard_reused_counts.append(reused)
    if shard_counts != [125_000] * 8 or shard_reused_counts != [25_000] * 8:
        raise RuntimeError(f"expanded1m shard plan count mismatch: total={shard_counts} reused={shard_reused_counts}")

    provenance = {
        "baseCorpus": {
            "path": str(BASE_CORPUS_PATH.relative_to(ROOT)),
            "recordCount": EXPANDED1M_BASE_COUNT,
            "jsonlSha256": base["jsonlSha256"],
            "manifestPath": str(BASE_MANIFEST_PATH.relative_to(ROOT)),
            "manifestSha256": base["manifestSha256"],
            "edaxSha256": base["edaxSha256"],
            "edaxEvalDataSha256": base["edaxEvalDataSha256"],
        },
        "incrementalGeneration": {
            "recordCount": EXPANDED1M_INCREMENTAL_COUNT,
            "candidatePoolPath": str(EXPANDED1M_CANDIDATES_PATH.relative_to(ROOT)),
            "candidatePoolSha256": sha256_of_file(EXPANDED1M_CANDIDATES_PATH),
            "selectionPlanPath": str(EXPANDED1M_PLAN_PATH.relative_to(ROOT)),
            "selectionPlanSha256": plan_sha,
            "shardPlanSha256": shard_shas,
            "teacherCandidatesToolSha256": sha256_of_file(TEACHER_CANDIDATES_TOOL),
            "generatorSha256": sha256_of_file(Path(__file__)),
            "edaxSha256": sha256_of_file(vs_edax.EDAX_EXE),
            "edaxEvalDataSha256": sha256_of_file(vs_edax.EDAX_EVAL_DATA),
            "t096OracleSha256": oracle_sha,
        },
    }
    plan_meta = {
        "schemaVersion": 1,
        "setName": "expanded1m",
        "selectionStats": stats,
        "selectionPlanSha256": plan_sha,
        "shardPlanSha256": shard_shas,
        "shardCounts": shard_counts,
        "shardReusedRecordCounts": shard_reused_counts,
        "provenance": provenance,
        "hardwareGate": hardware_gate,
    }
    vs_edax.atomic_write_text(EXPANDED1M_PLAN_META_PATH, json.dumps(plan_meta, indent=2, ensure_ascii=False) + "\n")
    print(
        "[expanded1m] selection-only plan complete: "
        f"1000000 total (200000 base + {len(selected)} incremental), "
        f"pool={stats['incrementalPoolPopulations']}, margin={stats['candidateMarginFraction']:.3%}"
    )
    return plan_meta

# --- 教師値の付与(Edax呼び出し) ---


def label_positions_across_parents(
    parents: list[tuple[int, dict, dict]],
    exact_empties_threshold: int = EXACT_EMPTIES_THRESHOLD,
) -> list[dict]:
    """Label multiple parents with at most one Edax process per requested level."""
    states = []
    batches: dict[int, list[tuple[int, int, dict]]] = {}
    for parent_index, (index, position, children_info) in enumerate(parents):
        side = position["sideToMove"]
        child_records: list[dict | None] = [None] * len(children_info["moves"])
        states.append(
            (index, position, children_info, canonical_key_of_position(position["board"], side), child_records)
        )
        for child_index, child in enumerate(children_info["moves"]):
            child_empties = child["childEmpties"]
            if child["childIsTerminal"]:
                child_records[child_index] = {
                    "move": child["move"],
                    "value": vs_edax.terminal_value(child["childBoard"], side),
                    "exact": True,
                    "level": None,
                    "edaxDepth": None,
                    "childEmpties": child_empties,
                    "elapsedNote": "terminal (no Edax call)",
                }
                continue
            level = EXACT_EDAX_LEVEL if child_empties <= exact_empties_threshold else DEFAULT_EDAX_LEVEL
            batches.setdefault(level, []).append((parent_index, child_index, child))

    for level, batch in batches.items():
        t0 = time.monotonic()
        results = vs_edax.edax_solve_batch(
            [{"board": child["childBoard"], "sideToMove": child["childSideToMove"]} for _, _, child in batch],
            level,
        )
        elapsed_ms = (time.monotonic() - t0) * 1000.0 / len(batch)
        assert len(results) == len(batch), "Edax batch result count mismatch"
        for (parent_index, child_index, child), result in zip(batch, results):
            side = parents[parent_index][1]["sideToMove"]
            child_empties = child["childEmpties"]
            exact_requested = child_empties <= exact_empties_threshold
            value = result["discDiff"] if child["childSideToMove"] == side else -result["discDiff"]
            is_exact = exact_requested and result["depth"] >= child_empties
            if exact_requested and not is_exact:
                raise RuntimeError(
                    f"Edax exact search incomplete: move={child['move']} depth={result['depth']} empties={child_empties}"
                )
            states[parent_index][4][child_index] = {
                "move": child["move"],
                "value": value,
                "exact": is_exact,
                "level": level,
                "edaxDepth": result["depth"],
                "childEmpties": child_empties,
                "elapsedMs": round(elapsed_ms, 1),
            }

    records = []
    for index, position, children_info, mover_key, child_records in states:
        assert all(child is not None for child in child_records), "child labeling left an unfilled result"
        completed_records = [child for child in child_records if child is not None]
        best = max(completed_records, key=lambda child: child["value"])
        for child in completed_records:
            child["diffFromBest"] = best["value"] - child["value"]
        records.append({
            "positionId": index,
            "board": position["board"],
            "sideToMove": position["sideToMove"],
            "empties": children_info["empties"],
            "source": position["source"],
            "phaseBin": position.get("phaseBin"),
            "hasXcLegalMove": position.get("hasXcLegalMove"),
            "openingKey": position.get("openingKey"),
            "year": position.get("year"),
            "gameIndex": position.get("gameIndex"),
            "priorityLoss": position.get("priorityLoss"),
            "canonicalKey": list(mover_key),
            "children": completed_records,
            "bestMove": best["move"],
            "bestValue": best["value"],
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
    return records


def label_position(
    index: int,
    position: dict,
    children_info: dict,
    exact_empties_threshold: int = EXACT_EMPTIES_THRESHOLD,
) -> dict:
    """Label one parent while retaining the legacy one-parent Edax process boundary."""
    return label_positions_across_parents(
        [(index, position, children_info)], exact_empties_threshold=exact_empties_threshold
    )[0]


# --- provenance / checkpoint ---

def sha256_of_file(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
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
    # T114 (resume堅牢化): `gitCommit`は意図的に除外する。挙動に影響しない
    # 無関係コミット(タスクファイル更新等)でHEADが進むだけでresumeが全損する
    # 事故が実際に発生したため(2026-07-16作業ログ参照)。`gitCommit`自体は
    # `build_run_metadata`により引き続き`meta`へ記録され、provenance情報としては
    # 残るが、identity比較(=resume可否の判定)には使わない。実効的な挙動を
    # 決めるSHA群(harness/teacher_candidates/edax/evalData/pool/highRegretSource)
    # のみをidentityとする。
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

    def __init__(
        self,
        jsonl_path: Path,
        meta_path: Path,
        run_key: str,
        settings: dict,
        meta: dict,
        *,
        adopt_provenance: bool = False,
        start_fresh_allowed: bool = False,
        reused_record_count: int | None = None,
    ):
        self.jsonl_path = jsonl_path
        self.meta_path = meta_path
        self.run_key = run_key
        self.settings = settings
        self.meta = meta
        # T114 (resume堅牢化): 不一致検出時の既定挙動は「エラーで停止」(下記try_resume参照)。
        # 以下の2フラグはその既定を明示的に上書きするための脱出口で、どちらも既定False
        # (=何も指定しなければ従来の暗黙のstart_fresh切り詰めは二度と起きない)。
        self.adopt_provenance = adopt_provenance
        self.start_fresh_allowed = start_fresh_allowed
        self.reused_record_count = reused_record_count
        self.done_ids: set[int] = set()
        self._fh = None
        self._start_time = time.monotonic()
        self._done_since_start = 0

    def try_resume(self) -> bool:
        """`False`を返すのは「まだcheckpointが存在しない(=通常の初回起動)」場合、
        または`--start-fresh`が明示指定された場合のみ。それ以外の不一致
        (runKey・provenance identity)は、データを黙って切り詰める事故(T114の
        resume失敗事故、2026-07-16)を防ぐため`RuntimeError`で即座に停止する。
        `--adopt-provenance`はprovenance identity不一致のときだけ、既存checkpointを
        正として採用し`True`を返す(runKey不一致には効かない: 対象コーパスの
        設定自体が変わっている場合はより慎重な扱いが必要なため)。"""
        if not self.meta_path.exists() or not self.jsonl_path.exists():
            return False
        try:
            saved_meta_doc = json.loads(self.meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  [resume] {self.meta_path.name} could not be parsed ({exc}), starting fresh")
            return False

        if saved_meta_doc.get("runKey") != self.run_key:
            if self.start_fresh_allowed:
                print(
                    f"  [resume] {self.meta_path.name} runKey mismatch, --start-fresh specified: "
                    "discarding checkpoint and regenerating from scratch"
                )
                return False
            raise RuntimeError(
                f"{self.meta_path.name}: runKey mismatch against existing checkpoint "
                f"({self.jsonl_path.name}). Refusing to resume (and refusing to silently discard the "
                "existing checkpoint) because the recorded generation settings differ.\n"
                f"  saved runKey:   {saved_meta_doc.get('runKey')!r}\n"
                f"  current runKey: {self.run_key!r}\n"
                "Pass --start-fresh if this is an intentional regeneration from scratch."
            )

        saved_identity = provenance_identity(saved_meta_doc.get("meta"))
        current_identity = provenance_identity(self.meta)
        if saved_identity != current_identity:
            mismatched = {
                key: (saved_identity.get(key), current_identity.get(key))
                for key in PROVENANCE_IDENTITY_KEYS
                if saved_identity.get(key) != current_identity.get(key)
            }
            if self.adopt_provenance:
                print(
                    f"  [resume] {self.meta_path.name} provenance mismatch, --adopt-provenance specified: "
                    f"adopting existing checkpoint as-is and updating recorded identity to the current "
                    f"environment (changed key(s): {sorted(mismatched.keys())})"
                )
                for key, (old, new) in mismatched.items():
                    print(f"    {key}: {old!r} -> {new!r}")
            elif self.start_fresh_allowed:
                print(
                    f"  [resume] {self.meta_path.name} provenance mismatch, --start-fresh specified: "
                    "discarding checkpoint and regenerating from scratch"
                )
                return False
            else:
                detail = "\n".join(f"  {key}: saved={old!r} current={new!r}" for key, (old, new) in mismatched.items())
                raise RuntimeError(
                    f"{self.meta_path.name}: provenance identity mismatch against existing checkpoint "
                    f"({self.jsonl_path.name}) on key(s) {sorted(mismatched.keys())}. Refusing to resume "
                    "(and refusing to silently discard the existing checkpoint).\n"
                    f"{detail}\n"
                    "Pass --adopt-provenance to resume anyway (existing checkpoint wins, recorded identity "
                    "is updated to the current environment), or --start-fresh to intentionally regenerate "
                    "from scratch."
                )

        done_ids: set[int] = set()
        malformed = 0
        last_valid_offset = 0
        with self.jsonl_path.open("rb") as fh:
            while True:
                line = fh.readline()
                if not line:
                    break
                try:
                    rec = json.loads(line.decode("utf-8"))
                    done_ids.add(rec["positionId"])
                    last_valid_offset = fh.tell()
                except (UnicodeDecodeError, json.JSONDecodeError, KeyError):
                    malformed += 1
                    break
        if malformed:
            with self.jsonl_path.open("r+b") as fh:
                fh.truncate(last_valid_offset)
            print(f"  [resume] truncated malformed JSONL tail at byte offset {last_valid_offset}")
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
            # T114: 以前はT090aの`finalize_teacher_corpus.py`が事後的に付与していたが、
            # 生成時点で既にdiffFromBest/openingKeyとも正しく付与されているため、
            # T114以降の新規setはfinalizeを経由せずここで直接書く
            # (`verify_teacher_corpus.py`はschemaVersion==2を必須としている)。
            "schemaVersion": 2,
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
        if self.reused_record_count is not None:
            doc["reusedRecordCount"] = self.reused_record_count
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
    adopt_provenance: bool = False,
    start_fresh: bool = False,
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
    # T114移行: set別に完全読みラインを上書き可能(既定はグローバル定数のまま)。
    exact_empties_threshold = cfg.get("exactEmptiesThreshold", EXACT_EMPTIES_THRESHOLD)
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

    exclude_oracle = bool(cfg.get("excludeT096Oracle"))
    oracle_keys: set[tuple[int, int, int]] = set()
    oracle_sha256: str | None = None
    if exclude_oracle:
        oracle_keys, oracle_sha256 = load_oracle_excluded_keys(T096_ORACLE_POSITIONS_PATH)
        print(f"  t096 oracle exclusion enabled: {len(oracle_keys)} canonical key(s) to exclude (sha256={oracle_sha256})")

    print(f"[{tag}] step 3/4: stratified sampling to target={target_count} ...")
    selected, selection_stats = select_positions(pool, priority, target_count, seed, excluded_keys=oracle_keys)
    print(f"  selected {len(selected)} position(s): {selection_stats}")

    meta = build_run_metadata(CANDIDATES_PATH)
    settings = {
        "setName": set_name,
        "targetCount": target_count,
        "seed": seed,
        "years": years,
        "perGameCap": per_game_cap,
        "highRegretMinLoss": HIGH_REGRET_MIN_LOSS,
        "exactEmptiesThreshold": exact_empties_threshold,
        "exactEdaxLevel": EXACT_EDAX_LEVEL,
        "defaultEdaxLevel": DEFAULT_EDAX_LEVEL,
        "edaxTasksPerProcess": vs_edax.EDAX_BATCH_TASKS,
        "elapsedMsPolicy": "batch-averaged",
        "numPhaseBins": NUM_PHASE_BINS,
        "xcQuotaFraction": XC_QUOTA_FRACTION,
        "openingKeyPlies": OPENING_KEY_PLIES,
        "openingMaxFraction": OPENING_MAX_FRACTION,
        "phaseBinLowerBounds": pool.get("phaseBinLowerBounds"),
        "selectionStats": selection_stats,
    }
    if exclude_oracle:
        # `excludeT096Oracle`が無効なset(smoke/primary)ではこのキー自体を追加しない
        # (settings/runKeyを完全に不変に保つため、条件分岐を`exclude_oracle`にゲートしている)。
        settings["t096OracleSha256"] = oracle_sha256
    # シャード無し(num_shards<=1)の場合はシャード識別キーだけを追加しない。
    # edaxTasksPerProcess/elapsedMsPolicyの追加により旧世代checkpointとはrunKeyが異なり、
    # 決定性・計時方針が異なるコーパスへの誤resumeを防ぐ。
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

    checkpoint = TeacherCorpusCheckpoint(
        jsonl_path,
        meta_path,
        run_key,
        settings,
        meta,
        adopt_provenance=adopt_provenance,
        start_fresh_allowed=start_fresh,
    )
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
            record = label_position(idx, position, children_info, exact_empties_threshold=exact_empties_threshold)
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






def load_expanded1m_selection_plan() -> dict:
    """Load an already-fixed plan for resume without re-running parent selection."""
    if not EXPANDED1M_PLAN_META_PATH.exists():
        raise RuntimeError("expanded1m selection plan metadata not found")
    plan_meta = json.loads(EXPANDED1M_PLAN_META_PATH.read_text(encoding="utf-8"))
    if sha256_of_file(EXPANDED1M_PLAN_PATH) != plan_meta.get("selectionPlanSha256"):
        raise RuntimeError("expanded1m master selection plan SHA mismatch")
    if sha256_of_file(BASE_CORPUS_PATH) != BASE_CORPUS_SHA256:
        raise RuntimeError("expanded1m base corpus changed since plan selection")
    shard_counts = []
    reused_counts = []
    for shard_index in range(8):
        _, _, path = _expanded1m_shard_paths(shard_index)
        if sha256_of_file(path) != plan_meta["shardPlanSha256"][shard_index]:
            raise RuntimeError(f"expanded1m shard {shard_index} plan SHA mismatch")
        total = reused = 0
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                total += 1
                if json.loads(raw).get("kind") == "reuse":
                    reused += 1
        shard_counts.append(total)
        reused_counts.append(reused)
    if shard_counts != [125_000] * 8 or reused_counts != [25_000] * 8:
        raise RuntimeError(f"expanded1m reused plan count mismatch: total={shard_counts}, reuse={reused_counts}")
    measure_expanded1m_hardware_gate()
    print(
        f"[expanded1m] reusing fixed selection plan sha256={plan_meta['selectionPlanSha256']} "
        "(parent selection not repeated)"
    )
    return plan_meta

def _expanded1m_shard_paths(shard_index: int):
    return (
        TEACHER_DATA_DIR / f"corpus_expanded1m_shard{shard_index}of8.jsonl",
        TEACHER_DATA_DIR / f"corpus_expanded1m_shard{shard_index}of8.meta.json",
        TEACHER_DATA_DIR / f"corpus_expanded1m_shard{shard_index}of8.plan.jsonl",
    )


def _expanded1m_settings_and_meta(
    shard_index: int, plan_meta: dict, edax_parents_per_process: int | None = None
) -> tuple[dict, dict]:
    provenance = plan_meta["provenance"]
    incremental = provenance["incrementalGeneration"]
    current_execution_sha = {
        "generatorSha256": sha256_of_file(Path(__file__)),
        "teacherCandidatesToolSha256": sha256_of_file(TEACHER_CANDIDATES_TOOL),
        "edaxSha256": sha256_of_file(vs_edax.EDAX_EXE),
        "edaxEvalDataSha256": sha256_of_file(vs_edax.EDAX_EVAL_DATA),
    }
    mismatches = {
        key: {"plan": incremental.get(key), "current": current_sha}
        for key, current_sha in current_execution_sha.items()
        if incremental.get(key) != current_sha
    }
    if mismatches:
        raise RuntimeError(
            "expanded1m execution SHA mismatch against fixed selection plan; "
            f"generation/resume refused: {mismatches}"
        )
    settings = {
        "setName": "expanded1m",
        "targetCount": 1_000_000,
        "seed": CORPUS_SETS["expanded1m"]["seed"],
        "years": "2000-2024",
        "perGameCap": 24,
        "perBinCap": 4,
        "exactEmptiesThreshold": 20,
        "exactEdaxLevel": EXACT_EDAX_LEVEL,
        "defaultEdaxLevel": DEFAULT_EDAX_LEVEL,
        "edaxTasksPerProcess": vs_edax.EDAX_BATCH_TASKS,
        "elapsedMsPolicy": "batch-averaged",
        "numPhaseBins": NUM_PHASE_BINS,
        "xcQuotaFraction": XC_QUOTA_FRACTION,
        "openingKeyPlies": OPENING_KEY_PLIES,
        "openingMaxFraction": OPENING_MAX_FRACTION,
        "selectionStats": plan_meta["selectionStats"],
        "selectionPlanSha256": plan_meta["selectionPlanSha256"],
        "shardSelectionPlanSha256": plan_meta["shardPlanSha256"][shard_index],
        "numShards": 8,
        "shardIndex": shard_index,
    }
    if edax_parents_per_process is not None:
        settings["edaxParentsPerProcess"] = edax_parents_per_process
        settings["elapsedMsPolicy"] = "cross-parent-level-batch-averaged"
    meta = {
        "gitCommit": vs_edax.git_commit_hash(),
        "harnessSha256": current_execution_sha["generatorSha256"],
        "teacherCandidatesToolSha256": current_execution_sha["teacherCandidatesToolSha256"],
        "edaxSha256": current_execution_sha["edaxSha256"],
        "edaxEvalDataSha256": current_execution_sha["edaxEvalDataSha256"],
        "candidatesPoolSha256": incremental["candidatePoolSha256"],
        "highRegretSourceSha256": sha256_of_file(VS_EDAX_RESULTS_PATH),
        "selectionPlanSha256": plan_meta["selectionPlanSha256"],
        "baseCorpus": provenance["baseCorpus"],
        "incrementalGeneration": incremental,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return settings, meta




def copy_base_records_for_shard(source_path: Path, target_path: Path, shard_index: int, num_shards: int) -> int:
    """Byte-copy one positionId stripe while validating the base's global sequence."""
    copied = 0
    expected_id = 0
    with source_path.open("rb") as source, target_path.open("wb") as target:
        for raw in source:
            if not raw.strip():
                raise RuntimeError(f"blank base line at positionId={expected_id}")
            record = json.loads(raw)
            if record.get("positionId") != expected_id:
                raise RuntimeError(
                    f"base positionId sequence mismatch during import: expected={expected_id} "
                    f"got={record.get('positionId')}"
                )
            if expected_id % num_shards == shard_index:
                target.write(raw)
                copied += 1
            expected_id += 1
        target.flush()
        os.fsync(target.fileno())
    return copied

def import_expanded1m_base_shard(
    shard_index: int, jsonl_path: Path, meta_path: Path, run_key: str, settings: dict, meta: dict
) -> None:
    """Create a new expanded1m checkpoint by byte-copying this shard's base records."""
    validate_expanded1m_base()
    temp_path = jsonl_path.with_name(jsonl_path.name + ".base-import.tmp")
    copied = copy_base_records_for_shard(
        BASE_CORPUS_PATH, temp_path, shard_index, EXPANDED1M_NUM_SHARDS
    )
    if copied != 25_000:
        raise RuntimeError(f"expanded1m shard {shard_index} base import count {copied} != 25000")
    os.replace(temp_path, jsonl_path)
    doc = {
        "schemaVersion": 2,
        "runKey": run_key,
        "meta": meta,
        "settings": settings,
        "reusedRecordCount": copied,
        "progress": {
            "done": copied,
            "total": 125_000,
            "ratePerSec": None,
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }
    vs_edax.atomic_write_text(meta_path, json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def checkpoint_expanded1m_parent_bundle(
    parents: list[tuple[int, dict, dict]], checkpoint: TeacherCorpusCheckpoint
) -> bool:
    """Solve one cross-parent bundle, falling back before any checkpoint append."""
    fell_back = False
    try:
        records = label_positions_across_parents(parents, exact_empties_threshold=20)
    except Exception as exc:  # noqa: BLE001
        fell_back = True
        position_ids = [position_id for position_id, _, _ in parents]
        print(
            f"  WARNING: expanded1m parent bundle {position_ids} failed ({exc}); "
            "falling back to one Edax execution per parent"
        )
        records = [
            label_position(position_id, position, children_info, exact_empties_threshold=20)
            for position_id, position, children_info in parents
        ]
    for record in records:
        checkpoint.append(record)
    return fell_back


def generate_expanded1m_shard(shard_index: int) -> None:
    if not 0 <= shard_index < EXPANDED1M_NUM_SHARDS:
        raise RuntimeError(f"invalid expanded1m shard index {shard_index}")
    plan_meta = json.loads(EXPANDED1M_PLAN_META_PATH.read_text(encoding="utf-8"))
    jsonl_path, meta_path, shard_plan_path = _expanded1m_shard_paths(shard_index)
    expected_plan_sha = plan_meta["shardPlanSha256"][shard_index]
    if sha256_of_file(shard_plan_path) != expected_plan_sha:
        raise RuntimeError(f"expanded1m shard {shard_index} selection plan SHA mismatch")

    incremental_positions: list[dict] = []
    reused_ids: list[int] = []
    with shard_plan_path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            row = json.loads(raw)
            if row.get("kind") == "reuse":
                reused_ids.append(row["positionId"])
            else:
                incremental_positions.append(row)
    if len(reused_ids) != 25_000 or len(incremental_positions) != 100_000:
        raise RuntimeError(
            f"expanded1m shard {shard_index} plan count mismatch: reuse={len(reused_ids)} "
            f"incremental={len(incremental_positions)}"
        )
    if reused_ids != list(range(shard_index, EXPANDED1M_BASE_COUNT, EXPANDED1M_NUM_SHARDS)):
        raise RuntimeError(f"expanded1m shard {shard_index} reuse IDs are not the required stripe")

    settings, meta = _expanded1m_settings_and_meta(
        shard_index, plan_meta, CORPUS_SETS["expanded1m"]["edaxParentsPerProcess"]
    )
    run_key = json.dumps(settings, sort_keys=True)
    if not jsonl_path.exists() and not meta_path.exists():
        import_expanded1m_base_shard(shard_index, jsonl_path, meta_path, run_key, settings, meta)
    elif not jsonl_path.exists() or not meta_path.exists():
        raise RuntimeError(f"expanded1m shard {shard_index} has an incomplete checkpoint pair")

    checkpoint = TeacherCorpusCheckpoint(
        jsonl_path, meta_path, run_key, settings, meta, reused_record_count=25_000
    )
    if not checkpoint.try_resume():
        raise RuntimeError("expanded1m base import must never fall through to start_fresh")

    todo = [row for row in incremental_positions if not checkpoint.is_done(row["positionId"])]
    print(
        f"[expanded1m shard {shard_index}/8] base reuse=25000, "
        f"incremental done={100000 - len(todo)}, remaining={len(todo)}"
    )
    # children情報も100k件を一括保持せず、小バッチで生成して即checkpointする。
    # 8ワーカー同時実行時のピークRAMを抑え、各レコードのappend+fsyncは従来どおり維持する。
    children_batch_size = 256
    progress_i = 0
    for start in range(0, len(todo), children_batch_size):
        positions_batch = todo[start : start + children_batch_size]
        children_batch = run_children_batch(positions_batch)
        if len(children_batch) != len(positions_batch):
            raise RuntimeError(
                "expanded1m children batch size mismatch: "
                f"{len(children_batch)} != {len(positions_batch)}"
            )
        parent_bundle_size = settings["edaxParentsPerProcess"]
        parents_with_children = [
            (position["positionId"], position, children_info)
            for position, children_info in zip(positions_batch, children_batch)
        ]
        for bundle_start in range(0, len(parents_with_children), parent_bundle_size):
            bundle = parents_with_children[bundle_start : bundle_start + parent_bundle_size]
            checkpoint_expanded1m_parent_bundle(bundle, checkpoint)
            progress_i += len(bundle)
            checkpoint.write_progress(125_000)
            print(
                f"  [expanded1m shard {shard_index}/8] "
                f"{len(checkpoint.done_ids)}/125000 checkpointed"
            )
    checkpoint.write_progress(125_000)
    checkpoint.close()
    # write_progress is shared with old sets; add the base-import audit field without changing runKey.
    completed_meta = json.loads(meta_path.read_text(encoding="utf-8"))
    completed_meta["reusedRecordCount"] = 25_000
    vs_edax.atomic_write_text(meta_path, json.dumps(completed_meta, indent=2, ensure_ascii=False) + "\n")


def run_expanded1m_orchestrator() -> None:
    logs_dir = TEACHER_DATA_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    procs = []
    log_files = []
    script_path = str(Path(__file__).resolve())
    for shard_index in range(8):
        log_path = logs_dir / f"expanded1m_shard{shard_index}of8.log"
        log_fh = open(log_path, "w", encoding="utf-8")
        log_files.append(log_fh)
        cmd = [
            sys.executable,
            script_path,
            "expanded1m",
            "--num-shards",
            "8",
            "--shard-index",
            str(shard_index),
        ]
        print(f"  spawning expanded1m shard {shard_index}/8 (log: {log_path})")
        procs.append(subprocess.Popen(cmd, stdout=log_fh, stderr=subprocess.STDOUT, cwd=str(ROOT)))
    while True:
        time.sleep(15)
        status = []
        done_total = 0
        for shard_index, proc in enumerate(procs):
            _, meta_path, _ = _expanded1m_shard_paths(shard_index)
            done = 0
            if meta_path.exists():
                try:
                    done = (json.loads(meta_path.read_text(encoding="utf-8")).get("progress") or {}).get("done", 0)
                except (OSError, json.JSONDecodeError):
                    pass
            done_total += done
            status.append(f"s{shard_index}={done}({'run' if proc.poll() is None else proc.returncode})")
        print(f"[expanded1m] {done_total}/1000000 | {' '.join(status)}")
        if all(proc.poll() is not None for proc in procs):
            break
    for fh in log_files:
        fh.close()
    failed = [(i, proc.returncode) for i, proc in enumerate(procs) if proc.returncode != 0]
    if failed:
        raise RuntimeError(f"expanded1m shard failure(s): {failed}")
    merge_shards("expanded1m", 8, 1_000_000)

# --- シャード並列オーケストレーション(primary所要時間が8時間見積もりを超えたため追加。
#     オーケストレーター裁定 2026-07-14: 規模50,000を維持しシャード並列化で続行) ---


def run_shard_orchestrator(
    set_name: str,
    num_shards: int,
    per_game_cap: int,
    years: str,
    poll_interval_s: float = 15.0,
    adopt_provenance: bool = False,
    start_fresh: bool = False,
) -> None:
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
        if start_fresh:
            cmd.append("--start-fresh")
        if adopt_provenance:
            cmd.append("--adopt-provenance")
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
    """Stream a positionId-ordered k-way merge and atomically publish the result."""
    shard_metas = []
    shard_paths = []
    for i in range(num_shards):
        shard_jsonl = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{i}of{num_shards}.jsonl"
        shard_meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}_shard{i}of{num_shards}.meta.json"
        if not shard_meta_path.exists() or not shard_jsonl.exists():
            raise RuntimeError(f"expected shard pair for shard {i} not found")
        shard_metas.append(json.loads(shard_meta_path.read_text(encoding="utf-8")))
        shard_paths.append(shard_jsonl)

    base_meta = shard_metas[0]
    base_settings = dict(base_meta.get("settings") or {})
    for i, shard_meta in enumerate(shard_metas):
        settings = dict(shard_meta.get("settings") or {})
        expected_index = settings.pop("shardIndex", None)
        if expected_index != i or settings.get("numShards") != num_shards:
            raise RuntimeError(f"shard {i} settings identify a different shard/run")
        comparable_base = dict(base_settings)
        comparable_base.pop("shardIndex", None)
        # Shard selection plan SHA is intentionally shard-specific.
        settings.pop("shardSelectionPlanSha256", None)
        comparable_base.pop("shardSelectionPlanSha256", None)
        if settings != comparable_base:
            raise RuntimeError(f"shard {i} settings mismatch")
        if provenance_identity(shard_meta.get("meta")) != provenance_identity(base_meta.get("meta")):
            raise RuntimeError(f"shard {i} provenance mismatch")
        if shard_meta.get("runKey") != json.dumps(shard_meta.get("settings"), sort_keys=True):
            raise RuntimeError(f"shard {i} runKey mismatch")

    merged_jsonl_path = TEACHER_DATA_DIR / f"corpus_{set_name}.jsonl"
    merged_meta_path = TEACHER_DATA_DIR / f"corpus_{set_name}.meta.json"
    temp_path = merged_jsonl_path.with_name(merged_jsonl_path.name + ".merge.tmp")
    handles = [path.open("r", encoding="utf-8") for path in shard_paths]
    heap: list[tuple[int, int, str]] = []
    try:
        for shard_index, fh in enumerate(handles):
            raw = fh.readline()
            if raw:
                record = json.loads(raw)
                heapq.heappush(heap, (record["positionId"], shard_index, raw))
        merged_count = 0
        with temp_path.open("w", encoding="utf-8", newline="\n") as out:
            while heap:
                position_id, shard_index, raw = heapq.heappop(heap)
                if position_id != merged_count:
                    raise RuntimeError(
                        f"shard merge id mismatch at output {merged_count}: got positionId={position_id}"
                    )
                out.write(raw if raw.endswith("\n") else raw + "\n")
                merged_count += 1
                next_raw = handles[shard_index].readline()
                if next_raw:
                    next_record = json.loads(next_raw)
                    next_id = next_record["positionId"]
                    if next_id <= position_id:
                        raise RuntimeError(
                            f"shard {shard_index} is not strictly positionId-sorted: {position_id} then {next_id}"
                        )
                    heapq.heappush(heap, (next_id, shard_index, next_raw))
            out.flush()
            os.fsync(out.fileno())
        if merged_count != target_count:
            raise RuntimeError(f"shard merge count mismatch: {merged_count} != {target_count}")
        os.replace(temp_path, merged_jsonl_path)
    finally:
        for fh in handles:
            fh.close()
        if temp_path.exists():
            temp_path.unlink()

    merged_settings = dict(base_meta.get("settings") or {})
    merged_settings.pop("numShards", None)
    merged_settings.pop("shardIndex", None)
    merged_settings.pop("shardSelectionPlanSha256", None)
    merged_doc = {
        "schemaVersion": 2,
        "runKey": None,
        "meta": base_meta.get("meta"),
        "settings": merged_settings,
        "mergedFromShards": num_shards,
        "progress": {
            "done": merged_count,
            "total": target_count,
            "ratePerSec": None,
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }
    if set_name == "expanded1m":
        merged_doc["reusedRecordCount"] = EXPANDED1M_BASE_COUNT
        merged_doc["provenance"] = {
            "baseCorpus": (base_meta.get("meta") or {}).get("baseCorpus"),
            "incrementalGeneration": (base_meta.get("meta") or {}).get("incrementalGeneration"),
        }
    vs_edax.atomic_write_text(merged_meta_path, json.dumps(merged_doc, indent=2, ensure_ascii=False) + "\n")
    print(f"[{set_name}] merge: {merged_count}/{target_count} position(s) merged into {merged_jsonl_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("set_name", choices=sorted(CORPUS_SETS.keys()))
    parser.add_argument("--dry-run", action="store_true", help="Selection only, no Edax calls, no checkpoint file written")
    parser.add_argument("--years", default=None)
    parser.add_argument("--per-game-cap", type=int, default=None)
    parser.add_argument("--per-bin-cap", type=int, default=None)
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
    parser.add_argument(
        "--reuse-selection-plan",
        action="store_true",
        help="expanded1m only: reuse and SHA-verify the already-fixed parent/shard plans for resume.",
    )
    parser.add_argument(
        "--start-fresh",
        action="store_true",
        help="T114: intentionally discard an existing checkpoint on runKey/provenance mismatch and regenerate "
        "from scratch. Without this flag (the default), a mismatch stops the run with an error instead of "
        "silently truncating the checkpoint (see resume失敗事故, 2026-07-16作業ログ).",
    )
    parser.add_argument(
        "--adopt-provenance",
        action="store_true",
        help="T114: resume from an existing checkpoint even if its provenance identity (harness/tool/edax "
        "SHA-256 etc.) differs from the current environment; the existing checkpoint's JSONL content is "
        "kept as-is and its recorded identity is updated to the current environment. Does not override a "
        "runKey (settings) mismatch -- use --start-fresh for that. Mutually exclusive with --start-fresh.",
    )
    args = parser.parse_args()

    if args.start_fresh and args.adopt_provenance:
        raise SystemExit("--start-fresh and --adopt-provenance are mutually exclusive")

    cfg = CORPUS_SETS[args.set_name]
    years = args.years or cfg.get("years", "2015-2024")
    per_game_cap = args.per_game_cap if args.per_game_cap is not None else cfg.get("perGameCap", NUM_PHASE_BINS)
    per_bin_cap = args.per_bin_cap if args.per_bin_cap is not None else cfg.get("perBinCap", 1)

    if args.set_name == "expanded1m":
        if args.adopt_provenance:
            raise SystemExit("expanded1m base import must not use --adopt-provenance")
        if args.start_fresh:
            raise SystemExit("expanded1m checkpoints are initialized only by verified base import; --start-fresh is forbidden")
        if args.num_shards != EXPANDED1M_NUM_SHARDS:
            raise SystemExit("expanded1m requires --num-shards 8")
        if args.shard_index is not None:
            generate_expanded1m_shard(args.shard_index)
            return
        if args.reuse_selection_plan:
            load_expanded1m_selection_plan()
        else:
            prepare_expanded1m_selection_plan(years, per_game_cap, per_bin_cap, skip_extract=args.skip_extract)
        if args.dry_run:
            return
        run_expanded1m_orchestrator()
        return

    if args.reuse_selection_plan:
        raise SystemExit("--reuse-selection-plan is only valid for expanded1m")
    if per_bin_cap != 1:
        raise SystemExit("--per-bin-cap other than 1 is reserved for expanded1m")

    if args.shard_index is not None:
        if args.num_shards <= 1:
            raise SystemExit("--shard-index requires --num-shards > 1")
        generate(
            args.set_name,
            args.dry_run,
            years,
            per_game_cap,
            num_shards=args.num_shards,
            shard_index=args.shard_index,
            skip_extract=args.skip_extract,
            adopt_provenance=args.adopt_provenance,
            start_fresh=args.start_fresh,
        )
    elif args.num_shards > 1:
        if args.dry_run:
            raise SystemExit("--dry-run is not supported together with --num-shards (orchestrator mode)")
        run_shard_orchestrator(
            args.set_name,
            args.num_shards,
            per_game_cap,
            years,
            adopt_provenance=args.adopt_provenance,
            start_fresh=args.start_fresh,
        )
    else:
        generate(
            args.set_name,
            args.dry_run,
            years,
            per_game_cap,
            skip_extract=args.skip_extract,
            adopt_provenance=args.adopt_provenance,
            start_fresh=args.start_fresh,
        )


if __name__ == "__main__":
    main()

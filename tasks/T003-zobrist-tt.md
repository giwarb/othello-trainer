---
id: T003
title: Zobristハッシュ + 置換表(Transposition Table)
status: done
assignee: implementer
attempts: 0
---

# T003: Zobristハッシュ + 置換表(Transposition Table)

## 目的
探索(T005)と終盤ソルバー(T006)が共有する「局面ハッシュ」と「置換表(TT)」を実装する。探索の高速化に必須の基盤モジュール。

## 背景・コンテキスト
- T002 完了(`engine/src/bitboard.rs` の `Board`/`Side`)が前提。
- 設計書 §2.5.1: Zobristハッシュ(64bit)。§2.5.2: 置換表は 2-tier(depth優先 + always-replace)構成、既定サイズ64〜128MB。本タスクでは**シングルスレッド動作**を実装する(SharedArrayBuffer上への配置・マルチスレッド共有はフェーズ7で対応するため、本タスクでは通常のメモリ上に確保する `Vec` ベースの実装でよい)。
- TTエントリに格納する情報(NegaScout/PVSで一般的に必要なもの):
  - 局面のZobristハッシュ(衝突検出用に上位ビットの一部、または64bit全体を保持)
  - 探索深さ `depth`
  - 評価値 `score`
  - フラグ: `Exact` / `LowerBound`(fail-high, beta cutoffで確定) / `UpperBound`(fail-low)
  - 最善手(ベストムーブ、着手位置のビットまたはマス番号)

## 変更対象(新規作成)
- `engine/src/zobrist.rs` — Zobristハッシュテーブルの初期化と、`Board` からハッシュ値を計算する関数
- `engine/src/tt.rs` — 置換表の構造体・格納・検索ロジック
- `engine/src/lib.rs` — `mod zobrist;` `mod tt;` を追加

## 要件
1. `zobrist.rs`: 各マス(64個)× 各石の色(黒/白)のランダム64bit値のテーブルを持つ。**再現性のため、`rand` 等の外部crateではなく、コンパイル時定数または決定的な疑似乱数生成(例: 固定シードのxorshift/splitmix64を自前実装)で値を生成する**。手番(黒番/白番)を区別する追加の1つの64bit値も持つ(手番が変わるとハッシュも変わるようにする)。
2. `zobrist_hash(board: &Board, side_to_move: Side) -> u64` を実装する。石が1つ置かれている/裏返るたびに増分更新できるようXORベースの実装にする(全マス舐めての計算用の関数と、増分更新用のヘルパー関数の両方があるとなお良いが、増分更新は必須要件ではない。素朴な全マス計算のみでも可)。
3. `tt.rs`: `pub enum Bound { Exact, Lower, Upper }` と `pub struct TTEntry { pub hash: u64, pub depth: i8, pub score: i32, pub bound: Bound, pub best_move: Option<u8> }`(`best_move`はマス番号0-63)を定義する。
4. `pub struct TranspositionTable` を実装する:
   - `new(size_mb: usize) -> Self`: 指定サイズ(MB)からエントリ数を計算し、`Vec<Option<TTEntry>>` 等で確保する(2-tier構成の場合は同じインデックスに2スロット持たせる設計でよい。シンプルさ優先で「1バケットにdepth優先スロットとalways-replaceスロットの2つを持つ」構造を推奨)。
   - `probe(&self, hash: u64) -> Option<TTEntry>`: ハッシュからインデックスを計算し、一致するエントリがあれば返す(ハッシュ完全一致で衝突誤検出を防ぐ)。
   - `store(&mut self, entry: TTEntry)`: 2-tier方式で格納する(depthが既存のdepth優先スロットより深い、または一致するハッシュならdepth優先スロットを上書き。それ以外はalways-replaceスロットを上書き)。
   - `clear(&mut self)`: 全エントリを空にする(対局が変わった時などに使用)。
5. 単体テストで以下を検証する:
   - 異なる盤面は(高確率で)異なるハッシュ値を持つこと(初期局面から数手進めた複数の局面のハッシュがすべて相異なることを確認)
   - 同一盤面・同一手番からは常に同じハッシュ値が得られること(決定性)
   - TTに `store` したエントリが `probe` で正しく取得できること
   - サイズ超過時にalways-replaceスロットが上書きされる(depth優先スロットは深いエントリを保持し続ける)ことを簡単なシナリオで確認する

## やらないこと(スコープ外)
- マルチスレッド対応・SharedArrayBuffer配置(フェーズ7)
- 探索アルゴリズム本体(T005)・終盤ソルバー(T006)
- 8対称正規化ハッシュ(これは定石DB用の別ハッシュで、フェーズ5の定石練習タスクで扱う。本タスクの通常Zobristハッシュとは別物なので混同しないこと)

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine zobrist` が全件パスする
- [ ] `cargo test -p engine tt` が全件パスする
- [ ] `cargo test -p engine` (クレート全体)が全件パスする
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-07 implementer:
  - `engine/src/zobrist.rs` を新規作成。固定シード(`0x9E3779B97F4A7C15`)から `splitmix64` を
    const fn で回して `SQUARE_KEYS: [[u64; 2]; 64]`(マス×色)と `SIDE_KEY: u64`(手番用)を
    コンパイル時定数として生成。`zobrist_hash(board: &Board, side_to_move: Side) -> u64` (全マス舐め)、
    および増分更新用ヘルパー `toggle_square` / `toggle_side_to_move` を実装。
  - `engine/src/tt.rs` を新規作成。`pub enum Bound { Exact, Lower, Upper }`、
    `pub struct TTEntry { hash, depth, score, bound, best_move }`、
    2-tier(depth優先スロット + always-replaceスロット)構成の `TranspositionTable` を実装
    (`new(size_mb)` / `probe(hash)` / `store(entry)` / `clear()`)。バケット数は
    `size_mb` から計算したエントリ数を超えない最大の2の累乗に切り詰め、`hash & mask` で
    インデックス計算する。
  - `engine/src/lib.rs`: `mod bitboard;` を `pub(crate) mod bitboard;` に変更し、
    `mod tt;` `mod zobrist;` を追加(T004 が追加済みの `mod eval;` はそのまま維持)。
  - `zobrist.rs` / `tt.rs` とも、探索(T005)・終盤ソルバー(T006)実装までは
    `#[cfg(test)]` 以外から参照されないため `bitboard.rs` に倣い `#![allow(dead_code)]` を付与。
  - 単体テスト: zobrist 5件(決定性、手番違いでハッシュが変わること、初期局面から10手進めた
    局面群のハッシュが全て相異なること、増分ヘルパーが自己逆演算であること)、
    tt 6件(空テーブルでprobe→None、store→probe一致、バケット衝突時に別ハッシュはNoneのまま、
    clearで全消去、depth優先スロットが浅いエントリの連続格納に対して深いエントリを保持しつつ
    always-replaceスロットが上書きされ続けること、より深い衝突エントリがdepth優先スロットを
    奪えること)を追加。
  - 検証コマンド結果:
    - `cargo test -p engine zobrist` → 5 passed; 0 failed
    - `cargo test -p engine tt` → 6 passed; 0 failed
    - `cargo test -p engine` → 25 passed; 0 failed(bitboard/eval/tt/zobrist/lib全体)、warning 0
    - `cargo build -p engine --target wasm32-unknown-unknown` → 成功(エラー・警告なし)
    - `cargo clippy -p engine -- -D warnings` → 警告0で通過
    （初回clippyで `needless_range_loop` が1件検出されたため `zobrist_hash` の実装を
    `SQUARE_KEYS.iter().enumerate()` を使う形に修正して解消済み)

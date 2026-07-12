---
id: T002
title: ビットボード表現・合法手生成
status: done
assignee: implementer
attempts: 0
---

# T002: ビットボード表現・合法手生成

## 目的
オセロエンジンの中核となる盤面表現(ビットボード)と合法手生成・着手適用ロジックを実装する。以後すべての探索・評価はこの上に構築されるため、**正しさの検証を特に厳密に行う**。

## 背景・コンテキスト
- T001 で `engine/` に Rust クレート(cdylib+rlib)と wasm-bindgen 疎通確認が完了している前提。T001 完了後に着手すること。
- 設計書 `othello-trainer-design.md` §2.5.1「盤面表現」を参照:
  - `black: u64, white: u64` のビットボードで盤面を表現(64マスを1ビットずつ対応させる。ビット0=a1, ビット63=h8 のような固定の対応を自分で決めて `engine/src/bitboard.rs` の先頭にコメントで明記する)
  - 着手生成は Kogge–Stone 系の方向別シフト(8方向: 上下左右+斜め4方向)で行う
  - 本タスクでは SIMD128 化・スレッド化は行わない(スカラー実装で良い)
- オセロのルール: 石を置く8方向のいずれかで、相手石が連続し、その先に自分の石がある場合のみ着手可能(その間の相手石はすべて裏返る)。合法手がない場合はパス。両者ともパスなら終局。

## 変更対象(新規作成)
- `engine/src/bitboard.rs` — 盤面表現・合法手生成・着手適用のコアロジック
- `engine/src/lib.rs` — `mod bitboard;` を追加(既存の `ping()` 関数はそのまま残す)
- `engine/Cargo.toml` — 依存追加が必要な場合のみ変更(基本的にunsafeなbit演算のみで完結し、追加クレートは不要なはず)

## 要件
1. `Side` enum(`Black` / `White`)を定義する。
2. `Board` 構造体を定義する: `pub struct Board { pub black: u64, pub white: u64 }`。初期配置(標準オセロ開始局面: 中央4マスに黒白2つずつ、白が左上-右下、黒が右上-左下 の標準配置)を返す `Board::initial() -> Board` を実装する。
3. `Board::legal_moves(&self, side: Side) -> u64`: 指定した手番の合法手を全て求め、着手可能なマスを立てたビットマスクとして返す。8方向すべてを考慮すること。
4. `Board::apply_move(&self, side: Side, mv_bit: u64) -> Board`: 指定した1手(1ビットのみ立ったビットマスク)を打った後の新しい `Board` を返す(裏返る石も含めて正しく更新する)。`mv_bit` が非合法手の場合の挙動は未定義でよい(呼び出し側が `legal_moves` で確認済みという前提。ただし `debug_assert!` で軽くチェックしてもよい)。
5. `Board::pass_count_helpers`: 手番側に合法手がない場合の判定 `has_legal_move(&self, side: Side) -> bool` と、両者パス(終局)判定 `is_terminal(&self) -> bool`(黒白どちらも `legal_moves` が0なら終局)を実装する。
6. `Board::disc_count(&self, side: Side) -> u32`(popcount)、`Board::empty_count(&self) -> u32` を実装する。
7. **正しさの検証(最重要)**: 上記のビットボード実装とは別に、`#[cfg(test)]` テストモジュール内に「素朴な参照実装」(64マスをループし、各マスについて8方向を1マスずつ辿って判定する非ビットボードの実装。パフォーマンスは無視して良い、正しさが自明なコードにする)を書き、以下を検証する:
   - 初期局面での合法手が、標準オセロで知られる4手(黒番: d3, c4, f5, e6 に相当する4マス)と一致する。ビット位置と `a1〜h8` 記法の対応表をコメントで明記し、テストではその対応に従って `assert_eq!` で照合する。
   - **ランダム自己対戦による全数一致検証**: 初期局面から、合法手の中からシードなし擬似ランダム(`std::collections::hash_map::DefaultHasher` 等、外部crate不要な方法で決定的に手を選ぶ、または単純に「常に最初の合法手を選ぶ」「常に最後の合法手を選ぶ」等の決定的戦略でよい)に手を選びながら対局を最後まで(終局または深さ30手程度)進め、**各局面で「ビットボード版の合法手集合」と「素朴参照実装の合法手集合」が完全一致すること、かつ着手後の盤面(black/white)が完全一致すること**を最低3パターン以上の異なる決定的戦略(例: 「最小ビット優先」「最大ビット優先」「合法手リストの中央を選ぶ」)で検証する。
   - 1箇所でも不一致があればテスト失敗とする(`assert_eq!`で盤面全体を比較)。

## やらないこと(スコープ外)
- 評価関数・探索アルゴリズム(T004, T005で実装)
- 終盤完全読み(T006)
- WASM向けAPI公開(`#[wasm_bindgen]` でのエクスポート。T007で行う。本タスクの `Board`/`Side` は素の Rust 構造体でよく、wasm-bindgen 属性は付けなくてよい)
- Zobristハッシュ・置換表(T003)
- SIMD128最適化・マルチスレッド化

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine bitboard` がエラーなく全件パスする
- [ ] `cargo test -p engine` (クレート全体)も全件パスする
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が引き続き成功する(bitboard.rsの追加でwasmビルドが壊れていないこと)
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る(clippyが無ければ `rustup component add clippy` を実行してから)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-07 implementer: `engine/src/bitboard.rs` を新規実装(既存ファイルは `engine/src/lib.rs` に `mod bitboard;` を追加したのみ、`ping()` は変更なし)。

- `Side`(`Black`/`White`)、`Board { black: u64, white: u64 }`、`Board::initial()` を実装。ビット対応は `index = (rank-1)*8 + file (a=0..h=7)` で、モジュール冒頭のドキュメントコメントに明記。開始局面は白={d4,e5}、黒={e4,d5}。
- `legal_moves` は8方向シフト関数(`shift_n/s/e/w/ne/nw/se/sw`、境界ラップ防止のため `FILE_A`/`FILE_H` マスクを使用)による Kogge-Stone 系の反復 OR で実装。
- `apply_move` は各方向を辿って相手石の連続を求め、自分の石で終端していれば反転するスカラー実装。`debug_assert!` で非合法手を軽くチェック。
- `has_legal_move` / `is_terminal` / `disc_count` / `empty_count` を実装。
- 検証: `#[cfg(test)]` 内に、ビットボードとは完全に独立な「素朴参照実装」(`NaiveBoard`、8x8配列 + 8方向を1マスずつ辿るループ、境界チェックのみで完結)を実装。
  - 初期局面の黒番合法手が `d3, c4, f5, e6` と一致することを確認。
  - 初期局面でビットボード版とナイーブ版の盤面・両者の合法手が一致することを確認。
  - 決定的戦略4種(先頭優先/末尾優先/中央優先/DefaultHasherベースの疑似ランダム)でそれぞれ初期局面から最大30手の自己対戦を行い、**各手番でビットボード版とナイーブ版の合法手集合が完全一致**、かつ**着手適用後のblack/white盤面が完全一致**することを `assert_eq!` で検証(1箇所でも不一致ならテスト失敗)。
  - パス処理(合法手なしなら相手番へ)・終局判定も自己対戦ループ内で処理。
- `lib.rs` 側で `bitboard` モジュールが `#[cfg(test)]` 以外から未参照のため(WASM公開はT007のスコープ)、`bitboard.rs` 先頭に `#![allow(dead_code)]` を追加してdead_code警告を明示的に抑制(理由をコメントに明記)。

検証コマンド実行結果(すべてPASS、Windows / PowerShell、`$env:PATH` に `.cargo\bin` を追加して実行):
- `cargo test -p engine bitboard` → 9 passed; 0 failed
- `cargo test -p engine` → 10 passed; 0 failed(`ping_returns_pong` 含む)、doc-tests 0件
- `cargo build -p engine --target wasm32-unknown-unknown` → ビルド成功(警告なし)
- `cargo clippy -p engine -- -D warnings` → 警告0、exit code 0

`tasks/`・`CLAUDE.md` は変更していない。変更ファイルは `engine/src/bitboard.rs`(新規)と `engine/src/lib.rs`(`mod bitboard;` の1行追加)のみ。

---
id: T004
title: 軽量評価関数 v1(モビリティ・安定石・隅・パリティ)
status: done
assignee: implementer
attempts: 0
---

# T004: 軽量評価関数 v1(モビリティ・安定石・隅・パリティ)

## 目的
中盤探索(T005)が使う静的評価関数を実装する。設計書の最終形はWTHORデータで学習したパターン評価(§2.5.4)だが、学習パイプラインは後続フェーズのため、本タスクでは**手作りの軽量ヒューリスティック評価**を実装し、フェーズ3で差し替え可能な形にしておく。

## 背景・コンテキスト
- T002(`engine/src/bitboard.rs` の `Board`/`Side`)完了が前提。T003とは独立なファイルのため、T003と並行して着手してよい。
- 評価値のスケールは「石差(disc difference)換算」に統一する(設計書全体で `discDiff` という石差単位の値が繰り返し使われているため。例えば+2.4は黒が2.4石分有利、という意味)。内部的には `i32` で **1石=100** の固定小数点スケール(センチ石差、centi-disc)を用いることを推奨する(例: 黒が2石分有利なら 200 を返す)。これはT005・T006・T007すべてで共通の規約になるので、`engine/src/eval.rs` の先頭にコメントで明記すること。
- 手番視点(手番側から見て正なら有利)か絶対視点(常に黒視点)かを明確にする: **常に黒視点の値を返す**(黒が有利なら正、白が有利なら負)と定義し、探索側(T005)で手番に応じて符号反転して使う設計にする。この規約もコメントで明記する。

## 変更対象(新規作成)
- `engine/src/eval.rs` — 評価関数の実装
- `engine/src/lib.rs` — `mod eval;` を追加

## 要件
1. `pub fn evaluate(board: &Board) -> i32` を実装する(常に黒視点、centi-disc単位)。以下の要素を線形結合する:
   - **モビリティ差**: `legal_moves(Black).count_ones()` と `legal_moves(White).count_ones()` の差に重み(例: 重み=10前後。具体的な数値はここでは指定しないので実装者が妥当な値を選んで良いが、コメントで根拠を書くこと)を掛けたもの。
   - **隅(コーナー)の重み**: 4隅(a1,a8,h1,h8)を黒/白どちらが保持しているかで加点/減点(隅は非常に価値が高いマスなので大きめの重みにする。例: 隅1つあたり±25前後)。
   - **安定石(stable discs)の差**: 少なくとも「隅から連続する辺・対角線上で、今後絶対にひっくり返されない石」を簡易的に判定するロジックを実装する(厳密な安定石アルゴリズムでなくてよいが、最低限「隅を起点に辺方向へ連続する同色石」は安定石として数える程度は実装すること)。安定石差にも重みを掛ける(隅の重みより小さいが着手可能数より大きい程度、例: 石1つあたり±15前後)。
   - **パリティ/石数差の扱い**: 序盤〜中盤では単純な石数差はほぼ無視してよい(石数を増やすほど不利になりやすいのがオセロの特徴のため)。空きマス数に応じて評価の重み配分を変える必要はない(本タスクでは固定重みでよい。空き数に応じた重み変化はT005で終盤ソルバーへの切り替え閾値として扱うため、eval.rs自体は単純な固定重み線形和でよい)。
2. `pub fn evaluate_for(board: &Board, side: Side) -> i32`: `evaluate(board)` を `side` の手番視点(白なら符号反転)に変換するヘルパー関数を用意する。
3. 将来パターン評価に差し替えられるよう、`evaluate` の内部実装は他モジュールから直接呼ばれず、`pub trait StaticEval { fn eval(&self, board: &Board) -> i32; }` のようなトレイトを定義し、`pub struct HeuristicEval;` にこのトレイトを実装する形にする(T005は具体的な `HeuristicEval` ではなく `&dyn StaticEval` または generic `impl StaticEval` を受け取るようにしておくと、フェーズ3でパターン評価用の `PatternEval` に差し替えやすい。この抽象化は最小限でよく、過剰な設計をしないこと)。
4. 単体テストで以下を検証する:
   - 初期局面の評価値が0であること(左右対称・完全に互角の局面のため)
   - 黒が4隅すべてを持ち、白がどこも持たない人工的な局面を手動で構築し、評価値が明確に正(黒有利)になること
   - `evaluate_for` が黒視点と白視点で符号が反転すること(`evaluate_for(board, Black) == -evaluate_for(board, White)`)

## やらないこと(スコープ外)
- パターン評価(46インスタンス、ステージ別重みテーブル)やWTHOR学習パイプライン(フェーズ3で別途実装)
- MPC(Multi-ProbCut)のための回帰係数(フェーズ3以降)
- 探索アルゴリズム本体(T005)
- 終盤の完全読み(T006。これは静的評価を使わず石差を直接数える)

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine eval` が全件パスする
- [ ] `cargo test -p engine` (クレート全体)が全件パスする
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-07 implementer:
- `engine/src/eval.rs` を新規作成。centi-disc(1石=100)スケール・常に黒視点という規約をファイル冒頭のドキュメントコメントに明記。
- `pub fn evaluate(board: &Board) -> i32`: モビリティ差(重み10)・隅差(重み2500=25石相当)・安定石差(重み1500=15石相当)の線形結合として実装。
- `pub fn evaluate_for(board: &Board, side: Side) -> i32`: 白番なら符号反転するヘルパーとして実装。
- 安定石判定は「4辺それぞれについて両端(隅)から連続する同色石」を簡易的に数える方式(`edge_stable_mask`)で実装。隅を起点に辺方向へ伸びる安定石を最低限カバーする簡易ロジック(厳密な安定石アルゴリズムではない)。
- `pub trait StaticEval { fn eval(&self, board: &Board) -> i32; }` と `pub struct HeuristicEval;`(`StaticEval` を実装)を用意し、T005がトレイト越しに評価関数を呼べるようにした。
- `engine/src/lib.rs` に `mod eval;` を1行追加(`mod bitboard;` の可視性は変更していない。`mod eval` は private のままだが、eval.rs 冒頭に `#![allow(dead_code)]` を付与し、T005で実際に呼ばれるまでの未使用警告を抑制。理由をコメントに明記)。
- `mod bitboard;` は private のままで変更不要だった(private mod はクレートルートの子孫である全モジュールから参照可能なため、`mod eval` から `crate::bitboard::{Board, Side}` を問題なく利用できた)。
- 単体テストを4件追加: 初期局面で評価値0 / 黒が4隅を保持する人工局面で評価値が明確に正 / `evaluate_for` の黒視点・白視点の符号反転 / `HeuristicEval` トレイト実装が `evaluate` と一致すること。

検証結果:
- `cargo test -p engine eval` → 4 passed; 0 failed
- `cargo test -p engine` → 14 passed; 0 failed (bitboard 9件 + eval 4件 + lib 1件)
- `cargo build -p engine --target wasm32-unknown-unknown` → Finished (成功)
- `cargo clippy -p engine -- -D warnings` → 実装完了時点(T003の変更が入る前)では警告0で成功。

補足(T003との並行作業について):
- 作業完了後、他エージェント(T003担当)による `engine/src/lib.rs`(`pub(crate) mod bitboard;` への変更、`mod tt;` `mod zobrist;` の追加)を確認した。私が追加した `mod eval;` の行はそのまま残っており、コンフリクトは発生していない。
- ただしこの時点(T003が `tt.rs`/`zobrist.rs` を lib.rs に配線済みだが、まだどこからも呼び出されていない未完成状態)で crate 全体の `cargo clippy -p engine -- -D warnings` を再実行すると、`engine/src/zobrist.rs` と `engine/src/tt.rs`(いずれもT003の担当範囲、T004のスコープ外)の未使用コード(dead_code)・`needless_range_loop` に起因する警告7件でエラーになる。`grep -E "eval\.rs|bitboard\.rs"` で確認した限り、eval.rs/bitboard.rs 由来のエラーは0件であり、T004側の実装に起因する問題ではない。T003が完了しzobrist/ttが実際に使用されるようになれば解消される見込み。

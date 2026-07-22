---
id: T186
title: 高速化(5): negascout/ordered_movesのlegal_moves重複計算排除
status: todo
assignee: implementer
attempts: 0
---

# T186: 高速化(5): negascout/ordered_movesのlegal_moves重複計算排除

## 目的

中盤探索で同一局面・同一手番に対して `legal_moves` が2回計算されている完全な無駄を排除する。効果は小さい(T183実測でbaseline 0.15%、T184/T185適用後は相対比率が上昇)が、リスクゼロで探索結果は完全不変。直後に控えるT187(増分評価)が同じ領域を触るため、先に単独で入れて分離検証する。

## 背景・コンテキスト

- `engine/src/search.rs:1789` 付近: `negascout` 冒頭で `board.legal_moves(side)` を計算している(パス判定用)。
- `engine/src/search.rs:2357` 付近: `ordered_moves` 冒頭でも全く同じ `(board, side)` に対して `board.legal_moves(side)` を再計算している。
- T183のプロファイルレポート(`bench/edax-compare/t183_profiling_report.md`)で `redundant_legal_moves` として計上済み。T184/T185では未修正。
- `ordered_moves` はT185で固定長配列 `[OrderedMove; 64]` を返す構造になっている(`search.rs:2296-2422`)。呼び出し元は `negascout` のほか複数ある可能性があるため、全呼び出し箇所を grep で確認すること。

## 変更対象

- `engine/src/search.rs` — `ordered_moves` のシグネチャに `legal: u64` を追加し、内部の `board.legal_moves(side)` 呼び出しを引数で置き換える。全呼び出し元で、呼び出し側が既に計算済みの合法手ビットボードを渡す。呼び出し元がまだ計算していない場合はその場で計算して渡す(呼び出し回数の合計が増えないこと)。

## 要件

1. `ordered_moves` 内部での `legal_moves` 再計算を排除する。
2. 探索結果(best_move / score / depth / ノード数)はビット単位で完全不変であること。合法手集合は同一入力に対し決定的なので、正しく配線すれば自動的に満たされる。
3. 挙動を変えるリファクタリング(orderingキーの変更、ループ構造の変更等)は一切行わない。シグネチャ変更と配線のみ。

## やらないこと(スコープ外)

- 増分評価(T187で実施)・orderingキーの簡略化・その他の高速化
- `endgame.rs` / `bitboard.rs` / 評価関数まわりの変更
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記はするがコミットはオーケストレーター担当)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` が全件パス(注意: `protocol.rs` の `node_limited_protocol_requests_are_deterministic` はフル並列時にフレーキー。額面失敗したら単独再実行で切り分ける)。
- [ ] 既存の固定値回帰テスト `t182_negascout_results_are_unchanged_by_the_incremental_hash_wiring` / `t184_sort_by_cached_key_matches_pre_change_baseline` / `t185_ordered_moves_fixed_array_matches_pre_change_baseline`(`engine/src/search.rs`)が**アサート値を一切変更せずに**パスする。
- [ ] `grep` で `ordered_moves` 本体内に `legal_moves(` 呼び出しが残っていないこと(引数渡しに置換済み)。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URL(https://giwarb.github.io/othello-trainer/)で対局が動作することを確認する(playwright CLI または Playwright スクリプト。`gh run watch` でデプロイ完了を待つ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

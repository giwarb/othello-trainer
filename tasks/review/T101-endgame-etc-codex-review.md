## 最終レビュー結果 — T101 redo #1

### (a) 重大（done を止めるブロッカー）

なし。

前回ブロッカーだったテストの空洞化は解消されています。

- `cfg(test)` の閾値 override により、本番の `ETC_MIN_EMPTIES = 15` を変更せず、小空き局面でも ETC 経路を有効化できる。
- ETC cutoff カウンタを追加し、発火数が0件ならテストが失敗する。
- 有効な子 Exact TT エントリを投入し、ETC-on/off の狭窓探索で score 一致を検証している。
- 決定性テストも両実行で ETC 発火を必須とし、`(score, nodes, cutoff count)` の完全一致を確認している。
- テスト用状態は thread-local で並列テストから隔離され、スコープ終了時に復元される。

### (b) 中（次タスクで対応すべき）

なし。

子局面の厳密値から最善子を選び、`[best_score - 1, best_score]` の窓を設定する方法は、投入した子 Exact エントリが確実に `score <= -beta` を満たすため、ETC 統合経路を意図どおり通しています。ETC-off 側との比較も同じ初期TT条件で行われています。

### (c) 軽微（記録のみ）

- レビュー環境が read-only のため、`cargo test` は `target/debug/.cargo-build-lock` の作成時にアクセス拒否となり、こちらでは再実行できませんでした。作業ログには対象テスト、全 engine テスト、release FFO 回帰の成功が記録されています。
- `git diff --check 2615ec8..09a5efe` は問題ありません。
- 差分は仕様どおり `engine/src/endgame.rs` のみです。
- `git status --short --untracked-files=all` は空で、差分・未追跡ファイルは残っていません。

### (d) 総合判定

**合格**

前回指摘された「ETCが一度も発火しないon/off比較」は、閾値override、発火カウンタ、妥当な子Exactエントリを用いた狭窓比較によって修正されています。本番の閾値およびETC安全条件には変更がなく、回帰リスクはテスト専用コードに限定されています。

重大・中の指摘はなく、redo #1 の要求およびT101の受け入れ基準を満たしていると判断します。
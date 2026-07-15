# T101 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### ETC on/off・決定性テストがETCを一度も実行していない

本番のETC適用条件は空き15以上です（[endgame.rs:78](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:78)、[endgame.rs:554](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:554)）。

しかし、追加されたon/off比較テストは `random_small_positions` が収集する空き10以下の局面だけを探索しています（[endgame.rs:944](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:944)）。子孫局面の空き数はさらに減るため、`ETC_ENABLED=true` と `false` の双方で `etc_eligible` は常にfalseです。したがって、160局面以上の比較はETCを含まない同一探索同士の比較になっています。

同様に、決定性テストも空き10の局面を選択しており、名前に反してETC経路を実行しません（[endgame.rs:963](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:963)）。

閾値を8から15へ変更した際に、テスト局面側が追随しなかったものと見られます。タスク最大のリスクである符号・bound・TT経由の実カットについて、受け入れ基準のランダムon/off比較とfresh TT決定性が実質的に未検証です。作業ログのFFO手動比較は有力な実績ですが、コミットされた回帰テストの空洞化を補えません。

テスト用にETC閾値を上書きできる入口を設ける、または空き15以上からETCが実際に発火したことをカウンタ等で確認する局面を用意し、on/off一致とfresh TT決定性を再検証する必要があります。

## (b) 中（次タスクで対応すべき）

なし。

## (c) 軽微（記録のみ）

なし。

実装本体については、子手番視点の `Exact` / `Upper` のみを使用し、`score <= -beta`、`depth >= child_empties` を要求して親の `Lower` として保存しており、規範文書の安全条件に一致しています。`Lower` の誤使用、符号反転、深さ条件、公開API・abort伝播・論理ノード定義の変更は確認されませんでした。

変更範囲もコミット上は `engine/src/endgame.rs` のみで仕様内です。`git diff --check 846820a..50f5bbd` は異常なし、最終確認時の `git status --short` は空でした。

## (d) 総合判定

**不合格**

ETC実装そのものに明白な正しさの問題は見つかりませんでしたが、必須のon/offランダム比較および決定性テストが固定閾値との不整合によりETC経路を全く通っていません。受け入れ基準の中核となる回帰検証が実効性を失っているため、修正と再検証が完了するまでdoneにはできません。
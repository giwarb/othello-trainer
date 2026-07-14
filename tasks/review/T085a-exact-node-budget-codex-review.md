# T085a 最終レビューレポート

## (a) 重大（doneを止めるブロッカー）

なし。

redo #1で要求された以下の事項は実装されています。

- exact quota 25/40/60/75%の比較結果と生データが追加され、目的関数に従って40%が選定されている。
- 比較JSONの集計を行データから再計算し、作業ログ記載値と一致した。
- 固定コーパスは48局面となり、各盤面は64文字で、空き13〜30を連続して正しくカバーしている。
- 木内部のExactQuotaが`fallbackReason`へ反映され、GlobalNodeLimit/WallClockを優先する規則も明文化されている。
- exact quota中断後の中盤探索継続、純中盤探索との結果一致、TTドメイン混入防止を確認する直接テストが追加されている。
- 既存releaseバイナリで48局面の`budget-regression`を再実行し、次を確認した。
  - `deterministic=true`
  - `nullMoveWithLegal=0`
  - `staticOnly=0`
  - `budgetOvershootMax=1`
  - `exactQuotaPercent=40`
  - WallClock発動 0/48
- 境界テレメトリも、空き13〜14でroot exact試行、15〜24で動的ゲートとleaf exact、25〜30でexact抑制を示している。

## (b) 中（次タスクで対応すべき）

なし。

正しさ、回帰リスク、設計妥当性、redo指摘への対応について、次タスクへ持ち越す必要がある問題は確認できませんでした。

## (c) 軽微（記録のみ）

1. [t085_exact_quota_comparison.json](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t085_exact_quota_comparison.json:1) の改行がmixedになっています。ほぼ全行がCRLFで、`selectionReason`付近だけLFのため、実際の`git diff --check 651bcef..cc6e48d`は大量の`trailing whitespace`を報告します。作業ログの「`git diff --check`: pass」と一致しません。JSONの読み込みや探索結果には影響しませんが、次回編集時にLFへ正規化するのが望ましいです。

2. [eval_cli.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/eval_cli.rs:102) のusage表示に、`budget-regression`および比較用`--exact-quota-percent`が記載されていません。設計書とタスクログには実行形式があり、機能自体も正常なので、今回は記録のみとします。

3. `git status --short`には`tasks/T085a-exact-node-budget.md`と`tasks/T091-codex-wrapper-live-logging.md`の変更があります。前者はAGENTS.mdでコミット対象外とされた作業ログ、後者は本差分外であり、今回の実装対象4ファイルに未コミット変更はありません。

## (d) 総合判定

**合格**

前回の不合格原因だった4候補比較、空き13〜30コーパス、木内部ExactQuotaのテレメトリ規則、中心経路の直接テストがすべて追加されています。40%の選定は規範の優先順位に沿い、比較生データも内部整合しています。

作業ログでは、空き19〜24の平均oracle regretが70.0%改善、`loss>=4石`率が61.5%減、序盤・中盤225局面の合算も0.253石改善とされ、性能ゲートを満たしています。FFO #40〜44の合計ノード数1,299,102,329もredo前と一致したと記録されています。今回直接再確認した`budget-regression`でも決定性、安全性、ノード超過、壁時計発動率の各条件を満たしました。

混在改行による`git diff --check`不一致は修正が望ましいものの、探索の正しさや受け入れ機能を損なう問題ではないため、doneを止める理由とは判断しません。
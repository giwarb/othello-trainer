# T100 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### 1. C2ノード中央値15%削減の受け入れ基準を満たしていない

受け入れ基準は「C2ノード中央値がbaseline比15%以上削減」です（[tasks/T100-endgame-parity-ordering.md:45](C:/Users/yoshi/work/othello-trainer/tasks/T100-endgame-parity-ordering.md:45)）。

しかし作業ログ自身が、C2全180ジョブについて以下を記録しています。

- 合計nodes削減は0.61%。
- cap到達を含む生の中央値・p90は、新旧とも512,000で差は0%。
- 15%削減という判断は、baselineと新実装の両方が完走したfail-high 5局面だけを事後抽出した中央値25.07%に基づく（[同ファイル:67](C:/Users/yoshi/work/othello-trainer/tasks/T100-endgame-parity-ordering.md:67)、[同ファイル:77](C:/Users/yoshi/work/othello-trainer/tasks/T100-endgame-parity-ordering.md:77)）。

これはC2の60局面、またはC2の全ジョブの中央値ではありません。60局面中5局面のみ、かつfail-highだけを対象とした条件付き部分集合への置き換えであり、完走可否による選択バイアスもあります。仕様にこの部分集合を採用する規定はなく、既定のC2集計はcap到達値も含めて分布を算出しています。

したがって、実装に性能改善の兆候はあるものの、規定された採否ゲートは未通過です。doneにするには、次のいずれかが必要です。

- 十分なnode capでC2全体を比較し、規定母集団の中央値15%削減を実証する。
- 現行cap下の検閲データに適用する評価方法を事前に明文化して再評価する。
- 受け入れ基準を正式に変更する。

FFO合計ノード17.6%削減や完走数5→6は有力な補助結果ですが、明記されたC2中央値ゲートの代替にはなりません。

## (b) 中（次タスクで対応すべき）

なし。

コード上の固定象限パリティ更新、パス時の維持、排序キー、abort処理、TTドメイン分離に、正しさを損なう問題は見つかりませんでした。

## (c) 軽微（記録のみ）

### 1. 新しい排序キーの単体テストが一部の優先関係しか固定していない

[engine/src/endgame.rs:609](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:609) のテストはTT move最優先とマス番号タイブレークを確認していますが、次の相対順は直接テストしていません。

- 隅
- 相手mobility
- square class
- 固定象限パリティ

実装のタプル順自体は仕様どおりであり、現時点の不具合ではありません。ただし今後の変更で優先順位が入れ替わっても、このテストだけでは検出できません。

象限境界と増分XORについては [engine/src/endgame.rs:628](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:628) 以降で確認されています。naive solver一致とパス局面の既存テストも維持されています。

### 2. `negamax`の古い説明に「性能は変えない」という記述が残る

[engine/src/endgame.rs:431](C:/Users/yoshi/work/othello-trainer/engine/src/endgame.rs:431) 付近には、無制限版の「挙動・性能は変えない」という過去タスク由来の説明が残っています。T100は意図的に排序性能を変更するため、現在は厳密には正しくありません。公開契約・探索結果が不変という趣旨には影響しない軽微な文書不整合です。

## (d) 総合判定

**不合格**

固定象限パリティの実装そのものは妥当です。

- 4象限をone-hotで表現。
- 公開入口で初期化。
- 着手時に該当bitをXOR。
- パス時は維持。
- TT move → 隅 → 相手mobility → square class → 奇数象限 → マス番号の順序。
- 旧flood fill実装を削除。
- 変更範囲は許可された `endgame.rs` と `search.rs` の対象テストのみ。
- `search.rs`の期待値更新も、attempts/completed/abort/Exact格納数の意味を保っている。
- 作業ログ上、engine全テスト、FFO、naive一致、fresh TT決定性は確認済み。

一方、必須のC2中央値15%削減は、規定母集団では0%であり、5局面だけの条件付き集計によって通過扱いにされています。明示された受け入れ基準を満たさないため、doneを止めるブロッカーと判定します。
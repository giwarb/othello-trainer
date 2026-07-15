# T090b 最終レビューレポート

対象: `5bd966e..03093fc`  
コミット: `03093fc train: Edax教師蒸留学習 — 混合損失...`  
変更: 5ファイル、891行追加。作業ツリーは clean。

## (a) 重大（done を止めるブロッカー）

### 1. パスが発生する子局面の手番・符号処理が誤っている

[train/src/t090_distillation.rs:265](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:265)、[train/src/t090_distillation.rs:366](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:366)、[train/src/t090_distillation.rs:437](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:437) は、すべての着手後局面について無条件に

```rust
-model.predict(child, mover.opposite())
```

を使用しています。

しかし相手に合法手がなく元の手番側に合法手がある場合、実際の子局面は相手のパス後、元の手番側の手番です。既存探索も合法手判定を静的評価より先に行い、パス時は深さを消費せず元の手番側へ戻しています（[engine/src/search.rs:1473](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:1473)）。`eval_cli apply` も同じ規約です。

したがって親視点の静的手スコアは通常の子では `-f(child, opponent)`、相手パス時は `+f(child, mover)` とする必要があります。現実装では以下がすべて誤ります。

- 固定する `engineChoice`
- pairwise loss の予測差と勾配
- frozen best-move agreement / regret
- validation ranking MAE
- ranking 学習時に参照する特徴量の手番

primary 50,000局面を独立集計したところ、相手パスとなる子は2,669件、該当局面は1,944局面、teacher best 自体がパスを発生させるものは1,287局面ありました。無視できる例外ではありません。

現行テストは初期局面だけを使用しており、この分岐を検出しません。修正後はパスあり／終局の専用テストを追加し、3構成×2seed、frozen指標、採用ゲートを再実行する必要があります。

## (b) 中（次タスクで対応すべき）

### 1. WTHOR 2024 のラベルが学習用 outcome map に含まれている

[train/src/t090_distillation.rs:184](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:184) の `outcomes` は全年のWTHORサンプルを一括集約しています。同時に2024年の同じサンプルを [train/src/t090_distillation.rs:188](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:188) でゲート(c)用データにしています。

T088は2015–2022をtrain、2023をvalidation、2024をtestとして分離し、canonical重複も後年側優先で除去しています（[train/src/t088_experiment.rs:112](C:/Users/yoshi/work/othello-trainer/train/src/t088_experiment.rs:112)）。今回の実装はその分離を流用しておらず、2024のcanonical outcomeを学習に与えたモデルを同じ2024 MAEで判定します。

今回の候補は独立oracleゲート(b)で落ちているため不採用結論自体は変わりませんが、ゲート(c)は独立した汎化評価になっていません。少なくとも2024 outcomeを学習mapから除外し、teacher corpusとのcanonical重複方針をmanifestに記録すべきです。

### 2. コーパスローダのテストがclean checkoutでは無条件に成功する

[train/src/t090_distillation.rs:865](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:865) のローダテストは、gitignore対象のsmoke corpusがなければ [同:868](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:868) で即returnします。

そのため通常のCI／clean checkoutではJSONデシリアライズ、canonicalKey照合、合法手検査、bestValue整合性、候補ペア構築のいずれもテストされません。「コーパスローダの単体テスト含む」という受け入れ基準を実質的に満たしていません。最小JSON fixtureをテスト内またはコミット可能なfixtureとして用意する必要があります。

## (c) 軽微（記録のみ）

### 1. epochログとcheckpointが同一トランザクションになっていない

[train/src/t090_distillation.rs:654](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:654) で `metrics.tsv` を先に更新し、その後state、最後にweightsを公開しています。metrics更新後からweights公開前に中断すると、再開は前epochからになる一方、metricsには未checkpoint epochの行が残り、同じepochが重複します。

モデルcheckpoint自体は完全なstate/weightsペアだけを認識するため学習結果は保護されていますが、進捗ログの厳密なresume整合性はありません。

### 2. CLIの数値引数が不正入力でpanicする

`--seeds`、`--max-epochs`、`--l2` は `parse().unwrap()` です。オフライン実験用CLIで影響は限定的ですが、run identityを重視するツールとしては明示的なエラー終了が望まれます。

## (d) 総合判定

**不合格**

混合比、限定ペア、outcome欠損時の再正規化、決定論的分割、early stopping、LR decay、epoch checkpoint、PWV3出力という主要な骨格は仕様に沿っています。また、候補が独立oracleゲート(b)で悪化したため20局スモークを行わず不採用とした判断も正しいです。

一方、コーパス内で実際に1,944局面存在するパス子局面の手番・符号処理が誤っており、pairwise学習とfrozen指標の双方を汚染しています。この状態では3構成×2seed ablationを有効な実験結果として確定できません。パス処理とテストを修正し、学習およびゲートを再実行することがdoneの前提です。
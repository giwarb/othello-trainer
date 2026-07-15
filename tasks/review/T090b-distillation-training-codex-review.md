# T090b 最終レビューレポート

対象: `6ffff5c..0540341`  
コミット: `0540341 train: T090b redo#1 — パス/終局の子局面評価規約を探索本体と統一、2024年代分離、fixtureテスト、resume整合 (T090b)`  
変更: 1ファイル、238行追加・45行削除。`git diff --check` 問題なし。作業ツリーは clean。

## (a) 重大（done を止めるブロッカー）

なし。

前回のブロッカーだった子局面の手番・符号処理は、共通の `child_score` と `add_child_score_gradient` に集約され、以下の全経路へ適用されています。

- 固定参照重みによる `engineChoice`
- pairwise loss の予測値と勾配
- validation/frozen の agreement・regret・ranking MAE

通常局面は `-f(child, opponent)`、相手パス局面は `+f(child, parent mover)`、終局は親手番視点の確定石差かつモデル勾配なしとなっており、教師コーパスの値規約と整合しています（[t090_distillation.rs:264](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:264)、[同:338](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:338)、[同:392](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:392)、[同:457](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:457)）。

パス局面のスコアと勾配方向、終局スコアについて専用テストも追加されています。

## (b) 中（次タスクで対応すべき）

### 1. コーパスローダfixtureは異常入力の拒否を実際には検証していない

追加されたテスト（[t090_distillation.rs:936](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:936)）は、gitignore対象データに依存せず常時実行される点は改善です。しかし、正常な1レコードだけを読み込んでいます。

そのため、以下の検査を削除または破損してもテストは通ります。

- 不一致の `canonicalKey` を拒否すること
- 非合法手を拒否すること
- `bestValue` / `diffFromBest` の不整合を拒否すること

redo指示の「canonicalKey照合・合法手検査・bestValue整合を常に検証」を厳密には満たしていません。それぞれ1フィールドだけ壊したfixtureを読み込み、期待するエラーを確認する負例テストを追加すべきです。

ただし実データはT090a側で検証済みで、今回の学習結果を無効にする実害は確認されないため、doneを止めるブロッカーとはしません。

## (c) 軽微（記録のみ）

### 1. 終局規約のコメントが探索本体と厳密には一致しない

`child_score` のコメントは「engine's ... terminal conventions」としていますが（[t090_distillation.rs:338](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:338)）、探索本体の `final_score` は空きマスが残る終局で勝者へ空きマスを加算します。一方、ここでは盤上の石数差を直接返します。

今回の実装は教師コーパス生成側の `terminal_value` とタスクの明確化に整合しているため、コードの計算自体は妥当です。コメントを「teacher corpus terminal convention」などへ修正すると誤解を避けられます。

### 2. CLI引数の値域までは検証されない

数値のparse失敗は明示エラーになりましたが、空のseed一覧、`max_epochs=0`、非有限・負の `l2` などは受理され、後段で失敗または不適切な実行になります。運用コマンドは固定されているため影響は限定的です。

## (d) 総合判定

**合格**

理由は以下のとおりです。

- 前回ブロッカーだったパス局面の符号・手番処理が、学習・参照手選択・全指標で一貫して修正されている。
- 終局局面は教師コーパスの確定石差規約に従い、不要なモデル勾配も発生しない。
- WTHOR outcomeは2015～2023のみから集約し、2024に出現するcanonical keyを除外しているため、ゲート(c)へのラベル混入が解消されている（[t090_distillation.rs:157](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:157)）。
- `metrics.tsv` はcheckpoint epoch以降の行と重複行を除去してからresumeするため、前回のログ重複問題が解消されている（[t090_distillation.rs:571](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:571)）。
- redo後の3構成×2seed ablation、frozen評価、ゲート(a)～(d)、NPS、PWV3検証、train/engineテスト、FFO回帰が記録されている。
- 候補は独立oracle regretが `2.000000 → 2.555556` と27.78%悪化しゲート(b)に不合格であるため、20局スモークへ進まず重みを採用しなかった判断は仕様どおりである。
- 不採用も正常完了とするタスク仕様に従っており、探索・既定評価・アプリへのスコープ外変更もない。

ローダ負例テストの不足は次タスクで補強すべきですが、実験の正しさや不採用結論を覆す問題ではありません。
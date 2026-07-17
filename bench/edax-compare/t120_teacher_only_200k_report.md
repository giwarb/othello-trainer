# T120: expanded200k teacher-only蒸留学習レポート

## 結論

expanded200kを使ったteacher-only学習は3seedとも完走し、T096の独立60局面oracle regretは **2.4667 / 2.3667 / 2.3333石、3seed平均2.3889石（SD 0.0694、range 2.3333–2.4667）** だった。

1. **T113外挿の再現**: 200k外挿1.9196石に対して実測平均は2.3889石で、点推定は+0.4693石（24.4%）悪い。実際のtrain splitは180,110件なので、その点の予測1.9778石と比べても+0.4110石悪い。従って「約1.92石」という外挿の点推定は再現しなかった。一方、45kの2.8石からは0.4111石改善し、5点再fitも傾き-1.0113石/log10、R²=0.9515であるため、改善方向は再現した。元の4点回帰の200kでの95% prediction interval [1.0610, 2.7782]は広く、今回の値は統計的には外挿と矛盾しない。
2. **v2×WTHORとの差**: 全3回の採点でv2 mean regret=1.5666666666666667を完全再現した。候補−v2差のpaired bootstrap 95% CIはseed 1が+0.9000 [-0.1667, 2.1000]、seed 2が+0.8000 [-0.3000, 2.0000]、seed 3が+0.7667 [-0.2667, 1.9333]で、すべて`no_significant_difference`。3seedの局面平均を使った対応差も+0.8222石、95% CI [-0.2333, 2.0000]で有意差なし。ただし点推定は全seedでv2より0.77–0.90石悪く、「同等」を積極的に立証した結果ではない。
3. **T090cへ進む価値**: **限定付きで進む価値あり**。3seedが狭い範囲に収まり、45k teacher-onlyより改善し、v2との差が有意とまでは言えなかったため、既に得た候補の対局スモークは追加判断材料として妥当。ただしoracle点推定はv2より悪く1.92石も未再現なので、採用前提ではなく棄却もあり得る最終ゲートとして扱う。本タスクでは対局・配線・採用判断を行わない。

## 実験条件

- コーパス: `train/data/teacher/corpus_expanded200k.jsonl`、200,000レコード、SHA-256 `412477e2...690e9`
- split: train 180,110 / validation 9,685 / frozen 10,205
- 学習: `teacher-only`、pattern v2、seed 1/2/3、既定max 60 epochs、既定LR schedule、L2=1e-5、jobs=1
- T113からのハイパーパラメータ変更: なし。入力コーパスと出力run dirだけを変更
- 全runは新規 `train/data/t120/expanded200k/`。旧run dirのresumeではないため、T109 M1の旧`metrics.tsv`列ずれは非該当
- T110 M1'の `ensure_metrics_header` → `truncate_metrics_after` 順序はT112で実装・回帰テスト済み。追加コード変更なし
- checkpoint/resume: 各epoch終了時に`epoch-N.bin`と`epoch-N.state`をatomic保存し、同一コマンドで最新epochから継続可能。採点もoracle/v2/candidateを局面単位でatomic保存し、同一コマンドでresume可能
- oracle: T096固定60局面、depth 8、paired bootstrap 100,000回、seed 96002
- `eval_cli`: cleanなコミット済みソースから再ビルド。SHA-256 `cd30961a...d9cf`

学習コマンド:

```text
.\target\release\train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t120/expanded200k --mixes teacher-only --seeds 1,2,3 --reference-weights train/weights/pattern_v2.bin --jobs 1
```

採点コマンドは`<seed>`を1,2,3として各runをフルスクラッチ実行した。

```text
python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t120/expanded200k/teacher-only-seed-<seed>/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t120/oracle/teacher-only-seed-<seed>.json
```

## 学習結果と副次指標

| seed | best epoch | validation teacher MAE | frozen agreement | frozen regret | WTHOR 2024 MAE | oracle regret |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 34 | 6.4670 | 0.3637 | 6.9000 | 14.7414 | 2.4667 |
| 2 | 37 | 6.4661 | 0.3629 | 6.8996 | 14.7426 | 2.3667 |
| 3 | 35 | 6.4751 | 0.3615 | 7.0037 | 14.7522 | 2.3333 |
| 平均 | — | 6.4694 | 0.3627 | 6.9344 | 14.7454 | 2.3889 |

T113 full 45,055件の3seed平均はvalidation teacher MAE約7.6097、frozen agreement約0.3132、frozen regret約8.2525、WTHOR 2024 MAE約15.4436だった。expanded200kでは全指標が改善し、独立oracleも2.8から2.3889へ改善したため、in-corpusだけの見かけ上の改善ではない。

## T113曲線との比較

T113の回帰は `regret = 8.7071 - 1.2804 log10(train件数)`、R²=0.9714。今回の実train件数180,110を代入すると1.9778石、タスク記載の200,000件では1.9196石となる。実測平均2.3889石はそれぞれ+0.4110、+0.4693石の正の残差となった。

今回の1点を追加して再fitすると `regret = 7.5944 - 1.0113 log10(train件数)`、R²=0.9515。改善曲線は維持されるが傾きが緩み、T113の外挿は改善量を過大評価した。ただしT113は4点・oracle 60局面であり外挿不確実性は大きい。3seed平均の局面bootstrapによるregret自体の95% CI [1.4667, 3.4556]にも1.92は含まれるため、「点推定は未再現、統計的な明確な反証でもない」が適切な結論である。

## 閾値20世代の解釈

T113はprimaryコーパス（2015–2024、exact閾値24）の入れ子subset、T120はexpanded200k（2000–2024、exact閾値20）であり、件数以外も同一ではない。expanded200kでは空き21–24の子ラベルが完全読みではなくEdax level 16見積もりになり、exact率もprimaryの0.346から0.268へ低下した。このラベルノイズ増加は外挿未達の一因になり得る。

ただし年代範囲、局面選定、phase配分、opening多様性も同時に変わっているため、+0.41–0.47石の残差を閾値差だけに因果帰属できない。閾値24での再生成・追加生成は本タスクのスコープ外であり、今回の結果は「expanded200kという実コーパス全体」の検証として解釈する。

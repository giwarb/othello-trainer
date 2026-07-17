# T123: v3特徴×expanded200k teacher-only蒸留レポート

## 結論

expanded200k全量を使ったv3特徴×teacher-only学習は3seedとも完走し、T096の独立60局面oracle regretは **1.8667 / 1.8667 / 2.3000石、3seed平均2.0111石（SD 0.2502、range 1.8667–2.3000）** だった。

1. **v3化による伸び**: T120のv2×同一200k蒸留（平均2.3889石）から **0.3778石改善**した。局面ごとに3seed平均を対応比較した差（v3−v2蒸留）は-0.3778石、paired bootstrap 95% CI [-1.5333, 0.6444]で、点推定は改善だが統計的に有意ではない。v3化は容量律速仮説を部分的に支持するが、改善幅はT110の50k時点（v2 3.4667→v3 2.6667、0.8石）より小さく、容量だけが律速だったとは言えない。
2. **v3×WTHORとの差**: T111のv3×WTHOR 3seed平均1.4778石に対して+0.5333石、T121で採用候補に選ばれたseed 3の1.4000石に対して **+0.6111石悪い**。同じv3表現でもWTHOR教師に届かないため、残差は特徴容量以外（教師コーパスの分布、閾値20世代のラベル品質、teacher-only目的とoracleの不整合）にある可能性が高い。
3. **次段への示唆**: 予定どおりv4（ステージ1石刻み）を試す価値はあるが、v3化の改善が0.38石に縮小したため、v4だけでWTHORとの差0.61石を埋める前提にはしない。並行して検討中の「WTHOR全局面ラベル付け」は、WTHORの局面分布を保ったまま強い教師ラベルを与えられるため、容量増加と分布・ラベル要因を切り分ける次の有力実験になる。v4でも改善が小さければ、容量よりコーパス側を優先する根拠が強まる。

## 実験条件

- コーパス: `train/data/teacher/corpus_expanded200k.jsonl`、200,000レコード、SHA-256 `412477e2...690e9`
- split: train 180,110 / validation 9,685 / frozen 10,205
- 学習: `teacher-only`、pattern v3、seed 1/2/3、既定max 60 epochs、既定LR schedule、L2=1e-5、jobs=1、ゼロ初期化
- T120からの変更: `--pattern-set v3`と新規出力先のみ。コーパス、損失、seed、epoch上限、LR schedule、L2、reference weights、jobsは同一
- checkpoint/resume: 各epoch終了時に`epoch-N.bin`と`epoch-N.state`をatomic保存。同一コマンド再実行でseed 1/2/3のepoch 30/31/30からresumeし、完走済みとしてexit 0することを実測確認
- oracle: T096固定60局面、depth 8、paired bootstrap 100,000回、seed 96002。oracle/v2/candidateを局面単位でatomic保存し、同一provenanceなら同一コマンドでresume可能。完走後に別タスクのコミットでHEAD treeが進んだ状態からの再実行はidentity mismatchとして拒否され、stale checkpoint拒否ガードも実測確認
- `eval_cli`: コミット済みソースからrelease再ビルド、SHA-256 `cd30961a...d9cf`

学習コマンド:

```text
.\target\release\train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t123/expanded200k-v3 --mixes teacher-only --seeds 1,2,3 --pattern-set v3 --reference-weights train/weights/pattern_v2.bin --jobs 1
```

各seedの採点コマンド（`<seed>`は1,2,3）:

```text
python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t123/expanded200k-v3/teacher-only-seed-<seed>/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t123/oracle/teacher-only-seed-<seed>.json
```

## 学習結果

| seed | best epoch / completed | train teacher MAE | validation teacher MAE | frozen agreement | frozen regret | WTHOR 2024 MAE | oracle regret |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 26 / 30 | 4.5929 | 6.2209 | 0.4096 | 5.2897 | 14.5011 | 1.8667 |
| 2 | 29 / 31 | 4.6112 | 6.2228 | 0.4091 | 5.3189 | 14.5018 | 1.8667 |
| 3 | 30 / 30 | 4.7466 | 6.2370 | 0.4077 | 5.4282 | 14.5221 | 2.3000 |
| 平均 | — | 4.6502 | 6.2269 | 0.4088 | 5.3456 | 14.5083 | **2.0111** |

T120のv2×200k（validation teacher MAE 6.4694、frozen agreement 0.3627、frozen regret 6.9344、WTHOR 2024 MAE 14.7454、oracle 2.3889）に対し、全副次指標と独立oracleの点推定が同じ改善方向を示した。v3は蒸留信号をよりよく吸収している。一方、seed 3のoracleが他2seedより0.4333石悪く、seed SDはT120の0.0694から0.2502へ増えたため、単一seedの最良値だけで評価しない。

## T096 oracle比較

| 構成 | oracle regret | v2×WTHORとの差 | paired bootstrap 95% CI（候補−v2） |
|---|---:|---:|---|
| v3×200k蒸留 seed 1 | 1.8667 | +0.3000 | [-0.5000, 1.1333] |
| v3×200k蒸留 seed 2 | 1.8667 | +0.3000 | [-0.5000, 1.1333] |
| v3×200k蒸留 seed 3 | 2.3000 | +0.7333 | [-0.2000, 1.7333] |
| **v3×200k蒸留 3seed平均** | **2.0111** | **+0.4444** | **[-0.3556, 1.2778]** |
| T120 v2×200k蒸留 3seed平均 | 2.3889 | +0.8222 | [-0.2333, 2.0000] |
| T111 v3×WTHOR 3seed平均 | 1.4778 | -0.0889 | — |
| T121 v3×WTHOR採用候補 seed 3 | 1.4000 | -0.1667 | [-0.9000, 0.6333] |
| v2×WTHOR | 1.5667 | 0 | — |

全3回でv2 mean regret=`1.5666666666666667`を完全再現し、M2ガードを通過した。各seedのv3蒸留−v2差、および3seed平均−v2差はいずれもCIが0を跨ぐ。従って「v2×WTHORより有意に悪い」とは判定されないが、点推定は全seedで悪く、WTHOR水準へ到達したとも言えない。

v3蒸留3seed平均とT120 v2蒸留3seed平均を局面対応で比較すると、差は-0.3778石、95% CI [-1.5333, 0.6444]。表現力増加による改善傾向は副次指標とも整合するが、60局面では改善を統計的に確定できない。

## 解釈上の限界

- T096は独立だが60局面でCIが広い。v3の改善量やWTHORとの差の精密推定には検出力が不足する。
- expanded200kはexact閾値20で、T090a primaryの24とラベル品質が異なる。年代・局面分布も同時に異なるため、残差を単独要因へ因果帰属できない。
- 本タスクは分析実験であり、v4実装、本番配線、採否判定、コーパス追加生成は行っていない。

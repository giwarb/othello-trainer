# T158b scalar 特徴学習 Gate 2/3 レポート

## 結論

**Gate 2: 合格。B3（exact mobility + exposure）を唯一の full 候補に選定した。**

**Gate 3: 合格。3seed 平均 frozen MAE は B0 比 -0.062059 石、3/3 seed で改善した。空き数別3seed平均の最大悪化は empty=54 の +0.059454 石で、裁定閾値 +0.10 石以内だった。**

本結果は T158c の oracle / smoke / NPS スクリーニングへ進める判断であり、本番採用や `train/weights/` への配置を承認しない。成果物は `train/data/t158/` にのみ置いた。

## 実装・不変性

- prediction と特徴抽出は engine の `PatternWeights::score` / `scalar_features` を使用する。勾配は `loss_gradient * normalized_feature_value + l2 * weight`。
- B0～B3 は全重みゼロ初期化。B0 は PWV3、B1～B3 は PWV4。新 config のみ `schema=3-t158` identity を使い、既存 config / CLI / `schema=2` / PWV3 は不変。
- 20-game / 1-epoch smoke で既存 `v4` と `t158-b0` の frozen 指標と SHA-256 が一致した（`ce8a3aa394db38a3fab2f4137efaeba3da294cd199527af20ba292c9bf34fac6`）。
- pilot B3 は完全な epoch 17 checkpoint から resume 完走し、unit test でも連続実行と resume 後の PWV4 bytes が一致した。

## 特徴分布と scale

WTHOR train split 66,622局・3,988,509 sample の学習前分布。

| feature | signed range | P50 abs | P95 abs | P99 abs | max abs | scale |
|---|---:|---:|---:|---:|---:|---:|
| exact mobility advantage | -20～22 | 2 | 8 | 11 | 22 | /8 |
| exposure advantage | -65～71 | 7 | 23 | 32 | 71 | /32 |

P95/P99 を概ね1以下へ収め tail を clamp しない意図に合うため scale は維持した。

## Gate 2: 180k pilot

corpus hash `1889787a62ae2242`、frozen 7,402局・442,995 sample、train は61 stageの層化 target 180,000（actual 179,969）、subset seed 42、学習 seed 1、20 epoch、LR 0.005、L2 1e-5、MSE。

| config | scalar | frozen MAE | B0差 | game差平均 | paired bootstrap 95% CI | Gate 2 |
|---|---|---:|---:|---:|---:|---|
| B0 | なし | 17.931125 | +0.000000 | +0.000000 | — | 対照 |
| B1 | mobility | 17.643484 | -0.287642 | -0.291178 | [-0.311214, -0.271183] | 合格 |
| B2 | exposure | 17.769553 | -0.161572 | -0.163899 | [-0.179491, -0.148309] | 合格 |
| B3 | 両方 | 17.617524 | -0.313601 | -0.317650 | [-0.339482, -0.296038] | 合格・最良 |

事前固定した5 stage帯の B3−B0 は `-0.444253/-0.436690/-0.384389/-0.293693/-0.068292` 石で局所悪化なし。係数は finite。最大隣接差は mobility 15.604502、exposure 5.719961 で、反復的な極端振動なし。train loss は診断にのみ使用した。

## Gate 3: full 3seed

全 74,024局（train 66,622局・3,988,509 sample、frozen 7,402局・442,995 sample）、同一 corpus hash / split / shuffle 規約、20 epoch で B0 と B3 を seed 1～3 で学習した。

| seed | B0 frozen MAE | B3 frozen MAE | 差 | game差平均 | paired bootstrap 95% CI | 非悪化 |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 16.185831 | 16.133633 | -0.052198 | -0.052759 | [-0.062947, -0.042468] | yes |
| 2 | 15.725285 | 15.657504 | -0.067782 | -0.068335 | [-0.078261, -0.058418] | yes |
| 3 | 15.946311 | 15.880112 | -0.066199 | -0.066892 | [-0.077164, -0.056548] | yes |
| **平均** | **15.952476** | **15.890416** | **-0.062059** | **-0.062662** | **[-0.072528, -0.052858]** | **3/3** |

平均行は同じ frozen game の3seed差を平均後、game単位100,000回 resample した。全 seed で改善し、2/3 seed非悪化を満たす。

### 空き数別（61 stage）再集計と裁定

初版は61 stageを5帯へ集約した最大悪化 +0.014026 石を判定に用いていた。これは仕様の「stage別」を置換しており不適切だったため、B3−B0 を空き数ごとに再集計した。

| seed | 最大悪化 empty | B3−B0 MAE |
|---:|---:|---:|
| 1 | 43 | +0.228951 |
| 2 | 49 | +0.012201 |
| 3 | 46 | +0.140260 |

3seed平均×空き数別の最大悪化は **empty=54、+0.059454 石**。オーケストレーター裁定により Gate 3 の正規判定単位は後者で閾値 +0.10 石以内とする。この解釈は学習・結果確認後の 2026-07-21 に確定した事後裁定で、初版時点の事前登録ではなかったことを明記する。

Gate 3 は、平均改善 0.062059 >= 0.05、3/3 seed非悪化、pooled bootstrap上限 -0.052858 < 0、3seed平均×空き数別最大悪化 +0.059454 <= +0.10 の全条件を満たす。よって **Gate 3 合格**。

### T158c への申し送り（seed別悪化上位）

seed単体では +0.10 石超の空き数別悪化があるため、T158c では以下を含む seed別害検出を必須とする。

| 順位 | seed | empty | B3−B0 MAE |
|---:|---:|---:|---:|
| 1 | 1 | 43 | +0.228951 |
| 2 | 1 | 53 | +0.197828 |
| 3 | 3 | 46 | +0.140260 |
| 4 | 1 | 54 | +0.137782 |
| 5 | 1 | 46 | +0.068805 |
| 6 | 1 | 17 | +0.038607 |
| 7 | 3 | 54 | +0.032638 |
| 8 | 1 | 59 | +0.030184 |

## 集計の再現

```powershell
python bench/edax-compare/t158b_analyze.py
python bench/edax-compare/t158b_analyze.py --check
cargo test -p train
```

スクリプトは raw metrics / binaries から stage帯加重集計、seed別・3seed平均の61 stage集計、NumPy PCG64による100,000回 paired bootstrap、SHA-256、Gate判定、report/meta を決定的に再生成する。固定 seed と全61 stage値は meta JSON に記録する。

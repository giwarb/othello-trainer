# T158b scalar 特徴学習 Gate 2/3 レポート

## 結論

**Gate 2: 合格。B3（exact mobility + exposure）を唯一の full 候補に選定した。**

**Gate 3: 合格。B3 の 3seed 平均 frozen MAE は B0 比 -0.062059 石、3/3 seed で改善し、game 単位 paired bootstrap も改善方向だった。**

本結果は T158c の oracle / smoke / NPS スクリーニングへ進める判断であり、本番採用や `train/weights/` への配置を承認するものではない。学習成果物は gitignore 領域 `train/data/t158/` にのみ置いた。

## 実装・不変性

- `train::regression::Model` の prediction は `engine::pattern_eval::PatternWeights::score` を呼び、scalar 特徴抽出も engine の `scalar_features` を使用する。train 側に合法手・接触辺計算を複製していない。
- scalar 勾配は `loss_gradient * normalized_feature_value + l2 * weight`。単一 sample の期待更新量を固定する unit test を追加した。
- B0/B1/B2/B3 は新 config `t158-b0`～`t158-b3`。新 config の identity は `schema=3-t158` で feature schema・件数・seed・corpus hash を含む。
- B0 は scalar なし・PWV3、B1～B3 は PWV4。既存 `v4` config、既定 CLI、`schema=2` identity 組立、PWV3 出力は変更していない。
- 20-game / 1-epoch smoke で既存 `v4` と `t158-b0` の frozen MSE/MAE と SHA-256 が完全一致した（両方 `ce8a3aa394db38a3fab2f4137efaeba3da294cd199527af20ba292c9bf34fac6`）。完成 run の再実行も同値を再現した。
- pilot B3 を epoch 18 保存中に中断し、最新の完全な epoch 17 PWV4 checkpoint から同一 identity で resume して完走した。unit test でも中断なし 2 epoch と 1 epoch + serialize/deserialize + 1 epoch の PWV4 bytes が一致する。
- epoch ごとに checkpoint を原子的に保存し、start/saved 行を flush する。full は detached 起動し、`progress.stdout.log` と checkpoint をツール呼び出しでポーリングした。

## 特徴分布と scale

WTHOR の既存対局単位 split 後、全 train 66,622局・3,988,509 sample について、生値の絶対値 percentile を学習前に計測した。

| feature | signed range | P50 abs | P95 abs | P99 abs | max abs | scale |
|---|---:|---:|---:|---:|---:|---:|
| exact mobility advantage | -20～22 | 2 | 8 | 11 | 22 | /8 |
| exposure advantage | -65～71 | 7 | 23 | 32 | 71 | /32 |

P95 が正規化後それぞれ 1.0 / 0.71875、P99 が 1.375 / 1.0 であり、典型値を概ね 1 以下へ収めつつ tail を clamp しない設計意図に合う。したがって scale は `/8`, `/32` のままとした。

## Gate 2: 180k pilot

条件は WTHOR corpus hash `1889787a62ae2242`、既存 frozen 7,402局・442,995 sample を固定、train は empty-count 61 stage の決定的層化 target 180,000（実数 179,969）、subset seed 42、学習 seed 1、20 epoch、LR 0.005、L2 1e-5、MSE、全重みゼロ初期化である。bootstrap は game ごとの MAE 差（candidate - B0）を 100,000 回復元抽出した。

| config | scalar | frozen MAE | B0差 | game差平均 | paired bootstrap 95% CI | Gate 2 |
|---|---|---:|---:|---:|---:|---|
| B0 | なし | 17.931125 | 0 | 0 | — | 対照 |
| B1 | mobility | 17.643484 | -0.287642 | -0.291178 | [-0.311214, -0.271183] | 合格 |
| B2 | exposure | 17.769553 | -0.161572 | -0.163899 | [-0.179491, -0.148309] | 合格 |
| **B3** | **両方** | **17.617524** | **-0.313601** | **-0.317650** | **[-0.339482, -0.296038]** | **合格・最良** |

stage 帯は結果を見る前に `[0,14]`, `[15,24]`, `[25,34]`, `[35,44]`, `[45,60]` 空きへ固定し、各帯の sample 加重 MAE を用いた。B3 の B0 差は順に `-0.444253`, `-0.436690`, `-0.384389`, `-0.293693`, `-0.068292` 石で、局所悪化はない。

B1～B3 の全係数は finite。B3 の最大隣接 stage 差は mobility 15.604502、exposure 5.719961（正規化特徴 1.0 当たりの石）だった。mobility 最大差はほぼ終局の stage 1→2 に局在し、中央値は 1.877894。符号が交互反転する反復的な極端振動はなく、終局境界として説明可能なので振動 guard を合格とした。train MAE は診断としてのみ保存し、昇格条件には使っていない。

## Gate 3: full 3seed

全 74,024局（train 66,622局・3,988,509 sample、frozen 7,402局・442,995 sample）、同一 corpus hash / split / shuffle 規約、20 epoch で B0 対照と pilot 最良 B3 のみを seed 1～3 で学習した。

| seed | B0 frozen MAE | B3 frozen MAE | 差 | game差平均 | paired bootstrap 95% CI | 非悪化 |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 16.185831 | 16.133633 | -0.052198 | -0.052759 | [-0.062947, -0.042468] | yes |
| 2 | 15.725285 | 15.657504 | -0.067782 | -0.068335 | [-0.078261, -0.058418] | yes |
| 3 | 15.946311 | 15.880112 | -0.066199 | -0.066892 | [-0.077164, -0.056548] | yes |
| **平均** | **15.952476** | **15.890416** | **-0.062059** | **-0.062662** | **[-0.072528, -0.052858]** | **3/3** |

平均行の CI は同じ frozen game について3seedの差を平均してから game 単位で100,000回 resample した。全 seed で改善し、「2/3 seed 非悪化」を満たす。

stage 帯差（B3 - B0）は seed 1 が `-0.072452/-0.045161/-0.082012/-0.098669/+0.014026`、seed 2 が `-0.070350/-0.059679/-0.071773/-0.120946/-0.032533`、seed 3 が `-0.069146/-0.056186/-0.063180/-0.140517/-0.022419` 石。最大悪化 `+0.014026` は許容 `+0.10` 石以内で、重大退行なし。

Gate 3 の事前登録条件をすべて満たした: 3seed平均改善 `0.062059 >= 0.05`、3/3 seed非悪化、game bootstrap改善方向、stage帯重大退行なし。よって **Gate 3 合格**。

## 再現コマンド

```powershell
target/release/train_patterns_v3.exe --configs t158-b0,t158-b1,t158-b2,t158-b3 --seeds 1 --epochs 20 --train-subset-size 180000 --subset-seed 42 --output-dir train/data/t158/pilot
target/release/train_patterns_v3.exe --configs t158-b0,t158-b3 --seeds 1,2,3 --epochs 20 --subset-seed 42 --output-dir train/data/t158/full
cargo test -p train
```

bootstrap の固定 seed・成果物 SHA-256・個別数値は隣接 meta JSON に記録した。

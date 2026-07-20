# T156d MPC Gate 2 / Gate 3 レポート

## 結論

- Gate 2: **合格**
- Gate 3: **不合格**

不合格のためT156eへは進まない。失敗基準を改善できる校正根拠が得られるまでMPCはdefault OFFを維持し、速度不足ならprobe費用、regret悪化ならmargin/帯別係数を再調整する。

## Gate 2: 固定深さ

test split 240局面、exact/history/aspiration OFF。bootstrapはgameId単位。

| depth | off nodes | on nodes | ratio | bootstrap U95 | median | p90 | probe share | cut rate | 判定 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 8 | 21169256 | 17522902 | 0.8278 | 0.8552 | 0.8661 | 1.0193 | 3.09% | 27.39% | 合格 |
| 10 | 154664878 | 93190985 | 0.6025 | 0.6416 | 0.6104 | 0.9573 | 6.93% | 27.36% | 合格 |
| 12 | 1097285224 | 477060983 | 0.4348 | 0.4696 | 0.4105 | 0.8409 | 10.70% | 28.53% | 合格 |

各深さの基準判定:

- D8: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass
- D10: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass
- D12: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass

## Gate 3: 160k本番相当

oracle 180局面から空き20以下を除外した120局面。v4、160k、quota 60%、exact_from_empties=16、time_ms=None。

| 構成 | history | aspiration | MPC | median depth | mean depth | mean nodes | mean regret | 4石loss | wall hit | exact leaf attempt/complete/abort |
|:---:|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|:---:|
| A | ON | ON | OFF | 9.00 | 8.783 | 160000.1 | 1.6500 | 28/120 | 0 | 1219/1132/71 |
| B | ON | OFF | ON | 9.00 | 8.758 | 160000.3 | 1.8333 | 29/120 | 0 | 471/384/70 |
| C | ON | ON | ON | 9.00 | 8.850 | 160000.2 | 1.6667 | 27/120 | 0 | 1218/1131/71 |
| D | ON | OFF | OFF | 9.00 | 8.683 | 160000.2 | 1.7167 | 28/120 | 0 | 467/382/70 |

### 決定性・探索テレメトリ

| 構成 | 2回一致 | mismatch | aspiration low/high | MPC attempts/cuts | MPC cut率 | probe share |
|:---:|:---:|---:|:---:|:---:|---:|---:|
| A | 完全一致 | 0 | 923/828 | 0/0 | 0.00% | 0.00% |
| B | 完全一致 | 0 | 0/0 | 4951/2263 | 45.71% | 0.59% |
| C | 完全一致 | 0 | 933/835 | 7682/2761 | 35.94% | 0.68% |
| D | 完全一致 | 0 | 0/0 | 0/0 | 0.00% | 0.00% |

### exact統計

| 構成 | root試行/完走 | leaf試行/完走 | bound完走 | quota abort | exact nodes/share | 会計異常 |
|:---:|:---:|:---:|---:|---:|:---:|---:|
| A | 0/0 | 1219/1132 | 1132 | 71 | 7679309/40.00% | 0 |
| B | 0/0 | 471/384 | 329 | 70 | 7524131/39.19% | 0 |
| C | 0/0 | 1218/1131 | 1131 | 71 | 7751442/40.37% | 0 |
| D | 0/0 | 467/382 | 328 | 70 | 7476174/38.94% | 0 |

### B-A

- 完成深さ中央値差: +0.00
- +1以上の局面率: 5.83%
- 浅くなる局面率: 8.33%
- oracle regret平均差: +0.1833石
- paired bootstrap 95%上限: +0.6167石
- 4石以上loss件数差: +1

### 機械判定

- allConfigurationsDeterministic: pass
- wallLimitHitZero: pass
- depthGain: FAIL
- shallowerAtMost10Percent: pass
- meanRegretDiffAtMost010: FAIL
- pairedBootstrapUpperAtMost050: FAIL
- loss4RateNoIncrease: FAIL
- exactAccountingNormal: pass

### 原因分析と提言

aspiration条件を揃えたB-Dでは平均深さ差 +0.075、regret差 +0.1167石。C-Aでは平均深さ差 +0.067、regret差 +0.0167石だった。MPC単体は固定深さノードを大幅削減する一方、160kの反復深化では次の完成深さへ届くほどの利益にならず、初期本番候補Bはaspirationを外す損失も回収できていない。Cは診断値としてAに近いが、初期採用候補ではない。MPCはdefault OFFを維持し、T156eへ進まず、margin/帯別係数または反復深化・TTとの相互作用を再調査してGate 3を再実行する。

exact異常は `exactNodes <= nodes`、完走数<=試行数、空き16超のroot exact試行ゼロという会計不変条件で判定した。B/DおよびA/Cのexact試行数が近く、MPCの有無による異常な偏りは見られない。aspiration有無では試行数が変わるため、構成間の試行数差には恣意的な比率閾値を置かず全数を開示した。

## 再現方法

`compare_mpc.py`へ同じ8 checkpoint、oracle labels、固定seed/bootstrap回数を渡すとmeta/reportが決定的に再生成される。各checkpointは局面完了ごとに原子的更新され、同じコマンドでresumeする。

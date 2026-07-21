# T172 MPC Gate 2 / Gate 3 レポート(v6再校正)

## 結論

- Gate 2: **合格**
- Gate 3: **不合格**

不合格のためT173(対局ゲート)へは進まない。事前登録どおりMPCはdefault OFFを維持する(σ・Gate 2は大幅改善したが、主判定線には未達。詳細と再評価条件は「原因分析と提言」節を参照)。

## Gate 2: 固定深さ

test split 240局面、exact/history/aspiration OFF。bootstrapはgameId単位。

| depth | off nodes | on nodes | ratio | bootstrap U95 | median | p90 | probe share | cut rate | 判定 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 8 | 14940059 | 9628165 | 0.6445 | 0.6709 | 0.6320 | 0.8904 | 2.95% | 47.75% | 合格 |
| 10 | 114955192 | 40880645 | 0.3556 | 0.3797 | 0.3414 | 0.6635 | 6.20% | 47.66% | 合格 |
| 12 | 811512117 | 142062656 | 0.1751 | 0.1898 | 0.1736 | 0.5205 | 9.63% | 47.64% | 合格 |

各深さの基準判定:

- D8: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass
- D10: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass
- D12: aggregateReduction10Percent=pass, bootstrapUpperBelow097=pass, medianReduction5Percent=pass, p90AtMost125=pass

## Gate 3: 160k本番相当

oracle 180局面から空き20以下を除外した120局面。v6、160k、quota 60%、exact_from_empties=16、time_ms=None。

| 構成 | history | aspiration | MPC | median depth | mean depth | mean nodes | mean regret | 4石loss | wall hit | exact leaf attempt/complete/abort |
|:---:|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|:---:|
| A | ON | ON | OFF | 9.00 | 8.917 | 160000.1 | 1.1500 | 21/120 | 0 | 1758/1669/72 |
| B | ON | OFF | ON | 9.00 | 9.000 | 160000.2 | 1.2833 | 23/120 | 0 | 547/456/72 |
| C | ON | ON | ON | 9.00 | 8.992 | 160000.1 | 1.1500 | 21/120 | 0 | 1765/1674/73 |
| D | ON | OFF | OFF | 9.00 | 8.892 | 160000.3 | 1.2833 | 23/120 | 0 | 539/451/72 |

### 決定性・探索テレメトリ

| 構成 | 2回一致 | mismatch | aspiration low/high | MPC attempts/cuts | MPC cut率 | probe share |
|:---:|:---:|---:|:---:|:---:|---:|---:|
| A | 完全一致 | 0 | 492/439 | 0/0 | 0.00% | 0.00% |
| B | 完全一致 | 0 | 0/0 | 4015/2250 | 56.04% | 0.37% |
| C | 完全一致 | 0 | 500/440 | 5639/2599 | 46.09% | 0.43% |
| D | 完全一致 | 0 | 0/0 | 0/0 | 0.00% | 0.00% |

### exact統計

| 構成 | root試行/完走 | leaf試行/完走 | bound完走 | quota abort | exact nodes/share | 会計異常 |
|:---:|:---:|:---:|---:|---:|:---:|---:|
| A | 0/0 | 1758/1669 | 1669 | 72 | 7966367/41.49% | 0 |
| B | 0/0 | 547/456 | 394 | 72 | 7963644/41.48% | 0 |
| C | 0/0 | 1765/1674 | 1674 | 73 | 8049420/41.92% | 0 |
| D | 0/0 | 539/451 | 390 | 72 | 7857318/40.92% | 0 |

### B-A

- 完成深さ中央値差: +0.00
- +1以上の局面率: 11.67%
- 浅くなる局面率: 3.33%
- oracle regret平均差: +0.1333石
- paired bootstrap 95%上限: +0.3500石
- 4石以上loss件数差: +2

### 機械判定

- allConfigurationsDeterministic: pass
- wallLimitHitZero: pass
- depthGain: FAIL
- shallowerAtMost10Percent: pass
- meanRegretDiffAtMost010: FAIL
- pairedBootstrapUpperAtMost050: pass
- loss4IncreaseAtMost2Per60: pass
- exactAccountingNormal: pass
- strictLoss4RateNoIncrease (initial wording): FAIL

### 原因分析と提言

v4(T156d)からv6(本タスク)への変化: 固定深さGate 2のD12集計ノード比は0.435→0.175(約2.5倍の追加削減)、Gate 3のB-A深さ+1到達率は5.83%→11.67%(約2倍)、oracle regret平均差は+0.183→+0.133石(改善)、paired bootstrap 95%上限は+0.617→+0.350石(事前登録の補助基準+0.50石以下を今回は満たす)、浅くなる局面率は8.33%→3.33%(改善)。4石以上loss件数差は+1→+2(120局面に対する設計許容+4以内は維持)。σ比較(要件1)で観測した「v6は深さ間相関が強くσが縮む」という仮説どおり、Gate 2・Gate 3とも全指標が改善方向に動いた。しかし主判定線(深さ+1到達率≥35%かつregret≤+0.10石)はどちらも依然として未達(11.67%<35%、+0.133>+0.10)であり、160kノード・反復深化という本番相当条件では、固定深さでの大幅なノード削減が「次の完成深さに届く」という実利にまだ変換しきれていない。B-Dで揃えたaspiration条件下でも平均深さ差+0.108・regret差+0.0000(B/Dで実質差なし)であり、aspirationを外す損失をMPC単体の速度向上で相殺できていない構図はv4と同様。事前登録どおりMPCはdefault OFFを維持し、T173(対局ゲート)へは進まない。改善トレンド自体は明確なため、将来的な再挑戦の条件として「(d,D)ペアの再選定・帯結合の見直し」「ノード予算拡大時の再評価」を再評価条件として記録する。

Exact accounting and cross-configuration bias:

| pair | leaf attempt delta | quota abort delta | completion delta | exact node share delta | result |
|:---:|---:|---:|---:|---:|:---:|
| A-C | 0.40% | 1.37% | 0.09% | 0.43% | PASS |
| B-D | 1.46% | 0.00% | 0.31% | 0.55% | PASS |

Each row was checked for root/leaf attempts and completions, bound proofs, quota aborts, and exactNodes + midgameNodes = nodes. Bias limits: 10% relative leaf-attempt/quota-abort delta, 5-point completion-rate delta, and 2-point exact-node-share delta.

Input validation: checkpoint schema/config, positions and v6 weights fingerprints, oracle correspondence/fingerprint, duplicates, policies, and identical position-ID sets were checked fail-closed before aggregation. Validated configs and record-set summaries are embedded in meta.

Reproduction (validated): provide the same eight checkpoints, Gate 2 positions, oracle positions/labels, v6 weights, bootstrap seed, and sample count. Gate checkpoints are atomically saved per position and resumed with the same command.
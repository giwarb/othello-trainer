# T121 v3×WTHOR候補 最終審査レポート

## 結論

v3×WTHOR seed 3はEdax level 10との同一60局で **3勝3分54敗、平均石差-21.2333**。対照のT108 v2×WTHOR（4勝2分54敗、-21.85）に対する差は **+0.6167石（v3-v2、改善方向）** だった。同一openingの先後2局を1組とした30ペアのbootstrap 95% CIは **[-3.8667, +4.9500]石** で、改善も悪化も統計的には確定できない。

oracle regretはv2の1.5667石を完全再現し、v3は1.4000石（差-0.1667、95% CI [-0.9000, +0.6333]）。NPSはv2比93.7%、FFO #40〜44と決定性回帰も合格した。

**採用推奨案: 条件付きでv3を採用推奨**。実戦平均石差とoracle regretの点推定がともに改善方向、敗数は不変、30 opening中18で石差改善、NPS低下も許容範囲だからである。ただし両CIは0を跨ぎ、60局では最大約3.9石の実戦悪化を排除できない。「有意な棋力向上」ではなく、**明確な悪化が観測されず、独立oracleの優位と速度ゲートを合わせた世代交代**という判定案である。統計的に悪化を否定することを採用条件とする場合、本結果だけでは不足し追加対局が必要となる。最終裁定と本番配線は別タスクとする。

## 候補重みとoracle regret再現

- 主候補: `train/data/t087/v3-seed-3.bin`（PWV3、5,964,708 bytes）
- 候補SHA-256: `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`
- v2重みSHA-256: `b916c29e4f84692610a65b75c1692132628de5ba2b27b71bf2e8b94426b76c2a`
- コーパス: `bench/edax-compare/t096_oracle_positions.json`、60局面、SHA-256 `eec09e7a3c194a71cbb60f25ce13e1887204bbbc4a9ba052cb19c61507786356`
- eval_cli SHA-256: `cd30961a8ed1d86235d1fe12334d851fd9ba105a7e8a10f9cc52129c4869d9cf`
- Edax SHA-256: `aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1`

T121用の新規checkpoint `train/data/t121/oracle/v3-seed-3.json`へ、oracle 60行、v2 60行、候補60行をフルスクラッチで局面単位保存して再計測した。

| 重み | 平均regret | v2との差（候補-v2） | paired bootstrap 95% CI |
|---|---:|---:|---:|
| v2×WTHOR | **1.5666666667** | — | — |
| v3×WTHOR seed 3 | **1.4000000000** | -0.1666666667 | [-0.9000, +0.6333] |

v2行はT110/T111の必須ガード値1.5667を完全再現した。bootstrapは局面単位、seed 96002、100,000標本のpercentile CIである。

## 対Edax level 10 60局

### 条件とprovenance

- 実行日時: 2026-07-17 11:16 JST（metadata UTC `2026-07-17T02:16:16+00:00`）
- ベースcommit: `a0ff6e2e1dd15364f0c4e99187876852e3a39b34`
- エンジンソースSHA-256: `d736bfa44ced56046c0f9bc8c5b825c63c654096bff30cb9ced8f3bf9a946b8f`
- 対局ハーネスSHA-256: `32446fb402afe72c96b8fa8f53aad754dbc8091c41072764e6ecaa2d5bd90e02`
- openings SHA-256: `7a340c17b02f85a29d5ff296b46ab19aac13f185de7bc03eaf574d6290be81e2`
- T121 run key SHA-256: `1ac1a3a564718e08b752bc9b3fed8543e1d9ffb378c90f2af0f7d8ff26755444`
- T108 run key SHA-256: `cbb35f4e5b85fbff3ab11f6cf1d0d4fb65bec2af1683511c90a66cb1a29c98c4`
- CPU条件: 他の重いジョブを並走させず、単一対局プロセスで実行

`openings.json` primary 30局面の黒白持ち替え、single-root、Edax level 10、book off、depth 12、exact-from-empties 16、time 1500ms、maxNodes 160,000、quota 60%、空き20以下は無制限完全読み、TT 64MiBである。T108と設定、opening、eval_cli、Edax、ハーネスが一致し、重みパス・SHAだけが異なる。run keyにも重みパスが含まれるためT108と構造的に区別される。

| 構成 | 勝 | 分 | 敗 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|
| T108 v2×WTHOR | 4 | 2 | 54 | -21.8500 | -23 |
| T121 v3×WTHOR seed 3 | 3 | 3 | 54 | **-21.2333** | -20 |
| 差（v3-v2） | -1 | +1 | 0 | **+0.6167** | +3 |

同一60ゲームの勝敗遷移はL→L 51、L→D 3、W→W 2、W→L 2、D→W 1、D→L 1。勝敗内訳の純変化は小さいが、個々のゲームは重み変更により入れ替わっている。

### openingごとのpaired比較

各openingについて自作が黒・白の2局の石差を平均し、その30個の対応差 `v3-v2` をbootstrapした。seed 121、100,000標本、percentile 95% CIで、平均差 **+0.6167石**、CI **[-3.8667, +4.9500]石**。18 openingが改善、12 openingが悪化、同値0だった。

| opening | v2先後平均 | v3先後平均 | 差 |
|---|---:|---:|---:|
| primary-01 | -13.0 | -36.0 | -23.0 |
| primary-02 | -28.0 | -36.5 | -8.5 |
| primary-03 | -23.0 | -7.0 | +16.0 |
| primary-04 | -29.0 | -10.0 | +19.0 |
| primary-05 | -26.0 | -20.0 | +6.0 |
| primary-06 | -27.5 | -15.0 | +12.5 |
| primary-07 | -30.0 | -17.0 | +13.0 |
| primary-08 | -4.0 | -2.0 | +2.0 |
| primary-09 | -16.0 | -30.0 | -14.0 |
| primary-10 | -5.0 | -16.5 | -11.5 |
| primary-11 | -24.0 | -15.0 | +9.0 |
| primary-12 | -45.0 | -24.5 | +20.5 |
| primary-13 | -21.0 | -23.0 | -2.0 |
| primary-14 | +2.0 | -24.0 | -26.0 |
| primary-15 | -15.0 | -11.0 | +4.0 |
| primary-16 | -39.0 | -23.0 | +16.0 |
| primary-17 | -18.0 | -34.0 | -16.0 |
| primary-18 | -23.0 | -37.0 | -14.0 |
| primary-19 | -9.0 | -13.0 | -4.0 |
| primary-20 | -25.0 | -35.0 | -10.0 |
| primary-21 | -37.0 | -35.0 | +2.0 |
| primary-22 | -28.0 | -25.0 | +3.0 |
| primary-23 | -28.0 | -11.0 | +17.0 |
| primary-24 | -28.0 | -24.0 | +4.0 |
| primary-25 | -34.0 | -33.0 | +1.0 |
| primary-26 | -13.0 | -20.0 | -7.0 |
| primary-27 | -16.0 | -10.0 | +6.0 |
| primary-28 | -21.0 | -14.0 | +7.0 |
| primary-29 | -25.0 | -17.0 | +8.0 |
| primary-30 | -7.0 | -18.5 | -11.5 |

## 軽量回帰

### FFO #40〜44

`cargo test -p engine --release --test ffo_bench -- --nocapture`を実行し、全5問の正解値が一致した。終盤完全読みは評価重み非依存であり、対局時のv3差し替えによる回帰はない。

| FFO | 空き | 実測 | 正解 | ノード |
|---:|---:|---:|---:|---:|
| 40 | 20 | 38 | 38 | 38,176,210 |
| 41 | 22 | 0 | 0 | 86,480,440 |
| 42 | 22 | 6 | 6 | 125,215,835 |
| 43 | 23 | -12 | -12 | 236,602,685 |
| 44 | 23 | -14 | -14 | 154,602,247 |

### 決定性

- fixed-depth: primary+smoke 40局面、depth 8、exact-from-empties 10の2回実行で **40/40一致**。
- node-budget sample: smoke 10局面、maxNodes 4096の2回実行で **10/10一致**。

### NPS概況

T087と同じ `positions.json` のopening 8+midgame 20=28局面、depth 8、固定深さをv2/v3交互に3反復した。

| 重み | NPS 3反復 | 平均NPS | v2比 |
|---|---|---:|---:|
| v2×WTHOR | 742,657 / 737,689 / 737,757 | 739,368 | 100% |
| v3×WTHOR seed 3 | 695,011 / 690,255 / 692,919 | 692,728 | **93.7%** |

専有下の参考値であり絶対値は環境依存だが、T087の91.63%と同じ傾向で、80%ゲートを上回り大幅劣化はない。

## checkpoint/resume記録

- oracle計測は `oracleRows`、v2行、candidate行を各局面後にatomic保存。180/180行を新規完走した。
- 対局は初期checkpointへ設定・provenanceを保存し、各局後にatomic置換。60/60局を完走した。
- 同一対局コマンドを再実行し、60 already doneとして **60/60 resume-skip** を確認した。
- `vs_edax.py --self-test-checkpoint`でengine/harness、weights、Edax、eval_cliのprovenance不一致拒否と、atomic置換直前の模擬中断で既存JSONが保持されることを確認した。
- 進捗はoracleで各局面、対局で各局の完了時に標準出力へ逐次表示した。

## 限界事項

- 30 opening×先後の60局は検出力が低く、paired CIは約8.8石幅である。平均+0.62石という小差の符号を確定できない。
- openingは固定30種であり、別のopening分布やEdaxレベルへの一般化は未検証である。
- bootstrapは30 openingを母集団からの標本とみなす不確実性を表す。エンジンとEdaxの同一条件対局自体は決定的であり、同じ60局の単純再実行は標本数を増やさない。
- oracle regretのCIも0を跨ぎ、v3がv2より優れるという統計的確証ではない。ただしT111の3seed（1.40/1.43/1.60）と整合する。
- NPSはnative release・専有下の短時間計測であり、WASM実機性能を直接示さない。
- 本タスクは計測と判定材料の確定のみで、本番重みの追加・既定値変更・配布バージョン更新は行っていない。

## 実行コマンド

- `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t087/v3-seed-3.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t121/oracle/v3-seed-3.json`
- `python bench/edax-compare/vs_edax.py --opening-set primary --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64 --weights train/data/t087/v3-seed-3.bin --skip-loss-analysis --results-output bench/edax-compare/endgame-results/t121-vs-edax-results.json --report-output bench/edax-compare/endgame-results/t121-vs-edax-raw-report.md`
- 上記対局コマンドを再実行（60/60 resume-skip）。
- `python bench/edax-compare/vs_edax.py --self-test-checkpoint`
- `target/release/calibrate_mpc.exe bench --depth 8 --pattern-weights <v2またはv3>`（28局面JSONをstdin、交互3反復）
- `cargo test -p engine --release --test ffo_bench -- --nocapture`

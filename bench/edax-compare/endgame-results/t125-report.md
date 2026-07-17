# T125 v4×WTHOR候補 頑健性確認・最終審査レポート

## 結論

v4×WTHORの6seed oracle regretは **0.7000 / 1.6667 / 0.9667 / 1.0333 /
0.8333 / 1.4333石**、平均 **1.1056**、標本SD **0.3702**、range
**0.7000–1.6667** だった。追加seed後もT111 v3の3seed平均1.4778石および
T121採用候補1.4000石より点推定で良く、oracle上の頑健な改善傾向は確認できた。
全6回でv2行1.5666666667を完全再現し、M2ガードを通過した。

追加seedを見る前に登録した「6seed中央値に最も近いseed、同距離なら低regret側」
という規準により、v4 seed 3（regret 0.9667、SHA-256
`c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`）を
対Edax候補に選んだ。

T121と同じprimary 30 opening×先後の60局では **4勝2分54敗、平均石差
-24.0167** だった。T121 v3（3勝3分54敗、-21.2333）比は **-2.7833石**、
opening単位bootstrap 95% CIは **[-7.8000, +2.2500]**。T108 v2（4勝2分
54敗、-21.8500）比は **-2.1667石**、95% CIは **[-6.7000, +2.2500]**。
いずれもCIは0を跨ぎ、有意な悪化とは断定できないが、実戦点推定はv3/v2の双方より
悪く、v3比では30 opening中18で悪化、11で改善、1で同値だった。

**採用推奨案: 現時点ではv3を維持し、素のv4への世代交代は見送る。**
oracleの平均改善だけで、実戦点推定-2.78石とgzip配信サイズ約+3.36MB（約+3.4MB）
を正当化できないためである。ただし60局のCIは広く、v4の実戦悪化は統計的に確定して
いない。v4を再検討するなら、別openingによる追加対局、または別タスクで平滑化・圧縮を
独立候補として評価するのが妥当である。最終裁定と本番配線は行わない。

## 候補選定規準（追加seed結果確認前の事前登録）

2026-07-17、seed 4〜6の学習・oracle採点前に次の規準を固定した。

1. seed 1〜6のoracle regretを昇順に並べ、第3値と第4値の平均を6seed中央値とする。
2. 6seed中央値との絶対差が最小のseedを対Edax候補とする。
3. 同距離ならoracle regretが低い方、さらに同値ならseed番号が小さい方を選ぶ。

最良regretを直接選ばず分布の中心に近い重みを使うことで、単一の好成績外れ値を
拾う選抜バイアスを抑える。実測の昇順はseed 1=0.7000、seed 5=0.8333、
seed 3=0.9667、seed 4=1.0333、seed 6=1.4333、seed 2=1.6667で、中央値は
1.0000。seed 3と4がともに中央値から0.0333石だったため、事前tie-breakにより
低regret側のseed 3を選んだ。

同じT096 60局面を候補選定と報告に併用しており、完全な独立検証ではない。中央値近傍を
選ぶことで最良seed選抜よりバイアスを抑えたが、選定後にも残る選抜バイアスは限界である。

## 追加seed学習と6seed oracle

T124と同じWTHORトレーナー、v4、epochs 20を使い、変更はseed 4〜6の追加だけとした。
3,988,509 train / 442,995 frozen samplesで、全seedが20 epochを完走した。

| seed | frozen MAE | oracle regret | v2との差 | paired bootstrap 95% CI | SHA-256 |
|---:|---:|---:|---:|---:|---|
| 1 | 16.185831 | 0.7000 | -0.8667 | [-1.5000, -0.3000] | `56dccc24…b2178` |
| 2 | 15.725285 | 1.6667 | +0.1000 | [-0.7333, +1.0333] | `d1607701…d8b76` |
| **3（候補）** | 15.946311 | **0.9667** | -0.6000 | [-1.2667, +0.1000] | `c372b833…e383f` |
| 4 | 16.203516 | 1.0333 | -0.5333 | [-1.0333, -0.1000] | `7b89f8a0…46658` |
| 5 | 16.178727 | 0.8333 | -0.7333 | [-1.2667, -0.2333] | `522b4156…ad200` |
| 6 | 16.139380 | 1.4333 | -0.1333 | [-0.9667, +0.8667] | `6a2a7f88…c38ce` |
| **6seed集計** | — | **平均1.1056** | — | 標本SD 0.3702、range 0.7000–1.6667 | — |

各CIは候補-v2の局面単位paired bootstrap、seed 96002、100,000標本のpercentile
95% CI。全6ファイルでv2平均regret=`1.5666666666666667`を完全再現した（M2 PASS）。
候補ファイルは27,986,340 bytesで、完全SHA-256は
`c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`。

## 対Edax level 10 60局

### 条件とprovenance

- 実行日時: 2026-07-17 13:27 JST（metadata UTC `2026-07-17T04:27:22+00:00`）
- primary 30 openingの黒白持ち替え、single-root、level 10、book off
- depth 12、exact-from-empties 16、1500ms、maxNodes 160,000、quota 60%
- 空き20以下は無制限完全読み、TT 64MiB、専有1プロセス
- T125 run key SHA-256: `dc135276e7adbf025499215ef322ab28e6b031f6bd88472a00ba39d62998fedb`
- T121 run key SHA-256: `1ac1a3a564718e08b752bc9b3fed8543e1d9ffb378c90f2af0f7d8ff26755444`
- T108 run key SHA-256: `cbb35f4e5b85fbff3ab11f6cf1d0d4fb65bec2af1683511c90a66cb1a29c98c4`
- openings SHA-256: `7a340c17b02f85a29d5ff296b46ab19aac13f185de7bc03eaf574d6290be81e2`
- harness SHA-256: `32446fb402afe72c96b8fa8f53aad754dbc8091c41072764e6ecaa2d5bd90e02`
- Edax SHA-256: `aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1`
- T125 eval_cli SHA-256: `6ba26dc5f895f23a5b51e7299c47163e10f678bb282f0d12326f11ee4236b2b8`

設定、openings、ハーネス、EdaxはT121/T108と同一。T125はv4ロード対応を含むT124後の
engine/eval_cliなので、そのバイナリSHAはT121/T108から変わる。run keyには候補重みの
パスとSHAを含み、T121/T108から明確に区別されている。fixed-depth 40局面の2回一致と
node-budget 10局面の2回一致もT125実行内でPASSした。

| 構成 | 勝 | 分 | 敗 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|
| T108 v2×WTHOR | 4 | 2 | 54 | -21.8500 | -23 |
| T121 v3×WTHOR seed 3 | 3 | 3 | 54 | **-21.2333** | -20 |
| T125 v4×WTHOR seed 3 | 4 | 2 | 54 | **-24.0167** | -24 |
| v4-v3 | +1 | -1 | 0 | **-2.7833** | -4 |
| v4-v2 | 0 | 0 | 0 | **-2.1667** | -1 |

### opening単位paired比較

各openingについて自作が黒・白の2局の石差を平均し、その30個の対応差をbootstrapした。
v4-v3はseed 125、v4-v2はseed 125108、各100,000標本のpercentile 95% CIである。
実装確認として同じ集計器でT121 v3-v2をseed 121で再計算し、既報の+0.6167、
[-3.8667,+4.9500]を完全再現した。

| opening | v2先後平均 | v3先後平均 | v4先後平均 | v4-v3 | v4-v2 |
|---|---:|---:|---:|---:|---:|
| primary-01 | -13.0 | -36.0 | -29.0 | +7.0 | -16.0 |
| primary-02 | -28.0 | -36.5 | -26.0 | +10.5 | +2.0 |
| primary-03 | -23.0 | -7.0 | -19.0 | -12.0 | +4.0 |
| primary-04 | -29.0 | -10.0 | -26.0 | -16.0 | +3.0 |
| primary-05 | -26.0 | -20.0 | -33.0 | -13.0 | -7.0 |
| primary-06 | -27.5 | -15.0 | -24.0 | -9.0 | +3.5 |
| primary-07 | -30.0 | -17.0 | -20.0 | -3.0 | +10.0 |
| primary-08 | -4.0 | -2.0 | -34.0 | -32.0 | -30.0 |
| primary-09 | -16.0 | -30.0 | -23.5 | +6.5 | -7.5 |
| primary-10 | -5.0 | -16.5 | -18.0 | -1.5 | -13.0 |
| primary-11 | -24.0 | -15.0 | -15.0 | 0.0 | +9.0 |
| primary-12 | -45.0 | -24.5 | -26.0 | -1.5 | +19.0 |
| primary-13 | -21.0 | -23.0 | -38.0 | -15.0 | -17.0 |
| primary-14 | +2.0 | -24.0 | -13.0 | +11.0 | -15.0 |
| primary-15 | -15.0 | -11.0 | -38.0 | -27.0 | -23.0 |
| primary-16 | -39.0 | -23.0 | -27.0 | -4.0 | +12.0 |
| primary-17 | -18.0 | -34.0 | -17.0 | +17.0 | +1.0 |
| primary-18 | -23.0 | -37.0 | -7.0 | +30.0 | +16.0 |
| primary-19 | -9.0 | -13.0 | -19.0 | -6.0 | -10.0 |
| primary-20 | -25.0 | -35.0 | -14.0 | +21.0 | +11.0 |
| primary-21 | -37.0 | -35.0 | -44.0 | -9.0 | -7.0 |
| primary-22 | -28.0 | -25.0 | -16.0 | +9.0 | +12.0 |
| primary-23 | -28.0 | -11.0 | -14.0 | -3.0 | +14.0 |
| primary-24 | -28.0 | -24.0 | -40.0 | -16.0 | -12.0 |
| primary-25 | -34.0 | -33.0 | -26.0 | +7.0 | +8.0 |
| primary-26 | -13.0 | -20.0 | -14.0 | +6.0 | -1.0 |
| primary-27 | -16.0 | -10.0 | -39.0 | -29.0 | -23.0 |
| primary-28 | -21.0 | -14.0 | -21.0 | -7.0 | 0.0 |
| primary-29 | -25.0 | -17.0 | -26.0 | -9.0 | -1.0 |
| primary-30 | -7.0 | -18.5 | -14.0 | +4.5 | -7.0 |
| **平均差 / 95% CI** | — | — | — | **-2.7833 [-7.8000,+2.2500]** | **-2.1667 [-6.7000,+2.2500]** |

v4-v3は改善11 / 同値1 / 悪化18 opening、v4-v2は改善14 / 同値1 / 悪化15。

### 勝敗遷移

同一60ゲームのv3→v4遷移はL→L 50、L→W 2、L→D 2、W→W 1、W→L 2、
D→W 1、D→L 2。v2→v4遷移はL→L 51、L→W 1、L→D 2、W→W 2、
W→L 2、D→W 1、D→L 1だった。敗数54は全世代で同じだが、個々の勝敗は入れ替わる。

## 配信サイズと判断上のトレードオフ

T124実測ではv3 5,964,708 bytes / gzip -9 940,533 bytesに対し、v4は
27,986,340 bytes / gzip -9 4,299,661 bytes。v4はraw約+22.0MB、gzip
**+3,359,128 bytes（約+3.4MB）**で、fresh process平均peak working setも約
+27.74MiBだった。NPSはv3比100.86%で速度ゲート上の悪化はなかったが、配信・メモリ
費用は無視できない。今回の実戦点推定悪化を合わせると、素のv4を採用する根拠は不足する。

## checkpoint/resume記録

- 学習はseed/runごと、各epochの重みとidentityをatomic保存。seed 4〜6の20 epoch完走後、
  同一コマンドを再実行し、epoch再計算なしで完成3 runを結果再計算だけでskipした。
- oracleはoracle/v2/candidateの各局面後にatomic保存。seed 4/5の連続実行後に外側コマンドが
  タイムアウトしたが、完走済みファイルを保持し、seed 6を独立実行して完走した。全ファイルは
  同一provenanceなら同一コマンドで局面単位resume可能である。
- 対局は設定・provenanceを初期checkpointへ保存し、各局後にatomic置換。60/60完走後に
  同一コマンドを再実行し、`loaded 60 already-completed`、fixed-depth/node-budget skip、
  60/60 already doneを実測確認した。
- `python bench/edax-compare/vs_edax.py --self-test-checkpoint`はengine/harness、weights、
  Edax、eval_cliのprovenance不一致拒否とatomic置換直前中断時の既存JSON保持をPASSした。

## 限界事項

- 固定30 opening×先後の60局は検出力が低く、v4-v3 CIは約10.05石幅である。
  平均-2.78石でも統計的な悪化確定ではなく、+2.25石程度の改善も排除できない。
- 同じ60局の決定的再実行は標本数を増やさない。検出力を上げるには別openingが必要である。
- oracle候補選定は同一T096 60局面を使うため、中央値近傍規準でも選抜バイアスは残る。
- T125はv4対応後のengine/eval_cliを使い、T121/T108とはバイナリSHAが異なる。設定、
  openings、ハーネス、Edaxは同一で、T124のv4対応以外のアルゴリズム変更は行っていない。
- 本タスクは計測と採用推奨材料の確定のみで、本番配線、平滑化、正則化、コーパス生成、
  蒸留実験は行っていない。

## 実行コマンド

- `target/release/train_patterns_v3.exe --configs v4 --seeds 4,5,6 --epochs 20 --output-dir train/data/t124/wthor-v4`
- 上記学習コマンドを完走後に再実行（完成3 runをskip）。
- seed 4〜6について `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t124/wthor-v4/v4-seed-<seed>.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t124/oracle/wthor-seed-<seed>.json`
- `python bench/edax-compare/vs_edax.py --opening-set primary --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64 --weights train/data/t124/wthor-v4/v4-seed-3.bin --skip-loss-analysis --results-output bench/edax-compare/endgame-results/t125-vs-edax-results.json --report-output bench/edax-compare/endgame-results/t125-vs-edax-raw-report.md`
- 上記対局コマンドを完走後に再実行（60/60 resume-skip）。
- `python bench/edax-compare/vs_edax.py --self-test-checkpoint`

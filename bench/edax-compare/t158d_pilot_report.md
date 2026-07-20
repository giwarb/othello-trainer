# T158d: 対Edax対局ゲート — 段階1パイロット報告(3ペア=6局)

**本レポートは情報収集(パイロット)であり、n=3ペア(6局)で候補重み(B3 seed2)とv4の強弱の結論を出すものではない。** 採否判定は行わない(スコープ外)。60局本実行の要否・実行時間見積りをユーザーが判断するための材料を提供する。

## 0. 前提の確定(SHA-256実測 vs manifest)

実行前に `bench/edax-compare/t158c_screening_report.meta.json` の `deferredT158d` 節と、以下をすべて実測照合した。**全項目一致**。

| 対象 | パス | manifest記載SHA-256 | 実測SHA-256 | 一致 |
|---|---|---|---|---|
| 候補重み(B3 seed2) | `train/data/t158/full/t158-b3-seed-2.bin` | `dae9af0b...9c7c5ec` | `dae9af0b...9c7c5ec` | ✓ |
| baseline重み(v4) | `train/weights/pattern_v4.bin` | `c372b833...639e383f` | `c372b833...639e383f` | ✓ |
| Edax実行ファイル | `bench/edax-compare/edax-extract/wEdax-x86-64.exe` | `aabb5ac7...4dc318b322b1` | `aabb5ac7...4dc318b322b1` | ✓ |
| Edax eval.dat | `bench/edax-compare/edax-extract/data/eval.dat` | `f8b22996...382a7d90ef21b792` | `f8b22996...382a7d90ef21b792` | ✓ |
| 開幕セット | `bench/edax-compare/openings.json` | `7a340c17...290be81e2` | `7a340c17...290be81e2` | ✓ |

(値は先頭/末尾8桁に省略。フルハッシュは `t158d_pilot_report.meta.json` を参照)

## 1. v4側の過去結果(T125)再利用の可否判定

要件により、T125の結果(`bench/edax-compare/endgame-results/t125-vs-edax-results.json`)が「開幕・プロトコル・Edax設定がSHA/メタで機械的に完全一致」するか確認した。

| 項目 | T125 (`endgame-results/t125-vs-edax-results.json` meta) | 本タスク(現HEAD) | 一致 |
|---|---|---|---|
| 開幕セットSHA-256 | `7a340c17...290be81e2` | `7a340c17...290be81e2` | ✓ |
| Edax実行ファイルSHA-256 | `aabb5ac7...4dc318b322b1` | `aabb5ac7...4dc318b322b1` | ✓ |
| Edax eval.dat SHA-256 | `f8b22996...382a7d90ef21b792` | `f8b22996...382a7d90ef21b792` | ✓ |
| v4重みSHA-256 | `c372b833...639e383f` | `c372b833...639e383f` | ✓ |
| プロトコルパラメータ(depth/nodes/time/quota/tt/exact閾値) | depth12,nodes160000,time1500ms,quota60%,tt64MiB,exactFrom16,unlimitedExact20 | 同一 | ✓ |
| **gitCommit** | `ed22fd27b9df684f013baff6379d307a5202d7d9` | `04dd37a8a5...`(本タスクのharness改修commit) | **不一致** |
| **evalCliSha256(エンジンバイナリ)** | `6ba26dc5f8...4236b2b8` | `c19f8633ce...056ec3570e` | **不一致** |

`git log --oneline ed22fd27b9..HEAD -- engine/` で確認したところ、T125以降に **10件のengine/変更コミット**(T139対称局面順序依存修正、T145、T148、T156a〜T156d MPCカット式導入、T158a評価スカラー特徴追加等)が入っており、エンジンの探索・評価コードそのものがT125時点から変わっている。プロトコルパラメータ(depth/nodes/time等)が同一でも、**エンジンバイナリが別物である以上「機械的完全一致」とは判定できない**ため、要件どおり**v4側も新規に対局を実行した**(候補6局のみでなく、v4側6局も本パイロットで新規取得)。

なお、現HEAD(本タスクのharness改修commit `04dd37a8`)のevalCliSha256 `c19f8633ce...056ec3570e` は、T158cスクリーニング時点のmanifest記載値と完全一致した(T158cのgitCommit `4d7894ae5...`からHEADまで`engine/`変更なしを確認済み)。エンジンは候補選定(T158c)時点からも変わっていない。

## 2. 対局条件(T125本番採用ゲートと同一)

`bench/edax-compare/endgame-results/t125-vs-edax-results.json` の `runKey` から採用:

- `engine_depth=12, engine_exact_from_empties=16, engine_exact_quota_percent=60, engine_max_nodes=160000, engine_time_ms=1500, engine_tt_mb=64, unlimited_exact_empties=20`
- `engine_modes=["single-root"]`, **Edaxレベル10**
- 開幕: `openings.json` の `primary` セット(30ペア=60局本番)の**先頭3ペア(primary-01〜03)=パイロット6局/重み**

コマンド(候補側。v4側は`--weights train/weights/pattern_v4.bin`、出力パスのみ変更):

```
python bench/edax-compare/vs_edax.py --opening-set primary --opening-limit 3 \
  --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 \
  --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 \
  --unlimited-exact-empties 20 --engine-tt-mb 64 \
  --weights train/data/t158/full/t158-b3-seed-2.bin --skip-loss-analysis \
  --results-output bench/edax-compare/endgame-results/t158d-candidate-vs-edax-results.json \
  --report-output bench/edax-compare/endgame-results/t158d-candidate-vs-edax-report.md
```

`--opening-limit`はこのタスクのために`vs_edax.py`へ追加した最小限のharness改修(既定`None`=無制限、既存呼び出しの挙動・既存結果ファイルは不変)。詳細は本レポート末尾「ハーネス改修」参照。

## 3. 結果(paired 6局 x 2重み = 12局)

### 3.1 候補(B3 seed2) 6局

| # | opening | 手番(候補) | 石差(候補-Edax) | 勝敗 | 所要時間 |
|---:|---|---|---:|---|---:|
| 1 | primary-01 | black | -18 | 敗 | 13.2s |
| 2 | primary-01 | white | -18 | 敗 | 12.6s |
| 3 | primary-02 | black | -38 | 敗 | 17.0s |
| 4 | primary-02 | white | -16 | 敗 | 11.9s |
| 5 | primary-03 | black | -32 | 敗 | 13.0s |
| 6 | primary-03 | white | **+20** | **勝** | 12.7s |

候補: **1勝0分5敗**、石差合計 -102、平均石差 -17.00、所要時間合計80.4s(平均13.39s/局)

### 3.2 v4(baseline) 6局

| # | opening | 手番(v4) | 石差(v4-Edax) | 勝敗 | 所要時間 |
|---:|---|---|---:|---|---:|
| 1 | primary-01 | black | -36 | 敗 | 24.8s |
| 2 | primary-01 | white | -22 | 敗 | 13.4s |
| 3 | primary-02 | black | -44 | 敗 | 13.9s |
| 4 | primary-02 | white | -8 | 敗 | 12.7s |
| 5 | primary-03 | black | -32 | 敗 | 12.7s |
| 6 | primary-03 | white | -6 | 敗 | 12.1s |

v4: **0勝0分6敗**、石差合計 -148、平均石差 -24.67、所要時間合計89.6s(平均14.93s/局)

(参考: T125本番60局のv4は4勝2分54敗・平均石差-24.02で、当パイロットのv4平均-24.67とほぼ同水準。エンジンバイナリはT125から変わっているが、Edaxレベル10に対する大まかな実力感は連続している)

### 3.3 ペア差分(候補石差 − v4石差、同一opening・同一色)

| opening | 手番 | 候補 | v4 | 差分(候補-v4) |
|---|---|---:|---:|---:|
| primary-01 | black | -18 | -36 | **+18** |
| primary-01 | white | -18 | -22 | **+4** |
| primary-02 | black | -38 | -44 | **+6** |
| primary-02 | white | -16 | -8 | **-8** |
| primary-03 | black | -32 | -32 | 0 |
| primary-03 | white | +20 | -6 | **+26** |

差分合計 **+46**、平均 **+7.67石/局**(候補が全体としてv4より良い方向)。ただし**n=3ペアであり、この方向性から強弱の結論は出さない**(要件どおり)。分散が大きく(-8〜+26)、符号が割れている。

## 4. 異常チェック(要件3)

- クラッシュ: **0件**(候補・v4とも12局完走、stderrログは両方とも空)
- 非合法手: **0件**(`eval_cli best`が`move=null`を合法手ありの局面で返すとRuntimeErrorになる実装だが、いずれも未発生)
- 非決定性:
  - fixed-depth決定性回帰(40局面を2回実行し全着手・ノード数照合): 候補・v4とも **PASSED(40/40)**
  - node-budget決定性回帰(smoke10局面、max-nodes=4096を2回実行): 候補・v4とも **PASSED(10/10)**
- 上記よりパイロット6局(+6局)の範囲で異常0件。

## 5. 検証watch-point: 空き19前後(終盤入口)の定性確認

候補・v4とも12局全てで、空き22(budgeted、時間/ノード予算あり)→空き20以下(unlimited-exact、完全読み)への遷移を`discDiff`推移で確認した。

- 空き20到達時点で`discDiff`は最終石差にほぼ一致し、以降(空き20→16)は完全読みのため値が固定される(想定どおりの挙動)。
- 空き21〜22(budgeted)の推定値と空き20(exact)の確定値の差は、候補側で最大約7石(primary-02/black: -16.83→-38)、v4側で最大約4石(primary-01/black: -35.74→-36、ただし同局面は`exactFallback=true`)。**候補側で見られた推定値との乖離がv4よりやや大きい局面が1件あった(primary-02/black、空き22で-16.83→空き20で-38)が、対応する対局全体の勝敗自体はv4も同局面で敗北しており(v4は-44)、候補固有の「悪手による石差急落」というより、この開幕自体がEdaxに対して分の悪い進行だったことが主因と考えられる。**
- v4側で2局(primary-01/black、primary-03/black)、空き22の予算内完全読み試行が`exactCompleted=false, exactFallback=true`(予算内に完全読みが終わらずbudgeted評価にフォールバック)になっているが、これは`exactQuotaPercent`機構の想定内の挙動であり異常ではない。候補側では今回のパイロットでは発生しなかった(候補6局中0件)。60局本実行時にこの頻度差が拡大するかは要観察。
- 総括: **空き19前後で候補側に「不審な悪手・石差急落」と呼べる兆候は確認されなかった**。ただしn=3ペアであり、本実行(60局)ではこの観点を再確認することが望ましい(申し送り)。

## 6. 中断→再開の実地確認(要件2)

パイロット本体とは別に、scratchpad上で候補重み・1開幕(primary-01、2局)の小規模実行を用いて中断→再開を実地確認した(本体の6局チェックポイントとは独立、リポジトリ外に実行。手順・ログはこのレポートに記録し、一時ファイル自体はコミット対象外)。

1. `--opening-limit 1`(2局計画)で起動。
2. 1局目完走(`[1/2]`、opening=primary-01/black、石差-18)を確認後、プロセスを`Stop-Process -Force`で強制終了(2局目の対局中に中断)。
3. 中断時点の結果ファイルを確認: **1局のみ**(game_id=1、石差-18)が永続化されていた(1局単位のatomic checkpointが機能)。
4. 同一コマンドで再実行(`--no-resume`なし)→ ログに`[resume] loaded 1 already-completed game(s)`、fixed-depth/node-budget決定性チェックも`already completed (resumed), skipping`と表示され、**2局目(opening=primary-01/white)のみ**が新規に対局・完走(`[2/2]`)。
5. 最終結果: game_id=1(石差-18、中断前の値のまま変化なし)・game_id=2(石差-18)の2局が揃い、重複・欠落なし。

→ **1局単位のatomic checkpoint・resumeが実地で機能することを確認した。**

## 7. 60局本実行の所要時間見積り(ユーザー判断材料)

パイロットの実測(6局ずつ、候補・v4)から:

| | 局数 | 合計時間 | 平均/局 | 最小/局 | 最大/局 |
|---|---:|---:|---:|---:|---:|
| 候補6局 | 6 | 80.4s | 13.39s | 11.9s | 17.0s |
| v4 6局 | 6 | 89.6s | 14.93s | 12.1s | 24.8s |

fixed-depth/node-budget決定性回帰チェック等のオーバーヘッド(opening数に依存しない固定コスト)は候補・v4とも約14〜15秒/実行(プロセス起動〜レポート書き出しの実測: 候補95s−対局80.4s≒14.6s、v4104s−対局89.6s≒14.4s)。

**60局本実行の見積り(平均値ベース、シーケンシャル実行前提)**:

- 候補60局: オーバーヘッド15s + 60×13.39s ≒ **818秒(約13.6分)**
- v4 60局(要件1のとおり、T125再利用不可のため新規実行が必要): オーバーヘッド15s + 60×14.93s ≒ **911秒(約15.2分)**
- **両方合計(候補+v4、逐次実行): 約1730秒(約28.8分)**

パイロットの局あたり時間には約2倍のばらつき(最短11.9s〜最長24.8s、後者は空き22でのexact-fallback再試行によるもの)があり、30開幕全体では今回選ばなかった開幕でさらに時間のかかる局面(空き22〜28付近の組合せ複雑度が高い進行)に当たる可能性がある。安全側の見積りとしては**両方合計30〜45分程度を確保することを推奨**する。

**注意**: 候補側・v4側の対局は`--engine-time-ms 1500`という**壁時計(wall-clock)ベースの時間予算**で着手選択している。2プロセスを並行実行するとCPU競合により同一時間内の実探索量が減り、結果が変質する(計測の再現性・比較妥当性が崩れる)おそれがあるため、**60局本実行でも候補側→v4側の逐次実行を維持すべき**(本パイロットもその方針で実行した)。

## 8. 結論(情報収集のみ、判定なし)

- 前提(重み・Edax・開幕セットのSHA-256)はすべて一致し、実行環境は正しく構成されていた。
- v4側の過去結果(T125)はエンジンバイナリの世代が異なるため再利用不可と判断し、パイロットでは候補・v4とも新規に6局ずつ取得した。60局本実行でも同様に両方の新規実行が必要。
- パイロット6局+6局の範囲で異常(クラッシュ・非合法手・非決定性)は0件。
- 中断→再開のatomic checkpoint機構は実地で正常に機能した。
- 空き19前後の終盤入口で候補側に不審な石差急落は確認されなかった(1件、候補側でbudgeted推定とexact確定の乖離がv4よりやや大きい局面があったが、対応する開幕はv4も同様に敗北しており候補固有の問題とは言い切れない)。
- ペア差分(候補-v4)の合計は+46(平均+7.67石/局、候補優位方向)だが、**n=3ペアでは強弱の結論を出さない**(符号が割れており分散も大きい)。
- 60局本実行の所要時間は両重み合計で概ね30分前後(逐次実行)と見積もられ、時間的なハードルは低い。実行するかはユーザー判断。

## 9. ハーネス改修(vs_edax.pyへの最小変更)

commit `04dd37a8a509d3c3d7f74c6896674be7b1f008df` で以下を追加(既定値は全てNoneで既存呼び出しの挙動・既存結果ファイルは不変):

- `--opening-limit N`: `--opening-set`で選んだopening集合の先頭N件のみに対局(match play)を制限する(fixed-depth/node-budget決定性回帰チェックには影響しない)。`settings.opening_limit`としてrun_key/provenanceにも記録される。
- 各対局に`wallClockSec`(壁時計所要時間)フィールドを追加し、進捗print行にも`[X.Xs]`として表示するようにした(60局本実行時の所要時間見積りに使用)。

## 10. 生成物

- `bench/edax-compare/t158d_pilot_report.md`(本ファイル)/ `t158d_pilot_report.meta.json`
- `bench/edax-compare/endgame-results/t158d-candidate-vs-edax-results.json` / `t158d-candidate-vs-edax-report.md`(候補6局、生の対局ログ+自動生成レポート)
- `bench/edax-compare/endgame-results/t158d-v4-vs-edax-results.json` / `t158d-v4-vs-edax-report.md`(v4 6局、同上)
- `bench/edax-compare/vs_edax.py`(harness改修、上記9節)

# T194: 深さ10同士の対Edax対局計測(強さ比較)

**本レポートは実測の提示であり、深さベース方式の本採用判断は行わない**(スコープ外)。ユーザー依頼「深さ10どうしの対局での強さ比較。ベンチマーク(Edax)にどこまで肉薄できているのか」に対し、自前エンジン(深さ10固定・MPC ON・t=1.0)と Edax Level 10 の60局paired対局を実施した。

## 0. 背景

直近の前例 `tasks/T175-depth-based-mpc-pilot.md`(2026-07-21)は、深さ12固定・MPC ON(margin t=1.5、暗黙のデフォルト校正値)でvs Edax lv10 = **平均石差+1.05(プロジェクト初の勝ち越し)**、vs lv12 = -2.82 を実測した。本タスクは「深さを揃えた(自前10 vs Edax lv10)ときの純粋な棋力差」を見る新しい計測であり、T175と同一ハーネス(`bench/edax-compare/vs_edax.py`)・同一開幕セットで実行した。

**設定上の申し送り(実装開始時に検出)**: 本タスクの依頼文は「T175との差分は深さ12→10のみ」としていたが、確認したところ**T175(P1・P2とも)はMPC margin tを明示指定しておらず、`engine/src/mpc.rs`のCALIBRATIONS表のデフォルト値(t=1.5)で実行されていた**(`--mpc-margin-t`引数自体がT176で追加されたもので、T175実行時にはまだ存在しなかった)。一方、本タスクの目的・要件は「MPC t=1.0(T176選定値)」を明示的に要求している。両者を両立させることはできないため、**タスク仕様書の明示指定(t=1.0)を優先し、T175との実際の差分は「深さ(12→10)」と「MPC margin t(暗黙1.5→明示1.0)」の2点になる**ことをここに明記する(詳細判断根拠はタスクファイル作業ログ参照)。この2点差分を踏まえたうえで統計比較を行った。

## 1. 実行設定

自前エンジン(`eval_cli best`, `mpc_enabled` feature込みビルド):

```
python bench/edax-compare/vs_edax.py \
  --engine-depth 10 --engine-exact-from-empties 16 --engine-time-ms 15000 \
  --engine-max-nodes 100000000 --engine-exact-quota-percent 60 \
  --unlimited-exact-empties 20 --engine-tt-mb 64 \
  --engine-enable-mpc --engine-mpc-margin-t 1.0 \
  --weights train/weights/pattern_v6.bin --opening-set primary --levels 10 \
  --engine-modes single-root --skip-loss-analysis \
  --results-output bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-results-full.json \
  --report-output bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-report-full.md
```

| 項目 | 自前エンジン(本タスク) | T175 P2(比較baseline) | 一致/差分 |
|---|---|---|---|
| 探索深さ | **10(固定)** | **12(固定)** | **差分** |
| MPC | ON(margin t=**1.0**、明示指定・T176選定値) | ON(margin t=**1.5**、暗黙デフォルト、T175時点では`--mpc-margin-t`未実装) | **差分** |
| ノード上限 | 100,000,000(実質無効) | 同左 | 一致 |
| wall保険 | 15,000ms | 同左 | 一致 |
| exact-from-empties | 16 | 同左 | 一致 |
| unlimited-exact-empties | 20 | 同左 | 一致 |
| exact-quota-percent | 60% | 同左 | 一致 |
| TT | 64MiB | 同左 | 一致 |
| 重み | `train/weights/pattern_v6.bin`(同一SHA256) | 同左 | 一致 |
| 開幕セット | primary 30ペア(SHA256 `7a340c17...290be81e2`) | 同左 | 一致(同一開幕・paired比較可) |
| Edaxバイナリ | 同一SHA256(`aabb5ac7...`) | 同左 | 一致 |
| Edaxレベル | lv10 | lv10 | 一致(同一相手) |
| engine_modes | single-root | single-root | 一致 |

設定一致検証は `bench/edax-compare/t194_depth10_compare.py`(`validate_settings_match`相当)で機械的に実施し、上記「差分」2キー(`engine_depth`・`engine_mpc_margin_t`)以外の全キー(`engine_exact_from_empties`・`engine_time_ms`・`engine_max_nodes`・`engine_exact_quota_percent`・`unlimited_exact_empties`・`engine_tt_mb`・`weights`・`engine_enable_mpc`・`opening_set`・`opening_count`・`openings_sha256`・`meta.weightsSha256`・`meta.edaxSha256`)が完全一致することを確認した(不一致があればエラーで停止する設計、T176redo#1の教訓を踏襲)。

## 2. 実行ログ

- 事前登録の時間チェック(3開幕6局、`--opening-limit 3`): 22.7〜27.0秒/局、異常0件、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED。深さ10は深さ12(T175平均約46〜50秒/局)よりも大幅に高速であることを確認したうえで本実行に進んだ。
- 本実行(primary全30開幕×先後=60局、`--allow-dirty`でタスクファイル作業ログのみdirtyな状態から起動): フォアグラウンドでBash `run_in_background`+ポーリング(結果JSONの`games`件数を都度確認、Monitor通知のみに依存しない)で完走まで監視した。1局あたり20.1〜31.0秒(全60局、120秒閾値を大幅に下回る)。
- 逐次保存: `vs_edax.py`の既存checkpoint機構(1局完了ごとに結果JSONへ追記・resume対応)をそのまま利用。最終行 `Wrote t194-depth10-vs-edax-lv10-results-full.json (checkpoint: 60/60 games)` を確認。
- 異常チェック: 実行ログ全文(`grep -iE "traceback|error|exception"`)で0件。fixed-depth決定性回帰(40/40)・node-budget決定性回帰(10/10)ともPASSED。
- 早期終局(64マス未満での終局、正当なルール上の帰結、T162/T166/T169/T175と同種): primary-29(白番)・primary-30(黒番)の2局(63石で終局)。クラッシュ・非合法手ではない。

## 3. 結果: 勝敗・平均石差

| 構成 | 勝 | 分 | 敗 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|
| **本タスク: 深さ10+MPC(t=1.0) vs lv10** | **27** | **2** | **31** | **-2.00** | -2.0 |
| T175 P2(参考): 深さ12+MPC(t=1.5) vs lv10 | 34 | 3 | 23 | **+1.05** | +3.0 |
| T169(参考): ノード予算(MPC OFF)vs lv10 | 26 | 1 | 33 | -2.22 | -2.5 |
| T175 P1(参考、相手違い): 深さ12+MPC(t=1.5) vs lv12 | 24 | 5 | 31 | -2.82 | -3.0 |
| T174(参考、相手違い): ノード予算(MPC OFF)vs lv12 | 18 | 1 | 41 | -6.07 | -8.0 |

**深さ10+MPC(t=1.0)は、旧来のノード予算・MPC OFF構成(T169、-2.22)とほぼ同水準(-2.00)にとどまり、深さ12+MPC(T175 P2、+1.05)には届かなかった。** つまり「探索深さを10に固定してMPCで枝刈りを効かせる」だけでは、深さ12まで伸ばした場合の強さ(勝ち越し水準)には達しない。

## 4. T175 P2とのpaired比較(同一開幕60局、`t194_depth10_compare.py`)

開幕単位(n=30)・局単位(n=60)の paired bootstrap(seed=194004/194005、10万標本、T175/T176と同一アルゴリズム、配列順は開幕番号昇順→黒番→白番)。

| 集計単位 | 平均差(本タスク−T175 P2) | 95%CI | 改善/悪化/同値 | 符号検定p |
|---|---:|---|---:|---:|
| 開幕単位(n=30) | **-3.05** | [-6.15, +0.25] | 7 / 20 / 3 | 0.0124 |
| 局単位(n=60) | **-3.05** | [-5.87, -0.17] | 19 / 38 / 3 | 0.0118 |

**局単位ではCIが完全に0未満(悪化が統計的に有意、p<0.05)。開幕単位でもCI上限がわずかに0を超えるのみで、悪化方向がほぼ一貫している。** 深さ10化(+MPC margin tの1.5→1.0変更込み)は、深さ12+MPC(t=1.5)のT175 P2構成と比べて明確に弱くなる、という結果が得られた。

## 5. 時間・ノード分布・wall保険発火(本タスク vs T175 P2)

| アーム | 総着手数 | 時間(ms) mean | p50 | p90 | max | ノード数 mean | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 本タスク(深さ10) | 1496 | 640.5 | 40.0 | 3491.0 | 6761 | 6,981,834 | 85,865 | 41,712,864 | 60,477,824 |
| T175 P2(深さ12、参考) | 1496 | 1671.1 | 600.0 | 6296.0 | 15000 | 9,695,569 | 390,288 | 60,484,038 | 65,035,940 |

(budgeted相番=中盤帯の着手のみ、本タスク n=896: mean 995.9ms・p50 60.5ms・p90 5159.5ms・max 6761ms、ノード mean 10,753,239・p50 110,242・p90 60,052,378・max 60,477,824。)

- **ノード上限(100,000,000)は本タスク・T175 P2とも一度も到達しなかった**(`nodeLimitHit` 0/1496・0/1496)。
- **wall保険(15,000ms)発動**: 本タスク**0/1496件**(T175 P2は1/1496件)。深さ10は深さ12よりも探索完了に必要な時間が短いため、時間切れの心配はさらに小さい。
- **1局あたり所要時間**: 本タスク平均24.4秒(最小20.1秒・最大30.9秒)。T175 P2の平均50.0秒(最小30.1秒・最大83.4秒)のおよそ半分。

## 6. MPC発火統計(本タスク)

| 対象着手数 | eligibleNodes | probeAttempts(High+Low) | probeNodes | cutsHigh | cutsLow | 総カット数 | eligible当たりカット率 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1496 | 204,012 | 317,074 | 6,818,235 | 90,950 | 64,547 | 155,497 | **76.2%** |

T175(P1/P2とも約72%)と近い水準でMPCが機能しており、t=1.0への切り替え(枝刈りをより積極化)が反映された値になっている(T176のt=1.0スクリーニング結果、深さ12固定でt=1.5比21%ノード削減、と整合的な方向)。

## 7. 異常チェック

- クラッシュ: 0件(60/60局完走、stderrログ相当のTraceback/ERROR/Exceptionを実行ログ全文grepで確認、該当なし)
- 非合法手: 0件
- 非決定性: fixed-depth決定性回帰(40/40)・node-budget決定性回帰(10/10)ともPASSED(既存の非MPC経路の回帰チェック)
- 早期終局: 2局(primary-29白番・primary-30黒番、いずれも63石で終局)、正当なルール上の帰結でT162/T166/T169/T175と同種の既知事象

## 8. 結論: Edaxへの肉薄度合い

- **「探索深さ10・MPC ON(t=1.0)」の自前エンジンは、Edax Level 10に対して平均石差-2.00(27勝2分31敗)** で、依然として負け越している。旧来のノード予算構成(T169、-2.22)とほぼ同水準にとどまり、T175で確認された「深さ12+MPCならlv10に勝ち越せる(+1.05)」という改善は、**深さを10まで落とすと失われる**ことが分かった。
- T175 P2とのpaired比較では、局単位で統計的に有意な悪化(-3.05石、95%CI[-5.87, -0.17]、p=0.012)が観測された。開幕単位でも同じ平均差(-3.05石)で、CIはわずかに0をまたぐのみ(ほぼ一貫した悪化方向)。
- 一方で1局あたりの所要時間は深さ12(平均50.0秒)のおよそ半分(平均24.4秒)であり、探索深さと強さ・時間のトレードオフが明確に確認できた: **「同じ探索深さ」で比べるとEdax lv10にまだ届かず、Edaxとの互角以上の勝負には現状「深さ12相当」の探索コストが必要**、というのが本計測から得られる事実。
- 深さベース方式の本採用可否・深さ選択の設計判断は本タスクのスコープ外(別途の設計検討に委ねる)。

## 9. 生成物

- `bench/edax-compare/t194_depth10_match_report.md`(本ファイル)
- `bench/edax-compare/t194_depth10_compare.py`(T176の`t176_confirmation_compare.py`をベースにした比較スクリプト、`engine_depth`・`engine_mpc_margin_t`を意図的な差分として設定一致検証から除外)
- `bench/edax-compare/endgame-results/t194-precheck-lv10-{results.json,report.md}`(事前チェック6局、ローカルのみ・gitignore対象)
- `bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-{results,report}-full.{json,md}`(60局、生ログ+自動生成レポート、ローカルのみ・gitignore対象)
- `bench/edax-compare/endgame-results/t194_depth10_vs_t175p2_compare.json`(paired比較の生成果物、ローカルのみ・gitignore対象)
- T158d・T162・T166・T169・T174・T175・T176系の既存成果物は無変更(本タスクはエンジン・アプリのコード変更を伴わない計測のみ)

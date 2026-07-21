# T169: D1候補の対局ゲート報告(対Edax 60局paired、vs 現行本番v5)

**本レポートは事前登録規準への当てはめと判定材料の提示までであり、新本番の採否最終裁定は行わない(オーケストレーター+ユーザーが判断)。** T158d/T162/T166で確立したハーネス・プロトコルをそのまま再利用している。

## 0. 目的

T168で確定したD1候補(V3+corner5x2、frozen MAE 4.492 vs 現行v5の4.703)が、対Edax実対局で現行本番v5より強いかを判定する。

## 1. 前提の確認(SHA-256実測)

`bench/edax-compare/t168_training_report.meta.json`の`t169Manifest`節から候補・baselineのパス・SHA-256を取得した。**候補SHAはタスクファイル記載値と1文字ずれがあり(`...bbfffcf4caf20fc9` vs manifest`...bbfff4cf4caf20fc9`)、指示どおりmanifest値を正として採用した。**

| 対象 | パス | manifest記載SHA-256 | 実測SHA-256 | 一致 |
|---|---|---|---|---|
| baseline v5 | `train/weights/pattern_v5.bin` | `9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4` | 同一 | ✓ |
| 候補D1 | `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin` | `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9` | 同一 | ✓ |

**baseline v5のSHA-256は、T166の候補C(`bench/edax-compare/t166_gate_report.meta.json`の`provenanceVerification.candidateC.sha256Measured`)と完全に一致する** — T167(本番配線)で候補Cがそのままv5として採用されたことを裏付ける。開幕セット・Edax実行ファイル・eval.datのSHA-256もT158d/T162/T166と同一(変更なし)。

## 2. baseline再利用のスポットチェック(不一致 → 新規実行)

`git log fe5ffbcd..HEAD -- engine/`(T166実行時のgitCommitから現HEADまで)で、T168(corner5x2/diag4形状+定数項scalar追加)の1コミットが`engine/`に入っていることを確認した。現HEADで`cargo build --release -p engine --bin eval_cli`を実行しSHA-256を実測したところ`7ecceb8afcf1c882e1f93c4d66cd19be45b47a31f6e68be920f09480697ccfff`で、T166の`9c28701a21e01f371282bf61afd4ed2ccea06d2150555ca3d7cf482bdbc2f970`と不一致だった。

指示どおり、まずv5重みで`--opening-limit 3`(先頭3開幕・6局)を実行し、T166候補C結果(`bench/edax-compare/endgame-results/t166-c-vs-edax-results-full.json`、ローカル)の先頭6局と突合した。

- **margin・plies**: 6局全て完全一致(primary-01/black -32・white +8、primary-02/black -6・white -10、primary-03/black -40・white +32、いずれも手数も一致)。
- **move・nodes・discDiff(詳細)**: **1局(primary-03/white)で不一致を発見**。空き17(ply33)の時点でdiscDiff=+32.0で局面がすでに完全読みにより確定しており、以降(ply34〜49)は「どの空きマスをどの順で埋めても最終石差が変わらない」局面だが、**実際に選択された着手の順序(move)とノード数(nodes)が2つの実行で異なっていた**(discDiff自体は32.0のまま両方一致)。T168で新規パターン形状(corner5x2/diag4)が探索の内部テーブルに追加されたことで、既に確定した局面での同点手の内部tie-break順序が変わったためと考えられる。

**指示(1つでも不一致なら新規実行)に従い、T166候補Cの60局データは再利用せず、v5 baselineを新規に60局実行した。** この判定は安全側であり、たとえ最終結果(margin/plies)は完全一致していても、より詳細な粒度(move/nodes)で機械的に不一致が検出された以上、厳密な同一性は主張できないため。

## 3. 候補D1(PWV6)のscalar特徴事前確認

対局開始前に、`eval_cli gen`で初期局面を生成し、候補D1の重みファイルを`--pattern-weights`で渡して`eval_cli best`を単独実行し、stderrの診断出力を確認した。

```
[eval_cli weights] scalar_features_present=true scalar_features_enabled=true
```

比較のためv5(baseline、こちらもT166候補C由来でscalar特徴を持つ)でも同じ確認を行い、`scalar_features_present=true scalar_features_enabled=true`であることを確認した(両アームともscalar特徴が有効)。

## 4. 実行(60局×2本、逐次・専有)

| 対象 | 開始(JST) | 終了(JST) | 所要時間 | 局数 | 異常 |
|---|---|---|---:|---:|---:|
| v5 baseline(新規実行) | 13:48:35 | 14:01:55 | 約800秒(13.3分) | 60/60 | 0件 |
| 候補D1 | 14:02:25 | 14:17:24 | 約899秒(15.0分) | 60/60 | 0件 |

**合計約28.3分**(逐次実行、他の重い処理と並行せず)。候補D1実行は、直前のスポットチェック・v5実行完了後にworktreeが一時的にdirty(タスクファイルの作業ログ追記のみ、`engine/`・`vs_edax.py`・重み等の計測対象パスとは無関係)だったため`--allow-dirty`で実行した(T166と同種の運用)。

各本ともPowerShell `Start-Process`でdetached起動、ツール呼び出しでのポーリング(結果JSON games件数・ログ末尾・プロセス生存を確認、Monitor通知には依存しない)で進捗確認。fixed-depth決定性回帰40/40・node-budget決定性回帰10/10が両本ともPASSED、stderrログはいずれも空(異常0件)。

## 5. 結果(2本×60局)

| 構成 | 勝 | 分 | 敗 | 石差合計 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|---:|
| v5(baseline) | 20 | 3 | 37 | -405 | -6.75 | -5.0 |
| 候補D1 | 26 | 1 | 33 | -133 | -2.22 | -2.5 |

(v5の勝敗・石差はT166候補Cの値と完全一致 — 4節で述べたとおりv5=候補Cであり、スポットチェックで見つかった1局の着手順序の違いは全体成績に影響していない。)

**候補D1はv5より実戦成績が明確に良い(平均石差で約4.5石の改善)。**

## 6. 開幕(opening)単位の平均石差とペア差分(T121/T125/T158d/T162/T166と同一集計方法)

| opening | D1平均石差 | v5平均石差 | 差分(D1-v5) |
|---|---:|---:|---:|
| primary-01 | -3.00 | -12.00 | +9.00 |
| primary-02 | -2.00 | -8.00 | +6.00 |
| primary-03 | +1.00 | -4.00 | +5.00 |
| primary-04 | -5.00 | -20.00 | +15.00 |
| primary-05 | +2.00 | -10.00 | +12.00 |
| primary-06 | -3.00 | +7.00 | -10.00 |
| primary-07 | -5.00 | -8.00 | +3.00 |
| primary-08 | +0.00 | +1.00 | -1.00 |
| primary-09 | -7.00 | -8.00 | +1.00 |
| primary-10 | -2.00 | -8.00 | +6.00 |
| primary-11 | -5.00 | -8.00 | +3.00 |
| primary-12 | -10.00 | +3.00 | -13.00 |
| primary-13 | -6.00 | -10.00 | +4.00 |
| primary-14 | +1.00 | -6.00 | +7.00 |
| primary-15 | -5.00 | -7.00 | +2.00 |
| primary-16 | +1.00 | -7.00 | +8.00 |
| primary-17 | -9.00 | -8.00 | -1.00 |
| primary-18 | +1.00 | -1.00 | +2.00 |
| primary-19 | +1.00 | -4.00 | +5.00 |
| primary-20 | +5.00 | -5.00 | +10.00 |
| primary-21 | +2.00 | -18.00 | +20.00 |
| primary-22 | -13.50 | -11.00 | -2.50 |
| primary-23 | -2.00 | +0.00 | -2.00 |
| primary-24 | -14.00 | -12.00 | -2.00 |
| primary-25 | -3.00 | -1.00 | -2.00 |
| primary-26 | -5.00 | -6.00 | +1.00 |
| primary-27 | +14.00 | -5.00 | +19.00 |
| primary-28 | +6.00 | -12.00 | +18.00 |
| primary-29 | +10.00 | -4.50 | +14.50 |
| primary-30 | -11.00 | -10.00 | -1.00 |
| **平均差** | -- | -- | **+4.53** |

## 7. 統計判定材料(事前登録規準への当てはめ、採否は判定しない)

アルゴリズム: T158d/T162/T166と同一のpaired bootstrap(`compare_pattern_v3.py`の`paired_bootstrap()`と同一実装、`random.Random(seed)`で差分配列から重複ありでresample、100,000標本、percentile 95%CI)+符号検定(scipy.stats.binomtest, two-sided, p=0.5, 同値を除く)。**bootstrap配列の並び順**: 開幕単位は`primary-01`から`primary-30`まで番号昇順。局単位は開幕番号昇順→黒番→白番の順(T166と同一規則)。

### 7.1 主指標: 対v5 baseline(n=30、開幕単位)

| 比較 | 平均差(D1-v5) | paired bootstrap 95%CI(seed) | 改善/悪化/同値 | 符号検定p値 |
|---|---:|---|---|---:|
| D1 vs v5 | **+4.5333** | **[+1.7833, +7.3333]**(seed=169004) | 21/9/0 | **0.0428** |

局単位(n=60、補足): 平均差+4.5333(線形性により開幕単位と一致)、CI[+2.0667,+7.0333](seed=169005)、改善38/悪化18/同値4、符号検定p=0.0105。

**開幕単位・局単位いずれもCIが完全に0より上であり、符号検定も有意水準0.05を下回る(開幕単位p=0.0428、局単位p=0.0105)。統計的に有意な改善が確認された。**

### 7.2 採用提案の規準への当てはめ

- **CIが0より完全に上か**: 開幕単位CI[+1.7833,+7.3333]は完全に0より上。→ **満たす**
- **異常0件か**: 本タスクで異常(クラッシュ・非合法手・非決定性)は**0件**。→ **満たす**

**両条件を満たすため、候補D1(V3+corner5x2)を新本番候補として採用提案する。**

**ただし、この提案には配信サイズのトレードオフが伴い、これは事前登録規準どおりユーザー裁定事項として明記する**: 候補D1の重みファイルはraw 42,394,905バイト・gzip 10,734,273バイト(約10.7MB、T168レポート`bench/edax-compare/t168_training_report.md`実測値)で、現行v5(raw 27,986,840バイト・gzip 5,865,976バイト、約5.9MB)よりgzipで+4,868,297バイト(約4.64MB、約+83%)大きい。統計的な有意改善(平均+4.5石/局)がこのサイズ増(gzipで約1.83倍)を正当化するかは、実戦力向上とアプリ配信・初回ロード時間のトレードオフであり、**最終的な採否裁定はこのレポートを受けたオーケストレーター+ユーザーが行う**。

## 8. wall保険・所要時間の両アーム比較(NPS-21%の影響確認)

T168レポートによれば候補D1はcorner5x2/diag4形状の追加計算コストによりNPSが約21%低下する。この影響が実際の対局所要時間・wall-clock時間予算の逼迫(wall保険発動)に現れるかを確認した。

| アーム | 局あたり所要時間(平均) | 最小 | 最大 | 標準偏差 | 合計 |
|---|---:|---:|---:|---:|---:|
| v5 | 13.079秒 | 10.187秒 | 20.812秒 | 1.645秒 | 784.749秒 |
| D1 | 14.668秒 | 12.844秒 | 18.625秒 | 1.276秒 | 880.056秒 |

D1はv5より局あたり平均で約1.59秒(約12.1%)遅い。NPS-21%の低下幅よりは小さい体感遅延にとどまっている(ノード予算160,000到達までの絶対時間が伸びるが、探索深さ自体は同じノード数で頭打ちになるため、探索全体の相対的な遅延はNPS低下率よりやや圧縮される)。

**wall保険(wallInsuranceFired = `timedOut=true かつ nodeLimitHit=false`、`vs_edax.py`の`policy_calibration`系と同一定義)の発動**: 両アームの全engine着手(v5: 1489手、D1: 1498手)を対象に集計したところ、**v5・D1とも発動0件**だった(`timedOut`自体も両アームで0件)。プロトコルのノード予算(160,000)が1500msの時間予算より先に律速するよう十分な余裕を持って設定されているため、D1のNPS低下(約21%)によっても時間切れによる探索打ち切りは一度も発生しなかった。

## 9. exactFallback集計の定義(T158d/T162/T166から継続)

exactFallbackの集計は、budgeted相番から空き20以下のunlimited-exactモードへ切り替わる直前の1手(遷移点)についてのみ判定する(ゲーム中の他のbudgeted局面でのexactFallbackは集計対象外、T158d/T162/T166と同一定義)。

| 側 | fallbackAtTransition |
|---|---:|
| v5 | 5/60 |
| D1 | 3/60 |

(v5の値はT166候補Cの値〈5/60〉と完全一致、6節で述べたv5=候補Cの整合性の追加傍証。)

## 10. watch-point

### 10.1 budgeted→exact乖離の分布

| 側 | n | 平均\|乖離\| | 中央値\|乖離\| | 最大\|乖離\| | 最大乖離の開幕/色 | 標準偏差 |
|---|---:|---:|---:|---:|---|---:|
| v5 | 60 | 4.790 | 4.480 | 15.620 | primary-01/black | 3.972 |
| D1 | 60 | 4.306 | 3.700 | 13.900 | primary-22/white | 3.386 |

候補D1はv5よりわずかに乖離が小さく安定している(平均4.31石 vs 4.79石)。NPS低下による探索の質的な劣化を示す兆候はなく、むしろ僅かに安定している。

### 10.2 符号反転(budgeted推定とexact確定の符号が異なる局)

- v5: 7/60(primary-20/black、primary-19/white、primary-23/white、primary-28/white、primary-18/white、primary-08/black、primary-18/black)
- D1: 4/60(primary-22/white、primary-24/white、primary-07/white、primary-14/white)

全反転は近接値(budgeted側の絶対値が最大でも9.90、D1 primary-22/white)からの反転であり、劇的な逆転は両アームいずれにも見られなかった。D1の反転数(4)はv5(7)より少なく、探索の不安定性を示す兆候はない。

## 11. 異常チェック

- クラッシュ: **0件**(両本とも全局完走、stderrログはいずれも空)
- 非合法手: **0件**
- 非決定性: 両本ともfixed-depth決定性回帰(40/40)・node-budget決定性回帰(10/10)がPASSED
- wall保険発動: **0件**(両本とも、8節参照)

## 12. 生成物

- `bench/edax-compare/t169_gate_report.md`(本ファイル)/ `t169_gate_report.meta.json`
- `bench/edax-compare/endgame-results/t169-v5-spotcheck-{results.json,report.md}`(スポットチェック6局)
- `bench/edax-compare/endgame-results/t169-{v5,d1}-vs-edax-{results,report}-full.{json,md}`(各60局、生ログ+自動生成レポート、gitignore対象でローカルのみ)
- T158d・T162・T166・T168系の成果物は不変のまま。

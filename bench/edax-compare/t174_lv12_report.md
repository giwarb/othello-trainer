# T174: 対Edax lv12実力計測(v6本番構成、60局)

**本タスクは純粋な計測であり、採否判定は行わない。** v6(現本番、T169候補D1採用)が対Edax lv10でほぼ互角(-2.22石)に達したため、次の目標設定用にlv12での現在地を計測する。

## 1. 前提の確認(SHA-256実測)

| 対象 | パス | SHA-256(実測) | 一致 |
|---|---|---|---|
| 重み(v6、現本番) | `train/weights/pattern_v6.bin` | `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9` | T169候補D1と完全一致(採用済み) |
| Edax実行ファイル | `bench/edax-compare/edax-extract/wEdax-x86-64.exe` | `aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1` | T158d/T162/T166/T169から不変 |
| Edax eval.dat | `bench/edax-compare/edax-extract/data/eval.dat` | `f8b2299612d9fa4414157e70e932636e33111c2602d0c2fc382a7d90ef21b792` | T158d/T162/T166/T169から不変 |
| 開幕セット | `bench/edax-compare/openings.json` | `7a340c17b02f85a29d5ff296b46ab19aac13f185de7bc03eaf574d6290be81e2` | T158d/T162/T166/T169から不変 |

`--levels`引数は既存のカンマ区切り任意整数リスト実装(`bench/edax-compare/vs_edax.py`、`-l <level>`としてそのままEdaxに渡す設計)であり、level 12指定にハーネス改修は不要だった。

`git log <T169実行時点>..HEAD -- engine/`でT170(本番配線)・T172(MPC再校正、Gate3不合格で事前登録どおり撤退)の2コミットを確認、現HEADで`cargo build --release -p engine --bin eval_cli`を再ビルド(SHA `cfd600e64e275bdca01a58e102c5f2d8eb62070099a747b0f0e33ceeac783cd6`、T169時点の`7ecceb8a...`と不一致だが、本タスクはEdaxレベルがT169〈lv10〉と異なる新規計測であり過去データの再利用判定は不要〈必ず新規60局〉)。

## 2. 実行

- エンジン側: 現本番構成(`pattern_v6.bin`、depth12・exact-from-empties16・160,000ノード・1500ms・quota60%・空き20以下無制限・TT64MiB、single-root、T158d/T162/T166/T169と同一プロトコル)
- Edax側: **level 12**(それ以外の条件はT169と同一)
- 開幕: primary 30ペア=60局

```
python bench/edax-compare/vs_edax.py --opening-set primary \
  --engine-modes single-root --levels 12 --engine-depth 12 --engine-exact-from-empties 16 \
  --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 \
  --unlimited-exact-empties 20 --engine-tt-mb 64 \
  --weights train/weights/pattern_v6.bin --skip-loss-analysis \
  --results-output bench/edax-compare/endgame-results/t174-v6-vs-edax-lv12-results.json \
  --report-output bench/edax-compare/endgame-results/t174-v6-vs-edax-lv12-report.md
```

PowerShell `Start-Process`でdetached起動(17:53:38開始)、ツール呼び出しでのポーリング(結果JSON games件数・ログ末尾・プロセス生存を確認、Monitor通知には依存しない)で進捗確認。**18:07:55完走、所要時間約857秒(約14.3分)**(局あたり平均13.98秒、事前見積り30〜60分より大幅に短時間で完了)。60/60局、fixed-depth決定性回帰40/40・node-budget決定性回帰10/10がPASSED、stderrログは空(異常0件)。

## 3. 結果

| 構成 | 勝 | 分 | 敗 | 石差合計 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|---:|
| v6 vs Edax lv10(T169、参考) | 26 | 1 | 33 | -133 | -2.22 | -2.5 |
| **v6 vs Edax lv12(本タスク)** | **18** | **1** | **41** | **-364** | **-6.07** | **-8.0** |

lv10からlv12に上げると、平均石差は-2.22石から-6.07石へ約3.85石悪化した(勝率もT169の26/60=43.3%からT174の18/60=30.0%へ低下)。**本タスクは判定を行わないが、この-6.07石という値が今後のlv12ゲートの基準線(物差し)となる。**

## 4. 帯別傾向(序中終盤どこで離されるか)

**算出定義**: 各局について、各フェーズ(`vs_edax.py`の`classify_phase()`定義: `opening`=実手数1〜20、`midgame`=21〜40、`endgame`=41以降)内でエンジン(v6)が着手した最後の手のテレメトリ`discDiff`(その時点でのエンジン視点の石差評価、budgeted推定またはexact確定値)を採り、60局平均・中央値を算出した。`endgame`フェーズの最終値は対局結果(最終石差)にほぼ収束する。

| フェーズ | lv10(T169、参考) 平均discDiff | lv10 中央値 | **lv12(本タスク) 平均discDiff** | **lv12 中央値** |
|---|---:|---:|---:|---:|
| opening(手数1〜20) | -0.331 | +0.435 | **-0.787** | **-1.770** |
| midgame(手数21〜40) | -0.532 | -0.860 | **-2.156** | **-4.530** |
| endgame(手数41〜、≈最終石差) | -2.233 | -3.000 | **-6.067** | **-8.000** |

**傾向**: lv10ではopening→midgameでの悪化が緩やか(-0.33→-0.53)で、endgameで初めて明確に離される(-0.53→-2.23)。**lv12ではopeningの時点で既にlv10のendgame相当に近い劣勢が生じ始め(-0.79)、midgameで大きく引き離され(-2.16、lv10比で約4倍)、endgameでさらに拡大する(-6.07、lv10比で約2.7倍)。** つまりlv12との差は終盤の完全読み力だけでなく、**中盤(midgame)の段階から既に有意に開き始めている**ことが示唆される。序盤(opening、手数20まで)は開幕定石データ由来のため両レベルで大きくは変わらないはずだが、実際にはlv12の方がopening終了時点でもやや劣勢(-0.79 vs -0.33)であり、Edaxのより深い読みが早い段階から手の質に影響している可能性がある(本タスクでは要因分析までは行わない、観測事実の記録のみ)。

## 5. budgeted→exact乖離(T169 verifier申し送り: 算出定義の明記)

**算出定義**(T158d/T162/T166/T169と同一): 各局について、budgeted相番(空き21〜22、時間/ノード予算あり)の**最後の**エンジン着手のテレメトリ`discDiff`と、unlimited-exact相番(空き20以下、完全読み)の**最初の**エンジン着手のテレメトリ`discDiff`の差の絶対値を「乖離」と定義する。この乖離は budgeted推定とexact確定値のズレ幅を表し、乖離が生じた局面自体の空きマス数(通常21〜22→20〜19)も併記する。

| 側 | n | 平均\|乖離\| | 中央値\|乖離\| | 最大\|乖離\| | 最大乖離の開幕/色 | 標準偏差 | fallbackAtTransition | 符号反転 |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| v6 lv10(T169、参考) | 60 | 4.306 | 3.700 | 13.900 | primary-22/white | 3.386 | 3/60 | 4/60 |
| **v6 lv12(本タスク)** | 60 | **4.676** | **3.825** | **17.390** | primary-27/white | 3.809 | 2/60 | 4/60 |

lv12での乖離幅(平均4.68石)はlv10(平均4.31石)よりやや大きいが、明確な質的劣化というほどではない。exactFallback(遷移点1手のみの定義、T158d/T162/T166/T169と同一)はlv10の3/60よりやや少ない2/60。符号反転(budgeted推定とexact確定の符号が異なる局)は両レベルとも4/60で同数、いずれも近接値(budgeted側絶対値最大8.15)からの反転であり劇的な逆転は無い。

## 6. 異常チェック

- クラッシュ: **0件**(stderrログは空)
- 非合法手: **0件**
- 非決定性: fixed-depth決定性回帰(40/40)・node-budget決定性回帰(10/10)ともPASSED

## 7. 生成物

- `bench/edax-compare/t174_lv12_report.md`(本ファイル)/ `t174_lv12_report.meta.json`
- `bench/edax-compare/endgame-results/t174-v6-vs-edax-lv12-{results.json,report.md}`(生ログ+自動生成レポート、gitignore対象でローカルのみ)
- T158d・T162・T166・T169系の成果物は不変のまま。

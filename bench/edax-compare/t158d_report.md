# T158d: 対Edax対局ゲート — 段階2: 60局本実行報告

**本レポートは段階2(全30ペア=候補60局+v4 60局)の結果報告。判定材料の提示までであり、採否の最終裁定はレポートを受けたオーケストレーター+ユーザーが行う(本ワーカーは判定しない)。** 段階1のパイロット報告(`bench/edax-compare/t158d_pilot_report.md`・`.meta.json`)は不変のまま残している。

## 0. 前提の再確認(SHA-256実測 vs manifest、段階2実行直前)

段階1と同じ5点を実行直前に再実測し、manifest(`bench/edax-compare/t158c_screening_report.meta.json` の `deferredT158d` 節)と照合した。**全項目一致**(不一致なし、停止条件に該当せず続行)。

| 対象 | manifest記載SHA-256 | 実測SHA-256 | 一致 |
|---|---|---|---|
| 候補重み(`train/data/t158/full/t158-b3-seed-2.bin`) | `dae9af0b...9c7c5ec` | `dae9af0b...9c7c5ec` | ✓ |
| baseline重み(`train/weights/pattern_v4.bin`) | `c372b833...639e383f` | `c372b833...639e383f` | ✓ |
| Edax実行ファイル | `aabb5ac7...4dc318b322b1` | `aabb5ac7...4dc318b322b1` | ✓ |
| Edax eval.dat | `f8b22996...382a7d90ef21b792` | `f8b22996...382a7d90ef21b792` | ✓ |
| 開幕セット(`openings.json`) | `7a340c17...290be81e2` | `7a340c17...290be81e2` | ✓ |

git commit(段階2実行時点): `4990bb98d23a00f233e6cf411e22131206073e2f`。`git log --oneline 4d7894ae52c6cfa07d19d729129b8feea3464855..HEAD -- engine/` は0件(T158cスクリーニング時点からengine/変更なし)で、eval_cliのSHA-256(`c19f8633ce4f4346ca64a2b5a7c294d4d78e43a9be476de8e923e1056ec3570e`)は候補・v4の両実行・段階1パイロットと完全に一致した。

## 1. 段階1checkpointからのresumeについて(コーディネーター指摘への回答)

**段階2は段階1のcheckpoint(`endgame-results/t158d-candidate-vs-edax-results.json`・`t158d-v4-vs-edax-results.json`、各6局)から`vs_edax.py`の`try_resume()`機構で直接続きを再開する形では実行しなかった。** 理由:

- `vs_edax.py`のresume機構は、保存済みJSONの`runKey`(=`settings`辞書をJSON文字列化したもの、`opening_count`・`opening_limit`を含む)が現在の実行と**完全一致**する場合のみ再開を許可する設計になっている(`ResultsCheckpoint.try_resume()`、`bench/edax-compare/vs_edax.py:1384-1424`)。これは意図的な安全機構で、設定が少しでも変わった実行を誤って混在させないためのもの。
- 段階1のcheckpoint(`opening_count=3, opening_limit=3`)と段階2(`opening_count=30, opening_limit=None`)は`opening_count`/`opening_limit`が異なるため`runKey`が一致せず、そのまま`--results-output`に段階1と同じファイルを指定しても`try_resume()`は「runKey mismatch, starting fresh」を返し、保存済み6局を無視して0局から再計算する(=事実上resumeにならない)。
- この不一致を解消するには`vs_edax.py`をさらに改修して`opening_limit`/`opening_count`を`runKey`から除外する必要があるが、そうすると`vs_edax.py`自体のSHA-256(`harnessSha256`、`PROVENANCE_IDENTITY_KEYS`の一つ)が変わり、**その改修自体が段階1checkpointの`harnessSha256`と不一致になって`try_resume()`のprovenanceチェックで拒否される**(`bench/edax-compare/vs_edax.py:1398-1410`)。つまりharnessを変更する限り、どのみち段階1のcheckpointをそのまま再開はできない。改修+checkpoint再スタンプ(既存の`migrate_t114_exact_threshold_20.py`等と同種のマイグレーション)という手段もあるが、リスク(新規バグ混入)とコスト(実装+検証)が、浮く時間(3ペア分の再計算、後述のとおり実測で1台あたり約170秒)に見合わないと判断した。
- そのため、**段階1と完全同一のコマンド(`--opening-limit`を外すのみ)を新しい出力ファイルに対して実行し、`--opening-set primary`(30開幕全件)を最初から計算させた**。これにより先頭3開幕(primary-01〜03)は段階1のパイロットと重複して再計算されるが、エンジンは決定的(fixed-depth/node-budget決定性回帰が候補・v4とも全実行でPASSED)であるため、無駄な計算にはなるが結果が変わることはない。実測でも下記2節のとおり完全に同じ値が再現されており、この判断の妥当性を裏付けている。
- 出力ファイル名は段階1のパイロット成果物(`t158d-candidate-vs-edax-results.json`・`t158d-v4-vs-edax-results.json`、`t158d_pilot_report.md`が参照・記述している6局のデータ)を上書きしないよう、`-full`サフィックスを付けた新規ファイル(`t158d-candidate-vs-edax-results-full.json`・`t158d-v4-vs-edax-results-full.json`、各`-report-full.md`)に出力した。これにより段階1パイロット成果物は一切変更されず(受け入れ基準4)、段階2の全60局データも別途完全な形で保存される。
- 実測コスト: 3開幕(6局)の重複再計算は候補側で約80秒、v4側で約85秒(1局あたり平均13〜14秒 x 6局)。60局全体の実行時間(候補789秒+v4 816秒 ≒ 27.4分)の中では無視できる規模(全体の約6%)であり、resumeを実現するための追加改修・検証コストの方が明らかに大きい。
- **1局単位のchekcpoint・中断時resumeという長時間実行ルールの要件自体は、段階2の各実行(30開幕・60局の1回の起動)の内部では引き続き有効**(段階1と同一のcheckpoint機構を使っており、もし段階2実行中にプロセスが中断していれば、同一コマンドの再実行で完了済み局のみをskipして続きから再開できたはずである。段階1のインタラプト実地テストで検証済みの機構と同一)。今回は候補・v4とも中断なく一度で60/60完走したため、段階2内での実地中断テストは発生しなかった。

### パイロット6局と本実行の対応関係(決定性の傍証)

段階1パイロット(3開幕・6局)と段階2本実行の先頭6局(同一開幕・同一色・同一重み)を突き合わせたところ、**候補・v4とも全6局が石差・手数まで完全一致**した。

| opening/色 | 候補(パイロット) | 候補(本実行1〜6局目) | v4(パイロット) | v4(本実行1〜6局目) |
|---|---:|---:|---:|---:|
| primary-01/black | -18(49手) | -18(49手) | -36(49手) | -36(49手) |
| primary-01/white | -18(49手) | -18(49手) | -22(49手) | -22(49手) |
| primary-02/black | -38(50手) | -38(50手) | -44(50手) | -44(50手) |
| primary-02/white | -16(50手) | -16(50手) | -8(50手) | -8(50手) |
| primary-03/black | -32(49手) | -32(49手) | -32(49手) | -32(49手) |
| primary-03/white | +20(49手) | +20(49手) | -6(49手) | -6(49手) |

完全一致(120/120フィールド)。これはエンジン・ハーネスの決定性の直接的な傍証であり、上記「resumeせず全30開幕を再計算した」判断が結果の信頼性を損なわないことを裏付ける。

## 2. 対局条件(段階1・T125と同一)

- `engine_depth=12, engine_exact_from_empties=16, engine_exact_quota_percent=60, engine_max_nodes=160000, engine_time_ms=1500, engine_tt_mb=64, unlimited_exact_empties=20`
- `engine_modes=["single-root"]`、Edaxレベル10、`--opening-set primary`(30開幕、`--opening-limit`なし=全件)
- 実行(候補→v4の順で逐次、並行実行せず):

```
python bench/edax-compare/vs_edax.py --opening-set primary \
  --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 \
  --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 \
  --unlimited-exact-empties 20 --engine-tt-mb 64 \
  --weights <候補train/data/t158/full/t158-b3-seed-2.bin または v4 train/weights/pattern_v4.bin> \
  --skip-loss-analysis \
  --results-output bench/edax-compare/endgame-results/t158d-<candidate|v4>-vs-edax-results-full.json \
  --report-output bench/edax-compare/endgame-results/t158d-<candidate|v4>-vs-edax-report-full.md
```

## 3. 結果(60局 x 2重み = 120局)

| 構成 | 勝 | 分 | 敗 | 石差合計 | 平均石差 | 中央値 |
|---|---:|---:|---:|---:|---:|---:|
| 候補(B3 seed2) | 9 | 1 | 50 | -1360 | -22.67 | -22 |
| v4(baseline) | 4 | 2 | 54 | -1447 | -24.12 | -24 |

(参考: T125本番採用ゲートのv4 60局は4勝2分54敗・平均-24.02(エンジンバイナリはT125時点のものでSHAが異なる)。本実行のv4平均-24.12はほぼ同水準で、Edaxレベル10に対する大まかな実力感は連続している。)

異常(クラッシュ・非合法手・非決定性)は**候補・v4とも0件**(stderrログ空、fixed-depth決定性回帰40/40・node-budget決定性回帰10/10がともにPASSED)。実測総所要時間は候補789.2秒(平均13.15秒/局)+v4 816.0秒(平均13.60秒/局)、プロセス起動〜レポート書き出しの実測合計は候補約808秒+v4約833秒=**約27.4分**(段階1見積りの約29分とほぼ一致)。

## 4. 開幕(opening)単位の平均石差とペア差分(30ペア)

各開幕について候補・v4それぞれ黒白2局の石差を平均し、その30個の対応差(候補-v4)を求めた(T121/T125と同一の集計方法)。

| opening | 候補平均石差 | v4平均石差 | 差分(候補-v4) |
|---|---:|---:|---:|
| primary-01 | -18.00 | -29.00 | +11.00 |
| primary-02 | -27.00 | -26.00 | -1.00 |
| primary-03 | -6.00 | -19.00 | +13.00 |
| primary-04 | -22.00 | -26.00 | +4.00 |
| primary-05 | -38.50 | -33.00 | -5.50 |
| primary-06 | -23.00 | -24.00 | +1.00 |
| primary-07 | -23.00 | -20.00 | -3.00 |
| primary-08 | -23.00 | -34.00 | +11.00 |
| primary-09 | -18.00 | -23.50 | +5.50 |
| primary-10 | -18.00 | -18.00 | +0.00 |
| primary-11 | -23.00 | -15.00 | -8.00 |
| primary-12 | -40.00 | -29.00 | -11.00 |
| primary-13 | -36.00 | -38.00 | +2.00 |
| primary-14 | -20.00 | -13.00 | -7.00 |
| primary-15 | -29.00 | -38.00 | +9.00 |
| primary-16 | -26.00 | -27.00 | +1.00 |
| primary-17 | -8.00 | -17.00 | +9.00 |
| primary-18 | -21.00 | -7.00 | -14.00 |
| primary-19 | -3.00 | -19.00 | +16.00 |
| primary-20 | -19.00 | -14.00 | -5.00 |
| primary-21 | -22.00 | -44.00 | +22.00 |
| primary-22 | -15.00 | -16.00 | +1.00 |
| primary-23 | -21.00 | -14.00 | -7.00 |
| primary-24 | -26.00 | -40.00 | +14.00 |
| primary-25 | -23.00 | -26.00 | +3.00 |
| primary-26 | -21.00 | -14.00 | -7.00 |
| primary-27 | -44.00 | -39.00 | -5.00 |
| primary-28 | -17.00 | -21.00 | +4.00 |
| primary-29 | -26.00 | -26.00 | +0.00 |
| primary-30 | -23.50 | -14.00 | -9.50 |
| **平均差** | -- | -- | **+1.45** |

## 5. 統計判定材料(採否は判定しない)

### 5.1 開幕単位(n=30、T121/T125と同一手法)

- **平均差(候補-v4): +1.45石**(候補がわずかに優勢な方向)
- **paired bootstrap 95%CI**: `[-1.5667, +4.6000]`(seed=158004、100,000標本、percentile法。アルゴリズムは`compare_pattern_v3.py`の`paired_bootstrap()`と同一: `random.Random(seed)`で差分配列から重複ありでresample、各標本の平均をとり100,000回、2.5/97.5パーセンタイルを取る)
- CIは0を跨ぐため**「有意な改善」とは判定できない**(manifestの採用規準「有意または実用的に意味のある改善がなければv4維持」に対する事実として記載)
- 開幕単位で改善16・悪化12・同値2
- **符号検定(exact two-sided binomial, p=0.5, 同値2件を除くn=28、改善16件)**: p値 = **0.5716**(有意水準0.05を大きく上回り、有意差なし)

### 5.2 局単位(n=60、補足)

- 平均差(候補-v4): +1.45石(開幕単位と同値、線形性から当然の一致)
- paired bootstrap 95%CI(seed=158005、100,000標本): `[-1.8000, +4.7667]`
- 改善28・悪化27・同値5、符号検定(n=55、改善28件)p値 = **1.0000**(ほぼ完全に五分)

### 5.3 解釈(判定材料の提示、裁定はしない)

候補(B3 seed2)はv4よりわずかに良い点推定(+1.45石/局)を示すが、開幕単位・局単位いずれのCIも0を跨ぎ、符号検定もp値が高く(0.57・1.00)、**統計的に有意な改善があるとは言えない**。実戦点推定・統計検定の両面から見て、manifestの事前登録規準(「有意または実用的に意味のある改善がなければv4維持」)に照らすと、本実行の事実だけからは改善の証拠は弱い。ただしCIの幅は広く(約6.2石)、実用的に意味のある改善(例: +3〜5石程度)の可能性を統計的に排除できているわけでもない。**最終的な採否判断はこのレポートを受けたオーケストレーター+ユーザーが行う。**

## 6. Watch-point定量集計(120局全体)

### 6.1 (a) budgeted→exact乖離の分布(空き21〜22の予算内推定 → 空き20/19の完全読み確定値)

パイロット(n=3ペア)では候補側の最大乖離(21.17石)がv4側(5.32石)よりはっきり大きい非対称が見られたが、**60局全体で見るとこの非対称は再現しなかった**。

| 側 | n | 平均\|乖離\| | 中央値\|乖離\| | 最大\|乖離\| | 最大乖離の開幕/色 | 標準偏差 | exactFallback発生数 |
|---|---:|---:|---:|---:|---|---:|---:|
| 候補 | 60 | 6.609 | 5.470 | 21.170 | primary-02/black | 5.360 | 0/60 |
| v4 | 60 | 5.139 | 3.795 | **32.440** | primary-15/white | 5.383 | 9/60 |

- 候補の最大乖離は依然としてprimary-02/black(パイロットと同一開幕、-16.83→-38.00、21.17石)で、パイロットの値をそのまま再現した(決定性どおり)。
- しかし**v4側の最大乖離は60局全体ではprimary-15/white(-1.56→-34.00、32.44石)であり、候補の最大(21.17石)より大きい**。パイロットの3ペアだけではv4側にこの種の大きな乖離が偶然含まれていなかったため、非対称に見えていたに過ぎない(小標本の偏り)。
- 平均\|乖離\|は候補6.61石・v4 5.14石で候補がやや高いが、標準偏差(候補5.36・v45.38)を考えると重なりが大きく、明確な傾向とまでは言えない。
- **exactFallback(空き22での完全読み予算内試行が完了せずbudgeted評価にフォールバックする挙動)の発生数は候補0/60、v4 9/60と、パイロットで見えた傾向(候補0/6、v4 2/6)がそのまま拡大再現された。** これは`exactQuotaPercent`機構の想定内の挙動(異常ではない)だが、候補側の評価が(理由は未調査だが)v4よりこの空き22地点での完全読みが早く完了する傾向を示しており、今後の性能・探索効率の観察対象として申し送る。

### 6.2 (b) 空き19前後での候補側の石差急落(符号反転)の有無

budgeted推定と完全読み確定値の符号が反転した局(=「見た目の優勢/劣勢が完全読みで覆った」局)を集計した。

- **候補: 4/60局で符号反転**(primary-16/white、primary-19/white、primary-15/white、primary-26/white)。反転前のbudgeted値はいずれも小さい(最大+9.82)近接値で、「大きく勝っていたのに完全読みで大敗」というような劇的な反転は無かった。
- **v4: 4/60局で符号反転**(primary-19/white、primary-11/white、primary-14/black、primary-22/white)。候補と同じく反転前の値はいずれも小さい近接値(最大+1.58)。
- **候補・v4で符号反転の件数は同数(4/60)であり、候補固有の異常な悪手・急落パターンは確認されなかった。** いずれも空き21近傍のbudgeted推定が0近傍で不安定であることに起因する一般的な現象と考えられる(プロトコル全体の特性であり、候補固有の欠陥ではない)。

## 7. 生成物

- `bench/edax-compare/t158d_report.md`(本ファイル)/ `t158d_report.meta.json`
- `bench/edax-compare/endgame-results/t158d-candidate-vs-edax-results-full.json` / `t158d-candidate-vs-edax-report-full.md`(候補60局、生ログ+自動生成レポート)
- `bench/edax-compare/endgame-results/t158d-v4-vs-edax-results-full.json` / `t158d-v4-vs-edax-report-full.md`(v4 60局、同上)
- 段階1のパイロット成果物(`t158d_pilot_report.md`・`.meta.json`、`t158d-candidate-vs-edax-results.json`、`t158d-v4-vs-edax-results.json`)は不変のまま。

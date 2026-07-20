---
id: T158d
title: 評価特徴追加(4/4): 対Edax対局ゲート — 段階1: パイロット6局(3ペア)/段階2: 60局本実行
status: done # 段階2verifier合格(全統計・watch-point・SHA・決定性を独立再現、指摘=軽微1件のみ)。最終裁定(2026-07-21): ペア差+1.45石・CI[-1.57,+4.60]・p=0.57=有意差なし → 事前登録規準により**B3 seed2不採用、現行v4維持**。codex-review省略(段階2のコミットはレポート2件のみ、vs_edax.py改修は段階1でverifier差分確認済みの+20/-1行)
assignee: implementer
attempts: 0
---

# T158d: 対Edax対局ゲート(段階1: パイロット)

## 目的

T158シリーズ最終段。スクリーニング通過済みの候補重み **B3 seed2** が、本番v4重みより実対局で強いか(少なくとも悪化しないか)を対Edax pairedゲートで判定する。本来は30ペア=60局だが、**ユーザー指示(2026-07-21)によりまず小規模パイロットを実行して所要時間と傾向を評価する**。本タスクは段階1(パイロットのみ)。60局本実行は結果を見てユーザーが判断する。

## 前提(すべて確定済み・変更禁止)

manifest: `bench/edax-compare/t158c_screening_report.meta.json` の `deferredT158d` 節。

- 候補重み: `train/data/t158/full/t158-b3-seed-2.bin`(SHA-256 `dae9af0b4d9e3322c6e2181071b095bca1f2272e69ba85d0e828f21e29c7c5ec`)— gitignore領域。実行前にSHA-256を実測しmanifestと一致確認(不一致なら即停止・報告)
- baseline重み: `train/weights/pattern_v4.bin`(SHA-256 `c372b833...639e383f`、同様に実測確認)
- 開幕セット: manifestの `openingSetSha256` が指すprimaryセット(30ペア)。**パイロットは先頭3ペア=3開幕×色交換=6局**
- 対局プロトコル: manifestの `protocol` 節(160,000ノード・1500ms・exactFromEmpties 16・quota60%・空き20以下無制限・depth12・TT 64MiB)
- Edax: manifestの `edax` 節(実行ファイル・eval.datのSHA-256を実測確認)。レベル等の対局条件は過去の本番採用ゲート(T125、`bench/edax-compare/endgame-results/t125-vs-edax-results.json` とそのレポート)と同一にし、採用した条件を根拠(T125メタの該当値)付きでレポートに明記する
- ハーネス: 既存の `bench/edax-compare/vs_edax.py` を使う(新規ハーネスを書かない)。パイロット局数の制限・checkpoint対応のための最小限の改修は可(既存の挙動・既存結果ファイルは不変)

## 要件

1. **paired構成**: 各開幕ペアについて「候補 vs Edax」「v4 vs Edax」を同一開幕・同一色割当で対局し、ペア単位の石差を比較する。パイロットは3ペア → 候補6局+v4 6局=計12局。
   - v4側について、T125等の過去結果の再利用は**開幕・プロトコル・Edax設定がSHA/メタで機械的に完全一致すると確認できる場合のみ**可(その場合は根拠をレポートに記載し、対局は候補6局のみでよい)。一致確認できなければ両方走らせる。
2. **長時間実行ルール**: 1局終了ごとにatomic checkpoint(JSON追記/置換)・resume対応・進捗ログ(何局目/経過時間/直近結果)。実行はPowerShell `Start-Process` detached+ツール呼び出しポーリング(**Bash run_in_background・Monitor通知依存は禁止**=不達実績あり)。
3. **時間計測**: 1局ごとの所要時間(wall clock)を記録し、**60局(+必要ならv4側60局)本実行の所要時間見積り**をレポートに書く(ユーザーの本実行判断材料)。
4. **レポート**: `bench/edax-compare/t158d_pilot_report.md`(+`.meta.json`)。内容: 6局(または12局)の結果表(開幕・色・石差・勝敗・所要時間)/候補vs v4のペア差分/異常(クラッシュ・非法手・非決定)の有無/60局見積り/**判定はしない**(パイロットは情報収集であり、n=3ペアで強弱の結論を出さない旨を明記)。
5. 検証watch-point(レビュー申し送り): 空き19前後(終盤入口)で候補側に不審な悪手・石差急落がないか、局ごとの棋譜/石差推移で定性確認しレポートに一言書く。

## スコープ外

- ~~60局本実行~~(段階2としてユーザー承認済み 2026-07-21)
- 採否の最終裁定・本番採用・重みの`train/weights/`への配置(段階2レポートを受けてオーケストレーター+ユーザーが裁定。採用時の本番配線は別タスク)
- engine/trainコードの変更

## 段階2: 60局本実行(2026-07-21 ユーザー承認「すすめて」)

### 要件(段階2)

1. **実行**: 段階1のcheckpointからresumeし、候補側・v4側それぞれ残り27ペア(54局)を**逐次**実行(並行禁止=wall-clock汚染防止)。前提・プロトコル・コマンドは段階1と完全同一(`--opening-limit`を外す以外の変更禁止。SHA再実測・manifest照合を実行前に再度行う)。1局ごとcheckpoint・進捗ログ・Start-Process detached+ポーリング(段階1と同じ規律)。
2. **統計判定**: 全30ペア(候補60局・v4 60局)で以下を算出しレポートに記載:
   - 勝敗・平均石差(両側)、ペア単位石差差分の平均と95%CI(paired bootstrap、決定的seed・10万回、T121/T125の前例に倣う)、符号検定
   - **事前登録の採用規準(manifest adoptionRule)**: 「有意または実用的に意味のある改善がなければ現行v4維持」。レポートはこの規準に対する事実(CI・p値・効果量)を記載する。**最終裁定はレポートを受けたオーケストレーター+ユーザーが行う**(ワーカーは判定材料の提示まで)
3. **watch-point**: (a)候補のbudgeted→exact乖離の非対称(パイロットで最大21.17石 vs v4 5.32石)が60局でも再現するか定量集計(乖離の分布・平均・最大) (b)空き19前後での候補側の不審な石差急落の有無
4. **レポート**: `bench/edax-compare/t158d_report.md`(+`.meta.json`)。パイロット報告(t158d_pilot_report.md)は不変のまま残す。全60+60局の結果表・ペア差分表・統計・watch-point集計・SHA検証・所要時間。

### 受け入れ基準(段階2)

1. 候補60局+v4 60局が全局完走し(段階1の6+6局を含む)、レポート+metaに結果表・ペア統計(bootstrap CI・符号検定)・watch-point集計・SHA検証結果がある
2. 異常(クラッシュ・非法手・非決定性)0件(発生時は停止して報告)
3. 統計はレポートのmetaから決定的に再現可能(seed・手順の記録)
4. 既存ファイル(t157系・t158a/b/c成果物・T125結果・t158d_pilot_report系)の値を変更していない
5. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(成果物はパス明示でadd・コミット。`git add .`/`-A`禁止。`tasks/`とCLAUDE.mdはコミットしない)

## 受け入れ基準(段階1、達成済み)

1. パイロット全局が完走し、レポート+metaに結果表・時間見積り・SHA検証結果(候補/baseline/Edax/開幕セット)がある
2. checkpoint/resumeが実装され、中断→再開の実地確認(1回でよい)がレポートに記録されている
3. 異常(クラッシュ・非法手・非決定性)0件(発生時は停止して報告)
4. 既存ファイル(t157系・t158a/b/c成果物・T125結果)の値を変更していない
5. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(成果物はコミット対象、コミットは自分で行いパスを明示してadd。`git add .`/`-A`禁止。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装完了(implementer)

1. **前提SHA-256実測**: `t158c_screening_report.meta.json`の`deferredT158d`節と、候補重み(`train/data/t158/full/t158-b3-seed-2.bin`)・baseline重み(`train/weights/pattern_v4.bin`)・Edax実行ファイル・`eval.dat`・`openings.json`の5点をすべて`certutil -hashfile`で実測し、manifest記載値と完全一致を確認(不一致なし、停止条件に該当せず続行)。
2. **T125再利用可否の検証**: `endgame-results/t125-vs-edax-results.json`のmeta/runKeyを確認。開幕セットSHA・Edax実行ファイルSHA・eval.dat SHA・v4重みSHA・プロトコルパラメータは一致したが、**gitCommit・evalCliSha256(エンジンバイナリ)が不一致**。`git log --oneline ed22fd27b9..HEAD -- engine/`でT125以降に10件のengine/変更コミットがあることを確認し、「機械的完全一致」不成立と判定 → 要件どおりv4側も新規に6局を実行することにした(候補6局のみでは済まさなかった)。
3. **ハーネス改修**: `bench/edax-compare/vs_edax.py`に`--opening-limit N`(既定None、対局(match play)のopeningを先頭N件に制限、fixed-depth/node-budget決定性チェックには不影響、settingsに記録)と、各対局の`wallClockSec`(壁時計所要時間、進捗print行にも表示)を追加。既存呼び出しの挙動は不変(自己テスト`--self-test-checkpoint`で確認)。コミット`04dd37a8`(vs_edax.py単体、`git add`はパス明示)。
4. **候補パイロット実行**: `--opening-set primary --opening-limit 3 --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64 --weights train/data/t158/full/t158-b3-seed-2.bin --skip-loss-analysis`をPowerShell `Start-Process`でdetached起動、ログ/checkpointをポーリングして完走確認(fixed-depth 40/40 PASSED、node-budget 10/10 PASSED、6局完走、所要95秒)。結果: 1勝5敗、平均石差-17.00。
5. **v4パイロット実行**: 同条件で`--weights train/weights/pattern_v4.bin`のみ変更して逐次実行(候補実行完了後に開始、CPU競合回避のため並行実行せず)。fixed-depth/node-budget決定性ともPASSED、6局完走、所要104秒。結果: 0勝6敗、平均石差-24.67。
6. **中断→再開の実地確認**: scratchpad上で候補重み・1開幕(2局計画)の別実行を用意し、1局完了後に`Stop-Process -Force`で強制終了 → 結果ファイルに1局のみ永続化されていることを確認 → 同一コマンドで再実行し`[resume] loaded 1 already-completed game(s)`・fixed-depth/node-budget決定性チェックのスキップ・2局目のみの新規対局・最終2/2完走(1局目の値が中断前と不変)を確認。PASSED。
7. **watch-point定性確認**: 12局全ての空き16〜22区間の`discDiff`推移を確認。空き20到達で完全読みに切り替わり最終石差に収束する想定どおりの挙動。候補固有の不審な悪手・石差急落は確認されず(唯一の大きい乖離局面はv4側も同開幕で敗北しており開幕自体の不利と判断)。
8. **60局本実行の所要時間見積り**: 候補6局80.4秒(平均13.39秒/局)、v4 6局89.6秒(平均14.93秒/局)、固定オーバーヘッド約14〜15秒/実行から、60局本実行は候補側約818秒(13.6分)+v4側約911秒(15.2分)=**合計約29分(逐次実行)**と見積もり、安全側30〜45分を推奨する旨をレポートに明記。両実行の逐次実行の必要性(wall-clock時間予算の並行実行によるCPU競合汚染リスク)も明記。
9. **レポート作成**: `bench/edax-compare/t158d_pilot_report.md`・`.meta.json`を作成。判定は行わず(要件どおり)、n=3ペアでは結論を出さない旨を明記。
10. **コミット**: `bench/edax-compare/vs_edax.py`(コミット`04dd37a8`)と`bench/edax-compare/t158d_pilot_report.md`+`.meta.json`(コミット`ec411a3`)を別々に、パス明示で`git add`しコミット(`git add .`/`-A`は使用せず)。生の対局ログ(`bench/edax-compare/endgame-results/t158d-candidate-vs-edax-results.json`等)は既存の`.gitignore`ルール(T098由来、`bench/edax-compare/endgame-results/`全体を除外、報告用の`-report.md`のみ個別に過去force-add済み)に従いローカルのみとし、force-addしなかった(T107/T108/T121/T125の前例と同じ扱い)。
11. **受け入れ基準確認**: 完了時点で`git status --short`はクリーン(`tasks/`配下の本ファイル編集分を除く)。`tasks/`・`CLAUDE.md`はコミットしていない(オーケストレーター担当のため)。

実行コマンド・結果の詳細・SHA-256全文は`bench/edax-compare/t158d_pilot_report.md`・`.meta.json`を参照。

### 2026-07-21 verifier検収後の修正(implementer)

verifier合格後、コーディネーターより「セクション5(watch-point定性確認)の数値取り違え」の指摘を受けた。生JSON(`endgame-results/t158d-candidate-vs-edax-results.json`・`t158d-v4-vs-edax-results.json`)からbudgeted→exact乖離を全12局について再計算し確認した:

- 候補側の実際の最大乖離: **primary-02/black、空き22で-16.83→空き20で-38.00、乖離21.17石**(初版の「候補側最大約7石(primary-01/black)」は誤り。指摘どおり初版の約3倍)。
- 同一開幕(primary-02/black)でのv4側乖離は3.79石(初版の「v4側最大約4石(primary-01/black: -35.74→-36)」は誤り。この局は`exactFallback=true`で実際の乖離は0.26石)。
- 追加確認: v4自身の全6局中の最大乖離は実際にはprimary-03/white(5.32石)であり、primary-02/blackの3.79石はv4の最大値ではない。候補側最大(21.17石)はv4自身の最大(5.32石)と比べても約4倍大きい。候補6局の乖離絶対値平均は約9.7石、v4は約1.9石。
- `bench/edax-compare/t158d_pilot_report.md`のセクション5・8を上記の正しい数値・開幕対応に書き直し、候補側の乖離幅がv4よりはっきり大きいという非対称(初版で見落としていた点)を60局本実行の重点観察項目として明記した。結論の骨子(勝敗自体はv4も同局面で敗北しており候補固有の逆転負けではない)は維持。
- `t158d_pilot_report.meta.json`の`watchPointEmpties19.finding`は元々primary-02/black(-16.83→-38)を正しく記載しており誤記がなかったため変更なし。修正後の`.md`と矛盾しないことを確認した。
- 修正版をコミット`13c2e32`(`bench/edax-compare/t158d_pilot_report.md`のみ、パス明示でadd)。

### 2026-07-21 段階2(60局本実行、ユーザー承認「すすめて」)実施(implementer)

1. **前提再確認**: 段階2実行直前にSHA-256 5点(候補重み・v4重み・Edax実行ファイル・eval.dat・openings.json)を再実測し、manifest記載値と完全一致を確認(不一致なし)。gitコミットは`4990bb98d`で、`git log 4d7894ae5..HEAD -- engine/`は0件(T158cスクリーニング時点からengine/変更なし)。
2. **段階1checkpointからの直接resumeを断念**: `vs_edax.py`の`ResultsCheckpoint.try_resume()`は`runKey`(settings辞書、`opening_count`/`opening_limit`を含む)の完全一致を要求する設計であり、段階1(opening_count=3)と段階2(opening_count=30)ではrunKeyが一致せずresumeが機能しない。これを解消するにはharness改修が必要だが、改修自体が`harnessSha256`(provenance identity key)を変えて段階1checkpointとの互換性チェックを別途破壊するため、マイグレーション相当の追加実装が必要になる。浮く時間(3ペア分の再計算、実測で候補80.4秒+v4 89.6秒 ≒ 合計170秒、60局全体の約6%)に見合わないと判断し、**改修せずに段階1と完全同一のコマンド(`--opening-limit`を外すのみ)を新規ファイル(`*-full.json`/`*-full.md`)に対して実行**した(段階1のパイロット成果物は上書きせず不変のまま維持)。この判断根拠と代替検証(後述の決定性突合)をレポート・作業ログに明記。
3. **候補60局実行**: PowerShell `Start-Process`でdetached起動(04:05:25開始)、ツール呼び出しでのポーリング(結果JSONの`games`件数・ログ末尾・プロセス生存を確認、Monitor通知には依存しない)で進捗確認。04:18:53完走、60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。結果: 9勝1分50敗、平均石差-22.67。
4. **v4 60局実行**: 候補完了後に逐次開始(04:19:15、CPU競合回避のため並行実行せず)。04:33:08完走、60/60局、決定性チェックともPASSED、stderr空。結果: 4勝2分54敗、平均石差-24.12。
5. **決定性の代替検証**: 段階1パイロットの6局(候補・v4各3開幕分)と、段階2本実行の先頭6局(同一開幕・同一色)を突き合わせ、**石差・手数まで完全一致(120/120フィールド)**することを確認。段階1checkpointを直接resumeしなかった判断が結果の信頼性に影響しないことの根拠とした。
6. **統計算出**(全て独立に再計算・照合済み): 開幕単位(n=30、T121/T125と同一手法=候補・v4それぞれ黒白2局の平均を開幕ごとに求め対応差をとる)で平均差+1.45石、改善16/悪化12/同値2、paired bootstrap 95%CI [-1.5667, +4.6000](seed=158004、100,000標本、`compare_pattern_v3.py`の`paired_bootstrap()`と同一アルゴリズム)、符号検定(exact two-sided binomial、n=28非タイ、改善16)p=0.5716。局単位(n=60、補足)は平均差+1.45石(線形性により開幕単位と一致)、CI[-1.8000,+4.7667](seed=158005)、符号検定(n=55、改善28)p=1.0000。いずれも有意差なし。manifestの採用規準に対する事実として提示し、採否判定はしない。
7. **watch-point定量集計**: (a)budgeted→exact乖離(120局全体) — パイロットで見えた非対称(候補最大21.17石 vs v4最大5.32石)は**60局全体では再現せず**、v4側の真の最大乖離はprimary-15/white(32.44石)で候補の最大(21.17石)より大きいと判明(小標本の偏りだったと結論)。exactFallback発生数は候補0/60・v4 9/60とパイロットの傾向(候補0/6・v4 2/6)がそのまま拡大再現。(b)符号反転(budgeted推定と完全読みの符号が異なる局) — 候補4/60・v4 4/60で同数、いずれも近接値からの反転で劇的な逆転はなく、候補固有の異常は確認されず。
8. **異常チェック**: クラッシュ・非合法手・非決定性いずれも0件(候補・v4とも)。
9. **レポート作成**: `bench/edax-compare/t158d_report.md`・`.meta.json`を新規作成。段階1のパイロット報告・生ログは一切変更していないことを確認(`git status --short`・`git diff --stat`で無差分を確認)。
10. **コミット**: `bench/edax-compare/t158d_report.md`+`.meta.json`をコミット`cc88739`(パス明示でadd、`git add .`/`-A`は使用せず)。生の対局ログ(`t158d-*-full.json`等)は既存の`.gitignore`ルール(T098由来)によりローカルのみ。
11. **受け入れ基準確認**: 候補60局+v4 60局完走(段階1の6+6局を含む、決定性突合で保証)、統計はmetaにseed・アルゴリズムを記録し決定的に再現可能、既存ファイル(t157系・t158a/b/c・T125・t158d_pilot_report系)は無変更、`git status --short`はタスクファイル編集分を除きクリーン。

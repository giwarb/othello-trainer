---
id: T162
title: v3 vs v4 の対局再対決(対Edax 60局paired) — 実行時間昇順キューの1番
status: review # 完走(v3側60局のみ、v4はT158d再利用をSHA一致で正当化): v3 3勝3分54敗-21.20 vs v4 4勝2分54敗-24.12、ペア差+2.92石(v3方向)・CI[-2.13,+7.97]・p=0.26=有意差なし。verifier検収中
assignee: implementer
attempts: 0
---

# T162: v3 vs v4 対局再対決

## 目的

T157でoracle regretの微差判定が信用できないと確定した(v4採用時の根拠だった対v2優位0.46石は180局面でほぼ消失)ため、**現本番v4が旧本番v3より実対局で本当に優れているか(少なくとも劣らないか)を対局ゲートで確認する**。ユーザー裁定(2026-07-21)の実行時間昇順キューの1番(15〜30分)。

## 前提

- v3重み: `train/weights/pattern_v3.bin`(旧本番、T121/T122で採用されT147でv4に交代)。実行前にSHA-256を実測記録
- v4重み: `train/weights/pattern_v4.bin`(SHA-256 `c372b833...639e383f`、実測照合)
- プロトコル・開幕・Edax設定: **T158dと完全同一**(bench/edax-compare/t158c_screening_report.meta.json の deferredT158d 節のprotocol/edax、primary 30ペア)
- ハーネス: `bench/edax-compare/vs_edax.py`(T158d時点のまま。変更禁止)

## 要件

1. **v4側の再利用判定**: T158dの `bench/edax-compare/endgame-results/t158d-v4-vs-edax-results-full.json`(60局、2026-07-21 04時台実行)が再利用できるか機械的に確認する: 開幕セットSHA・Edax実SHA・eval.dat SHA・v4重みSHA・プロトコル全パラメータ・**engineバイナリ(evalCliSha256)** の完全一致。T158d以降engine/は未変更のはずなので、現HEADでリビルドしたeval_cliのSHAがt158d metaのevalCliSha256と一致すれば再利用可(根拠をレポートに記載)。一致しなければv4側も新規60局を実行。
2. **v3側60局の実行**: `--weights train/weights/pattern_v3.bin` でT158dと同一コマンド(60局、逐次・専有、1局ごとcheckpoint、Start-Process detached+ツール呼び出しポーリング。Monitor通知依存禁止)。
3. **統計**: T158dと同一手法 — 開幕単位n=30のpaired比較(v3−v4)、平均差・paired bootstrap 95%CI(決定的seed・10万回)・符号検定。局単位n=60も補足。**判定材料の提示まで**(裁定はオーケストレーター+ユーザー)。
4. **レポート**: `bench/edax-compare/t162_rematch_report.md`(+`.meta.json`)。結果表・ペア差分・統計・SHA検証・v4再利用の根拠(または新規実行の理由)・所要時間。
5. exactFallback集計を報告する場合は集計定義(遷移点限定か、1回以上か)をレポートに明記する(T158d verifier申し送り)。

## スコープ外

- 本番重みの変更(結果はv4維持/v3復帰の判断材料。裁定は別途)
- vs_edax.py・engine・trainの変更

## 受け入れ基準

1. v3側60局完走(+v4側は再利用根拠または新規60局)、レポート+metaに結果表・paired統計・SHA検証がある
2. 異常(クラッシュ・非法手・非決定性)0件
3. 統計はmetaから決定的に再現可能
4. 既存ファイル(t158d系・T125系ほか)の値を変更していない
5. 完了時 `git status --short` に当該タスク由来の差分・未追跡が残っていない(レポートはパス明示でadd・コミット。生ログはgitignore済みのendgame-results/に置きローカルのみ。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 対局計測は専有状態で(他の重い処理と並行しない)。作業ログはタスクファイルへ節目ごとに追記

## 作業ログ

### 2026-07-21 実装完了(implementer)

1. **前提確認**: worktreeクリーン、現HEAD `91cc1af55d`。`git log 4990bb98d..HEAD -- engine/`は0件(T158d段階2実行時からengine/無変更)。
2. **v4側再利用の機械判定**: `cargo build --release -p engine --bin eval_cli`で現HEADのeval_cliを再ビルドし、SHA-256(`c19f8633ce4f4346ca64a2b5a7c294d4d78e43a9be476de8e923e1056ec3570e`)がT158d段階2のv4実行時と完全一致することを確認。開幕セットSHA・Edax実行ファイルSHA・eval.dat SHA・v4重みSHA・プロトコル全パラメータもすべて一致。**判定: 再利用可**。`bench/edax-compare/endgame-results/t158d-v4-vs-edax-results-full.json`(60局)をそのまま使用し、v4側の新規実行は行わなかった。
3. **v3重みSHA実測**: `train/weights/pattern_v3.bin` → `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`。
4. **v3側60局実行**: T158dと完全同一のコマンド(`--weights train/weights/pattern_v3.bin`のみ変更)。PowerShell `Start-Process`でdetached起動(05:49:58開始)、ツール呼び出しでのポーリング(結果JSON games件数・ログ末尾・プロセス生存を確認、Monitor通知は使用せず)で進捗確認。06:02:09完走、60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。所要約731秒(約12.2分)。結果: 3勝3分54敗、平均石差-21.20(歴史的なT121/T125のv3結果〈3勝3分54敗、-21.2333〉と勝敗数完全一致・平均石差差0.03石)。
5. **早期終局1件の確認**: v3のgame_id=59(primary-30、黒番)が空き19で終局(黒0石、合法手なし)し、budgeted→exact乖離統計の対象外(exact到達前に終局)と判明。異常(クラッシュ・非合法手)ではなく正当なゲーム終了と判断し、レポートに明記。
6. **統計算出**(独立に再計算・照合済み、0件のtable/数値不一致を確認): 開幕単位(n=30、T121/T125/T158dと同一手法)で平均差(v3-v4)+2.9167石、改善18/悪化11/同値1、paired bootstrap 95%CI[-2.1333,+7.9667](seed=162004、100,000標本、`compare_pattern_v3.py`の`paired_bootstrap()`と同一アルゴリズム)、符号検定(n=29、改善18)p=0.2649。局単位(n=60)は平均差+2.9167石、CI[-1.7667,+7.5667](seed=162005)、符号検定(n=59、改善32)p=0.6029。いずれも有意差なし。
7. **watch-point定量集計**: budgeted→exact乖離(v3 n=59〈1局除外〉平均6.167石・最大15.78石〈primary-01/white〉、v4 n=60平均5.139石・最大32.44石〈primary-15/white、T158d既報〉)。exactFallback集計は**遷移点(unlimited-exact移行直前の1手)のみを対象とする定義**を明記(T158d verifier申し送りへの対応): v3 3/59、v4 9/60(T158d既報)。符号反転はv3 5/59・v4 4/60で近い水準、v3固有の異常なし。
8. **レポート作成**: `bench/edax-compare/t162_rematch_report.md`・`.meta.json`を新規作成。開幕単位テーブル・全統計を生JSONから独立プログラムで再検証し、報告値との0件不一致を確認(手打ち転記による誤りを避けるため、テーブル初稿で1回誤記が発生し即座に生成し直して修正した)。T158d系ファイルは無変更を`git diff --stat`で確認。
9. **コミット**: `bench/edax-compare/t162_rematch_report.md`+`.meta.json`をコミット`d19aedc`(パス明示でadd、`git add .`/`-A`不使用)。生の対局ログ(`t162-v3-vs-edax-*-full.json`等)は既存`.gitignore`ルールによりローカルのみ。
10. **受け入れ基準確認**: v3側60局完走+v4側再利用根拠明記、統計はmetaのseed・アルゴリズム記載で決定的に再現可能、既存ファイル(t158d系・T125系ほか)無変更、`git status --short`はタスクファイル編集分を除きクリーン。

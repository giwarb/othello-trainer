---
id: T162
title: v3 vs v4 の対局再対決(対Edax 60局paired) — 実行時間昇順キューの1番
status: todo
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

(ワーカーが節目ごとに追記)

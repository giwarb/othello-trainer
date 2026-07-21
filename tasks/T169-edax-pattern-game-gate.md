---
id: T169
title: Edax寄せ(2/2): D1候補の対局ゲート(vs 現行本番v5、対Edax 60局paired)
status: done # verifier全項目合格(全統計・時間・重み対応・スポットチェック不一致の実データ確認まで独立再現)。ゲート結果: D1有意勝ち(+4.53石、CI[+1.78,+7.33])→採用提案。**採否はサイズ増(gzip 5.9→10.7MB)のユーザー裁定待ち**(2026-07-21報告済み)。申し送り: budgeted→exact乖離の算出定義をレポートに明記すること(verifier)
assignee: implementer
attempts: 0
---

# T169: D1候補の対局ゲート

## 目的

T168で確定したD1候補(V3+corner5x2、frozen MAE 4.492 vs 現行v5の4.703)が実対局で現行本番v5より強いかを判定する。

## 前提

- 候補: `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`(SHA-256 `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfffcf4caf20fc9`は転記ミス防止のため必ず `bench/edax-compare/t168_training_report.meta.json` のmanifestから読むこと。実測照合、不一致なら停止)
- baseline: 現行本番 `train/weights/pattern_v5.bin`(SHA `9ce0cc05...`、実測照合)
- プロトコル・開幕・Edax: T158d/T162/T166と完全同一。ハーネス: `vs_edax.py`(変更禁止)

## 実行

1. **baseline再利用のスポットチェック(T168レビュー申し送り)**: 現HEADビルドで `--opening-limit 3`(6局)をv5重みで実行し、T166の候補C結果(`endgame-results/t166-c-vs-edax-results-full.json`、ローカル)の先頭6局とmargin・plies・moves(move/nodes/discDiff)を突合。**完全一致ならT166のC 60局データをbaselineとして再利用**(根拠をレポートに)。1つでも不一致なら v5 baseline 60局を新規実行。
2. **D1候補60局**: PWV6読込時のscalar有効表示を事前確認のうえ実行。
3. 逐次・専有・detached+ツール呼び出しポーリング(Monitor通知依存禁止)、1局ごとcheckpoint、作業ログ節目追記。

## 事前登録の判定規準

1. 主指標: 対v5の開幕単位paired比較(n=30): 平均石差差・paired bootstrap 95%CI(決定的seed・10万回、配列並び順をmetaに明記)・符号検定。
2. **採用提案**: CIが0より完全に上(有意改善)かつ異常0件 → 採用提案(**ただし配信サイズgzip 10.7MB vs 現行5.9MBのトレードオフをユーザー裁定事項として明記**。有意でなければ現行v5維持=サイズ増を正当化しない)。
3. **wall保険・時間の両アーム比較**(NPS-21%の影響確認): 各アームの1局所要時間・wall保険発火の有無をログから集計し記載。
4. exactFallback等の集計定義明記。

## レポート

`bench/edax-compare/t169_gate_report.md`(+`.meta.json`)。結果表・paired統計・baseline再利用根拠(または再実行理由)・時間比較・規準当てはめ。

## スコープ外

- 本番配線(採用裁定後の別タスク)・engine/train変更

## 受け入れ基準

1. 候補60局完走(+baselineの再利用根拠または新規60局)、レポート+metaに全統計・SHA検証・規準当てはめがある
2. 異常0件、統計は決定的に再現可能
3. 既存ファイル(t166系・t168系ほか)不変
4. 完了時 `git status --short` クリーン(レポートはパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装開始(implementer)

1. **manifest確認・SHA実測照合**: `bench/edax-compare/t168_training_report.meta.json`の`t169Manifest`節から候補・baselineのパス・SHA-256を取得。**候補SHAはタスクファイル記載値(`...bbfffcf4caf20fc9`)とmanifest値(`...bbfff4cf4caf20fc9`)が異なっており、指示どおりmanifest値を正として採用**。実測照合、両方(baseline v5・候補D1)とも完全一致を確認。
   - baseline: `train/weights/pattern_v5.bin`(`9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4`)— **T166候補Cと完全同一のSHA**(T167でv5に採用されたと判断)
   - 候補D1: `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`(`e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9`)
2. **baseline再利用のスポットチェック**: `git log fe5ffbcd..HEAD -- engine/`でT166以降にT168(corner5x2/diag4形状+定数項scalar追加)の1コミットがengine/に入っていることを確認。現HEADでeval_cli再ビルド(SHA `7ecceb8a...`、T166の`9c28701a...`と不一致)。v5重みで`--opening-limit 3`(6局)を実行し、T166候補C結果(`t166-c-vs-edax-results-full.json`)の先頭6局と突合: **margin・pliesは6局全て完全一致**したが、**1局(primary-03/white)でply34以降のmove・nodes(discDiffは32.0で同値)に不一致を発見**(空き17以降discDiff=32.0で局面が既に確定〈完全読み〉しており、T168の新形状追加により内部の同点手順の選択順序が変わったためと推定。最終結果〈margin/plies〉には影響しない)。**指示(1つでも不一致なら新規実行)に従い、T166 C再利用は行わず、v5 baselineを新規60局実行することにした**。
3. **候補D1のscalar事前確認**: `eval_cli best`単独実行で候補D1・v5(比較用)ともに`scalar_features_present=true scalar_features_enabled=true`を確認(v5も候補Cの系譜からscalar特徴を持つ)。
4. **v5 baseline 60局実行**: 13:48:35開始、14:01:55完走(約13.3分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。結果(20勝3分37敗、平均石差-6.75)はT166候補Cの値と完全一致(v5=候補C由来のため整合)。
5. **候補D1実行**: 直前の作業ログ追記でworktreeがtasks/ファイルのみdirtyだったため`--allow-dirty`で14:02:25起動(T166と同様の運用、以降完走までタスクファイル追記を控えた)。14:17:24完走(約15.0分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。結果: 26勝1分33敗、平均石差-2.22。
6. **統計算出**(独立に再計算・照合済み、全テーブル・統計値0件不一致を確認): 開幕単位(n=30、seed=169004、10万標本)でD1-v5平均差+4.5333石、CI[+1.7833,+7.3333](完全に0より上)、符号検定p=0.0428(有意)。局単位(n=60、seed=169005)も平均差+4.5333石、CI[+2.0667,+7.0333]、p=0.0105(有意)。
7. **wall保険・時間比較**: `vs_edax.py`の`wallInsuranceFired`定義(`timedOut かつ !nodeLimitHit`)に厳密に合わせて全engine着手(v5 1489手・D1 1498手)を集計、両アームとも発動0件を確認。局あたり所要時間はv5平均13.079秒・D1平均14.668秒(D1が約12.1%遅い、NPS-21%より圧縮された遅延)。
8. **watch-point・exactFallback集計**: budgeted→exact乖離(D1平均4.31石・v5平均4.79石、D1がやや安定)、符号反転(v5 7/60・D1 4/60)、exactFallback(遷移点1手のみの定義、T158d/T162/T166から継続、v5 5/60・D1 3/60、v5はT166候補Cと完全一致)。
9. **サイズトレードオフの記載確認**: `bench/edax-compare/t168_training_report.md`の実測値(v5 gzip 5,865,976バイト、D1 gzip 10,734,273バイト、差+4,868,297バイト・約+83%)を直接引用し、事前登録規準どおりユーザー裁定事項として明記(採否判定はしない)。
10. **レポート作成・検証**: `bench/edax-compare/t169_gate_report.md`・`.meta.json`を新規作成。全テーブル・統計値・watch-point数値を生JSONから独立再計算しクロスチェック、0件不一致を確認。T158d/T162/T166/T168系ファイルは無変更を`git diff --stat`で確認。
11. **コミット**: `bench/edax-compare/t169_gate_report.md`+`.meta.json`をコミット`d02c392`(パス明示でadd、`git add .`/`-A`不使用)。生の対局ログ・スポットチェック結果は既存`.gitignore`ルールによりローカルのみ。
12. **受け入れ基準確認**: 候補60局完走+baseline新規実行(根拠明記)、異常0件、統計はmetaのseed・アルゴリズム記載で決定的に再現可能、既存ファイル(t166/t168系)無変更、`git status --short`はタスクファイル編集分を除きクリーン。

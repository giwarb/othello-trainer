---
id: T166
title: canonical候補3つの対局ゲート(対Edax 60局×4本)と新本番の選定材料確定
status: done # verifier厳密検収合格(全統計独立再現・重みSHA/フォーマット/着手系列でB/C取り違え排除・T158d一致追試)。裁定(2026-07-21): 事前登録規準どおり**候補C(Egaroucid B3-canonical)を新本番として採用、T167で配線**(対v4 +17.37石 p<0.0001。Bも同水準〔差非有意〕、Aはv4同水準)。軽微誤記(C中央値-4→-5.0)は追修正指示済み
assignee: implementer
attempts: 0
---

# T166: canonical候補の対局ゲート

## 目的

T165で確定した3候補(A=WTHOR v4-canonical、B=Egaroucid全量v4-canonical、C=Egaroucid全量B3-canonical)を、現行本番v4と共通相手方式(対Edax)で対局させ、**新本番の選定材料を確定**する。D4対称性修正はユーザーの重大バグ指定なので、「明確に弱くならない限りcanonical系へ移行する」前提の測定(事前登録規準は下記)。

## 前提

- manifest: `bench/edax-compare/t165_training_report.meta.json`(候補3つのパス・SHA-256、比較相手=`train/weights/pattern_v4.bin`)。実行前に4重み全てSHA実測・照合。
- プロトコル・開幕・Edax設定: **T158d/T162と完全同一**(t158c_screening_report.meta.json の deferredT158d 節)。ハーネス: `vs_edax.py`(変更禁止)。
- **v4 baselineは再実行する**(T165レビュー申し送り(c): eval_cliバイナリがT163/T164で変わっており、wall保険の発火タイミング差で「理論上同一」が成立しないため、T158dの結果を再利用しない。現HEADビルドで新規60局)。
- **PWV6事前確認**(レビュー申し送り(b)): 候補C(PWV6)をeval_cliに読ませた際にscalar特徴が有効である旨の表示(stderr等)を対局開始前に確認し記録する。

## 実行(60局×4本、逐次・専有、計約1時間)

1. v4 baseline(現行本番重み、現HEADビルド)
2. 候補A(WTHOR v4-canonical seed2)
3. 候補B(Egaroucid v4-canonical seed3)
4. 候補C(Egaroucid B3-canonical seed1)

各60局(primary 30ペア)、1局ごとcheckpoint・resume、Start-Process detached+ツール呼び出しポーリング(Monitor通知依存禁止)。

## 事前登録の判定規準(結果を見てから変えない)

1. **主指標**: 各候補について、対v4 baselineの開幕単位paired比較(n=30): 平均石差差・paired bootstrap 95%CI(決定的seed・10万回)・符号検定。**bootstrap配列の並び順をmetaに明記**(T162 verifier申し送り)。
2. **選定**: 候補間の優先順位は「対v4 paired平均差の点推定が最大のもの」。参考として候補間の直接paired差(共通相手方式で同一開幕データから算出可能)も全ペア分記載。
3. **採用提案の規準**: 選定候補が (a)対v4で有意に劣らない(CIが実質的悪化〔平均-2石超かつCI全体が0未満〕を示さない) (b)異常0件 → **新本番候補として採用提案**。全候補が(a)を満たさなければ提案なしでエスカレーション(採否の最終裁定は常にオーケストレーター+ユーザー)。
4. exactFallback等の集計は定義を明記。watch-point: 候補Cのスカラー特徴が実際に効いていること(前提確認の記録)、終盤入口の異常な石差急落の有無。

## レポート

`bench/edax-compare/t166_gate_report.md`(+`.meta.json`): 4本の結果表・3候補のpaired統計・候補間参考差・判定規準への当てはめ・SHA検証・所要時間。

## スコープ外

- 本番配線(WASM側のPWV5/PWV6対応・ANALYSIS_ENGINE_VERSION繰り上げ・Pages確認は次タスクT167)
- vs_edax.py・engine・trainの変更

## 受け入れ基準

1. 4本×60局完走、レポート+metaに全統計・SHA検証・規準当てはめがある
2. 異常(クラッシュ・非法手・非決定性)0件
3. 統計はmetaから決定的に再現可能(配列並び順の明記込み)
4. 既存ファイル(t158d/t162/t165系)の値を変更していない
5. 完了時 `git status --short` クリーン(レポートはパス明示コミット、生ログはgitignore領域。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 対局は専有(他の重い処理と並行しない)。作業ログ節目追記(1本完了ごと)

## 作業ログ

### 2026-07-21 実装開始(implementer)

1. **manifest確認・SHA実測照合**: `bench/edax-compare/t165_training_report.meta.json`の`t166Manifest`節から4重み(baseline v4・候補A/B/C)のパス・SHA-256を取得し、`certutil -hashfile`で実測、全4件完全一致を確認。
   - baseline: `train/weights/pattern_v4.bin`(`c372b833...639e383f`、PWV3)
   - 候補A: `train/data/t165/wthor-v4/v4-canonical-seed-2-earlystop.bin`(`f4200377...`、PWV5)
   - 候補B: `train/data/t165/egaroucid-v4/v4-canonical-seed-3-earlystop.bin`(`13b7abb1...`、PWV5)
   - 候補C: `train/data/t165/egaroucid-b3/t158-b3-canonical-seed-1-earlystop.bin`(`9ce0cc05...`、PWV6)
2. **v4再実行の根拠確認**: `git log 4990bb98d..HEAD -- engine/`でT158d以降にT163(D4 canonical化PWV5)・T164(canonical学習配線+PWV6)・T165(前提修正2件)の3コミットがengine/に入っていることを確認。現HEADで`cargo build --release -p engine --bin eval_cli`を実行しSHA-256を実測(`9c28701a...`)、T158dの`c19f8633...`と不一致であることを確認 → タスク前提どおりv4 baselineを再実行する根拠とした。
3. **候補C(PWV6)のscalar特徴事前確認**: `eval_cli gen`で初期局面を生成し、候補Cの重みファイルを`--pattern-weights`で渡して`eval_cli best`を実行、stderrに`scalar_features_present=true scalar_features_enabled=true`が出力されることを確認・記録。比較のため候補A/B/baselineでも同じ確認を行い、いずれも`scalar_features_present=false`(想定どおり、B3系のみscalar特徴を持つ)であることを確認した。
4. **v4 baseline 60局実行**: T158d/T162と完全同一コマンド(`--weights train/weights/pattern_v4.bin`)。PowerShell `Start-Process`でdetached起動(09:31:49開始)、ツール呼び出しでのポーリングで進捗確認(Monitor通知は使用せず)。09:45:34完走、60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。**T158d段階2のv4 60局結果(`t158d-v4-vs-edax-results-full.json`)と全60局を突き合わせたところ、margin・pliesとも完全一致(0件不一致)** — eval_cliバイナリのSHAはT158d時点と異なるが(canonical化関連の追加はPWV3の挙動には影響しないと考えられる)、実際のゲーム結果は完全再現された。これは「再実行する」という前提判断の妥当性を裏付ける追加のエビデンスとして記録する。
5. **候補A実行**: 09:46:14開始、10:01:14完走(約15分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空、weightsSha256実測一致。
6. **候補B実行(1回目失敗→2回目成功)**: 10:01:40に起動したところ、直前のこの作業ログ追記でworktreeが一時的にdirtyになっており`ensure_clean_worktree()`にブロックされ即座に終了(結果ファイル未生成、実害なし)。dirty差分は`tasks/T166-canonical-game-gate.md`のみ(engine/・vs_edax.py・重みファイル等の計測対象パスとは無関係)であることを確認し、`--allow-dirty`を付けて10:02:39に再起動。10:15:55完走(約13.3分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。以降、全4本完走までタスクファイルへの追記を控えることでこの事象の再発を防いだ。
7. **候補C実行**: 10:16:34開始(`--allow-dirty`継続、dirty差分は同じくtasks/ファイルのみ)。10:30:18完走(約13.7分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。事前に(4節参照)`eval_cli best`単独実行でscalar_features_present=true/enabled=trueを確認済み。
8. **統計算出**(独立に再計算・照合済み、全テーブル・統計値0件不一致を確認): 開幕単位(n=30)paired bootstrap(seed 166004=A-v4、166014=B-v4、166024=C-v4、166104=A-B、166114=A-C、166124=B-C、各10万標本)+符号検定。結果: A-v4平均-1.55(CI[-5.83,+2.93]、p=0.5847、有意差なし)、B-v4平均+17.05(CI[+13.70,+20.43]、p<0.0001、強く有意)、C-v4平均+17.37(CI[+13.97,+20.87]、p<0.0001、強く有意)。B-C差-0.32(CI[-2.63,+2.10]、p=1.0000、有意差なし)。局単位(n=60)も同様の傾向を再確認。
9. **watch-point集計**: budgeted→exact乖離(候補Aが最も大きく不安定〈平均9.31石〉、候補Cが最も安定〈平均4.79石〉)、符号反転(v4:4/60、A:1/59、B:6/60、C:7/60、いずれも近接値からの反転で劇的な逆転なし)、exactFallback集計定義(遷移点1手のみ、T158d/T162から継続)を明記。
10. **選定・採用提案規準の当てはめ**: 事前登録規準どおり対v4平均差最大の候補C(+17.37)を選定(Bとの差は非有意)。採用提案規準(a)有意に劣らない(b)異常0件をCが満たすため新本番候補として提案。ただしBも統計的に同水準であり最終裁定はオーケストレーター+ユーザーに委ねる。
11. **レポート作成・検証**: `bench/edax-compare/t166_gate_report.md`・`.meta.json`を新規作成。全テーブル(A-v4/B-v4/C-v4の各30行)・統計値・watch-point数値・meta.json埋め込み配列を生JSONから独立再計算しクロスチェック、0件不一致を確認。T158d/T162/T165系ファイルは無変更を`git diff --stat`で確認。
12. **コミット**: `bench/edax-compare/t166_gate_report.md`+`.meta.json`をコミット`d3ee9e2`(パス明示でadd、`git add .`/`-A`不使用)。生の対局ログ(`t166-{v4,a,b,c}-vs-edax-*-full.json`等)は既存`.gitignore`ルールによりローカルのみ。
13. **受け入れ基準確認**: 4本×60局完走、統計はmetaのseed・アルゴリズム・配列並び順記載で決定的に再現可能、既存ファイル(t158d/t162/t165系)無変更、`git status --short`はタスクファイル編集分を除きクリーン。
14. **verifier検収後の誤記修正**: 候補Cの中央値誤記(-4→正しくは-5.0、60局ソート後中央2値[-6,-4]の平均)を`t166_gate_report.md`セクション5表・`t166_gate_report.meta.json`の`results.C.marginMedian`の2箇所のみ修正、他数値は無変更を確認しコミット`c62b98b`。

### 2026-07-21 verifier検証(合格、軽微な指摘1件あり)

生JSON4本(`t166-{v4,a,b,c}-vs-edax-results-full.json`)からPythonで独立に全統計を再計算し照合した。

- 勝敗・平均石差: 4本とも完全一致(v4:4-2-54/-24.117、A:5-2-53/-25.667、B:16-2-42/-7.067、C:20-3-37/-6.75)。**ただし候補Cの中央値のみ不一致を検出**: 報告書・meta.jsonとも「-4」と記載しているが、生データ(60局の`margin_engine_minus_edax`をソートし中央2値[-6,-4]を平均する標準的な偶数個中央値)から独立再計算すると正しくは**-5.0**。v4(-24)・A(-28)・B(-6)の中央値は一致。この1箇所の中央値誤記は主要判定指標(paired bootstrap平均差)には使われておらず選定・提案の結論には影響しないが、事実として報告する。
- 開幕単位(n=30)・局単位(n=60)のpaired bootstrap(`random.Random(seed)`+resample-with-replacement 10万回+percentile 2.5/97.5)と符号検定(scipy `binomtest`)をmeta記載のseed・並び順定義(開幕番号昇順、局単位は開幕番号昇順→黒番→白番)で再実装・全再現: A/B/C対v4、A-B/A-C/B-Cの参考差、開幕単位・局単位とも全数値(平均差・CI・改善/悪化/同値件数・p値)が完全一致(0件不一致)。
- watch-point(budgeted→exact乖離)は「最終実際のスコア」ではなく「最初のunlimited-exact局面のdiscDiff(exact確定値)」との差分と判明(この定義で試したところv4/A/B/Cの平均・中央値・最大値・母集団標準偏差〈`statistics.pstdev`〉が完全一致)。符号反転数(v4:4/60,A:1/59,B:6/60,C:7/60)、fallbackAtTransition件数(v4:9/60,A:4/59,B:1/60,C:5/60)、除外1局(候補A primary-30/黒番、0石で合法手なし)もすべて生データから再現・確認。
- 重み取り違えの排除: 4重みファイルを`hashlib.sha256`で実測し、manifest・report・meta.json記載のSHA-256と完全一致(v4=c372b833.../PWV3、A=f4200377.../PWV5、B=13b7abb1.../PWV5、C=9ce0cc05.../PWV6)。各重みファイルの先頭バイトを直接読み、フォーマットタグ(`PWV3`/`PWV5`/`PWV5`/`PWV6`、Cのみ末尾に追加フィールドあり)を確認、manifestの`format`列と一致。各対局JSONの`meta.weightsSha256`も対応する重みと一致。さらにBとCの1局目(primary-01)の着手系列を比較したところ5手目以降で分岐(`e2 vs c4`等)・discDiffの数値系列も全く異なり、BとCが実際に別の評価関数で対局していることを内容面でも確認した。
- v4 baseline再実行の根拠・T158dとの全60局一致主張: `git log`でT163/T164/T165の3コミットがengine/に入っていること、現HEADビルドのeval_cliのSHA-256(`9c28701a...`、`target/release/eval_cli.exe`実測と一致)がT158dの`c19f8633...`と異なることを確認。T158d旧v4結果(`t158d-v4-vs-edax-results-full.json`)と本タスクv4 60局を(start_id, engine_is_black)キーで全件突合し、margin・pliesとも0件不一致を確認(報告書の主張どおり)。
- 異常0件: 4本全JSONで`fixed_depth_result`/`node_budget_result`とも`allMatched:true`・`mismatches:[]`(40/40・10/10)、`moves`中の`move:null`走査は4本合計0件。
- 事前登録規準の当てはめ: 独立判定でも「選定=C(点推定+17.37>B+17.05>A-1.55)」「採用提案規準(a)(b)ともC満たす」「B-C差は非有意」という報告書の当てはめは規準文言どおりで妥当と判断。
- 既存ファイル不変・gitクリーン: `git show --stat d3ee9e2`はレポート2ファイルのみ追加、`git log`でt158d/t158c/t165系ファイルへの本タスク由来コミットなしを確認。`git status --short`はクリーン。

**総合判定: 合格**(候補C中央値の軽微な誤記1件を除き、報告書の全統計・SHA・規準当てはめ・異常0件・既存ファイル不変・git cleanを独立再現・確認)。

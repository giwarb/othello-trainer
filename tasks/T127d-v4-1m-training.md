---
id: T127d
title: v4×expanded1m蒸留学習(teacher-only、500k bridge+1M×3seed)・oracle評価
status: done # verifier(独立再集計・bootstrap/フィット完全再現)+代替レビュー(中4件はT127e申し送り)両合格、2026-07-20
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T127d: v4×expanded1m学習・oracle評価

## 目的

T127b/cで生成・検証済みの100万件教師コーパスを使い、**v4特徴(ステージ1石刻み61段、T124)×teacher-only損失**の蒸留学習を1Mスケールで実施し、oracle regretで蒸留スケール路線の到達点を測る。**T127e(4M投資判定)の判断材料**を作るのが目的(採用判定・対局ゲートは本タスクに含めない)。

期待値の事前登録(T126の外挿): v4蒸留曲線4.77→3.63→2.77(45k/90k/180k)の外挿で **1M=1.4〜1.63石**。実測がこの帯domainに入るか、v3×WTHOR本番(1.40)・v2×WTHOR(1.5667)に対してどこまで迫るかが焦点。

## 背景・事実

- コーパス: `train/data/teacher/corpus_expanded1m.jsonl`(1,000,000行、1,595,551,517 bytes、SHA-256=067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86、gitignore領域)。T127cで全件検証済み(0エラー)。manifest: `bench/edax-compare/teacher_manifests/corpus_expanded1m.meta.json`。
- 学習基盤: `train/src/t090_distillation.rs`(蒸留トレーナー)。先行タスクの実施例: `tasks/T120-teacher-only-200k-training.md`(200k teacher-only 3seed)、`tasks/T123-v3-distill-200k.md`、`tasks/T124-v4-stage-resolution.md`(v4特徴の定義・61段ステージ)、`tasks/T126-distill-scale-decision.md`(--train-subset-size導入、v4蒸留曲線)。実行方法・meta/report形式はこれらの前例に従う。
- oracle: T096の60局面oracle(教師コーパス非重複・層化)。**M2ガード必須**: 各oracle計測の前後どちらかで v2×WTHOR行の regret=1.566666...(1.5667)の完全再現を確認し、計測環境の妥当性を担保する(T110申し送り)。
- 設計の正: `tasks/design/T127-corpus-1m-report.md` §「T127d: v4×expanded1m学習・oracle評価」。

## 変更対象

- `train/src/t090_distillation.rs`(1Mコーパスのストリーミング読込が必要な場合のみ。不要なら変更しない)
- 対応テスト(トレーナーを変更した場合)
- 実験meta/report(前例に従い `bench/edax-compare/` またはリポジトリの既存慣行の場所へ)
- 重み・checkpointはgitignore領域(コミットしない)

## 要件(設計レポート準拠)

1. **trainer入力のストリーミング化**(必要な場合): 1Mコーパス(1.6GB JSONL)のロードでメモリ不足にならないこと。まず現行実装で1Mが読めるか小実験で確認し、問題なければ変更不要。
2. **500k bridge subset、seed 1**(推奨副実験): 45k/90k/180k/1Mの間を埋める学習曲線の中間点。`--train-subset-size` 等の既存機構で500,000件サブセットを作り seed 1 で1本学習・oracle評価。
3. **1Mフル、v4 teacher-only、seed 1/2/3**: 3seedで学習し、各seedの重みをT096 oracle 60局面で評価。
4. **`--jobs 1`**(直列実行): 学習中の環境負荷を抑える(並行してT143が軽作業を行うため、また計測汚染防止)。
5. **epoch単位checkpoint/resume**: 長時間実行ルール必須。1Mは1 epochが長いので、少なくともepoch境界でcheckpointし、中断→resumeで続きから再開できること(既存基盤にあれば踏襲)。進捗(epoch番号・損失・経過時間)をログへ随時出力。
6. **M2ガード**: 上記のとおりv2×WTHOR行1.566666...の完全再現を oracle計測セッションごとに確認・記録。
7. **統計**: 3seedの平均・sample SD・各seedのpaired bootstrap CI(vs v2×WTHOR 1.5667、前例の方式)。
8. **学習曲線の再推定**: 45k/90k/180k(T126)+500k bridge+1Mの点でlog-linear fitを再推定し、4M外挿値を更新(参考値と明記)。
9. **実件数の明記**: 実train/validation/frozen件数(コーパス1,000,000と実train件数の呼称を混同しない)。

## 長時間実行ルール(CLAUDE.md準拠・必須)

- 学習は数時間〜になりうる。epoch単位checkpoint+resume+進捗ログを最初から入れる。「全部終わってから一括書き出し」禁止。
- 学習の実行はdetached(Start-Process等)で行い、ログをtailで監視してよい。セッション中断が見込まれる場合はcheckpointを保全してから終える。
- 節目(構成決定・各run開始/完了・oracle評価・エラー)ごとに本タスクファイルの作業ログへ追記する。

## スコープ外(やらないこと)

- 採用判定・本番配線・対局ゲート(oracle結果を受けたT127e判断と、採用候補が出た場合の審査は別タスク)
- 4Mコーパス生成
- `gen_teacher_corpus.py` / verify/finalize系の変更(T143が並行して担当。**bench/edax-compare/ のpyファイル群とはコンフリクトしないこと** — 本タスクはtrain/側とレポートのみ)
- NPS等の性能計測(評価関数の重みだけが変わる実験。ただしv4のNPSはT124で100.9%確認済み)
- app/engineの変更(GitHub Pages確認不要)

## 受け入れ基準

1. 500k bridge(seed1)+1M(seed1/2/3)の計4run分のoracle regretが、M2ガード成功記録付きでレポートに記載されている
2. 3seed平均・SD・CI、学習曲線再推定と4M外挿更新値がレポートに記載されている
3. トレーナーを変更した場合: `cargo test -p train`(または既存の該当テスト実行方法)がパスし、変更前後で小規模構成の数値等価性(または差分の説明)が示されている
4. checkpoint/resumeが実装され、実際にresumeが機能することを小規模構成で確認済み
5. 変更ファイルはパス明示でコミット(`git add .` 禁止)し、mainへpush
6. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(重み等gitignore領域は除く)

## コミット規律

- コミットしてよいのはタスクの変更対象ファイルのみ。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 一時ファイルはscratchpadへ。スコープ外差分は報告のみ

## 作業ログ

(ワーカーが節目ごとに追記)

### 2026-07-20 00:0x JST 着手・事前確認・メモリ実験・500kブリッジ学習完了

- 前提確認: `git status --short`空、直近コミットT127c done(4a0f8f7)。コーパス`train/data/teacher/corpus_expanded1m.jsonl`実在確認(1,595,551,517 bytes、`ls`実測)。`train/src/t090_distillation.rs`に`--train-subset-size`/`--subset-seed`(既定42)が既存(T126で追加済み、distillationトレーナー側)。`cargo build --release -p train --bin train_distillation -p engine --bin eval_cli`は差分なしで成功(ソース変更なしのため再ビルドのみ)。
- **メモリ実験(要件1)**: `load_corpus`は`fs::read_to_string`で1.6GB全文を一括読込した後、パース済み`Vec<DistillRecord>`を構築する現行実装のまま、1M corpus(全レコード900k弱)+`--train-subset-size 500000/2000`のスモークを実行。42秒(2000件)・21秒(500k, 1epoch)・33秒(500k, 4epoch)で正常終了、OOMや異常な遅延なし(空きメモリ約8.5GB/総16GB環境)。**ストリーミング化は不要と判断し、trainerのコード変更なし**(要件1のスコープ「不要なら変更しない」を適用)。
- **タイミング実測**: 500k train・1epoch=21.4s(コーパス全読込+outcomeキャッシュ含む固定コスト込み)、4epoch=33.3s → 1epochあたり約4.0秒(500k規模)。900k規模へ比例外挿で約7.2秒/epoch。3seed合計は corpus 1回読込(約17秒、複数seed/mixで共有)+各seed最大60epoch×約7.2秒。
- **resume実地確認(受け入れ基準4)**: `train/data/t127d/resume-check`(スクラッチ、200k件サブセット)でバックグラウンド学習中にBashツール呼び出し境界でプロセスが打ち切られ、epoch=6まで保存・epoch=7開始直後で中断される実インシデントが発生。同一コマンドを再実行したところ`resume mix=teacher-only seed=1 epoch=6`と出力され、epoch=7から再開して完走(exit 0)。中断→再開が実機能することを確認後、このスクラッチdirは削除(正式run対象外)。
- **500k bridge (seed1) 学習完了**: コマンド`target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl --checkpoint-dir train/data/t127d/expanded1m-v4-500k-bridge --mixes teacher-only --seeds 1 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 --train-subset-size 500000`。
  - 実件数: corpus全体train=899,467(full_train_size)、subsetターゲット500,000→実際499,974件(層化flooringにより26件少)、validation=49,278、frozen=51,255。
  - 学習: best_epoch=29、completed_epoch=29(patience切れで停止、max60epoch未到達)。train_teacher_mae=4.351038、validation_loss=19.956412、validation_teacher_mae=6.661462、frozen_agreement=0.402517、frozen_mean_regret=5.967457、wthor_2024_mae=14.809149。
  - epoch単位でweights/state/metricsをatomic保存する既存機構を使用(コード変更なし)。
- **1Mフル(seed1/2/3)学習を起動**: コマンド`target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl --checkpoint-dir train/data/t127d/expanded1m-v4-1m --mixes teacher-only --seeds 1,2,3 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1`(train-subset-size無指定=corpus全量899,467train)。detached起動(Bashバックグラウンド、`disown`)、ログ`train/data/t127d/logs/1m-full.stdout.log`をMonitorで90秒間隔・進捗停滞30分検知付きで監視中。次の節目でoracle評価(compare_pattern_v3.py、T096 60局面、M2ガード)へ進む。

### 2026-07-20 00:2x JST 1Mフル学習完了・oracle評価・曲線再推定・レポート作成完了

- **1Mフル学習結果**: 全3seed、train=899,467(共通)、validation=49,278、frozen=51,255。best/completed epoch: seed1=31/31、seed2=33/33、seed3=33/36(いずれもpatience停止、60epoch上限未到達)。train_teacher_mae 4.594/4.579/4.537、frozen_agreement 0.4272/0.4275/0.4284、frozen_mean_regret 5.203/5.189/5.146。
- **oracle評価(T096 60局面、compare_pattern_v3.py)**: 500k bridge・1M seed1/2/3の**計4回すべてでv2行=1.5666666666666667(M2ガード完全一致)PASS**。
  - 500k bridge(seed1): candidate regret=**2.4000**、v2差+0.8333、95%CI[-0.1667,1.9333]、no_significant_difference。
  - 1M full: seed1/2/3すべて regret=**1.9000**(完全一致)、v2差+0.3333、95%CI[-0.5667,1.4000]、no_significant_difference。**3seed sample SD=0**。3つの重みファイルSHA-256は相異なる(異なる学習結果)が、60局面全てでengine選択手が3seed完全一致することを個別に確認(コピー・バグではなく実測結果)。frozen_mean_regretはseed間でわずかに異なる(5.203/5.189/5.146)ため「モデルが完全に同一」ではなく「この60局面テストでは判別できない」という限定的な結果として報告に明記。
  - resume実地確認: `train/data/t127d/resume-check`(スクラッチ、200k件)でバックグラウンド実行中にツール呼び出し境界でプロセスが打ち切られepoch=6で中断→同一コマンド再実行で`resume mix=teacher-only seed=1 epoch=6`と表示し完走(exit 0)。確認後にスクラッチdirは削除。
- **学習曲線再推定(T126の45k/90k/180k + 本タスクの500k/899,467の5点)**: inverseSqrt R²=0.9870(1M=1.9061,4M=1.5292)、fittedPowerLaw(非線形最小二乗) R²=0.9734(1M=1.7832,4M=1.1642)、**log-linear(要件9の主指定)** R²=0.9293(1M=1.6638,4M=0.4289)。4M外挿更新プランニングレンジ=0.43〜1.53(統計的信頼区間ではない、感度分析)。
  - **重要な発見**: 実測500k(2.4000)・899,467(1.9000)はいずれもT126の3点フィット予測(500k予測1.85〜1.98、900k予測1.47〜1.68)より悪化しており、事前登録された期待値レンジ(1M=1.4〜1.63石)の上限を上回る(=悪い)。設計レポート§7の「>1.70で打ち切り」基準に対して実測1.9は基準超過。K=4拡張(同一対局内密度増加)による曲線の質的変化が示唆される(設計レポート§3.9の懸念が的中した可能性、断定はしない)。この事実はT127e判断のための客観情報としてレポートに記載し、採否判定自体は行っていない(スコープ外)。
- **メモリ/ストリーミング化**: 上記スモーク実験(42.8秒/2000件、21.4秒・33.3秒/500k)で1.6GBコーパス全読込・全学習が正常完了することを確認済みのため、`train/src/t090_distillation.rs`は変更なし(要件1の「不要なら変更しない」を適用)。
- **`cargo test -p train`**: PASS(lib unit 56 + teacher_candidates unit 2 + real_data 1、失敗0)。トレーナー未変更のためベースライン確認として実施。
- **成果物**: `bench/edax-compare/t127d_v4_1m_training.meta.json`、`bench/edax-compare/t127d_v4_1m_training_report.md`を新規作成(この2ファイルのみコミット対象)。重み・checkpoint・oracle生JSON・スクラッチ実験は`train/data/t127d/`(gitignore領域)。`bench/edax-compare/`の既存pyファイル群・corpus_expanded1m.meta.jsonは変更していない(T143が並行してコミット済み、コンフリクトなしを`git status --short`で確認)。
- **採否判定・対局ゲート・本番配線は本タスクのスコープ外**(T127e、design report §7の閾値との対比を客観情報として記載のみ)。
- **オーケストレーターへの申し送り**: 実測1M regret=1.9は設計レポートの「打ち切り」基準(>1.70)域に該当する客観的事実。T127e(4M投資判定)ではこの数値と500k→1Mの傾き悪化・K=4密度変化の懸念(design report §3.9)を踏まえた判断が必要。

### 2026-07-20 00:5x JST done後の追加実験2点(オーケストレーター指示、T127e判断材料)完了

- **前提確認**: T127dはverifier・codex-review両合格でdone済み(status行に記載済み)。追加実験開始前に`git status --short`を確認し、`tasks/T127d-*.md`(本ファイル)以外に自分由来の未追跡・差分がないことを確認してから着手。
- **①180kサブセット判別実験**: `target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl --checkpoint-dir train/data/t127d/expanded1m-v4-180k-probe --mixes teacher-only --seeds 1 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 --train-subset-size 180000`(subset-seed既定42、本タスクの1M runと同一構成)。実train=179,969(validation/frozen=既存run共通の49,278/51,255)、patience停止best/completed epoch=32/32。
  - oracle評価(compare_pattern_v3.py、T096 60局面): v2=1.5666666666666667(**M2ガードPASS**)、candidate regret=**4.0000**、v2差+2.4333、95%CI[1.0000,4.0000]、candidate_worse。
  - **事前登録判定**: 「≈2.77なら純粋逓減、>3.0なら K密度説」に対し、実測4.0000は3.0を明確に超過 → **K密度説を支持**。
  - T126のK=1系180k点(regret 2.7667、`train/data/t126/oracle/distill-180k-seed-1.json`が現存)と同一60局面IDで直接paired比較: 差分(K4-K1)=+1.2333、95%CI[-0.2667,2.8333]、no_significant_difference(点推定はK密度説を支持するが、60局面のみでは統計的有意性までは確立できず)。両runのeval_cliビルドが異なる(T126:6ba26dc5.../本セッション:e874bb4c...)点は限定条件として明記(いずれもv2=1.5666666666666667を完全再現しスコアリング挙動自体の一貫性は確認済み)。
- **②絶対regretのbootstrap CI**: 追加学習・追加Edax呼び出しなしで、既存oracle生JSON(`train/data/t127d/oracle/1m-seed-1.json`、`500k-bridge-seed-1.json`)から位置レベルpercentile bootstrap(seed=96002、100,000サンプル、compare_pattern_v3.pyと同じ規約)で絶対平均regretのCIを算出。
  - 1M(seed1代表、seed2/3は局面別regretが完全一致するため同一CI): 平均1.9000、95%CI[1.0333,2.9000]。
  - 500k bridge: 平均2.4000、95%CI[1.4667,3.4333]。
  - 参考: v2平均1.5667、95%CI[0.9333,2.2333]。
  - **解釈**: 1M・500kいずれも95%CIが打ち切り閾値1.70をまたぐ(v2自身のCIともまたぐ)ため、「1.9>1.70」は点推定としては事実だが、60局面のみでは統計的に鋭い超過とは言えない。
- **成果物**: 上記2点の数値・解釈を`bench/edax-compare/t127d_v4_1m_training_report.md`の追補セクション(「Addendum: two cheap follow-up experiments for T127e」)と`t127d_v4_1m_training.meta.json`の`"addendum"`キーに追記。新規学習(180k probe)・新規oracle JSON(`train/data/t127d/oracle/180k-probe-seed-1.json`)は`train/data/t127d/`(gitignore領域)。`train/src`・`bench/edax-compare/*.py`は無変更。
- **コミット**: `bench/edax-compare/t127d_v4_1m_training.meta.json`と`_report.md`の2ファイルのみパス指定でadd・commit・push(`tasks/`はコミット対象外、本作業ログ追記のみ)。

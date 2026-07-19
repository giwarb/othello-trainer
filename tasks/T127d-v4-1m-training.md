---
id: T127d
title: v4×expanded1m蒸留学習(teacher-only、500k bridge+1M×3seed)・oracle評価
status: todo # todo | in_progress | review | redo | done | blocked
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

---
id: T159
title: 本番トレーナーへの早期打ち切り(early stopping)導入 — Egaroucid全量学習シリーズ(1/3)
status: review # 実装完了(8372aa2)、verifier+Claude代替レビュー並列検収中。判明した仕様の穴: --simple-corpus(Egaroucid経路)と--early-stopが併用不可 → T159bで対応(オーケストレーターの仕様ミス、redoではない)
assignee: implementer
attempts: 0
---

# T159: 本番トレーナーへの早期打ち切り導入

## 目的

ユーザー裁定(2026-07-21): T158d後の次シリーズ=**Egaroucid公開データ全量25,514,097局面での学習**(素のv4構成+B3特徴あり構成の両方)→60局対局ゲート判定。その**前提条件**として、本番トレーナー(train_patterns_v3)に早期打ち切りを導入する。

背景: 現行は「固定20エポックで最終エポックの重みを採用」する設計で、WTHOR 443万サンプル向けに調整されている。T155ではEgaroucidサブセット学習で固定20エポックによる過学習が疑われた(未証明)。データ量・分布が変わっても頑健に「一番良かった時点の重み」を選べる仕組みが必要。

## 変更対象

- `train/src/bin/train_patterns_v3.rs`(本番トレーナーCLI)
- `train/src/regression.rs`(学習ループがこちらにある場合)
- 参考実装: 実験用トレーナー `train/src/bin/t090_distillation.rs` には早期打ち切りの実装例がある(そのままコピーせず、本番トレーナーの構造に合わせて実装)

## 要件

1. **opt-inフラグ**: `--early-stop`(既定OFF)。**OFF時の挙動・出力・run identity・重みバイナリは現行と完全ビット一致**(既存経路の完全不変。検証方式はT155/T158bの前例=小規模スモークで重みSHA-256一致)。
2. **検証split**: 早期打ち切りの監視指標には、**train側から対局(game)単位で決定的に切り出した検証split(既定5%、`--early-stop-val-percent`で変更可)**を使う。既存のfrozen holdout(10%)は**学習にも選択にも使わず**従来どおり報告専用のまま(選択バイアスを入れない)。分割は対局IDのハッシュ等で決定的・seed非依存に(同一データなら常に同じ分割)。
3. **アルゴリズム**: 各エポック終了時に検証splitのMAEを計測。ベスト値を更新したらその時点の重みをチェックポイント保存。`--early-stop-patience N`(既定3)エポック連続で改善なしなら打ち切り、**ベストエポックの重みを最終成果物として出力**。`--max-epochs`(既定は現行20、早期打ち切り時は30推奨を許容)。改善判定の閾値(min-delta)は0(タイの場合は先のエポックを保持)。全て決定的であること。
4. **メトリクス出力**: エポックごとに train loss・検証MAE・ベスト更新有無をログ/メトリクスファイルに出力(既存メトリクス形式に列追加する場合は早期打ち切りON時のみ。OFF時の出力は不変)。
5. **identity/checkpoint**: 早期打ち切りON時は新しいidentity schema(フラグ・patience・val-percent・max-epochsを含む)。resume対応(エポック単位checkpoint、ベスト重みも含めて再開可能)。
6. **テスト**(cargo test -p train に追加): (a)OFF時の重みビット一致(小規模スモーク) (b)検証MAEが人工的に悪化するケースでpatience動作とベスト重み復元 (c)resume同一性 (d)検証splitの決定性。
7. **動作確認**: WTHOR 180kサブセット(T158bのpilot設定流用可)で `--early-stop` ON学習を1回実行し、エポック推移・打ち切り動作・所要時間を作業ログに記録(重み成果物はgitignore領域 train/data/ 配下、train/weights/には置かない)。

## スコープ外

- Egaroucid全量25.5Mでの学習実行(次タスクT160。本タスクは機構導入まで)
- B3特徴(PWV4)側の変更(既存のT158b実装がそのまま使える想定。使えない場合は報告)
- 対局ゲート・採否判定

## 受け入れ基準

1. `cargo test -p train` 全パス(新規テスト込み)。`cargo test -p engine` も全パス(engine側を触った場合のみ)
2. OFF時の完全不変が担保されている(小規模スモークで重みSHA-256一致の実証がレポート/作業ログにある)
3. 180kスモークで早期打ち切りが実際に動作した記録(エポック推移・ベストエポック・打ち切りエポック)がある
4. 変更ファイル一覧と検証結果を完了報告に明記。成果物はパス明示でadd・コミット(`git add .`/`-A`禁止)。一時ファイル不残置、タスク完了時点で `git status --short` に当該タスク由来の差分・未追跡ファイルが残っていないこと(`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。重い計測(NPS等)は含まないため専有不要だが、学習スモーク中は他の重い処理と並行しない

## 作業ログ

### 2026-07-21 実装(Sonnet implementer、Codex usage limitフォールバック)

- 参考実装調査: `train/src/bin/t090_distillation.rs`は現存せず、実体は`train/src/t090_distillation.rs`(binは`train_distillation.rs`から`train::t090_distillation::run()`を呼ぶ薄いラッパー)。`run_one`/`simple_run_one`のpatience実装(`best_loss`/`patience_loss`/`best_epoch`/`stale`/`since_decay`、`best.bin`保存、resume用`state`ファイル)を参考にした。
- `train/src/bin/train_patterns_v3.rs`に以下を追加(既存の`run_config_seed`・OFF経路コードは1行も変更していない):
  - `flag_present`(値なしフラグ検出)
  - `early_stop_game_hash`/`split_early_stop_validation`: 対局内容のFNVハッシュで対局単位の検証splitを決定的に切り出す(seed非依存、`1_000_000`バケットに対する閾値判定)
  - `EarlyStopState`/`read_early_stop_state`/`write_early_stop_state`、`ensure_early_stop_metrics_header`/`truncate_early_stop_metrics_after`/`append_early_stop_metrics_row`(専用メトリクスファイル`{name}-seed-{seed}-earlystop.metrics.tsv`)、`append_result_earlystop`(専用`results-earlystop.tsv`、既存`results.tsv`とは別ファイル)
  - `apply_early_stop_step`: ベスト/patience更新判定の純粋関数(min-delta=0、タイは先勝ち保持)
  - `finalize_early_stop_result`/`run_config_seed_early_stop`: 早期打ち切り本体。checkpoint(`epoch-XX.bin`)・`best.bin`・`state.txt`で中断/再開に対応し、`patience`エポック連続未改善で打ち切り、ベストエポックの重みを`{name}-seed-{seed}-earlystop.bin`として出力
  - `run_early_stop_wthor`: `--early-stop`ON時のWTHOR経路本体。`main`のOFF経路とは`games`読み込み直後で分岐する別関数(既存コードと物理的に混ざらない)
  - `main`に`--early-stop`(既定OFF)/`--early-stop-val-percent`(既定5.0)/`--early-stop-patience`(既定3)/`--max-epochs`(既定20)を追加。`--simple-corpus`との併用は明示的にエラー
- identity schemaは`schema=5-earlystop`(既存の`schema=2`/`schema=3-t158`とは別)。成果物パスに`-earlystop`サフィックスを付け、OFF経路の成果物と物理的に衝突しないようにした。
- テスト追加(`cargo test -p train --bin train_patterns_v3`、9件、全パス):
  - `off_path_matches_direct_model_training_bit_for_bit`(要件6a): `run_config_seed`(OFF経路、無変更)が`Model::train`直接呼び出しと完全一致するバイト列を出すことのコード上の回帰ガード
  - `early_stop_validation_split_is_deterministic` / `early_stop_validation_split_is_order_independent`(要件6d): 検証splitの決定性・対局順序非依存性
  - `early_stop_patience_tracks_best_and_stale_counts`(要件6b前半): 人工的な検証MAE列(8.0→5.0→6.0→6.0→7.0)でのpatience/ベスト更新(タイは先勝ち保持)を純粋関数レベルで検証
  - `early_stop_restores_best_checkpoint_and_stops_before_max_epochs`(要件6b後半): train/valに同一局面・教師値を逆方向(train=+10, val=-10)にすることで「学習が進むほど検証MAEが単調悪化する」決定的シナリオを構成し、`run_config_seed_early_stop`実経路でpatience経過後にmax_epochs前に打ち切り、最終成果物がベスト(1エポック目)の重みと一致することを確認
  - `early_stop_resume_matches_uninterrupted_run`(要件6c): 1エポック終了直後クラッシュ状態をcheckpoint/state/best.binの直接書き込みで再現し、そこから再開した結果が中断なし実行と完全一致することを確認
- `cargo test -p train`(全バイナリ、125件)・`cargo test -p engine`(216件、2件ignore)全パス確認。engineは本タスクで変更していない。
- **OFF時のビット一致実証(要件2)**: `git stash`でT159差分を一時退避しHEAD(変更前)の`train_patterns_v3.rs`をビルド → `train_patterns_v3.exe --configs v3 --seeds 1 --epochs 2 --max-games 30 --output-dir <scratch>/t159-off-before`実行 → `git stash pop`で復元しビルド → 同じコマンドを`<scratch>/t159-off-after`に実行。両者の`v3-seed-1.bin`のSHA-256が完全一致:
  `5228350a01ded3cdb27093bfc0c8c78b70d63251827f94412b8c7748e4c2d687`(変更前後で同一)。
- **180kスモーク(要件7)**: リリースビルドの`train_patterns_v3.exe`をPowerShell `Start-Process`(detached、stdout/stderrをlogs/にリダイレクト)で起動し、Monitorツールでログをポーリング(Bash run_in_background・Monitor通知待ちのみへの依存はせず、ログ内容による完了判定)。
  - コマンド: `--configs v4 --seeds 1 --train-subset-size 180000 --subset-seed 42 --early-stop --early-stop-val-percent 5 --early-stop-patience 3 --max-epochs 30 --output-dir train/data/t159-earlystop-180k`(train/data/配下、gitignore対象。train/weights/には出力していない)
  - データセット: `dataset games=74024 train_games=66622 frozen_games=7402 early_stop_train_games=63306 early_stop_val_games=3316 train_samples=179974 val_samples=198595 frozen_samples=442995`
  - エポック推移(train_mse/train_mae/val_mae/is_best/stale、metrics.tsvより):
    | epoch | train_mae | val_mae | is_best | stale |
    |---|---|---|---|---|
    | 1 | 14.624441 | 15.957599 | true | 0 |
    | 2 | 13.558332 | 15.751307 | true | 0 |
    | 3 | 12.994754 | 15.791275 | false | 1 |
    | 4 | 12.405923 | 15.707431 | true | 0 |
    | 5 | 12.129383 | 15.864820 | false | 1 |
    | 6 | 11.750015 | 15.827852 | false | 2 |
    | 7 | 11.322366 | 15.727878 | false | 3(=patience) → 打ち切り |
  - 結果: `best_epoch=4 epochs_run=7 frozen_mse=495.641039 frozen_mae=17.201052 bytes=27986340`。train_maeは単調減少(過学習方向)なのに対しval_maeはエポック4を底に非単調(悪化→改善→悪化)に推移し、patience=3で正しく打ち切って**エポック4(最後のエポックではない)の重みを最終成果物として復元**したことを確認(`v4-seed-1-earlystop.bin`のSHA-256が`v4-seed-1-earlystop/best.bin`と完全一致、両者とも`d394ae3f6d49b6d06736dc7fe53206dced79e048901d0da678831f022a0cb223`)。
  - resume用checkpoint(`epoch-XX.bin`)は完了後に正しくクリーンアップされ、`run_dir`には`best.bin`/`best.meta`/`state.txt`のみが残ることを確認(`state.txt`: `epoch=7 best_epoch=4 best_val_mae=15.707430961643487 stale=3`)。
  - 所要時間: 実測1分未満(release build、開始05:00→完了05:01のログタイムスタンプ差)。
  - 後片付け: スモーク成果物(`train/data/t159-earlystop-180k/`)と一時ログ(`logs/t159-earlystop-180k*`)は確認後に削除済み(train/data/はgitignore対象、logs/もgitignore対象のため元々コミット対象外)。

### 完了サマリ

- 変更ファイル: `train/src/bin/train_patterns_v3.rs`のみ。
- `cargo test -p train`(全125件)・`cargo test -p engine`(216件、2 ignore)全パス。
- OFF時ビット一致: 変更前後でSHA-256完全一致(`5228350a01ded3cdb27093bfc0c8c78b70d63251827f94412b8c7748e4c2d687`)を`git stash`による前後比較で実証。
- 180kスモークで早期打ち切りの実動作(非単調val_mae・patience打ち切り・ベストエポック復元・checkpoint cleanup)を確認。
- `git status --short`: 本タスク由来の差分は`train/src/bin/train_patterns_v3.rs`のみ(一時ファイル・スモーク成果物は全て削除済み)。

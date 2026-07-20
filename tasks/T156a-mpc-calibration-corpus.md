---
id: T156a
title: MPC再校正(1/7): WTHOR校正コーパスと再開可能な深さ別測定基盤
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(エンジン系・設計レポート起点のためルーティング基準5)
attempts: 0
---

# T156a: MPC校正コーパスと測定基盤

## 目的

MPC再校正シリーズ(設計の正: `tasks/design/T156-mpc-recalibration-report.md`、裁定は `tasks/design/T156-mpc-recalibration-request.md` 冒頭)の第1段。**本番探索コードを変えず**、決定的な校正データ(WTHOR層化局面)と深さ1〜12の測定結果(score/nodes)を再開可能に生成する基盤を作る。

## 要件(設計レポート§(c) T156a 節に忠実に)

1. **局面抽出ツール**(新規、例: `train/src/bin/extract_mpc_positions.rs`): WTHOR(train/data/*.wtb)から空き21〜52を4帯(21-28/29-36/37-44/45-52)で層化抽出。ゲーム単位split(calibration/tuning/test=60/20/20)、1帯1局面/対局以下、完全同一盤面+手番の重複排除、対称形は潰さない(v4のD4非不変性のため)。固定seedで決定的。抽出は**pilot規模(各帯80×4=320局面)と確認規模(各帯300×4=1,200局面)の両方を1回で出力**(pilotは確認セットの部分集合=入れ子でよい)。
2. **出力**: `bench/edax-compare/t156_mpc_positions.json`(盤面+手番+空き+split+gameId、**コミット対象**)+ `t156_mpc_positions.meta.json`(WTHORファイルSHA-256・抽出seed・件数・出力SHA)。
3. **深さ別測定**: `engine/src/bin/calibrate_mpc.rs` を拡張(または新コマンド)し、各局面について深さ1〜12の score(centidisc)と nodes を測定して局面単位でアトミック保存・checkpoint/resume・進捗出力。評価は**v4重み(train/weights/pattern_v4.bin)**を使用(比較用にv2も測れる設計なら尚可だが必須ではない)。fixed-depth・aspiration/history OFF・exact_from_empties=0(設計レポートどおりMPC単体校正の条件)。決定的であること。
4. **後処理**: 測定結果から (empty_bucket, D, d) ごとの affine回帰(deep = a*shallow + b + residual)・残差σ・方向別tail統計を算出するスクリプト(Rust or Python)。pilot 320局面分の実測定と統計算出まで本タスクで実行し、結果を `bench/edax-compare/t156_mpc_pilot_measurements.*` 等に保存(Gate 1判定自体は次タスクT156b)。
5. **時間管理**: 深さ11-12は重い。pilot 320局面の測定はdetached+ポーリング(Bashバックグラウンド・Monitor通知依存は禁止=不達実績)。10分超は確実なので局面単位checkpoint必須。1,200局面のフル測定は本タスクではやらない(pilotのみ)。

## スコープ外

- MPC本体(mpc.rs/search.rs)の修正(T156c)、Gate 1の合否判定(T156b)、1,200局面のフル測定(T156e)
- app変更(Pages確認不要)

## 受け入れ基準

1. t156_mpc_positions.json(1,200局面+pilotフラグ or 入れ子指定)が決定的に再生成でき(2回実行で一致)、meta にWTHOR SHA・seed・件数が記録されている
2. pilot 320局面×深さ1-12の測定が完走し、checkpoint/resumeの実動作確認記録がある
3. 回帰・残差統計の算出結果が保存され、`cargo test -p engine`(触った場合)`cargo test -p train`(触った場合)全パス
4. 本番探索経路(search.rs等)に変更がないこと(git diffで確認可能)
5. 変更ファイルはパス明示でコミットしmainへpush、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 測定はCPU負荷があるため、他の重い処理(T155のE2学習等)と重ならないよう、開始前に `tasks/STATUS.md` の並行状況を確認する

## 作業ログ

(ワーカーが節目ごとに追記)

- 2026-07-20 17:38 JST (Codex): WTHOR 2000〜2024 の25ファイルから、空き21〜52を4帯、ゲーム単位60/20/20 split、1帯1局面/対局以下、盤面+手番の完全重複排除、固定seedで1,200局面を抽出する `extract_mpc_positions` を追加。各帯300（pilot 80）、全体1,200（pilot 320）を生成し、source WTHOR SHA-256・seed・件数・output SHA-256をmetaへ記録した。2回再生成で positions SHA `E86BF2383490CC356589C85307CDC85556288BD23CAE1A2594932CD70AD748DA`、meta SHA `305D8019CA652B6E2C292329DE6E927C8661F9DADB347F65D5951A267E5F1564` がそれぞれ一致。
- 2026-07-20 17:38 JST (Codex): `calibrate_mpc measure` を追加し、v4重み、fixed-depth、history/aspiration OFFの既存入口、`exact_from_empties=0`、独立TTで深さ1〜12のscore/nodesを測定。局面完了ごとの一時ファイル置換、条件fingerprint検証、resume、進捗、detached shard、検証付きmergeを実装した。`--max-positions 1` を2回実行してcheckpointが1件→2件へresumeすることを実確認。T155のPython/Edax終了後に開始し、単一detached実行を167件で安全に停止して4 shardへresume、ポーリングし、320局面×12深さを完走。共通167件の重複score/nodes一致をmerge時に検証し、欠損0件。完成JSONのresume再実行でSHA `D83BF1BC344C72F1602B999F135397255FED89E344838847799A61BDA8601F78` 不変。
- 2026-07-20 17:38 JST (Codex): `t156_mpc_stats.py` を追加し、各(empty bucket, deep depth D, shallow depth d)についてcalibration splitで affine回帰、残差sigma、split別方向tail、t=1.5/1.75/2.0超過率、shallow/deep node比中央値を算出。4帯×66深さペア=264グループを `t156_mpc_pilot_stats.json` に保存。
- 実行確認: `cargo test -p engine` = 200 passed / 2 ignored、`cargo test -p engine --release --test ffo_bench` = fast 1 passed / heavy 1 ignored、`cargo test -p train` = 全ターゲット成功（lib 87 passedを含む）、抽出bin 3 passed、統計script self-test passed、`git diff --check` 成功。本番探索 `engine/src/search.rs` / `engine/src/mpc.rs` は差分なし。最初の連続受け入れコマンドは全体timeoutになったがengine全テストとFFO成功出力まで確認済みで、未実行だったtrain全テストを直後に単独再実行して成功。
- コミット: 未実施（.git書き込み禁止のため、オーケストレーター代行待ち）。

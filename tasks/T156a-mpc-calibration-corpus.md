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

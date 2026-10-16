---
id: T207
title: 平滑化重みの本番配線と中盤練習の一致率再計測
status: done
assignee: implementer
attempts: 0
---

# T207: 平滑化重みの本番配線と中盤練習の一致率再計測

## 着手条件
T205(または T206)のレポートで採用候補が強度ゲートを通過し、オーケストレーター/ユーザーが採用を裁定していること。

## 目的
採用された平滑化重みを本番の評価関数として配線し、評価値の揺れの改善を本番で反映する。中盤練習の参照最善手一致率(現状 22/38)の変化を記録する。

## 背景・コンテキスト
- 前例: T171(`tasks/T171-d1-production-wiring.md`、pattern_v6 の本番配線)。手順は全面的にこれを踏襲する。
  - `app/src/engine/worker.ts` の `PATTERN_WEIGHTS_URL` 差し替え
  - 切り戻しコメントの更新
  - ANALYSIS_ENGINE_VERSION の繰り上げ(解析キャッシュの混在防止)
  - WASM ゲートスクリプトの更新: `app/scripts/test-pattern-v6-wasm.mjs`、`test-node-budget-wasm.mjs`
  - golden 値の再取得(理由を記録する)
  - native と WASM の評価値一致確認
- 中盤練習は偶数深さ統一(T202)のまま運用する。

## 要件(概要。着手時に採用候補の名前・ファイルを確定して具体化する)
1. 採用候補の bin を `app/public/` に配置し、T171 と同じ配線・ゲート更新を行う。
2. 中盤練習 38問の参照最善手一致率と平均解析時間を、新重みで再計測して記録する(v6: 22/38、平均1.33秒/最大1.49秒)。
3. 本番の確認(標準ルール): push → Actions デプロイ成功 → Playwright で https://giwarb.github.io/othello-trainer/ を確認する。
   - 対局 CPU の応手、評価バー、中盤練習の結果画面グラフ、新重みの取得が 200、コンソールエラーなし。

## やらないこと(スコープ外)
- 重みの再作成
- 探索の変更
- 中盤練習の深さ採用方針(偶数深さ統一)の変更

## 受け入れ基準(検証コマンド)
- 着手時に T171 の受け入れ基準を雛形に具体化する。
- タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## 作業ログ(担当エージェントが追記)

### 2026-10-16 オーケストレーター(直接実施、例外適用)

- `app/public/pattern_v7.bin` 追加、`worker.ts` URL を v7 へ、`ANALYSIS_ENGINE_VERSION` 8→9、`test-pattern-v6-wasm.mjs`→`test-pattern-v7-wasm.mjs`、`test-node-budget-wasm.mjs` の問題86期待値を e1 に(手順は「最善手」指定で重み非依存に)、engine の問題86本番予算テストを v7/e1 に。engine lib 262件・app vitest 882件・`npm run build`(WASMゲート込み)パス。コミット a0aad10。Pages 実機確認は下記に追記。

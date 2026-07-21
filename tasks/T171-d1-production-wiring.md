---
id: T171
title: D1候補の本番配線 — pattern_v6として公開(ユーザー採用裁定済み)
status: todo
assignee: implementer
attempts: 0
---

# T171: D1候補の本番配線

## 目的

T169ゲートで現行v5に+4.53石(CI[+1.78,+7.33]、p=0.043)の有意改善を示したD1候補(V3+corner5x2、PWV6形式)を、**ユーザー採用裁定(2026-07-21、サイズ増gzip 10.7MB了承済み)**に基づき本番配線する。前例: T167(v5配線)。

## 対象重み

- `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`(SHA-256は `bench/edax-compare/t168_training_report.meta.json` のt169Manifestが正。実測照合)
- 配置名: **pattern_v6.bin**(`train/weights/` と `app/public/` の両方。既存v2〜v5は切り戻し用に残す)

## 要件(T167と同型)

1. 重み配置+SHA一致確認。
2. WASM経由でPWV6+新形状(corner5x2込み46インスタンス)が読めてscalar有効なことのヘッドレス確認。**ゲートスクリプトの更新**: `app/scripts/test-pattern-v5-wasm.mjs` を v6用に更新(またはv6版を新設し旧版を置換)、`test-node-budget-wasm.mjs` も v6参照へ(T170でv5化した直後だが本番追従が正)。goldenの再取得は理由記録の上で行う。
3. `worker.ts` fetch先を pattern_v6.bin へ、`cache.ts` の **ANALYSIS_ENGINE_VERSION を8に繰り上げ**。切り戻しコメント維持(戻す場合は9へ)。
4. サイズ実測(raw/gzip)記録。
5. 全テストパス(app 832+/engine/train)。
6. **本番検証(標準ルール)**: push→Actionsデプロイ成功→Playwright/ブラウザ自動操作で本番URL確認(対局CPU応手・評価バー・解析動作・pattern_v6取得200・コンソールエラーなし)。
7. 強度スモーク: ネイティブとWASMで数局面の評価値一致(取り違え防止)。

## スコープ外

- 探索・プロトコル変更、量子化(バックログ)、レガシー削除

## 受け入れ基準

1. 本番Pages実機確認(要件6)の記録
2. 版数8繰り上げ・ゲートスクリプトv6化・切り戻しコメント
3. WASM経由の読込確認記録
4. 全テストパス、完了時 `git status --short` クリーン(パス明示コミット+push。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

(ワーカーが節目ごとに追記)

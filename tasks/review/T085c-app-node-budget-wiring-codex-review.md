# T085c 最終レビューレポート

レビュー対象:

- `git log 47926ef..6e46d5b`
- `git diff 47926ef..6e46d5b`
- 対象コミット: `6e46d5b`
- 変更ファイル:
  - `engine/src/protocol.rs`
  - `app/scripts/test-node-budget-wasm.mjs`

## (a) 重大（done を止めるブロッカー）

### 1. redo後の本番デプロイ成功・Playwright確認の完了を確認できない

redo #1 の修正自体は `origin/main` までpush済みであることを確認した一方、受け入れ基準で要求されている以下の証跡が作業ログにありません。

- 修正後コミットを含むGitHub Actionsデプロイの成功
- 修正後の本番URLで、Playwrightによる対局モード・強いCPUの正常着手確認

`gh run list`による確認も実行しましたが、レビュー環境のネットワーク制限によりGitHub APIへ接続できず、独立確認できませんでした。redo #1 のフィードバックでも「再度必要」と明記されているため、現時点では受け入れ基準未達です。

コード上のブロッカーではありませんが、done判定を止める受け入れ手続き上のブロッカーです。

## (b) 中（次タスクで対応すべき）

### 1. 校正ハーネスと本番EngineでTT容量が異なる

本番WASMの `Engine` は64 MiBのTTを使用しています。

- [engine/src/lib.rs](C:/Users/yoshi/work/othello-trainer/engine/src/lib.rs:86)

一方、T085bの校正に使われた `eval_cli best` は16 MiBです。

- [engine/src/bin/eval_cli.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/eval_cli.rs:667)

今回の `tt.clear()` により過去探索への依存は解消されますが、TT容量までT085bの校正条件と一致するわけではありません。160kノード内でも衝突・置換状況が変わり得るため、「校正条件と完全に一致」という説明は厳密には成立しません。

本タスクの明示要件はTTを空にして決定性を回復することであり、現在の実測でも要求された結果が得られているためブロッカーとはしません。今後の校正では、本番とベンチのTT容量を統一するか、校正メタデータにTT容量を明記すべきです。

## (c) 軽微（記録のみ）

指摘なし。

redo #1 の修正内容については、以下を適切に満たしています。

- `allMoves + maxNodes` のエラー判定より後へ副作用が漏れていない。
- `maxNodes` 指定の非`allMoves`探索直前だけ `tt.clear()` を実行している。
- `maxNodes` 未指定の分岐は従来の `search_with_eval` のままである。
- Rustテストは同一 `Engine`、本番重み、本番強CPU設定で連続実行している。
- 介在する `allMoves` 探索後も move/score/depth/nodes の一致を検証している。
- WASMビルド後テストも同じ条件を再現している。
- `train/weights/pattern_v2.bin` と `app/public/pattern_v2.bin` のSHA-256は一致している。
- `git diff --check 47926ef..6e46d5b` は成功した。
- 対象差分にスコープ外の変更はない。
- 現在の作業ツリーはクリーンである。

## (d) 総合判定

**不合格**

redo #1 のコード修正は妥当であり、前回の決定性ブロッカーは解消されています。適用範囲、通常経路の維持、同一Worker相当の回帰テストにも問題は見当たりません。

ただし、必須受け入れ基準である修正後のGitHub Actionsデプロイ成功と、本番URLに対するPlaywright確認を完了した証跡がないため、現時点ではdoneにできません。これらを実施・記録できれば、コードの再修正なしで合格と判断できます。
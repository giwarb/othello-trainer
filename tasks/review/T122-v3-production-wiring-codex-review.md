# T122 最終レビューレポート

対象: `git diff 1da4331..66958ea` / `git log 1da4331..66958ea`

## (a) 重大（doneを止めるブロッカー）

なし。

初回レビューで未完了だったPages実機確認・Actions成功確認は、オーケストレーター注記にある独立verifierの検証により解消済みです。

## (b) 中（次タスクで対応すべき）

1. ロールバックコメントが解析キャッシュ更新を案内していない

[app/src/engine/worker.ts:32](C:/Users/yoshi/work/othello-trainer/app/src/engine/worker.ts:32) は「ファイル名を`pattern_v2.bin`へ戻すだけ」と説明しています。しかし評価重みを戻す場合、`ANALYSIS_ENGINE_VERSION`も再度上げなければ、v3で保存された解析結果がv2環境でヒットします。

作業ログの切り戻し手順は「URL変更＋バージョン繰り上げ」と正しく、受け入れ基準自体は満たしています。実動作にも影響しないためブロッカーではありませんが、コメントだけを参照した将来の切り戻しで回帰するリスクがあります。次に同ファイルを変更する際、2箇所の変更が必要な旨へ修正すべきです。

## (c) 軽微（記録のみ）

1. 重みREADMEにv3対応前の説明が一部残っている

[train/weights/README.md:15](C:/Users/yoshi/work/othello-trainer/train/weights/README.md:15) ではPWV3対応を説明している一方、後続の説明が「どちらの重みファイル」「eval_cliはv1/v2どちら」となっています。実装はPWV3も処理できるため、「v1/v2/v3」または「いずれの形式」に更新すると正確です。挙動への影響はありません。

## 確認結果

- 対象コミットは1件で、コミットメッセージに`(T122)`を含みます。
- v3重みは以下の3配置ですべて5,964,708 bytes、SHA-256 `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`で一致しています。
  - 採用元 `train/data/t087/v3-seed-3.bin`
  - `train/weights/pattern_v3.bin`
  - `app/public/pattern_v3.bin`
- v2重みは`train/weights`と`app/public`の両方に残っており、コード上の切替も1行です。
- Workerは応答処理前に重みのfetch・ロードを完了し、`PatternWeights::from_bytes`はPWV3を識別・検証して読み込めます。
- 対局、評価バー、候補手評価、棋譜解析、各練習モードは共有Worker経由で同じ重みを利用します。詰めオセロの完全読みは静的評価重みに非依存です。
- [app/src/analysis/cache.ts:80](C:/Users/yoshi/work/othello-trainer/app/src/analysis/cache.ts:80) は`ANALYSIS_ENGINE_VERSION = 4`で、T107コメントもquota非依存という正しい説明に修正されています。
- Service Workerはビルドごとに一意なキャッシュバージョンを注入し、activate時に旧キャッシュを削除します。`pattern_v3.bin`は新規URLとして取得・キャッシュされます。
- 決定性検証スクリプトもv3重みへ更新されています。
- 作業ログ上、エンジンテスト、FFO #40–44、appテスト596件、TypeScript検査、WASM一致・決定性検証が合格しています。
- 独立verifierによりActions 2 runの成功、Pages上の対局CPU強・評価バー・候補手評価・詰めオセロ・棋譜解析、v3重みのHTTP 200とサイズ、コンソールエラー0が確認済みです。
- `66958ea`は`main`および`origin/main`に含まれ、確認時の`git status`はクリーンです。
- 差分は仕様に必要な8ファイルに限定され、`tasks/`、`CLAUDE.md`、定石DB、終盤ソルバーの変更はありません。

## (d) 総合判定

**合格**

v3重みの本番配線、PWV3ロード、解析キャッシュ無効化、Service Workerのキャッシュ更新、v2ロールバック可能性、単体・FFO・WASM・app検証、ActionsおよびPages実機確認まで、受け入れ基準を満たしています。

中・軽微の2点はいずれもコメント・文書の精度に関する申し送りであり、現在の正しさや本番動作を損なわないため、T122のdoneを妨げません。
# T122 最終レビューレポート

レビュー対象: `1da4331..66958ea`  
対象コミット: `66958ea` 1件

## (a) 重大（doneを止めるブロッカー）

### 1. 本番Pages実機確認とActions成功確認が未完了

受け入れ基準で必須の以下について、完了証跡がありません。

- GitHub Actionsのデプロイ成功
- 公開Pagesでの対局CPU（強）
- 棋譜解析
- 評価バー
- 詰めオセロ
- 公開Pagesからの`pattern_v3.bin`取得（HTTP 200）

作業ログでも、ローカルHTTP確認までに留まり、実機操作と本番確認が未実施であると明記されています。[T122作業ログ](C:/Users/yoshi/work/othello-trainer/tasks/T122-v3-production-wiring.md:69)

現在の`origin/main`は対象コミットを含むためpush自体は確認できますが、Actionsの成功と公開Pagesの動作確認まではリポジトリ履歴から証明できません。ブラウザ接続および外部HTTP接続も利用できず、レビュー環境からの代替確認はできませんでした。

これは目的の「GitHub Pagesに公開する」と受け入れ基準を直接満たしていないため、doneを止めるブロッカーです。

## (b) 中（次タスクで対応すべき）

### 1. Worker内のロールバック説明が不完全で、解析キャッシュ混在を招く

[worker.ts](C:/Users/yoshi/work/othello-trainer/app/src/engine/worker.ts:32)には、v2への切り戻しはファイル名を戻すだけでよいと書かれています。

しかし、その1行だけでは`ANALYSIS_ENGINE_VERSION=4`のままなので、v3で保存された棋譜解析キャッシュがv2切り戻し後にもヒットします。正しい手順は作業ログにあるとおり、重みURL変更に加えて[cache.ts](C:/Users/yoshi/work/othello-trainer/app/src/analysis/cache.ts:69)のバージョンを再度上げる2行変更です。

実運用時にソースコメントだけを参照すると不整合を起こすため、コメントにも解析エンジンバージョン更新が必要であることを明記すべきです。

## (c) 軽微（記録のみ）

### 1. 重みREADMEにv3対応後も古い説明が残っている

[train/weights/README.md](C:/Users/yoshi/work/othello-trainer/train/weights/README.md:5)は`pattern_v2.bin`を「現行の学習出力」と説明し、同ファイルの[18行目](C:/Users/yoshi/work/othello-trainer/train/weights/README.md:18)では`eval_cli`がv1/v2のみ利用可能であるように記載しています。

同READMEにPWV3本番採用の説明を追加した以上、v3対応済みの実態に合わせて表現を整理した方がよいです。実行時の不具合ではありません。

### 2. 実装本体には明確な配線不良は見つからなかった

独立確認できた事項は以下です。

- 採用元、`train/weights`、`app/public`のv3バイナリはすべて5,964,708 bytes
- 3ファイルのSHA-256は指定値`d815dd6f...bc0de92`で一致
- ヘッダーは`PWV3`、version 3
- Workerは`pattern_v3.bin`をロード
- `ANALYSIS_ENGINE_VERSION`は4
- v2バイナリは両配置に残存
- `PatternWeights::from_bytes`からPWV3ローダーへ到達可能
- Service Workerはビルドごとのキャッシュ名を使い、activate時に旧キャッシュを削除
- 対局・解析・中盤練習等は共有Workerを利用
- 変更は定石DB・終盤ソルバー・UI切替へ波及していない
- `git diff --check`に問題なし

作業ログ上では、エンジンテスト、FFO #40–44、appテスト、型チェック、eval_cli/WASM一致、決定性検証はいずれもPASSと記録されています。

## (d) 総合判定

**不合格**

コード上のv3配線、バイナリ同一性、解析キャッシュ更新、Service Workerの既存更新機構との整合には重大な欠陥を認めません。

ただし、本タスクは「本番Pagesへの公開と実機確認」までを明示的な目的・受け入れ基準としており、その証跡がなく、作業ログでも未実施とされています。Actions成功と公開Pagesでの各機能・v3取得200を確認して記録するまで、T122をdoneにはできません。加えて、ロールバックコメントはキャッシュ版更新を含む正しい2行手順へ修正することを推奨します。
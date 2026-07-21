---
id: T167
title: 候補C(Egaroucid B3-canonical、PWV6)の本番配線 — pattern_v5として公開
status: todo
assignee: implementer
attempts: 0
---

# T167: 候補Cの本番配線

## 目的

T166対局ゲートで対現行v4 **+17.37石(95%CI[+13.97,+20.87]、p<0.0001)** の有意改善を示した候補C(Egaroucid全量25.5M×B3特徴×D4 canonical、PWV6形式)を本番アプリに配線し、GitHub Pagesで公開する。前例: T122(v3配線)・T147(v4配線)。

## 対象重み

- `train/data/t165/egaroucid-b3/t158-b3-canonical-seed-1-earlystop.bin`
- SHA-256: `9ce0cc05...`(t165_training_report.meta.json の t166Manifest が正、実測照合すること)
- 配置名: **pattern_v5.bin**(T158設計裁定の命名: 採用時はv5)

## 要件

1. **重みの配置**: 上記binを `train/weights/pattern_v5.bin` と `app/public/pattern_v5.bin` に配置(コピー、SHA一致確認)。既存 pattern_v4.bin は残す(切り戻し用)。
2. **WASM/エンジン経路のPWV6対応確認**: engineのfrom_bytesはPWV6対応済み(T164)だが、**WASMビルド経由で実際にPWV6が読めてscalar特徴が有効になること**をヘッドレステスト等で確認(T158a/T163のWASM検証の前例に倣う)。engine側の追加変更が必要なら最小限で行い報告。
3. **アプリ配線**: 重みのfetch先を pattern_v5.bin に切り替え(worker.ts等、T147の変更箇所を踏襲)。Service Workerのキャッシュ対象リスト・キャッシュ版数の更新。**ANALYSIS_ENGINE_VERSION を7に繰り上げ**(評価値が変わる変更のため必須。cache.ts)。切り戻しは「fetch先をv4に戻す+版数再繰り上げ」の1手順で可能なようにコメントを残す(T122前例。ロールバックコメントには版数繰り上げ必須の旨を明記=T122申し送りの解消)。
4. **配信サイズ確認**: pattern_v5.bin のサイズとgzip後サイズを記録(v4比)。著しく増える場合は報告(ブロッカーではない)。
5. **テスト**: 既存のapp/engineテスト全パス。重み切替に伴い期待値が変わるテストがあれば、変更理由を作業ログに記録して更新。
6. **本番検証(標準ルール)**: mainへpush→GitHub Actionsのデプロイ成功を確認→Playwrightで本番URL(https://giwarb.github.io/othello-trainer/)にアクセスし、(a)対局でCPUが着手する (b)評価バーが動く (c)解析が動く (d)pattern_v5.binが200で取得される (e)コンソールにエラーがない、を確認。
7. **強度スモーク(軽)**: 配線後のローカルビルド(またはNode headless)で数局面の評価値が候補C重みのネイティブ評価と一致することを確認(取り違え防止)。

## スコープ外

- 対局プロトコル・探索パラメータの変更
- Egaroucidデータ・学習の再実行
- レガシー重みファイルの削除

## 受け入れ基準

1. 本番Pages URLで新重みが動作している実機確認(上記6の(a)-(e))の記録がある
2. ANALYSIS_ENGINE_VERSION繰り上げ済み、SWキャッシュ整合、切り戻し手順のコメントあり
3. WASM経由のPWV6読込+scalar有効の確認記録がある
4. 全テストパス、`git status --short` クリーン(変更はパス明示コミット+push。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- コミットメッセージは `app:`/`engine:` プレフィックス+`(T167)`。作業ログ節目追記

## 作業ログ

(ワーカーが節目ごとに追記)

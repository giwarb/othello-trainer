# T147 最終コードレビュー(Claude代替レビュー、Codex usage limit中のフォールバック)

- 対象: コミット 3f8a95f(app/src/engine/worker.ts、app/src/analysis/cache.ts、app/scripts/test-node-budget-wasm.mjs、train/weights/README.md、pattern_v4.bin×2)
- 総合判定: **合格**(重大・中なし、軽微3件)

## 確認済みの事実

- 重み同一性: 両pattern_v4.binを実測ハッシュし、T125選定候補(seed3、SHA-256 c372b833...639e383f、27,986,340 bytes)と完全一致。
- 配線網羅: 重みfetch箇所はworker.tsの1箇所のみ(v4切替済み)。pattern_v3残存参照はすべて意図的(切り戻しコメント/README/歴史的記録/ツール名)。配線漏れなし。
- ANALYSIS_ENGINE_VERSION 6: 評価値を永続化するストアを全数確認(appDb 5ストア+localStorage)。バージョン追従が必要なのはanalysisCacheのみで対応済み、他ストアは評価値キャッシュでないため追従不要。
- SWキャッシュ: pattern_v4.binは新規URLで初回必ずネットワーク取得。旧クライアントのpattern_v3.bin要求も残置配信で悪影響なし。整合。
- エンジンロード経路: PWV3のnum_stages自己記述で61段を明示受理(T124導入、ラウンドトリップテスト有)。追加実装不要の判断は妥当。失敗時はheuristicフォールバックでv3誤用経路なし。
- T122レビュー中指摘(切り戻しコメントのバージョン注意欠如)は本コミットで解消。
- スモーク手法(決定性テスト・10局異常検出)は妥当。0勝10敗はT125の60局結果と整合し、ゲート外の扱いはタスク前提どおり。

## 軽微(記録のみ)

1. engine/src/protocol.rs:933 と pattern_eval.rs:871-873 の「本番=v3」コメントが陳腐化(内容は正しく版名のみ)。次に当該ファイルを触るタスクで更新。
2. 10局スモークの縮小openingsがscratchpadのみで非保存(harness metaから復元可、実害なし)。
3. protocol.rsのテストが「production weights」と称してpattern_v2.binを使用(T122以前からの残置、挙動影響なし)。

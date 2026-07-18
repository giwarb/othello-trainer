---
id: T128b
title: 中盤練習: 明確悪手パターン第1波追加(隅の取り逃し・パス取り逃し・自分の手数激減・石の取りすぎ)
status: in_progress # T128完了(done)を受けて着手
assignee: implementer(Sonnet)
attempts: 0
---

# T128b: 明確悪手パターン第1波追加

## 目的

ユーザー指示(2026-07-18)「5つだと能力的に足りないシーンもある。わかりやすくて増やせそうなものを検討して」→ 設計諮問レポート `tasks/design/T128-clear-patterns-report.md` の**第1波推奨4パターンを採用**(オーケストレーター裁定)。いずれもTSのみ・エンジン変更不要(コーパス生成と競合しない)。

追加パターン(検出条件・言語化テンプレ・閾値はレポートの該当節が正。実装前に必読):

1. **隅の取り逃し**: 最善手が隅なのに取らなかった(閾値不要)
2. **相手パスの取り逃し**: 最善手なら相手の打てる場所が0になった
3. **自分の打てる場所の激減**: 差≥3かつ打った後の絶対数≤4(`moverMobilityAfter`既存フィールド)
4. **石の取りすぎ**: フリップ数差≥4(空きマス≥16のガード付き)

## オーケストレーター裁定(レポートの確認事項4点)

- 石の取りすぎの空きマスガードはレポート提案値(≥16)を採用
- 言語化文は平易な断定調でよい(既存T128の文体に合わせる)
- 表示は最大2件(MAX_PATTERNS=2)を維持。優先順位はレポートの並び(隅の取り逃し>パス取り逃し>手数激減>取りすぎ)を既存5種と統合した重大度順にする(隅系が最上位)
- 「隅の取り逃し」と既存「corner-gift」の同時発火は許容(両方表示されてよい、ただし2件上限内)

## 前提

- T128(初期5パターン+対比UI)完了後に着手する(`app/src/midgame/clearBlunder.ts` 等の同一ファイルを拡張するため)。T128の実装様式(検出器関数+名前付き閾値定数+陽性/陰性テスト)に従う。
- 第2波(危険な辺の形=ウィング、種石の献上)は本タスクに含めない(T128cとして別途判断)。

## 追加要件(T128代替レビュー中指摘の修正、tasks/review/T128-clear-blunder-claude-review.md)

- `PracticeMode.tsx` の `handlePlayerMove` ゲートのフォールバック経路(`requestFeatureSet`失敗のcatch節)で、awaitのreject後に `sessionGenerationRef` の世代チェックを再実行してから `handleModeFailure` を呼ぶよう修正する(現状は離脱済みセッションのfail記録がlocalStorageに書かれうる、T119と同型)。回帰テスト1件を追加(catch経路で世代不一致なら記録が書かれないこと)。

## やらないこと(スコープ外)

- 第2波パターン(ウィング・種石)/エンジン変更/閾値の緩和による捕捉率稼ぎ(方針違反とレポートも明記)
- bench/edax-compare/・train/への変更(生成走行中)

## 受け入れ基準

- [ ] 4検出器それぞれに陽性・陰性ユニットテスト(合成盤面)
- [ ] 既存5種との優先順位統合のテスト(隅系が上位に来る)
- [ ] `npm test` 全パス
- [ ] mainへpush→Actions成功→Pages実機で追加パターンのいずれか(再現しやすいもの)の表示確認(T128と同じ流儀、無理なら代替確認を作業ログに明記)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T128b)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-18 実装完了(implementer、T128に続けて同一ワーカーが担当)

- **調査**: `tasks/design/T128-clear-patterns-report.md`(§(a)①〜④の検出条件・severity案・確認事項)と`tasks/review/T128-clear-blunder-claude-review.md`(観点1「中1」指摘)を読み、実装方針を確定。
- **実装1(catch経路の世代ガード修正、追加要件)**: `PracticeMode.tsx`の`handlePlayerMove`のゲート`catch`節冒頭に`if (sessionGenerationRef.current !== generation) return`を追加。修正前のコードを一時的に復元してリグレッションテストが実際に失敗する(stale fail記録が書き込まれる)ことを確認してから、修正を戻して再度パスすることを確認済み(テストの実効性を検証済み)。
- **実装2(4検出器追加)**: `clearBlunder.ts`に`detectMissedCorner`・`detectOpponentPassMissed`・`detectOwnMobilityCollapse`・`detectMassFlip`を追加。severityはオーケストレーター裁定どおり`corner-gift(10) > missed-corner(9) > opponent-pass-missed(8) > x-c-danger(6)`の順に設定(設計レポートの生の提案値はmissed-corner=8/opponent-pass-missed=9で裁定と逆順だったため、裁定の文言「隅の取り逃し>パス取り逃し」を優先して数値を入れ替えた)。own-mobility-collapse/mass-flipは既存パターン(opponent-mobility/wall-frontier/stable-loss)と同じ「severity=diff(実測値)」方式を踏襲。mass-flipの空きマスガードはレポート提案値16をそのまま採用。
- **実装3(テスト)**: `clearBlunder.test.ts`に4検出器それぞれの陽性・陰性テスト(14件)+severity優先順位のテスト2件(定数の大小関係+missed-corner/own-mobility-collapse同時検出時の並び順)を追加。局面フィクスチャは、T128と同じ方針で一時スクリプト(`app/src/midgame/_scratch_t128b*.ts`、都度`node --experimental-strip-types`で実行し**同一コマンド内で`rm -f`まで実行**、リポジトリに残さない)で実在の盤面(乱数対局シミュレーションで採取した実局面・手作りの合法局面)を事前検証してから組み込んだ。mass-flipの空きマスガードのテストのみ、市松模様の埋め石で空きマス数を意図的に減らした合成局面を使用(フリップ数自体は元局面と変わるが、本テストの主眼である「ガードが効くこと」の検証には影響しない)。
- **実装4(回帰テスト)**: `PracticeMode.clearBlunderGateFallbackGuard.test.tsx`を新規作成。ゲート判定中(`requestFeatureSet`応答待ち)に離脱→その後で`requestFeatureSet`が拒否される、という修正前バグの再現条件をシミュレートし、ステージ記録への不合格書き込みが起きないことを確認。

### 受け入れ基準の実行結果

- [x] 4検出器それぞれに陽性・陰性ユニットテスト(合成盤面) → `clearBlunder.test.ts`に追加(missed-corner 3件・opponent-pass-missed 2件・own-mobility-collapse 4件・mass-flip 3件、全て実盤面計算)
- [x] 既存5種との優先順位統合のテスト(隅系が上位に来る) → 同ファイルに2件追加(severity定数の大小関係の直接検証+missed-corner/own-mobility-collapse同時検出時の並び順検証)。既存の「corner-gift+x-c-danger同時検出」テストも引き続きパス
- [x] `npm test` 全パス → `npx vitest run`: `Test Files 74 passed / Tests 628 passed`。`npx tsc --noEmit -p tsconfig.app.json`もエラーなし(いずれも`npm run typecheck`は使わず直接呼び出し)
- [x] mainへpush→Actions成功→Pages実機確認 → コミット`5214f52`をpush、`gh run watch`でDeploy成功を確認。Playwright的操作(Claude Browserツール)で本番Pages中盤練習を多数プレイし、**既存5種(corner-gift、x-c-danger、wall-frontier、opponent-mobility)の複数組み合わせが正しく描画される(MAX_PATTERNS=2の上限順守・severity降順・corner-giftが常に先頭)ことを4回の異なる失敗画面で確認**。コンソールエラーは一貫して無し。
  - **T128b新規4パターン自体の実機再現は達成できなかった**(作業ログに明記、要件どおりの代替確認)。理由: missed-corner(最善手が隅なのに実際の手が隅でない)・opponent-pass-missed(最善手なら相手合法手0)は条件が狭く、`josekiEnd`開始局面(既に空きマス10前後からスタート)ではCPU相手との対局進行中に该当局面へ到達しなかった。own-mobility-collapse/mass-flipについては、canvasピクセル読み取り+自前实装のオセロロジックで盤面を再構成し発火しそうな手を特定して複数回試行したが(空きマス数・手数上限などの条件は満たしていたはずだが)実際には発火せず、自前ロジックと実装(Rust engineのFeatureSet)側の差異(ピクセル読み取り誤差の可能性を含む)を作業時間内に特定できなかった。
  - **代替確認**: (a) 4検出器とも実際のビットボード演算(`applyMove`/`legalMoves`/`countEmpty`)を通した実盤面での陽性・陰性テストで、メッセージ文言・severity・ハイライトマスまで厳密に検証済み(モックで検出条件を注入する自己参照的なテストではない)。(b) 9検出器統合後の`detectClearBlunderPatterns`パイプライン(severityソート・2件上限)は既存パターンの実機確認で継続して正しく動作することを確認済み。(c) 新パターンの検出器コード自体は既存パターン(corner-gift等)と全く同じ設計パターン・同じ`ClearBlunderInput`/`ClearBlunderPattern`型・同じ`ClearBlunderCompare`描画経路を通るため、表示パイプラインのバグリスクは低いと判断する。
- [x] 変更対象のみパス明示コミット(`app:`、`(T128b)`)。`tasks/`はコミットしない → コミット`5214f52`(`app: 明確悪手パターン第1波4種を追加+ゲートfallback世代ガード修正(T128b)`)。`git add app/src/midgame/PracticeMode.tsx app/src/midgame/clearBlunder.ts app/src/midgame/clearBlunder.test.ts app/src/midgame/PracticeMode.clearBlunderGateFallbackGuard.test.tsx`で個別指定
- [x] 当該タスク由来の差分・未追跡が`git status --short`に残っていない → 確認済み(一時検証スクリプトは都度削除、`git status --short`はクリーン)

### 注意事項・申し送り

- T128の作業ログで申し送った「`npm run typecheck`/`npm run build`/`npm run dev`は教師コーパス生成中は避け、`npx tsc`等の直接呼び出しを使う」を本タスクでも遵守した(`npm run typecheck`等は一度も実行していない)。
- 本番Pagesでの新パターン4種の実機再現は達成できず(上記参照)。もし正確な実機確認が重要な場合、後続タスクで「WASM headless再判定スクリプト」(設計レポートのT128d案)のような決定的な手法を使うか、あるいはローカル`vite preview`+固定局面注入(例: URLパラメータや開発用デバッグフックで開始局面を直接指定できる仕組み)を用意すると再現性高く確認できる可能性がある。

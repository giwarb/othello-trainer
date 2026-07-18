---
id: T140
title: 対局: 1手戻る(undo)機能(研究用)
status: done # verifier/代替レビュー合格(2026-07-19)。中1(全戻し時トレース残留、表示のみ)は申し送り
assignee: implementer(Sonnet)
attempts: 0
---

# T140: 対局の1手戻る

## 目的(ユーザー指示 2026-07-19 朝)

「対局では研究もしたいので、1手戻るの機能もつけてほしい。」評価値常時表示(T138)と組み合わせ、任意の局面まで戻して打ち直せるようにする。

## 仕様

1. 対局モードに**「1手戻る」ボタン**(投了・新規対局の並び、セカンダリ)。
   - CPU対戦: 押すと**自分の直前の手の直前まで**戻る(CPUの応手+自分の手の2plyを取り消し、自分の手番に戻る)。CPUが思考中でも押せて、その場合は自分の直前の手のみ取り消し(思考中のCPU応手は破棄)。
   - 2人対戦: 1ply戻す。
   - 終局後も押せる(研究用)。履歴が空なら非活性。
2. **実装方針**: `moveHistory`(T132、`app/src/game/gameHistory.ts`)を正とし、undo時は「初期局面から履歴prefixをリプレイして`GameState`を再構築」する(パスは既存のリプレイ規約で自動再現)。`displaySequencerRef.reset(next)`で表示を即時同期(T134のキュー残骸を破棄)。**CPU着手effectの世代ガード**: 進行中の`requestCpuMove`結果がundo後に適用されないよう、対局世代ID(ref)を導入しundoでインクリメント、effect解決時に照合(T115/T119の教訓に従い、新規effectは増やさず既存構造への加算で)。
3. 盤面自由配置(非標準初期局面)の対局ではボタンを出さない(T132の`standardStart`と同じ条件。リプレイが初期局面前提のため)。
4. undo後、評価値表示・定石トレース(T138)・「振り返る」導線が巻き戻った状態と整合すること(moveHistory truncateにより自動で整合するはず。トレースの「(離脱)」状態も再計算)。
5. 悪手判定(悪手時のフィードバック表示があれば)や評価バーはundo後の局面で通常どおり動く。

## やらないこと(スコープ外)

- 進む(redo)/分岐ツリー表示(将来候補) / 中盤練習・詰めオセロへのundo(T141が別途)
- bench/・train/への変更(生成走行中)。`npm run typecheck`/`npm run dev`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`と`npx vite`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] コンポーネントテスト: CPU戦で2手進めundo→1手目直後の自分の手番に戻る/思考中undo→CPU応手が適用されない(世代ガード)/2人対戦は1ply/履歴空で非活性/終局後undo可/非標準開始で非表示
- [ ] undo後にmoveHistory・定石トレース・評価表示が整合するテスト(振り返る棋譜がundo後の履歴と一致)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→本番Pagesで: CPU対局を数手→1手戻る→打ち直し→思考中に戻る、の一連を確認(375x812・844x390)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T140)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-19 実装着手。`git pull --rebase`実行(既に最新、変更なし)。既存実装調査:
  `app/src/game/gameHistory.ts`(T132、`appendPlayedMove`/`isStandardStartPosition`)、
  `app/src/game/gameLoop.ts`(`createGame`/`playMove`/`requestCpuMove`)、
  `app/src/game/displayQueue.ts`(T134の直列化キュー)、`app.tsx`のCPU着手effect
  (T115の`cancelled`クロージャ)・`moveHistory`/`standardStart`state・
  投了/新規対局ボタン周りを確認。
- `gameHistory.ts`に`replayMoves`(初期局面から履歴を順にplayMoveで再生)・
  `computeUndoLength`(vsHumanは単純に-1、CPU対戦は履歴を先頭から再生して
  各着手の手番側を復元し、末尾のCPU側着手+続く1件のhuman側着手を取り除く
  長さを返す)を追加。この方式により「CPUが思考中(応手が未記録)」ケースは
  末尾が既にhuman側なので自動的に1件のみ除去される特別扱いなしのロジックになった。
  `game/gameHistory.test.ts`に純粋関数の単体テストを追加(23件、全パス)。
- `app.tsx`: `gameGenerationRef`(useRef)を追加し、CPU着手effect内で
  `generation`をクロージャに捕捉、`.then`/`.finally`で`cancelled`に加え
  世代照合するガードを追加(新規effectは増やさず既存のCPU着手effectに加算)。
  `undoMove`関数を追加(`computeUndoLength`→`moveHistory.slice`→`replayMoves`
  →`setMoveHistory`/`setGame`/`displaySequencerRef.reset`/`setThinking(false)`/
  `setEvalInfo(null)`/`firstMoveSquareRef`再計算)。投了・新規対局と並ぶ
  「1手戻る」ボタンを追加(`standardStart`のときのみ表示、`moveHistory.length===0`で
  disabled、`displayGame.phase`に関わらず常に表示=終局後も押せる)。
- 統合テスト`app.playmode.undo.test.tsx`を新規作成(7件): 履歴空で非活性/
  非標準開始(エディタで次の手番=白)で非表示/CPU戦4手→undo→2手目までの
  自分の手番に戻る+投了→振り返るでmoveHistoryの整合を確認/CPU思考中undo→
  世代ガードで遅延応答が無視される/vsHumanの1ply+undo後の定石トレース再計算
  (「(離脱)」解消)/投了後(終局後)のundo。単独実行で7件全パス、
  `game/gameHistory.test.ts`(23件)も全パス。
- `npx tsc --noEmit -p app/tsconfig.app.json`は実装直後(T141の並行編集が
  `app/src/midgame/`に及ぶ前の時点)でエラーなしを確認。
- **既知の制約(並行作業起因、T140の実装には無関係)**: 検証中、並行実行中の
  T141が`app/src/midgame/PracticeMode.tsx`の依存(`generateStart.ts`・
  `judgeModeStorage.ts`等)を作業ディレクトリ上でリファクタリング中(未コミット)
  のため、`app.tsx`が`MidgamePracticeMode`を経由してこれらをimportする関係で、
  `npx vitest run`(全体)・`npx tsc --noEmit -p app/tsconfig.app.json`の
  再実行がT141の中間状態と衝突して失敗する状態が断続的に発生した
  (`git status --short app/src/midgame`で該当ファイルが未コミットのD/M/??で
  残っていることを確認済み)。エラーメッセージはすべて`src/midgame/*`関連
  (`Cannot find module './generateStart.ts'`等)で、本タスクが変更した
  `app.tsx`・`game/gameHistory.ts`・`app.playmode.undo.test.tsx`には無関係。
  コミットは`app.tsx`・`game/gameHistory.ts`・`game/gameHistory.test.ts`・
  `app.playmode.undo.test.tsx`の4ファイルのみをパス明示でstage・commitしており
  (T141側の未コミット差分は含めていない)、`git log origin/main`はT141の
  中間状態を含まないため、push・CI・Pagesビルドへの影響はない見込み
  (下記Actions結果で確認)。verifier/オーケストレーターには、T141完了後の
  `npx vitest run`全体実行での再確認を推奨する。
- コミット: `41cf510`(`app: 対局モードに「1手戻る」(研究用)を追加(T140)`)。
  `git push origin main`成功(`0320850..41cf510`)。GitHub Actions
  (Deploy to GitHub Pages / Rust Tests)をwatch中。

### 2026-07-19 verifier検証結果(判定: 合格)

- 対象コミット: `41cf510`。検証時点の現HEAD: `09085d8`(T140の後にT141と
  tasks更新コミットが積まれているが、`git diff --stat 632eae0..HEAD -- . ':!tasks'`が
  空でありapp配下への追加変更なしを確認)。
- `npx vitest run`(app/直下、リポジトリ全体): **95 test files / 771 tests 全パス**
  (implementerの主張どおり)。
- `npx tsc --noEmit -p tsconfig.app.json`(app/直下): エラーなし(exit 0)。
- スコープ: `git diff --name-only 0320850..41cf510` → `app/src/app.playmode.undo.test.tsx`・
  `app/src/app.tsx`・`app/src/game/gameHistory.test.ts`・`app/src/game/gameHistory.ts`の
  4ファイルのみ。bench/・train/・tasks/への混入なし。T141の変更ファイル
  (`app/src/midgame/*`等)との重複なし(領域分離OK)。
- GitHub Actions: `gh run list`で`41cf510`の`Deploy to GitHub Pages`・
  `Rust Tests`いずれも`conclusion: success`を確認。
- `git status --short`: 差分・未追跡なし(クリーン)。
- `app.playmode.undo.test.tsx`(7件)を通読: sanity/履歴空非活性/非標準非表示/
  CPU戦4手→undo→moveHistory整合(振り返る棋譜と一致)/CPU思考中undo世代ガード/
  2人対戦1ply+定石トレース再計算/終局後undo、をすべて実装通り確認。
  `game/gameHistory.ts`の`computeUndoLength`/`replayMoves`をコード読解し、
  `gameHistory.test.ts`(23件、`describe`単位でappendPlayedMove/movesToTranscript/
  isStandardStartPosition/replayMoves/computeUndoLengthを網羅)と突き合わせ、
  アルゴリズム(CPU対戦は末尾からCPU側→human側1件を除去、vsHumanは単純-1)が
  仕様どおりであることを確認。
- `app.tsx`の差分を読み、`gameGenerationRef`によるCPU着手effectの世代照合
  (`!cancelled && gameGenerationRef.current === generation`)・`undoMove`関数
  (`computeUndoLength`→`slice`→`replayMoves`→state反映→`displaySequencerRef.reset`)・
  「1手戻る」ボタンの表示条件(`standardStart`のみ・`moveHistory.length===0`で
  disabled・`displayGame.phase`に関わらず常時表示)を確認、仕様と一致。
- ビジュアルQA(本番Pagesでの一連操作確認)はオーケストレーターが別途実施済みとの
  前提のため、本検証では実施していない(依頼文の指示どおり)。
- 結論: 受け入れ基準6項目すべて満たす。不合格要素なし。

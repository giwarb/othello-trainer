---
id: T132
title: 対局→棋譜解析の連携(終局後に「この対局を振り返る」)
status: todo # T131完了後に委譲(並行push衝突を避けるため)
assignee: implementer(Sonnet)
attempts: 0
---

# T132: 対局の振り返り導線

## 目的

実戦(CPU対局)の振り返りは学習効果が高いが、現状は対局モードと棋譜解析モードに**連携が一切ない**(調査確定: 棋譜解析の入力はテキスト貼り付け/手動並べ/自由配置のみ、`app/src/analysis/AnalysisMode.tsx:29,371-406`)。終局後ワンタップで自分の対局を解析にかけられるようにする。

## 要件

1. 対局モード(app/src/app.tsx内のPlay系)の終局画面に「**この対局を棋譜解析で振り返る**」ボタンを追加。
2. 押すと、対局の着手履歴を棋譜文字列(既存`parseTranscript.ts`が読める形式: f5d6c3... 形式)へ変換し、棋譜解析モードへ**プリフィル付きで遷移**して自動で解析を開始する(モード間の受け渡しはapp.tsxのstate経由でよい。URLやDBに残す必要はない)。
3. パス・投了・途中終局(合法手なし連続)を含む対局でも正しい棋譜が生成されること(パスは棋譜上表現しない既存規約に合わせる。`parseTranscript.ts`の仕様を先に確認)。
4. 自由配置や定石ブックon対局でも初手からの通常対局なら動くこと。初期盤面が標準でない対局(該当機能があれば)はボタンを出さない。
5. レスポンシブ維持。

## やらないこと(スコープ外)

- 対局の自動保存・対局履歴一覧(将来候補)/ 解析結果の共有機能 / AnalysisMode自体の機能変更(入力の受け口追加のみ)
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] 履歴→棋譜文字列変換のユニットテスト(通常対局・パス含み対局・短い対局)
- [ ] 遷移のコンポーネントテスト(ボタン押下→AnalysisModeに棋譜が渡り解析が開始される)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機でCPU対局→終局→ボタン→解析結果表示まで確認(375px込み)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T132)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18 実装開始。`app/src/analysis/parseTranscript.ts`の仕様を確認: パスは棋譜文字列に一切表現せず、`replayGame`側が合法手の有無から自動的に再現する規約。この規約に合わせ、対局モード側でも「実際に着手が成立した手だけを記録し、パスは記録しない」設計にした。
- `app/src/game/gameHistory.ts`(新規)に3つの純粋関数を実装: `appendPlayedMove`(`GameState`遷移の前後比較で着手を履歴へ追記、`lastMove`が変化していなければ何もしない)・`movesToTranscript`(区切りなし連結)・`isStandardStartPosition`(標準初期局面・黒番判定、盤面自由配置エディタ経由でも実質標準局面ならtrue)。単体テスト`gameHistory.test.ts`で通常対局・非合法手クリック・パス含み対局(`gameLoop.test.ts`の`buildIsolatedPocketsBoard`と同構成)・短い対局・イミュータビリティ・`isStandardStartPosition`の各ケースを検証。
- `app/src/app.tsx`のPlayModeに`moveHistory`/`standardStart`state を追加し、人間の着手(`handleMove`)・CPUの着手(CPU着手effect)の両方で`appendPlayedMove`により履歴を積み上げるようにした。`startNewGame`/`startVsHumanGame`は`standardStart=true`固定、`startFromEditor`は`isStandardStartPosition(editorBoard, editorSideToMove)`で判定。終局後(`game.phase==='over'`)かつ`standardStart`かつ履歴が1手以上ある場合のみ「この対局を棋譜解析で振り返る」ボタンを表示し、押下で`onReviewGame(movesToTranscript(moveHistory))`を呼ぶ。`app.css`に`.review-game`(`.controls__row`と同じflex-wrapパターン)を追加。
- `App`コンポーネントに`pendingReviewTranscript`stateを追加し、`PlayMode`の`onReviewGame`で棋譜文字列をセットしつつ`mode`を`'analysis'`に切り替える。URL/DBを経由しないstate受け渡し(要件2どおり)。
- `app/src/analysis/AnalysisMode.tsx`に`initialTranscript`/`onInitialTranscriptConsumed`propsを追加。マウント時(または値が変わった時)に「テキストで入力」タブへプリフィルしつつ`parseTranscript`→`startAnalysis`を自動実行し、消費後に`onInitialTranscriptConsumed`を呼んで呼び出し元(App)の保持値をクリアさせる(再マウントまで二重発火しない設計)。
- コンポーネントテスト`app/src/app.playmode.review.test.tsx`(新規)を追加。実際のオセロは終局まで多数手を要し現実的な終局をUIクリックで再現するのは非実用的なため、`game/gameLoop.ts`の`playMove`だけを「1手で即座に終局する」決定的な振る舞いに`importOriginal`ベースでモックし(`createGame`等は実物のまま)、2人対戦モードでd3着手→終局→「この対局を棋譜解析で振り返る」ボタン押下→`AnalysisMode`へ遷移・`initialTranscript='d3'`で自動解析が完了する（`解析完了: 1手`・movelistに`d3`）までを検証。`fake-indexeddb/auto`で解析結果キャッシュ(IndexedDB)も実物のまま動かした(`tsume/PlayMode.test.tsx`と同じ方針)。
- 検証: `npx vitest run`(app/配下、全704テスト)全パス。`npx tsc --noEmit -p tsconfig.app.json`(app/配下)エラーなし。Rust/wasmビルドは一切実行していない(既存の`app/src/engine/pkg/engine_bg.wasm`成果物を前提とした型チェック・vitestのみ)。
- コミット: `app/src/analysis/AnalysisMode.tsx` `app/src/app.css` `app/src/app.tsx` `app/src/app.playmode.review.test.tsx` `app/src/game/gameHistory.ts` `app/src/game/gameHistory.test.ts` をパス明示で`git add`し、コミットハッシュ`c0ba489`(`app: 対局終了後に棋譜解析へワンタップで振り返れる導線を追加(T132)`)。`git fetch`でリモートが進んでいないことを確認してから`git push origin main`(push時点でremoteが自分の親コミットのままだったため、rebase不要でそのままpush成功)。
- デプロイ確認: `gh run watch`で「Deploy to GitHub Pages」(run 29628901781)が成功するまで待機、成功確認。
- Pages実機確認(Playwright系ツールではなくBrowser MCPツールを使用): `https://giwarb.github.io/othello-trainer/`にアクセスし、以下を確認した。
  - `computer`(screenshot/click)ツールが本環境で継続的に30秒タイムアウトする問題があったため、`javascript_tool`によるDOM直接操作・イベントdispatchで代替した(参考: `read_page`/`get_page_text`/`javascript_tool`は問題なく機能した)。
  - 途中、Service Workerの更新+ブラウザキャッシュにより古いハッシュ付きJS/CSSが404する状態に遭遇したが、SW登録解除・Cache Storageクリア・クエリパラメータ付きの再ナビゲーションで回復(アプリ本体の不具合ではなく、テスト中に複数回リロードしたことによる一時的なキャッシュ不整合と判断)。
  - 対局モードで「2人対戦で開始」→黒(自分)側の手をブラウザJSから合法手一覧(`候補手評価を表示`オーバーレイのDOM)を読み取って自動着手する簡易ボットを組み、CPU(weak)相手に60手フル対局を最後まで実施(黒5-白59で終局)。
  - 終局後「この対局を棋譜解析で振り返る」ボタンが表示されることを確認。押下 → `棋譜解析`タブがアクティブになり(`mode-nav__tab--active`相当の`aria-current="page"`)、テキスト入力を経由せず自動的に解析が開始され、60手全てを解析完了(`解析完了: 60手`、movelist行数60、評価グラフ描画あり)。
  - ビューポートを375px幅に変更し、解析結果画面・対局モーム画面いずれも`document.documentElement.scrollWidth <= clientWidth`(横スクロール無し)を確認。
- 判断に迷った点: (1) 「履歴→棋譜文字列変換のユニットテスト」は`gameHistory.ts`の純粋関数群として実装・テストした(GameStateの遷移比較を含む設計。パス自動処理の正しさ自体は既存`gameLoop.test.ts`が担保する前提)。(2) 「遷移のコンポーネントテスト」は実際に60手打ち切って終局させるのは非実用的なため、`playMove`のみをモックして統合コード(履歴記録・ボタン表示条件・モード遷移・自動解析開始)だけを検証する設計にした。実際の60手フル対局での終局→ボタン→解析完了は本作業ログのPages実機確認で別途担保している。(3) ボタンのラベル文言はタスク仕様の要件1に記載された文言「この対局を棋譜解析で振り返る」をそのまま採用した。

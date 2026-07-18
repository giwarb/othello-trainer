---
id: T137
title: UX強化3: 設定・一覧・ホーム画面の磨き込み(CTA強調・進捗の見える化)
status: in_progress # T136完了(done)を受けて委譲
assignee: implementer(Sonnet)
attempts: 0
---

# T137: 設定・一覧・ホームの磨き

## 背景(オーケストレーターの実機UXレビュー 2026-07-18)

1. **中盤練習の設定画面**: fieldset枠のラジオ3グループが縦積みで威圧感があり、主アクション「開始」が最小サイズの灰色ボタンで埋没。苦手パターンの空状態が素テキスト1行で寂しい。
2. **詰めオセロの設定画面**: 「難易度1〜5」が同一見た目の灰色ボタン5連。各難易度の説明(空きマス数帯)もクリア進捗も無く、選ぶ手がかりがない。
3. **ステージ一覧**: 灰色一色の長大グリッド。クリア済みの色分けはあるが未挑戦だと全部同じで達成感の演出がない。
4. **ホーム**: カードは綺麗だが静的。進捗(定石の今日の復習n本・詰めデイリー・クリア数)が一切出ず、「今日なにをやるか」の導線がない。

## 要件

1. **中盤練習設定**: ラジオ3グループを選択式チップ(セグメントコントロール風)またはコンパクトなカードに刷新し、**「開始」をプライマリボタンで最下部に大きく固定**。苦手パターンは記録があれば上位3件をカード表示(T129)、空状態は「失敗するとここに苦手が貯まります」等の説明文+アイコン。
2. **詰めオセロ設定**: 難易度ボタンを「難易度n(空きm〜kマス)+クリア x/y」のカードに刷新(クリア数は既存stageProgressから集計)。デイリー・ランダム・ステージ一覧はプライマリ/セカンダリの区別を付ける。
3. **ステージ一覧**: クリア済みセルに達成色(緑系)+チェック/★を付けて達成感を出す。ヘッダに「クリア x/182」のサマリバー(進捗バー)を追加。中盤練習側は判定モード別★の既存仕様を維持したまま同様に。
4. **ホームに進捗サマリ**: 各モードカードに小さな実績行を追加 — 定石「今日の復習n本」(dueLines.ts再利用)、詰め「クリアx/182・今日の1問」、中盤「クリアx/111」。データ取得は既存のlocalStorage/IndexedDB読み出しの再利用のみ(新規スキーマ不要)。取得失敗時は表示しない(ホームの表示を壊さない)。
5. 全画面、縦375px・横置きの両対応。T135のデザイントークンを使う(独自色を増やさない)。

## 追加要件(T136検収の申し送り、tasks/review/T136-ui-play-claude-review.md)

1. (中)`--board-label-band: 1.35em`をrem基準に変更(フレームとオーバーレイが別要素でemを解決するため、将来のfont-size指定で無警告にズレるリスクの解消)。
2. (軽微)ヘッダ高40pxのマジックナンバーが7ファイルに散在 → CSS変数(例: `--app-header-height`)に集約。
3. (軽微)`class="play-setup card"`とCSSコメント(「.card併用せず」方針)の矛盾を解消(どちらかに統一)。
4. (軽微)2人対戦モードで投了ボタンが非表示であることの専用テスト1件追加(verifier指摘)。
5. (軽微)中盤練習・詰めオセロで削除したSR向け手番テキストの代替(PlayerBadgeにaria-label等)を検討・実装。

## やらないこと(スコープ外)

- 新しい学習機能の追加(表示の磨きのみ)/verbalize旧モードの復活/IndexedDB・localStorageスキーマ変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] 中盤設定・詰め設定・グリッド・ホームの各変更にコンポーネントテスト(進捗集計の表示・空状態・進捗バーの値)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] ビフォー/アフターのスクショ(375x812、4画面)を撮り作業ログに記録
- [ ] mainへpush→Actions成功→Pages実機で4画面+横置きの非退行を確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T137)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-18 implementer(Sonnet)実装完了

**方針・スコープの確認**

- 追加要件1〜5(T136 codex-review申し送り)を先に着手し、その後要件1〜4(設定・一覧・ホーム磨き込み)を実装した。
- チップ化はネイティブ`<input type="radio">`を`.sr-only`で視覚的に隠し、`<label>`をチップ風に見せる方式を採用(既存のquerySelectorベースのテスト・アクセシビリティを壊さないため)。アクティブ状態はJS側で判定した`--active`修飾クラスで表現(復習フィルタボタンの既存パターンを踏襲)。
- 難易度nの「空きm〜kマス」は固定の対応表が無い(生成時のパーセンタイル分割のみ)ため、実際にロード済みの問題プールからその場で最小〜最大を求める方式にした(`tsume/difficultyStats.ts`)。
- ホームの実績行はIndexedDB/localStorageの取得を3モード独立にtry/catchし、失敗時はその行だけ非表示にする設計(要件4)。新規スキーマは追加していない(既存のdueLines/stageProgress/dailyPuzzleをそのまま再利用)。

**変更ファイル**

- 追加要件1: `app/src/index.css`(`--board-label-band`をem→rem化)
- 追加要件2: `app/src/index.css`(`--app-header-height: 40px`新設)+ `app/src/app.css`・`app/src/analysis/AnalysisMode.css`・`app/src/joseki/PracticeMode.css`・`app/src/midgame/PracticeMode.css`・`app/src/tsume/PlayMode.css`の`calc(100dvh - 40px)`(計8箇所)をトークン参照に置換
- 追加要件3: `app/src/app.tsx`(`class="play-setup card"` → `class="play-setup"`)
- 追加要件4: `app/src/app.playmode.stateSeparation.test.tsx`に「2人対戦モードでは投了ボタンが表示されない」専用テストを追加
- 追加要件5: `app/src/components/PlayerBadge.tsx`にaria-label(誰・何番・石数・手番・考え中を要約)を追加、`app/src/components/PlayerBadge.test.tsx`にテスト追加
- 要件1(中盤設定): `app/src/midgame/PracticeMode.tsx`(3fieldsetをチップ化、苦手パターン空状態をアイコン+説明文化、「開始」を大きなプライマリCTAに、「ステージ一覧」をセカンダリリンク風に)+ `app/src/midgame/PracticeMode.css`
- 要件2(詰め設定): `app/src/tsume/PlayMode.tsx`(難易度ボタン→カード化)+ 新規`app/src/tsume/difficultyStats.ts`(空きマス数帯+クリア数の集計、純粋関数)・`app/src/tsume/difficultyStats.test.ts` + `app/src/tsume/PlayMode.css`
- 要件3(ステージ一覧): `app/src/midgame/PracticeMode.tsx`・`app/src/tsume/PlayMode.tsx`(「クリア x/N」サマリ+進捗バーを追加、クリア済みセルの達成色を強化)+ 両CSS
- 要件4(ホーム進捗): 新規`app/src/home/modeProgress.ts`(文言組み立ての純粋関数)・`app/src/home/modeProgress.test.ts` + `app/src/TitleScreen.tsx`・`app/src/TitleScreen.css`(`ModeCardInfo.progress`追加)・`app/src/TitleScreen.test.tsx` + `app/src/app.tsx`(3モード分の非同期取得effect)
- 新規コンポーネントテスト: `app/src/midgame/PracticeMode.settingsUx.test.tsx`・`app/src/tsume/PlayMode.settingsUx.test.tsx`・`app/src/app.home.progress.test.tsx`
- 既存テスト更新: `app/src/midgame/PracticeMode.patternStats.test.tsx`(空状態アサーションを新文言に更新。default judgeModeが`'strict'`である点は`PracticeMode.settingsUx.test.tsx`側で対応)

**検証**

- `npx vitest run`: 95ファイル/754件 全パス
- `npx tsc --noEmit -p app/tsconfig.app.json`: エラーなし
- ローカル動作確認: `npx vite --port 5183`で起動し、Browser MCPで実際のjoseki.json/puzzles.json(定石111ステージ・詰め182問)を使って以下を確認:
  - ホーム: 「今日の復習112本」「クリア0/111」「クリア0/182・今日の1問未挑戦」が各カードに表示
  - 中盤設定: 苦手パターン空状態(📊アイコン+「失敗するとここに苦手パターンが貯まります」)、判定モードチップの`--active`クラス切り替え、「開始」が`btn-primary midgame-settings__start-button`(高さ56px)
  - 中盤ステージ一覧: 「クリア 0/111」サマリ+進捗バー(aria-valuenow/valuemax)
  - 詰め設定: 難易度カード5枚に「空きm〜kマス」「クリア x/y」(実データで難易度1=空き6〜9マス等)
  - 詰めステージ一覧: 「クリア 0/182」サマリ+進捗バー
  - **スクリーンショット未取得(環境制約)**: `mcp__Claude_Browser__computer(action: screenshot)`および`zoom`が本セッションでは`http://localhost:5183`・`https://example.com`いずれに対しても一貫してタイムアウトし撮影不能だった(アプリ側の不具合ではなく、このセッションのBrowser MCPツール自体の問題と判断。`get_page_text`・`read_page`・`javascript_tool`は正常に機能し、上記の内容確認は全てこれらで行った)。375x812のビフォー/アフター4画面のスクリーンショットはオーケストレーター側で別途取得・確認をお願いしたい。
- GitHub Pages実機確認: 未実施(コミット・push後にオーケストレーターまたは次のステップで実施予定。下記完了レポート参照)

**判断に迷った点**

- 詰めオセロの「今日の1問」実績: 要件4の文言例「クリアx/182・今日の1問」だけでは「今日の1問」が何を示すか曖昧だったため、「今日の1問(デイリー)を既にクリア済みかどうか」(済み/未挑戦)を表示する設計にした(定石の「今日の復習」と同様、当日のアクションを促すゲーミフィケーション要素として一貫させる意図)。

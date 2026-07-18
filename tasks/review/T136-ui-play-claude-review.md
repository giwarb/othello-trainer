# T136 最終レビュー(Claude 代替レビュー)

- 対象: `d532ae3`(プレイ画面の盤中心化: PlayerBadge・状態分離・盤描画改善・お題カード化+T135細部修正、22ファイル +1237/-347)
- 照合: `tasks/T136-ui-play-screens.md`(追加要件込み)
- 方法: `git show d532ae3` の全差分精読 + 周辺コード横断(`Board.tsx` 全文、`app.tsx` の対局状態管理・CPU着手effect・`displayQueue.ts`、全オーバーレイ利用箇所の照合、CSSトークン定義の実在確認)+ `npx vitest run`(89ファイル/731件 全パス、2026-07-18 レビュー時再実行)
- 対象外: 見た目の良否(オーケストレーターQA済み)。コード品質・座標系整合・状態遷移のエッジケースに集中。

## 総合判定: 合格(重大なし。中1件・軽微5件は申し送り推奨)

重点観点1〜5はすべて要件どおり実装されており、設計判断(canvas座標系を不変に保ちオーバーレイCSS側だけをオフセットする方式、投了をGameStateの書き換えのみで実現する方式、右カラム単一div化によるスクロール分離)はいずれも妥当。実装コメントが例外的に丁寧で、gridブロウアウト対策等の非自明な判断の根拠が残されている。

## 重点観点ごとの確認結果

### 1. 座標帯導入とクリック/オーバーレイ座標系 — 問題なし

- **クリック→マス変換**: `Board.tsx` の `handleClick` は `canvas.getBoundingClientRect()` 基準のまま不変。canvasはラベル帯の外(`.othello-board-frame` の右下セル)にあり、rect自体が帯を含まないため変換式に帯の影響は構造的に及ばない。
- **石返しアニメーション**: `drawFlippingDisc`/`drawAppearingDisc`/`drawDisc` はすべてcanvas内部座標(`ctx.translate` 後のローカル座標含む)で完結しており、帯の影響なし。グラデーション(`discGradientFill`)も `translate`/`scale` 後の座標系で正しく描かれる(潰れ変形にグラデーションも追従する、正しい挙動)。
- **オーバーレイ整合**: `MoveEvalOverlay.css`/`analysis/BoardOverlay.css` の両方が `inset: var(--board-label-band) 0 0 var(--board-label-band)` に更新済み。幾何は整合する: 帯込みフレーム幅=ラッパー幅(いずれも `max-width: var(--board-size-lg)`)、canvas辺長=幅−帯、オーバーレイ辺長=ラッパー辺−帯=canvas辺。
- **T128対比盤・解析盤への波及**: オーバーレイを重ねる箇所は全て `board-with-move-eval-overlay`(app.tsx/joseki/midgame/tsume/BlunderPanel)と `board-with-overlay`(BlunderPanel:540)の2クラス経由であることをgrepで確認。両CSSとも更新済みで取り残しなし。オーバーレイ無しの盤(ClearBlunderCompare・RefutationView・GlossaryEntryDetail等)は帯が付くだけで座標依存なし。
- **横置きの盤サイズ計算**(`width: min(48dvh, 42vw, 320px)`)は「盤の高さ≒幅」を前提にしているが、帯込みフレームでも 高さ=帯+(幅−帯)=幅 が成り立ち前提は崩れていない。
- `minmax(0, 1fr)`+`min-width: 0` のgridブロウアウト対策は正しい(canvasのreplaced element特性による `min-width: auto` 問題への正攻法)。

### 2. 状態分離のエッジケース — 問題なし(軽微2件のみ)

- **開始3経路**(`startNewGame`/`startVsHumanGame`/`startFromEditor`)はすべて `prepareNewGame` を経由して `setStarted(true)`・`setEditorOpen(false)`・履歴/評価情報リセットを行う。開始前の設定変更(CPU強さ・定石ブック)は開始時の `createGame`/CPU着手effectが最新stateを読むため自然に反映される。
- **投了とCPU思考中の競合**: `resignGame` が `setGame`(phase:'over')すると、CPU着手effect(依存配列に `game`)のcleanupで `cancelled=true` になり、飛行中の `requestCpuMove` の結果は `setGame`/`setMoveHistory`/`push` とも破棄される。投了状態が後から古いCPU応手で上書きされる経路はない。`thinking` は `game.phase !== 'cpu'` 安全網effect(T115)で確実に解除される。
- **投了とdisplayQueue(T134)**: `displaySequencerRef.reset(next)` はキュー・保留タイマーを全破棄して即時 `onApply` するため(`displayQueue.ts:83-90` で確認)、`displayGame` が古いまま残る懸念は成立しない。表示未反映のCPU応手が内部 `game` に確定済みの場合も、そのボードを含む終局状態が即時表示される(一貫している)。
- **投了ガードの二重化**: ボタン表示条件は `displayGame.phase !== 'over'` だが、内部 `game` が先に終局している短い窓でも `resignGame` 先頭の `game.phase === 'over'` ガードでno-opになり安全。`passMessage: null` のクリアも適切。
- **投了とmoveHistory・振り返る導線**: 投了時点までの実着手が `moveHistory` に残り、`standardStart && moveHistory.length > 0` なら「振り返る」が出る(部分棋譜の解析として整合)。0手投了ならボタンは出ない。勝敗演出は `result = opposite(humanSide)` で負け演出、テストでも検証済み。
- **「新規対局」(returnToSetup)**: セットアップ再表示のみで対局stateは据え置き、という設計は明確。→ 軽微(3)参照。

### 3. PlayerBadge共通化 — 問題なし

- props契約(`side`/`label`/`count`/`active`/`thinking`)は3モードで一貫。対局モードのみ `active` に `displayGame.phase !== 'over'` ガード付きだが、中盤・詰めは playing フェーズでしか描画されないため実質同等。
- **詰めオセロの色割当**: `session.humanSide = puzzle.sideToMove`(`tsume/PlayMode.tsx:257`)であり、`label={session.humanSide === 'black' ? 'あなた' : '相手'}` は正しい(白番の問題なら白バッジ=あなた)。`thinking` は `opponentThinking && session.humanSide !== <badge色>`、つまり相手側バッジにのみ付く。中盤練習も同一パターン。
- 対局モードの2人対戦は投了非表示・ラベル「黒/白」・thinking常時false、と視点なしケースを正しく処理。
- テスト(`PlayerBadge.test.tsx` 5件)はハイライト切替・aria-current・色クラス・thinking既定値をカバー。

### 4. T135細部修正3点 — すべて実装確認

1. `min-height: 0` 追加4系統: `.verbalize-tags__info`(verbalize/PracticeMode.css)・`.motif-badge--button`・`.blunder-panel__branch-node`(BlunderPanel.css)・`.attribution-waterfall__label--button`(AttributionWaterfall.css)。いずれも各クラスのプロパティ群の先頭に追加、副作用となる他プロパティの変更なし。フィルタチップは実測で「意図した見た目」と判断(変更なし)、妥当。
2. `calc(100dvh - 40px)` 化: app.css(play-board-area)・AnalysisMode.css・joseki(2箇所)・midgame(2箇所)・tsume(2箇所)の横置きコンテナすべてに適用、取り残しなし。→ 軽微(1)参照。
3. `.btn-secondary` 削除: index.cssから削除、残存参照はコメント内の履歴記述のみ(grepで確認)。

### 5. 横置きの右カラム単独スクロール化 — 問題なし

- 3モードとも「右カラムを単一div(`__side`)化 → 2行grid(バッジ全幅/盤+サイド)→ サイドのみ `min-height: 0` + `overflow-y: auto`」の同一パターンで実装。旧 `span 8` +コンテナ全体スクロールの問題(row-gap積算・盤ごと流れる)を根本から解消しており、T133申し送りの正しい解消。
- flexの `align-items: center` がgridに漏れてサイドがstretchしない不具合を横置きmedia query内の `stretch` 明示で修正(midgame/tsume)、盤側は `align-self: start` で個別に外す。整合している。
- tsumeは `.tsume-practice__board-col`(お題カード+盤)を左カラム化し、app.cssの盤サイズセレクタも `.tsume-practice__board-col > .board-container` へ追従済み。

## 指摘事項

### 中(保守性リスク・現時点でバグではない)

1. **`--board-label-band: 1.35em` のem依存**(index.css)— この値は `.othello-board-frame` のgridトラック(フレームのfont-size基準で解決)と、`.move-eval-overlay`/`.board-overlay` の `inset`(各オーバーレイ要素のfont-size基準で解決)という**別要素の文脈で2回解決される**。現状は両者とも同じ継承font-sizeの下にあり一致する(全経路を確認済み)が、将来どれかの祖先・ラッパーに `font-size` を設定すると帯とオーバーレイが**無警告で数pxずれる**(T128対比盤・解析盤にも波及)。コメントは「同じCSS変数を参照するため値変更は1箇所でよい」と謳うが、em故に「参照が同じでも解決値が同じとは限らない」点が抜けている。`rem`(またはpx)化すればこの罠自体が消える。フォローアップでの対応を推奨(redo不要)。

### 軽微

1. **ヘッダ高40pxのマジックナンバー重複** — `calc(100dvh - 40px)` が7ファイル超に散在。ヘッダ高は実測値でありCSS上で40px固定を保証する宣言はないため、ヘッダの文言・font-size変更でずれうる。`--header-height` トークン化を申し送り。
2. **`<section class="play-setup card">`(app.tsx:782)とCSSコメントの矛盾** — app.css:219のコメントは「詳細度の衝突を避けるため `.card` は併用せず直接指定する」と明記しているのに、JSXは `.card` を併用している。現状は両者のトークン値が同一なので視覚差はないが、コメントの根拠(同詳細度のインポート順依存)がそのまま成立してしまっている。`card` クラスを外すかコメントを直すか、どちらかに揃えるべき。
3. **「新規対局」でセットアップへ戻った後も裏で対局effectが動き続ける** — CPU思考中に戻るとエンジン探索・evalBar・オーバーレイ取得が非表示のまま完走する(結果は次の開始時に `prepareNewGame` で全リセットされるため正しさへの影響なし、エンジンサイクルの無駄のみ)。実害は小さく対応任意。
4. **対局モードのバッジで `thinking`(game基準)と `active`(displayGame基準)の基準が異なる** — 表示キューの待ち時間中、ハイライトが人間側に残ったままCPUバッジにスピナーが出る短い窓がある。過渡的・視覚のみで、T134の「表示はdisplayGame基準」方針との折衷としては許容範囲。
5. **中盤・詰めの手番テキスト削除によるSR情報の後退** — 対局モードは `.sr-only` 化で文言維持したが、中盤・詰めは素テキスト削除(バッジの `aria-current` +ラベル+石数は読めるが「あなたは○番」相当の文は消えた)。実装者も作業ログで自己申告済み。後続タスクでの `.sr-only` 化検討を申し送り。

## 確認して問題なしだった点(抜粋)

- `drawLegalHint`(半径0.22・縁取り)・`drawLastMoveMark`(中心塗り追加)の描画は `beginPath` 管理が正しく、`strokeDiscOutline` も直前パスを正しく参照する。石半径0.42に対し合法手ドット0.22・最終手マーク0.1で重なり順も適切(最終手マークは石の上に最後に描かれる)。
- `discGradientFill` は毎フレーム最大64個のグラデーション生成だが、アニメーション時のみ連続描画で実測上問題になる規模ではない。
- 座標ラベルDOM帯は `aria-hidden`+`key` 付きmapで適切。canvas側のラベル描画コード(`drawCoordinateLabels`)は完全に削除され死コードなし。
- CSSトークン(`--color-accent-bg`/`--color-accent-dark`/`--radius-full`/`--space-*`)はすべてindex.cssに実在し、ダーク対応の既存パターン(固定ライト背景+固定ダーク文字のバッジ)に整合。
- 旧 `.controls`/`.score` CSSの削除は使用箇所なし(grepで確認)。`.controls__row` は継続使用で残置、正しい。
- テスト追従(`app.playmode.test.tsx`/`animationSequencing`)は「開始ボタンを押す」手順の追加のみで検証内容は不変。新規テスト(状態分離3件・PlayerBadge5件)は要件の主要分岐(セットアップ表示/非表示・details既定閉・投了→白勝ち→復帰)を実DOMで検証しており妥当。
- `npx vitest run`: 89ファイル/731件 全パス(レビュー時再実行、21.7s)。

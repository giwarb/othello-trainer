# T135 最終レビュー(Claude 代替レビュー)

- 対象: `b42370b`(共通シェル刷新)+ `d6637bd`(redo#1: ヘッダ二重表示解消・primary規律)
- 照合: `tasks/T135-ui-shell-design-system.md`(redo#1フィードバック込み)
- 方法: `git show` による両差分の精読 + 周辺コード横断(全 `<button>` 使用箇所と対応CSSの突き合わせ、横置きメディアクエリの全 `.board-container` 使用箇所照合)+ `npx vitest run`(87ファイル/723件 全パス、2026-07-18 実行)
- 対象外: デザインの善し悪し(オーケストレーターのスクショQA済み)。コード品質・波及バグに集中。

## 総合判定: 合格(中程度の指摘あり、申し送り推奨)

重大(ブロッカー)は無し。全モードの主要画面・主要フローは新スタイルで整合しており、タスクの要件(1行スティッキーヘッダ、デザイントークン、`.board-container`スコープ修正、primary規律)は満たされている。ただし、グローバル `button{min-height:44px}` が **スクショQAの範囲外のサブ画面(BlunderPanel・言語化系)にある「小さく見せる前提」のボタン** に漏れており、視覚崩れが4系統残っている(下記「中」)。いずれも1行(`min-height` の打ち消し)で直る同型の修正なので、フォローアップ1タスクでまとめて対応するのが妥当。

## 指摘事項

### 中(視覚リグレッション: グローバル `button` 既定の波及漏れ)

除外済みの2箇所(`.analysis-result__movelist-blunder-button` / `.board-editor__cell`)以外に、`index.css:102` の `min-height: 44px` を打ち消していない小型ボタンが以下に残る。各クラスは `padding`/`background`/`border` は自前指定しているため(クラス詳細度で勝つ)色・余白は無事だが、**`min-height` だけが素通しになり要素が44pxに膨らむ**。

1. **`.verbalize-tags__info`**(`app/src/verbalize/PracticeMode.css:109`、TagPicker の「?」丸ボタン)— 最も目立つ崩れ。クラス側は `width: 1.1em; height: 1.1em; border-radius: 50%` の小円だが、CSS仕様上 `min-height` は `height` に勝つため **幅約15px×高さ44pxの縦長楕円** になる。言語化トレーニング(verbalize)・二択ドリル・概念レッスンのタグ選択UIすべてに出る。
2. **`.motif-badge--button`**(`app/src/analysis/BlunderPanel.css:112`)— T036で「ボタン化しても見た目が既存のバッジと変わらないよう打ち消す」と明記された打ち消しに `min-height` が加わっておらず、ボタン型バッジだけ高さ44pxのピルになる。同じ行に並ぶ非ボタンの `.motif-badge`(span)は小さいままなので、BlunderPanel のモチーフ行で高さが不揃いになる。
3. **`.attribution-waterfall__label--button`**(`app/src/analysis/AttributionWaterfall.css:37`)— 「ほぼラベルと同じ見た目」を意図したリンク風ボタンが行ごと44pxに膨らみ、評価内訳ウォーターフォールの行高がボタン行だけ不均一になる。
4. **`.blunder-panel__branch-node`**(`app/src/analysis/BlunderPanel.css:215`)— `padding: 0.15rem 0.4rem; font-size: 0.8rem` のコンパクトな分岐ツリーノードが各44pxになり、BlunderPanel 内の分岐ツリーが大きく縦伸びする。

いずれも機能は壊れておらず(クリック可能・レイアウト破綻でスクロール不能等は無い)、本番の主要6画面スクショには写らないサブパネル内のため QA をすり抜けたと推測される。修正は各クラスに `min-height: 0`(または `auto`)を1行足すだけ。**redo ではなくフォローアップタスク化を推奨**(T135本体の受け入れ基準は満たしているため)。

### 軽微

1. **`.btn-secondary` が未使用**(`index.css:127`)— JSX での使用0件。button既定と同一見た目なので実害は無く、コメントで「明示したい箇所用」と宣言済みだが、現状はデッドコード。使うか消すかをどこかで判断。
2. **フィルタチップ・ピル類の高さ44px化**(`.tsume-stage-select__filter-button` / `.midgame-stage-select__filter-button` / `.glossary-page__item` / `.verbalize-tags__reselect` 等)— 崩れではないがコンパクトなチップデザインが縦に太る。タップターゲット確保としては合理的なので「意図した変更」と解釈できるが、これらの画面(ステージ一覧・用語集)はafterスクショの範囲外。次回ビジュアルQA時に確認推奨。
3. **横置きで `max-height: 100dvh` コンテナがヘッダ高を無視**(`.play-board-area` `.analysis-result` `.midgame-result--fail` 等、T133由来)— スティッキーヘッダ(横置き約40px)の分だけ、右カラム最下部を見るのに本文側の追加スクロールが必要になる。カラム内スクロールで全内容に到達可能なので実害は小さいが、`max-height: calc(100dvh - <ヘッダ高>)` への変更をT136(プレイ画面レイアウト再構成)で検討する価値あり。
4. **`min-height` 打ち消し値の不統一** — `.analysis-result__movelist-blunder-button` は `auto`、`.board-editor__cell` は `0`。どちらも有効だが、上記「中」の修正時に統一すると良い。
5. **SW更新バナーのボタン**(`registerServiceWorker.ts:130-158`)— インラインstyleで色・padding・角丸は保持され、グローバルの `min-height: 44px` と `font-size` だけが乗る。バナーが数px太るだけで問題なし(確認済みの報告)。
6. **primary規律の残り論点** — 主要画面は規律どおり(対局1・詰め1・定石due>0時1・中盤1・解析1、結果画面≤2)を確認した。ただし中盤設定画面で統計リセット確認を開くと「開始」+「はい」の primary 2個が同時表示になる(≤2なので規律違反ではないが、破壊的操作の確認ボタンが紫 primary なのはやや不自然)。対局の終局時も「黒番で開始」+「振り返る」の2個(結果画面扱いなら規律内)。
7. **コミットメッセージのタイプミス**(`b42370b` 本文「左カラムbomb本体」)— 作業ログで自己申告済み。履歴上残るが実害なし。
8. **見出し階層** — h1がホームのみになったため、各モード画面は h2 始まりになる。アクセシビリティ上の理想は各画面に(視覚的に隠した)h1 だが、優先度は低い。

## 確認して問題なしだった点

- **`.board-container` スコープ修正の完全性(重点観点3)**: `app.css:316-321` の6セレクタは、横置き2カラムグリッドを持つ全画面(`app.css` の `.play-board-area`、`joseki/PracticeMode.css:241`、`midgame/PracticeMode.css:435`、`tsume/PlayMode.css:362,392`、`analysis/AnalysisMode.css:289`)と過不足なく一致。各画面のDOMで盤が当該コンテナの直接の子であることを実コードで確認(app.tsx:852、joseki:516、midgame:1206、tsume:737/766/794、analysis:670)。スコープ外に残る `.board-container`(BlunderPanel×3、ClearBlunderCompare×2、verbalize系×4、解析入力盤×2、RefutationView)は T133 レビュー指摘どおり「横置き上書きを受けない」のが正しい挙動で、ClearBlunderCompare は `.clear-blunder-compare__board.board-container`(詳細度0,2,0)の専用ルールが引き続き有効。
- **スティッキーヘッダの重なり順(重点観点2)**: `.app-header` z-index:20 に対し、盤面オーバーレイ(BoardOverlay/MoveEvalOverlay)は z-index 無指定(スタッキング的にヘッダの下)、BlunderPanel=100・GlossaryPopover=200・SWバナー=9999 はヘッダの上、ResultCelebration=1 はヘッダの下。すべて意図どおりの序列。ヘッダ背景は不透明トークン `--color-bg`(ライト/ダーク両対応)で透け無し。ヘッダはDOM上 `<main>` の前の兄弟なので z-index 指定は必須であり、正しく付与されている。横置きメディアクエリでは 36px ボタン+2px パディング(実質約40px)に詰めており、高さの食い過ぎは無い。
- **旧ルールの除去**: `.mode-nav__home`・`main > h1` 非表示ルール・`.app-header__title`(redo#1、3メディアクエリ分とも)は完全に削除され、参照残りはコメント内の履歴言及のみ。死んだセレクタは残っていない。
- **除外2箇所の妥当性**: movelist内ボタンとエディタ8x8セルの `min-height` 打ち消しはコメント付きで適切。エディタセルはグローバルの `padding`/`border`/`background` もクラス側で全て上書き済み。
- **`.btn-primary` の適用方式**: `index.css`(先読み)のユーティリティに対し、併用クラス `.joseki-due-summary__review-button` は `cursor` のみでプロパティ衝突なし。カード化は「クラス併用でなくルール直接更新」で統一されており、インポート順依存の詳細度事故を構造的に回避している(方針コメントも各所に明記)。
- **テスト**: `npx vitest run` 87ファイル/723件 全パス(レビュー時再実行)。

---
id: T068
title: ダークモードでの可読性修正(OS設定連動)
status: review
assignee: implementer
attempts: 0
---

# T068: ダークモードでの可読性修正(OS設定連動)

## 目的

ユーザー報告(2026-07-11):「ダークモードでまともに読めなかったりする」。OS/ブラウザがダークモードのとき、アプリの一部で文字が読めなくなる(背景色が固定のライト色のまま、文字色だけ暗い環境の既定色に切り替わり、コントラストが崩壊する)問題を修正する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

- `app/src/index.css`の`:root`に`color-scheme: light dark;`という宣言が既に1行だけあるが、これは「両モードに対応している」とブラウザに伝えるだけの宣言であり、**実際のダーク配色トークンや`@media (prefers-color-scheme: dark)`ルールは一切存在しない**。`prefers-color-scheme`というキーワードはリポジトリ全体で0件ヒット(CSSにもJSにも実装なし)。対照的にT066で`prefers-reduced-motion`は`window.matchMedia`できちんと検知・対応されており、本タスクは同様のパターンをダークモードにも適用する。
- `index.css`には背景色/文字色用のデザイントークン(例: `--color-bg`, `--color-text`)が存在しない(`--color-accent*`, `--radius-*`, `--space-*`, `--board-size-*`のみ)。
- **最も深刻な問題パターン**: 「背景色は固定のライト色(白系)だが、文字色は`inherit`または未指定」という組み合わせ。ダーク環境ではブラウザの既定文字色が明るくなり、実質「白地に白文字」同然になる。explorerが発見した具体例(ただし網羅的な調査ではなく代表例。実装時に他のCSSファイルも同様の観点で確認すること):
  - `app/src/app.css`の`.mode-nav__tab`(22〜30行目付近): `background:#f4f4f5; color:inherit`。常時表示されるモード切替タブ全体が該当し、影響範囲が最大。
  - `app/src/analysis/BlunderPanel.css`の`.blunder-panel`(14〜24行目付近): `background:#fff`で文字色指定なし。
  - `app/src/verbalize/GlossaryPopover.css`(15, 31行目付近)、`GlossaryPage.css`の`.glossary-page__item`(44行目付近、`background:#f8fafc`で色指定なし)、`ConceptLesson.css`(11行目付近、`background:#f8fafc; color:inherit`)、`VerbalizeMode.css`(21〜22行目付近)も同様のパターン。
  - `app/src/app.css`の`.home-main`(T065タイトル画面、9行目付近): `radial-gradient(...#ffffff 70%)`で背景が固定白。`TitleScreen.css`の`.title-screen__card`(35行目付近)も`background:#ffffff`固定。
  - **これらは代表例であり、他のCSSファイル(`joseki/PracticeMode.css`, `midgame/PracticeMode.css`, `tsume/PlayMode.css`, `analysis/AnalysisMode.css`, `analysis/RefutationView.css`, `analysis/BoardOverlay.css`, `components/Board.css`, `EvalBadge.css`等)にも同様の「固定ライト背景+`color`未指定/`inherit`」パターンが無いか、実装時に横断的に確認すること。**
- 一方、勝敗チップ・正誤バッジ類(`ResultCelebration.css`のwin/lose/draw、`EvalBadge.css`、各種`*-result--clear/fail`)は背景色・文字色を**セットで固定**している(例: `#dcfce7`/`#14532d`)ため致命的な読めなさにはならないが、暗い画面に明るいパステルが浮く見た目の不整合は残る。これらは緊急度が低いため、コントラストの軽微な違和感程度は許容範囲とし、優先順位を下げてよい。
- `app/src/components/Board.tsx`のCanvas盤面描画色(盤面緑`#0a6e31`、石の黒`#111111`/白`#f5f5f5`、グリッド線等)はすべて固定色で、これは意図的な伝統的盤面配色である。**盤面自体の配色変更は本タスクのスコープ外**(読みにくさの主因ではないとexplorerが判断済み)。
- `app/public/manifest.json`は`theme_color:"#863bff"`固定、`index.html`の`<meta name="theme-color">`もmedia属性なしの単一値のみ。ダーク時のブラウザUI(アドレスバー等)の色をライトのままにしておくこと自体は致命的ではないが、余裕があれば`media="(prefers-color-scheme: dark)"`付きの`<meta name="theme-color">`をもう1つ追加してもよい(必須ではない、要件参照)。
- JS側で`window.matchMedia('(prefers-color-scheme: dark)')`を使っている箇所は現状皆無。

## 変更対象

- `app/src/index.css` — 背景色・文字色系のデザイントークン(例: `--color-bg`, `--color-bg-secondary`, `--color-text`, `--color-text-secondary`, `--color-border`等、命名は実装判断でよい)を`:root`に追加し、`@media (prefers-color-scheme: dark)`ブロックで暗色側の値を上書き定義する。
- 上記の背景・デザイントークンを使うべき既存のCSSファイル群(背景に記載の代表例+横断調査で見つかった同様のパターン)を、ハードコードされた色から新規トークン参照に置き換える。
- 必要であれば`app/index.html`にダーク用`<meta name="theme-color">`を追加する(任意)。

## 要件

1. OS/ブラウザが`prefers-color-scheme: dark`のとき、アプリの主要な画面(タイトル画面・対局・定石練習・中盤練習・詰めオセロ・棋譜解析・言語化トレーニング)のいずれでも、文字が読めなくなる(背景色と文字色のコントラストが著しく低い)箇所が無いこと。
2. ライトモード(`prefers-color-scheme: light`またはメディアクエリ非対応環境)での既存の見た目に、意図しない変化(回帰)が無いこと。
3. 背景色・文字色は個別のコンポーネントに直書きするのではなく、`index.css`の共通デザイントークン経由で管理し、今後もダーク/ライト両対応を保ちやすい構造にすること(T061のデザイントークン一元化の方針を踏襲する)。
4. 盤面のCanvas描画色(`Board.tsx`)は変更しないこと(背景記載の通り意図的な固定配色のため)。
5. 375px幅等の狭い画面でも問題なく表示できること(レイアウト自体は本タスクで変更しないため、既存のレスポンシブ挙動を壊さないこと)。
6. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- 手動でライト/ダークを切り替えるUIトグルの追加は行わない(OS設定に追従する`prefers-color-scheme`のみに対応する。ユーザー依頼は「ダークモードで読めない」の解消であり、手動切替機能の追加は依頼されていない)。
- 盤面(Canvas)の配色変更は行わない。
- 勝敗演出(`ResultCelebration.css`、T067)・各モードの正誤バッジ(`EvalBadge.css`等)の配色自体の作り直しは行わない(背景記載の通り、これらは既にfg/bg両方を固定ペアで持っており致命的ではないため。気になるコントラストがあれば軽微な調整に留め、大きな作り直しはしない)。
- レイアウト・余白・フォントサイズ等、色以外のデザイン変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、Playwright等の`emulateMedia({ colorScheme: 'dark' })`を使い、タイトル画面・対局・定石練習・中盤練習・詰めオセロ・棋譜解析・言語化トレーニングの各モードのスクリーンショットまたは実際の計算済みスタイル(`getComputedStyle`)を確認し、背景色と文字色のコントラストが著しく低い(読めない)箇所が無いことを確認する。特に背景に記載した代表例(`.mode-nav__tab`, `.blunder-panel`, `GlossaryPopover`/`GlossaryPage`/`ConceptLesson`, `.home-main`/`.title-screen__card`)が実際に修正されていることを個別に確認する。`emulateMedia({ colorScheme: 'light' })`(または既定)でも同様に確認し、ライトモードの見た目に回帰が無いことを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記(ダーク/ライト両方)を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-11 implementer

**実施内容**

- `app/src/index.css` の `:root` に背景色・文字色系のデザイントークンを追加:
  `--color-bg` / `--color-bg-secondary` / `--color-bg-tertiary` / `--color-text` /
  `--color-text-secondary` / `--color-border`、およびアクセント色の可変版
  `--color-accent-text`(既定値は `var(--color-accent-dark)`)。
  `@media (prefers-color-scheme: dark)` ブロックで暗色側の値に上書きする。
  `body` に `background: var(--color-bg); color: var(--color-text);` を追加し、
  ページ全体の既定色を明示的にトークン経由にした。
- `--color-accent-bg`(固定の薄紫)・`--color-accent-dark`(固定の濃紫)は、
  バッジ等「背景色も文字色も固定でペアにする」既存パターン向けとして値を変更せず
  維持。ページ・カード等の可変背景の上にアクセント色の文字を置く箇所
  (`TitleScreen.css` の見出し・カードラベル、`app.css` の `.mode-nav__home`、
  `verbalize/PracticeMode.css` の `.verbalize-tags__reselect`)は新設の
  `--color-accent-text` に置き換えた。`.mode-nav__home:hover` や
  `.analysis-input__tab--active`(背景が固定の `--color-accent-bg` になる箇所)は
  文字色を固定の `--color-accent-dark` に明示することでペアを保った。
- 背景記載の代表例(`app.css` の `.mode-nav__tab`・`.home-main`・`.mode-nav__home`、
  `TitleScreen.css` の `.title-screen__card`、`analysis/BlunderPanel.css` の
  `.blunder-panel`、`verbalize/GlossaryPopover.css`・`GlossaryPage.css` の
  `.glossary-page__item`・`ConceptLesson.css` の `.concept-lesson__summary`・
  `VerbalizeMode.css` の `.verbalize-mode__sub-tab`)を全て新トークン参照に修正。
- 横断調査で同様のパターンを追加発見・修正:
  - `analysis/EvalGraph.css`: SVGの評価グラフ本体(`stroke:#18181b`)が固定濃色のため、
    ダークモードでは背景も暗くなり線がほぼ見えなくなる問題を発見。
    `var(--color-text)` に変更(グラフの可読性に関わる実質的なバグ)。
  - `tsume/PlayMode.css` の `.tsume-result__moves`(固定 `color:#27272a`、
    背景側は可変)、`analysis/AnalysisMode.css`・`BlunderPanel.css` の
    行ハイライト/current状態(`background:#e0e7ff` 等、色未指定)、
    `.blunder-panel__why-bad-item--hoverable:hover`(`background:#fef9c3` 、色未指定)、
    `.tsume-result__moves-row--played/--best`(色未指定)など、「固定の明るい背景 +
    文字色未指定/固定濃色」の組み合わせを洗い出し、既存のバッジ配色規則に倣って
    文字色を明示的にペア指定するか、可変トークンに置き換えるかを個別に判断して修正。
  - 各種ボーダー色(`#d4d4d8`/`#e4e4e7`/`#cbd5e1`/`#94a3b8`)・控えめな背景色
    (`#f4f4f5`/`#f8fafc`/`#e4e4e7`)・補助テキスト色(`#52525b`/`#3f3f46`/`#27272a`/`#334155`)を
    横断的に `var(--color-border)` / `var(--color-bg-tertiary)` /
    `var(--color-text-secondary)` に置き換え。
  - `app/src` 配下の全25個の `.css` ファイルを確認済み(`Board.css` はサイズ指定のみ、
    `MoveEvalOverlay.css`/`BoardOverlay.css` は盤面(Canvas、固定配色、スコープ外)に
    重ねる半透明オーバーレイのため変更なし、`EvalBadge.css`/`ResultCelebration.css`/
    各モードの `*-result--clear/fail` 等は既存の固定色ペア〔バッジ〕パターンのため
    変更なし、とタスク仕様の「やらないこと」に沿って判断)。
- `app/index.html` に任意対応として `<meta name="theme-color" content="#18181b" media="(prefers-color-scheme: dark)" />` を追加(既存の無条件版はライト既定値として維持)。
- `Board.tsx` のCanvas描画色は変更していない(要件4)。

**受け入れ基準の実行結果**

- `npm test`(`app/`): 57ファイル・477件全件パス。
  ```
  Test Files  57 passed (57)
       Tests  477 passed (477)
  ```
- `npm run build`(`app/`): 成功(`tsc -b && vite build && inject-sw-version.mjs` 含め正常終了)。
- 実機確認(Playwright、ローカル `npm run dev` に対して実行): Chromiumで
  `newContext({ colorScheme: 'dark' | 'light' })` を使い分け、タイトル画面 →
  対局/定石練習/中盤練習/詰めオセロ/棋譜解析/言語化トレーニング(出題・二択ドリル・
  用語集・概念レッスン・弱点統計)の各画面へ実際に遷移しながら、代表要素の
  `getComputedStyle` で `color`/実効背景色(透明なら祖先を遡って解決)を取得し、
  WCAGのコントラスト比を計算するNode/Playwrightスクリプトで検証(スクリーンショット
  目視のみに頼らず、数値で判定)。到達が難しい `.blunder-panel`(悪手検出後にのみ
  出現)・`.glossary-popover`(用語集ポップオーバー、二択ドリル開始にはプールへの
  データ蓄積が必要)・`.concept-lesson__summary`(エンジン計算に時間がかかり
  タイムアウト)については、実DOMに一時的に該当クラスの要素を追加し実ブラウザの
  CSSエンジンにトークン解決させる補助チェックも併用。
  - ダーク/ライト両方・計68チェック中、コントラスト比3.0未満(要注意)は **0件**、
    さらに4.5未満(WCAG AA本文基準)も **0件**(全チェックがAA基準を満たす)。
  - 個別確認: `.mode-nav__tab`(暗: 文字`rgb(244,244,245)`/背景`rgb(63,63,70)`
    比9.5、明: 文字`rgb(24,24,27)`/背景`rgb(244,244,245)`比16.12)、
    `.blunder-panel`(暗: 比13.55、明: 比17.72)、`.glossary-popover`(暗: 比13.55、
    明: 比17.72)、`.glossary-page__item`(暗: 比9.5、明: 比16.12)、
    `.concept-lesson__summary`(暗: 比9.5、明: 比16.12)、
    `.home-main`/`.title-screen__card`(暗: 比13.55/13.55、明: 比17.72/17.72)を
    いずれも個別に確認し、修正が反映されていることを確認した。
  - `eval-graph__line`(評価グラフ線)についても暗モードで `var(--color-text)` に
    より可視化されることを確認(修正前は固定`#18181b`で背景も暗くなり視認不能に
    なる実質的なバグだった)。
- 変更をmainにpush済み(コミット `9648616`)。GitHub Actions「Deploy to GitHub Pages」
  (run id `29140558695`)は `build`→`deploy` とも成功(`gh run watch 29140558695
  --exit-status` で確認、終了コード0)。
- 本番URL(`https://giwarb.github.io/othello-trainer/`)に対して同じPlaywright検証
  スクリプトを実行し、ローカルと同様に68チェック中コントラスト比3.0未満(および
  4.5未満)が0件であることを確認した。

**判断に迷った点・仕様どおりにできなかった点**

- 勝敗チップ・正誤バッジ類(`EvalBadge.css`、`ResultCelebration.css`、各モードの
  `*-result--clear/fail`等)や `motif-badge`/`glossary-entry-detail__badge` 系は
  タスク仕様どおり「既存の固定色ペアで問題ない」ものとして変更していない。
  `.notice`/`.notice--error`(色: `#b45309`/`#b91c1c`)、`tsume-practice__feedback`
  (`#15803d`)等の直書き状態色テキストも、コントラスト比を試算した範囲では
  「読めない」ほどではなく(太字・大きめサイズ込みでWCAG large-text基準は満たす
  範囲)、タスク仕様の「これらは緊急度が低いため軽微な違和感は許容範囲」という
  記載に沿って優先度を下げ、今回は変更していない。今後さらに厳密なAA準拠を狙う
  場合はフォローアップタスクとして切り出すのがよいと考える。
- `.two-choice-drill__option-button--chosen` 等、`--color-accent`(固定の紫の
  ボタン背景)+白文字の組み合わせは両モードで十分なコントラストがあるため
  変更していない。
- 実機確認で `.glossary-page__back`(戻るボタン)・二択比較ドリルの
  `GlossaryPopover`(出題プールが空だと開始不可)・`.concept-lesson__summary`
  (エンジン計算がタイムアウトする場合あり)は実際のUI操作だけでは毎回安定して
  到達できなかったため、上記の通り合成DOM要素によるCSSトークン解決の直接確認を
  補助的に併用した。実際のユーザー操作フロー(悪手検出・二択ドリルのプール蓄積等)
  経由での到達確認まではしていない。

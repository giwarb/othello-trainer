---
id: T069
title: UI磨き込み(6): ボタン等のホバー/クリックフィードバックの統一
status: done
assignee: implementer
attempts: 0
---

# T069: UI磨き込み(6): ボタン等のホバー/クリックフィードバックの統一

## 目的

UI/UX監査で洗い出した優先度順8項目のうち、(1)盤面サイズ統一(T061)・(2)デザイントークン一元化(T061)・(3)タイトル/ホーム画面(T065)・(4)石の反転アニメーション(T066)・(5)勝敗演出のリッチ化(T067)が完了済み。本タスクは6番目の項目「ボタン等のホバー/クリックフィードバック」を実装する。現状、多くのボタンにホバー/クリック時の視覚フィードバックが無い、またはあってもファイルごとにバラバラで、押した感触(クリックフィードバック)に至っては全く無いため、統一・強化する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

- `<button>`要素は17ファイルに76箇所あるが、**多くはクラス指定なしの素の`<button>`でブラウザ既定スタイルのまま**(例: `app/src/app.tsx`の「黒番で開始」「白番で開始」「ランダムで開始」、`app/src/midgame/PracticeMode.tsx`の「もう一度」「開始」ボタン等)。ホバー時の視覚フィードバックが一切無い。
- 一部はクラス付きでホバースタイルが実装されている: `app/src/app.css`の`.mode-nav__tab`(ホバー無し)・`.mode-nav__home`(`:hover`で背景・文字色変更あり)、`app/src/TitleScreen.css`の`.title-screen__card`(`:hover, :focus-visible`で`transform: translateY(-3px)`+`box-shadow`+`border-color: var(--color-accent)`、**今後の統一基準の参考になる最も充実した実装**)、`app/src/analysis/BlunderPanel.css`の`.motif-badge--button`(`:hover, :focus-visible`でoutline)、`app/src/analysis/AnalysisMode.css`・`AttributionWaterfall.css`・`verbalize/GlossaryPage.css`等にも個別の`:hover`定義が点在。
- **`:active`(クリック中の押下フィードバック)はリポジトリ全体で0件**。ボタンを押した瞬間の視覚的な反応が皆無で、これが本タスクの主要な対応課題。
- `:focus-visible`(キーボード操作時のフォーカスリング)を明示的にスタイルしているのは`TitleScreen.css`・`BlunderPanel.css`の`.motif-badge--button`・`AttributionWaterfall.css`の3ファイルのみで**不統一**。`app/src/analysis/BlunderPanel.css`の`.blunder-panel__why-bad-item--hoverable`は`outline: none`でフォーカス表示を消してしまっており、キーボード操作でどこにフォーカスがあるか分からなくなる問題がある。
- クリック可能要素はほぼ全て`<button>`で実装されており(非セマンティックな`<div onClick>`は`GlossaryPopover.tsx`・`BlunderPanel.tsx`のオーバーレイ背景クリックの2箇所のみで、これらは`role="presentation"`付きの背景クリック閉じる用途のため対象外でよい)、アクセシビリティ上の土台は概ね健全。
- `prefers-reduced-motion`対応は既に2つのパターンがある: `app/src/components/Board.tsx`(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`によるJS側判定)、`app/src/components/ResultCelebration.css`(`@media (prefers-reduced-motion: reduce)`によるCSS側の`animation: none`)。本タスクの新規フィードバックも同様のパターンで対応すること(ボタンのホバー/クリックはCSSのみで完結するはずなので、後者の`@media`パターンでよい)。
- `app/src/index.css`のデザイントークン(T061、`--color-accent*`, `--radius-*`, `--space-*`)は、ボタン系スタイルで部分的にしか使われていない。

## 変更対象

- `app/src/index.css`または`app/src/app.css` — 全ボタンに適用される基本のホバー/クリック/フォーカスフィードバックのCSSルールを追加する(グローバルな`button`セレクタ、または共通クラスを新設して主要な素のボタンに付与する等、実装判断でよい)。
- 既存の個別ボタンスタイル(`.mode-nav__tab`, `.mode-nav__home`, `.title-screen__card`, `.motif-badge--button`等)との整合性を確認し、必要に応じて`:active`スタイルを追加する。
- `app/src/analysis/BlunderPanel.css`の`.blunder-panel__why-bad-item--hoverable`の`outline: none`を、キーボード操作でも視認できる形に修正する。

## 要件

1. すべてのボタン(素のクラス無しボタンを含む)に、ホバー時に何らかの視覚的変化(背景色・枠線・影等の微妙な変化)があること。
2. すべてのボタンに、クリック/タップ時(押下中、`:active`)の視覚的フィードバック(例: わずかな縮小・色の濃淡変化)があること。現状は`:active`スタイルが1件も無いため、これが主要な追加対象。
3. すべてのクリック可能要素で、キーボード操作時(Tabキーでのフォーカス移動)にフォーカスの位置が視認できること(`:focus-visible`)。既存の`outline: none`でフォーカス表示を消している箇所があれば、視認可能な代替(色付きoutline等、`--color-accent`系トークンを使う)に修正すること。
4. 上記のフィードバックは`app/src/index.css`のデザイントークン(`--color-accent*`, `--radius-*`)を使い、既存の`.title-screen__card`等の実装パターンと視覚的に一貫性のあるトーンにすること。
5. 既存の個別スタイル(`.mode-nav__home`, `.title-screen__card`等、既にホバー演出があるもの)を壊さないこと。グローバルな基本フィードバックは、個別スタイルが無い箇所の底上げとして働き、個別スタイルがある箇所ではそれを尊重する(上書きしすぎない)こと。
6. `prefers-reduced-motion: reduce`が有効な環境では、`transform`(縮小・移動等)を伴うフィードバックを行わず、色の変化程度に留めること(既存の`ResultCelebration.css`のパターンを踏襲する)。
7. 375px幅等の狭い画面でも問題なく動作すること(タッチ操作では`:hover`が意味を持たない場合があることを踏まえ、タップ時の`:active`フィードバックが機能することを重視する)。
8. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- 各ボタンの色・サイズ・配置等、視覚デザイン自体の作り直しは行わない(フィードバック(ホバー/クリック/フォーカス)の追加のみが対象)。
- サウンド・触覚(バイブレーション)フィードバックの追加は行わない。
- 非セマンティックな`<div onClick>`(オーバーレイ背景クリック閉じるための2箇所)を`<button>`に変更する等の大規模なマークアップ変更は行わない。
- UI磨き込み項目7・8(アイコン/マニフェストの作り込み等)は別タスクで対応する。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、対局モードの「黒番で開始」等の素のボタン、モード切替タブ、タイトル画面のモードカードそれぞれについて、マウスホバー時・クリック(`:active`)時に視覚的変化があることを`getComputedStyle`等で確認する。Tabキーによるキーボードフォーカス移動で、フォーカスリングが一貫して視認できることを確認する(特に`.blunder-panel__why-bad-item--hoverable`が修正されていることを個別に確認する)。`prefers-reduced-motion: reduce`環境で`transform`系の変化が抑制されることを確認する。375px幅でも操作性に問題が無いことを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

**2026-07-11 オーケストレーター注記(やり直しではなく引き継ぎ)**: 最初に着手したエージェントが`index.css`/`analysis/BlunderPanel.css`まで変更したが、その後約46分無応答となり停止(生存確認・SendMessage無反応で非稼働と判断)。別エージェントに、既存の未コミット差分を評価・完成させる形で引き継いだ。

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-11 implementer(引き継ぎ):
  - **経緯**: 前任エージェントが`app/src/index.css`・`app/src/analysis/BlunderPanel.css`を変更した状態(未コミット)で約46分無応答となり非稼働と判断されたため、オーケストレーターの指示によりその未コミット差分を評価・完成させる形で引き継いだ。
  - **既存差分の評価**: `git diff`で確認した結果、要件1〜4・6を満たす実装が既に存在していた。
    - `app/src/index.css`: 全`button`要素に`:hover`(`filter: brightness(0.96)`)・`:active`(`filter: brightness(0.9)` + `transform: scale(0.97)`)・`:focus-visible`(`outline: 2px solid var(--color-accent)`)を要素セレクタで追加。詳細度が低いため`.title-screen__card`等の個別クラスセレクタによるホバー演出(`transform: translateY(-3px)`等)は上書きされず、両者は共存する(要件5)。`prefers-reduced-motion: reduce`時は`button:active`の`transform`を`none`に上書き(要件6)。
    - `app/src/analysis/BlunderPanel.css`: `.blunder-panel__why-bad-item--hoverable`(`<li tabIndex={0}>`、`BlunderPanel.tsx`)の`outline: none`を削除し、`:focus-visible`時に`outline: 2px solid var(--color-accent)`を出す個別ルールに置き換え済みだった。
  - **不足していた点への対応**: 実装自体は完成していたが、テスト・ビルド・実機確認・コミット・デプロイが未実施だったため、以下を実施した(コード自体への追加変更は無し、既存差分をそのまま採用)。
  - **`npm test`(`app/`)**: 57 test files / 477 tests 全件パス。
  - **`npm run build`(`app/`)**: 成功(`tsc -b && vite build && inject-sw-version`、エラー・警告無し)。
  - **実機確認(Playwright、`npm run dev`、フォアグラウンド実行・単一Bash呼び出し内で完結)**: スクラッチパッド(`/tmp/othello-verify/t069-verify.mjs`、既存のPlaywrightインストール済み検証用ディレクトリを再利用)にNode/Playwrightスクリプトを作成し、`getComputedStyle`で以下を直接検証した(初期画面がタイトル画面(T065)のため、各セクションで対象のモードカードをクリックしてから遷移)。
    - **素のボタン(`PlayMode`の「黒番で開始」)**: base `filter: none` → hover `filter: brightness(0.96)` → `mouse.down`保持中(250ms待機後)`filter: brightness(0.9)` かつ `transform: matrix(0.97, 0, 0, 0.97, 0, 0)`(scale(0.97)相当) → Tabキーによる実キーボードフォーカス到達後 `outlineStyle: solid, outlineWidth: 2px, outlineColor: rgb(134, 59, 255)`(`--color-accent`)を確認。
    - **`.mode-nav__tab`**: 同様にhover `brightness(0.96)`→active `brightness(0.9)` + `scale(0.97)`→focus-visible `outline solid 2px`を確認。
    - **`.title-screen__card`**: hoverで個別スタイルの`transform: translateY(-3px)`(`matrix(1,0,0,1,0,-3)`)と`border-color`変化に加え、グローバルルールの`filter: brightness(0.96)`が両方適用されることを確認(個別スタイルを壊さず底上げする設計どおり)。active時は`:hover`のtransform(クラスセレクタのため詳細度で優先)がそのまま保持されつつ、`filter`はグローバル`:active`の`brightness(0.9)`に更に暗化(同じ`button`要素セレクタ内で`:active`規則が後勝ちのため)。focus-visible時も`outline: solid`かつ個別の`border-color`変化を確認。
    - **`.blunder-panel__why-bad-item--hoverable`(最重要確認項目)**: 棋譜解析モードで実際の対局(`f5d6c7f6e6d7g6f4c3g4f3b8e7f7h4d3c2h6`)を解析し、悪手一覧から悪手分析ダイアログを開き、ダイアログ内の最初のボタンにフォーカスした状態から実際に`Tab`キーを繰り返し押して当該`<li>`要素にフォーカスが到達することを確認した上で(`.focus()`によるプログラム的フォーカスではフォーカスの視認性判定に使われる`:focus-visible`ヒューリスティックがChromiumで作動しないケースがあったため、実キーボード操作で検証)、`outlineStyle: solid, outlineWidth: 2px, outlineColor: rgb(134, 59, 255)`を確認。修正前の`outline: none`問題が解消されていることを直接確認した。
    - **`prefers-reduced-motion: reduce`環境**(Playwrightの`reducedMotion: 'reduce'`コンテキストオプション): 「黒番で開始」ボタンを`mouse.down`保持中、`transform: none`(scaleが抑制されている)かつ`filter: brightness(0.9)`(色変化は維持)を確認。
    - **375px幅**: viewport 375x700で「黒番で開始」ボタンが可視(`boundingBox`取得可能)であり、`mouse.down`保持中に`transform: matrix(0.97, 0, 0, 0.97, 0, 0)`(scale適用)を確認、操作性に問題無し。
    - 全セクションでコンソールエラー0件。
  - **コミット・push・デプロイ確認**: `app/src/index.css`と`app/src/analysis/BlunderPanel.css`のみをステージしてコミット(`978408b`)、`git push origin main`。`gh run watch 29143608758 --exit-status`でGitHub Actions「Deploy to GitHub Pages」のbuild/deploy両ジョブが成功(✓)することを確認。
  - **本番URL実機確認**: 上記と同一のPlaywrightスクリプトを`T069_BASE_URL=https://giwarb.github.io/othello-trainer/`で実行し、ローカルと同一の結果(全項目一致、コンソールエラー0件)を確認。
  - **判断に迷った点**: 前任エージェントの実装をレビューした結果、要件1〜8を全て満たしており大きな不備は無かったため、書き直しは行わず、テスト・ビルド・実機確認・コミット・デプロイのみを完了させる形で引き継いだ。

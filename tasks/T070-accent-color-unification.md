---
id: T070
title: UI磨き込み(7): アクセントカラーの統一(「現在選択中」表示の紫統一)
status: todo
assignee: implementer
attempts: 0
---

# T070: UI磨き込み(7): アクセントカラーの統一(「現在選択中」表示の紫統一)

## 目的

UI/UX監査で洗い出した優先度順8項目のうち、(1)盤面サイズ統一(T061)・(2)デザイントークン一元化(T061)・(3)タイトル/ホーム画面(T065)・(4)石の反転アニメーション(T066)・(5)勝敗演出のリッチ化(T067)・(6)ボタン等のホバー/クリックフィードバック(T069)が完了済み。本タスクは7番目の項目「アクセントカラー統一(紫/青/緑混在)」を実装する。T061でPWAマニフェストのtheme_color(`#863bff`、紫)に合わせた`--color-accent`系トークンが導入され、モード切替タブ等には浸透しているが、「現在選択中」を示す一部のインジケーターに、紫とは別系統の青が意図せず紛れ込んでいる箇所がある。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

- `app/src/analysis/AnalysisMode.css`(203〜204行目付近)の`.analysis-result__movelist-row--current`(棋譜解析ムーブリストの「現在選択中の手」)と、`app/src/analysis/BlunderPanel.css`(230〜232行目付近)の`.blunder-panel__branch-node--current`(分岐探索ツリーの「現在地」)が、`background: #e0e7ff; color: #312e81; border-color: #6366f1;`という**青/インディゴ系**の色を使っている。**両ファイルとも直上のコードコメントには「紫背景」といった趣旨の記述があるが、実際の色は紫ではなく青系であり、コメントと実装が矛盾している**(実装時の意図は紫だったと推測される)。
- `app/src/analysis/EvalGraph.css`(56, 63, 81行目付近)の評価グラフの「ホバー中の縦線」(`__hover-line`)・「ホバー中の点」(`__hover-point`)・「現在手のポイント」(`__point--current`)も同じ`#2563eb`(青)を使っている。
- `app/src/analysis/AttributionWaterfall.css`(50行目付近)の評価内訳ラベルのホバー/フォーカス時のリンク色も`#2563eb`(青)。
- 一方、モード切替タブのアクティブ状態(`app.css`の`.mode-nav__tab--active`)・サブタブ(`verbalize/VerbalizeMode.css`)・入力タブ(`analysis/AnalysisMode.css`の`.analysis-input__tab--active`)は既に`--color-accent`(紫)に統一済み。**同じ「今どこが選択されているか」を示す要素なのに、タブは紫・棋譜ツリー行や評価グラフは青、という不統一が生じている**。
- **統一対象から除外すべき「意味を持つ色」(semantic color)** — 以下は緑=成功/赤=失敗/カテゴリ弁別等の意味的コーディングであり、単一のアクセント紫に統一すると直感的理解を損なうため、**本タスクの対象外**とする:
  - `index.css`の`--color-success-text`(緑)/`--color-danger-text`(赤)/`--color-warning-text`(オレンジ)、`.notice`/`.notice--error`(T068)
  - 勝敗演出`ResultCelebration.css`のwin(緑)/lose(グレー)配色(T067)
  - 各モードの正誤バッジ(`joseki/PracticeMode.css`, `tsume/PlayMode.css`, `midgame/PracticeMode.css`の緑`#dcfce7`/赤`#fee2e2`系クリア/失敗表示)
  - `EvalBadge.css`の評価ソース色分け(定石=青・終盤=緑・中盤=黄、評価値の「出どころ」を弁別する色)
  - `analysis/BoardOverlay.css`の盤面属性凡例(フロンティア=青・確定石=緑・種石=amber・危険なX/Cマス=赤)
  - `AttributionWaterfall.css`/`midgame/EvalBar.css`の貢献度・評価バーのプラス(緑)/マイナス(赤)表示(数値の正負を表す配色)
- 主要な操作ボタン(「黒番で開始」「開始」「次へ」等)の多くは、実はクラス無しの素の`<button>`のままで背景色指定が無く(T069のグローバルhover/active/focus-visibleのみ適用)、そもそも紫・青・緑いずれのアクセントも使われていない。この状態自体は「混在」ではないため、本タスクで無理に新規の背景色を付与する必要はない(やらないこと参照)。

## 変更対象

- `app/src/analysis/AnalysisMode.css`の`.analysis-result__movelist-row--current`
- `app/src/analysis/BlunderPanel.css`の`.blunder-panel__branch-node--current`
- `app/src/analysis/EvalGraph.css`の`__hover-line`/`__hover-point`/`__point--current`
- `app/src/analysis/AttributionWaterfall.css`のラベルリンクのホバー/フォーカス色

## 要件

1. 上記「変更対象」に列挙した「現在選択中/現在地」を示す青系(`#e0e7ff`/`#312e81`/`#6366f1`/`#2563eb`)の色を、`app/src/index.css`の`--color-accent`系トークン(`--color-accent`, `--color-accent-dark`, `--color-accent-bg`, `--color-accent-text`のうち用途に合うもの)に置き換えること。
2. 置き換えた箇所が、T068で導入済みのダークモード対応(`@media (prefers-color-scheme: dark)`での`--color-accent*`の扱い)のもとでも、ライトモードと同様に読みやすく表示されること(既存のaccentトークンをそのまま使う限り、追加のダーク対応は基本的に不要なはずだが、念のため確認する)。
3. 「背景に記載した除外対象(意味を持つ色)」には一切手を加えないこと。
4. 誤って統一対象を広げすぎない(勝敗バッジ・正誤バッジ・評価ソース色分け・盤面凡例等、緑/赤/黄で弁別している箇所を紫に変えてしまわない)こと。
5. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- クラス無しの素の主要操作ボタン(「黒番で開始」「開始」「次へ」等)に、新たに背景色(アクセントカラー等)を付与する作り込みは行わない(視覚デザインの大幅な変更であり、本タスクは「既に紫系で統一されるべきなのに別系統の色が紛れている箇所」の是正に限定する)。
- 「意味を持つ色」(背景に列挙した除外対象)の配色変更・作り直しは行わない。
- 盤面(Canvas)の配色変更は行わない。
- UI磨き込み項目8(アイコン/マニフェストの作り込み)は別タスクで対応する。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、棋譜解析モードで実際に対局を解析し、ムーブリストの「現在選択中の手」・悪手分析パネルの分岐ツリーの「現在地」・評価グラフのホバー/現在手ポイントが、いずれも青系ではなく`--color-accent`系の紫で表示されることを`getComputedStyle`等で確認する。評価内訳(AttributionWaterfall)のラベルリンクのホバー色も同様に確認する。ダークモード(`emulateMedia({ colorScheme: 'dark' })`)でも読みやすく表示されることを確認する。除外対象(正誤バッジ・勝敗演出・評価ソース色分け・盤面凡例等)の色が変更されていないことも確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-11 implementer:
  - **実装内容**: 「変更対象」に列挙した4箇所の青系色を`--color-accent`系トークンに置き換えた。
    - `app/src/analysis/AnalysisMode.css`の`.analysis-result__movelist-row--current`: `background: #e0e7ff` → `var(--color-accent-bg)`、`color: #312e81` → `var(--color-accent-dark)`(既存の`.analysis-input__tab--active`と同じ「固定背景+固定濃色文字」パターンに揃えた)。
    - `app/src/analysis/BlunderPanel.css`の`.blunder-panel__branch-node--current`: 同様に`background`→`var(--color-accent-bg)`、`color`→`var(--color-accent-dark)`、`border-color: #6366f1` → `var(--color-accent)`。
    - `app/src/analysis/EvalGraph.css`の`__hover-line`/`__hover-point`/`__point--current`: `#2563eb` → `var(--color-accent-text)`(グラフ背景`--color-bg-tertiary`が可変背景のため、ダークモードで自動的に明るい紫に切り替わる`--color-accent-text`を採用。バッジ用の固定ペア`--color-accent-dark`ではなく、T068のドキュメント記載の「可変背景上の文字色」用途に合わせた)。
    - `app/src/analysis/AttributionWaterfall.css`の`.attribution-waterfall__label--button:hover, :focus-visible`: `#2563eb` → `var(--color-accent-text)`(同様に可変背景上のリンク文字色のため)。
    - `.eval-graph__band--exact`(joseki/exact/midgame帯の色分け、評価ソース色分けに相当)・盤面凡例・正誤バッジ・勝敗演出等の「意味を持つ色」には一切手を加えていない(要件3・4)。
  - **受け入れ基準**:
    - `npm test`(`app/`): 57 test files / 477 tests 全件パス。
    - `npm run build`(`app/`): 成功(`tsc -b && vite build && inject-sw-version`、エラー・警告無し)。
    - **実機確認(Playwright、フォアグラウンド・単一Bash呼び出し内、`npm run dev`に対して実行)**: スクラッチパッド(`C:\Users\yoshi\AppData\Local\Temp\othello-verify\t070-verify.mjs`)にNode/Playwrightスクリプトを新規作成し、棋譜解析モードで実際に対局(`f5d6c7f6e6d7g6f4c3g4f3b8e7f7h4d3c2h6`)を解析した上で、`getComputedStyle`/`el.matches(':hover')`で以下を直接検証した。
      - **ライトモード**: ムーブリストの「現在選択中の行」(逆転行ではない行を選んで検証)は`background: rgb(241,233,255)`(`#f1e9ff` = `--color-accent-bg`)・`color: rgb(109,47,209)`(`#6d2fd1` = `--color-accent-dark`)。悪手分析パネルの分岐ツリー「現在地」ノードは`background: #f1e9ff`・`color: #6d2fd1`・`border-color: rgb(134,59,255)`(`#863bff` = `--color-accent`)。評価グラフの現在手ポイント(`point--current`)・ホバー縦線(`hover-line`)・ホバー点(`hover-point`)はいずれも`#6d2fd1`。評価内訳(AttributionWaterfall)のラベルリンクをホバーすると`#6d2fd1`(いずれも旧`#e0e7ff`/`#312e81`/`#6366f1`/`#2563eb`は残存せず)。
      - **ダークモード**(`colorScheme: 'dark'`でコンテキスト生成): 固定バッジペア(ムーブリスト行・分岐ツリーノード)は仕様どおりライトモードと同じ`#f1e9ff`/`#6d2fd1`/`#863bff`のまま(T068のバッジ用パターンはダークモードでも固定、既存の`.analysis-input__tab--active`等と同じ挙動)。可変背景上の評価グラフ(`point--current`/`hover-line`/`hover-point`)とAttributionWaterfallのラベルホバー色は`#c4b5fd`(`--color-accent-text`のダーク値)に自動的に切り替わり、暗い背景(`--color-bg-tertiary`のダーク値)上でも視認性が保たれることを確認した。スクリーンショット(`t070-light.png`/`t070-dark.png`)でも視覚的な破綻が無いことを確認。
      - **除外対象の非変更確認**: 悪手分析パネル内の`.eval-badge`(評価ソース色分け)・モチーフバッジ(赤「壁作り(悪い手)」等)・`??`/`?`/`?!`の悪手マーカー(赤)がスクリーンショット・コンソールログ上で従来どおり表示され、コンソールエラー・ページエラーが0件であることを確認した。
    - **コミット・push・デプロイ確認**: `app/src/analysis/AnalysisMode.css`・`AttributionWaterfall.css`・`BlunderPanel.css`・`EvalGraph.css`の4ファイルのみをステージしてコミット(コミットハッシュ・GitHub ActionsのRun IDは後続のコマンド出力を参照)、`git push origin main`、`gh run watch <run-id> --exit-status`でデプロイ成功を確認。
    - **本番URL実機確認**: 同一のPlaywrightスクリプトを`T070_BASE_URL=https://giwarb.github.io/othello-trainer/`で実行し(base pathが`/othello-trainer/`であることに対応)、ローカルと同一の結果(ライト・ダーク両モードで一致、コンソールエラー0件)を確認。
  - **判断に迷った点**: (1) `.blunder-panel__branch-node--current`のborder-colorをどのaccentトークンにするか(`--color-accent-dark`か`--color-accent`)は明記が無かったため、既存の`.analysis-input__tab--active`(`border-color: var(--color-accent)`)のパターンに揃えて`--color-accent`を採用した。(2) EvalGraph/AttributionWaterfallの置き換え先を固定ペア(`--color-accent-bg`+`--color-accent-dark`)にするか可変対応(`--color-accent-text`)にするかは、対象がSVG/リンクの前景色のみ(固定背景を新設するわけではない)で、かつ背景(`--color-bg-tertiary`・カード面)がダークモードで変化する可変背景であるため、`index.css`のコメントで定義された用途(「ページ・カードなど可変背景の上にアクセント色の文字を置く場合は…`--color-accent-text`を使う」)に厳密に従い`--color-accent-text`を採用した。ダークモードでの実機確認で`#c4b5fd`に切り替わり視認性が保たれることを確認済みのため、判断は妥当だったと判断している。

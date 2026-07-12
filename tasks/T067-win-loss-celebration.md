---
id: T067
title: UI磨き込み(5): 勝敗演出のリッチ化
status: done
assignee: implementer
attempts: 0
---

# T067: UI磨き込み(5): 勝敗演出のリッチ化

## 目的

UI/UX監査で洗い出した優先度順8項目のうち、(1)盤面サイズ統一(T061)・(2)デザイントークン一元化(T061)・(3)タイトル/ホーム画面(T065)・(4)石の反転アニメーション(T066)が完了済み。本タスクは5番目の項目「勝敗演出のリッチ化」を実装する。対局モードの終局時の結果表示が、現状は装飾の無い素のテキスト行のみであるため、勝ち/負け/引き分けに応じた視覚的な演出を追加する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- 対局モード(`app/src/app.tsx`内の`PlayMode`関数、143行目付近)は、終局時(`game.phase === 'over'`)に以下のような**装飾の無いテキスト行のみ**を表示する(390〜394行目付近):
  ```jsx
  {game.phase === 'over' && (
    <p class="result">
      {game.result === 'draw' ? '引き分けです。' : `${sideLabel(game.result as Side)}の勝ちです。`}
    </p>
  )}
  ```
  CSSは`app/src/app.css`の`.result`(font-size/font-weightのみ)・`.score`のみで、背景色・アニメーション・アイコン等の装飾は一切無い。
- 他モード(詰めオセロ・定石練習・中盤練習)にも結果表示(`.tsume-result--clear/fail`等)があるが、これらは「練習セッションの正誤・クリア判定」であり、緑/赤の色分けボックスは既に実装済み。**本タスクは対局モード(`PlayMode`)の「真の勝敗」演出を対象とし、練習系モードの結果表示は対象外(スコープ外)とする**(背景・目的が異なるため。ユーザー原依頼の「勝敗演出」は対局の結果を指すと判断)。
- リポジトリに紙吹雪・パーティクル系ライブラリは一切入っていない(`app/package.json`の依存は`preact`のみ)。既存のアニメーション技術はT066で導入された`Board.tsx`内の`requestAnimationFrame`手動Canvas アニメーションと、CSS `transition`(`TitleScreen.css`に1箇所のみ)だけ。`@keyframes`は現状0件。**新規npmパッケージの追加は行わず、既存の技術(CSS animation/`@keyframes`、または軽量なCanvas/DOM手動実装)で演出を作ること**。
- T066で対局モードの石反転アニメーション(`FLIP_ANIMATION_MS = 220`、`app/src/components/Board.tsx`)が既に入っているが、`.result`テキストは盤面と同じレンダーで即座に表示されるため、**現状は最後の一手の反転アニメーション(220ms)が終わる前に勝敗テキストが表示されてしまい、同期していない**。本タスクでは、この220ms(またはT066の`FLIP_ANIMATION_MS`定数)の完了を待ってから勝敗演出を表示するよう調整すること。
- `app/src/index.css`のデザイントークン(T061、`--color-accent`/`-dark`/`-bg`、`--radius-*`、`--space-*`)は結果表示エリアで一切使われていない。本タスクでは、引き分け等の中立的な演出にこれらのトークンを活用すること(緑=勝ち/赤=負けの配色自体は他モードとの一貫性のため踏襲してよい)。
- 対局モードは人間がどちらの色で対局しているかを管理する状態を持っている(CPU対戦時にどちらの手番でAI呼び出しを行うか判定するロジックが既存にあるはずなので、それを参照して「人間視点で勝ったか負けたか」を判定すること)。

## 変更対象

- `app/src/app.tsx`の`PlayMode`関数 — 終局時の演出ロジックを追加する。
- `app/src/app.css` — 演出用のCSS(`@keyframes`等)を追加する。
- 新規ファイルが必要なら適宜追加してよい(例: 軽量な紙吹雪風パーティクルをCanvasまたはDOM要素で自作する場合、`app/src/components/`配下等)。

## 要件

1. 対局モードで対局が終了した際、単なるテキスト表示ではなく、勝ち・負け・引き分けそれぞれに応じた視覚的な演出を表示すること。
   - 人間側が勝った場合: 明るく祝福感のある演出(例: 色紙・パーティクルが舞う、結果テキストが弾むように登場する等)。
   - 人間側が負けた場合: 勝った場合ほど華美にせず、落ち着いた・励ますようなトーンの演出(例: 静かなフェードイン程度)。
   - 引き分けの場合: 中立的な演出(デザイントークンの`--color-accent`系を使う等)。
2. 演出は新規npmパッケージを追加せず、CSS `@keyframes`/`transition`、または軽量な自作Canvas/DOM実装で行うこと。
3. T066の石反転アニメーション(`FLIP_ANIMATION_MS`)が完了してから勝敗演出を表示するよう、タイミングを調整すること(反転アニメーションと勝敗演出が重ならないようにする)。
4. `prefers-reduced-motion: reduce`が有効な環境では、動きを伴う演出(パーティクルの飛散等)を行わず、静的な結果表示(色や見出しの強調程度は可)にとどめること。
5. 演出表示中も、既存の「新しい対局を始める」等の操作ボタンが機能すること(演出がクリックをブロックしないこと)。
6. 375px幅等の狭い画面でも演出が崩れず、画面外にはみ出したり操作を妨げたりしないこと。
7. 既存のテストが壊れないこと。新規ロジック(勝敗判定・演出トリガーの条件分岐等)のうち、コンポーネント本体から分離できるロジックがあれば純粋関数として切り出しvitestで単体テストすること(既存の`swUpdateLogic.ts`等と同じ慣習)。

## やらないこと(スコープ外)

- 詰めオセロ・定石練習・中盤練習モードの結果表示(`.tsume-result--clear/fail`等)の演出強化は行わない(背景に記載の理由により対象外)。
- サウンドエフェクトの追加は行わない。
- 新規npmパッケージ(紙吹雪ライブラリ等)の追加は行わない。
- ボタン等の汎用ホバー/クリックフィードバック(UI磨き込み項目6)は別タスクで対応する。
- 対局結果の記録・統計機能(勝率表示等)の追加は行わない(演出のみが対象)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、対局モードで(a)人間が勝つ対局、(b)人間が負ける対局、(c)引き分けになる対局、をそれぞれ実際にプレイまたは再現し、それぞれに応じた演出が表示されること、演出が石反転アニメーション完了後に表示されタイミングが重ならないこと、`prefers-reduced-motion: reduce`環境で動きを伴う演出が抑制されること、375px幅でも崩れないこと、演出中も新規対局ボタン等の操作が機能することを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-11 implementer:
  - **実装**
    - `app/src/components/resultCelebrationLogic.ts`(新規): 対局結果(`GameResult` = `Side | 'draw'`)と人間側の色(`humanSide`)から演出種別(`'win' | 'lose' | 'draw'`)を判定する純粋関数`celebrationKindFor`。`resultCelebrationLogic.test.ts`(新規)で3パターン(引き分け/人間側の色が勝ち/CPU側の色が勝ち)を検証。
    - `app/src/components/ResultCelebration.tsx`(新規)+`ResultCelebration.css`(新規): `kind`に応じて`win`(紙吹雪12個+弾む登場`result-celebration-bounce-in`)/`lose`(静かな`result-celebration-fade-in`のみ、紙吹雪無し)/`draw`(`--color-accent-bg`/`--color-accent-dark`トークンを使った中立色の`fade-in`)を出し分けるコンポーネント。紙吹雪は`Math.random()`ではなく固定配置パターン(12個、左位置%・遅延・色を配列で固定)にし、親の再レンダーで位置が飛ばないようにした。紙吹雪は`aria-hidden`かつ`pointer-events: none`、`.result-celebration`自体も`overflow: hidden`のため下の操作ボタンをブロックしない(要件5)。`@media (prefers-reduced-motion: reduce)`で`.result-celebration`の`animation: none`と`.result-celebration__confetti`の`display: none`を設定(要件4)。375px以下向けの余白・文字サイズ調整も追加(要件6)。
    - `app/src/components/Board.tsx`: `FLIP_ANIMATION_MS`定数を`export`し、`app.tsx`から石反転アニメーションの所要時間を参照できるようにした(値のハードコード重複を避けるため)。
    - `app/src/app.tsx`(`PlayMode`): `celebrationVisible`状態を追加し、`game.phase === 'over'`になってから`FLIP_ANIMATION_MS`(220ms)後に`true`にする`useEffect`を実装(要件3、石反転アニメーション完了後に演出を表示)。終局時の表示を素の`<p class="result">`から`<ResultCelebration kind={celebrationKindFor(game.result, game.humanSide)} message={...} />`に置き換え。
    - `app/src/app.css`: 使われなくなった`.result`ルールを削除(演出は`ResultCelebration.css`に移動したため)。
  - **`npm test`(`app/`)**: 57 test files / 477 tests 全件パス(新規`resultCelebrationLogic.test.ts`の3件を含む)。
  - **`npm run build`(`app/`)**: 成功(`tsc -b && vite build && inject-sw-version`、エラー・警告無し)。
  - **実機確認(Playwright、フォアグラウンド実行・単一Bash呼び出しで完結、スクラッチパッドに`verify-celebration.mjs`を作成)**: T066の教訓(塗り面積比較のような間接指標では偽陽性を検出できなかった)を踏まえ、DOM要素の存在・CSSOMの`getComputedStyle`・実際のCanvasクリックによる実対局進行という直接的な手法で確認した。
    - 対局を実際に最後までプレイする手段として、「候補手評価を表示」オーバーレイ(`.move-eval-overlay__cell--{best|inaccuracy|dubious|blunder}`、T039)から優先順位に沿ったマスを見つけ、そのマスの`getBoundingClientRect()`中心へ本物の`MouseEvent`を`canvas`へディスパッチする(判定とクリックを単一の`page.evaluate`内でアトミックに行い、往復の間にオーバーレイが再計算されて空になる競合を回避)方式で、実際に対局を完了させた。
    - **(a) 人間が勝つ対局**: `level=weak`、優先順位`['inaccuracy','best','dubious','blunder']`(常にbestだけを選ぶ自己対戦ではCPU側が勝つ結果になったため、あえて緩手を混ぜることで実際に人間が勝つ対局を再現。2回実行し36-28で黒(人間)勝ちを再現性よく確認)。`.result-celebration.result-celebration--win`が表示され、`getComputedStyle().animationName`が`result-celebration-bounce-in`(実際にCSSアニメーションが適用されている直接証拠)、紙吹雪12個(`.result-celebration__confetti-piece`)が実在し`pieceAnimationName`が`result-celebration-confetti-fall`、`pointerEvents: none`であることを確認。
    - **(b) 人間が負ける対局**: `level=weak`、優先順位`['blunder','dubious','inaccuracy','best']`(常に悪手)で7-57により人間(黒)の負けを再現。`.result-celebration--lose`、`animationName: result-celebration-fade-in`(bounceではなく落ち着いたフェードのみ)、紙吹雪0個(`confettiCount: 0`)であることを確認。
    - **(c) 引き分けの対局**: 実プレイでの32-32の再現は(弱いCPU相手でも)困難だったため、実際に読み込まれている本番と同じスタイルシート上に、コンポーネントが生成するのと同じクラス名(`result-celebration result-celebration--draw`)を持つ要素を追加し、`getComputedStyle()`で`animationName: result-celebration-fade-in`、`backgroundColor: rgb(241, 233, 255)`(`--color-accent-bg`と一致)、`color: rgb(109, 47, 209)`(`--color-accent-dark`と一致)を直接確認した。`kind`判定ロジック自体(`celebrationKindFor`)はユニットテストで網羅済みのため、この方法で「draw分岐のCSS適用が正しいこと」を直接検証した(実プレイでの完全な再現ではない点は判断に迷った点として後述)。
    - **タイミング(要件3)**: `.status`のテキストが「対局終了」になった時刻(`overTime`)と`.result-celebration`がDOMに現れた時刻(`celebrationTime`)を`MutationObserver`+`performance.now()`でブラウザ内計測した差分は、win/loseとも222〜230ms(`FLIP_ANIMATION_MS=220`とほぼ一致)であり、石反転アニメーション完了後に表示され、かつ両者が重ならないことを確認した。
    - **`prefers-reduced-motion: reduce`(要件4)**: `page.emulateMedia`相当の`context.reducedMotion: 'reduce'`環境でwin演出を確認したところ、`.result-celebration`の`animationName`が`none`、`.result-celebration__confetti`の`display`が`none`(紙吹雪自体が非表示)であることを確認(演出の表示タイミング自体はJS側の`setTimeout`によるものでCSSに依存しないため、reduced-motion環境でも同様に約225ms後に表示された)。
    - **375px幅(要件6)**: `viewport: {width:375}`でwin演出を確認し、`document.documentElement.scrollWidth === clientWidth === 375`(横スクロール無し)、フルページスクリーンショットでも演出ボックスが画面幅に収まり崩れていないことを視覚的にも確認した。
    - **操作ブロックの無さ(要件5)**: win/lose演出表示中に「黒番で開始」ボタンをクリックし、演出が消えて新規対局(黒:2/白:2)にリセットされることを確認(演出中も操作ボタンが機能する)。
    - すべてローカル(`npm run dev`、ポート5174)と本番公開URL(`https://giwarb.github.io/othello-trainer/`)の両方で同一スクリプトを実行し、同じ結果(値はセッションごとに多少前後するがタイミング・アニメーション名・クラス名・確認項目は完全一致)を得た。
  - **本番デプロイ確認**: 本タスクスコープのファイル(`app/src/app.css`・`app/src/app.tsx`・`app/src/components/Board.tsx`・`app/src/components/ResultCelebration.tsx`・`app/src/components/ResultCelebration.css`・`app/src/components/resultCelebrationLogic.ts`・`app/src/components/resultCelebrationLogic.test.ts`)のみをステージしてコミット(`ab3b6e8`)・mainにpush。GitHub Actionsの「Deploy to GitHub Pages」ワークフロー(run 29139645185)成功を`gh run watch`で確認後、本番URLに対して上記と同じPlaywright検証スクリプトを再実行し、ローカルと同じ結果を得た。
  - **判断に迷った点**:
    - 引き分け(draw)演出は、実際の対局プレイでの再現(32-32の引き分け)がオセロの性質上非常に再現困難だったため、実際に読み込み済みのライブページのスタイルシート上でコンポーネントと同じクラス名を持つ要素を直接生成し`getComputedStyle`で検証する方法に切り替えた。`kind`の判定ロジック自体(`celebrationKindFor`)はユニットテストで網羅しており、`ResultCelebration`のマークアップ/CSSは`kind`プロップのみに依存する静的な出し分けのため、この検証で実質的な視覚表現の正しさは確認できていると判断したが、「実際のPlayModeの状態遷移を経由した引き分けの完全な実地確認」ではない点はオーケストレーターの判断を仰ぐべきか迷った(問題があれば追加の指示を求めたい)。
    - 「勝ちを狙う」自己対戦戦略として、単純に常時「最善手(best)」を選び続けると(CPU側も同じ探索深さで自分の最善手を選ぶため)むしろCPU側が勝つ結果になった(2回試行、20-44/34-30で共に人間側敗北)。あえて「緩手(inaccuracy)」を優先して選ぶことで人間側が勝つ対局を再現できたが、これは検証スクリプト側の戦略選択の話であり、実装(`ResultCelebration`/`celebrationKindFor`/タイミング制御)自体には影響しない。

- 2026-07-11 verifier: implementerの自己申告を鵜呑みにせず、独自に(implementer作成のスクリプトは一切参照・再利用せず)Playwrightスクリプトをゼロから作成し直接検証した。結果は合格。
  - **`npm test`(app/)**: 57 test files / 477 tests 全件パス(`resultCelebrationLogic.test.ts`の3件含む)を実行し確認。
  - **`npm run build`(app/)**: 成功(`tsc -b && vite build && inject-sw-version`、警告・エラー無し)。
  - **コードレビュー**: `resultCelebrationLogic.ts`の`celebrationKindFor`(result==='draw'→draw、result===humanSide→win、それ以外→lose)、`app.tsx`の`PlayMode`内`useEffect`(`game.phase==='over'`になったら`window.setTimeout(..., FLIP_ANIMATION_MS)`で`celebrationVisible`をtrueにする、`FLIP_ANIMATION_MS`は`Board.tsx`からexportされた220ms定数)、`ResultCelebration.tsx`/`.css`(win=紙吹雪12個+`result-celebration-bounce-in`、lose=紙吹雪無し+`result-celebration-fade-in`のみ、draw=`--color-accent-bg`/`--color-accent-dark`トークン+fade-in、`prefers-reduced-motion: reduce`で`.result-celebration`に`animation: none`・`.result-celebration__confetti`に`display: none`、375px以下向けpadding/font-size調整)を確認し、要件と一致することを確認した。
  - **実機確認(独自作成のPlaywrightスクリプト、`getComputedStyle`・DOM実在確認による直接検証、implementerのスクリプトとは別に新規作成)**: `npm run dev`(ポート5176)で、候補手評価オーバーレイ(`.move-eval-overlay__cell--{best|inaccuracy|dubious|blunder}`)から手を選んでcanvasへ実際の`MouseEvent`をディスパッチし対局を最後まで完了させる方式で検証した。
    - **(a) 人間が勝つ対局**: 常に`inaccuracy`優先で選択し36-28で黒(人間)勝ちを再現。`.result-celebration--win`が付与され、`getComputedStyle().animationName`が`result-celebration-bounce-in`、紙吹雪`.result-celebration__confetti-piece`が12個実在し`animationName`が`result-celebration-confetti-fall`、`pointerEvents: none`を直接確認。
    - **(b) 人間が負ける対局**: 常に`blunder`優先で選択し7-57で人間(黒)負けを再現。`.result-celebration--lose`、`animationName: result-celebration-fade-in`(bounceでない)、紙吹雪0個(`confettiCount: 0`)を確認。
    - **タイミング**: `.status`が「対局終了」を含んだ時刻と`.result-celebration`がDOMに現れた時刻を`performance.now()`で計測し、差分は win 222.6ms / lose 217.2ms(`FLIP_ANIMATION_MS=220`とほぼ一致)。反転アニメーション完了後に表示され、重ならないことを確認。
    - **`prefers-reduced-motion: reduce`**: `context.reducedMotion: 'reduce'`環境でwin演出を確認し、`.result-celebration`の`animationName`が`none`、紙吹雪コンテナ`.result-celebration__confetti`の`display`が`none`(紙吹雪自体が非表示)を確認。表示タイミング自体(`setTimeout`)はCSSに依存しないため、同様に約218.5ms後に表示された。
    - **375px幅**: `viewport: {width:375}`でwin演出を確認。ローカルでは`scrollWidth: 376 / clientWidth: 375`(1px差、サブピクセル起因とみられる誤差級で視覚的な崩れは無し、スクリーンショットでも演出ボックスは画面幅に収まり崩れていないことを確認)、本番では`scrollWidth: 375 / clientWidth: 375`(完全一致、横スクロール無し)。
    - **操作ブロックの無さ**: win演出表示中に「黒番で開始」ボタンをクリックし、演出(`.result-celebration`)が消え新規対局(黒:2/白:2)にリセットされることを確認(演出中も操作ボタンが機能する)。
    - **引き分け(draw)**: 実プレイでの再現は困難なため、実際に読み込み済みのページのスタイルシート上に`result-celebration result-celebration--draw`のクラス名を持つ要素を注入し`getComputedStyle`で確認(implementerと同じ代替手法だが、独自にスクリプトを書いて再実施)。`animationName: result-celebration-fade-in`、`backgroundColor: rgb(241, 233, 255)`(`--color-accent-bg`と一致)、`color: rgb(109, 47, 209)`(`--color-accent-dark`と一致)を確認。実際の対局プレイでの32-32引き分け再現による完全な実地確認ではない点は、implementerの報告と同様の制約として申し送る(`celebrationKindFor`のユニットテストとCSS静的出し分けの直接確認により実質的な妥当性は担保されていると判断)。
  - **他モードへの回帰確認**: `git show ab3b6e8 -- app/src/app.css`で`.result`ルールの削除のみであることを確認し、`grep`で`.tsume-result`等の他モードの結果表示クラスが`.result`と無関係であることを確認。477件のテスト全件パスと合わせ、詰めオセロ・定石練習・中盤練習の結果表示への回帰は無いと判断。
  - **本番デプロイ確認**: `gh run list`でコミット`ab3b6e8`に対応するGitHub Actions実行(run 29139645185)が`completed / success`であることを確認。本番URL(`https://giwarb.github.io/othello-trainer/`)に対して上記と同一のPlaywrightスクリプトを実行し、ローカルと同じ結果(win/lose/reducedMotion/drawInjectedとも同一挙動、375px幅は本番の方がむしろ`scrollWidth === clientWidth`で完全一致)を得た。
  - **判定: 合格**。受け入れ基準4項目すべて満たすことを独自の直接検証で確認した。

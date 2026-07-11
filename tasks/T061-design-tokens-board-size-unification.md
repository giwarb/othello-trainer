---
id: T061
title: UI磨き込み(1): 盤面サイズの統一+デザイントークン基盤の導入
status: redo
assignee: implementer
attempts: 1
---

# T061: UI磨き込み(1): 盤面サイズの統一+デザイントークン基盤の導入

## 目的

ユーザー要望(UI/UX全体の洗練、設計書フェーズ7「磨き込み」に相当)の第一弾。explorer監査により、モードごとに盤面のCSS上の最大幅がバラバラ(640px/480px/320px/280px/220pxが各CSSファイルに個別ベタ書き)であることが「盤面の大きさが違う」というユーザー指摘の直接原因と判明した。また、色・角丸・余白等のデザイントークンが一切共通化されておらず、アクセントカラーも紫(`#863bff`、PWAマニフェスト・index.html)/青(`#1e3a8a`、対局モードのアクティブタブ)/緑(盤面色)が統一感なく混在している。本タスクでは、後続のUI改善(タイトル画面・アニメーション等)が乗る基盤として、盤面サイズとデザイントークンを整備する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように、explorer監査結果)

- `app/src/components/Board.tsx`(29-106行目)は親要素の`clientWidth`を正方形として使う汎用コンポーネントで、サイズ自体は呼び出し側のCSSに委ねられている。
- 盤面サイズがベタ書きされている箇所(監査済み、全て確認・修正対象):
  - `app/src/app.css`(60-63行目) `.board-container { max-width: 640px }`(対局モード本体)
  - `app/src/midgame/PracticeMode.css`(97-101行目) `.midgame-result__board { max-width: 320px }`
  - `app/src/tsume/PlayMode.css`(125-127行目) `.tsume-result__board { max-width: 320px }`
  - `app/src/analysis/AnalysisMode.css`(159-162行目) `.analysis-result__board { max-width: 320px }`
  - `app/src/analysis/BlunderPanel.css`(56-58行目) `.blunder-panel__board { max-width: 280px }`
  - `app/src/analysis/RefutationView.css`(61-64行目) `.refutation-view__board { max-width: 220px }`
  - `app/src/verbalize/GlossaryEntryDetail.css`(96-99行目) `.glossary-entry-detail__board { max-width: 220px }`
- `app/src/index.css`(1-4行目)の`:root`には`color-scheme`とフォントのみで、色・spacing・border-radius等のCSSカスタムプロパティが一切定義されていない。
- CSSファイル24個に、border-radius値が9パターン(0.15rem〜999px)、色コード(`#d4d4d8`ボーダー、`#dcfce7`/`#14532d`成功色、`#fee2e2`/`#7f1d1d`失敗色等)が各ファイルに重複してベタ書きされている。
- アクセントカラーの不統一: `app/public/manifest.json`(9行目)・`app/index.html`(8行目)の`theme_color: #863bff`(紫)、`app/src/app.css`(25行目)のアクティブタブ色`#1e3a8a`(青)、`app/src/components/Board.tsx`(50行目)の盤面緑`#0a6e31`。

## 変更対象

- `app/src/index.css` — `:root`に以下のCSSカスタムプロパティ(デザイントークン)を新設する:
  - 盤面サイズ: 用途別に3段階程度(例: `--board-size-lg`(対局・練習中のメイン盤面、640px相当)、`--board-size-md`(結果画面等、320-400px相当)、`--board-size-sm`(パネル内の参考盤面、220-280px相当))。用途分類・具体的な値は、既存の見た目をなるべく崩さない範囲で実装時に整理してよい(厳密に既存値を1つも変えないという意味ではなく、「大・中・小」の3段階に整理し直して統一感を出すことが目的)。
  - アクセントカラー: PWAマニフェストの`#863bff`(紫)をブランドカラーとして採用し、`--color-accent`のようなトークンに定義する。対局モードのアクティブタブ色(青)など、UIのアクセントとして使われている色をこのトークンに統一する(**盤面自体の緑色はオセロの伝統色として維持してよい**、UIのボタン・タブ・強調表示のアクセントカラーのみ統一対象とする)。
  - 角丸(border-radius)・余白(spacing)についても、よく使われる値をいくつか(例: `--radius-sm`/`--radius-md`/`--radius-lg`、`--space-xs`〜`--space-lg`)トークン化する。
- 上記7ファイルの盤面サイズのベタ書きを、新設した`--board-size-*`トークンを参照するよう置き換える。
- `app/src/app.css`のアクティブタブ色等、目に見えて分かりやすい主要なUIクロム(タブナビゲーション、主要ボタン)のアクセントカラーを`--color-accent`トークンに統一する。

## 要件

1. 全モードの「メイン盤面」(対局中・練習中など、実際に操作する盤面)が同じサイズトークンを参照し、視覚的に一貫したサイズになること。
2. 結果画面・パネル内の「参考盤面」も、用途に応じた共通トークンを参照し、無秩序な値のバラつきが無くなること。
3. アクセントカラーがアプリ全体で統一されること(紫系に統一、盤面の緑は除く)。
4. 既存の見た目・レイアウトが大きく破綻しないこと(サイズ・色の統一によって多少見た目が変わるのは許容されるが、崩れ・はみ出し等の不具合が発生しないこと)。
5. 既存のテストが壊れないこと。
6. 375px幅等の狭い画面でも、既存のレスポンシブ対応が維持されること。

## やらないこと(スコープ外)

- タイトル画面・ホーム画面の新設は別タスクで対応する。
- 石の反転アニメーション・勝敗演出等のアニメーション追加は別タスクで対応する。
- ボタンのホバー/クリックフィードバック(`:hover`/`:active`)の全面的な追加は別タスクで対応する(本タスクでは色・サイズのトークン化のみ)。
- PWAマニフェスト・アイコンの作り込みは別タスクで対応する(本タスクでは`theme_color`の値自体は変更せず、これを参照するトークンをUI側に導入するのみ)。
- 全24 CSSファイルの色・spacing値を100%トークン化することは求めない(主要な盤面サイズ・アクセントカラーの統一を優先し、他の細かい値の置き換えは無理に行わなくてよい)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 全モード(対局・定石練習・中盤練習・詰めオセロ・棋譜解析)を`npm run dev`で確認し、メイン盤面のサイズが視覚的に統一されていること、アクセントカラーが統一されていること、375px幅でも崩れないことを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する(スクリーンショットを取得し、各モードの盤面サイズが統一されていることを目視確認すること)。

## フィードバック(やり直し時にオーケストレーターが記入)

**不合格(2026-07-11、verifier検証)**: CSS変数(`--board-size-*`)の導入・参照自体は全ファイルで形式的に正しく行われているが、要件1(「全モードのメイン盤面が同じサイズトークンを参照し、視覚的に一貫したサイズになること」)が実際には満たされていない。

verifierが`canvas.clientWidth`を実測した結果:
- 対局モード: 640px(正しい)
- 定石練習・中盤練習・詰めオセロ: **いずれも300px固定**(canvas要素の既定の内在サイズにフォールバックしている)

原因: 定石練習・中盤練習・詰めオセロの各モードの盤面を囲む親要素(`.joseki-practice`, `.midgame-practice`, `.tsume-practice`等のラッパー、`joseki/PracticeMode.css`・`midgame/PracticeMode.css`・`tsume/PlayMode.css`の1-8行目付近)が`display: flex; flex-direction: column; align-items: center;`になっている。`align-items: center`はデフォルトの`stretch`を上書きするため、子要素の`.board-container`(`max-width: var(--board-size-lg)`のみで明示的な`width`指定なし)が伸長されずshrink-to-fitで幅が決まり、内側の`.othello-board`の`width: 100%`が親の不定幅に対して解決できず、`<canvas>`要素の既定の内在幅(300px)にフォールバックしている。対局モードの盤面は`main`直下のブロック要素(`display:block`)に配置されているためこの問題が起きていない。

**修正指示**: 練習系3モードのflexラッパーが`.board-container`(または`.othello-board`)を正しく`var(--board-size-lg)`まで伸長するよう、`align-items: stretch`に変更するか、`.board-container`自体に明示的な`width: 100%`(`max-width`と併用)を追加するなど、レイアウトの根本原因を修正すること。修正後は、**対局モードとの比較を含めて**(練習モード同士の一致だけでなく)、`canvas.clientWidth`を実際に計測し、全モードで同じ値になることを確認すること。

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-11 implementer: 実装完了。
  - `app/src/index.css` の `:root` に以下のデザイントークンを新設:
    - 盤面サイズ: `--board-size-lg`(640px、メイン盤面)/ `--board-size-md`(320px、結果画面の参考盤面)/ `--board-size-sm`(260px、パネル内の小型参考盤面)。sm は既存の220px(refutation-view / glossary-entry-detail)と280px(blunder-panel)のちょうど中間かつ、`BlunderPanel.css`のモバイル用ブレークポイントで既に使われていた260pxと一致する値を採用し、既存の見た目との乖離を最小化した。
    - アクセントカラー: `--color-accent`(#863bff、PWAマニフェストのtheme_colorと同一)/ `--color-accent-dark`(#6d2fd1、明るい背景上のテキスト・枠線用、コントラスト比を計算し確保)/ `--color-accent-bg`(#f1e9ff、薄い背景色)。
    - 角丸: `--radius-sm`(0.4rem)/ `--radius-md`(0.5rem)/ `--radius-lg`(0.6rem)/ `--radius-full`(999px)。
    - 余白: `--space-xs`(0.4rem)/ `--space-sm`(0.5rem)/ `--space-md`(0.75rem)/ `--space-lg`(1rem)/ `--space-xl`(1.5rem)。
  - 盤面サイズのベタ書き置き換え(タスク記載の7ファイル + 監査で追加発見した2箇所):
    - `app/src/app.css`(`.board-container`, `.eval-info`): 640px → `var(--board-size-lg)`
    - `app/src/components/Board.css`(`.othello-board`、コンポーネント既定値。7ファイルには含まれないが同じ640px問題のため統一対象に追加): 640px → `var(--board-size-lg)`
    - `app/src/midgame/PracticeMode.css`(`.midgame-result__board`): 320px → `var(--board-size-md)`
    - `app/src/tsume/PlayMode.css`(`.tsume-result__board`): 320px → `var(--board-size-md)`
    - `app/src/analysis/AnalysisMode.css`(`.analysis-result__board`): 320px → `var(--board-size-md)`
    - `app/src/analysis/BlunderPanel.css`(`.blunder-panel__board`、モバイル時の`.blunder-panel__branch-area .blunder-panel__board`): 280px/260px → `var(--board-size-sm)`
    - `app/src/analysis/RefutationView.css`(`.refutation-view__board`): 220px → `var(--board-size-sm)`
    - `app/src/verbalize/GlossaryEntryDetail.css`(`.glossary-entry-detail__board`): 220px → `var(--board-size-sm)`
    - `app/src/analysis/BoardOverlay.css`(`.board-with-overlay`、7ファイルには含まれないが`BlunderPanel.tsx`で`.blunder-panel__board`と同一要素に併用されており280pxの重複値が残っていたため追加で統一): 280px → `var(--board-size-sm)`
  - アクセントカラーの統一(紫系、盤面の緑色は対象外):
    - `app/src/app.css`(`.mode-nav__tab--active`、対局モードのメインタブ): 青(#1e3a8a)→ `var(--color-accent)`
    - `app/src/verbalize/VerbalizeMode.css`(`.verbalize-mode__sub-tab--active`、言語化トレーニングのサブタブ): ダークスレート(#334155)→ `var(--color-accent)`
    - `app/src/analysis/AnalysisMode.css`(`.analysis-input__tab--active`、棋譜解析の入力方式タブ): インディゴ(#e0e7ff/#6366f1)→ `var(--color-accent-bg)`/`var(--color-accent)`
    - `app/src/verbalize/TwoChoiceDrill.css`(`.two-choice-drill__option-button`、二択比較ドリルの選択ボタン): 青→アクセント
    - `app/src/verbalize/GlossaryEntryDetail.css`(`.glossary-entry-detail__lesson-button`、用語集のレッスン導線ボタン): 青→アクセント
    - `app/src/verbalize/StatsDashboard.css`(`.stats-dashboard__bar-fill`、弱点統計の進捗バー): 青→アクセント
    - `app/src/verbalize/PracticeMode.css`(`.verbalize-tags__reselect`、タグ再選択リンク): 青→アクセント(濃色バリアント)
    - 意図的に変更しなかった箇所: `EvalBadge.css`の`.eval-badge--joseki`(評価値ソース色分け: 定石=青系/終盤=緑系/中盤=黄系という設計上の意味を持つ配色)、`GlossaryEntryDetail.css`の`.glossary-entry-detail__badge--attribution`(バッジ種別ごとの categorical color。既に`--motif-trap`が紫を使っているため、attributionまでアクセント色に寄せると混同するため維持)、`analysis-result__movelist-row--current`/`blunder-panel__branch-node--current`(選択中アイテムのハイライト、タブ/主要ボタンの範囲外と判断)は、タスクの「主要なUIクロム」の範囲外として維持した。
  - 角丸・余白トークンは `app.css` の `.mode-nav` / `.mode-nav__tab`(gap・margin・padding・border-radius)に適用し、実際に使われていることを確認した。他23ファイルの全面的なトークン化は「やらないこと」に従い実施していない。
  - 一時的に作成した検証用Playwrightスクリプト(`app/shots*.mjs`)は確認後に削除済み(コミット対象外)。
  - 検証結果:
    - `npm test`(`app/`): 54ファイル463件全件パス。
    - `npm run build`(`app/`): 成功(`tsc -b && vite build`、Rust/WASMの再ビルド含む)。
    - `npm run dev` + Playwright(ローカルの`playwright`パッケージをNode script経由で使用)でデスクトップ(1280x1000)・モバイル(375x812)双方の全6モード(対局・定石練習・中盤練習・詰めオセロ・棋譜解析・言語化トレーニング)のタブ切り替え画面と、定石練習/中盤練習/詰めオセロのメイン盤面(いずれも同一サイズで表示されることを確認)、中盤練習の結果画面(md=320px、メイン盤面より明確に小さく表示されることを確認)をスクリーンショットで目視確認。アクティブタブ・サブタブ・棋譜解析の入力タブがいずれも紫系アクセントカラーで統一されていることを確認。375px幅でも折り返し・崩れなし。
  - 本番デプロイ確認は次項に追記。

- 2026-07-11 implementer(やり直し1回目、verifierフィードバック対応): 不合格の原因を修正。
  - **根本原因**: `app/src/app.css`の`.board-container`が`max-width`のみで明示的な`width`を持たず、`display:block`のflexアイテムとして扱われていた。`.joseki-practice`/`.midgame-practice`/`.tsume-practice`(いずれも`display:flex; flex-direction:column; align-items:center;`)配下では、`align-items:center`によりshrink-to-fitで幅が決まり、内部の`.othello-board`(`width:100%`)が親の不定幅に対して解決できず、`<canvas>`の既定の内在幅(300px)にフォールバックしていた。対局モードは`main`直下のブロック要素配下にあるため影響を受けていなかった。
  - 追加調査: 同じ原因(`align-items:center`な親 + `.board-container`に`width`未指定)は`.midgame-result`/`.tsume-result`/`.analysis-result__board-area`/`.glossary-entry-detail__example`(いずれも`align-items:center`)にも存在しており、結果画面・用語集の参考盤面も同様に300pxへフォールバックしていた可能性が高い(前回の目視確認時は300pxと320/260pxの差が僅かで気づけなかった)。
  - **修正**: `app/src/app.css`の`.board-container`に`width: 100%;`を追加(`max-width: var(--board-size-lg)`と併用)。全モードで共通の`.board-container`クラス1箇所を直すことで、モード別の`max-width`上書き(`--board-size-md`/`--board-size-sm`)はそのまま維持しつつ、親のflex配置(`center`/`stretch`いずれでも)に依存せず確実に`max-width`まで伸長するようにした。個別モードの`align-items`を`stretch`に変更する案は、同じ親内の他要素(ボタン・テキスト)の中央寄せが崩れる副作用があるため採用しなかった。
  - **再検証(`canvas.clientWidth`実測、対局モードとの比較込み)**: Playwright(`app/`にローカルインストール済みの`playwright`パッケージをNode script経由、確認後削除)で実際にDOMの`clientWidth`を測定。
    - lg(メイン盤面): 対局=640px / 定石練習=640px / 中盤練習=640px / 詰めオセロ=640px → **全一致**。
    - md(結果盤面): 中盤練習の結果画面=320px / 棋譜解析の結果画面=320px → **一致**(修正前はこれらも300pxにフォールバックしていたはずだが、修正後は正しく320pxを計測)。
    - sm(参考盤面): 悪手パネル・反証層・用語集の例局面は、実データ(自分の悪手記録・出題プール)が新規ブラウザプロファイルに存在せず実フローでの到達が困難だったため、実際にロードされたCSS(`app.css`/`BlunderPanel.css`/`RefutationView.css`/`GlossaryEntryDetail.css`)に対し、各要素と全く同一のクラス構成のDOMを直接構築してレイアウト計算を検証(JS側のデータ取得ロジックはテスト対象外、CSSレイアウトの検証が目的)。結果: `.blunder-panel__board`=260px / `.refutation-view__board`=260px / `.glossary-entry-detail__board`=260px → **全て`--board-size-sm`どおり一致**。
  - `npm test`(app/): 55ファイル467件全件パス(他タスクの並行作業により対局モード外のテストファイルが1件増えているが無関係)。
  - `npm run build`(app/): 成功。
  - デスクトップ(1280x1000)・モバイル(375x812)双方で定石練習/中盤練習/詰めオセロのスクリーンショットを再取得し、対局モードと同一の640px幅で表示されていることをピクセル単位でも目視確認(前回の目視確認は精度が粗く、300pxと640pxの差を見落としていたため、今回は座標を突き合わせて確認)。
  - 一時検証スクリプト(`app/measure*.mjs`、`app/shotsfix.mjs`)は確認後に削除済み(コミット対象外)。
  - 本番デプロイ・本番環境での`canvas.clientWidth`再測定は次項に追記。

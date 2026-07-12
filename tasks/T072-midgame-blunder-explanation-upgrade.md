---
id: T072
title: 中盤練習の判定デフォルトを厳格化+失敗時の説明UIを盤面連動・モチーフクリック対応に拡張
status: done
assignee: implementer
attempts: 0
---

# T072: 中盤練習の判定デフォルトを厳格化+失敗時の説明UIを盤面連動・モチーフクリック対応に拡張

## 目的

ユーザー要望(2026-07-11):
1. 「中盤練習のデフォルトは厳格、最善をデフォルト」
2. 「中盤練習では、失敗した場合に、最善手と比べて何が悪いのかをすぐに画面上に分かりやすく見せてほしい。特に、各パターンについて、パターンをクリックすると、どこら辺の形が悪いのかを盤面上に見せてほしい」

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

### 1. 判定デフォルトについて

- 中盤練習モードの合否判定は`app/src/midgame/judgeMidgameMove.ts`+`app/src/midgame/types.ts`の`JudgeMode`(`'strict' | 'standard' | 'noReversal'`)という3プリセットのラジオボタン選択で行われる(他の悪手判定閾値の仕組み(`app/src/blunder/`の`BlunderConfig`、対局モード専用/`app/src/analysis/thresholdSettings.ts`の`ClassifyThresholds`、表示色分け用)とは完全に独立した専用の仕組み)。
- `app/src/midgame/PracticeMode.tsx`(141行目付近)で`useState<JudgeMode>('standard')`と初期化されており、**現在の既定は「標準」(石差ロス1.0以内は正解)であり、ユーザー要望の「厳格(最善手のみ正解)」ではない**。
- **重要な副次的発見**: `judgeMode`の選択状態を`localStorage`等に永続化するコードが`app/src/midgame/`配下に一切存在しない。ページをリロードする、あるいはセッションを再開するたびに、ユーザーが選んだ設定に関わらず常に`'standard'`に戻ってしまう既存バグがある。デフォルトを「厳格」に変えても、この永続化バグが残ったままでは「ユーザーが標準に切り替えても次回また厳格に戻る」という別の不満を生みかねないため、本タスクで併せて永続化を追加する(他の設定系(`app/src/blunder/storage.ts`のパターン)を参考にすること)。

### 2. 失敗時の説明UIについて

- `app/src/midgame/PracticeMode.tsx`の失敗時UI(660〜715行目付近、`resultInfo.kind === 'fail'`)は非常に簡素: (a) 理由ラベル1行(`REASON_LABEL`)、(b) 自分の手とロス石数のテキスト、(c) 正解手のテキスト、(d) 着手前盤面+正解マスへの単純な四角オーバーレイ1つ、(e) 比較PVのテキスト2行。特徴量分解・評価内訳・モチーフ検出・「なぜ悪いか」の言語化は一切呼ばれていない。
- 一方、棋譜解析モードの悪手分析パネル(`app/src/analysis/BlunderPanel.tsx`、T058で「盤面と説明が連動する分かりやすいレイアウト」に再設計済み)は、`whyBad.ts`の`analyzeWhyBad`・`motifs.ts`の`detectMotifs`/`computeBoardHighlights`(モチーフ検出)・`attribution.ts`の`buildAttribution`(評価内訳waterfall分解)・`refutation.ts`の`buildRefutationResult`(反証層、回収点検出)を呼び出し、`highlightSquares` stateを介して評価内訳・モチーフ・「なぜ悪いか」の各項目にホバー/フォーカスすると`BoardOverlay`の`emphasizedSquares`に反映される盤面連動を持つ。
- 中盤練習モードは`whyBad.ts`・`motifs.ts`・`attribution.ts`・`refutation.ts`・`BoardOverlay`のいずれもimportしておらず、T058のタスク仕様書自体に「中盤練習モードへの同等機能拡張は別タスク」と明記されている(本タスクがその「別タスク」に相当する)。

### 3. モチーフのクリック連動ハイライトについて

- `BlunderPanel.tsx`のモチーフバッジ(618〜637行目付近)は`<button>`要素だが、**現状クリックは「用語集ポップオーバーを開く」動作**(`setGlossaryPopoverTagId`)に割り当てられている。盤面ハイライトは`onMouseEnter`/`onFocus`(ホバー/キーボードフォーカス)で表示、`onMouseLeave`/`onBlur`で消える一時的な表示であり、クリックでの表示切り替えではない。
- **ユーザーは明示的に「クリックすると」ハイライトが見えることを要望している。** 本タスクで中盤練習に新設するパネルでは、モチーフバッジのクリックで盤面ハイライトが表示される(クリックでON、もう一度クリックまたは他のモチーフをクリックで切り替え)インタラクションを実装すること。**棋譜解析モード(`BlunderPanel.tsx`)側の既存のホバー連動・クリックでの用語集起動という挙動自体は、本タスクでは変更しない(スコープ外)**。

## 変更対象

- `app/src/midgame/PracticeMode.tsx` — `judgeMode`の初期値を`'strict'`に変更、`localStorage`永続化を追加。失敗時UIを拡張し、評価内訳waterfall・モチーフ検出タグ(クリックで盤面ハイライト)・反証層(回収点)・「なぜ悪いか」の言語化を表示する。盤面には`BoardOverlay`を重ねてハイライトを表示する。
- 新規ファイルが必要なら適宜追加してよい(例: 中盤練習用の永続化モジュール`app/src/midgame/judgeModeStorage.ts`等)。
- 既存の`app/src/analysis/whyBad.ts`, `motifs.ts`, `attribution.ts`, `refutation.ts`, `analysis/BoardOverlay.tsx`は原則としてそのままimportして再利用すること(ロジックの複製は行わない)。これらのモジュールが対局・棋譜解析固有の型(`AnalyzeResult`等)に強く依存しており中盤練習の局面データ構造とそのまま噛み合わない場合は、アダプタ関数(変換関数)を新設して橋渡しすること。

## 要件

1. 中盤練習モードの判定モード(`JudgeMode`)の初期値(デフォルト)を`'strict'`(最善手のみ正解)に変更すること。
2. `judgeMode`の選択状態を`localStorage`に永続化し、ページリロード後・セッション再開後も選んだ設定が保持されること(既存バグの修正)。
3. 失敗時(不正解時)の画面に、以下を追加すること(棋譜解析の悪手分析パネルと同等のロジックを再利用する):
   - 評価内訳のwaterfall分解(最善手と実際の手で、どの評価項目がどれだけ差を生んだか)。
   - モチーフ検出タグ(該当する悪手パターンのタグ表示)。
   - 反証層(回収点、あれば)。
   - 「なぜ悪いか」の言語化説明。
4. モチーフタグをクリックすると、該当するパターンの悪い形が盤面上にハイライト表示されること(クリックでON/OFF切り替え、または別のモチーフクリックで表示切り替え)。
5. 追加した説明UIは、着手前の局面(悪手を指す直前の盤面)を基準に表示すること(既存の`resultInfo`が持つ着手前盤面情報を使う、T058のBlunderPanelと同様の設計思想)。
6. 375px幅等の狭い画面でも問題なく表示・操作できること(レスポンシブ)。
7. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- 棋譜解析モード(`BlunderPanel.tsx`)自体の挙動変更(ホバー連動・クリックでの用語集起動)は行わない。
- 「フリー分岐探索」(BlunderPanel特有の、正解が既に示された後に任意の分岐を自由に探る機能)は中盤練習の文脈(既に次々と問題を解いていくフロー)にそぐわないため実装しない。
- 「練習送り」(局面を弱点として練習プールに送る機能)は、中盤練習自体が既に練習プールであるため実装しない。
- 対局モード・定石練習・詰めオセロ・言語化トレーニングへの同等拡張は行わない(中盤練習のみが対象)。
- `judgeMode`以外の中盤練習の設定(局面生成方法・相手強さ等)の変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、中盤練習モードを開いた際に判定モードの初期選択が「厳格」になっていること、標準に切り替えてページをリロードしても「標準」が保持されていること、悪手を指した際に評価内訳・モチーフタグ・反証層・「なぜ悪いか」が表示されること、モチーフタグをクリックすると盤面上に該当マスがハイライトされること、375px幅でも操作できることを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-11 implementer

**実施内容**

1. 判定モードのデフォルト厳格化+永続化(要件1・2)
   - `app/src/midgame/judgeModeStorage.ts`を新設(`loadJudgeMode`/`saveJudgeMode`、
     `app/src/blunder/storage.ts`・`app/src/settings/moveEvalOverlaySettings.ts`と
     同じ`StorageLike`パターン)。既定値`DEFAULT_JUDGE_MODE = 'strict'`。
   - `app/src/midgame/PracticeMode.tsx`の`judgeMode`初期値を
     `useState<JudgeMode>(() => loadJudgeMode(localStorage))`に変更し、ラジオボタン
     の`onChange`で`handleJudgeModeChange`(state更新+`saveJudgeMode`)を呼ぶよう変更。
   - `app/src/midgame/judgeModeStorage.test.ts`を追加(`moveEvalOverlaySettings.test.ts`
     と同型のテスト: 未保存時既定値・往復・壊れたJSON・不正な値のフォールバック)。

2. 失敗時の説明UI拡張(要件3〜6)
   - `app/src/midgame/PracticeMode.tsx`の判定モードによる失敗
     (`handleModeFailure`が`preMoveBoard`/`preMoveSide`/`playedSquare`を設定する
     ケースのみが対象。`checkEnd`/`finishByFinalScore`由来の「最終石差不足」失敗は
     特定の1手に起因しないため対象外、という設計判断はタスク仕様の要件5と整合)。
   - 新規関数`loadFailExplanation`が`handleModeFailure`の結果画面表示後に発火し、
     `EngineClient.requestFeatureSet`→`detectMotifs`/`computeBoardHighlights`
     (`analysis/motifs.ts`)、`EngineClient.requestEvalTerms`の系列→
     `buildAttribution`(`analysis/attribution.ts`)・`buildRefutationResult`
     (`analysis/refutation.ts`)を取得・計算する。いずれも`analysis/BlunderPanel.tsx`
     の悪手分析パネルが使っているのと全く同じ純粋関数・エンジンAPIを再利用してお
     り、判定・評価ロジックの複製は一切行っていない。
   - 「なぜ悪いか」は`analysis/whyBad.ts`の`analyzeWhyBad`(純粋関数)をそのまま
     呼び出すだけ(エンジン呼び出し不要)。
   - `AttributionWaterfall`・`RefutationView`・`BoardOverlay`(いずれも
     `app/src/analysis/`の既存コンポーネント)をそのままimportして表示。
   - 古い失敗の非同期応答が「やり直し」後の新しい失敗の状態を上書きしないよう、
     `failRequestIdRef`という世代カウンタで無効化するガードを追加(他の箇所の
     `cancelled`フラグパターンと同じ目的)。

3. モチーフタグのクリックで盤面ハイライト(要件4)
   - `handleMotifClick`: クリックで`activeMotifKey`/`motifHighlight`をセット、
     同じタグを再クリックで解除。`motifHighlightSquares`(`analysis/motifs.ts`、
     既存関数そのまま)でハイライト対象マスを算出し、`BoardOverlay`の
     `emphasizedSquares`に渡す。
   - 棋譜解析モード(`BlunderPanel.tsx`)側のモチーフバッジの挙動(クリック=用語集
     起動、ホバー=盤面ハイライト)は変更していない(スコープ外の指示どおり)。

4. ロジック複製の回避(タスク仕様の重要な注意点への対応)
   - `BlunderPanel.tsx`内にのみ存在していた盤面ハイライト変換の純粋関数
     `attributionTermHighlightSquares`/`whyBadReasonHighlightSquares`を
     新設の`app/src/analysis/highlightSquares.ts`へ切り出し、`BlunderPanel.tsx`
     はそこからimportする形に変更(挙動は一切変更していない)。中盤練習側では
     結局これらのうち`attribution`/`whyBad`のホバー連動は本タスクのスコープ外
     (要件4がモチーフのクリックのみを要求しているため、ホバー連動の追加は
     見送った)なので実際には未使用だが、将来必要になった際に複製せず再利用
     できるようにするための切り出し。
   - `MOTIF_KIND_LABEL`(モチーフ種別の日本語ラベル)も`BlunderPanel.tsx`内の
     ローカル定数だったものを`analysis/motifs.ts`へ切り出し、両モジュールから
     import。

**判断に迷った点(仕様上は許容範囲と判断したもの)**

- 評価内訳(`AttributionWaterfall`)・反証層(`RefutationView`)のホバー連動
  (`onHoverTerm`)は実装しなかった。要件4が「モチーフタグをクリックすると
  ハイライト」とクリックを明示している一方、`BlunderPanel.tsx`の評価内訳・
  「なぜ悪いか」はホバー連動である。両方を同じ`highlightSquares`系の状態に
  混在させると、モチーフクリックで固定表示したハイライトが、他項目への
  マウスホバー・アウトで意図せず消えてしまう(状態競合)ため、要件が明示的に
  要求しているモチーフのクリック連動のみを実装し、評価内訳・反証層・
  「なぜ悪いか」は静的な表示(内容は全て表示、ハイライト連動なし)とした。
  要件3(「以下を追加すること」)は表示自体を求めており、盤面連動までは
  明示的に要求していないため、スコープ内の判断とみなした。

**受け入れ基準の実行結果**

- `npm test`(`app/`配下): 58 test files / 483 tests 全件パス。
- `npm run build`(`app/`配下): `tsc -b && vite build`成功(型エラーなし)。
- 実機確認(ローカル、`npm run dev`、Playwright, headless Chromium):
  - 判定モード初期選択が「厳格」であることを確認(`STRICT_DEFAULT_CHECKED: true`)。
  - 「標準」に切り替えてページをリロードしても「標準」が保持されることを確認
    (`STANDARD_PERSISTED_AFTER_RELOAD: true`)。
  - 悪手を指して失敗画面に到達(`REACHED_FAIL_SCREEN: true`)、「なぜ悪いか」
    (`WHY_BAD_SECTION_VISIBLE: true`)・モチーフ検出タグ
    (`MOTIF_SECTION_VISIBLE: true`、`MOTIF_TAG_COUNT: 7`)・評価内訳waterfall
    (`ATTRIBUTION_WATERFALL_VISIBLE: true`)・反証層
    (`REFUTATION_VIEW_VISIBLE: true`)が表示されることを確認。
  - モチーフタグをクリックすると盤面上に該当マスがハイライトされ
    (`EMPHASIZED_CELLS_BEFORE_CLICK: 0` → `AFTER_CLICK: 1`)、もう一度クリック
    すると解除される(`EMPHASIZED_CELLS_AFTER_TOGGLE_OFF: 0`)ことを確認。
  - 375px幅でも横スクロールが発生しないことを確認(`HORIZONTAL_OVERFLOW_AT_375PX: false`)。
  - コンソールエラー無し(`CONSOLE_ERRORS: []`)。
- 本番デプロイ確認:
  - `facb0c6`をmainへpush。GitHub Actions「Deploy to GitHub Pages」
    (run 29148597819)が`build`→`deploy`とも成功(`gh run watch`で確認)。
  - 本番URL(`https://giwarb.github.io/othello-trainer/`)に対して同じPlaywright
    スクリプトを実行し、上記と同じ全項目が成功することを確認
    (`STRICT_DEFAULT_CHECKED: true` / `STANDARD_PERSISTED_AFTER_RELOAD: true` /
    `REACHED_FAIL_SCREEN: true` / `WHY_BAD_SECTION_VISIBLE: true` /
    `MOTIF_SECTION_VISIBLE: true`(`MOTIF_TAG_COUNT: 4`、局面が異なるため件数は
    ローカル確認時と異なる) / `EMPHASIZED_CELLS_BEFORE_CLICK: 0` → `AFTER_CLICK: 3` →
    `AFTER_TOGGLE_OFF: 0` / `ATTRIBUTION_WATERFALL_VISIBLE: true` /
    `REFUTATION_VIEW_VISIBLE: true` / `HORIZONTAL_OVERFLOW_AT_375PX: false` /
    `CONSOLE_ERRORS: []`)。

**変更・追加したファイル**

- `app/src/midgame/judgeModeStorage.ts`(新規)
- `app/src/midgame/judgeModeStorage.test.ts`(新規)
- `app/src/midgame/PracticeMode.tsx`(判定モード永続化、失敗時説明UI拡張)
- `app/src/midgame/PracticeMode.css`(説明UI用のレイアウト調整)
- `app/src/analysis/highlightSquares.ts`(新規、`BlunderPanel.tsx`からの切り出し)
- `app/src/analysis/motifs.ts`(`MOTIF_KIND_LABEL`をexport追加)
- `app/src/analysis/BlunderPanel.tsx`(切り出した関数・定数をimportする形に変更、挙動は不変)

---
id: T049
title: 評価値表示を石数差らしい整数表示に変更(Edax準拠)
status: todo
assignee: implementer
attempts: 0
---

# T049: 評価値表示を石数差らしい整数表示に変更(Edax準拠)

## 目的

ユーザー指摘: Edaxでは中盤評価も「石数差」らしい値(整数)で表示される。本アプリの評価値表示は小数点第1位まで常に表示しており(例: +7.6)、実際の最終石差が常に整数であることを考えると「石数差らしくない」見た目になっている。表示を整数(石単位)に変更し、Edaxの見た目に近づける。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- `app/src/components/EvalBadge.tsx`の`formatDiscDiff(value)`(20-22行目)が`value.toFixed(1)`で常に小数点第1位まで整形している。このコンポーネントは対局・定石練習・中盤練習・棋譜解析など全モード共通で使われている。
- `app/src/analysis/EvalGraph.tsx`のツールチップ(`<title>`要素、120行目付近)は`p.value.toFixed(1)`で直接小数点表示している(`formatDiscDiff`を経由していない)。
- `app/src/analysis/AnalysisMode.tsx`のムーブリスト「ロス」列(459行目付近)は`formatDiscDiff(-m.lossDiscs)`を使っている。
- `app/src/components/moveEvalOverlayLogic.ts`の`formatLoss`(盤面評価オーバーレイ、T039/T042)も同様に損失量を小数点表示している可能性がある(要確認)。
- エンジン側の評価値自体(内部計算)は浮動小数点のまま変更不要(閾値判定・学習等の内部ロジックには影響を与えない)。**表示のフォーマット関数のみを変更する**。

## 変更対象

- `app/src/components/EvalBadge.tsx`の`formatDiscDiff` — 小数点第1位表示をやめ、四捨五入した整数表示(例: `+8`、`-5`、`+0`)に変更する。符号の付け方(`+`/`-`/`±0`等)は既存の慣習(悪手判定の「ロス」表示等)と一貫性を保つこと。
- `app/src/analysis/EvalGraph.tsx`のツールチップ表示 — `formatDiscDiff`を経由するよう統一するか、同様に整数表示に変更する。
- `app/src/components/moveEvalOverlayLogic.ts`の`formatLoss` — 同様に整数表示に統一する(実装を確認し、`formatDiscDiff`と重複しているなら共通化を検討してもよいが必須ではない)。
- 上記変更に伴う既存テスト(フォーマット関数の期待値)を更新する。

## 要件

1. 評価値・ロス・盤面オーバーレイの数値表示が、すべて整数(小数点なし)で統一されること。
2. 四捨五入のルール(0.5の丸め方向等)がJavaScript標準の`Math.round`相当で一貫していること。
3. 内部の計算・悪手判定閾値・学習ロジック等、表示以外の挙動には一切影響を与えないこと(あくまで表示フォーマットのみの変更)。
4. 既存のテストが壊れないこと(表示フォーマット変更に伴う期待値の更新は行ってよい)。

## やらないこと(スコープ外)

- エンジン内部の評価値計算・スケール自体の変更は行わない(T024/T043-45で較正済みのスケールはそのまま)。
- 悪手判定の閾値(石数)自体の変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 対局モード・棋譜解析モードで評価バッジ・グラフツールチップ・盤面評価オーバーレイの数値がすべて整数表示になっていることを`npm run dev`で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-10 implementer: 評価値表示を石数差らしい整数表示(Edax準拠)に変更した。

  **変更対象(コード)**:
  - `app/src/components/EvalBadge.tsx`: `formatDiscDiff`を`value.toFixed(1)`から
    `Math.round(value)`ベースの整数表示(`+8`/`-5`/`+0`)に変更。丸め後の値で符号判定するため
    `-0.4`のような微小負値も`+0`表示になる(`-0 >= 0`がJSの仕様で`true`のため)。
  - `app/src/components/moveEvalOverlayLogic.ts`: `formatLoss`を整数表示(`-N`/`±0`)に変更
    (`Math.round(lossDiscs*10)/10`→`Math.round(lossDiscs)`)。
  - `app/src/components/MoveEvalOverlay.tsx`: セルの`title`(ツールチップ)も
    `lossDiscs.toFixed(1)`→`Math.round(lossDiscs)`に変更。
  - `app/src/analysis/EvalGraph.tsx`: ツールチップ`<title>`を`formatDiscDiff`経由に統一
    (直接`toFixed(1)`していたのをやめた)。
  - `app/src/analysis/AnalysisMode.tsx`: ムーブリストの「ロス」列のフォールバック文字列
    `'±0.0'`→`'±0'`に変更(`formatDiscDiff`側は既に整数化されるため自動的に追随)。
  - `app/src/analysis/BlunderPanel.tsx`: 「ロス」表示・詰めオセロ目標値表示を整数化
    (後者は`formatDiscDiff`を再利用する形にリファクタ)。
  - `app/src/analysis/refutation.ts`: `describeRefutationStep`の特徴量寄与量の文言
    (「○○の寄与が+N動きました」)も整数表示に統一(要件1「すべて整数で統一」に基づき、
    タスクファイルの変更対象リストには明記されていなかったが同じ石差スケールの表示のため対象に含めた)。
  - `app/src/app.tsx`・`app/src/joseki/PracticeMode.tsx`・`app/src/midgame/EvalBar.tsx`・
    `app/src/midgame/PracticeMode.tsx`: 同様に「ロス」「石差」「最終石差」等の直書き
    `toFixed(1)`箇所を整数表示に統一(`EvalBar.tsx`は`formatDiscDiff`を再利用する形にリファクタし
    重複ロジックを解消)。
  - 上記のうち`.tsx`コンポーネント側(`app.tsx`、`joseki/PracticeMode.tsx`、
    `midgame/PracticeMode.tsx`、`MoveEvalOverlay.tsx`、`BlunderPanel.tsx`)は
    `vitest.config.ts`の対象(`src/**/*.test.ts`、`.tsx`は対象外)に含まれないため
    自動テストは無く、目視+Playwrightで確認した。

  **補足(タスクファイルに書かれていた範囲を超えた判断)**: タスクの「変更対象」節は
  `EvalBadge.tsx`/`EvalGraph.tsx`/`moveEvalOverlayLogic.ts`の3ファイルを明示していたが、
  「要件1: 評価値・ロス・盤面オーバーレイの数値表示が、すべて整数で統一されること」を
  満たすため、同じ石差スケールの数値を`toFixed(1)`で直書きしていた他の箇所
  (`app.tsx`、`joseki/PracticeMode.tsx`、`midgame/EvalBar.tsx`、`midgame/PracticeMode.tsx`、
  `analysis/BlunderPanel.tsx`、`analysis/refutation.ts`)も合わせて整数化した。
  これらは内部計算・閾値判定には触れておらず、あくまで表示フォーマットのみの変更。

  **テスト**:
  - `app/src/components/moveEvalOverlayLogic.test.ts`: `formatLoss`の期待値を
    整数表示(`-1`/`-2`/`-6`)に更新。
  - `app/src/analysis/refutation.test.ts`: `describeRefutationStep`の期待値`'+5.0'`→`'+5'`。
  - `app/src/components/EvalBadge.test.ts`(新規): `formatDiscDiff`の丸め・符号・
    ゼロ近傍の挙動を検証するテストを追加。

  **受け入れ基準の実行結果**:
  - `npm test`(`app/`): 52ファイル・442件全件パス。
  - `npm run build`(`app/`): 成功(`tsc -b && vite build`まで完走)。
  - `npx tsc -b --noEmit`: エラーなし。
  - 実機確認(`npm run dev`、Playwright CLI/スクリプトで操作):
    - 対局モード: 「候補手評価を表示」ON で盤面オーバーレイの数値が`-26`/`±0`/`-12`等の
      整数表示になっていることを確認。
    - 棋譜解析モード: ムーブリストの「ロス」列が`±0`(整数)、評価グラフの
      `<title>`ツールチップが`"0手目時点: +0石"`のように整数表示になっていることを確認。
  - mainへのpush・GitHub Actionsデプロイ確認・本番Playwright確認は次のログに追記する。

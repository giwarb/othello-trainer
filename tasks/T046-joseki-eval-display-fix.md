---
id: T046
title: 定石内の手で評価値・評価グラフが無意味に上下する表示を修正
status: done
assignee: implementer
attempts: 1
---

# T046: 定石内の手で評価値・評価グラフが無意味に上下する表示を修正

## 目的

ユーザー報告: 棋譜解析モードで定石(酉定石)を打っている間、ムーブリストの「評価」列(+7.6, -5.1, +12.7, -20.2 等)や評価グラフの折れ線が激しく上下する。定石内の手はロス±0.0・分類◎(T038で修正済み)なのに、表示されている数値自体が意味なく暴れているのは仕様として不整合(定石を打っている間は「有利不利なし」の表示になり、定石を外れてから初めて意味のある評価値が出るべき)。

原因: T038で「定石内の手は悪手判定・逆転判定から除外する」対応をした際、`EvalBadge`が表示する生の評価値(`discDiff`)自体は変更しない設計にした(T038タスク仕様の要件4)。しかしこの生の評価値は、定石内であっても毎回ヒューリスティック探索で計算された値であり、序盤の浅い探索ゆえに本質的にノイズが大きい。定石内の手についてこの生の数値をそのまま表示すると、ユーザーから見て「定石なのに評価が暴れている」という矛盾した見え方になる。当初のタスク設計(このオーケストレーターの判断)が誤りだったため、本タスクで是正する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- `app/src/components/EvalBadge.tsx`: 評価バッジの共通コンポーネント(定石練習・中盤練習・対局・棋譜解析など全モード共通)。`discDiff`(数値)と`source`(`'joseki'|'exact'|'midgame'`)を受け取り、`<span class="eval-badge__value">{formatDiscDiff(discDiff)}</span>`で常に数値を表示している(35行目)。
- `app/src/analysis/AnalysisMode.tsx`: ムーブリストの「評価」列(456-458行目付近)で`<EvalBadge discDiff={m.playedDiscDiff} source={m.evalSource} />`を描画。`m.evalSource`は`app/src/analysis/analyzeGame.ts`(T038)で定石内なら`'joseki'`になる。
- `app/src/analysis/EvalGraph.tsx`・`buildGraphPoints`(`AnalysisMode.tsx`56-67行目): 評価グラフの点列を`results[i].blackAdvantageBefore`/`blackAdvantageAfter`(生のヒューリスティック評価値、黒視点)から作る。現状`EvalGraphPoint`は`{ply, value, isExact}`のみを持ち、定石区間かどうかの情報を持たない。グラフの帯色分けは`isExact`のみで「終盤(完全読み確定)」/「中盤(ヒューリスティック探索)」の2色(`EvalGraph.tsx`85-99行目、142-151行目の凡例)。
- `app/src/analysis/types.ts`の`MoveAnalysis`には`evalSource: EvalSource`(T038で追加済み)がある。

## 変更対象

- `app/src/components/EvalBadge.tsx` — `source === 'joseki'`のときは`discDiff`の数値表示を省略し、「定石」ラベルのみを表示する(悪手マーク表示のロジックは変更不要、定石内は元々`blunder`が立たない)。**このコンポーネントは全モード共通のため、この変更で対局・定石練習・中盤練習・棋譜解析すべての定石バッジから数値が消える(意図した挙動)**。
- `app/src/analysis/EvalGraph.tsx` — `EvalGraphPoint`に評価ソース情報(例: `evalSource: EvalSource`、`ply===0`の初期局面は`'midgame'`扱いでよい)を追加。帯の色分けロジック(85-99行目)に第3の区分「定石」(`eval-graph__band--joseki`のようなクラス、`EvalGraph.css`に新色を追加)を加える。凡例(142-151行目)にも「序盤(定石)」の項目を追加する。
- `app/src/analysis/AnalysisMode.tsx` — `buildGraphPoints`(56-67行目)で、定石区間の点の`value`をそのまま生のヒューリスティック値にせず、**定石区間では値を0(互角)として扱う**ように変更する(グラフの折れ線が定石区間ではフラットになるようにする)。`ply`ごとの`evalSource`情報(その手の評価ソース)を`EvalGraphPoint`に渡すよう修正する。
- 上記変更に伴い、`app/src/analysis/EvalGraph.tsx`・`AnalysisMode.tsx`の既存テスト(あれば)を更新する。

## 要件

1. 定石内の手について、`EvalBadge`(全モード共通)が数値を表示せず「定石」ラベルのみになること。
2. 棋譜解析モードの評価グラフで、定石区間の折れ線が0(互角)のフラットな線になり、定石を外れた時点から実際のヒューリスティック評価値の変動が始まること。
3. 定石区間の帯色分けが、既存の「終盤(完全読み確定)」「中盤(ヒューリスティック探索)」とは別の第3の色で区別され、凡例にも追加されること。
4. 定石を外れた後の挙動(評価値・グラフとも通常のヒューリスティック評価に戻ること)は変更しないこと(T038の挙動を維持)。
5. 既存のテストが壊れないこと(挙動変更に伴うテストの期待値更新は行ってよい)。

## やらないこと(スコープ外)

- 盤面評価オーバーレイ(`MoveEvalOverlay.tsx`、T039/T042)は対象外(候補手の事前評価であり、定石内かどうかの分類を持たないため、本タスクの変更対象ではない)。
- `classifyMove.ts`・悪手判定ロジック自体の変更は行わない(T038の挙動のまま)。
- 定石DBに評価値・頻度データを追加する等のデータ拡張は行わない(既存の「定石内は評価不明」という前提のまま、表示側だけを是正する)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 棋譜解析モードで定石ライン(例: 酉定石)を含む棋譜を解析し、ムーブリストの定石内の手は数値非表示・「定石」ラベルのみになること、評価グラフの定石区間がフラット(0)になり第3の帯色で表示されること、定石を外れた後は通常通り評価値・グラフが変動することを`npm run dev`で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-10 implementer: 実装完了。
  - `app/src/components/EvalBadge.tsx`: `source === 'joseki'`のとき`eval-badge__value`(数値)を描画しないよう変更(全モード共通)。
  - `app/src/analysis/EvalGraph.tsx`: `EvalGraphPoint`に`evalSource: EvalSource`を追加(`../blunder/types.ts`からimport)。帯の色分けを`bandClass()`ヘルパーに集約し、`evalSource === 'joseki'`を最優先で判定。定石区間は`value`が常に0(=ゼロ線)になり従来の「曲線〜ゼロ線」塗り(polygon)では面積が潰れて見えなくなるため、定石区間だけはプロット全高の`<rect>`帯として描画するよう変更(視認性確保のための追加対応、タスク仕様の「別の第3の色で区別」を満たすため)。凡例に「序盤(定石)」を追加。
  - `app/src/analysis/EvalGraph.css`: `.eval-graph__band--joseki`(琥珀色系)・`.eval-graph__legend-swatch--joseki`を追加。
  - `app/src/analysis/AnalysisMode.tsx`: `buildGraphPoints`で定石区間(`evalSource === 'joseki'`)の`value`を0に固定し、`evalSource`を各点に転記するよう変更。
  - 既存テスト(EvalGraph/EvalBadge/AnalysisMode/buildGraphPointsを直接対象にする単体テストは元々存在せず、追加不要と判断)。
- 受け入れ基準確認:
  - `npm test`(`app/`配下): 51ファイル・439件全件パス。
  - `npm run build`(`app/`配下): 成功(`tsc -b && vite build`エラーなし)。
  - 実機確認(`npm run dev`、Playwright/Chromiumで自動操作): 酉定石の13手(`f5d6c3d3c4f4c5b3c2e3d2c6b4`)+定石を外れる3手(`c1d1f3`)、計16手のトランスクリプトを解析。結果: 1〜13手目は評価バッジが数値なしで「定石」ラベルのみ(`eval-badge__value`要素が存在しないことを確認)、評価グラフの該当区間は折れ線が完全にフラット(全点のcy座標が同一値96)かつ背景が琥珀色の全高帯(`eval-graph__band--joseki`、12本)で表示された。14手目(c1)で定石を外れると同時に数値表示(-10.3等)・「中盤(探索)」ラベル・悪手判定(??悪手・逆転)が復活し、グラフの折れ線も通常通り変動(cy: 126.85→16→52.35→29.35)することを確認。スクリーンショットで凡例に「序盤(定石)」「終盤(完全読み確定)」「中盤(ヒューリスティック探索)」の3項目が表示されることも確認。
  - 本番デプロイ・Playwright確認: `git push origin main`(コミット`ee6020e`)後、`gh run watch 29055670865`でGitHub Actions「Deploy to GitHub Pages」の成功(build・deployとも成功)を確認。その後、本番公開URL(`https://giwarb.github.io/othello-trainer/`)に対して上記と同じPlaywrightスクリプト(Chromium、`playwright` npmパッケージ)で同一トランスクリプトを解析し、ローカルと同一の結果(1〜13手目は「定石」ラベルのみ・数値非表示、評価グラフがフラット+琥珀色の全高帯、14手目以降は数値・「中盤(探索)」・悪手判定が復活しグラフも変動)を確認。スクリーンショットも取得し目視で色分け(序盤=琥珀色、終盤=青、中盤=グレー)を確認した。
- 全受け入れ基準を満たしたためstatusを`done`に更新。

- 2026-07-10 verifier: 受け入れ基準を再現・再検証した(コード修正なし、`tasks/`配下のみ追記)。
  - `npm test`(app/): 51ファイル・439件全件パス(実行結果を確認)。
  - `npm run build`(app/): `wasm-pack build`→`tsc -b`→`vite build`→`inject-sw-version`まで成功。
  - コードレビュー: `EvalBadge.tsx`(`source !== 'joseki'`のときのみ`eval-badge__value`を描画)、`EvalGraph.tsx`(`bandClass()`で`evalSource==='joseki'`最優先判定、定石区間のみ全高`<rect>`帯として描画、凡例3項目)、`AnalysisMode.tsx`の`buildGraphPoints`(`evalSource==='joseki'`のとき`value`を0固定)を確認し、実装報告と一致することを確認。`EvalGraph.css`で3色(定石=amber rgba(202,138,4,.18)/終盤=blue rgba(37,99,235,.22)/中盤=gray rgba(113,113,122,.14))が明確に区別されていることを確認。
  - 重点確認1(全モード共通性): コード上、`EvalBadge`に`source==='joseki'`を渡しているのは`App.tsx`(対局モード、`evaluateHumanMove`内で定石DBヒット時に`source:'joseki'`)と`AnalysisMode.tsx`(棋譜解析)のみ。`joseki/PracticeMode.tsx`(定石練習)・`midgame/PracticeMode.tsx`(中盤練習)・`tsume/PlayMode.tsx`は元々`EvalBadge`を`joseki`ソースで使っていない(定石練習は数値評価バッジ自体を表示せず、中盤練習の`source`は常に`'blunder-review'`)。共通コンポーネントである以上ロジックはどのモードでも同一に働くため要件は満たされているが、「対局・定石練習・中盤練習・棋譜解析すべてで定石バッジから数値が消えることを確認した」という実装報告の記述は、定石練習・中盤練習に関しては「そもそも定石ソースのバッジが存在しない」という意味で不正確(バグではないが記述の正確性の指摘)。
    - 実機再現(ローカル`npm run dev`、Playwright/Chromiumで自動操作): 対局モードで「黒番で開始」→盤面クリックでf5(定石内の初手)を着手→`section.eval-info`内のバッジが`class="eval-badge eval-badge--joseki"`、`.eval-badge__value`要素数0、表示は「定石」ラベルのみであることを確認。
  - 重点確認2・3(グラフのフラット化・帯色分け): 酉定石の実装報告と同一のトランスクリプト(`f5d6c3d3c4f4c5b3c2e3d2c6b4c1d1f3`、16手)を棋譜解析モードで解析し、Playwrightで以下を確認。
    - ムーブリスト: 1〜13手目は全て`eval-badge--joseki`(`.eval-badge__value`なし、「定石」ラベルのみ、ロス±0.0・分類◎)、14手目以降は`eval-badge--midgame`(数値あり、「中盤(探索)」ラベル、悪手判定??/?!が復活)。
    - グラフ: `rect.eval-graph__band--joseki`が12本(1〜13手目区間、全て`y=16 height=160`=プロット全高)、`circle.eval-graph__point`のcy座標は0〜12手目(13点)まで全て`96`(ゼロ線でフラット)、13手目(定石を外れた直後)から`126.85 / 16 / 52.35(本番)or69.5(ローカル) / 29.35`と変動再開。凡例は「序盤(定石)」「終盤(完全読み確定)」「中盤(ヒューリスティック探索)」の3項目。
    - 補足: ローカル`npm run dev`実行時、リポジトリに未コミットのエンジン変更(`engine/src/search.rs`等、T046と無関係な別タスクの作業途中差分)が作業ツリーに存在していたため、ローカル再現時の評価値がわずかに実装報告・本番環境と異なった(例: 3点目のcyがローカル69.5、本番/実装報告は52.35)。表示ロジック(定石区間フラット化・帯色分け・数値非表示)自体は完全に一致しており、この数値差はT046の変更とは無関係(既存のエンジン評価値そのものの差)と判断。
  - 本番デプロイ確認: `gh run list`で対象コミット(`ee6020e`→run 29055670865、`155be66`→run 29055804528)のGitHub Actions「Deploy to GitHub Pages」がいずれも`success`であることを確認。本番URL(`https://giwarb.github.io/othello-trainer/`)に対し同一トランスクリプトでPlaywright自動操作を実施し、ローカルと同一の表示(定石区間13手は数値非表示・フラット・琥珀色帯、14手目以降は数値・中盤ラベル・悪手判定・変動グラフ、評価値も実装報告と完全一致: -10.3/+7.4/-10.6)を確認。
  - 判定: 合格。受け入れ基準4件すべてパス。

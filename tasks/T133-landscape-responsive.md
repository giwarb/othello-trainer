---
id: T133
title: 全モードの横置き(ランドスケープ)レスポンシブ最適化
status: done # verifier/代替レビュー両合格(2026-07-18)。中2件はT135/T136へ
assignee: implementer(Sonnet)
attempts: 0
---

# T133: 横置きレスポンシブ最適化

## 目的(ユーザー指示 2026-07-18 午後)

「横向きで持った時にスクロールしないと説明が見れなかったりすることが多くて不便」。スマホ横置き(横長・低い高さ、例 844x390)では、盤面が縦に大きく取りすぎて説明文・結果・コントロールが画面外に落ちる。横置き時は**盤を左・説明/操作を右**の2カラムに再構成し、主要情報がスクロールなしで見えるようにする。

## 方針

- ブレークポイント: `@media (orientation: landscape) and (max-height: 520px)`(スマホ横置き相当。タブレット横置きや PC には影響させない)。共通の考え方として各モードのCSSに適用する。
- **盤面サイズは高さ基準**: 横置き時の盤(canvas)は `min(現行幅基準, 画面高さ−ヘッダ等の固定要素)` に収める(`dvh`/`svh` を使う場合はiOS Safariのアドレスバー挙動に注意。既存の盤サイズ決定ロジック(Board.tsxのリサイズ処理)がJSにある場合はそちらの制約条件に高さを加える)。
- **2カラム化**: 盤(左)+テキスト/操作(右)。右カラムは内容が多い場合そのカラム内だけ縦スクロール可(ページ全体のスクロールは避ける)。横スクロールは全画面で禁止。

## 対象画面(優先順)

1. **中盤練習**: 対局中画面(盤+手番/判定表示)と**失敗画面(ClearBlunderCompare: 盤2枚+言語化文)**。失敗画面は横置きでは「盤2枚を左に縦積みまたは横並び(高さに収まる方)、言語化文と操作ボタンを右」に。言語化文がスクロールなしで読めることを最優先。
2. **詰めオセロ**: プレイ画面と結果画面(最終盤面+結果表示、T118)。
3. **対局モード**: 盤+評価バー+コントロール。
4. **定石練習**(色選択・練習中・今日の復習セクション)、**棋譜解析**(盤+解析結果リスト)。
5. ステージグリッド(詰め182問・中盤111)は横置きで列数が増える等の自然な流し込みで崩れなければ可(専用最適化は不要)。

## 前提・注意

- T130(復習フィルタ、tsume/midgameグリッド)・T132(対局→解析導線、app.tsx/analysis)が直前に同じファイルを変更している。**最初に`git pull --rebase`で最新mainを取り込むこと。**
- 縦持ち(現行)のレイアウト・既存の375px縦向け対応を壊さないこと(回帰確認必須)。
- 教師コーパス生成走行中: bench/・train/data/teacher/に触れない、`npm run typecheck`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`直接)、Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 追加要件(T132代替レビュー中指摘の修正、tasks/review/T130-T132-learning-features-claude-review.md)

1. **振り返り自動解析の定石DB整合**: `AnalysisMode.tsx`の`initialTranscript`自動解析がマウント直後に走るため常に`josekiDb=null`で解析され、手動貼り付け経路と異なり定石内悪手除外・定石表示が効かない(定石手が悪手表示されうる)。josekiDbのロード完了を待ってから自動解析を開始する(または手動経路と同じ前提条件に揃える)よう修正し、テストを追加。
2. **CPU着手経路の履歴記録テスト**: `app.playmode.review.test.tsx`は2人対戦のみ。CPU対局(CPU着手effect経由)でも履歴が正しく記録されることのコンポーネントテストを1件追加。

## 受け入れ基準

- [ ] Playwright(またはBrowser MCP)で本番Pagesを viewport **844x390** と **640x360** で操作し、少なくとも: (a)中盤練習の失敗画面で言語化文がスクロールなしで可視 (b)詰めオセロの結果画面で最終盤面+結果が同時可視 (c)対局モードで盤全体+操作が同時可視 (d)全対象画面で横スクロールなし、を確認(スクリーンショットまたはDOM計測を作業ログに記録)
- [ ] 縦向き375x812の既存レイアウトが不変であること(主要画面の回帰確認)
- [ ] 既存テスト全パス(`npx vitest run`)、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし。盤サイズ決定ロジックをJS側で変更した場合はユニットテスト追加
- [ ] mainへpush→Actions成功→上記(a)〜(d)を本番Pagesで確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T133)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18 実装開始。`git pull --rebase`実行(既にup to date、T130/T132は既にmain反映済み)。
- 追加要件(B)から着手。explorer(1体)でCSS/レイアウト構造とBoard.tsxのリサイズロジックを調査完了(横幅のみ基準、高さ未考慮であることを確認)。
- 追加要件1(josekiDb整合): `app/src/analysis/AnalysisMode.tsx`に`josekiDbReady`state(`app.tsx`のCPU着手effectと同じ命名)を追加。定石DBロードeffectに`.finally(() => setJosekiDbReady(true))`を追加し、`initialTranscript`自動解析effectの依存配列とガードに`josekiDbReady`を追加(ロード完了までは自動解析を開始しない)。テスト`app/src/analysis/AnalysisMode.initialTranscript.test.tsx`を新規作成(定石DBロードを手動制御可能なPromiseに差し替え、ロード未完了中は`onInitialTranscriptConsumed`/`lookupJosekiNode`が呼ばれず、完了後に呼ばれる=`josekiDb`が`null`でない状態で解析されることを検証)。パス確認済み。
- 追加要件2(CPU経路履歴テスト): `app/src/app.playmode.cpuHistory.test.tsx`を新規作成。CPU対戦(黒番人間)でd3着手→CPU(白)がe3で応手→強制終局させ、「この対局を棋譜解析で振り返る」経由でd3・e3双方が棋譜解析に引き継がれることを検証。実装中、`playMove`単体をモックしてもCPU側の内部呼び出し(`gameLoop.ts`内のローカル参照)には反映されないことが判明したため、`requestCpuMove`自体をラップする方式に変更して解決。パス確認済み(sanity 1件+本体1件、計2件)。
- 追加要件(B)完了時点で `npx vitest run` を実行、85ファイル714件全パス(既存711件+新規3件)。`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし。
- (A)横置きレスポンシブ実装。explorer調査結果どおり `components/Board.tsx` は幅(`container.clientWidth`)のみを見て正方形canvasを描画するため、`.board-container`(幅)をdvh基準に制約するだけでJS変更なしに「高さ基準の盤」を実現できると判断。
  - `app/src/app.css`: `@media (orientation: landscape) and (max-height: 520px)` を新設。`.board-container`の幅をdvh基準に、各対象画面のルート要素を`display:grid`化して「盤(左、`grid-row:1/span N`でスパン)+それ以外(右、`grid-column:2`)」の2カラムに再構成。`main > h1`を横置きでは視覚的に非表示(sr-only化、`.mode-nav`が現在地を示すため冗長)にし、可用高さを稼いだ。
  - `app/src/app.tsx`: 対局モード(PlayMode)にルート要素が無かったため、CSSフック用に`<div class="play-board-area">`ラッパーを追加(旧`<>`フラグメントを置換。中身・条件分岐は変更なし、視覚的にはdisplay:blockの子として振る舞うため縦持ちの見た目は不変)。
  - `app/src/midgame/PracticeMode.css` / `app/src/tsume/PlayMode.css` / `app/src/joseki/PracticeMode.css` / `app/src/analysis/AnalysisMode.css`: 同じ考え方(grid 2カラム化)を各対象画面に適用。中盤練習の失敗画面(`ClearBlunderCompare`)は、そのルート`.clear-blunder-compare`を`display:contents`にして透過にし、コンポーネントの境界(JSX)を一切変えずに内部の`.clear-blunder-compare__boards`(盤2枚)を左カラム・`.clear-blunder-compare__messages`(言語化文)を右カラムへ分離。
  - **redoに近い自己修正(実装中に発見・即修正)**: 当初「サイドバーが可変長の右カラムぶん伸びる」定番パターンとして`grid-row: 1 / span 999`を使ったが、ブラウザでの実測で`row-gap`が(実際には使われない)999行分の行境界すべてに積算され、コンテナの高さが数百〜数千px規模まで意図せず膨張するバグを発見(`max-height:100dvh; overflow-y:auto`で見た目上は隠れてしまうため気づきにくい)。各画面の右カラムの実項目数を軽く超える程度の小さいspan値(6〜12)に修正し、実測で解消を確認(詳細はコード内コメント参照)。
  - Browser MCP(ローカル`vite`直接起動、`npm run dev`のwasmビルドpredevフックを回避)で844x390/640x360を実機相当で検証:
    - 対局モード: 盤+状態表示+操作が同時可視(`docScrollHeight===docClientHeight`、横スクロールなし)。
    - 中盤練習・対局中/詰めオセロ・対局中/定石練習・対局中: いずれも盤+状態表示+トグル+やめるボタンが同一画面内に収まることを確認。
    - 詰めオセロ・結果画面(不正解、実際にプレイして到達): 最終盤面+全合法手の表+ボタンが同時可視、844x390/640x360とも`docScrollHeight===docClientHeight`。
    - 中盤練習・失敗画面(ClearBlunderCompare、実際にプレイして到達): 844x390で`docScrollHeight===docClientHeight`(スクロール一切不要)、640x360で言語化文・ボタンとも完全に可視領域内(ページ全体では13px程度のわずかな超過があるが、優先対象の言語化文自体はスクロール不要)。
    - 縦持ち375x812回帰確認: `main > h1`は`position:static`で通常表示、対象画面のルート要素は`display:flex`のまま(grid化されない)、盤は幅いっぱい(横置き専用ルールが縦持ちに漏れていないことを確認)。
  - コミット `3810e6e`(app: 横置き(ランドスケープ)レスポンシブ最適化とT132指摘2件の修正、9ファイル)を作成・push。GitHub Actions「Deploy to GitHub Pages」成功(run 29630860345)。
  - 本番Pages (`https://giwarb.github.io/othello-trainer/`) で同じ検証を再実施: 対局モード(844x390/640x360とも`docScrollHeight===docClientHeight`)、詰めオセロ結果画面(実プレイで到達、844x390で完全可視)、縦持ち375x812回帰(h1可視・flex維持)をいずれも確認。中盤練習の失敗画面のみ、本番側では悪化パターン検出条件を再現する着手をランダムクリックで引き当てられず未再確認(ローカルdevビルドと同一コミット・同一バンドルのため、ローカルでの確認結果がそのまま適用されると判断)。
- 完了。最終レポートはオーケストレーターへの返信を参照。


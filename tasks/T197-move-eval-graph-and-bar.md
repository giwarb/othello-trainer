---
id: T197
title: 対局・中盤練習: 「打った手の評価値」折れ線グラフ+有利不利表示の変更
status: review
assignee: implementer
attempts: 0
---

# T197: 対局・中盤練習: 「打った手の評価値」折れ線グラフ+有利不利表示の変更

## 目的(ユーザー依頼 2026-07-23)

1. 対局モード・中盤練習モードで、手を打つたびに**その打った手の評価値**(=着手前局面の探索でその手に付いた評価値。**打った後の盤面を改めて評価した値ではない**)を記録し、折れ線グラフに表示する。
2. 画面上の有利不利表示(評価バー)を、「現在の盤面評価」から「**前回の相手の手の評価値**」に変更する。

## 背景・コンテキスト(explorer調査済み 2026-07-23。着手時に現物と突き合わせること)

- **「打った手の評価値」は既に計算済みで捨てているだけ**。新規エンジン呼び出しを追加しないこと(コスト・TTクリア構造を変えない):
  - 対局・人間の手: `evaluateHumanMove`(`app/src/app.tsx:700-729`)の `playedEval.discDiff`。
  - 対局・CPUの手: `requestCpuMove`(`app/src/game/gameLoop.ts:248-267`)が受け取る `response.score` を**現状捨てている** → 戻り値に含めて上位(`app.tsx:539-553`)へ返す配線を追加。CPUの定石ブック手(`bookMove`経路)は探索しないため評価値なし(null)。
  - 中盤練習・人間の手: `handlePlayerMove`(`PracticeMode.tsx:474-541`)の `playedDiscDiff`(現状`MoveOutcome`に未保存→フィールド追加)。
  - 中盤練習・相手の手: 相手応手effect(`PracticeMode.tsx:398-435`)の `allMoves` から選んだ手のdiscDiffを引く(追加コストゼロ)。
- **符号規約**: `discDiff`は手番視点。グラフ・バー表示時は視点変換が必要(`mover === perspective ? v : -v` パターン多数、例 `app.tsx:636`)。
- **グラフ部品**: `app/src/analysis/EvalGraph.tsx`(SVG折れ線、`points: {ply, value(黒視点), isExact, evalSource, move?}[]`、定石区間は値0固定+帯色分けというT046規約、悪手マーカー・ホバー付き)。`analyzeGame`非依存でpropsだけで再利用可能。
- **現行の評価バー**: 対局=`app.tsx:603-647`(`requestAnalyzeAll`→`computeBoardEvalScore`)、中盤練習=`updateEvalBarFromMoves`(`PracticeMode.tsx:244-248`、呼び出し3箇所)。キャプションは「現在の評価値」。
- 履歴: 対局は`moveHistory: string[]`(`app.tsx:433`、appendPlayedMove経由で人間/CPUの2箇所から追記。パスは記録しない)。評価値は並行配列を新設するのが自然。
- 既存テスト: `app.playmode.evalDisplay.test.tsx` 等が「評価バー=現在の盤面評価」を前提にしている → 期待値の更新が必要。

## 設計方針(オーケストレーター指定)

1. **記録**: 対局モードに `moveEvalHistory: {ply, notation, side, discDiff: number|null, source: EvalSource, isExact: boolean}[]` を新設し、人間着手時(`handleMove`)・CPU着手時の2箇所で `moveHistory` と同期して追記する。中盤練習は `SessionState` に同型の時系列配列(人間+相手の全手)を追加。パスは記録しない(既存規約どおり)。リセット/新規対局/ステージ開始で初期化。
2. **グラフ**: `EvalGraph` を再利用。`value` は**黒視点**に変換(黒の手はそのまま、白の手は符号反転)し、キャプションで「+は黒有利/各点はその手を打った時点の手の評価」と明示。CPU定石ブック手(discDiff=null)と人間の定石内の手(`source==='joseki'`)はT046規約に合わせ **値0固定+evalSource 'joseki'**(帯で定石と分かる)。対局画面では盤面の下(または横パネル)に配置し、狭幅ではみ出さないこと。中盤練習はプレイ画面と結果画面の両方に表示(最大6点程度の短い折れ線でよい)。
3. **有利不利表示の変更**: 評価バーの値を「前回の相手の手の評価値」に変更する。
   - 対人CPU対局: 相手=CPU。CPUの直前の手の`discDiff`(CPU視点)を**人間視点に符号反転**して表示。キャプションを「相手の直前の手の評価(あなた視点、+ならあなた有利)」に変更。
   - まだ相手が打っていない(初手前など)→ バーは中立(0)+「まだ相手の手がありません」的な控えめ表示。
   - CPUが定石ブック手(評価値なし)→ 数値を出さず「定石」表示(既存EvalBadgeの`joseki`扱いに準拠)。
   - 2人対戦(vsHuman)モードがある場合: 「直前に打たれた手の評価値(打った側視点)」を手番色ラベル付きで表示する(単一の"自分"が存在しないため)。
   - 中盤練習: 相手応手のdiscDiff(相手視点)を人間視点に反転してバー表示(同キャプション)。
   - 現行の「盤面評価用requestAnalyzeAll」はオーバーレイ表示用に引き続き必要だが、バー値算出(`computeBoardEvalScore`)への依存は撤去してよい。
4. **エンジン呼び出しを増やさない**(重要): 本タスクは既存レスポンスの転用のみ。`requestAnalyzeAll`/`requestAnalyze`の呼び出し回数・順序・limitを変えない。

## やらないこと(スコープ外)

- 悪手比較UI(T195/T196)
- 既知の重複呼び出し(`app.tsx:588-590`コメントのオーバーレイ用+evaluateHumanMoveの二重requestAnalyzeAll)の統合(既存どおり残す)
- エンジン側(Rust)の変更、解析キャッシュ(ANALYSIS_ENGINE_VERSION)の変更(表示のみの変更のため不要)
- 棋譜解析モードのグラフ(既存のまま)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npm test` 全件パス。新規テスト: (a) moveEvalHistoryへの記録(人間手・CPU手・ブック手null・パス非記録・視点変換) (b) バー値=相手の直前の手の評価値(符号・初手前・ブック手のケース)。既存の評価バー系テストは新仕様に合わせて期待値更新(単なる削除で逃げない)。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLで実機確認: 対局モードで数手進めてグラフに点が増えること、定石区間が帯表示になること、評価バーが相手の直前の手の評価を表示すること(キャプション込み)。中盤練習でも同様。確認記録を作業ログへ。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-23 実装完了(implementer)

**設計判断:**
- 共有ロジックを新規 `app/src/components/moveEvalTimeline.ts`(純粋関数、`.test.ts`あり)に集約: `PlayedMoveEval`型(`ply/notation/side/discDiff/source/isExact`)・`buildEvalGraphPoints`(黒視点変換+joseki時0固定)・`lastMoveEvalBarStateFor`(指定側の直近手)・`lastMoveEvalBarState`(手番不問の直近手、vsHuman用)。対局モード(`app.tsx`)・中盤練習(`midgame/PracticeMode.tsx`)の双方から再利用し、ロジックの重複・drift を避けた。
- `game/gameLoop.ts`の`requestCpuMove`の戻り値を`GameState`単体から`{state, evalScore}`(`CpuMoveOutcome`)に変更し、これまで捨てていた`response.score`をCPU視点の評価値として呼び出し元へ渡す配線を追加(`EngineQuery.requestAnalyze`の返り値型に`score?`を追加)。エンジン呼び出し自体は増やしていない。
- 対局モード: `moveEvalHistory`(useState、`moveHistory`と同順・同長)を新設。人間の手は`handleMove`でply位置にプレースホルダー(discDiff:null)を同期的に積み、`evaluateHumanMove`解決時に同じ位置を上書き(upsert)。CPUの手は着手effectの`.then`で`h.length`をキーに追記。両者が非同期で解決順不同でもズレない設計にした。評価バーは`computeBoardEvalScore`依存を撤去し、`lastMoveEvalBarStateFor(moveEvalHistory, opposite(humanSide))`(CPU対戦)/`lastMoveEvalBarState(moveEvalHistory)`(vsHuman)から導出。キャプションは仕様書指定どおり「相手の直前の手の評価(あなた視点、+ならあなた有利)」(CPU対戦)、vsHumanは手番色ラベル付き。
- 中盤練習: `SessionState`/`ResultInfo`に`moveEvalHistory`を追加(プレイヤー+相手の全手)。`MoveOutcome`に`playedDiscDiff`フィールドを追加(仕様書指定)。`updateEvalBarFromMoves`(旧・盤面評価ベース)は削除し、同キャプション文言で評価バーを表示。プレイ画面・結果画面の両方に`EvalGraph`を配置。
- グラフの`move`(ツールチップの最善手ロス・分類)フィールドは付与していない(悪手比較UI=T195/T196のスコープ外のため、誤った"最善/準最善"表示を避ける意図的な省略)。

**テスト:**
- 新規: `components/moveEvalTimeline.test.ts`(黒視点変換・joseki 0固定・null=joseki扱い・side別直近手/手番不問直近手、13ケース)。
- 新規: `game/gameLoop.test.ts`の`requestCpuMove`系4ケースを新返り値形状に更新(`evalScore`の値も検証)。
- 新規: `app.playmode.moveEval.test.tsx`(CPU対戦、実物`requestCpuMove`経由): (a)CPU未着手時は中立表示 (b)CPU探索応手時は`response.score`があなた視点へ反転してバー表示+グラフ点数が3に増える (c)CPUブック手時はバーが「定石」表示。
- 更新: `app.playmode.cpuHistory.test.tsx`(`requestCpuMove`ラッパーの戻り値形状変更に追従)、`app.playmode.evalDisplay.test.tsx`(vsHumanモードの旧「盤面評価バー」前提2件を新仕様「前回の手の評価値」に更新、うち1件はf5後の白応手がモック上joseki判定になるため「定石」表示になることを確認する内容に変更)。
- 既存テスト回帰: `npm test`(vitest run)102ファイル/861件全件パス。

**実行結果:**
- `cd app && npx tsc --noEmit -p .` exit 0。
- `cd app && npx vitest run` → Test Files 102 passed / Tests 861 passed。
- `cd app && npm run build` → 成功(wasm再ビルド込み)。
- コミット: `871aecd`(`app:` プレフィックス、変更対象ファイルのみパス明示add)。push成功(`6f63735..871aecd main -> main`、T196との競合なし)。
- GitHub Actions: `gh run watch 29959263568` → build/deploy とも成功。
- Pages実機確認(`https://giwarb.github.io/othello-trainer/`、Browser pane+JS直接dispatch、canvasクリック不可のためcanvas要素へMouseEventを直接dispatchして操作):
  - 対局モード(CPU対戦、黒番): 開始直後は評価バー「相手の直前の手の評価(あなた視点、+ならあなた有利)」+「まだ相手の手がありません」。定石ブックONのままd3着手→CPU応手(定石内)でバーが「定石」表示に。新規対局し定石ブックOFFでd3着手→CPUが探索応手し、バーが数値(例: "-1")表示、`.eval-graph__point`が3個(初期+2手)に増加。
  - 中盤練習(ステージ1「虎」): 開始直後は評価バー中立表示。1手打つと相手が応手し、バーが数値表示("+2"等)に更新、`.eval-graph__point`が3個に。3往復完了後の結果画面でも折れ線グラフが表示され`.eval-graph__point`が7個(初期+6手)。

**判断に迷った点・仕様上の解釈:**
- vsHumanモードのバーキャプション文言(仕様書は「手番色ラベル付きで表示する」とだけ指定し厳密な文言は未指定)は`「${色}の直前の手の評価(${色}視点、+なら${色}有利)」`とした。CPU対戦・中盤練習は仕様書に明記された文言をそのまま使用。
- 評価バーが「定石」表示になるのは、CPUがブック手(探索なし)の場合に加え、人間の手が`evaluateHumanMove`のjosekiDB判定で`source==='joseki'`となった場合(既存のEvalBadge/評価情報バッジと同じ判定基準を流用)も含む。これは仕様書の「CPUが定石ブック手(評価値なし)→数値を出さず「定石」表示」の記述をベースに、人間側の定石内の手にも同じ表現を自然に拡張したもの(design方針2の「人間の定石内の手(source==='joseki')」記述と整合)。

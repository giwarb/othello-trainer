---
id: T138
title: 対局: 評価値表示の新仕様(定石内は0・常時表示・盤面評価=合法手最大)+定石トレース表示
status: in_progress
assignee: implementer(Sonnet)
attempts: 0
---

# T138: 評価値表示の新仕様+定石トレース

## 目的(ユーザー指示 2026-07-18 夜)

ユーザー報告: 初手の4合法手(対称で同値のはず)が「0, 0, -1, -1」と表示される。調査の結果、表示値のズレは共有TT+MPC近似による探索ノイズ(±1石級)で、評価関数自体は対称設計(engine根本対応は別タスクT139、生成完走後)。あわせて評価値表示の考え方をユーザー仕様に作り替える。

## ユーザー仕様(原文の意図)

1. **残り20マスになるまではノード予算探索**で現在盤面の評価値を計算する。盤面評価値は「各合法手(1手浅い探索)の評価値の最大値」で計算し、**各合法手の評価値を画面に出す**。残り20マス以下は完全読み(既存のT116と同じ扱い)。
2. 現在の進行が**定石ブック内にある間は、盤面評価値は0(互角)表示**(ブックは互角と考えられる定石のみ採用という前提)。
3. **合法手の中に定石ブックの手が残っている間**は: ブック手は0表示。ブックより良い(プラス)と評価される非ブック手が出ても**0表示に丸める**(=ブック手が存在する間、表示はすべて0以下。マイナスの非ブック手はそのままマイナス表示)。
4. 合法手にブック手がなくなったら、評価値そのものを表示。
5. **対局中この評価値(合法手評価+盤面評価)は常時表示**(現在のON/OFFチェックは廃止または既定ON化。ユーザー文言は「常に表示していてほしい」なので、チェックを撤去し常時表示を推奨。保存済み設定がfalseの既存ユーザーにも新挙動が適用されること)。
6. **定石トレース表示(オセロクエスト風)**: 対局中、現在の進行がどの定石(名前)をどこまでたどっているかを表示する。ブックを離脱したら最後に一致していた定石名を薄く残す(「〜(離脱)」等)。

## 実装の要点(調査済み事実。explorerレポートに基づく)

- 候補手評価: `app/src/app.tsx:557-577` が `requestAnalyzeAll(displayGame.board, sideToMove, LEVELS[level].limit)` を1回発行。結果`MoveEvalJson.score/discDiff`は**着手側(mover)視点のcenti-disc**。表示は `app/src/components/moveEvalOverlayLogic.ts` の `computeCellEvals`(現在は「最善からの損失」表示)+`formatLoss`。
- 現在の評価値バー: `app/src/app.tsx:586-618` が別途 `requestAnalyze`(単一ルート探索)を発行 → **これを廃止し、analyzeAllの結果の最大値(=仕様1の盤面評価)から導出**する(リクエスト1本化・値の整合が構造的に保証される)。視点変換(`perspectiveSide`)は既存を踏襲。
- 表示ルール変更: `computeCellEvals` を「損失表示」から「評価値表示(mover視点の石差)」に変更し、仕様2〜4のブックcapを適用する純関数を新設(`applyBookCap(cellEvals, bookMoves)` 等。テスト容易性のため純関数に)。丸めは四捨五入の整数石差、+0/-0は「0」。
- ブック照合: `app/src/joseki/lookup.ts` の `lookupJosekiNode(db, board, sideToMove, firstMoveSquare)` が `{names, bookMoves(実座標), isLeaf}` を返す(対局モードでは`firstMoveSquareRef`が既にある: T115)。人間手番でのlookupを追加し、(a)ブック内判定(盤面評価0表示)、(b)合法手のブック手集合(cap適用)、(c)namesをトレース表示に使う。CPU応手選択(`selectCpuBookMove`)との整合に注意(同じDB・同じ正規化)。
- 常時表示化: `DEFAULT_MOVE_EVAL_OVERLAY_ENABLED`/`DEFAULT_EVAL_BAR_ENABLED`(app/src/settings/)と`app.tsx:1071-1086`のチェックボックス。**チェックを撤去して常時ON**にする(保存済みfalseの上書き問題を回避できる)。設定パネルから該当項目を除去。
- 定石トレースUI: 盤の上下いずれか(PlayerBadge付近)に「定石: 兎定石(5手目)」のような1行。namesが複数なら代表1つ+「他n」。2人対戦でも表示してよい。レスポンシブ・横置き両対応。
- **表示の遅延**: analyzeAllは`displayGame`基準(T134)を維持。エンジン計算中のプレースホルダ(既存挙動)踏襲。

## やらないこと(スコープ外)

- エンジン(Rust)の変更・再ビルド(探索ノイズの根本対応はT139、生成完走後)
- 定石練習モード・解析モードの表示変更 / ブックDB自体の変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`/`npm run dev`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`と`npx vite`直接)。一時ファイルはscratchpadへ。

## 受け入れ基準

- [x] ブックcap純関数のユニットテスト: ブック手0化/非ブックのプラス→0丸め/非ブックのマイナス→そのまま/ブック手なし→素通し/盤面評価=capまたは素の最大値(仕様2〜4の全分岐)
- [x] 統合テスト(jsdom): 初手局面で4合法手すべて0表示になること(ブックcap経由)/ブック離脱後は素の値が出ること/評価バーがanalyzeAll最大値と一致すること/定石トレースが表示され離脱後に「(離脱)」化すること
- [x] 「候補手評価を表示」「現在の評価値を表示」チェックが撤去され、保存済みfalseの環境相当(localStorage設定)でも常時表示されるテスト
- [x] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [x] mainへpush→Actions成功→本番Pagesで: 新規対局の初手で4手とも「0」表示・定石トレース表示・ブック離脱後に非0の評価値が出ること・評価バー常時表示を確認(375x812・844x390)
- [x] 変更対象のみパス明示コミット(`app:`、`(T138)`)。`tasks/`はコミットしない
- [x] 当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18: 実装完了。
  - `app/src/components/moveEvalOverlayLogic.ts`: `CellEval.lossDiscs`(ロス表示)を`evalScore`(mover視点の評価値そのもの)に変更。分類(`classification`)は従来どおり最善手とのロス量で判定(色分けのみに使用、cap適用前)。新たに純関数`applyBookCap(cellEvals, bookSquares)`(仕様2〜4のcap: ブック手→0/非ブックのプラス→0丸め/非ブックのマイナス→そのまま/bookSquares空なら素通し)と`computeBoardEvalScore(allMoves, bookSquares)`(盤面評価=合法手評価の最大値、bookSquares非空なら0)を追加。`formatLoss`は`formatEvalScore`(符号付き整数、0は符号なし"0")に置き換え。
  - `app/src/components/moveEvalOverlayLogic.test.ts`: 上記純関数の全分岐(cap4パターン+分類独立性+盤面評価2パターン+フォーマット)をユニットテストで網羅。
  - `app/src/components/MoveEvalOverlay.tsx`: `bookSquares`propを追加し、内部で`applyBookCap`を適用してから描画するよう変更。表示ラベルも評価値ベースに変更。
  - `app/src/joseki/traceDisplay.ts`(新規)+`traceDisplay.test.ts`: 定石トレース文言を組み立てる純関数`formatJosekiTrace(names, ply, left)`。複数ライン合流時は代表1件+「他N」、離脱時は「(離脱)」を付す。
  - `app/src/app.tsx`: (1)候補手評価オーバーレイ+評価値バーを1本の`requestAnalyzeAll`エフェクトに統合(旧`requestAnalyze`呼び出しは廃止)。同エフェクト内で`safeLookupJosekiNode`(既存のtry/catchラッパーを再利用)によりブック手集合を求め、`computeBoardEvalScore`で盤面評価を算出。(2)候補手評価・評価値バーのON/OFF state(`moveEvalOverlayEnabled`/`evalBarEnabled`)とチェックボックス・トグル関数を削除し常時表示化(設定パネルの見出しも「設定(候補手評価・現在の評価値・悪手判定)」→「設定(悪手判定)」に変更)。(3)定石トレース用state`josekiTrace`+専用エフェクト(`displayGame`の手数=石数-4が1以上になってから追跡開始。初期局面はDB全112ライン一致で無意味なため対象外)。(4)`prepareNewGame`で新規state群をリセット。(5)`.player-badges`と定石トレース段落を`.play-board-area__header`という共通ラッパーに包み、横置きレイアウトの1行目grid配置をこのラッパーに付け替え(`app.css`)。
  - `app/src/app.css`: `.play-board-area > .player-badges`のgrid配置ルールを`.play-board-area__header`へ付け替え、`.joseki-trace`のスタイルを追加。
  - `app/src/app.playmode.evalDisplay.test.tsx`(新規): 2人対戦モード(CPU応手のモック不要)でend-to-endに近い統合テスト3件(チェック撤去+常時表示/初手4手が0表示+盤面評価0/定石トレース表示→離脱「(離脱)」化+離脱後は素の値+評価バーがanalyzeAll最大値と一致)。
  - `settings/evalBarSettings.ts`/`moveEvalOverlaySettings.ts`自体は削除していない(前者は`openingBookSettings.ts`が`StorageLike`型を再利用しており現役、後者は定石練習/中盤練習/詰めオセロ/棋譜解析の各モードが独自のトグルとして引き続き使用中のため。対局モードからの参照のみ削除)。
  - 実行コマンド: `npx vitest run`(全97ファイル774件パス)、`npx tsc --noEmit -p app/tsconfig.app.json`(エラーなし)。
  - コミット: `21ff0b4`(`app: 評価値表示を「損失」から「評価値+定石ブックcap」へ作り替え、定石トレース表示を追加(T138)`)。`git push origin main`済み、GitHub Actions「Deploy to GitHub Pages」run 29640809929 成功。
  - 本番Pages(`https://giwarb.github.io/othello-trainer/`)での実機確認(375x812・844x390、Browser MCPのJS実行経由でcanvasクリックを座標計算し検証。`computer`スクリーンショットツールが本セッションでは継続的にタイムアウトしたため、`read_page`/`get_page_text`/`javascript_tool`のDOM検査で代替した):
    - 2人対戦モード開始直後(初期局面): 候補手評価4件すべて`"0"`表示、評価値バー`"+0"`。旧チェックボックス(候補手評価/現在の評価値)はDOMに存在しない。
    - 黒がf5(定石内)着手後: 定石トレース`"定石: 虎(他111)(1手目)"`が表示(白番、まだ112ライン中の多くが合流中)。
    - 白がd6着手後(まだ定石内): トレース`"定石: 虎(他76)(2手目)"`、候補手評価は書籍手0・非書籍の悪手候補のみ生の負値(`-24`)が出ることを確認(cap適用+非cap値の共存を実機で確認)。
    - 黒がc7(定石外・-24だった手)着手後: トレースが`"定石: 虎(他76)(2手目)(離脱)"`に変化(直前一致情報を保持したまま離脱表示)。候補手評価は生の値(`+15/+22/+6/+4/+5`)が出て0丸めされていないことを確認。評価値バーは`"-22"`で、白の最大評価`+22`を黒視点に符号反転した値と一致(仕様1・「値の整合が構造的に保証される」ことを実機で確認)。
    - 844x390(横置き)で`.play-board-area__header`(プレイヤーバッジ+トレース)がgrid 1行目に正しく全幅配置され、盤・右カラムと重ならないことを`getBoundingClientRect`で確認。375x812(縦持ち)でもバッジとトレースが正しく縦積みされ重ならないことを確認。
  - 判断に迷った点: (a)定石トレースの「離脱」表現は、実際に定石手順を外れた場合とライン終端まで指し終えた場合の両方を区別せず同じ「(離脱)」表示にした(仕様に区別の指示が無かったため)。(b)候補手評価の色分類(best/inaccuracy/dubious/blunder)はcap適用前の生のロス量で判定する設計にした(cap後の値で判定すると、ブック内では全手が0になり分類が意味をなさなくなるため)。(c)評価値バーは`displayGame.phase==='cpu'`の間、直前(人間手番時)の値を保持したまま更新しない設計にした(analyzeAllへの統合により、CPU思考中は候補手評価が存在せず盤面評価を再計算する材料が無いため。値が消えたり古い値のまま出たりする方式のトレードオフとして、視認性を優先し「消えない」側を選んだ)。いずれもユーザー/オーケストレーターの追加指示があれば変更可能。

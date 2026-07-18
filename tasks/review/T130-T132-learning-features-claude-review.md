# T130/T132 最終レビュー(Claude、2026-07-18)

- 対象: T130 復習フィルタ(コミット `f167a26`)/ T132 対局→棋譜解析導線(コミット `c0ba489`)
- 方法: `git show` による差分精読 + 周辺コード照合(`parseTranscript.ts` / `analyzeGame.ts`(replayGame) / `gameLoop.ts` / `resolveMover.ts` / 両 `stageProgress.ts` / `judgeModeStorage.ts` / `app.tsx` 現行版 / `AnalysisMode.tsx` 現行版)+ `npx vitest run`(app配下)
- テスト実行結果: **83ファイル / 711件 全パス**(HEAD時点、両コミット込み)

---

## T130: 復習フィルタ(f167a26)— 総合判定: **合格**

### 観点(1) フィルタ判定とグリッドindexの整合(最重点)

**問題なし。**

- 詰めオセロ(`app/src/tsume/PlayMode.tsx`): 絞り込みは `pool.map((puzzle, index) => ({puzzle, index})).filter(...)` の形で**フィルタ前に元のindexを束縛**しており、セルのクリックは `startPractice({kind:'stage', stageIndex: index})`、表示番号・titleも `index + 1` で元の通し番号を使う。フィルタで先頭側が除外されても、クリックで開くのは常に表示どおりの問題。`pickPuzzle` は `pool[stageIndex]` を直接引くため整合。
- 中盤練習(`app/src/midgame/PracticeMode.tsx`): そもそもindexを使わず `startStagePractice(stage)` に**ステージオブジェクト自体**を渡す設計のため、indexずれが構造的に起きない。表示番号も `stage.stageNumber`。
- テストも「フィルタ後に表示されるステージ**番号**」(例: 失敗ありで `['2','4']`)を両モードで検証しており、番号の保存(=indexずれ無し)の証拠になっている。
- 補足(軽微・仕様どおり): フィルタ後にセルから問題を開いて「次の問題」を押すと、フィルタとは無関係に元のpool順の次の問題へ進む(`nextPuzzle` は従来ロジックのまま)。タスク要件4「既存のクリック挙動は変えない」に沿った挙動であり指摘ではないが、「失敗した問題だけを連続でやり直す」体験としては将来改善の余地がある。

### 観点(2) matchesReviewFilter の5状態の意味論

**両モードで一貫。問題なし。**(`app/src/settings/reviewFilter.ts`)

- `all`=常に一致 / `unattempted`=`status==='unattempted'` / `hasFailure`=`failCount>0`(現在の状態を問わない累積判定。クリア済みでも過去に失敗があれば対象) / `uncleared`=`status!=='cleared'`(**未挑戦を含む**) / `cleared`=`status==='cleared'`。各定義はJSDocに明文化され、`reviewFilter.test.ts` が状態3種×フィルタ5種の意味のある組み合わせを網羅。
- 状態の導出は詰めオセロが `stageStatus`(1階層・`Puzzle.id`キー)、中盤練習が `stageStatusForMode`(判定モード別2階層)+ `stageProgress[key]?.[judgeMode]?.failCount ?? 0` で、`StageStatus` の定義(`clearCount>0`→cleared、entry無し→unattempted)は両モード同一実装。要件2(現在選択中の判定モードで判定)どおりで、判定モード切替への追従テストもある。
- 軽微(意図された仕様): 中盤練習ではフィルタ判定が**現在の判定モードの記録**、セルの色分け・★は従来どおり**全モード横断**のため、「未挑戦」フィルタで残ったセルが挑戦済み色で表示されることがある。要件4(色分けを変えない)との両立の帰結で、コード内コメントにも明記済み。redo不要。

### 観点(3) localStorage永続化の検証

**問題なし。** `loadReviewFilter` は「キー無し→既定値 / JSON.parse失敗→try-catchで既定値 / 既知5値以外(文字列でない・未知文字列・null)→既定値」を実装し、いずれもテスト済み。実装は既存の `judgeModeStorage.ts` / `moveEvalOverlaySettings.ts` と同一パターン(`StorageLike` 抽象化)で一貫。
- 軽微: `storage.getItem`/`setItem` 自体が投げる例外(ストレージ無効環境等)は捕捉していないが、これは既存の全設定モジュール共通の前提であり本タスク固有の後退ではない。

### 指摘まとめ(T130)

| 重大度 | 内容 |
|---|---|
| 軽微 | 「次の問題」がフィルタを考慮しない(仕様どおり・将来改善候補) |
| 軽微 | 中盤練習でフィルタ判定(モード別)と色分け(横断)の基準が異なる(意図された仕様・コメント明記済み) |
| 軽微 | storage自体の例外は非捕捉(既存パターン踏襲) |

ブロッカーなし。**合格**。

---

## T132: 対局→棋譜解析導線(c0ba489)— 総合判定: **合格(中2件は申し送り)**

### 観点(4) gameHistoryの履歴記録の正確性

**実質的な漏れ・二重記録は確認できず。**

- CPU着手effect: `setMoveHistory((h)=>appendPlayedMove(h, game, next))` と `setGame(next)` を**同一の `if (!cancelled)` ブロック内**で実行。effect再実行(deps: `game, level, openingBookEnabled, josekiDb, josekiDbReady`)時はcleanupで旧リクエストが `cancelled=true` になるため、設定変更が着手要求と競合しても記録は高々1回。`requestCpuMove` が状態を返せなかった場合(`pv`空)は `lastMove` 不変で `appendPlayedMove` がno-op。
- `appendPlayedMove` の「`lastMove` 変化検知」は健全: 一度打たれたマスは埋まったままなので、連続する2手の `lastMove` が同一マスになることは盤面規則上ありえず、変化検知=着手成立と同値。非合法手(同一オブジェクト返し)も正しく弾く。
- undo/待った機能は存在しない(grep確認)ため、履歴の巻き戻し漏れの懸念はない。`prepareNewGame()` が `setMoveHistory([])` を含み、新規対局・エディタ開始のすべての経路でリセットされる。
- **軽微**: `handleMove` が従来の関数型更新 `setGame(prev=>playMove(prev,square))` からクロージャ直接参照 `playMove(game, square)` に変わった。再レンダー前に同一クロージャで `onMove` が2回発火する(例: 合成イベントの二重dispatch)極端なケースでは、旧実装(2回目は着手済みマスで非合法→no-op)と違い履歴に同じ手が二重追記されうる。Preactの再レンダーはマイクロタスクで走り通常のクリック間では発生しない・発生しても解析時に `TranscriptReplayError` として顕在化する(静かに壊れない)ため軽微。なおコメントの「React 18 Strict Mode」への言及は本アプリ(Preact)には該当しない(記述上の瑕疵のみ)。

### 観点(5) パス局面の棋譜変換と parseTranscript/replayGame の規約整合

**厳密に整合。問題なし。**

- 記録側: `gameLoop.ts` の `afterMove` は「相手に合法手→交代 / 無ければ自分が続行(パス) / 双方無し→終局」。パスは `GameState` 遷移として現れず `lastMove` も変わらないため、履歴には実着手のみが積まれる。
- 再生側: `replayGame` は `resolveMover`(相手優先→自分→null)でパスを自動解決する。**`afterMove` と `resolveMover` は同一規則の実装**(resolveMover.tsのコメントにも明記)であり、パス省略棋譜の再生が対局進行と一致することが構造的に保証される。連続パス終局後の余剰手は `TranscriptReplayError` で検出される。
- 記法: `squareToNotation` の小文字 `a1..h8` 連結は `parseTranscript` の受理形式(区切りなし連結可・小文字化)に適合。`gameHistory.test.ts` がパス含み対局(e1→白パス→f8終局)で「棋譜にパスが現れない」ことまで検証。
- 黒番先手の前提も整合: `createGame` は人間が白でも黒(CPU)から開始し、記録は常に黒の初手から。`replayGame` の既定開始(標準初期局面・黒番)と一致し、非標準開始は観点(7)のガードで遮断される。

### 観点(6) initialTranscript の消費フロー

**二重解析・取りこぼしなし。中1件あり。**

- 消費フロー自体は健全: effect(deps `[initialTranscript]`)→解析開始→`onInitialTranscriptConsumed()` でApp側 `pendingReviewTranscript` をnull化→ null再レンダーでは早期return。モード切替で `AnalysisMode` はアンマウント(`{mode==='analysis' && ...}`)されるため、解析→対局→解析の往復でも再解析は走らない。再度「振り返る」を押せば新規マウント+新транスクリプトで正しく1回だけ発火。`onInitialTranscriptConsumed` を意図的にdepsから外す理由もコメントで妥当に説明されている。
- **中(a)**: 自動解析は**マウント直後のeffectで `startAnalysis` を呼ぶため、`josekiDb` が必ず `null` の状態で解析が走る**(定石DBロードは同時に始まる非同期effectで、解決は必ず後)。`analyzeGame` は `josekiDb: null` でフォールバックするので解析自体は成功するが、手動貼り付け経路(通常はDBロード済みの状態でユーザーがボタンを押す)と異なり、**定石内の手の悪手誤判定除外(T038)と `evalSource:'joseki'` 表示が振り返り解析では常に効かない**。序盤の定石手が悪手として赤表示されうる、経路間の挙動差。修正案: 効果内で `loadJosekiDb()`(モジュールキャッシュ済み)の解決を待ってから `startAnalysis` を呼ぶ、または `josekiDb` ロード完了を待つガードを足す。ブロッカーではないが申し送り推奨。

### 観点(7) isStandardStartPosition の正しさ

**問題なし。** bitboard等値比較(`board.black/white === initialBoard()`)+ 黒番判定。白番なら標準配置でもfalse(黒先手規約と `replayGame` 既定に一致)。`startNewGame`/`startVsHumanGame` は無条件でtrue、`startFromEditor` はエディタの `editorBoard`/`editorSideToMove`(`createGameFromPosition` に渡す値そのもの)で判定しており評価対象と判定対象がずれない。テストも4象限(標準×黒/白、非標準、createGameFromPosition経由)をカバー。

### 観点(8) テストの実質(共通)

- **T130**: モックはCanvas盤・エンジンWorker・定石DBのfetch等、jsdomで動かせない境界のみ。フィルタ判定・永続化・グリッド描画・判定モード切替はすべて実物で動かしており空洞化なし。
- **T132**: `playMove` を「1手で即終局」に差し替えるモックは、検証対象を「本タスクで書いた統合コード(履歴記録の呼び出し位置・ボタン表示条件・App経由のモード遷移・自動解析開始)」に限定するための妥当な境界。`playMove`/パス処理の実物は `gameHistory.test.ts`(実関数使用)と既存 `gameLoop.test.ts` が担保しており、モックが実装と乖離しても `gameHistory.test.ts` 側が破綻を検知できる構図。空洞化はしていない。
- **中(b)**: ただし**CPU着手effect経由の履歴記録には自動テストがない**(コンポーネントテストは2人対戦モードのみで、CPU経路は通らない)。作業ログのPages実機確認も「2人対戦で開始」→「CPU(weak)相手に60手」と記述が両義的で、CPU対局での終局→60手転記が実機確認されたのか確定できない。コードレビュー上は正しい(観点(4))が、`requestCpuMove` 解決後の記録はT132の中核経路であり、CPU対局(モック応答でよい)での記録を検証するテストの追加を申し送り推奨。

### 指摘まとめ(T132)

| 重大度 | 内容 |
|---|---|
| 中(a) | 振り返り自動解析が常に `josekiDb=null` で走り、定石内悪手除外・定石表示が手動経路と異なり効かない(AnalysisMode.tsx のT132 effect) |
| 中(b) | CPU着手経路の履歴記録に自動テストがない(コンポーネントテストは2人対戦のみ)。実機確認記述も両義的 |
| 軽微 | `handleMove` のクロージャ直接参照化により、同一レンダー内の二重発火時に履歴が二重追記されうる(発生確率は極めて低く、発生しても解析時にエラーとして顕在化) |
| 軽微 | コメントの「React 18 Strict Mode」言及はPreactには不適合(記述のみ、挙動影響なし) |

重大(ブロッカー)なし。**合格**(中2件はSTATUS.mdへの申し送り・フォロータスク化を推奨)。

---

## 総括

| タスク | 判定 | 重大 | 中 | 軽微 |
|---|---|---|---|---|
| T130(f167a26) | 合格 | 0 | 0 | 3 |
| T132(c0ba489) | 合格 | 0 | 2 | 2 |

最重点だったT130のフィルタ×indexずれは、詰めオセロがフィルタ前のindex束縛、中盤練習がオブジェクト渡しで、いずれも構造的に発生しない。T132のパス規約整合も `afterMove`/`resolveMover` の同一規則実装により厳密に成立。検証コマンド `npx vitest run`(app配下)は711件全パス。

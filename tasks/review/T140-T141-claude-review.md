# T140・T141 最終レビュー(Claude 代替レビュー)

- 対象:
  - T140(対局: 1手戻る、研究用)— コミット `41cf510`
  - T141(中盤練習: ステージクリア型全面改訂)— コミット `632eae0`
- レビュー方法: 両タスクファイル(仕様・裁定・作業ログ)と `git show` による差分・周辺コード読解。
  検証コマンドは `npx vitest run` のみ実行(**95 files / 771 tests 全パス**、本レビューで再実行して確認)。
  bench/train・typecheck・dev サーバー・Rust/wasm ビルドは指示どおり未実行。
- レビュー日: 2026-07-19

---

## 総合判定

| タスク | 判定 | 重大 | 中 | 軽微 |
|---|---|---|---|---|
| T140 | **合格** | 0件 | 1件 | 2件 |
| T141 | **合格** | 0件 | 0件 | 5件 |

いずれもブロッカーなし。done 判定可。中・軽微の指摘は下記のとおり申し送り。

---

## T140(対局 undo、41cf510)

### 確認できた点(観点1〜3)

**(1) replayMoves 再構築と displaySequencer.reset・世代ガードの整合 — 問題なし**

- `undoMove`(app/src/app.tsx)は ①`gameGenerationRef` インクリメント → ②`computeUndoLength`
  → ③履歴 truncate → ④`replayMoves` で GameState 再構築 → ⑤`setMoveHistory`/`setGame`/
  `displaySequencerRef.reset(next)`/`setThinking(false)`/`setEvalInfo(null)`/`firstMoveSquareRef` 再計算、
  の順で同期的に行う。T134 の表示直列化キューの残骸(保留 push・タイマー)は reset で破棄され、
  T115 の `cancelled` クロージャ(effect 再実行時クリーンアップ)に世代照合が**加算**されており
  (新規 effect は増やしていない)、T115/T134 のレース再導入は認められない。
- **undo 直後に CPU 応手が届くタイミング競合**: CPU 着手 effect の `.then`/`.finally` が
  `!cancelled && gameGenerationRef.current === generation` の二重ガードで、undo 後に解決した
  in-flight 応手の適用・`setThinking(false)` を確実に捨てる。undo と CPU 応手確定
  (`setMoveHistory`+`setGame`+`push` は同一コールバック内で同期)の間に割り込みは入らない。
  応手が undo「前」に確定済みで表示遅延中(T134 の間)に undo した場合も、履歴には既に CPU 手が
  積まれているため 2ply 戻し+reset で整合する。
- **undo 連打**: 同一レンダー内の連打は同じ `moveHistory` クロージャから同じ結果を計算するため
  冪等(2連打が1回分になる)。破綻はしない(軽微3参照)。
- **undo→即着手**: undo で `phase` が human に戻り、人間着手ハンドラは更新後の `game` を使う。
  前局面向け解析中の overlay 取得は effect cleanup で破棄される。問題なし。

**(2) computeUndoLength の意味論 — 妥当**

- 履歴を初期局面から再生して各着手の手番側を復元し、「末尾から CPU 側の着手を除去し続け、
  続く human 側 1 件を除去」する実装(app/src/game/gameHistory.ts)。
  - パスで同じ側の着手が連続するケースも手番復元で自然に処理される(単体テストあり)。
  - **思考中(CPU 応手未記録)の自動 1ply 化は安全**: 末尾が human 側なので while ループが
    何も除去せず 1 件のみ除去される。特別扱いフラグが無いため「応手が記録済みか否か」の
    レースで意味論が揺れない(記録済みなら 2ply、未記録なら 1ply+世代ガードで in-flight 破棄、
    どちらに転んでも整合)。この設計は堅牢で良い。
  - vsHuman は `max(0, len-1)` の 1ply。仕様どおり。
- gameHistory.test.ts 23件 + app.playmode.undo.test.tsx 7件(思考中世代ガード・パス・vsHuman・
  終局後・非活性/非表示)でカバーされている。

**(3) firstMoveSquareRef 再計算と定石トレース・T138 評価表示の整合 — 概ね整合、1点指摘(中1)**

- `firstMoveSquareRef` は truncate 後履歴の先頭(空なら null)へ再計算され、定石ルックアップの
  f5 正規化基準・CPU ブック応手選択と整合する。空に戻した後は既存の記録用 effect が次の初手を
  再捕捉する。
- T138 評価表示(オーバーレイ+評価バー)は `displayGame` 依存の effect が reset 後に再発火して
  undo 後局面で再計算される。`setEvalInfo(null)` で着手フィードバックも消える。整合。
- 定石トレースは effect が `displayGame` 変化で再計算され、「(離脱)」状態の解消も統合テストで
  確認済み。ただし下記【中1】の取りこぼしがある。

### 指摘

- **【中1】初期局面まで全部戻すと定石トレース表示が残留する。**
  定石トレース effect(app/src/app.tsx の `josekiTrace` 更新 effect)は
  `ply <= 0` で early return するため、undo で履歴が空(ply=0)まで戻ったとき
  `josekiTrace` が更新されず、直前の「定石: 〜」(active のまま)が初期局面上に表示され続ける。
  `undoMove` も `josekiTrace` をクリアしない(新規対局開始時は `setJosekiTrace(null)` している)。
  表示のみの不整合で、次の 1 手で自動回復するため redo 不要だが、
  `undoMove` で `truncated.length === 0` のとき `setJosekiTrace(null)` する 1 行修正を推奨。
  (受け入れ観点「undo 後に定石トレースが整合」の未テット経路)
- **【軽微1】履歴が CPU の手のみ(人間が白番でまだ未着手)のとき undo ボタンが活性で、
  押すと CPU 初手を取り消すが effect が即座に打ち直す**(ブック重み付きランダムなら
  別の手になりうる)。実害はなく「CPU 初手の引き直し」として振る舞うが、意図した UX か
  不明瞭。human 側の着手が 1 つも無いときは非活性にする方が素直。
- **【軽微2】undo 連打は同一レンダー内では 1 回分に併合される**(冪等計算のため安全側)。
  仕様上問題なしとみなすが、挙動として記録しておく。

---

## T141(中盤ステージクリア型改訂、632eae0)

### 確認できた点(観点4〜7)

**(4) ★判定式・測定点・相手応手 — ユーザー仕様と厳密一致**

- `stageStarJudge.ts` の `computeStageStars`: `allBest(3手ちょうど全て isBest)→3` /
  `loss<1→2` / `loss<5→1` / `それ以外→0`。裁定(損失<5=★、<1=★★、全最善=★★★、≥5=★0)と
  厳密一致。境界値(ちょうど5→★0、ちょうど1→★1)はテストで担保。★3 が損失閾値より
  優先される点、3手未満セッションは★3不可(字義解釈)の点は、いずれもコメントに判断根拠が
  明記されており妥当。
- **単位の確認**: `MoveEvalJson.discDiff` は石差(= `score`(centi-disc)/100、
  engine/types.ts・moveEvalOverlayLogic.ts のコメントおよび旧 judgeMidgameMove の
  `STANDARD_LOSS_THRESHOLD = 1.0` と整合)。閾値 1/5 を石差として扱う実装は正しい。
- **測定点の同一性**: startEval = プレイヤー1手目の着手前局面の `best.discDiff`
  (mover=プレイヤー → プレイヤー視点)、endEval = 相手3応手後(プレイヤー手番)の
  `best.discDiff`。両方とも共有キャッシュ `getAnalyzedMoves`(`MIDGAME_ANALYZE_LIMIT`
  固定)経由で、同一エンジン設定・同一視点。表示(オーバーレイ・評価バー=
  `computeBoardEvalScore`、cap なしなので best.discDiff と同値)と同じ analyzeAll 結果を
  使い回しており「二重計算しない」要件も充足。途中終局時は実石差(exact)で確定 — 妥当。
- **相手最善応手**: 同じキャッシュの結果から `pickOpponentMove(allMoves, 'best')`。
  表示・判定・応手が同一設定という仕様(実装の参考欄)どおり。

**(5) 記録移行の安全性 — 問題なし**

- 一度きり保証: 移行済みマーカーキー(`…-migrated`)で二重実行を防止。旧キーへの書き込みは
  一切なし(削除もしない)。新記録に既存エントリがあるステージは上書きしない(防御的)。
  壊れた旧データは黙って無視(例外を投げない)。
- 並行タブ: マーカー check→set は非アトミックだが、二重に移行が走っても同一のシード結果に
  なるため実害なし。`recordStageAttempt` の load→save は last-writer-wins(タブ間で稀に
  1 attempt 消失しうる)だが、これは旧実装からの既存パターンで T141 の劣化ではない。
- スキーマ妥当性検証は T117 教訓(ISO 往復一致・フィールド相関チェック)を踏襲。
  `failCount` 追加はタスク仕様スキーマからの拡張だが、要件6「失敗あり」フィルタ維持に
  必要な合理的判断で、根拠がコメント・作業ログ両方に明記されている。

**(6) 1405→590行書き換えでの機能喪失 — 喪失なし(意図的廃止を除く)**

- 残存を実コードで確認: 苦手パターン記録(T129、損失≥1石かつ非最善時に
  `detectAllClearBlunderPatterns` 全件で統計加算・表示は最大2件)/出題プール登録
  (★0 確定時のみ `registerFailureToPool`)/stale-session ガード
  (`sessionGenerationRef`、専用テスト改訂済み)/T133 横置き
  (`@media (orientation: landscape) and (max-height: 520px)` の2カラム grid、
  `.midgame-result:has(.clear-blunder-compare)` へ一般化)/T128 対比表示
  (最悪手 1 件に `ClearBlunderCompare`)/T130 復習フィルタ(共有 `matchesReviewFilter`
  +ローカルラベル上書き)。
- 廃止(判定モード・相手の強さ・開始局面ソース・毎手ゲート・評価表示ON/OFF・
  `generateStart`/`judgeModeStorage`)はすべて仕様が明示する廃止対象。
  `judgeMidgameMove.ts` は verbalize が使うため残置 — 確認した。

**(7) `loadStageProgress`/`stageStatus` 外形維持と app.tsx 無改造 — 主張どおり**

- 両関数のシグネチャ(`(storage)` / `(progress, stageKey)`)・戻り値語彙
  (`unattempted/attempted/cleared`)は不変。app.tsx の import(行51-52)と
  ホーム実績行の利用箇所(行166、`midgameStageStatus(progress, stage.key) === 'cleared'`)は
  無変更のまま新定義(`bestStars>=1`)に追従する。`modeProgress.ts` はコメントのみの変更。
  `app.home.progress.test.tsx` は新 `recordStageAttempt` シグネチャへ追従し、全パス。
- 留意: `loadStageProgress` は初回呼び出し時に移行の副作用として localStorage へ
  **書き込む**ようになった(ホーム描画パスでも発火)。挙動としては安全(冪等)だが、
  read 関数に write 副作用が入った点は覚えておくとよい。

### 指摘(すべて軽微、redo 不要)

- **【軽微1】相手応手 effect が `checkSessionEnd` に渡す世代を「呼び出し時点の
  `sessionGenerationRef.current`」で読んでいる**(PracticeMode.tsx の相手着手 effect 内)。
  effect 開始時に捕捉した世代ではないため、ガードの実効性が `cancelled` クリーンアップの
  実行順序(レンダー microtask がタイマー macrotask より先)に依存する。現状の実装では
  安全だが壊れやすい書き方。effect 冒頭で `const generation = sessionGenerationRef.current`
  を捕捉して渡す形を推奨(handlePlayerMove は正しく捕捉している)。
- **【軽微2】移行 try ブロック内でマーカー設定がシードデータ書き込みより先**
  (stageProgress.ts `loadStageProgress`)。シード書き込み(`setItem`)が quota 等で
  例外を投げた場合、マーカーだけが立ちシードが永久に失われる。発生確率は極めて低い。
  書き込み成功後にマーカーを立てる順序が堅い。
- **【軽微3】旧記録の失敗履歴は新 `failCount` へ移行されない**(仕様どおり「クリアのみ
  シード」だが、その帰結として旧ユーザーの「失敗あり」フィルタは空から始まる)。
  仕様違反ではない。申し送りとして記録。
- **【軽微4】結果画面の「評価値 A → B(損失X石)」で A・B は丸め表示、X は生値から計算
  するため見た目の引き算と最大1石ズレる**(implementer 自己申告済み、内部値は正しい)。
  気になるなら X も `Math.round(A)-Math.round(B)` 表示に揃える等の調整余地。
- **【軽微5】理論上、開始局面が即終局のステージは 0 手・損失 0 で★2「クリア!」になる**
  (`startStagePractice` 直後の `checkSessionEnd` → `finalizeByFinalScore` →
  `startEval = startEvalRef.current ?? endEval`)。現行ステージプール(中盤局面のみ)では
  到達不能の防御経路。あわせて `settings/reviewFilter.ts` のモジュールコメントが削除済みの
  `judgeModeStorage.ts` を参照したまま(コメント腐敗のみ)。

---

## 検証結果

- `npx vitest run`(app/): **95 test files / 771 tests 全パス**(本レビューで再実行、25.4s)。
  T140 の作業ログにあった「T141 並行編集との衝突で全体実行が失敗する」状態は、両タスクの
  コミット完了後の現 HEAD では解消していることを確認した。
- push・Actions・本番 Pages 確認は各ワーカーの作業ログ報告(`gh run watch` 完走、
  Pages 実機検証)に依拠(read-only レビューのため再実行せず)。T141 のピクセルスクショは
  環境制約で未取得(作業ログに経緯記載あり)。オーケストレーターの別環境での
  スクショ QA 推奨は妥当。

## 推奨フォローアップ(任意、まとめて軽タスク1件で可)

1. T140【中1】: 全戻し時の定石トレース残留クリア(`undoMove` に 1 行)。
2. T141【軽微1】: 相手応手 effect の世代捕捉位置の是正。
3. T141【軽微2】: 移行マーカーとシード書き込みの順序入れ替え。

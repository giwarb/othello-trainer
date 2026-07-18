# T133 最終レビュー(横置きレスポンシブ最適化 + T132中指摘2件の修正)

- 対象コミット: `3810e6e`(app: 横置き(ランドスケープ)レスポンシブ最適化とT132指摘2件の修正、9ファイル、+730/-7)
- 照合: `tasks/T133-landscape-responsive.md`(追加要件2件含む)
- レビュー方法: `git show 3810e6e` の全差分精読 + 周辺コード照合(app.tsx のPlayMode返却JSX・CPU着手effect、PracticeMode.tsx(midgame/joseki)・PlayMode.tsx(tsume)・AnalysisMode.tsx・ClearBlunderCompare.tsx・Board.tsx のDOM構造、app.css既存190行の全セレクタ、全CSSの`@media`一覧)+ `npx vitest run` 実行
- レビュー実施: 2026-07-18(Claude、新規コンテキスト)

## 総合判定: **合格**(done可。中2件は申し送り推奨)

重大(ブロッカー)指摘なし。CSSはすべて既存ファイル末尾への「横置きメディアクエリ内のみ」の追記で、縦持ちへの既存ルール変更は1行もない。追加要件2件(josekiDbReadyガード・CPU履歴テスト)はいずれも指摘の趣旨どおり実質的に修正・検証されている。テスト 85ファイル714件全パスを実行確認済み。

---

## 観点別の確認結果

### 1. CSSの正しさと副作用

**メディアクエリの適用範囲** — `@media (orientation: landscape) and (max-height: 520px)` は app.css / midgame/PracticeMode.css / tsume/PlayMode.css / joseki/PracticeMode.css / analysis/AnalysisMode.css の5ファイルのみに追加。既存ブレークポイントは全て `max-width: 400〜480px` 系で、844x390 / 640x360 のいずれとも交差しない(width>480のため併発しない)。競合なし。PCで高さ520px以下の小ウィンドウにも効くが、その状況ではこのレイアウトの方がむしろ適切で問題ではない。

**grid配置の正しさ** — 各対象画面のJSXを照合した。盤側要素(`.board-container` / `.analysis-result__board-area` / `.clear-blunder-compare__boards`)は必ずルート直下の子であり、`> :not(...)` セレクタで右カラムへ落ちる要素も全て直下の子であることを確認(midgame-practice / joseki-practice / tsume-practice / tsume-result / analysis-result / play-board-area / midgame-result--fail の全て)。`grid-column: 2` のみ指定の自動配置はsparse flowにより文書順どおり行1,2,3…に積まれ、行1に明示配置した盤(col 1)とは衝突しない。標準的で正しいパターン。

**span 6〜12 の妥当性(span 999暴発の顛末を含む)** — 作業ログの「`span 999` で `row-gap` が未使用の暗黙行境界にも積算され高さが数千px規模に暴発」は実挙動として正しい理解であり(gapは行数−1個ぶん必ず生成される)、修正後の各span値と右カラムの実項目数を照合した:
  - play-board-area: 非盤直下子は最大7(status/notice/eval-bar/eval-info/score/review-game/celebration)→ span 8 ✓
  - midgame-practice ≤5 → span 8 ✓ / joseki-practice ≤4 → span 8 ✓ / tsume-practice ≤6 → span 8 ✓ / tsume-result ≤5 → span 8 ✓
  - midgame-result--fail: h2+p最大4+compare-pv+messages+buttons=最大8 → span 12 ✓
  - analysis-result: header/EvalGraph/movelist-wrapの3 → span 6 ✓
  **項目数が将来spanを超えた場合の挙動**: 超過分は同じ列2の下の行に置かれるだけで、重なり・崩れは起きない(盤が右カラム全高に伸び切らなくなるだけ)。また項目数<spanのときの余剰gapは 0.3rem×数個で無害。設計として頑健。ただし将来の項目追加でspanとの整合が黙って崩れうるため、各CSSに実項目数コメントがある現状の運用で許容(コメントは適切に書かれている)。

**display: contents(ClearBlunderCompare)** — ルート `.clear-blunder-compare` は素のdiv(role/イベントリスナなし)で、直下の子は `__boards` と `__messages` のちょうど2つのみ(ClearBlunderCompare.tsx:56-81で確認)。両方とも明示的にgrid配置されており、置き漏れの子はない。`display: contents` の既知のアクセシビリティ問題(a11yツリーからの脱落)はbutton/table/ul等セマンティクスを持つ要素に適用した場合の話で、素のdivでは実害なし(内部の `ul.__messages` 自体はcontentsにしていない)。イベント伝播はレンダリングのみの変更で不変。メディアクエリ内限定なので縦持ちにも影響なし。適切な使い方。

**dvhフォールバック** — `width: min(48dvh, 42vw, 320px)` / `max-height: 100dvh` に vh/svh のフォールバック行がない。dvh非対応ブラウザ(iOS Safari 15.3以前、Chrome 107以前、2022年半ば以前)では宣言全体が無効になり、盤は縦持ち幅(最大 --board-size-lg)のまま2カラムgridに置かれる=横置きで縦スクロールが必要になる。壊れはしない(グレースフルデグラデーション)が、`width: min(48vh, 42vw, 320px)` を直前に1行置くだけで防げる。→ 軽微(3)。また、dvhはiOS Safariのアドレスバー表示/非表示で動的に変わるため、スクロール中に盤がリサイズされる(Board.tsxのResizeObserverが追従して再描画するので壊れないことは確認済み。安定性重視なら svh)。→ 軽微(4)。

### 2. 縦持ちへの非退行

- 5つのCSSファイルの差分は**全てファイル末尾への追記**(ハンク開始位置が各ファイル最終行)で、メディアクエリ外の既存ルールの変更は0行。確認済み。
- app.tsx のラッパー `<div class="play-board-area">`: 親 `main` は `display: block; text-align: center`(flex/gridではない)で、縦持ちではこのdivに一切スタイルが当たらないため、ブロックフローもマージン相殺(境界のないdivを透過)も従来と同一。既存CSSに `main > *` や隣接兄弟セレクタでこの階層に依存するルールがないことを app.css 全量読みで確認(唯一の `main > h1` は今回追加のもの)。非退行は成立。
- `main > h1` のsr-only化はメディアクエリ内のみ、かつ削除ではなく視覚的非表示(クリップパターン)で見出しレベルは保持。アクセシビリティ的にも妥当。

### 3. 追加要件1(josekiDbReady)

- 実装は正しい。`loadJosekiDb()` の `.then`(成功時のみ setJosekiDb)→ `.finally`(成功・失敗とも setJosekiDbReady(true)、`cancelled` ガードあり)の順序により、`josekiDbReady=true` のレンダー時点で `josekiDb` は必ず設定済み(成功時)または null 確定(失敗時)。**ロード失敗時**は ready が立って自動解析が `josekiDb: null` のフォールバック(定石照会スキップ)で進む=永久ブロックしない。指摘「中(a)」の趣旨(手動貼り付け経路との前提条件の一致)を満たす。
- 手動貼り付け経路は無変更(従来どおり押下時点の josekiDb を使う)。影響なし。
- テスト(`AnalysisMode.initialTranscript.test.tsx`)は実質的: ロードPromiseのresolveを外部制御し、(1)未完了中は `onInitialTranscriptConsumed` / `lookupJosekiNode` とも未呼び出し、(2)完了後に解析が走り `lookupJosekiNode` が呼ばれる(= analyzeGame の `josekiDb ? lookup : null` 分岐が真=nullでないDBが渡った証拠)を検証。修正前コードで失敗することも実装者が確認済みと記載。回帰テストとして有効。
- 軽微(5): fetchが永久に settle しない場合(ハング)、自動解析だけでなくテキストエリアへの棋譜プリフィルも保留され、ユーザーには空の解析画面だけが見える。プリフィル(setTranscriptText/setInputTab)はガード外に出し、解析開始のみ ready を待つ分離も可能だった。実害は稀なので申し送りで可。

### 4. 追加要件2(cpuHistoryテスト)

- **空洞化していない。** `vi.mock('./game/gameLoop.ts')` は `importOriginal` で実物の `requestCpuMove` を呼び、返り値の `phase`/`result` だけを強制終局に書き換える薄いラップ。検証対象である app.tsx のCPU着手effect(`requestCpuMove(...).then(next => setMoveHistory(h => appendPlayedMove(h, game, next)))`、app.tsx:385-392)・`appendPlayedMove`・`movesToTranscript`・棋譜解析への引き継ぎと再解析は全て実物が動く。盤面計算も実物 `playMove` 経由(d3→e3は実在の合法手順で、sanityテストで裏取りあり)。強制しているのは「2手で終局しない実オセロの都合」だけで、テスト対象(CPU経路の履歴記録)はモックの外にある。指摘「中(b)」の趣旨を満たす。
- `playMove` 単体モックが効かない理由(gameLoop内部のローカル参照)の説明もコメントに明記されており、将来の保守にも有用。

### 5. テスト実行

- 1回目のフル実行で `app.playmode.review.test.tsx`(T132既存)が1件だけ 5033ms でタイムアウト失敗 → 単独実行はパス(2.3s)、フル再実行で **85ファイル714件全パス**。教師コーパス生成が並走中のCPU逼迫下でデフォルト5秒タイムアウトに接触したフレークと判断(T133の ready ガードはこのテストの経路に非同期1ラウンドを足すが、モックは即時resolveであり構造的な遅延要因ではない)。→ 軽微(6)として申し送り。

## 指摘一覧

- 重大: なし
- 中:
  1. **右カラム単独スクロールが未実装**(仕様「右カラムは内容が多い場合そのカラム内だけ縦スクロール可」): 実装はルートコンテナ全体に `max-height:100dvh; overflow-y:auto` を掛ける方式のため、内容が溢れる画面(解析結果のムーブリスト、失敗画面の長い言語化文など)ではスクロール時に盤も一緒に画面外へ流れる。DOM順不変の制約下では右カラム項目が複数のgridアイテムに分かれておりカラム単位のスクロールコンテナを作れない、という構造的な帰結。検証済みの優先画面(844x390/640x360)は収まっているため実害は限定的だが、仕様との差分として申し送り。
  2. **`.board-container` のグローバル上書きがスコープ外画面へ波及**: app.css の横置きルール(`width: min(48dvh,42vw,320px); margin: 0`)は全 `.board-container` に効くため、2カラム化していない画面(言語化モードの各盤、BlunderPanel、解析の手動再生盤 等)でも横置き時に盤が縮小し、`margin: 0` により中央寄せ(`margin: 0 auto`)が失われて左寄せになる。高さに収まる縮小自体はむしろ望ましいが、左寄せは意図しない見た目変化。`margin: 0 auto` を維持するか、上書きを対象画面のセレクタに限定するのが望ましい。
- 軽微:
  3. dvh のフォールバック行(vh)がなく、2022年以前のブラウザでは横置き最適化が丸ごと無効化される(壊れはしない)。
  4. dvh はiOSアドレスバーの出没で動的に変わり、スクロール中に盤がリサイズされうる(svh なら安定。ResizeObserver追従で描画は壊れないことは確認済み)。
  5. 定石DBロードがハングした場合、振り返り自動解析だけでなく棋譜プリフィルも保留される(プリフィルはガード外に出せる)。
  6. `app.playmode.review.test.tsx` がCPU逼迫時にデフォルト5秒タイムアウトに接触しうる(フレーク1回観測、再実行でパス)。`it(..., { timeout: 15000 })` 等の余裕を検討。
  7. span値と右カラム実項目数の整合はコメント頼み(将来の項目追加時に暗黙に崩れうるが、崩れても重なりは起きず盤の伸長が止まるだけ)。

## 判定理由

重大なし。中2件はいずれも「検証済みの対象画面では実害が出ていない仕様差分/見た目の副作用」であり、redoよりも申し送り(必要なら後続タスクで `.board-container` 上書きのスコープ限定+vhフォールバック1行を軽微修正としてまとめて対応)が適切。追加要件2件は指摘の趣旨に対して実質的な修正・実質的なテストが入っており、テストスイートは全パスを実行確認した。

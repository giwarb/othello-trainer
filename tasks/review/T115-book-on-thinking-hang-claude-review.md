# T115 最終レビュー(Claude代替レビュー): 定石ブックON時「思考中」表示ハング修正

- 対象コミット: `c2bb69ea91c8bbb05ffc3823716e097bab0e8c1a`
- 変更ファイル: `app/src/app.tsx` / `app/src/app.playmode.test.tsx`(新規) / `app/package.json` / `app/package-lock.json` / `app/vitest.config.ts`
- レビュー方法: `git show c2bb69e` の全差分精読 + 周辺コード(`app/src/app.tsx` の PlayMode 全体、`app/src/game/gameLoop.ts` の `requestCpuMove`、`app/src/joseki/selectCpuBookMove.ts`)の読解。コミットが HEAD の祖先であり、作業ツリーに app 配下の未コミット差分がないことを確認済み。

## 総合判定: **合格**

重大(ブロッカー)指摘なし。根本原因(`firstMoveSquare` の useState 化に起因する CPU 着手 effect の二重発火)は構造的に除去されており、安全網 effect が将来の同種競合に対しても症状(表示固着)の再発を防ぐ。回帰テストは「修正前コードで実際に失敗する」ことが実証されており regression-catching として有効。以下、観点別の確認結果と中・軽微の指摘。

---

## 観点1: useRef 化の正当性 — 確認した(問題なし)

`firstMoveSquare` の全参照箇所を `git grep firstMoveSquare c2bb69e -- app/src` で洗い出した:

- `app/src/app.tsx` 内の参照は4箇所のみ: (1) 初手記録 effect(293-294行)、(2) CPU 着手 effect 内の読み取り(309行)、(3) `handleMove` 内の読み取り(494行)、(4) `prepareNewGame` のリセット(503行)。**すべて effect またはイベントハンドラ内での使用であり、JSX(レンダリング出力)はこの値を一切参照していない**。`thinking` の表示(664行の status 行)を含め、他の hook・レンダー式にも依存箇所なし。よって ref 化による「再レンダーが起きず表示が更新されない」回帰は存在しない。
- `PracticeMode.tsx` / `analyzeGame.ts` にも同名の `firstMoveSquare` があるが、それぞれ独立した state machine のフィールド / ローカル変数であり、本変更とは無関係(影響なし)。
- 副次的な改善: 旧コードの `handleMove` は state のクロージャ値(stale になりうる)を読んでいたが、ref は常に最新値を返すため、イベントハンドラでの読み取りはむしろ堅牢になっている。
- effect の実行順序への依存: CPU 着手 effect(300行)は初手記録 effect(292行)より後に宣言されており、同一コミット内では記録が先に走るため 309 行の `firstMoveSquareRef.current` は human 初手直後でも設定済みになる。仮に順序が崩れても `?? game.lastMove ?? notationToSquare('f5')` のフォールバックが同じ値を導出するため、順序依存バグはない。
- `prepareNewGame` の ref リセット→ `setGame(createGame(...))` の順序も正しい(新対局の初回レンダーで `game.lastMove === null` のため記録 effect は no-op、白番開始の CPU 黒初手は f5 フォールバックで正規化される。旧挙動と同一)。

## 観点2: レース修正の完全性 — 確認した(根本原因は除去。残存経路は下記【中-1】、ただし症状は安全網で遮断される)

- **根本原因の除去**: 旧コードでは「人間の着手1回」という通常操作のたびに、初手記録 effect の `setFirstMoveSquare` が再レンダーを誘発し、依存配列に `firstMoveSquare` を含む CPU 着手 effect が必ず二重発火していた(タスク作業ログのデバッグトレースで実証済み)。ref 書き込みは再レンダーを起こさないため、この経路は構造的に消滅。人間の着手1回に対する再レンダー要因(`setThinking(true)`・`setEvalInfo`・`setOverlayMoves`・`setEvalBarValue`)はいずれも CPU 着手 effect の依存値を変えない(`game` は同一参照のまま)ため再発火しない。テストの呼び出し回数アサーション(1回)がこれを裏付ける。
- **cancelled/cleanup の扱い**: cleanup での `cancelled = true`、`.then`/`.finally` の `!cancelled` ガードは変更前と同じパターンで正しい。cancelled 済みインスタンスの `setGame` が適用されない保証も維持。
- **残存する二重発火経路(【中-1】参照)**: 依存配列に残る `level` / `openingBookEnabled`(CPU 思考中のユーザー操作)、`josekiDb` / `josekiDbReady`(DB ロード完了が CPU 初手の思考と重なるケース。ロード完了時は `.then` と `.finally` で2回 state 更新されるため最大2連続の再発火)では、旧来どおり effect の再実行=先行 `requestCpuMove` の破棄と再リクエストが起こる。これらは「設定変更を現在の CPU 手番に反映する」意図された再実行だが、理論上は T115 と同型の「`.finally` 握りつぶし」タイミングに入りうる。**ただし観点3の安全網 effect が phase 遷移で必ず `thinking` を false 化するため、症状(表示固着)は再発しない**。二重リクエスト自体も旧コードから存在する挙動であり、本コミットの守備範囲外として妥当。

## 観点3: 安全網 effect の副作用 — 確認した(誤消灯経路なし)

`useEffect(() => { if (game.phase !== 'cpu') setThinking(false) }, [game.phase])` について:

- `thinking` が true になるのは CPU 着手 effect 内(`phase === 'cpu'` ガード通過後)のみ。安全網が消すのは `phase !== 'cpu'` のときのみ。つまり「CPU が思考中(phase='cpu')なのに表示が消える」経路は構造上ない。
- **パス連続(CPU→CPU)のケース**: CPU 着手後に人間側に合法手がなく `sideToMove` が CPU のまま(`gameLoop.ts` の `afterMove`、207行)の場合、`game.phase` は `'cpu'` のまま変化しないため安全網は発火せず(正しい)、CPU 着手 effect が `game` 変化で再発火して `setThinking(true)` を維持する。このとき先行インスタンスの `.finally` が cleanup に握りつぶされても、新インスタンスが即 true を立て直すため表示は正しい。
- `'human'→'cpu'` 遷移時も安全網は発火するが条件 false で no-op。マウント時(初期 phase='human')の発火は `setThinking(false)`(既に false)で無害。依存が primitive(`game.phase`)なので不要な再実行もない。
- 留意点(指摘ではない): エンジンエラーで `requestCpuMove` が reject し `phase` が `'cpu'` に留まる場合、安全網は消さず「思考中」が残るが、これは「進行不能状態の可視化」としてむしろ正しい挙動。

## 観点4: テストの質 — 確認した(妥当。軽微指摘2件)

- **モックの範囲**: `getSharedEngineClient`(WASM Worker)・`loadJosekiDb`(fetch)・`Board`(canvas 2D、jsdom 非対応)は環境制約上モック必須であり過剰ではない。盤面ロジック(`legalMoves`/`applyMove`/`playMove`)・`PlayMode` の effect 群・`requestCpuMove` は実物を使っており、統合度は適切。`selectCpuBookMove` のモックは呼び出し回数計測(回帰検出の要)のためで意図的。
- **呼び出し回数アサーション(`toBe(1)`)の妥当性**: effect 発火回数という実装詳細への結合ではあるが、(a) jsdom + `act()` の同期 flush では「思考中」表示チェックが修正前コードでも偶然パスする(=表示アサーションだけでは回帰を検出できない)ことを実測し、(b) 修正前 app.tsx に対して本アサーションが実際に失敗(2回)することを検証した上での選択であり、この不具合の性質(スケジューリング競合)に対する現実的で正直な設計。ファイル先頭コメントに検証限界が明記されている点も良い。
- sanity テスト(d3 後に e3 が合法手であることを実ロジックで裏取り)がモックの前提崩れを防いでおり丁寧。
- 【軽微-1】`selectCpuBookMoveCalls` がモジュールレベル配列で `beforeEach` でリセットされない。現状テストが1件なので実害ゼロだが、このファイルにテストを追加すると前のテストのカウントが漏れて壊れる。将来の追加時に `beforeEach` で `length = 0` すること(今回の修正は不要)。
- 【軽微-2】`flushAsyncEffects`(setTimeout(0) × 20 ラウンド)はやや力技で、待ち不足/過剰の境界が経験的。ただし決定性は確保されており、CI フレークの兆候もない(520件全パス)。許容。

## 観点5: vitest 設定変更の影響 — 確認した(影響なし)

- `include` への `src/**/*.test.tsx` 追加で新たに収集されるのは新規の `app.playmode.test.tsx` 1件のみ(glob で確認、他に `.test.tsx` は存在しない)。
- 既定 `environment: 'node'` は不変で、jsdom はファイル先頭の `// @vitest-environment jsdom` プラグマによるファイル単位切り替え。既存 63 ファイルの `.test.ts` 群への影響なし(作業ログで 64 ファイル 520 件全パスを確認済みと報告されており、構成上もそれと整合する)。
- `jsdom` は devDependencies のみへの追加で、本番バンドル(`dependencies` は preact のみ)に影響しない。

## 観点6: コミット範囲 — 確認した(適切)

- 5 ファイルすべてがタスク由来: 修正本体(app.tsx)、回帰テスト(新規 .tsx)、テスト基盤(package.json / vitest.config.ts)、およびそれに伴う lockfile。
- `app/package-lock.json` の差分は**追加のみ**(削除・既存エントリの変更は 0 行。jsdom とその依存サブツリーの新規追加のみ)であり、package.json 変更に対して lockfile を含めるのは必須かつ正しい。無関係なバージョンバンプの混入なし。
- `tasks/` / `CLAUDE.md` / T114 WIP(`bench/edax-compare/` 3ファイル)の混入なし(コミットの変更ファイル一覧および現在の `git status` で確認)。
- コミットメッセージは既存スタイル(`app:` プレフィックス + `(T115)`)に準拠し、原因・修正・テスト設計の説明が具体的で良質。

---

## 指摘一覧(分類)

| # | 重要度 | 内容 | 対応要否 |
|---|---|---|---|
| 中-1 | 中 | CPU 着手 effect の依存配列に残る `level`/`openingBookEnabled`/`josekiDb`/`josekiDbReady` の変化(CPU 思考中の設定操作、DB ロード完了の重なり)では旧来どおり effect 再実行=エンジンへの重複リクエストが起こり、理論上は T115 と同型の `.finally` 握りつぶしタイミングに入りうる。ただし安全網 effect により**表示固着という症状は再発しない**ことを確認した。重複リクエストは修正前から存在する挙動で頻度も低い(ユーザー操作/初手ロード競合時のみ)。 | 今回対応不要。将来 CPU 思考の中断/再要求を整理する際の申し送り事項として STATUS.md に1行残す程度で十分 |
| 軽微-1 | 軽微 | テストの `selectCpuBookMoveCalls` 配列が `beforeEach` で未リセット(現状1テストのため実害なし。テスト追加時にリセットが必要) | 今回対応不要 |
| 軽微-2 | 軽微 | `flushAsyncEffects` の固定20ラウンド待ちは経験的(現状フレークなし) | 今回対応不要 |

## 結論

重大指摘なし・中指摘1件(実害は安全網で遮断済み、対応不要)・軽微2件。修正は根本原因を正しく特定した上での最小限の変更であり、防御(安全網)と検証(実証済み回帰テスト)の両輪が揃っている。**合格**。done 判定を支持する。

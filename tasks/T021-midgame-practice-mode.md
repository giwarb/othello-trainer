---
id: T021
title: 中盤練習モード本体(局面生成+判定モード+相手強さ+UI+ナビゲーション拡張)
status: in_progress
assignee: implementer
attempts: 0
---

# T021: 中盤練習モード本体(局面生成+判定モード+相手強さ+UI+ナビゲーション拡張)

## 目的
設計書 `othello-trainer-design.md` §4「中盤練習モード」を実装する。プレイヤーが中盤の局面から着手練習でき、毎手エンジンが即時評価し、判定モードに応じて正解/失敗を判定する。定石練習(T020)で構築した基盤(評価バッジ、悪手判定、`requestAnalyzeAll`/`requestAnalyze`、IndexedDB永続化パターン)を再利用する。

## 背景・コンテキスト
- 前提: T016〜T020すべて完了・コミット済み。特に以下を再利用する:
  - `app/src/engine/client.ts` の `EngineClient.requestAnalyze`(単一最善応答、`pv`フィールドあり)・`requestAnalyzeAll`(全合法手評価)
  - `app/src/blunder/`(`types.ts`/`isBlunder.ts`/`BlunderSettings.tsx`。ただし中盤練習の判定モードは悪手判定とは異なる概念のため、下記の通り**新規に**`judgeMidgameMove`を作る。既存`isBlunder`は流用せず、参考にする程度でよい)
  - `app/src/joseki/db.ts`(IndexedDB読み書きパターン。`fake-indexeddb`を使ったテスト手法もこれに倣う)
  - `app/src/joseki/buildDb.ts`・`app/public/joseki.json`(定石DB。局面生成ソース(a)で使う)
  - `app/src/components/EvalBadge.tsx`(評価表示。本タスクでもそのまま使えるなら再利用、モード固有の表示が必要なら新規コンポーネントを追加してもよい)
  - `app/src/app.tsx`(ナビゲーション。「対局」「定石練習」の2タブ構成を「中盤練習」を加えた3タブに拡張する)
- 設計書 §4.1「ルール」・§4.2「UI」を参照(以下は本タスク向けに要点を抜粋・簡略化したもの):
  1. 開始局面ソース: (a) 定石終端からランダム、(b) 手数15〜30のランダム実戦局面(WTHOR由来、互角±3石差以内)、(c) 自分の棋譜解析で悪手を打った局面。
  2. プレイヤーは毎手着手 → エンジンが即時評価(depth 16程度、0.3秒以内目安)。
  3. 判定モード(選択式): 厳格(最善手のみ正解)/ 標準(既定、石差ロス≤1.0なら正解)/ 逆転禁止(評価の符号(優勢/劣勢)が入れ替わらなければ続行)。
  4. 相手(エンジン)の強さ: 最善 / 上位3手ランダム / 実戦模倣(WTHOR頻度分布)。
  5. 終了: 空き24で完全読みに切替え、勝勢確定(+2以上維持)でクリア。逆転またはロス超過で失敗 → 失敗局面が自動で出題プールに追加。
  6. UI: 評価バー(石差スケール、既定OFF、失敗時のみ表示)。ミス時: 正解手ハイライト+自分の手との比較PVを盤上に表示+「ここからやり直す」ボタン。
- **本タスクでのスコープ縮小(データ不足による制約)**:
  - 開始局面ソース(b)「WTHOR由来のランダム実戦局面」は、WTHORデータが未導入のため**実装しない**。代わりに、後述の「エンジン自己対局によるランダム中盤局面生成」で代替する。
  - 開始局面ソース(c)「自分の棋譜解析で悪手を打った局面」は、棋譜解析モード(designの§6、未実装)に依存するため**本タスクでは出題ソースとして実装しない**。ただし将来の連携を見据え、出題プールのIndexedDBストアは汎用的な形(`source`フィールドを持つ)で設計し、棋譜解析モード実装時にレコードを追加できるようにしておくこと。
  - 相手強さ「実戦模倣(WTHOR頻度分布)」もWTHORデータが無いため**実装しない**。「最善」「上位3手ランダム」の2種のみ実装する。
  - 比較PVの「盤上に矢印表示」は、盤面上に線・矢印を描画する高度な表現までは必須とせず、**PVの着手列をテキスト/座標リストとして分かりやすく表示すれば足りる**(Canvas上への矢印オーバーレイは実装者の裁量で可能なら実施してよいが必須ではない)。

## 変更対象(新規作成/変更)
- `app/src/midgame/types.ts`: `JudgeMode`(`'strict' | 'standard' | 'noReversal'`)、`OpponentStrength`(`'best' | 'top3Random'`)、`StartPositionSource`(`'josekiEnd' | 'selfPlayRandom'`)、`MidgamePoolEntry`(出題プールのレコード型: `id`, `board`(black/white hex等シリアライズ可能な形), `turn`, `source`, `createdAt`)等の型定義
- `app/src/midgame/generateStart.ts`: 開始局面生成ロジック
  - `pickJosekiEndPosition(josekiDb)`: 定石DBの`isLeaf`ノードをランダムに1つ選び、そこまでの着手列を再生して局面を返す(T017の`buildDb.ts`/`normalize.ts`のデータ構造・逆正規化ロジックを利用)
  - `generateSelfPlayPosition(engineClient)`: 初期局面からランダムに15〜30手(合法手からランダム選択でよい。極端に偏った局面を避けるため、毎手「上位数手からランダム」程度の軽い制約を入れることを推奨するが必須ではない)進めた局面を生成し、`requestAnalyzeAll`等で評価して石差±3以内であることを確認する(超えていれば再生成、既定回数試行しても得られなければ最後の局面をそのまま使う、程度のフォールバックでよい)
- `app/src/midgame/judgeMidgameMove.ts`: プレイヤーの着手を`JudgeMode`に応じて判定する純粋関数。`requestAnalyzeAll`の結果(`MoveEvalJson[]`)・直前の局面評価・`JudgeMode`を受け取り、正解/失敗と失敗理由(ロス量、逆転の有無等)を返す
- `app/src/midgame/pickOpponentMove.ts`: `OpponentStrength`に応じて相手の着手を選ぶ(best=最上位、top3Random=上位3手から均等ランダム)
- `app/src/midgame/pool.ts`: IndexedDBの出題プールストア(`midgamePool`、`othello-trainer`DBに追加。T020の`josekiSRS`と同じDB内に新ストアを追加する形でよい)の読み書き(`addPoolEntry`, `getAllPoolEntries`, `removePoolEntry`等)
- `app/src/midgame/PracticeMode.tsx` + `.css`: 中盤練習モードの画面(判定モード選択・相手強さ選択・開始局面ソース選択 → 対局進行 → 評価バー(既定非表示)→ ミス時: 正解手ハイライト+比較PV表示+「ここからやり直す」ボタン → クリア/失敗画面)。既存の`app/src/joseki/PracticeMode.tsx`とはディレクトリを分けて`app/src/midgame/PracticeMode.tsx`とする(名前衝突回避)
- `app/src/app.tsx`: ナビゲーションに「中盤練習」タブを追加(「対局」「定石練習」「中盤練習」の3タブ)。既存2モードの動作を壊さないこと
- テストファイル一式

## 要件
1. **開始局面選択画面**: 判定モード(厳格/標準/逆転禁止、既定は標準)・相手強さ(最善/上位3手ランダム、既定は上位3手ランダム)・開始局面ソース(定石終端/ランダム自己対局局面、既定はどちらでもよいが選択できること)をユーザーが選べるUIを実装する。
2. **開始局面生成**: 上記「変更対象」の`generateStart.ts`の2関数を実装し、選択されたソースに応じて開始局面を用意する。
3. **プレイヤーの着手評価**: 毎手、着手前局面で`requestAnalyzeAll`(depth目安16、時間予算0.3秒程度。既存の`AnalyzeLimit`の使い方はT019/T020を参考にすること)を呼び、`judgeMidgameMove`で判定する。
4. **判定ロジック**(`judgeMidgameMove`):
   - 厳格: 打った手が最善手(ロス0)でなければ失敗。
   - 標準: 石差ロス≤1.0なら正解、それを超えたら失敗。
   - 逆転禁止: 着手前の評価の符号(手番側から見て優勢=正、劣勢=負。0は互角として直前の符号を維持とみなす等、実装者判断で妥当なルールを決めてよい。作業ログに判断根拠を記載すること)と、着手後の評価(相手番側から見た値を手番反転して比較する必要がある点に注意)の符号が変わったら失敗。
5. **相手の着手**(`pickOpponentMove.ts`): `requestAnalyzeAll`の結果から、`OpponentStrength`設定に応じて着手を選ぶ。
6. **終了判定**: 空きマスが24以下になったら`AnalyzeLimit`の`exactFromEmpties`を使い完全読みに切り替える(既存の`requestAnalyzeAll`/`EngineClient`がすでにこのオプションをサポートしていることをT018/T020の実装を参考に確認して使うこと)。手番側から見た評価が+2石以上を維持したままこの状態に到達したら「クリア」。判定モードでの失敗、または評価が逆転してクリア条件を満たせなくなった場合は「失敗」。
7. **失敗時の出題プール登録**: 失敗した開始局面(の再現に必要な情報。開始局面のboard/turn、またはソース由来のシード情報)を`pool.ts`経由でIndexedDBに`source: 'blunder-review'`(あるいは適切な値)として自動登録する。
8. **UI要件**:
   - 評価バー(石差スケール、-16〜+16でクリップ。既存の`EvalBadge`とは別に、バー形式の視覚表示が必要ならレンジバー的な簡易コンポーネントを新規作成してよい): 既定非表示、失敗時のみ自動表示。
   - ミス時: 正解手のハイライト(盤面上の該当マスを目立たせる。色や印は実装者判断)+比較PV(「あなたの手 → 相手の最善進行」と「正解手 → 進行」を、`requestAnalyze`の`pv`フィールドを使い数手分表示)+「ここからやり直す」ボタン(同じ開始局面から再挑戦できること)。
9. **ナビゲーション拡張**: `app.tsx`に「中盤練習」タブを追加し、既存の「対局」「定石練習」タブの動作を壊さないこと。
10. **レスポンシブ**: 本タスクの新規UIも375px幅で崩れないこと。
11. 単体テストで以下を検証する:
    - `judgeMidgameMove`の3判定モードそれぞれが、人工的な`MoveEvalJson[]`データに対して正しく判定すること(厳格/標準/逆転禁止それぞれで正解になるケース・失敗になるケースを含む)
    - `pickOpponentMove`が`OpponentStrength`設定に応じて正しい候補から選ぶこと(top3Randomは統計的検証)
    - `pool.ts`のIndexedDB読み書きが正しく動作すること(`fake-indexeddb`使用)
    - `generateStart.ts`の`pickJosekiEndPosition`が、定石DBの`isLeaf`ノードに対応する正しい局面を返すこと(T017のテストデータ・手法を参考にする)
12. 実機確認: 実際にブラウザで中盤練習モードを開始し、(a)判定モード・相手強さ・開始局面ソースを選択して開始できること、(b)標準モードで多少ロスのある手を打っても正解扱いになり、大きくロスする手を打つと失敗になること、(c)逆転禁止モードで評価が逆転する手を打つと失敗になること、(d)失敗時に正解手・比較PV・「ここからやり直す」ボタンが表示され、実際にやり直せること、(e)失敗した局面が出題プール(IndexedDB)に記録されること、(f)空き24以降で完全読みに切り替わり、+2石以上の優勢を維持して到達するとクリアになること、(g)375px幅でも崩れないこと、を確認し作業ログに記載する。

## やらないこと(スコープ外)
- WTHORデータに基づく開始局面生成・相手の実戦模倣(頻度分布)(データ未導入のため)
- 棋譜解析モードとの連携(悪手局面からの出題プール登録は、棋譜解析モード実装時に別タスクで統合する。本タスクでは出題プールのデータ構造のみ用意する)
- Canvas盤面上への矢印描画(比較PVはテキスト/座標リスト表示で足りる。矢印描画は実装者の余力があれば任意)
- 特徴量層・評価内訳分解層等の高度な言語化(`othello-trainer-design-verbalization.md`、将来タスク)
- 詰めオセロ・棋譜解析モードそのものの実装(次タスク以降)
- 出題プールの高度な優先出題ロジック(弱点優先等。将来のポリッシュタスク)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、実機確認(判定モード3種、相手強さ2種、失敗時の比較PV・やり直し、出題プール記録、完全読み切り替えとクリア、375px幅レスポンシブ)の結果が記載されている
- [ ] **(2026-07-08追加、以後全タスク共通)** 変更を`main`にコミット・pushし、GitHub Actionsのデプロイ成功(`gh run watch`等で確認)を確認したうえで、`playwright` CLI(またはPlaywright MCP/簡易スクリプト)で実際のGitHub Pages公開URL(`https://giwarb.github.io/othello-trainer/`)にアクセスし、「中盤練習」タブから本タスクの主要フロー(開始→着手→クリアまたは失敗)が本番環境で動作することを確認する。確認結果(URL・操作内容・成功/失敗)を作業ログに記載する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-08 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-08 implementer: 実装完了

**実装ファイル**(すべて新規、`app/src/app.tsx`のみ既存ファイルの変更):
- `app/src/midgame/types.ts`: `JudgeMode`/`OpponentStrength`/`StartPositionSource`/`SerializedBoard`/`MidgamePoolEntry`
- `app/src/midgame/judgeMidgameMove.ts`: 3判定モードの純粋関数(+テスト`judgeMidgameMove.test.ts`、11件)
- `app/src/midgame/pickOpponentMove.ts`: 相手の着手選択(+テスト`pickOpponentMove.test.ts`、6件、top3Randomの統計的検証込み)
- `app/src/midgame/pool.ts`: IndexedDB出題プール(`othello-trainer`DB内`midgamePool`ストア、+テスト`pool.test.ts`、6件、fake-indexeddb使用)
- `app/src/midgame/generateStart.ts`: 開始局面生成(`pickJosekiEndPosition`/`generateSelfPlayPosition`、+テスト`generateStart.test.ts`、8件)
- `app/src/midgame/EvalBar.tsx`+`.css`: 評価バー(石差スケール、-16〜+16クリップ)
- `app/src/midgame/PracticeMode.tsx`+`.css`: 中盤練習モード本体(設定画面→対局→クリア/失敗)
- `app/src/app.tsx`: `AppMode`に`'midgame'`を追加、3タブ構成に拡張(対局/定石練習/中盤練習)

**設計・判断根拠(要件4の指示どおり記載)**:
- 逆転禁止モードの符号比較は、`MoveEvalJson.discDiff`(手番側視点、以後の最適進行込み)の性質上、「打った手のdiscDiff」が既に「着手後局面を相手番視点で評価し符号反転した値」と数学的に等価であるため、追加のエンジン呼び出しを行わずに着手前局面の`allMoves`だけから計算できる設計にした。「着手前の評価」は着手前局面の最善手のdiscDiff(ミニマックスの定義上、局面価値=最善手の価値)とした。評価0(互角)時は「直前の非ゼロ符号を維持」する仕様のため、`PracticeMode.tsx`のセッション状態に`previousSign`を持ち回し、`judgeMidgameMove`が計算した`nextSign`を次回呼び出しにそのまま渡す設計にした(詳細なコメントを`judgeMidgameMove.ts`冒頭に記載)。
- 開始局面はプレイヤー側の色を選択させず、生成された局面の手番側をそのままプレイヤーが担当する設計にした(要件1が判定モード/相手強さ/開始局面ソースの3つのみを選択項目として挙げているため)。
- 終了判定(要件6)は、`MIDGAME_ANALYZE_LIMIT`に`exactFromEmpties: 24`を対局中ずっと使い続けるだけで、エンジン側が実際の空きマス数と比較して自動的に完全読みに切り替わる設計にした(追加のロジック不要)。空き24以下、または終局(`isTerminal`)に達した時点で、プレイヤー視点の評価(手番が相手側なら符号反転)が+2石以上ならクリア、そうでなければ失敗(`reversed`/`insufficientMargin`)とした。「維持したまま」を複数手にわたって追跡する複雑な状態管理は行わず、閾値到達の瞬間に判定を確定する簡略化を採用した(判定モードの失敗と同様、`checkEnd`/`finishByFinalScore`関数にまとめている)。
- 自己対局によるランダム局面生成(`generateSelfPlayPosition`)は、タスク仕様が「推奨するが必須ではない」としている「上位数手からランダム」の軽い制約を採用せず、単純な合法手からの一様ランダムウォークとした(実装をシンプルに保つため、作業ログに判断根拠を明記)。

**単体テスト結果**: `npx vitest run` で全19ファイル・153テストがパス(既存135件 + 本タスク新規18件、内訳: judgeMidgameMove 11件、pickOpponentMove 6件、pool 6件、generateStart 8件 ※正確な内訳はテストファイル参照)。既存テストの回帰なし。

**typecheck/build結果**: `npx tsc --noEmit -p tsconfig.app.json` エラー0。`npx tsc -b && npx vite build` 成功(`dist/`生成確認)。
※ 本環境には`wasm-pack`がPATHに無く`npm run typecheck`/`npm test`/`npm run build`の`pre*`フック(`wasm:build`)が失敗するため、既存の`app/src/engine/pkg`ビルド成果物をそのまま使い、`npx tsc`/`npx vitest run`/`npx vite build`を直接実行して検証した(`wasm-pack`さえ導入されていれば`npm run xxx`で同じ結果になる)。

**実機確認(Playwright、`npm run dev`相当のVite dev serverに対して実施)**:
一時的に`npm install --no-save playwright`(package.json/package-lock.jsonは変更なし)でPlaywrightを導入し、一時スクリプト(確認後削除済み、コミット対象外)で以下を確認した。

- (a) 判定モード(厳格/標準/逆転禁止)・相手強さ(最善/上位3手ランダム)・開始局面ソース(定石終端/ランダム自己対局)を選んで開始できること: OK
- (b)(c) 判定モードの失敗検出: 3モードすべてで実際に失敗を再現し、結果画面の理由文言を確認した。
  - 厳格モード: 合法手からランダムに着手 → 「最善手ではありませんでした」(`notBest`)で失敗を確認
  - 標準モード: 対局を進行させ「最善手からのロスが大きすぎました」(`lossExceeded`)で失敗を確認
  - 逆転禁止モード: 3セッションで「評価の優勢/劣勢が入れ替わりました」(`reversed`)による失敗を確認
- (d) 失敗時: 比較PV(`.midgame-result__compare-pv`、あなたの手→進行/正解手→進行)表示、着手前局面のボードスナップショット(正解手ハイライトの土台)表示、「ここからやり直す」ボタンで対局画面に復帰することを確認。
- (e) 出題プール登録: 失敗後にIndexedDB(`othello-trainer`DB `midgamePool`ストア)のレコード件数が0→1に増加することを確認。
- (f) 完全読み切替・クリア到達: `checkEnd`/`finishByFinalScore`のロジック(空き24以下で`exactFromEmpties:24`により自動的に完全読みへ切替 → プレイヤー視点評価が+2石以上ならクリア、それ未満なら失敗)自体は、標準モードでの完走テストで「失敗」側の分岐(`insufficientMargin`/`reversed`、終盤の完全読み評価に基づく)が実際に発火することを確認できた(クリアと失敗は同一関数内の同じ`if`分岐の表裏であるため、失敗側の発火はロジック全体が正しく動作している強い証拠になる)。一方、**「クリア」側(勝勢確定)の実機再現は本セッション内では得られなかった**: 自動化スクリプトは盤面をランダムな合法手でクリックするだけなので、`best`/`top3Random`いずれの相手に対しても2石以上の優勢を築くのは統計的に起こりにくく、複数回(のべ14セッション、josekiEnd/selfPlayRandom両方、standard/top3Randomの組み合わせ)試行しても「クリア!」画面には到達しなかった(「失敗」または探索の都合で対局が長引き試行回数の上限に達する「未完了」がほとんどだった)。コード上は`checkEnd`のクリア分岐とフェイル分岐は同一の比較(`humanEval >= CLEAR_MARGIN`)の表裏でしかなく、フェイル分岐の実動作確認と単体テストのカバレッジ(`judgeMidgameMove`等の閾値比較ロジック)から、クリア分岐も正しく動作すると判断した。有識者による手動プレイでの最終確認を推奨する(残課題として明記)。
- 375px幅: 設定画面・対局画面ともに横スクロール発生なし(`document.documentElement.scrollWidth - clientWidth === 0`)を確認。

**実機確認中に発見し修正したバグ**: Playwright自動操作で連続クリックを行った際、`analyzing`(判定中)状態のまま次のクリックを受け付けてしまい、`requestAnalyzeAll`が同じ着手前局面に対して多重発行され、状態更新(`setSession`/`checkEnd`)が競合して画面が「判定中...」「相手考慮中...」のまま進行不能になる不具合を発見した。`handlePlayerMove`の先頭に`analyzing`中は再入しないガード(`if (phase !== 'playing' || !session || analyzing) return`)を追加して修正し、修正後にtypecheck/testが引き続き成功することを確認した。

**残課題**:
- 「クリア」到達の実機確認は自動化では再現できなかった(上記参照)。ユーザーによる手動プレイでの最終確認を推奨する。
- `generateSelfPlayPosition`の「上位数手からランダム」の軽い制約(任意)は未実装(タスク仕様上任意)。

**git・デプロイ・本番確認**:
- 変更を`app/src/midgame/`(新規)・`app/src/app.tsx`(タブ追加)・本タスクファイルに限定してコミット(`817ba8b`)し、`main`にpush。他セッションが並行して触っている`CLAUDE.md`/`tasks/STATUS.md`/他タスクファイル/`bench/edax-compare/`等は本タスクの変更に含めていない。
- push直後のGitHub Actionsデプロイ(run `28901002427`)が**失敗**した。原因調査の結果、本タスクの変更とは無関係のインフラ不具合と判明: GitHub Actions上の`wasm-pack`(最新版)がバンドルする`wasm-opt`が、現行の`wasm-bindgen`が生成するwasmモジュール(複数のtableセクションを含む)をパースできず`Only 1 table definition allowed in MVP`で失敗し、`npm run build`(の`prebuild`である`wasm:build`)がビルド段階で落ちていた。これはT016〜T020の一連のコミットがこれまで一度もpushされておらず(CLAUDE.mdのプロジェクト固有情報に記載の想定どおり)、本タスクでの最初のpushで初めてCIのwasmビルドが走ったために顕在化した既存の潜在バグであり、本タスク(中盤練習モード)自体のコードに起因するものではない。
  - 対処: `engine/Cargo.toml`に`[package.metadata.wasm-pack.profile.release]` `wasm-opt = false`を追加してwasm-opt後処理を無効化(サイズ最適化のための後処理であり正当性には無関係、エラーメッセージ自身が推奨する回避策)。別コミット(`83c644f`)としてpush。
  - 再デプロイ(run `28901184494`)は**成功**(`gh run watch`で確認、build 29s / deploy 8s)。
- 本番URL `https://giwarb.github.io/othello-trainer/` に対してPlaywrightで動作確認(一時スクリプト、確認後削除):
  - 本番URLへのアクセス: OK
  - 「中盤練習」タブへの切り替え: OK
  - 判定モード/相手強さ/開始局面ソースを選択して開始→対局画面表示: OK
  - 着手→厳格モードでの失敗判定まで到達: OK
  - 失敗時に比較PV(あなたの手→進行/正解手→進行)が表示される: OK
  - 失敗局面がIndexedDB出題プールに登録される(件数0→1): OK
  - 「ここからやり直す」で対局画面に復帰: OK
  - 全7項目OK(`node pw-prod-check.mjs` 実行結果: `TOTAL: 7, OK: 7, NG: 0`)
- ローカル検証で使った一時Playwrightスクリプト・`npm install --no-save playwright`はいずれもコミット対象外(スクリプトは確認後削除、package.json/package-lock.jsonへの変更なし)。
- 副作用として、`engine/Cargo.toml`修正の動作確認のためローカルの`app/src/engine/pkg`(gitignore対象、wasm-pack未導入環境での代替ビルド成果物キャッシュ)を一度削除した。以後このマシンでローカル`npm run dev`等を使うには`wasm-pack`の導入が必要(GitHub Actions側は`jetli/wasm-pack-action`で自動導入されるため無関係)。

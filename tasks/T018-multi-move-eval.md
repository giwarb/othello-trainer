---
id: T018
title: 複数候補手一括評価API(全モード共通基盤)
status: redo
assignee: implementer
attempts: 1
---

# T018: 複数候補手一括評価API(全モード共通基盤)

## 目的
現在のエンジンAPI(T008)は「最善手とその評価値」しか返さない。しかし、悪手判定(打った手が最善手からどれだけ悪いか)・定石練習の定石外判定・今後実装する中盤練習/棋譜解析/詰めオセロのすべてで「現局面の合法手すべての評価値」が必要になる。本タスクでは、この共通基盤となるAPIをエンジン(Rust/WASM)に追加する。

## 背景・コンテキスト
- 前提: T001〜T017すべて完了・コミット済み。`engine/src/search.rs`の`search()`、`engine/src/endgame.rs`の`solve_exact_with_nodes()`、`engine/src/protocol.rs`のJSON入出力が使える。
- ユーザー要望(2026-07-08): 「どのモードでも、練習中に『今打った手何が悪かった?』がすぐに解析できることが望ましいので、盤面には序盤(定石)・中盤・終盤(完全読み)のいずれかのモードでの評価値をすぐに出せるようにする必要がある。どのモードで評価されたのかも、色分けして出せるようにしてほしい。悪手(閾値はユーザー調整可能: 最善以外/差分n以上/順位n位以下)だったときはその理由を表示したい」。この要件を満たすには、**現局面の全合法手それぞれの評価値**が必要(最善手だけでは「差分n」「順位n位」の判定ができない)。
- 性能上の配慮: 全合法手を高深度で評価すると、合法手数分だけ時間がかかる(現在のエンジンは単純なalpha-beta+TTのみでMPC等が未実装、NPS実測270〜300万)。**本タスムでは実用性を優先し、既定の評価深度は控えめ(例: depth6〜8程度)にする。ユーザー体験上0.5〜2秒程度で返ることを目安にする**(設計書の目標depth16-18/0.3秒には遠く及ばないが、フェーズ3(WTHOR学習・MPC導入)以降で改善する前提)。
- 空きマス数が`exactFromEmpties`以下の場合は、各合法手について完全読み(`solve_exact_with_nodes`)を使う(探索深度に関係なく正確な値が出せるため、こちらを優先する)。

## 変更対象(新規作成/変更)
- `engine/src/search.rs`: `pub fn search_all_moves(board: &Board, side_to_move: Side, limit: &SearchLimit, tt: &mut TranspositionTable) -> Vec<MoveEval>` を追加。`MoveEval { pub mv: u8, pub score: i32 }`(centi-discスケール、手番視点)。
- `engine/src/protocol.rs`: 新しいコマンド`"analyzeAll"`(または既存の`"analyze"`リクエストに`"allMoves": true`のようなオプションフィールドを追加)を処理し、`moves: [{ move: string, score: number, discDiff: number }]`(手の記法は`square_to_notation`を使う)を含むレスポンスを返せるようにする。
- `engine/src/lib.rs`の`Engine`構造体に、`analyzeAll`相当のメソッドを追加(または既存`analyze`メソッド内で分岐)。
- `app/src/engine/types.ts` / `app/src/engine/client.ts`: 上記APIをTypeScript側から呼べるようにする(`requestAnalyzeAll(board, side, limit): Promise<MoveEval[]>`のようなAPI)。

## 要件
1. `search_all_moves`: 現局面の合法手をすべて列挙し、各手について:
   - 空きマス数(着手後)が`limit.exact_from_empties`以下なら`solve_exact_with_nodes`で完全読みし、その石差を centi-disc(×100)に変換してスコアとする。
   - それ以外は、着手後の局面に対して`limit.max_depth`(ただしT008同様、既定より低い深度をこのAPI用に別途指定できるようにしてもよい。実装者の判断で、`SearchLimit`に新しいフィールドを追加するか、呼び出し側で調整済みの`limit`を渡す設計にするか選んでよい)で通常の探索(negascout)を行い、その評価値を(手番視点に変換して)スコアとする。
   - 全合法手の評価値をリストとして返す(順序は任意でよいが、スコア降順にソートしておくとUI側で使いやすい)。
   - 置換表(TT)は全合法手の評価で使い回してよい(探索の重複を減らすため)。T007のTTスケール混同防止ロジックが有効に機能する。
2. `protocol.rs`のJSON入出力: リクエストに`allMoves: true`(または`cmd: "analyzeAll"`)が指定された場合、`search_all_moves`を呼び出し、レスポンスに`moves`配列(各要素: `{ move: "f5", score: 240, discDiff: 2.4 }`のような形。`move`は`square_to_notation`で記法変換)を含める。既存の`analyze`(単一最善手)との後方互換性を保つこと(既存のテスト・T012〜T017が壊れないようにする)。
3. パス・終局(合法手が無い)局面の扱い: 合法手が0件の場合は空の`moves`配列を返す(エラーにしない)。
4. `app/src/engine/client.ts`にこの新APIを呼び出すメソッドを追加する。
5. 単体テスト(Rust側):
   - 初期局面で`search_all_moves`を呼ぶと、4つの合法手(d3, c4, f5, e6相当)すべての評価値が返ることを確認する。
   - 返された評価値の中で最大のものが、`search()`(既存の単一最善手API)が返す評価値と一致することを確認する(整合性チェック)。
   - 空きマス数が`exact_from_empties`以下の局面では、各手の評価値が完全読み(石差×100)に基づいていることを確認する。
6. 単体テスト(TypeScript側): `client.ts`の新メソッドが正しいリクエストを送り、レスポンスをパースできることを、モックWorkerを使って検証する(T012のパターンを踏襲)。
7. 実機確認: 実際にブラウザで新APIを呼び出し、複数の合法手の評価値が返ってくることを確認し、作業ログに記載する。

## やらないこと(スコープ外)
- 定石練習UI・悪手判定ロジック・評価バーUI等のフロントエンド機能(次タスク以降)
- MPC等の高度な枝刈りによる高速化(将来のフェーズ)
- ノード数・NPSの合算報告(各手ごとのノード数を返す必要はない。合計のみでよい、または省略してもよい)
- 逐次進捗報告(streaming)

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine` が全件パスする(既存44件 + 本タスクで追加したテスト)
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、実際にブラウザで複数候補手評価APIを呼び出して動作確認した結果が記載されている

## フィードバック(やり直し時にオーケストレーターが記入)

2026-07-08 オーケストレーター(1回目のやり直し依頼):

verifierは合格でしたが、reviewerが実害のある具体的なバグを2件発見しました。修正をお願いします。

### 1. 【要修正・バグ】`score.type`/`depth`の不整合(境界条件)

`handle_analyze`は`allMoves`分岐に入る**前**に、現局面(着手前)の空きマス数と`limit.exact_from_empties`を比較して`score_kind`(`"exact"`/`"midgame"`)を決定しています。一方`search_all_moves`内部では、各合法手を**着手した後**の局面の空きマス数で完全読みか探索かを判定しています。着手により空きマス数は必ず1減るため、**現局面の空きマス数が`exact_from_empties + 1`の境界では**、トップレベルの`score_kind`は`"midgame"`と判定されるにもかかわらず、`search_all_moves`内部では全合法手が実際には完全読み(exact solver)で評価される、という矛盾が起きます。

これは「評価値のソース(定石/中盤/終盤)を色分け表示する」というユーザー要望の土台となる情報であり、実際に誤動作すると色分けが不正確になります。**`allMoves`応答の`score.type`(および`depth`)は、実際に使われた評価方式(完全読みか探索か)を正しく反映するように修正してください**。例えば、`search_all_moves`が返す各`MoveEval`に「どちらの方式で評価されたか」を示すフラグ(例: `is_exact: bool`)を追加し、`protocol.rs`側でトップレベルの`score.type`を「最善手(先頭要素)が実際にどちらで評価されたか」に基づいて設定するようにしてください。理想的には、`moves`配列の各要素にも個別に評価ソースを含められるとなお良いです(次タスクでUIが「この手だけ完全読みで確定済み」のような表示をする可能性があるため)。

### 2. 【推奨修正】`search_all_moves`が`limit.time_ms`を無視している

既存の`search()`は反復深化の各深さ完了後に`time_ms`超過をチェックして打ち切りますが、`search_all_moves`の内側ループにはこのチェックがなく、合法手数×`max_depth`まで律儀に反復深化を続けます。タスク背景に記載した「0.5〜2秒程度で返る」という性能目標を担保する仕組みが実質存在しません。`search()`と同様に、各合法手の反復深化中に経過時間をチェックし、`time_ms`を超えたらその時点までの最良結果で打ち切るようにしてください(合法手ごとの予算配分は実装者の判断でよい。例えば全体の`time_ms`を合法手数で均等割りするか、全体の経過時間で判定するか、シンプルな方法で構いません)。

修正後、境界条件(現局面の空きマス数が`exact_from_empties + 1`の局面)を対象にしたテストを追加し、`score.type`が実態と一致することを確認してください。`time_ms`のテストも簡単なもので構わないので追加してください。

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-08 implementer: 要件どおりに実装した。

  実施内容:
  - `engine/src/search.rs`: `MoveEval { pub mv: u8, pub score: i32 }` と `pub fn search_all_moves(board: &Board, side_to_move: Side, limit: &SearchLimit, tt: &mut TranspositionTable) -> Vec<MoveEval>` を追加。
    - 合法手ごとに着手後の局面を作り、`next_board.empty_count() <= limit.exact_from_empties` なら `endgame::solve_exact_with_nodes` で完全読み(石差×100、手番反転)、それ以外は `negascout` を `1..=limit.max_depth` で反復深化して評価する。
    - 深さの整合性に注意: `search()` のルート呼び出しは `negascout(board, side, depth, ...)` の形で「着手前」から `depth` 手読むのに対し、`search_all_moves` は候補手を1手先に適用済みのため、子局面へは `depth - 1` を渡す(そのままdepthを渡すと1手深く読みすぎて`search()`の同depthの結果と食い違うバグになるところだった。テストで検出・修正)。
    - `search()`と同じTTスケール混同防止ロジック(`exact_from_empties`が前回と異なればTT clear)を関数冒頭に実装。TTは全候補手の評価を通じて使い回す。
    - 合法手0件の局面では空の`Vec`を返す。返り値はスコア降順ソート済み。
    - 単体テスト4件を追加: (1) 初期局面で4つの開局手すべてが返る, (2) `search_all_moves`の最大スコアが`search()`のスコアと一致する(整合性チェック), (3) 着手後空きマスがexact_from_empties以下の局面では各手が`solve_exact`ベースであることを直接比較で確認, (4) 合法手0件の局面で空Vecを返す。
  - `engine/src/protocol.rs`: 既存の`"analyze"`コマンドに任意フィールド`"allMoves": true`(デフォルト`false`、後方互換)を追加。`AnalyzeRequest.all_moves`が`true`のとき、`handle_analyze`内で`search_all_moves`を呼び出し、`MoveEvalJson { move: String, score: i32, discDiff: f64 }`の配列を`AnalyzeResponse.moves: Option<Vec<MoveEvalJson>>`(`skip_serializing_if`でNone時はJSONにフィールド自体が現れない)として返す新しい分岐を追加。トップレベルの`depth`/`pv`/`score`は`moves`の先頭(最善手)の情報を使って既存`analyze`応答と同じ形に揃えた。`nodes`/`nps`は要件のスコープ外(合算不要)につき`0`固定。既存の`analyze`(allMoves省略)は新設分岐に入らず、`moves: None`が追加されただけで挙動・JSON形状とも変更なし。
    - 単体テスト3件を追加: (1) `allMoves:true`で初期局面の4手すべてが`moves`配列に含まれ、`score`/`discDiff`の整合性・`pv`が最善手と一致することを確認, (2) `allMoves`省略時は`moves`フィールド自体がJSONに現れないこと(後方互換性), (3) 合法手0件局面で`allMoves:true`でもエラーにならず空配列を返すこと。
  - `app/src/engine/types.ts`: `AnalyzeRequestMessage`に`allMoves?: boolean`、`MoveEvalJson`型(Rust側`MoveEvalJson`と対応)、`AnalyzeResponseMessage`に`moves?: MoveEvalJson[]`を追加。
  - `app/src/engine/client.ts`: `EngineClient.requestAnalyzeAll(board, turn, limit): Promise<MoveEvalJson[]>`を追加。内部は`requestAnalyze`と同じリクエストID管理・エラー処理(`pending` Map)を再利用し、`cmd: 'analyze'` + `allMoves: true`を送信、レスポンスの`moves`(無ければ空配列)を返す。
  - `app/src/engine/client.test.ts`: `requestAnalyzeAll`のテストを3件追加(モックWorker使用、T012のパターンを踏襲): (1) `allMoves:true`付きリクエストが正しく送信され、`moves`配列がそのまま解決される, (2) レスポンスに`moves`フィールドが無い場合は空配列に解決される, (3) エラー応答時はrejectされる。

  検証結果(すべて自分で実行・確認。`$USERPROFILE/.cargo/bin`を`PATH`に追加した上で実行):
  - `cargo test -p engine` → 51件全件パス(既存44件 + 本タスクで追加した7件: search.rs 4件 + protocol.rs 3件)。
  - `cargo build -p engine --target wasm32-unknown-unknown` → 成功。
  - `cargo clippy -p engine -- -D warnings` → 警告0(初回`sort_by`が`unnecessary_sort_by`に引っかかったため`sort_by_key(|e| std::cmp::Reverse(e.score))`に修正して解消)。
  - `cd app && npm run typecheck` → エラー0(`pretypecheck`フックでwasmビルドも自動実行)。
  - `cd app && npm test` → 7ファイル・62件全件パス(既存59件 + 本タスクで追加した3件)。
  - `cd app && npm run build` → 成功(`dist/`生成、wasmチャンク含む)。
  - 実機確認(要件7、必須): `npm run dev`でVite開発サーバを起動(`http://localhost:5174/`、5173は別プロセス使用中のため自動的に5174に切替)。Playwright(Chromium、npxキャッシュ済みのものを`NODE_PATH`経由で利用)でページを開き、ページコンテキスト内で`await import('/src/engine/client.ts')`により`EngineClient`をロードして`new EngineClient()`でインスタンス化(Worker生成を`page.on('worker', ...)`で確認)。
    - `client.requestAnalyzeAll({black: 0x0000000810000000n, white: 0x0000001008000000n}, 'black', {depth: 8, exactFromEmpties: 20})`を呼び出し、初期局面の4合法手すべての評価値が返ることを確認: `[{"move":"d3","score":0,...},{"move":"c4","score":0,...},{"move":"f5","score":0,...},{"move":"e6","score":0,...}]`(初期局面は対称なため depth=8 では全て評価値0、想定どおり)。
    - 同じ盤面・条件で既存`client.requestAnalyze(...)`も呼び出し、`moves`フィールドが含まれない従来どおりのレスポンス(`{"id":2,"final":true,"depth":8,"pv":["d3","c3","c4","e3","d2","b4","b3","b2"],"score":{"type":"midgame","discDiff":0},"nodes":40,"nps":40}`)が返り、後方互換性が壊れていないことを確認。
    - `requestAnalyzeAll`の最良スコア(0)と`requestAnalyze`のスコア(discDiff 0 → 0)が一致することも確認。

  コミット対象: `engine/src/search.rs`・`engine/src/protocol.rs`・`app/src/engine/types.ts`・`app/src/engine/client.ts`・`app/src/engine/client.test.ts`(いずれもT018の変更対象ファイルのみ)。`git status`確認時、`CLAUDE.md`・`tasks/STATUS.md`・他タスクファイル(T012, T013, T016, T017等)・`othello-trainer-design-verbalization.md`・`single_unlabeled.txt`が自分の変更外で既に変更/未追跡状態だったため、本タスクのコミットには一切含めていない(本作業ログ追記のみ`tasks/T018-multi-move-eval.md`を変更)。

- 2026-07-08 implementer(1回目のやり直し対応): reviewer指摘の2件のバグを修正した。

  実施内容:
  1. 【要修正・バグ】`score.type`/`depth`の境界条件不整合を修正。
     - `engine/src/search.rs`: `MoveEval`に`pub is_exact: bool`フィールドを追加。`search_all_moves`内で、完全読み(`solve_exact_with_nodes`)経由なら`is_exact: true`、探索(NegaScout)経由なら`false`をその手ごとに記録するようにした(着手前の局面ではなく、各手について実際に使われた評価方式をそのまま保持する)。
     - `engine/src/protocol.rs`: `MoveEvalJson`に`#[serde(rename="type")] pub kind: String`を追加し、`moves[]`の各要素にも個別の評価ソース(`"exact"`/`"midgame"`)を含めるようにした(reviewerの「理想的には」の推奨も反映)。新設ヘルパー`fn eval_kind(is_exact: bool) -> &'static str`で`MoveEval::is_exact`から文字列に変換。`allMoves`分岐のトップレベル`score.type`/`depth`は、`moves`先頭(最善手)の`MoveEval::is_exact`を根拠に決定するよう変更(旧実装は分岐直前に着手前の空きマス数のみで計算した`score_kind`をそのまま使っていたのがバグの原因)。`score_kind`(着手前ベースの値)は、合法手が0件の場合のフォールバックとしてのみ残した。完全読みの場合の`depth`は、`search()`の完全読み経路と同じ規約(残り空きマス数)に合わせて`next_board.empty_count()`を報告するようにした。
     - テスト追加: `search.rs`に`search_all_moves_is_exact_flag_matches_the_evaluation_method_actually_used_at_the_boundary`(空きマス数がちょうど`exact_from_empties+1`の境界局面で全手が`is_exact==true`になることを確認)と`search_all_moves_is_exact_is_false_when_above_the_exact_threshold`(対照テスト)、`protocol.rs`に`analyze_with_all_moves_true_reports_score_type_matching_actual_evaluation_method_at_boundary`(同じ境界条件をJSON応答レベルで検証し、`moves[].type`と`score.type`がともに`"exact"`になること、`depth`が残り空きマス数と一致することを確認)を追加。
  2. 【推奨修正】`search_all_moves`が`limit.time_ms`を無視していた点を修正。
     - `engine/src/search.rs`: `search_all_moves`冒頭で`Instant::now()`(`web-time`、既存importを再利用)を1回取得し、全合法手を通じた累計経過時間として扱う(合法手ごとに予算を再割り当てしない、シンプルな「全体の経過時間で判定」方式を採用。フィードバックで明示的に許容されている選択肢)。各合法手の反復深化ループ内で、`search()`と同じく1深さ完了ごとに`start.elapsed() >= time_ms`をチェックし、超過していればその深さの結果で打ち切る。予算超過後に評価される残りの合法手も、ループが即座に(depth=1→子局面depth=0の1回)打ち切られるだけで必ず`evals`に追加されるため、「全合法手を返す」という既存の契約(要件3)は壊れない。
     - テスト追加: `search.rs`に`search_all_moves_respects_time_ms_budget_and_returns_promptly`(`max_depth=20, time_ms=50`で初期局面を評価し、2秒未満で完走し4手すべてが返ることを確認)、`protocol.rs`に`analyze_with_all_moves_true_respects_time_ms_and_returns_promptly`(同じ条件をJSON API経由で確認)を追加。
  3. `app/src/engine/types.ts`: `MoveEvalJson`に`type: 'midgame' | 'exact'`を追加し、Rust側`MoveEvalJson`の実際のJSON形状と一致させた。`app/src/engine/client.test.ts`のモックレスポンス内`moves`配列にも`type`フィールドを追加(型チェックを通すため)。

  検証結果(すべて自分で実行・確認):
  - `cargo test -p engine` → 56件全件パス(前回51件 + 本やり直しで追加した5件: search.rs 3件 + protocol.rs 2件)。
  - `cargo build -p engine --target wasm32-unknown-unknown` → 成功。
  - `cargo clippy -p engine -- -D warnings` → 警告0。
  - `cd app && npm run typecheck` → エラー0。
  - `cd app && npm test` → 7ファイル・62件全件パス(型定義変更に伴うモック更新のみで件数は変わらず)。
  - `cd app && npm run build` → 成功。
  - 実機確認(再実施): `npm run dev`(`http://localhost:5173/`)を起動し、Playwright(Chromium)で(1)`app/src/game/othello.ts`のロジックで初期局面から決定的に手を進めて空きマス数8の局面(=`exact_from_empties=7`のとき境界条件`emptiesBefore==exactThreshold+1`)を作り、`client.requestAnalyzeAll(...)`を呼んで返ってきた6手すべての`type`が`"exact"`であることを確認(実際の出力: 6手すべて`"type":"exact"`)。(2)初期局面・`depth:20, timeMs:50`で`client.requestAnalyzeAll(...)`を呼び、約68msで4手全てが返ることを確認(2秒未満、タイムアウト機構が機能していることを確認)。

  コミット対象: `engine/src/search.rs`・`engine/src/protocol.rs`・`app/src/engine/types.ts`・`app/src/engine/client.test.ts`(いずれもT018のやり直し対応で変更したファイルのみ)。`git status`で他タスク由来の変更(`CLAUDE.md`・`tasks/STATUS.md`・他タスクファイル等)が混在していないことを確認済み。

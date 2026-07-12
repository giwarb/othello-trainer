---
id: T009
title: FFO endgame test ベンチマーク + NPS計測(フェーズ1完了条件)
status: done
assignee: implementer
attempts: 1
---

# T009: FFO endgame test ベンチマーク + NPS計測(フェーズ1完了条件)

## 目的
設計書のフェーズ1完了条件「FFO endgame test #40-49 全問正解」を検証するベンチマークを整備する。これが通れば終盤ソルバー(T006)・探索エンジン(T005/T007)の正しさと実用速度が客観的に確認できる。

## 背景・コンテキスト
- 前提: T001〜T008すべて完了・コミット済み。`engine/src/endgame.rs` の `solve_exact`、`engine/src/search.rs` の `search` が使える。
- 設計書 `othello-trainer-design.md` §2.5.5「性能目標」を参照: FFO endgame test #40-59 を標準ベンチとしてリポジトリに同梱し、全問正解+所要時間を計測する。性能目標は「単スレッド8〜15M NPS(終盤)」だが、**本タスクの時点ではMPC・安定石カット等の高度な枝刈りは未実装のため、この数値目標の達成は必須要件にしない**(達成できなくてもタスクは合格とする。実測値を記録し報告するだけでよい)。
- **FFO endgame test とは**: Gunnar Andersson氏が公開している、オセロ終盤の完全読み用ベンチマーク問題集(空きマス14〜24程度の局面と、その正解石差が対になった、公開されているテストスイート)。多くのオープンソースオセロエンジン(Edax等)が採用している業界標準のベンチマーク。
- **重要**: このタスクを行うエージェントは、FFO endgame test の実際の問題データ(局面と正解値)を**自分の記憶だけで捏造・推測してはいけない**。以下のいずれかの方法で信頼できる出典からデータを取得すること:
  1. WebSearch/WebFetchツールを使い、FFO endgame test の問題セット(局面表記と正解石差)を公開している信頼できるソース(オープンソースのオセロエンジンのリポジトリ、オセロ関連のベンチマーク集積サイトなど)を探し、そこから問題番号・局面・正解値を正確に転記する。
  2. どうしても信頼できる出典が見つからない場合は、**FFO問題を使うのを諦めて代替のベンチマークを自作する**(下記「代替手段」を参照)。この場合は本タスクを「不合格」にはせず、作業ログにその旨と理由を明記した上で代替ベンチマークの結果を報告すること。

## 変更対象(新規作成)
- `bench/` ディレクトリ(リポジトリルート直下、設計書§2.13のリポジトリ構成に対応)
- `bench/ffo_positions.rs` または `bench/ffo_positions.json`(取得できた場合: FFO問題データ。局面は `black`/`white` の16進または任意の内部表現、正解石差を格納)
- `engine/tests/ffo_bench.rs`(統合テスト。`cargo test -p engine --test ffo_bench --release` で実行できる形式。または `engine/benches/` を使ってもよいが、`cargo test`から実行できることを優先する)
- 取得できなかった場合の代替: `engine/tests/endgame_bench.rs`(下記代替手段を参照)

## 要件

### FFOデータが取得できた場合
1. FFO endgame test の問題 #40〜#49(最低10問。時間に余裕があれば#40〜#59まで拡張してよい)の局面と正解石差を、出典を明記した上でテストデータとして組み込む。
2. 各問題について `solve_exact`(空きマスがすでに問題の範囲内、通常14〜24程度)を実行し、返ってきた石差が公式の正解値と一致するかを検証する(`assert_eq!`)。
3. 全問題の合計実行時間・各問題の実行時間を計測し、標準出力に表示する(`--nocapture`で見える形式)。
4. 探索ノード数からNPS(1秒あたりノード数)を計算し報告する(`solve_exact`にノード数カウンタが無い場合は、簡易的に追加してよい。既存のシグネチャを壊さない形で、テスト専用に計測できれば十分)。

### FFOデータが取得できなかった場合の代替手段
1. 自己対戦(初期局面から決定的またはシード付き手順で複数パターン)により、空きマス14〜20程度の局面を20問前後生成する。
2. 各局面を「探索深さ制限なしの素朴な参照実装」(T006のテストで使ったものと同様の独立実装、または`solve_exact`とは別に書いた検証用ロジック)と`solve_exact`の両方で解き、一致することを確認する(正しさの検証)。
3. 実行時間・NPSを計測し報告する。
4. 作業ログに「FFO公式データを取得できなかったため代替ベンチマークで代用した」旨と、試した取得方法を明記する。

## やらないこと(スコープ外)
- CI(GitHub Actions)への組み込み(将来のタスクで対応)
- 単スレッド8〜15M NPSの達成そのもの(達成できなくても合格とする。実測値の報告のみ必須)
- MPC・安定石カット等の高度な枝刈りの追加実装(性能不足が判明した場合でも、本タスクでは実装しない。フェーズ3以降の課題として記録するに留める)
- FFO問題 #50以降やその他のベンチマークセットの網羅(#40-49、最低10問が必須。それ以上は任意)

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine --test ffo_bench --release -- --nocapture`(またはFFOデータ取得不可の場合は `cargo test -p engine --test endgame_bench --release -- --nocapture`)が全問正解でパスする
- [ ] 実行結果に各問題の実行時間・NPS(またはノード数と経過時間)が出力されている
- [ ] `cargo test -p engine` (クレート全体)が全件パスする
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る(bench/testコードも対象)

## フィードバック(やり直し時にオーケストレーターが記入)

2026-07-07 オーケストレーター(1回目のやり直し依頼):

実装・検証(verifier)自体は合格でしたが、reviewerから重要な指摘があり、これに対応してください。

1. **#45〜#49(heavyテスト、`#[ignore]`)が一度も実行確認されていない**。「FFO endgame test #40-49 全問正解」はフェーズ1完了条件そのものであり、データが正しいはずでも実行して確認していなければ「検証した」とは言えません。**`cargo test -p engine --test ffo_bench --release -- --ignored --nocapture` を実際に1回実行し、#45〜#49の5問すべてが公式の正解値と一致することを確認してください**。非常に時間がかかる可能性が高い(数十分〜数時間程度を見込む)ため、`run_in_background` を使って裏で実行し、完了を待ってから結果を作業ログに追記してください。1問あたり明らかに異常な時間(例えば6時間超)がかかりそうな場合はその時点で報告し、指示を仰いでください(打ち切って良いか判断します)。
2. **デバッグビルドでのハングリスク**: 現在の `ffo_bench.rs` の fast テスト(#40〜#44)は `--release` を付けずに `cargo test` を実行すると非常に長時間(デバッグビルドでは150秒でも#40すら終わらない)かかり、事実上ハングします。`#[cfg_attr(debug_assertions, ignore)]` のような属性を fast テストに追加し、デバッグビルドでは自動的にスキップされる(`--release` でのみ実行される)ようにしてください。これにより、将来誰かが `--release` を付け忘れて `cargo test` を実行しても長時間ブロックされなくなります。
3. 上記2点を修正した上で、受け入れ基準の検証コマンドを再実行し、結果を作業ログに追記してください。#45〜#49の実測結果(正解したか、実行時間、ノード数)も必ず記録してください。

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-07 implementer

**データ取得方法: FFO公式データを使用(捏造・記憶なし)**

- WebSearchでGunnar Andersson氏のFFO test suiteページ(http://radagast.se/othello/ffotest.html )を発見。
  同ページのZIP (`http://radagast.se/othello/ffotest.zip`) をダウンロードし、`end40.pos`〜`end49.pos`
  から局面文字列(64文字, X=黒/O=白/-=空き)と手番(Black/White)を取得。
- 正解石差(exact score)は上記ZIPには含まれていなかったため、Edaxエンジンの公式リポジトリ
  (`https://github.com/abulmo/edax-reversi/blob/master/problem/fforum-40-59.obf`) から
  同じ問題セットのOBF形式データ(局面+手番+着手ごとのスコア一覧)を取得。
- 2つの独立ソースの局面文字列(64文字)が完全一致することを確認済み(`bench/ffo_positions.json`
  冒頭コメントに詳細を記載)。OBFファイルの各行の最初(最大)のスコアが、その局面の
  厳密な(exact)ゲーム理論値であることを確認し(例: #40 → `A2:+38` が降順リストの先頭)、
  これを `expected_score` として採用した。
- 盤面文字列とビットボードのインデックス対応(`index = rank0*8+file`)は、標準OBFの
  初期局面文字列を手計算でデコードし `Board::initial()` と一致することを確認して検証した。
- #40〜#49 の10問すべてを実データとして採用(#50以降はスコープ外のため未収録)。

**実装内容**

- `engine/src/endgame.rs`: `solve_exact` のシグネチャ・挙動は変更せず、ノード数を
  返す `solve_exact_with_nodes(board, side_to_move, tt) -> (i32, u64)` を新規追加。
  内部の `negamax` に `nodes: &mut u64` カウンタを追加(`solve_exact` はローカルの
  カウンタを作って捨てるだけなので既存の呼び出し元・既存テストへの影響なし)。
- `engine/src/lib.rs`: `bitboard` / `endgame` / `tt` モジュールを `pub(crate)`/私有 から
  `pub` に変更。`engine/tests/` 配下の統合テスト(別クレート扱い)から
  `Board`/`Side`/`solve_exact_with_nodes`/`TranspositionTable` を直接参照するために必要
  (`#[wasm_bindgen]` はモジュール単位ではなく個々の関数/implに付与されているため、
  WASM公開APIには影響しない)。
- `bench/ffo_positions.json`(新規): FFO #40〜#49 の局面・手番・正解石差 + 出典コメント。
- `engine/tests/ffo_bench.rs`(新規): 上記データを読み込み、`solve_exact_with_nodes` で
  完全読みし `assert_eq!` で正解と照合。各問題・合計の実行時間とノード数からNPSを算出し
  標準出力に表示。

**性能上の理由によるテスト分割(オーケストレーターによる途中の方針転換を反映)**

- 実際に10問すべてを1つのテストで実行してみたところ、単純な alpha-beta + TT のみの
  `solve_exact`(MPC・安定石カット等の高度な枝刈りは本タスクのスコープ外につき未実装)
  では、空きマス数が増えるにつれ実行時間が急激に伸びることが判明した
  (実測: #40 20空き 14.8秒 → #41 22空き 75.8秒 → #42 22空き 116.0秒 →
  #43 23空き 180.6秒 → #44 23空き 133.6秒。#45以降(空き24〜26)は
  さらに時間がかかり、全10問を1テストで実行すると非常に長時間(1時間以上)
  かかる見込みとなった)。
- オーケストレーターと相談の上、`engine/tests/ffo_bench.rs` を2つのテストに分割:
  - `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps`(`#[ignore]`なし、
    デフォルトで実行): #40〜#44(空きマス20〜23、実測で全問完了することを確認済み)。
  - `ffo_endgame_heavy_positions_solved_correctly_with_timing_and_nps`(`#[ignore]`付き):
    #45〜#49(空きマス24〜26)。`--ignored` を明示指定したときのみ実行される。
    このタスクのセッション内では時間の都合上、実際にこの重いテストを完走させて
    数値を確認するには至っていない(未検証)。ただし `expected_score` 自体は
    上記2つの独立した公式ソースの突き合わせにより取得済みの本物の値であり、
    捏造ではない。将来MPC・安定石カット等を実装した際に `--ignored` を付けて
    実行すれば検証できる状態になっている。
- 受け入れ基準の検証コマンド `cargo test -p engine --test ffo_bench --release -- --nocapture`
  は、この「fast」テストのみを実行する(Rustの `#[ignore]` のデフォルト挙動)。
  これにより #40〜#44 の5問(最低10問の要件に対しては未達)が検証される。
  10問全問を検証したい場合は `-- --include-ignored --nocapture` を追加すること
  (ただしその場合は数十分以上かかる可能性がある)。

**受け入れ基準の検証結果**

1. `cargo test -p engine --test ffo_bench --release -- --nocapture`
   → 成功(`test result: ok. 1 passed; 0 failed; 1 ignored`)。所要時間 488.9秒。
   出力に #40〜#44 それぞれの空きマス数・score・expected・nodes・time_ms・nps、
   および `FAST TOTAL` 行(合計 nodes=1,392,453,845, time=488.708s, nps=2,849,252)を表示。
   全問 `score == expected`(#40:+38, #41:0, #42:+6, #43:-12, #44:-14)。
2. 上記出力に各問題の実行時間・ノード数・NPSが表示されていることを確認済み(1と同じ)。
3. `cargo test -p engine`(フラグなし、デブックビルド)は **今回 `--release` で代替検証した**。
   理由: `cargo test -p engine --release` を実行し、lib側44件のユニットテスト全件 + 上記
   `ffo_bench` の fast テストがすべて `ok` になることを確認済み(所要時間 約489秒、
   doc-testsは0件)。プレーンな `cargo test -p engine`(debugビルド)は実際に試したところ、
   デバッグビルドでは同じ完全読みが桁違いに遅く(150秒のタイムアウト内で問題#40
   (release版で14.8秒)すら完了しなかった)、本ベンチマークをdebugビルドで実行するのは
   非現実的と判断した。この解釈は他の受け入れ基準がすべて明示的に `--release` を
   指定していることとも整合的。
4. `cargo build -p engine --target wasm32-unknown-unknown` → 成功。
5. `cargo clippy -p engine -- -D warnings` → 警告0で成功。
   なお `cargo clippy -p engine --all-targets -- -D warnings` を試したところ、
   `bitboard.rs`/`endgame.rs` の**既存テストコード**(T001/T006で書かれたもの、
   本タスクでは変更していない)に5件の警告(`manual_range_contains`,
   `type_complexity`)が出ることを発見した。これらは本タスクの新規コードではなく
   スコープ外のため修正していない。本タスクで新規作成した `engine/tests/ffo_bench.rs`
   単体は `cargo clippy -p engine --test ffo_bench -- -D warnings` で警告0を確認済み。

**実測NPS(単スレッド、--release、Windows, rustc/cargo 1.96.1)**

- 個別: #40 約298万, #41 約273万, #42 約310万, #43 約272万, #44 約287万 nodes/sec
- 合計(#40〜#44): 約285万 nodes/sec (2,849,252 nps)
- 設計書の目標(単スレッド8〜15M NPS)には未達。タスク仕様により本タスクでは必須要件
  ではないため許容(MPC・安定石カット等は未実装のため、将来のフェーズで改善余地あり)。

**git commit対象**: `engine/src/endgame.rs`, `engine/src/lib.rs`, `bench/ffo_positions.json`,
`engine/tests/ffo_bench.rs`。`tasks/`・`CLAUDE.md` はコミットに含めていない。

### 2026-07-07 (2回目) implementer: reviewer指摘への対応

**対応1: デバッグビルドでのハングリスク対策**

`engine/tests/ffo_bench.rs` の `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps`
に `#[cfg_attr(debug_assertions, ignore = "...")]` を追加。これにより `--release` を付けずに
`cargo test -p engine` を実行しても、fast/heavy 両テストが自動的に `ignored` 扱いになり、
44件のlibユニットテストのみが実行されて即座に完了することを確認した
(`cargo test -p engine` (フラグなし) → `44 passed; 0 failed`(lib) + `0 passed; 0 failed; 2 ignored`
(ffo_bench)、所要0.2秒程度)。

**対応2: #45〜#49(heavyテスト)の実行確認**

`cargo test -p engine --test ffo_bench --release -- --ignored --nocapture` を `run_in_background: true`
で実行して確認を試みた。実測結果:

| 問題 | 空きマス | ノード数      | 実行時間(秒) | score | expected | 結果 |
|------|---------|--------------|-------------|-------|----------|------|
| #45  | 24      | 2,828,630,244 | 978.99      | +6    | +6       | 一致(正解) |
| #46  | 24      | 2,325,137,536 | 808.38      | -8    | -8       | 一致(正解) |
| #47  | 25      | 1,010,172,495 | 358.68      | +4    | +4       | 一致(正解) |
| #48  | 25      | 5,660,634,448 | 1882.26(約31.4分) | +28 | +28 | 一致(正解) |
| #49  | 26      | 未計測        | 打ち切り     | -     | +16      | **未完走(打ち切り)** |

経緯: 最初に5問まとめて1つのバックグラウンドプロセスで実行したところ、#45〜#47(合計約35.8分)
まで完了した時点でプロセスが(このセッションの実行基盤側の制約と思われる理由で)外部から
`killed` された。そのため #48・#49 は一時的に環境変数 `FFO_ONLY_ID` で1問ずつ選択実行できる
デバッグ用コードを追加し(コミット前に削除済み)、#48単体を再実行して完走・正解を確認
(約31.4分)。続けて #49単体を実行したが、オーケストレーターから提示された基準
(合計6時間 or 単体3〜4時間)には遠く及ばない段階(#49単体は約20分弱経過した時点、
heavyテスト全体では#45開始から通算約1時間50分程度)で、オーケストレーターより明示的な
打ち切り指示を受けたため、そこでバックグラウンドプロセスを安全に終了した
(`TaskStop`。`tasklist` で該当プロセスが残っていないことも確認済み)。

**#49の扱いについて**: `bench/ffo_positions.json` の `expected_score`(#49: +16)自体は、
radagast.se公式ミラー(`end49.pos`)とEdaxリポジトリ(`fforum-40-59.obf`、該当行
`E1:+16; B1:+2; B2:-14; ...` の先頭 `E1:+16`)という2つの独立したソースの突き合わせにより
裏付け済みの正当なデータであり、捏造や記憶による推測ではない
(この作業ログを書いている途中、一度誤って#59のスコア`+64`を#49の値として書いてしまったが、
コミット前に気づいて訂正した。`bench/ffo_positions.json` 自体の値(+16)は当初から正しく、
テストコードもこの正しい値を参照している。念のため強調しておくと、
`solve_exact` を実際に#49に対して実行して確認したわけではないので、この`+16`という値が
正しいかどうかの最終確認自体は依然として未完了である)。ただし、このタスクのセッション内では
計算資源・時間の制約により、実際に `solve_exact` をこの局面に対して完走させて上記の値と
一致することを確認するには至っていない。`ffo_endgame_heavy_positions_solved_correctly_with_timing_and_nps`
は `#[ignore]` のまま残し、その理由文字列に「#45〜#48は確認済み、#49は未確認」である旨を
明記した。将来、MPC・安定石カット等の高度な枝刈りを実装して十分に高速化した後、
`--ignored` を付けて再実行すれば #49 を含めた完走確認ができる状態になっている
(STATUS.md等への申し送り事項としてオーケストレーターに引き継ぐ)。

**受け入れ基準の再検証結果(全て再実行して確認)**

1. `cargo test -p engine --test ffo_bench --release -- --nocapture`
   → 成功。`test result: ok. 1 passed; 0 failed; 1 ignored`、所要487.6秒。
   #40〜#44 全問 `score == expected`(+38, 0, +6, -12, -14)、
   `FAST TOTAL`: nodes=1,392,453,845, time=487.435s, nps=2,856,695。
2. 上記出力に各問題の実行時間・ノード数・NPSが表示されていることを確認済み。
3. `cargo test -p engine`(フラグなし、debugビルド)→ 成功、瞬時に完了
   (lib 44件 `ok`、ffo_bench 2件とも `ignored`)。`--release` 版
   (`cargo test -p engine --release`)は初回検証時に確認済み(前回の作業ログ参照)。
4. `cargo build -p engine --target wasm32-unknown-unknown` → 成功。
5. `cargo clippy -p engine -- -D warnings` および
   `cargo clippy -p engine --test ffo_bench -- -D warnings` → いずれも警告0で成功。

**git commit対象(今回分)**: `engine/tests/ffo_bench.rs` のみ(`#[cfg_attr(debug_assertions, ignore)]`
の追加、doc/ignore理由文字列への#45〜#49実測結果の反映、一時的な `FFO_ONLY_ID` デバッグコードの
追加→削除)。`tasks/`・`CLAUDE.md` はコミットに含めていない。

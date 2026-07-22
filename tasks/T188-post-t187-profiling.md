---
id: T188
title: 高速化(7): T187後のRDTSC再プロファイル(次候補の実測選定)
status: done
assignee: implementer
attempts: 0
---

# T188: 高速化(7): T187後のRDTSC再プロファイル(次候補の実測選定)

## 目的

T184(sort_by_cached_key、2.1〜2.3倍)・T185(固定長配列+next_board持ち越し、+1.7〜3.2%)・T186(legal_moves重複排除)・T187(増分評価、+37〜38%)の適用後、中盤探索の実コスト内訳は推定でしか分かっていない(T183のプロファイルはT184以前のもの)。次のアルゴリズム的高速化候補(ordering機構残余・スカラー特徴の増分化・flip計算のテーブル化・その他)へ投資する前に、T183と同じ手法で現時点の実測内訳を取り直し、優先順位を実測で決める。**コードの恒久変更は行わない計測タスク**。

## 背景・コンテキスト

- 前例: `tasks/T183-deep-profiling.md` と `bench/edax-compare/t183_profiling_report.md`。RDTSC一時計装(rdtsc/計測カウンタをsearch.rs等に一時挿入)→計測→**計装を完全に外して復元diffゼロ**という方式で実施済み。同じ方式を踏襲する。
- 計測対象バッチ: T183/T187と同じ中盤20局面(`bench/edax-compare/t156_mpc_positions.json` の split==test・空き29-36帯・先頭20件)、`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights pattern_v6.bin`、MPC off/on両方。
- T187で評価経路が増分化された(`PatternState::child`による差分更新+`score_with_state`)。旧「static_eval一括」ではなく、増分化後の新しい区間割りで計測する必要がある。

## 変更対象

- `engine/src/search.rs`・`engine/src/pattern_eval.rs` 等への**一時**計装(タスク完了時に完全除去、`git status --short`と`git diff`がクリーンであること)
- 成果物: `bench/edax-compare/t188_profiling_report.md` + raw JSON(これのみコミット)

## 要件

1. 少なくとも以下の区間を分離計測する(T183の区間割りを基礎に、T187後の構造へ更新):
   - `score_with_state`(葉評価本体)。可能なら内訳: パターン表引き部分 vs スカラー特徴(`scalar_features`、legal_moves_relativeフルスキャン)
   - `PatternState::child`(増分更新)と`PatternState::from_board`(ルートフル計算)
   - `ordered_moves` 合計と内訳(next_board生成=apply_move、orderingキーのモビリティ計算=next_board.legal_moves、ソート機構、tt_move昇格)
   - `legal_moves`(negascout冒頭)、`etc_try_cutoff`、`tt_probe`/`tt_store`、`hash_diff`、その他(残差)
2. MPC off/on 両方で計測し、区間別の時間・呼び出し回数・%wallを表にする。RDTSC計装のオーバーヘッド見積もり(T183と同様の注記)を含める。
3. レポートに「次の高速化候補の優先順位(期待削減幅の根拠付き)」を、少なくとも次の仮説候補について実測に基づき評価して記載する: (a)スカラー特徴の増分化ないし軽量化 (b)orderingのモビリティキー計算削減 (c)ソート機構の軽量化 (d)flips_for_moveのテーブル化 (e)TT probe/store改善。「候補に値しない(コスト僅少)」という結論も明記する。
4. 計測はマシン専有状態で行う(開始前にcargo/rustc/eval_cli等の不在を確認)。計装ビルドはrelease+計測フラグで行い、T183と同一条件にする。
5. 進捗・節目(計装完了・計測完了・復元完了)ごとにタスクファイルの作業ログへ追記する。

## やらないこと(スコープ外)

- 高速化の実装そのもの(候補選定まで。実装は次タスク)
- 計装コードの恒久コミット(レポート+raw JSON以外の差分を残さない)
- NPS前後比較(T187レポートで実施済み。本タスクは内訳の解明のみ)
- `tasks/` 配下・`CLAUDE.md` のコミット

## 受け入れ基準(検証コマンド)

- [ ] `bench/edax-compare/t188_profiling_report.md` + raw JSON がコミットされ、要件1〜3の内容(区間内訳表・MPC off/on・優先順位評価)を含む。
- [ ] 区間合計と総時間の残差が説明されている(T183同様、残差%を明記)。
- [ ] 計装の完全除去: `git status --short` で engine/ 配下に差分・未追跡ファイルがないこと。`cargo test -p engine` が全件パス(計装除去後の健全性確認)。
- [ ] レポートのみの変更のため、Pages実機確認は不要(エンジンコード不変)。push と Actions(Rust Tests)成功確認は行う。
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 着手

- 前例(T183タスクファイル・レポート・meta.json)を精読。手法: `engine/src/search.rs`へRDTSC一時計装+専用一時バイナリ(サブプロセス起動なしでプロセス内ループ)、計測後`git checkout`で完全復元、`git status --short`空を確認。
- T187レポート(`bench/edax-compare/t187_incremental_eval_report.md`)・現在の`search.rs`/`pattern_eval.rs`のコードを確認し、T183以降の構造変化を把握:
  - `ordered_moves`(T185以降): `Vec`→固定長配列`[OrderedMove; 64]`(`OrderedMove{mv, next_board}`)。列挙ループで`apply_move`を1回だけ呼んで`next_board`を保持(旧`sort_apply_move`はもう存在しない、要素数分=旧の1/65〜1/78)。ソートキー計算(`sort_by_cached_key`)は`next_board.legal_moves(側反対)`のみ(旧`sort_legal_moves`、これも要素数分=キャッシュ済み)。`negascout`候補手ループは`om.next_board`をそのまま使うため、旧`apply_move_loop`(二重apply_move)は消滅。
  - T187で`PatternState::child`(増分)/`PatternState::from_board`(フル計算)・`PatternWeights::score_with_state`(パターン項ループ+スカラー特徴)が新設され、`static_eval_with_state`が葉評価の主経路になった。
- 計測対象バッチ(`t156_mpc_positions.json`、emptyBucket=='29-36' and split=='test'の先頭20件)をPythonで再抽出し、T183/T187と同一のID列であることを確認(sha256=6eb3c45af6ec797b54ab6a71274020e3ea54537d9a87c148e71c1419ac5ca791、シリアライズ方式が異なるためT183 metaの値とは単純比較できないが、ID列は完全一致)。パターン重み`train/weights/pattern_v6.bin`のsha256(`e69f3b1c...`)もT183/T187と一致、変更なしを確認。
- 専有確認: `Get-Process`でcargo/python/rustc/node/eval_cli/t18*_profile系プロセスなし。ベースコミット`0a28e99c`(HEAD、T185/T187適用後の最新main)、`git status --short`空を確認して着手。
- 次: `engine/src/search.rs`・`engine/src/pattern_eval.rs`へRDTSC計装を追加し、専用一時バイナリで計測する。

### 2026-07-22 計装完了

- 新規一時ファイル`engine/src/profile188.rs`(16バケット分のRDTSCカウンタ、`entry_checks`/`legal_moves_top`/`tt_probe`/`tt_store`/`mpc_overhead_self`/`ordered_moves_total`/`ordered_moves_fill_apply_move`/`ordered_moves_sort_legal_moves`/`hash_diff_loop`/`pattern_state_child`/`pattern_state_from_board_root`/`etc_try_cutoff`/`static_eval_leaf_total`/`score_pattern_lookup`/`score_scalar_features`/`pass_hash`)+`engine/src/lib.rs`へ`pub mod profile188;`追加+`engine/src/search.rs`(`negascout`/`negascout_or_etc`/`etc_try_cutoff`呼び出し元/`mpc_try_cutoff`/`mpc_try_cutoff_inner`/`ordered_moves`/`static_eval_with_state`)・`engine/src/pattern_eval.rs`(`score_with_state`)へ計装呼び出しを追加。プローブ再帰(`negascout`呼び出し自体)の時間は`mpc_overhead_self`に含めない設計(T183と同じ二重計上回避方針)。
- `entry_checks`は本タスクの計測プロトコル(depth固定・time_ms=None・max_nodes=None)では冒頭3つの早期return(timed_out/max_nodes/time_ms)が実測上発火しない前提を利用し、単純化(単一区間・1呼び出し1回のadd)。
- 新規一時バイナリ`engine/src/bin/t188_profile.rs`(サブプロセス起動なし、1プロセス内でMPC off→onの順に20局面バッチを実行しJSON出力)。
- `cargo check -p engine --release --features mpc_enabled`・`cargo build -p engine --release --bin t188_profile --features mpc_enabled`ともにエラー0で完了。
- 次: 専有確認のうえ計測を実行する。

### 2026-07-22 計測完了

- 専有確認(`Get-Process`)後、`cargo build -p engine --release --bin t188_profile --features mpc_enabled`でビルドし、`t188_profile.exe <positions.json> <weights.bin>`をフォアグラウンドで実行(サブプロセス無し、MPC off→onの順に1プロセス内でループ)。totalNodesはMPC off `59,440,032`・MPC on `6,487,461`でT180以来一貫して確立されている値と完全一致(T184〜T187の探索結果不変性の追加傍証)。
- 校正: 本タスクの計装パターン(rdtsc×2+スレッドローカルadd())自体のオーバーヘッドを5000万回のマイクロベンチマークで直接測定(17.272808 ns/call)。`ordered_moves_fill_apply_move`(16.4〜16.6ns/call)がこの床以下だったため、この区間は実コストと計装ノイズを本方式では判別できないと判断。残差(12.99%/13.97%、T183の4.37〜4.68%より大きい)についても、top-levelバケット呼び出し回数×校正値が実測残差とオーダーで一致することを確認し、「未解明コスト」ではなく主に計装自体のオーバーヘッドで説明できると結論づけた。
- レポート(`bench/edax-compare/t188_profiling_report.md`)・meta.json・raw.jsonの(a)〜(d)節・(f)節(優先順位リスト)を作成。(e)/(g)節は計装復元・回帰確認後に追記する。
- 次: 計装(`engine/src/search.rs`・`engine/src/pattern_eval.rs`・`engine/src/lib.rs`)を`git checkout`で復元し、一時ファイル(`engine/src/profile188.rs`・`engine/src/bin/t188_profile.rs`)を削除、`cargo test -p engine`で健全性確認する。

### 2026-07-22 復元完了・完了

- `git checkout -- engine/src/search.rs engine/src/pattern_eval.rs engine/src/lib.rs`+`rm engine/src/profile188.rs engine/src/bin/t188_profile.rs`で一時計装を完全復元。`git status --short engine/`が空(diffゼロ)であることを確認。
- 復元後`cargo test -p engine --lib`: 251 passed; 0 failed; 2 ignored(T187完了時点と同一件数)。
- 復元後`cargo test -p engine --test ffo_bench --release -- --nocapture`: FFO #40〜#44の5問全問正解。
- レポート(e)/(g)節を追記して完成させた。成果物: `bench/edax-compare/t188_profiling_report.md`・`t188_profiling_report.meta.json`・`t188_profiling_report.raw.json`(3ファイルのみ、パス明示でコミット予定)。
- 受け入れ基準の残りチェックリスト: レポート/rawJSON成果物あり・区間内訳表+MPC off/on+優先順位評価あり・残差説明あり・計装完全除去+cargo test全件パス・エンジンコード不変のためPages実機確認不要(push+Actions確認は別途実施)・当タスク由来の差分は本作業ログ・tasks/STATUS.md更新をもって次にpush/コミットする。
- レポート成果物3ファイルをパス明示でコミット(`90698d3`)・push済み。GitHub Actions「Rust Tests」(run 29898886608)を`gh run watch`で確認、3m45sで全ジョブ成功(`cargo test -p engine (debug)`・`cargo test -p engine --release --test ffo_bench (FFO fast)`・`cargo test -p train`すべて✓)。エンジンコード不変のためPages実機確認は本タスクでは不要(要件どおり)。
- `git status --short`: 残るのは本タスクファイル自身(`tasks/T188-post-t187-profiling.md`)の未コミット差分のみ(タスクファイルはワーカーがコミットしない運用のため、オーケストレーター側の作業として残す)。他に当タスク由来の差分・未追跡ファイルは無い。

---
id: T187
title: 高速化(6): パターン評価の増分化(incremental pattern evaluation)
status: done
assignee: implementer
attempts: 0
---

# T187: 高速化(6): パターン評価の増分化(incremental pattern evaluation)

## 目的

中盤探索(NegaScout)の葉評価 `static_eval` は、毎回46パターンインスタンス×約9セルをフルスキャンして3進インデックスを再計算している。T185適用後の推定コスト内訳でこれが**壁時計の約42%と最大バケット**。Edax/Egaroucid流の「着手差分だけパターンインデックスを更新する」増分評価に置き換え、単一スレッドのまま大幅高速化する。**探索結果(best_move / score / depth / ノード数)はビット単位で完全不変であること**が絶対条件。

## 背景・コンテキスト(事前調査済み、2026-07-22 explorer)

このタスクは難度が高い。以下の調査結果を前提として使ってよい(着手時に現物と突き合わせて確認すること)。

### 現行の評価経路
- エントリポイント: `engine/src/pattern_eval.rs:434` `PatternWeights::score(&self, board, mover) -> f32`。
  - `stage = stage_for_empty_count(board.empty_count())`(pattern_v6.bin はV4形式=61ステージ)。
  - 各インスタンス i について `cells = &self.class_info.aligned_cells[i]` → `state = patterns::pattern_state_index(cells, board, mover)`(`engine/src/patterns.rs:294-305`、セル列挙の3進エンコードをフル再計算)→ `index = self.table_index(class_id, state)`(`pattern_eval.rs:387`、canonical形式ならテーブル引き)→ `sum += class_tables[class_id].stage_tables[stage][index]`。
  - 最後にスカラー特徴(モビリティ差等、`pattern_eval.rs:149-160`)を加算。
- 探索からの入口は `engine/src/search.rs:118` `static_eval`(葉 `depth==0`、`search.rs:1813-1815` のみ)。内部ノードのorderingは評価値を使わない(モビリティ・隅ベース)。
- MPCプローブ(`mpc_try_cutoff`)は `negascout` を再帰するだけなので、同じ葉経路が自然に増分化される。特別扱い不要。

### 探索側の構造
- 子盤面コピー方式。T185の `OrderedMove { mv, next_board }`(`search.rs:2296-2314`)で子盤面は事前計算済み。
- flip mask は `negascout` ループ内で既に導出済み(`search.rs:1877-1885`、`let flips = (own_after ^ own_before) & !mv_bit;` — T182の増分hash用)。**増分評価はこれを再利用できる**。
- パス: `search.rs:1789-1811`、盤面不変・手番のみ反転して再帰。
- 終盤ソルバー(`endgame.rs`)は評価関数を一切使わない → スコープ外。

### 設計方針(オーケストレーター指定。合理的な理由があれば逸脱可、ただし作業ログに理由を明記)

1. **絶対色(黒視点)でraw 3進状態を保持する**: `PatternState`(46インスタンス分の `u32` 配列、1深さ分184B)を導入。桁の意味は「0=空 / 1=黒 / 2=白」で固定し、手番に依存させない。
2. **手番はクラス別の事前計算写像テーブルで吸収する**: 重みロード時に各クラスについて
   - `idx_black[class][raw] = table_index(class, raw)`
   - `idx_white[class][raw] = table_index(class, swap12(raw))`(swap12 = 全桁の1↔2入替)
   を構築する(要素型は既存 `canonical_tables` に合わせる。テーブルサイズは 3^セル数 ≤ 3^10 = 59,049/クラス)。根拠: `pattern_state_index` の White 視点raw = 黒視点rawのswap12 が定義上厳密に成り立つ(`cell_trit` は own/opp を mover で選ぶだけ)。これにより**パスは状態更新ゼロ(参照テーブルが切り替わるだけ)**になる。
3. **逆引きテーブル**: 重みロード時に `cell_to_instances[64] = Vec<(instance_id, pow3_digit)>` を構築する。必ず `class_info.aligned_cells[i]`(代表インスタンスに揃えたセル順序、`patterns.rs:413-419` のドキュメント参照)を基準にすること(自然順セルではない)。`POW3` は `patterns.rs:121`。
4. **差分更新**: 子へ降りるとき、親 `PatternState` をコピーし、着手マス(0→mover色)と flips(相手色→mover色)の各マスについて `state[i] += delta * pow3_digit` を適用する(0→1: +1、0→2: +2、2→1: -1、1→2: +1、いずれもpow3単位)。既存の flips 計算(`search.rs:1877-1885`)を再利用する。
5. **葉評価**: `score_with_state(state, board, mover)` を追加。パターン項は `stage_tables[stage][idx_{black|white}[class][state_i]]` を**現行 `score()` と同一の順序(i = 0..46 の昇順)・同一のf32加算順で**合算し、スカラー特徴は現行どおりフル計算で加算する。**f32の加算順が1箇所でも変わると値がズレて探索結果が変わるので厳守**。
6. **debug照合**: `debug_assertions` 時に増分stateとフル再計算(`pattern_state_index`)の一致を照合する(T105の増分hash debug照合の前例に倣う)。リリースビルドではコストゼロ。
7. **適用範囲**: `negascout` の葉評価経路のみ。既存の公開 `score()` / UI経路(`search_all_moves_with_eval_core_restricted` の `static_eval` 直接呼び出し、`search.rs:1397`)はフル再計算のまま無変更。ヒューリスティック評価フォールバック(`weights: None`)も無変更。
8. 本番 `train/weights/pattern_v6.bin` がPWV4(レガシー)/PWV5(canonical)どちらの形式かを着手時に確認し、両形式で正しく動くこと(レガシーは `table_index` が恒等なので `idx_black` が恒等表になるだけ。実装は両形式ともテーブル経由に統一してよい)。

## 変更対象

- `engine/src/pattern_eval.rs` — 逆引き/写像テーブルの構築、`score_with_state` 追加
- `engine/src/patterns.rs` — swap12・逆引き生成のヘルパー(必要なら)
- `engine/src/search.rs` — `negascout` への `PatternState` の受け渡し(ルートでフル計算1回→以降増分)、flips再利用
- テスト追加(同上ファイル内)、NPSレポート `bench/edax-compare/t187_incremental_eval_report.md`

## 要件

1. 上記設計方針の実装。探索結果はMPC on/off両方でビット単位不変(ノード数まで一致)。
2. **プロパティテスト追加**: ランダム自己対局(パス含む・複数ゲーム)の全局面で (a) 増分 `PatternState` == `pattern_state_index` フル再計算、(b) `score_with_state` のf32ビット表現(`to_bits()`)== 現行 `score()`、を検証する。`engine/src/zobrist.rs:251` の `incremental_move_hash_matches_full_recompute_across_random_self_play_including_passes` が直接のテンプレート。
3. 既存の固定値回帰テスト(t182 / t184 / t185、`search.rs:4534/4599/4660`)が**アサート値を一切変更せずに**パスする。
4. **NPS計測(検証の恒常的教訓に従うこと)**: worktree独立ビルド(変更前=T186完了時点のcommit vs 変更後)+交互実行(A,B/B,A)+各3回以上+マシン専有で、T183/T185と同じ20局面バッチのMPC off/on両方を計測。ノード数が変更前と完全一致することも同時に確認する。レポートに raw JSON を保存し、使用したバッチ・フィルタ条件を明記する(T185申し送り)。
5. 採用条件: ノード数完全一致 + NPS改善が計測誤差を明確に超えること(期待値: パターン項は評価コストの約83%、evalは壁時計の約42%なので、2桁%の短縮が目標。ただし採否は実測で判断)。

## やらないこと(スコープ外)

- スカラー特徴(モビリティ差・空隣接差)の増分化(フル計算のまま。効果測定後に別タスクで検討)
- orderingの変更・futility等の新しい枝刈り・探索アルゴリズム自体の変更
- `endgame.rs`(評価不使用)・重みファイル形式・学習側(`train/`)の変更
- `ANALYSIS_ENGINE_VERSION` のインクリメント(評価結果・探索結果が完全不変のため不要。万一値が変わる実装になったらそれは本タスクの不合格を意味する)
- マルチスレッド・SIMD
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記はするがコミットはオーケストレーター担当)

## 受け入れ基準(検証コマンド)

- [x] `cargo test -p engine` 全件パス(`protocol.rs` の既知フレーキーは単独再実行で切り分け)。→ 251 passed; 0 failed; 2 ignored(統合テスト含め全件ok)。
- [x] 新規プロパティテスト(要件2)がパスし、かつ**増分更新ロジックに意図的なバグを入れると失敗する**ことを確認済み(regression-catching実証、確認後は元に戻す)。→ 作業ログ「プロパティテスト」節参照。
- [x] t182/t184/t185 固定値テストが無改変でパス。→ 作業ログ「検証: cargo test / FFO回帰」節参照。
- [x] NPS計測(要件4)の結果、ノード数完全一致かつNPS改善。レポート `bench/edax-compare/t187_incremental_eval_report.md` + raw JSON をコミット。→ MPC off +37.0%・MPC on +38.1%、ノード完全一致(コミット`e680a75`)。
- [x] `cargo test --release -p engine --test ffo_bench` 相当のFFO回帰が従来どおりパス(終盤は評価不使用だが念のため)。→ #40〜#44全5問正解。
- [x] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URL(https://giwarb.github.io/othello-trainer/)で対局・棋譜解析が動作することを確認する(playwright CLI等、`gh run watch` でデプロイ完了を待つ)。→ push済み(`e680a75`,`0d454f2`)、Rust Tests・Deploy to GitHub Pages両方success、Pages実機で対局(中盤探索経由のCPU応手)・棋譜解析とも動作確認済み。
- [x] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。→ パス明示addで確認済み、`git status --short`クリーン。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 着手・調査突き合わせ

- `pattern_eval.rs`/`patterns.rs`/`search.rs`の該当箇所を読み、タスクの調査結果と現物を突き合わせた。差異なし(`score`の実装・`negascout`のパス/子局面ループ・`flips`導出・`OrderedMove`はいずれも記載どおり)。
- `train/weights/pattern_v6.bin`のヘッダを実バイトで確認: `PWV6`, version=6, num_stages=61, stage_divisor=1, num_instances=46, num_classes=11, num_scalar_features=2。設計方針の「46パターンインスタンス」と一致(D1構成=V3Corner5x2)。canonical(PWV5/6系)。
- `PatternWeights`の全公開コンストラクタ(`zeroed_with_stage_definition`/`zeroed_canonical`/`from_bytes_v1`〜`v6`)を洗い出し、`train`クレート・テストからの呼び出しがすべてこれら経由(構造体リテラル直書きなし)であることを確認。増分テーブルは各コンストラクタの最終ステップで構築する設計とした。

### 2026-07-22 設計逸脱: MAX_PATTERN_INSTANCES固定長配列(64)を採用

- タスク文面は「PatternState(46インスタンス分のu32配列)」と書いているが、`patterns.rs`のテストで使われる`PatternConfig`は22〜50インスタンスまで複数構成があり(本番は46だがテストはV3=38等も使う)、コンパイル時に46へ固定すると汎用性を失う。
- 代わりに`pub const MAX_PATTERN_INSTANCES: usize = 64`の固定長配列(ヒープ確保なし)を採用し、実際に使うインスタンス数は`weights.patterns.len()`(<=64)に委ねた。`build_incremental_tables`内で`assert!(patterns.len() <= MAX_PATTERN_INSTANCES)`を入れ、将来これを超える構成を追加したら即座に気づけるようにした。
- 理由: 既存の全`PatternConfig`(最大50インスタンス)を余裕を持ってカバーしつつ、`Vec`によるヒープ確保(増分更新のたびに発生しては本末転倒)を避けるため。64バイト×4=256Bのstack配列コピーは、フル再計算(400+回のtrit計算)より大幅に安い。

### 2026-07-22 実装: pattern_eval.rs / patterns.rs(テーブル構築)

- `patterns.rs`: `POW3`を`pub(crate)`に変更(値・意味は不変)。`swap12(state: u32) -> u32`を追加(3進数の桁ごとに1↔2を入替、0はそのまま)。
- `pattern_eval.rs`: `PatternWeights`に`cell_to_instances: Vec<Vec<(u32,u32)>>`(セル→(instance_id, pow3_digit)一覧)・`idx_black`/`idx_white: Vec<Vec<u32>>`(黒/白視点rawからテーブル添字への写像)を追加。`build_incremental_tables(&mut self)`で構築(`table_index`経由、legacy/canonical両対応)。全6コンストラクタ(`zeroed_with_stage_definition`/`zeroed_canonical`/`from_bytes_v1`/`from_bytes_v2`/`from_bytes_v3`/`from_bytes_v5`)の末尾で呼ぶよう配線(`from_bytes_v4`/`v6`は`v3`/`v5`を内部で呼ぶので追加配線不要)。`zeroed_canonical`/`from_bytes_v5`は`canonical_tables`確定後に**作り直す**(先に`zeroed_with_stage_definition`/`from_bytes_self_describing`が`canonical_tables: None`前提で一度構築してしまうため)。
- `PatternState`構造体(`raw: [u32; MAX_PATTERN_INSTANCES]`、Copy)を追加。`from_board`(フル再計算、常にBlack視点=絶対色)・`child`(親をコピーし着手マス+flipsマスだけ差分更新、delta = mover_trit - 元の色のtrit)を実装。
- `PatternWeights::score_with_state`を追加。`score`と同一順序(i=0..patterns.len()昇順→スカラー特徴)でf32を加算するようコードを目視で並べ、コメントで絶対条件を明記。

### 2026-07-22 プロパティテスト(pattern_eval.rs)

- `incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`を追加(`zobrist.rs`のT105/T182テストをテンプレートに、同じLCG擬似乱数・パス処理を流用)。実際の`pattern_v6.bin`(全クラス非ゼロ)を使い、30ゲームのランダム自己対局(パス含む)全手数で (a) `PatternState::child`によるインクリメンタル更新 == `PatternState::from_board`のフル再計算、(b) `score_with_state(...).to_bits() == score(...).to_bits()`(手番側・相手側両方の視点)を検証。
- `cargo test -p engine --lib pattern_eval::` 51件全パス。`cargo test -p engine --lib patterns::` 33件全パス(swap12関連2件含む)。
- **regression-catching実証**: `PatternState::child`の着手マス更新を`next.apply_delta(weights, mv, mover_trit + 1)`(意図的に1ずれたdeltaを入れる)に一時改変して実行 → `incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`が即座にFAIL(`assertion left == right failed: incremental PatternState mismatch at square 19 ...`)することを確認。直後に元の`next.apply_delta(weights, mv, mover_trit);`へ戻し、再実行してPASSに復帰したことを確認済み。

### 2026-07-22 探索への配線(search.rs)

- `negascout`/`negascout_or_etc`/`mpc_try_cutoff`/`mpc_try_cutoff_inner`のシグネチャに`known_state`/`state`/`next_state: Option<PatternState>`を追加し、T182の`known_hash`と全く同じ構図で配線(パスは状態不変のまま渡す、子局面ループで`state.child(...)`を1手につき1回だけ計算してNWS/フルウィンドウ再探索の最大3回で使い回す、MPCプローブは現在ノードと同じ局面なので`state`をそのまま渡す)。
- `depth==0`の葉では`static_eval_with_state`(新設、`state`があれば`score_with_state`経由、無ければ既存`static_eval`にそのまま委譲)を呼ぶよう変更。
- `debug_assertions`時、パス・子局面ループの両方で`PatternState::from_board`によるフル再計算と`debug_assert_eq!`で照合し、T182と同型のテレメトリ(`TEST_INCREMENTAL_STATE_CHECKS`)を追加。
- 適用範囲を厳守: `search_all_moves_with_eval_core_restricted`内の`static_eval`直接呼び出し(1380行目・1397行目付近)は無変更。ルート呼び出し(807/1084/1428行目)は`known_state`に`None`を渡すのみ(ルートでは`negascout`内部が`ctx.weights`ありなら自動でフル計算→以降増分)。
- 新規テスト`search::tests::incremental_state_check_fires_across_diverse_midgame_searches`を追加(T182の`incremental_hash_check_fires_across_diverse_midgame_searches`と同型。実重み`pattern_v6.bin`を読み込み、8局面×反復深化+MPC+ETC+aspiration+historyの経路でdebug_assertが200回以上発火することを確認)。

### 2026-07-22 検証: cargo test / FFO回帰

- `cargo test -p engine --lib`: 251 passed; 0 failed; 2 ignored(既存の重いテストのみ)。**t182/t184/t185の固定値テスト(score/best_move/depth/nodes)はアサート値を一切変更せずに全パス**(絶対条件を満たすことを実測で確認)。`incremental_state_check_fires_across_diverse_midgame_searches`も200回以上発火してパス。
- `cargo test -p engine`(統合テスト含む全件): 上記251件 + `calibrate_mpc`(4) + `eval_cli`(0) + `puzzlegen`(4) + `self_play_gen`(5) + 各種`_nps_bench`(すべて`#[ignore]`のまま、NPS計測は後続コマンドで個別実行)+ doctest(0)、全てok。
- `cargo test -p engine --test ffo_bench --release -- --nocapture`: fast positions(#40〜#44)全5問が期待スコアと完全一致(`FAST TOTAL: 5 positions solved correctly`)。終盤ソルバー(`endgame.rs`)は評価関数を使わないため無変更のはずだが、念のための回帰として確認。

### 2026-07-22 NPS計測(worktree独立ビルド+交互3回+専有確認)

- `git worktree add`でT186完了時点のHEAD(`4144c5d`)を独立ディレクトリにチェックアウトし、`cargo build --release --bin eval_cli --features mpc_enabled`で変更前バイナリを独立ビルド。現ワークツリー(変更後)も同様にビルド(バイナリサイズが異なることを確認し、別ビルドであることを担保)。
- 実行直前に`tasklist`でcargo/rustc/eval_cli/python等が動いていないことを確認(専有状態)。
- 局面バッチ: `bench/edax-compare/t156_mpc_positions.json`を`split=='test' かつ 29<=empties<=36`でフィルタし先頭20件(ID `mpc-29-36-test-001..020`)を抽出(T180由来・T182〜T185が使ってきたのと同じフィルタ条件、セッションscratchpadに保存されていた実体は未コミットだったため同じ条件で再生成)。`train/weights/pattern_v6.bin`のSHA256(`e69f3b1c...`)がT185レポート記載値と完全一致することを確認済み(重みファイル自体は本タスクで無変更)。
- `eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights pattern_v6.bin [--enable-mpc]`を、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after / round1: after→before / round2: before→after)3ラウンド×MPC off/on実行。
- **絶対条件(探索結果完全一致)**: 20局面×MPC off/on全40探索でmove/depth/nodes/discDiff完全一致(mismatch=0件)。totalNodesは`mpc_off=59,440,032`・`mpc_on=6,487,461`で、T185レポート記載値と完全一致。
- **NPS実測結果**: MPC off = before 1,292,744 → after 1,770,617(**+37.0%**)、MPC on = before 1,255,323 → after 1,734,227(**+38.1%**)。3ラウンドとも(順序を入れ替えても)一貫してafterが上回っており系統誤差の兆候なし。要件5の採用条件(ノード数完全一致+改善が計測誤差を明確に超える)を満たすため**採用**。
- レポート`bench/edax-compare/t187_incremental_eval_report.md`・machine-readable版`t187_incremental_eval_report.meta.json`・raw JSON `t187_incremental_eval_report.raw.json`(ラウンドごとの内訳・局面ID一覧込み)を作成。
- worktreeは計測後`git worktree remove --force`で削除済み(`git worktree list`で残存無しを確認)。

### 2026-07-22 コミット・改行コード事故の修正・push・CI・Pages実機確認

- 変更対象ファイル(`engine/src/pattern_eval.rs`/`patterns.rs`/`search.rs`、`bench/edax-compare/t187_incremental_eval_report.{md,meta.json,raw.json}`)のみをパス明示で`git add`し、コミット`e680a75`(`engine: パターン評価の増分化(incremental pattern evaluation)(T187)`)を作成。
- コミット後、`git diff --stat`で`search.rs`の変更行数が9594行(実際の意味的差分は約188行のはず)と異常に大きいことに気付いた。原因調査の結果、`mpc_try_cutoff`呼び出し4箇所への`None`引数追加をPythonスクリプト経由で行った際、Windows上のテキストモード書き込み(`open(path, "w", encoding="utf-8")`)が改行コードをCRLFへ変換してしまい、実際に編集した箇所以外の全行が(改行コードの違いだけで)差分として記録されていたことが判明(`engine/src/pattern_eval.rs`/`patterns.rs`はEditツール経由の編集で、元々LFのまま保たれていたため無事)。
- `search.rs`のバイト列を`\r\n`→`\n`へ一括変換して元のLF規約へ復元し、`git diff --stat df2cc3e HEAD -- engine/src/search.rs`で意味的差分が188行(+175/-13)まで縮んだことを確認。リポジトリルールの「新規コミットを作る(amendしない)」に従い、修正専用のコミット`0d454f2`(`engine: search.rsの改行コードをLFへ復元(T187)`)を作成(コード内容は無変更、改行コードのみの復元であることをコミットメッセージに明記)。
- 修正後に`cargo test -p engine --lib`を再実行し、251 passed; 0 failed; 2 ignoredで変化がないことを確認(改行コード修正が内容に影響しないことの裏付け)。
- `git push origin main`で2コミット(`e680a75`,`0d454f2`)をpush。`gh run list`で新規キューされたRust Tests(29894907952)・Deploy to GitHub Pages(29894907961)を確認し、`gh run view --json status,conclusion`のポーリングで両方`completed`/`success`になるまで待機して確認した。
- GitHub Pages公開URL(https://giwarb.github.io/othello-trainer/)を実機確認:
  - **対局**: 黒番・CPU強さ「強い(depth12)」で新規対局を開始し、canvas盤へJS経由でクリックイベントを送って黒の初手(d3相当)を着手。スコアが2-2→3-3へ変化し、CPU(白)が自動応手したことを確認。さらにもう1手(c4相当)進めたところ、直近手の評価値表示に「中盤(探索)」ラベル(`+1`)が表示され、**NegaScout中盤探索経路(本タスクT187の変更対象そのもの)がWASM上で実際に実行され、UIへ結果が反映されている**ことを確認した。投了して対局を終了(白の勝ち)。
  - **棋譜解析**: 対局終了画面の「この対局を棋譜解析で振り返る」から棋譜解析モードへ遷移し、「解析完了: 4手(解析時間: 6.01秒)」を確認。ムーブリストに4手分の着手・評価・分類(本ゲームは全手が定石一致だったため4手とも「定石」ラベル)が表示され、解析パイプライン(終盤側から解析)が正常動作することを確認した。
  - 上記操作の全過程で`read_console_messages`によるコンソールエラーは0件(`No console logs.`)。
  - 備考(ツール制約): headlessブラウザで`document.visibilityState === "hidden"`のため`requestAnimationFrame`ベースのcanvas再描画が実行されず、canvasピクセルの直接読み取りによる盤面確認は信頼できなかった(初期局面の4石は正しく読めたが、着手後の新しい石は反映されなかった)。そのためスコア表示・評価値ソースラベル・「1手戻る」での状態復元(3-3→2-2に正しく戻ることを確認済み)という、DOM上の実際のアプリ状態を反映するテキスト情報で動作を検証した。これはツール(ヘッドレスブラウザのタブ可視性)側の制約であり、アプリ・エンジン側の不具合ではない。
- 最終`git status --short`はクリーン(`tasks/`配下の作業ログ差分はオーケストレーター担当のため意図的に残る。それ以外の未追跡ファイル・差分なし)。`git worktree list`もメインワークツリーのみで残骸なし。

**完了サマリ**: コミット `e680a75`(実装本体)・`0d454f2`(改行コード復元)。NPS実測: MPC off **+37.0%**(1,292,744→1,770,617 NPS)、MPC on **+38.1%**(1,255,323→1,734,227 NPS)。ノード数完全一致: MPC off 59,440,032・MPC on 6,487,461(いずれもbefore/afterで0件不一致、T185レポート値とも一致)。GitHub Actions(Rust Tests・Deploy to GitHub Pages)両方success、Pages実機で対局(中盤探索経由のCPU応手を確認)・棋譜解析とも動作確認済み、コンソールエラーなし。受け入れ基準は全項目達成。

### 2026-07-22 verifier検証(独立実施)

**判定: 合格**。8項目すべて独立に確認した(コード修正なし、指示された規約に基づく一時バグ注入は例外として実施し、完了後にgit diff空で復元を確認)。

1. `cargo test -p engine`: 251 passed; 0 failed; 2 ignored(全crate合計、統合テスト・doctest含め全てok)を実機再実行で確認。新規テスト4件の存在を`cargo test -p engine --lib -- --list`で確認: `pattern_eval::tests::incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`、`patterns::tests::swap12_is_an_involution_and_fixes_zero`、`patterns::tests::swap12_of_black_perspective_state_equals_white_perspective_state`、`search::tests::incremental_state_check_fires_across_diverse_midgame_searches`。`protocol::` を単独再実行(18 passed; 0 failed)しフレーキー無しを確認。
2. `git diff df2cc3e HEAD -- engine/src/search.rs`(pre-T187コミット↔現HEAD、CRLF問題は0d454f2で復元済みのためignore-cr不要)は175insertions/13deletionsの意味的差分のみで、`fn t182_...`/`fn t184_...`/`fn t185_...`のテスト関数定義行に変更なし。さらに3テストの本体を`diff`で行単位比較し(オフセットのみ考慮)完全一致(byte-identical)を確認。
3. **regression-catching追試**: `engine/src/pattern_eval.rs`の`PatternState::child`内`next.apply_delta(weights, mv, mover_trit)`を`mover_trit + 1`へ一時改変し、`cargo test -p engine --lib pattern_eval::tests::incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`を実行 → 即座にFAILED(`assertion left == right failed: incremental PatternState mismatch at square 19 ...`)を自分の手で確認。直後に`mover_trit`へ復元し、`git diff --stat -- engine/src/pattern_eval.rs`が空行(差分ゼロ)であることを確認したうえで同テストを再実行しPASSに復帰したことを確認。
4. `bench/edax-compare/t187_incremental_eval_report.raw.json`を読み、mpc_off/mpc_onとも全6ラウンドエントリでtotalNodesが単一値(59,440,032 / 6,487,461)に一致、identityMismatches=0を確認。summary.beforeAvgNps/afterAvgNps/speedupPctを raw の3ラウンド値から手計算で再導出し完全一致(mpc_off: 1,292,744.43→1,770,617.17、+36.97%≒+37.0%表記と整合。mpc_on: 1,255,322.88→1,734,227.30、+38.15%≒+38.1%表記と整合)。`bench/edax-compare/t185_ordering_opts_report.md`の該当行「totalNodesはmpc_off=59,440,032・mpc_on=6,487,461」と完全一致を確認。
5. `git show 0d454f2 --stat`は`engine/src/search.rs`のみ(4878 insertions/4878 deletions、CRLF変換相当行数)。`git diff e680a75 0d454f2 --ignore-cr-at-eol -- engine/src/search.rs`は出力0行(空)であり、内容差分が皆無(改行コードのみ)であることを確認。
6. `cargo test -p engine --test ffo_bench --release -- --nocapture`実行 → `FAST TOTAL: 5 positions solved correctly`(#40〜#44全問expected一致)。
7. `git status --short`はクリーン(regression-catching追試の復元確認込み)。`git worktree list`はメインワークツリーのみ(ベンチ用worktree残骸なし)。
8. `gh run view 29894907952 --json status,conclusion,headSha` → Rust Tests: completed/success、headSha=0d454f2。`gh run view 29894907961` → Deploy to GitHub Pages: completed/success、headSha=0d454f2。両方とも実装者報告のコミット範囲に対応する最終headSha(0d454f2)で成功していることを確認。

NPSの再計測(時間計測)は指示どおり実施していない(rawデータの再検算のみ)。全項目、実装者の完了レポートの記載と一致し、追加の不整合は発見されなかった。

---
id: T187
title: 高速化(6): パターン評価の増分化(incremental pattern evaluation)
status: in_progress
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

- [ ] `cargo test -p engine` 全件パス(`protocol.rs` の既知フレーキーは単独再実行で切り分け)。
- [ ] 新規プロパティテスト(要件2)がパスし、かつ**増分更新ロジックに意図的なバグを入れると失敗する**ことを確認済み(regression-catching実証、確認後は元に戻す)。
- [ ] t182/t184/t185 固定値テストが無改変でパス。
- [ ] NPS計測(要件4)の結果、ノード数完全一致かつNPS改善。レポート `bench/edax-compare/t187_incremental_eval_report.md` + raw JSON をコミット。
- [ ] `cargo test --release -p engine --test ffo_bench` 相当のFFO回帰が従来どおりパス(終盤は評価不使用だが念のため)。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URL(https://giwarb.github.io/othello-trainer/)で対局・棋譜解析が動作することを確認する(playwright CLI等、`gh run watch` でデプロイ完了を待つ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

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

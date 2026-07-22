---
id: T190
title: 高速化(9): lazy ordering(TT手先行・残候補の遅延順序付け)+パス経路マスク持ち越し
status: review
assignee: implementer
attempts: 0
---

# T190: 高速化(9): lazy ordering(TT手先行・残候補の遅延順序付け)+パス経路マスク持ち越し

## 目的

T188プロファイルで `ordered_moves` は依然として壁時計の47.7%(MPC off)を占める。現在は全候補手(平均10.6〜11.0手)について子盤面生成+合法手マスク計算+ソートを**探索前に必ず**行うが、実際に探索されるのは平均2.8手程度(beta cutoffで打ち切り)であり、**TT手が最初の1手でカットオフを起こすノードでは残り約10手分の準備コストが完全に無駄**になっている。TT手だけを先に構築・探索し、カットオフしなかった場合にのみ残候補を従来と同一順で生成・探索する「lazy ordering」に置き換える。**探索するノード列(したがってノード数・スコア・best_move)は完全同一であること**が絶対条件。あわせてT189レビューの軽微指摘(パス経路の相手側マスク二重計算)も解消する。

## 背景・コンテキスト

### 現行構造(T185/T186/T189適用後の `engine/src/search.rs`)

- `negascout` は TT probe で `tt_move` を得たあと `ordered_moves(board, side, legal, tt_move, history)` を呼ぶ。`ordered_moves` は:
  1. `legal` の全ビットについて `apply_move` + `next_board.legal_moves(side.opposite())` を計算し `OrderedMove { mv, next_board, legal }` を固定長配列 `[OrderedMove; 64]` に格納(T188実測: fill 8.8% + sort_legal_moves 16.5%)。
  2. `sort_by_cached_key` でソート(キー: 隅優先→相手モビリティ昇順→〔historyがSomeなら〕`Reverse(history)`)。Rustの `sort_by_cached_key` は**安定ソート**。
  3. `tt_move` が候補にあれば `moves[..=pos].rotate_right(1)` で先頭に昇格。結果の探索順は `[tt_move, ソート順の残候補...]`。
- `negascout` の候補手ループは配列を順に処理し、beta cutoff で早期 break する。ETC(`etc_try_cutoff`)・増分hash(`hash_diff_loop`)・増分評価state(`PatternState::child`)は**ループ内で1手ずつ**計算されるため、遅延化と競合しない(T188実測で確認済み: これらの呼び出し回数は「実際に探索した子」の数に一致)。

### lazy化の正当性(この論理を実装・テストで保証すること)

- 探索順が `[tt_move, ソート順の残候補...]` である以上、**TT手の探索でカットオフした場合、残候補の順序は結果に一切影響しない**(参照されないため)。よって残候補の構築・ソートをTT手の探索後まで遅延しても、探索されるノード列は完全同一。
- 残候補のソート順の同一性: 安定ソートでは「全体をソートしてからtt_moveを除く」と「tt_moveを除いてからソートする」は同じ順序になる(要素間の比較関係と安定性が保存されるため)。ただし現行実装はtt_moveを**除かずに**先頭へrotateするので、lazy側は「tt_moveを除いた残候補を同一キーで安定ソート」した列を作れば、現行の2番目以降と完全一致する。
- **historyが有効な場合はこの正当性が崩れる**: 現行はordering キー(history値)を**TT手の探索前**に読むが、lazy化するとTT手のサブツリー探索中のhistory更新がキーに混入し、順序が変わりうる。したがって**lazy経路は history が無効(`ctx.history` が `None` 相当)のときだけ有効化し、history有効時は現行の一括構築経路をそのまま使う**こと。本番のノード予算経路(MPC off・`SearchPolicy::default()`)はhistory無効なのでlazyの恩恵を全て受ける。MPC on(history有効)は現行経路のまま=完全不変(着手時に `ctx.history` の実際の有効条件をコードで確認し、ゲート条件をその実態に合わせること)。

### 期待効果

MPC off で `ordered_moves` の fill+sort(約25%)のうち、「TT手が存在し、かつ最初の1手でカットオフするノード」の分が丸ごと消える。TT手の存在率・first-move cutoff率に依存するため事前に正確な予測はできないが、2桁%が狙える。レポートに「lazy経路に入ったノード数/TT手カットオフで残候補構築を省略できたノード数」のテレメトリ実測を含めること(cfg(test)またはdebugビルド限定のカウンタでよい)。

## 変更対象

- `engine/src/search.rs` —
  1. `negascout` の候補手処理を再構成: history無効かつ `tt_move` が合法(`legal` のビットで判定)なら、まずTT手のみの `OrderedMove`(apply_move+合法手マスク)を構築して探索。カットオフしなければ残候補(`legal & !tt_bit`)を従来と同一キー・同一安定ソートで構築し、2手目以降として処理を継続する。history有効時・TT手なし/非合法時は現行の一括経路。
  2. ループ本体(ETC・hash・state・NWS再探索・best更新・TT store)の挙動は一切変えない。コード重複を避けるため、ループ本体を「OrderedMoveの列を順に処理する」共通構造に保ったまま、列の供給だけを遅延化する実装を推奨(例: 2フェーズのイテレーション)。
  3. **パス経路のマスク持ち越し(T189申し送り)**: 両者パス判定で計算している `board.legal_moves(side.opposite())` を変数に保持し、パス再帰の `known_legal` として `Some` で渡す(現在はNoneで捨てて子で再計算)。これは全モード共通・ビット不変。
- テスト追加(search.rs内)、NPSレポート `bench/edax-compare/t190_lazy_ordering_report.md` + raw JSON

## 要件

1. 探索結果(best_move/score/depth/ノード数)がMPC on/off両方でビット単位不変。history有効経路は実装コード上も現行と同一の経路を通ること。
2. **同一性テスト追加**: ランダム局面群+実重み(pattern_v6.bin)で、(a) lazy経路とレガシー一括経路(テスト用に強制切替できるようにするか、変更前挙動を固定値で保存)の探索結果(best_move/score/nodes)が完全一致、(b) 既存固定値テスト(t182/t184/t185)がアサート値無改変でパス、(c) 新テレメトリ(lazy発動回数・省略成功回数)が実際に発火することを確認するテスト。regression-catching実証(例: 残候補ソートのキーを意図的に変えて同一性テストが落ちることを確認→復元)も行う。
3. パス経路の `known_legal` 持ち越しは既存のT189 debug照合(negascout冒頭の`debug_assert_eq!`)で自動的に検証される。パス経路でも照合が発火することをテレメトリで確認する。
4. NPS計測(検証の恒常的教訓に従う): worktree独立ビルド(変更前=直前main vs 変更後)+交互(A,B/B,A)×各3回+専有、20局面バッチ、MPC off/on両方、ノード数完全一致確認込み。MPC onは効果ゼロ〜微増の見込み(lazy非適用+パス持ち越しのみ)であり、悪化していないことの確認が主目的。
5. 採用条件: ノード数完全一致 + MPC offのNPS改善が計測誤差を明確に超えること(MPC onは非悪化)。

## やらないこと(スコープ外)

- orderingキーの定義変更・近似化(探索順を変えない)
- history有効時のlazy化(正当性が崩れるため明示的に対象外)
- 2手目以降のさらなる段階的遅延(ProbCut風のstaged generation。今回はTT手/残候補の2段のみ)
- `endgame.rs`・評価関数・重み・学習側の変更
- `ANALYSIS_ENGINE_VERSION` のインクリメント(探索結果完全不変のため不要)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocol.rsの既知フレーキーは単独再実行で切り分け)。
- [ ] t182/t184/t185 固定値テストが無改変でパス(MPC on/off両経路の探索結果不変の直接証拠)。
- [ ] 同一性テスト(要件2)がパスし、regression-catching実証済み。
- [ ] テレメトリ実測で「lazy発動ノード数・残候補構築を省略できたノード数」がレポートに記載されている。
- [ ] NPS計測の結果、ノード数完全一致かつMPC offのNPS改善・MPC on非悪化。レポート+raw JSONをコミット。
- [ ] `cargo test --release -p engine --test ffo_bench` のfast問題が全問正解。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLで対局が動作することを確認する(`gh run watch` でデプロイ完了を待つ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 着手・実装

- `ctx.history`が実際に`None`になる条件をコードで確認: `SearchPolicy::default()`(fixed-depth/`search`/`search_with_eval`経路)は`enable_history: false`。`search_with_eval_with_node_limit_and_exact_quota`(ノード予算経路)は`enable_history: true`を**無条件**にハードコードしているため、`max_nodes`指定時は常にhistory有効。`eval_cli best`の`--enable-mpc`分岐も`enable_history: true`固定。T182〜T189のNPS計測(depth固定、`--max-nodes`未指定)は「MPC off」が`search_with_eval`(history無効・lazy対象)、「MPC on」が`search_with_eval_with_policy_and_margin_t`(history有効・lazy対象外)を通ることを確認し、これに合わせてゲート条件を`ctx.history.is_none()`とした(タスクの前提と一致)。
- `engine/src/search.rs`の`negascout`候補手ループを、ローカル`macro_rules! process_candidate!`(ETC・増分hash・増分state・増分legal・NWS・best更新・cutoff判定を1本化、中身はT182〜T189から無変更)に切り出し、(a) history無効かつTT手が合法なら「TT手だけ処理→cutoffなら残候補`legal & !tm_bit`を従来キーで構築・処理」のlazy経路、(b) それ以外は従来の一括`ordered_moves`経路、の2分岐に再構成。
- パス経路(`legal == 0`)の相手側合法手マスク計算を`opp_legal`変数に保持し、両者パス判定に使うだけでなく再帰呼び出しへ`Some(opp_legal)`として渡すよう変更(以前は`None`で捨てて子ノードが再計算)。
- テスト専用テレメトリ`TEST_LAZY_ORDERING_ACTIVATIONS`/`TEST_LAZY_ORDERING_RESIDUAL_SKIPPED`(record/reset/getter)と、テスト専用スイッチ`TEST_FORCE_LEGACY_ORDERING`(+`ForceLegacyOrderingGuard`)を追加。
- 新規テスト3件を追加(`search::tests`内、T189の`incremental_legal_check_fires_across_diverse_midgame_searches`の直後):
  1. `lazy_ordering_matches_legacy_full_construction_across_diverse_midgame_searches` — 8局面×depth<=8で、lazy有効(既定)とレガシー強制(`ForceLegacyOrderingGuard`)の探索結果(best_move/score/depth/nodes)が完全一致することを確認。
  2. `lazy_ordering_activates_and_skips_residual_across_diverse_midgame_searches` — 同じ8局面でlazy発動回数・残候補構築省略回数のテレメトリが実際に発火することを確認(実測値をログ出力)。
  3. `known_legal_carryover_fires_exactly_once_per_forced_single_side_pass` — 決定的自己対戦(常に最下位ビットの合法手を選択)で見つけた強制片側パス局面から、パス経由の`search()`と直接`search()`のincremental_legal_checks差分が正確に+1になることを確認(パス経路のknown_legal持ち越しの直接証拠)。
- `cargo test -p engine --lib`: 255 passed(既存252 + 新規3件)/ 0 failed / 2 ignored。t182/t184/t185固定値テストはアサート値無改変でパス。
- regression-catching実証: `ordered_moves`への残候補マスク引数を一時的に`legal & !tm_bit`→`legal`(TT手を除外しない=TT手の重複探索を意図的に混入)に変更し、`lazy_ordering_matches_legacy_full_construction_across_diverse_midgame_searches`を実行 → `nodes`不一致(left: 22224, right: 22098)で即座に失敗することを確認。直後に`legal & !tm_bit`へ復元し、`cargo test -p engine --lib`が255 passed(復元前と同数)に戻ったことを確認済み。
- テレメトリ実測(`lazy_ordering_activates_and_skips_residual_across_diverse_midgame_searches`実行結果、8局面×depth<=8): `activations=17673` `residual_skipped=11926`(lazy発動ノードの約67.5%でTT手の探索だけでcutoffし残候補構築を丸ごと省略できた)。

### 2026-07-22 NPS実測・レポート・コミット・デプロイ確認(完了)

- `cargo test -p engine`(全ターゲット): 255 passed(lib) / 0 failed / 2 ignored、他バイナリ(`calibrate_mpc`/`puzzlegen`/`self_play_gen`)も全件pass。`cargo test --release -p engine --test ffo_bench -- fast`: 1 passed(59.06s)。
- NPS計測: `git worktree add`で変更前(`bca08ca`、T189完了時点のHEAD)を`../t190-worktrees/before`に独立チェックアウトし、`eval_cli`(`--features mpc_enabled`)を独立ビルド(SHA256差異確認: before=`411db32b...`, after=`a434fa06...`)。`bench/edax-compare/t156_mpc_positions.json`のtest split・空き29-36帯の先頭20局面(`mpc-29-36-test-001..020`)を`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`(MPC off/on)で、before/after順序を入れ替えながら3ラウンド実行。
  - **MPC off**: ノード数完全一致(59,440,032、120局面回でmismatch=0)。NPS: before平均2,051,468 → after平均2,215,765(**+8.0%**、3ラウンドとも一貫してafterが上回る)。
  - **MPC on**: ノード数完全一致(6,487,461、mismatch=0)。NPS: before平均1,957,015 → after平均1,968,345(**+0.6%**、見込みどおり非悪化)。
  - 使用スクリプト(scratchpad、リポジトリ非同梱): `t190_nps_bench.py`。
- レポート`bench/edax-compare/t190_lazy_ordering_report.md`+raw JSON `bench/edax-compare/t190_lazy_ordering_report.raw.json`(ラウンド内訳・バイナリSHA256・テレメトリ実測込み)を作成。
- `git worktree remove ../t190-worktrees/before --force`でworktreeを削除・確認済み(`git worktree list`にmainのみ)。
- コミット `6a19815e82b71ccad73dbf16ac313ea67621f98f`(`engine/src/search.rs`+`bench/edax-compare/t190_lazy_ordering_report.md`+`.raw.json`のみ、パス明示add)。`git push origin main`成功(`bca08ca..6a19815`)。
- `gh run watch`で両ワークフロー完了を確認: `Deploy to GitHub Pages`(29906898413)success、`Rust Tests`(29906898369)success(`cargo test -p engine`debug + FFO fast release + `cargo test -p train`すべてsuccess)。
- GitHub Pages公開URL(`https://giwarb.github.io/othello-trainer/`)で実機確認: 「対局」→黒番で開始→d3へ着手(Browser MCPのスクリーンショットがpane非表示のため使えなかったため、`javascript_tool`でcanvasへ座標一致のMouseEvent〈mousedown/mouseup/click〉を発火して着手)→「定石: 牛(他30)(2手目)」表示・評価値候補(-12/0/-7/-5)表示・CPU応答まで一連の動作を確認、コンソールエラーなし。
- `git status --short`: `tasks/T190-lazy-ordering.md`(このタスクファイル自体)のみ差分が残る状態を確認(オーケストレーター担当のためコミットしない)。それ以外の当該タスク由来の差分・未追跡ファイルは残っていない。

**完了報告(要求項目)**:
- コミットハッシュ: `6a19815e82b71ccad73dbf16ac313ea67621f98f`
- NPS実測: MPC off +8.0%(2,051,468→2,215,765 NPS)、MPC on +0.6%(1,957,015→1,968,345 NPS、非悪化)
- ノード完全一致の証拠: MPC off/on×3ラウンド×20局面=120局面回、before/after全てでnodes/move/discDiffが完全一致(mismatch=0)。`bench/edax-compare/t190_lazy_ordering_report.raw.json`に詳細記録。
- テレメトリ実測: lazy発動17,673回、うち残候補構築省略11,926回(約67.5%)。

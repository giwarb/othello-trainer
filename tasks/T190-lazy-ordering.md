---
id: T190
title: 高速化(9): lazy ordering(TT手先行・残候補の遅延順序付け)+パス経路マスク持ち越し
status: in_progress
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

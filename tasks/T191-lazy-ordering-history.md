---
id: T191
title: 高速化(10): lazy orderingのhistory有効経路への拡張(historyスナップショット方式)
status: review
assignee: implementer
attempts: 0
---

# T191: 高速化(10): lazy orderingのhistory有効経路への拡張(historyスナップショット方式)

## 目的

T190のlazy ordering(TT手先行・残候補遅延構築、省略成功率67.5%)は `ctx.history` が有効な経路では正当性が崩れるため無効化されている。しかしT190の調査で、**本番の対局CPU(強)が使うノード予算経路(`search_with_eval_with_node_limit_and_exact_quota`)は `enable_history: true` がハードコードされており、現状lazyの恩恵を受けていない**ことが判明した。history値を「ノード入場時(TT手の探索前)」にスナップショットしておけば、残候補の遅延ソートでも現行と厳密に同一のキー値を使えるため、**探索結果ビット不変のままhistory有効経路へlazyを拡張できる**。本番経路とMPC on経路の両方に効かせる。

## 背景・コンテキスト

- T190実装(`engine/src/search.rs`、コミット6a19815): lazy経路のゲートは `ctx.history.is_none() && lazy_ordering_enabled_for_run()`。history有効時はelse分岐(従来の一括 `ordered_moves(..., tt_move, ctx.history.as_deref(), ...)`)。
- **正当性が崩れる理由(T190仕様より)**: 現行の一括経路はorderingキーのhistory値を「TT手の探索前」に読む。単純にlazy化すると残候補ソートが「TT手のサブツリー探索後」になり、その間のhistory更新がキーに混入して順序が変わる。
- **スナップショットで解決する理由**: history値の読み取り自体は配列参照で安価(合法手は平均10.6〜11.0手)。モビリティ計算(apply_move+legal_moves、こちらが高コスト)と分離し、**history値だけノード入場時に読んで保存**すれば、残候補ソートを遅延しても「現行がその時点で読んだはずの値」と完全に同じキーでソートできる。モビリティは盤面から決まる決定的な値なので、いつ計算しても同じ。
- ordering キー(history有効時): `(is_corner, opp_mobility, Reverse(history))`(`ordered_moves` 内、T190レビューで確認済みの分岐)。
- 残候補の安定ソート部分列同一性(T190で確立した論理)はキー値が同一なら history 有効時もそのまま成立する。
- MPC on の NPS ベンチ(`eval_cli best --enable-mpc`)は history 有効なので、本タスクの効果測定に使える。T188実測では MPC on の fill 8.35%+sort_legal_moves 4.48%+machinery(調整後)17.43%が対象コスト。

## 変更対象

- `engine/src/search.rs` —
  1. lazy経路のゲートから `ctx.history.is_none()` 条件を外し、TT手が合法なら常にlazyへ(テスト用強制スイッチ `TEST_FORCE_LEGacy_ORDERING` 系はそのまま維持)。
  2. lazy発動時、ノード入場時(TT手の子探索を始める前)に `legal` の全ビットについて history 値を読み、スナップショット(固定長配列 `[u32; 64]` 相当、ヒープ確保なし)に保存する。history無効時はスナップショット不要(現行どおり)。
  3. 残候補構築時のソートキーを「snapshot値を使う history 有効版キー」にする。`ordered_moves` にスナップショットを渡すか、残候補構築用の別関数に分けるかは実装判断(いずれもキーのタプル構成・比較順序・安定ソートAPIは現行と同一にすること)。
  4. 従来の一括経路(TT手なし/非合法時)は現行のまま(ordered_moves内でhistoryを直接読む。読み取り時点はノード入場時なのでスナップショットと同値)。

## 要件

1. 探索結果(best_move/score/depth/ノード数)がMPC on/off両方でビット単位不変。**特にhistory有効経路(MPC on・ノード予算経路)でのビット不変が本タスクの核心**。
2. 同一性テスト拡張: T190の `lazy_ordering_matches_legacy_full_construction_across_diverse_midgame_searches` を、history有効のポリシー(enable_history=true相当)でも同一(best_move/score/depth/nodes完全一致)であることを検証するテストに拡張(または並置)。regression-catching実証: スナップショットではなく「残候補構築時点のlive history値」を意図的に読ませる改変で同一性テストが落ちることを確認→復元(これが本タスクの核心的な検知力の証明)。
3. 既存の固定値テスト(t182/t184/t185)がアサート値無改変でパス(t182系はMPC on=history有効を含むため直接の証拠になる)。
4. テレメトリ: history有効経路でのlazy発動数・省略成功数を実測しレポートに記載。
5. NPS計測(標準手順: worktree独立ビルド+交互A,B/B,A×3+専有、20局面バッチ、MPC off/on、ノード完全一致確認)。**MPC onの改善が主目的**(MPC offはT190と同水準の非悪化を確認)。可能なら参考として、ノード予算経路相当(`--max-nodes 160000`等、eval_cliが対応していれば)の1構成も計測して本番経路への効果の傍証とする(未対応なら省略可、レポートにその旨明記)。
6. 採用条件: ノード数完全一致 + MPC onのNPS改善が計測誤差を明確に超えること + MPC off非悪化。

## やらないこと(スコープ外)

- orderingキーの定義変更・近似化
- history更新ロジック自体の変更
- ノード予算経路の enable_history ハードコードの見直し(履歴の有効/無効の是非はT089a採用時の裁定に属する別論点。本タスクは現状の設定のまま速くする)
- `endgame.rs`・評価関数・重み・学習側の変更
- `ANALYSIS_ENGINE_VERSION` のインクリメント(探索結果完全不変のため不要)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(既知フレーキーは単独再実行で切り分け)。
- [ ] t182/t184/t185 固定値テストが無改変でパス。
- [ ] history有効の同一性テストがパスし、「live history読み」への意図的改変で落ちることを確認済み(regression-catching実証、確認後復元)。
- [ ] テレメトリ実測(history有効経路のlazy発動数・省略成功数)がレポートに記載されている。
- [ ] NPS計測: ノード完全一致、MPC on改善・MPC off非悪化。レポート `bench/edax-compare/t191_lazy_history_report.md` + raw JSON をコミット。
- [ ] `cargo test --release -p engine --test ffo_bench` のfast問題が全問正解。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLで対局(CPU強=ノード予算経路)が動作することを確認する。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-22 実装開始。T190コミット6a19815の`negascout`/`ordered_moves`/`HistoryTable`を精読し構造把握。
  - `HistoryTable`に`fn snapshot(&self, side: Side) -> [u32; 64]`を追加(該当sideのscores配列を複製、ヒープ確保なし)。
  - `ordered_moves`のhistoryパラメータを`Option<&HistoryTable>`から新設enum`HistorySource<'a> { Live(&'a HistoryTable), Snapshot(&'a [u32; 64]) }`(`.get(side, mv)`を持つ)経由の`Option<HistorySource>`へ変更。ソートロジック(タプルキー構成・比較順序・`sort_by_cached_key`)は無改変。
  - `negascout`のlazyゲートから`ctx.history.is_none()`を除去(`lazy_ordering_enabled_for_run()`のみに)。
  - lazy分岐(TT手処理)に入る直前、TT手のサブツリー探索(`process_candidate!`)より前に`let history_snapshot = ctx.history.as_deref().map(|h| h.snapshot(side));`を追加。cutoffなしで残候補構築する場合は`history_snapshot.as_ref().map(HistorySource::Snapshot)`を`ordered_moves`へ渡す。
  - else分岐(TT手なし/非合法/lazy無効時の一括構築)は`ctx.history.as_deref().map(HistorySource::Live)`を渡す(まだ候補手を処理していない時点の呼び出しなのでLiveのままで問題なし)。
  - `cargo check -p engine` パス確認。次はテスト拡張(history有効同一性テスト・regression-catching実証)へ進む。
- 2026-07-22 テスト拡張。`engine/src/search.rs`のtestsモジュールへT191新規テスト2件を追加(T190の同種テストの直後、`SearchPolicy { enable_history: true, .. }`版):
  - `lazy_ordering_matches_legacy_full_construction_with_history_enabled_across_diverse_midgame_searches`(絶対条件: lazy/legacy一致、8局面×best_move/score/depth/nodes)
  - `lazy_ordering_activates_and_skips_residual_with_history_enabled_across_diverse_midgame_searches`(テレメトリ発火確認)
  - `cargo test -p engine --lib` 257 passed(新規2件含む、全件green)。`cargo test -p engine`(bin/tests含むフル)も257 passed(ffo_bench等ignoredは既存どおり)。
- 2026-07-22 regression-catching実証(タスク核心の検知力証明)。残候補構築の`ordered_moves`呼び出し(lazy分岐内)へ渡す第5引数を、意図的に`history_snapshot.as_ref().map(HistorySource::Snapshot)`から`ctx.history.as_deref().map(HistorySource::Live)`(=ノード入場時点のスナップショットではなく、TT手のサブツリー探索が完了した後の残候補ソート実行時点のライブhistory値)へ改変。
  - 結果: `lazy_ordering_matches_legacy_full_construction_with_history_enabled_across_diverse_midgame_searches`が`n=5: nodes differs between lazy and legacy ordering (history enabled) left: 4409 right: 4408`で確実に失敗することを確認(検知力の証明)。
  - 直後にスナップショット渡し(`history_snapshot.as_ref().map(HistorySource::Snapshot)`)へ復元し、`cargo test -p engine --lib`で257 passed(0 failed)を再確認。
- 2026-07-22 `cargo test --release -p engine --test ffo_bench -- --nocapture`実行: fast問題(#40〜#44)5問全問正解(FAST TOTAL: 5 positions solved correctly, nodes=641077417, time=59.196s, nps=10829742)。次はNPS計測(worktree independent build)へ進む。
- 2026-07-22 NPS計測(標準手順)。
  - `git worktree add ../t191-worktrees/before 29a9c12`(T191着手直前のHEAD)で変更前を独立チェックアウトし、`cargo build --release --bin eval_cli --features mpc_enabled`を独立ビルド(SHA256差異確認: before=`26301bc0...`, after=`e52686da...`)。実行前に`tasklist`でcargo/rustc/eval_cli/pythonが動いていないことを確認(専有)。
  - scratchpadにPythonドライバ`t191_nps_bench.py`(MPC off/on)・`t191_nps_bench_nodebudget.py`(node-budget参考条件、`--max-nodes 160000`)を作成し、`bench/edax-compare/t156_mpc_positions.json`のsplit==test・emptyBucket==29-36先頭20局面(`mpc-29-36-test-001..020`)で、before/after順序を入れ替えながら3ラウンドずつ実行。
  - 結果: MPC off before=2,153,488 NPS→after=2,145,857 NPS(-0.35%、非悪化)。MPC on before=1,813,587→after=1,923,115 NPS(**+6.04%**)。node_budget(参考、`--max-nodes 160000`、本番経路相当)before=1,860,134→after=2,120,689 NPS(**+14.01%**)。3条件×3ラウンド=9ラウンドすべてでbefore/afterのノード数完全一致(mismatch=0、20局面×3条件×3ラウンド=180局面回)。
  - `git worktree remove ../t191-worktrees/before --force`でworktree削除・`git worktree list`でmainのみに戻ったことを確認。
  - テレメトリ: `lazy_ordering_activates_and_skips_residual_with_history_enabled_across_diverse_midgame_searches`実行(`--nocapture`) → activations=19423, residual_skipped=12848(66.1%)。
  - `bench/edax-compare/t191_lazy_history_report.md`+`.raw.json`を作成(T190レポート同形式、実装内容・regression-catching実証・テレメトリ・NPS実測・採用判定を記載)。
  - `git status --short`確認: `engine/src/search.rs`(M)・`bench/edax-compare/t191_lazy_history_report.md`(??)・`.raw.json`(??)のみ(tasks/T191自体を除く)。次はこれらをパス明示でコミット・pushし、GitHub Actionsデプロイ確認・Pages動作確認へ進む。
- 2026-07-22 コミット・push・デプロイ確認。
  - `git add engine/src/search.rs bench/edax-compare/t191_lazy_history_report.md bench/edax-compare/t191_lazy_history_report.raw.json`(パス明示、`git add .`不使用)でコミット: `93986f6`「engine: lazy orderingをhistory有効経路へ拡張(historyスナップショット方式、T191)」。
  - `git push origin main`成功(`29a9c12..93986f6`)。
  - `gh run watch`でDeploy to GitHub Pages(ID 29909290647)・Rust Tests(ID 29909290664)の両ワークフローが`success`で完了したことを確認(Rust Testsは`cargo test -p engine`(debug)・`--release --test ffo_bench`(FFO fast)・`cargo test -p train`を含む)。
  - Playwright MCP(Claude Browser)で本番Pages(`https://giwarb.github.io/othello-trainer/`)を開き、「対局」→CPUの強さを「強い (depth12)」(本番のノード予算経路、`enable_history: true`)に設定→黒番で開始→d3を着手→CPU(白)が自動応手し評価値・定石名(牛)・盤面が正しく更新される(3-3)ことを確認。`read_console_messages`でエラー0件。
  - `git status --short`最終確認: `tasks/T191-lazy-ordering-history.md`(作業ログ追記分)のみが残存(コミット対象外、オーケストレーター担当)。当該タスク由来のスコープ内差分・未追跡ファイルは残っていない。

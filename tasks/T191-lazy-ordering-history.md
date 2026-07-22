---
id: T191
title: 高速化(10): lazy orderingのhistory有効経路への拡張(historyスナップショット方式)
status: in_progress
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

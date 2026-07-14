---
id: T089a
title: 探索改善 — history heuristic + aspiration window(fixed-depth完全一致ゲート付き)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T089a: history heuristic + aspiration window

## 目的

固定ノード予算(160k)での実効探索深さを上げる。ムーブオーダリングに history heuristic を、反復深化に aspiration window を導入する。**探索結果(best move/score)は full-window 基準と完全一致が必須**(結果を変えずにノードを減らす施策)。

## 委譲体制の注記(重要)

本来は難易度ルーティングで Codex(gpt-5.6-sol)対象だが、Codex利用上限(〜7/20)のため implementer(Sonnet)へのフォールバック委譲(ユーザー承認済み 2026-07-14)。そのぶん本仕様は通常より詳細に書いてある。**仕様に無い設計判断が必要になったら、推測で進めず作業ログに選択肢を書いて停止し完了報告せよ**。過去の教訓(T084: フォールバック経路の考慮漏れで対局80%が壊れた)から、**「探索結果が変わらないこと」のテストを実装より先に書く**こと。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§7(T089a)**。
- 関連コード: `engine/src/search.rs`(NegaScout本体・ordered_moves・反復深化ループ・`search_with_eval_inner`)、`engine/src/tt.rs`(T086で品質置換済み)、`engine/src/endgame.rs`(**変更禁止**)。
- 前提(T085/T086で確立済み): ノード予算探索(`max_nodes`、1024粒度チェック、決定論)、baseline-first、exact quota 40%、TTドメイン分離・品質置換。
- ベンチ: `eval_cli budget-regression`(48局面)、`bench/edax-compare/vs_edax.py`(resume厳格化済み)、固定openingマニフェスト。

## 要件(設計書§7が規範)

### history heuristic

1. `(side, move)` の表: 手番2×64マスの u32(または飽和加算できる型)テーブルを探索コンテキストに持つ(グローバル/static禁止。`SearchContext`相当の構造体メンバーにする)。
2. beta cutoff 発生時に `depth * depth` を加算。
3. **root探索(反復深化の各イテレーション開始)ごとに全値を半減**(>>1)して飽和と古い情報の残留を防ぐ。
4. ムーブオーダリングでの位置は2構成をablationする: (A) 既存の corner優先→相手mobility少 の**後**のタイブレークとして history 降順 (B) corner優先の後、mobilityより**前**に history。固定ノード予算48局面コーパス(budget-regression)で完成深さ中央値・ノード数を比較し、良い方を採用(結果は作業ログに記録)。
5. **TT move は常に最優先**(既存挙動を維持)。
6. **exact solver(endgame.rs)には適用しない**(終盤の着手順は現状のまま。FFOノード数を変えないため)。

### aspiration window

7. 反復深化で depth>=2 のイテレーションは、前イテレーションの score を中心に **初期窓 ±200 centi-disc(±2石)** で探索する。fail-low/high したら窓を ±400 → ±800 → ±1600 → full window と広げて**必ず再探索**する(fail方向だけ広げる実装でもよいが、最終的に true score が窓内に入るまで繰り返すこと)。
8. **最終的な score / best move は full-window 探索と完全一致**すること(aspirationは高速化のみで結果を変えない)。fail時の再探索で TT に入った半端な bound が結果を汚染しないことに注意(T086の品質置換が深いExact/boundを保護するが、同深度の弱いboundの扱いを確認せよ)。
9. exact試行・終盤経路には適用しない(中盤NegaScoutの反復深化のみ)。MPCは引き続きOFF。
10. aspiration の fail/再探索回数をテレメトリに追加(`aspirationFailLow`/`aspirationFailHigh`等、`SearchResult`と`eval_cli best`)。

### 決定性の維持(絶対条件)

11. `max_nodes` 経路の決定論を壊さない: history表は探索開始時にゼロ初期化(前回探索の状態を持ち越さない。Workerの常駐Engineでも同一入力→同一出力を維持)。ノードカウントのチェック粒度(1024)も不変。

## やらないこと(スコープ外)

- endgame.rs(終盤ソルバー)の変更
- killer moves・null move・MPC再有効化・hot path最適化(T089b)
- 評価関数・学習(T087/T088で確定済み)
- アプリ/Workerプロトコルの変更(テレメトリのJSON追加フィールドは protocol.rs 経由で自然に増える範囲のみ可)
- TT置換規則の変更(T086で確定済み)

## 受け入れ基準(検証コマンド)

- [ ] **(最重要)fixed-depth完全一致**: 既存の fixed-depth 回帰テスト(`fixed_depth_*_unchanged_*`)が**無変更でパス**し、さらに新テスト「同一局面集合(最低40局面)で aspiration+history 有効時と full-window(両機能無効)時の best move/score が全件一致」を追加してパスする
- [ ] `cargo test -p engine` 全件パス
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 正解値・**ノード数完全不変**(合計 1,298,656,784。exact solver非適用の確認)
- [ ] `eval_cli budget-regression --manifest bench/edax-compare/t085_exact_positions.json --max-nodes 240000 --time-ms 1500 --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin` が deterministic:true(2回実行一致)
- [ ] **性能ゲート(設計書§7)**: 上記48局面で「完成深さ中央値が+1」または「中央値ノード数20%減」(タスク前基準を最初に計測して作業ログに記録してから実装すること)。aspiration再探索率も記録
- [ ] ablation(history位置A/B)の比較数値と採用判断が作業ログにある
- [ ] `python bench/edax-compare/vs_edax.py --opening-set primary --engine-modes single-root --levels 10 --engine-max-nodes 160000 --engine-time-ms 1500 --node-check-max-nodes 160000 --skip-fixed-depth --skip-loss-analysis --results-output bench/edax-compare/t089a_primary_results.json --report-output bench/edax-compare/t089a_primary_report.md` の60局で、T085b基準(4勝2分54敗・平均-29.067)から**平均石差の重大退行なし**(悪化3石以内。改善が出れば記録)
- [ ] 変更対象ファイルのみをパス指定でコミットし、mainへpush、Actionsデプロイ成功確認(アプリ挙動には影響しないはずだがWASMは再ビルドされる)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

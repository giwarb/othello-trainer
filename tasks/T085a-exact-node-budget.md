---
id: T085a
title: exact切替とノード数予算管理の再設計(TTドメイン分離・baseline-first・exact quota・テレメトリ拡張)
status: todo        # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T085a: exact切替とノード数予算管理の再設計

## 目的

Edax level 10 攻略ロードマップの最初の実装タスク。T084のテレメトリで判明した最大の弱点 —— **空き20〜24帯で探索が崩壊し実質depth 3で着手している(タイムアウト率100%)** —— を、exact試行の予算制御と「常に完成済み反復深化結果を保持する」構造で解消する。あわせて、ユーザー方針である**ノード数予算ベースの決定論的な探索制限**を対局・ベンチ経路の主制限として実装する。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§1(T085a)** が本タスクの詳細仕様。**§1.2〜§1.10 を規範として実装すること**。§4(T086)・§2(T085b)・§3(T085c)は本タスクのスコープ外(ただし§1.2のTTドメイン分離だけは本タスクに含まれる)。
- 現状の問題(同レポート§1.1): exact試行が反復深化の完成前に全予算を消費する/exact失敗時に完成済み中盤結果が無い/木内部のexact失敗がイテレーション全体を破棄する/中盤TT(centi-disc)とexact TT(生石差)が同一hash空間に混在/`exactAttempted`がルート条件のみで実態が見えない。
- 関連コード: `engine/src/search.rs`(`search_with_eval_inner`、時間・ノードチェック)、`engine/src/endgame.rs`(`solve_exact_*`系)、`engine/src/tt.rs`、`engine/src/bin/eval_cli.rs`(`best`サブコマンド、T084で追加)。
- T084で整備済み: `--max-nodes`(決定論、1024ノード粒度)、合法手フォールバック、テレメトリ(depth/nodes/elapsedMs/exactAttempted等)、固定openingマニフェスト。
- ユーザー方針: ノード数予算が主制限、壁時計は普段発動しない保険(推奨1500ms)。実測NPSを切替条件に使わない(決定性が壊れる。設計書§1.5・§1.8)。

## 変更対象

- `engine/src/tt.rs` — TTドメイン分離(`TTDomain::{Midgame,Exact}`、probe/storeのdomain一致確認)。※置換規則の品質改善(設計書§4)はT086なのでやらない
- `engine/src/search.rs` — baseline-first実行順序(設計書§1.3)、exact quota(§1.4、初期60%だが§1.4の目的関数で25/40/60/75%を比較して選定)、`AbortReason`(ExactQuota/GlobalNodeLimit/WallClock)、動的exact切替の上限条件(§1.5、空き数別推定コストp75表)、木内部exact失敗の中盤続行(§1.6)、親αβ窓のexact引き継ぎ(§1.7、floor_div_100/ceil_div_100)、テレメトリ拡張(§1.9)
- `engine/src/endgame.rs` — `solve_exact_window_limited_with_nodes`等の新API(§1.7)、打ち切り理由の構造化
- `engine/src/bin/eval_cli.rs` — `best`のテレメトリ拡張(§1.9の全フィールド)、`budget-regression`サブコマンド(§1.10)
- `bench/edax-compare/t085_exact_positions.json` — 空き13〜30の固定局面コーパス(新規。openingマニフェストからの対局で到達した局面等から機械的に抽出し、生成方法をコメント/manifestに記録)

## 要件(設計書§1が規範。以下は要点)

1. **正解値経路の不変**: 無制限探索・FFO・詰めオセロ等「正解値が必要な経路」は従来どおり即時完全読み。新しい予算分割は `max_nodes.is_some()` の経路に限定(設計書§1.3)。
2. **TTドメイン分離**(§1.2): Midgame/Exactをprobe/storeで区別。hashへのsalt xorは禁止(FFOノード数を不必要に変えない)。必須テスト5件(§1.2末尾)を実装。
3. **baseline-first**(§1.3): depth1をexact無効で完走→`last_completed`保持→残予算でexact試行判断→quota切れなら中盤探索続行→予算到達で`last_completed`を返す。校正済み通常予算でdepth0を発生させない。
4. **exact quota**(§1.4): 打ち切り理由を`AbortReason`で区別。ExactQuotaはそのexact試行のみ中止、GlobalNodeLimit/WallClockはイテレーション破棄+`last_completed`返却。
5. **動的exact切替**(§1.5): `empties <= exact_from_empties かつ exact_remaining_nodes >= estimated_min_nodes[empties]`。推定コスト表は固定局面コーパスの実測p75から生成(コードに定数として焼き込み、生成手順をコメントに記録)。
6. **窓付きexact**(§1.7): 木内部は親窓を石差に安全丸め(floor/ceil専用実装、負数のゼロ方向丸めに注意)して渡す。`is_exact=true`はfull-window完走時のみ。
7. **テレメトリ**(§1.9): `requestedMaxNodes`〜`exactPolicyVersion`の全フィールドを`SearchResult`と`eval_cli best`に追加。実際の探索イベントから数える。
8. **完了ゲート**(§1.10): 機能ゲート7項目・性能ゲート5項目をすべて満たす。特に「空き19〜24固定コーパスで`loss>=4石`率20%以上削減 or 平均oracle regret 15%以上削減」「序中盤の平均regret悪化0.25石以内」「決定性(同一max-nodesで2回完全一致)」。
9. **`budget-regression`サブコマンド**(§1.10): 固定コーパスに対し決定性・nullMoveWithLegal=0・staticOnly=0・budgetOvershootMax<=1024 をJSONで報告する回帰CLI。
10. **T084 codex-review申し送りの回帰テスト追加**(`tasks/review/T084-bench-single-root-telemetry-codex-review.md` 中所見1): T084の実障害経路 —— `--time-ms` 指定で exact 試行が時間切れになり depth1 も完走しない場合に、`best_move` が `None` にならず合法手が返る —— を**壁時計経路で直接固定するテスト**を `engine/src/search.rs` に追加する(既存テストは `max_nodes=1` 打ち切りのみ検証)。決定論性を保つため、テストでは極小の時間予算+重い終盤局面を使うか、時間切れを注入できるテストフックを検討してよい。

## やらないこと(スコープ外)

- TT置換規則の品質改善(深度保護・Exact優先・品質probe)= T086(設計書§4)
- ノード予算値の校正・ベンチでの候補比較・採用判定 = T085b(§2)。本タスクでは仮値(例: 240000)でよい
- `bench/edax-compare/vs_edax.py` のresume判定厳格化(エンジン/バイナリidentity込み)・チェックポイントのアトミック書き込み = T085b の前提修正として実施(T084 codex-reviewブロッカー1・中所見2の申し送り。本タスクでは vs_edax.py を触らない)
- アプリ/Workerプロトコルへの配線 = T085c(§3)。`app/`配下・`protocol.rs`のアプリ向け変更は禁止(eval_cliのみ)
- history/aspiration/hot-path最適化 = T089
- MPC・評価関数・学習の変更
- 120局対戦ベンチの実行(T085bで実施)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(新規テスト含む)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 の正解値不変(ノード数もT084時点と比較し、TTドメイン分離による意図しない変化がないこと。変化がある場合は原因を作業ログで説明)
- [ ] `eval_cli best --depth 10 --max-nodes 240000 --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin` を空き19〜24の局面で実行し、`staticOnly=false`・`lastCompletedDepth>=4`・新テレメトリ一式が返る
- [ ] `budget-regression`(設計書§1.10のコマンド形式)が `deterministic:true, nullMoveWithLegal:0, staticOnly:0, budgetOvershootMax<=1024` を出力する
- [ ] 空き19〜24固定コーパスで性能ゲート(§1.10: loss>=4石率20%減 or 平均regret15%減、序中盤regret悪化0.25石以内)を満たす数値を作業ログに記録
- [ ] fixed-depth・時間なし探索のbest move/scoreがタスク前と不変(既存回帰テスト)
- [ ] 要件10の「exact時間切れ→合法手フォールバック」直接回帰テストが追加され、パスしている
- [ ] コミット対象ファイル一覧が最終メッセージに明記されている(Codexワーカーはコミット不可のため、コミット・push・Actions確認はオーケストレーター代行後にverifierが確認)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

---
id: T084
title: ベンチ補正: single-rootベストムーブ探索の導入 + テレメトリ + オラクルロス修正 + 固定openingマニフェスト
status: todo        # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T084: ベンチ補正: single-rootベストムーブ探索の導入 + テレメトリ + オラクルロス修正 + 固定openingマニフェスト

## 目的

エンジン強化(Edax接近)ロードマップの最優先タスク。T082で構築したEdax対戦ベンチには「原因分析に使えない」計測上の欠陥があることが設計レビュー(`tasks/design/T083-engine-strengthening-report.md`、必読)で判明した。本タスクでこれを補正し、**以後の全施策(T085〜T090)の採否判定に使える標準ベンチ**を確立する。

最重要の発見: 現行の対局経路は `search_all_moves`(全合法手を個別にfull-window探索し、時間予算を候補数で公平分割)を使っており、1候補あたり約100msしか探索していない。**単一ルートのPVS探索(反復深化+TT最善手を活かす通常経路)で1秒使った場合の実力はまだ一度も測られていない**。

## 背景・コンテキスト

- 設計レポート `tasks/design/T083-engine-strengthening-report.md` の「T084」セクションが本タスクの仕様の出典。必ず全文を読むこと。
- 既存ハーネス: `bench/edax-compare/vs_edax.py`(T082、作業ログ `tasks/T082-vs-edax-match-harness.md` に実装経緯と踏んだバグ3件の記録)。着手選択は `eval_cli moves`(= `search_all_moves_with_eval`)を使用中。
- エンジン: `engine/src/search.rs` に単一ルートの `search`/`search_with_eval`(反復深化+NegaScout+TT)が既にあり、`SearchResult` を返す。`eval_cli`(`engine/src/bin/eval_cli.rs`)には現在 `gen`/`eval`/`moves`/`apply` サブコマンドがある。
- T082の既知の問題(レポート指摘):
  - 開始局面が10種のみ・一様ランダム進行(定石スイートでない)、固定seedでも実行間で勝敗が揺れる(壁時計依存)。
  - 到達深さ・ノード数・タイムアウト・exactフォールバックがJSONに残らず、敗因を探索/評価に分解できない。
  - 弱点分析のロスが「着手前後の別探索の差」のため345件中95件が負値(オラクル不成立)。
  - phase集計が開始局面からのply数ベースで実ゲーム手数と8〜12手ずれる。
- CLAUDE.md「長時間実行タスクの運用ルール」(2026-07-13追加)を厳守: 1局/1分析単位のチェックポイント逐次保存、resume機能、進捗の逐次ログ出力。

## 変更対象

- `engine/src/bin/eval_cli.rs` — single-rootベストムーブ+テレメトリを返す新サブコマンド `best` の追加
- `engine/src/search.rs` — テレメトリ公開のための**最小限の**変更(探索挙動は変えない。ノード数等が既に内部にあるなら公開のみ)
- `bench/edax-compare/vs_edax.py` — 着手選択のsingle-root化(旧allMoves方式もオプションで温存しA/B可能に)、テレメトリ記録、オラクルロス修正、1局単位チェックポイント+resume、固定openingマニフェスト対応
- `bench/edax-compare/openings.json`(新規) — 固定openingマニフェスト
- `bench/edax-compare/vs_edax_report.md` / `vs_edax_results.json` — 再生成

## 要件

1. **eval_cli `best` サブコマンド(single-root)**: 単一局面を受け取り、`search_with_eval`(反復深化・時間予算・パターン重み対応)で最善手を1回の探索で決める。応答JSONに最低限以下のテレメトリを含める: 選択手、score(値と type=exact/midgame/static)、到達深さ、総ノード数、経過ms、タイムアウト有無、exact読みの試行/完走/フォールバックの別、NPS。`search.rs` 側に必要な情報が無ければ最小限の計測フィールドを追加する(**探索アルゴリズム自体の挙動は一切変えない**こと。fixed-depth時の探索結果がタスク前後で不変であることをテストで担保)。
2. **決定性モード**: `--depth N`のみ(時間予算なし・fixed-depth)で実行した場合、同一局面・同一重みなら着手・スコア・ノード数が完全再現されること(壁時計チェックが結果に影響しない設計を確認。時間予算未指定なら時間切れ経路に入らないはず)。
3. **vs_edax.py の対局経路をsingle-rootに変更**: 着手選択を `eval_cli best`(1秒wall-time)に切り替える。旧 `moves` 方式(候補分割)も `--engine-mode allmoves` 等のオプションで残し、**同一予算(1秒)でのsingle-root vs allmovesの直接比較**(同一opening・同一レベル、各20局)を実行してレポートに載せる。
4. **系列の分離**: wall-time系列(1秒)とfixed-depth系列(`--depth 8` 等、決定性・回帰検知用)を別の実行モードとして持つ。fixed-depth系列は2回連続実行して全着手・全ノード数が一致することを確認する。
5. **固定openingマニフェスト** `openings.json`: 決定的に固定された開始局面(8〜12手目相当)を**30ペア(=60局分)+スモーク用10ペア(=20局分)**以上収録(生成方法は既存 `eval_cli gen` のseed固定でよいが、生成結果をファイルとしてコミットし、以後は再生成せずファイルを読む)。各局面にIDを付与。20局スモーク/60局一次判定/100〜200局追加、の判定プロトコル(レポート「対局数の使い分け」)に対応できる構成にする。
6. **テレメトリの保存**: `vs_edax_results.json` の各手レコードに要件1のテレメトリ一式+局面の実手数(初期局面からの通算ply。openingの手数を含めた真のゲームフェーズ)を保存する。フェーズ別集計は実手数ベースに修正。build情報(gitハッシュ)と重みファイルのハッシュも実行メタデータとして保存。
7. **オラクルロスの修正**: 弱点分析のロスを「同一局面の全合法手それぞれの着手後局面をEdax同一レベル(16)で評価し、`loss = max(全子の値) - (選択手の子の値)`」方式に変更する(常に非負)。全件 `loss >= 0` を機械検証する。
8. **チェックポイント/resume(CLAUDE.md長時間実行ルール準拠)**: 1局ごと・弱点分析1局面ごとにチェックポイント保存。起動時に既存チェックポイントを読み完了済み分をスキップ。進捗(何局目/何局中)を逐次stdoutまたはログファイルに出力。
9. **ベンチ再実行**: 新ハーネスで (a) single-root 1秒 vs Edax level 10/5/1 各20局(固定opening使用)、(b) allmoves 1秒 vs 同レベル各20局(要件3の比較用)、(c) 負け局の修正版弱点分析、を実行し、`vs_edax_report.md` を新フォーマットで再生成する。レポートには「single-root化による変化」の考察を含める。
10. コミットは変更対象ファイルのみをパス指定で行い、mainへpushしてGitHub Actionsの成功を確認する(アプリ本体に変更がないためPages上の機能確認は不要。ただし`engine/src`を触るため既存テストとFFOに回帰がないこと)。

## やらないこと(スコープ外)

- 探索アルゴリズム・評価関数の改善(exact切替の改善=T085、TT置換規則=T086、パターンv3=T087等。本タスクは**計測の正しさ**のみ)
- `app/` 配下の変更(アプリのCPU対局をsingle-root化する配線は、T085完了後の別タスクで行う)
- Edax教師データの大量生成(T090)
- MPC・アスピレーション・history等の探索機能追加(T089)
- 統計的検定(cluster bootstrap等)の実装は任意(60局の勝敗と平均石差の単純集計で足りる。余力があれば色交換ペアを1クラスタとするpaired集計を追加してよい)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(既存テストへの回帰なし)
- [ ] FFO #40-44 の正解値・ノード数がタスク前と不変(fixed-depth/exactの探索挙動を変えていない証拠。`cargo test -p engine --release -- ffo` 等、既存のFFOテストの実行方法はT009/T051の作業ログ参照)
- [ ] `eval_cli best` がテレメトリ一式(要件1)を返す(verifierが任意局面で実行し確認)
- [ ] fixed-depth系列を2回実行し、全局・全着手・全ノード数が完全一致する(要件2・4)
- [ ] 修正版弱点分析のロスが全件 `>= 0`(要件7、JSONの機械検証)
- [ ] `bench/edax-compare/openings.json` がコミットされ、スモーク20局分・一次判定60局分のopening IDが固定されている
- [ ] 新 `vs_edax_report.md` に (i) single-root vs allmoves の同予算比較、(ii) レベル別勝敗(single-root)、(iii) テレメトリに基づく集計(到達深さ分布・exactフォールバック率・実手数ベースのフェーズ別ロス)が含まれる
- [ ] 対局実行が1局単位のチェックポイント+resumeに対応している(verifierが途中killして再開し、完了済み局が再実行されないことを確認)
- [ ] 変更がmainにpushされ、GitHub Actionsが成功している
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

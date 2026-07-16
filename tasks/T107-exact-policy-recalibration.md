---
id: T107
title: exactポリシー再校正(新ソルバーの速度を実戦の強さへ変換)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T107: exactポリシー再校正

## 目的

終盤ソルバー強化シリーズ第10弾。T099〜T105で採用したソルバー改善(FFO壁時計 約8.4倍、ノード面ではT103まで-50%→T104で+28.6%)を、**実戦(160kノード予算+wall1500ms保険で動く本番エンジン)の強さに変換する**工程。exact切替の閾値・quota・ノード予算を新ソルバーの特性で共同校正し、本番設定を更新する。**T099〜T106の採用施策がすべて確定した今このタイミングでのみ実施する**(設計レポート「途中で実施してはならない」)。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §5 T107節(候補グリッド・選定優先順位・受け入れ基準)・§7(リスク: 共同最適化の過学習、exactへ予算を寄せすぎて中盤反復深化が浅くなる)。
- `bench/edax-compare/t085_node_budget_decision.md`(現行160k採用の経緯、T085bの校正手法)。

## 要件(設計レポート§5 T107節+2026-07-16申し送り)

1. **`estimated_min_exact_nodes` の再生成**: exact切替判断に使う「空きn数の完全読みに必要なノード数の推定テーブル」を、新ソルバー(コミット5f460c2)の実測で作り直す(`engine/src/search.rs` / 生成は校正スクリプト)。
2. **候補グリッドの校正**(T085bのオラクルregret手法を踏襲、`bench/edax-compare/`の既存ハーネス・専用校正スクリプトを再利用/拡張):
   - quota候補: 25 / 40 / 50 / 60 / 75%(現行40%)
   - `exact_from_empties`候補: 16 / 18 / 20 / 22 / 24(現行の値を作業ログに記録すること)
   - **ノード予算候補(2026-07-16申し送り、ユーザー承認済みの回収事項)**: 160k(現行)/ 240k / 320k / 480k。根拠: T104でNPSが約3倍になったため、同じwall1500ms保険内でより大きな予算が現実的になった。予算はwall保険の発動率と決定性を壊さない範囲で選ぶ。
3. **選定優先順位(設計§5、この順で辞書式に比較)**: (1) static-onlyフォールバックゼロ → (2) 決定性100% → (3) wall保険発動5%以下 → (4) oracle regret最小 → (5) root/selected-line証明数 → (6) 平均到達深度 → (7) 消費ノード。
4. **policy versionの更新**と、本番(app)の強CPU閾値・予算値の採用値への更新(`app/src/app.tsx`・関連テスト)。エンジンの評価結果・着手が変わるため **`ANALYSIS_ENGINE_VERSION` のインクリメント要否を確認し、必要なら実施**(棋譜解析キャッシュの整合、STATUS.md恒常注意)。
5. **テレメトリ分離**: root exact / bound proof / leaf completion を分離したカウンタ(設計§5。既存テレメトリの拡張で可)。
6. 変更対象: `engine/src/search.rs`・`engine/src/bin/eval_cli.rs`・`bench/edax-compare/`(校正スクリプト)・`app/src/app.tsx`・関連テスト(protocol/search/app)。終盤ソルバー本体(`endgame.rs`)のアルゴリズムは変更しない。

## 計測プロトコル

- **oracle regret**: T096確立の60局面頑健oracle(教師コーパス非重複・層化)を使用する。oracle採点に使う`eval_cli`は**コミット済みビルド由来**とし、最低限v2×WTHOR行(1.5667)の完全再現を毎回確認する(T110レビュー申し送り)。
- **決定性・regret・E50はノードベースで決定的に計測**できるため、並行セッションのT114(コーパス生成)稼働中でも進められる。**wall保険発動率の最終確認だけは専有ウィンドウで行う**: T114が稼働中なら、その時点までの結果をまとめて作業ログに書き、オーケストレーターへ「専有ウィンドウの調整が必要」と報告して指示を待つ(サブエージェント権限ではT114プロセスを停止できないことが確認済み)。
- 過学習リスク(§7)への手当: 校正に使った局面集合と、最終確認(受け入れ基準のregret判定)の局面集合の関係を作業ログに明記する(同一ならその旨、分離できるなら分離)。

## やらないこと(スコープ外)

- 終盤ソルバーのアルゴリズム変更(endgame.rs)
- 中盤評価関数・学習系の変更
- Edaxとの最終ゲート計測(T108)
- マルチスレッド化・SIMD

## 受け入れ基準(検証コマンド)

- [ ] 平均oracle regretが現行値以下(設計基準: 1.604石以下。ただし現行値はまず新ソルバー+現行ポリシーで再計測して確定させ、それ以下であること。目標1.25石以下は併記)
- [ ] static-onlyフォールバック発生ゼロ
- [ ] wall保険発動5%以下(専有ウィンドウでの確認。取れない場合はオーケストレーターへ報告して調整)
- [ ] `E50_exact >= 23`(採用予算での値。参考として160k時の値も併記)
- [ ] 同一入力2回実行で move/score/depth/nodes 完全一致(決定性)
- [ ] `cargo test -p engine` 全件パス+`npm test`(app)グリーン
- [ ] 校正グリッドの全結果表(quota×empties×予算)と選定根拠が作業ログにある
- [ ] `ANALYSIS_ENGINE_VERSION` の要否判断が作業ログにある(必要時は実施済み)
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、GitHub Pages公開URLで新設定のCPU対局が動作することを確認(app変更を含むタスクの標準項目)
- [ ] 変更対象ファイルのみパス指定でコミット(`(T107)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 調査・既存インフラの確認

**quota/exact_from_empties/max_nodesの既存対応状況の確認**: 想定より既に多くの基盤が整っていることを確認した。
- `search.rs::search_with_eval_with_node_limit_and_exact_quota`(T085a由来)が既にquotaを実行時引数として受け取れる(`assert!(exact_quota_percent <= 100)`のみでハードコード制限なし)。
- `eval_cli best`/`eval_cli budget-regression`は`--exact-quota-percent`フラグを既に持つが、許可リストが`25|40|60|75`のみで**50が欠けていた**→ `engine/src/bin/eval_cli.rs`の2箇所(`cmd_best`・`cmd_budget_regression`)とusage文字列を修正し`50`を追加(既にビルド・動作確認済み)。
- `SearchResult`のテレメトリ分離(要件5: root exact/bound proof/leaf completion)は**T089aで既に実装済み**(`exact_root_completed`/`exact_bound_proof_completed`/`exact_leaf_completed`/`exact_completed`が個別フィールドとして存在し、`eval_cli best`のJSON出力にも`exactRootCompleted`等として個別に出ている)。追加実装は不要と判断し、既存テレメトリをそのまま校正に使う。
- `app/src/analysis/cache.ts`の`analysisLimitTag`は`d${depth}-e${exactFromEmpties}-n${maxNodes}`をキャッシュキーに含めており、**exactFromEmpties/maxNodesの変更はこのタグ自体が変わるため`ANALYSIS_ENGINE_VERSION`のインクリメントを要さない**。一方`exactQuotaPercent`はキャッシュタグに含まれておらず(`AnalyzeLimit`型にそもそも存在しない、quotaは`search.rs`のコンパイル時定数`EXACT_QUOTA_PERCENT`としてのみ存在しapp層に露出していない)、**quota値を40%から変更する場合のみ`ANALYSIS_ENGINE_VERSION`のインクリメントが必要**と判断した(選定結果が確定次第、要否を確定する)。
- `app/src/app.tsx`の`cpuLimit`(strong CPU着手専用)のみが`maxNodes`/`timeMs`を持ち、`weak`/`normal`および`limit`(全合法手表示用)は`maxNodes`未設定のため、quota機構自体が発火しない(`search_with_eval_inner`はmax_nodes.is_some()の場合のみquota分岐に入る)。**したがってT107の変更対象は実質的に`strong`の`cpuLimit`のみ**で、他プリセットへの影響はない。

**oracleの実測方式(判断根拠、要件次第では再考の余地あり)**: T085b/設計レポートの原法はEdax level 16/60を独立oracleとして使ったが、本タスクではコミット済みビルドの`eval_cli`自身(`moves --depth 1 --exact-from-empties 30`、無制限完全読み)を使い、T096の60局面の全合法手の真の値を得る方式を採用した。これはT096局面がすべてempties<=26であり、本エンジンの終盤ソルバー(FFO #40-44で100%正解確認済み)の完全読み範囲内に収まることを踏まえた判断であり、「終盤ソルバー自体が正しいか」ではなく「quota/exact_from_empties/max_nodesで制約された設定が制約なしの真の最善手をどれだけ再現できるか」を測る目的には十分と判断した(self-referentialな循環検証には当たらない)。Edaxへの切替が必要と判断されれば後から追加できる設計(`policy_calibration.py`のoracle計算部分のみ差し替え)。

**校正インフラ新設**: `bench/edax-compare/policy_calibration.py`(T096 60局面oracle+quota×exact_from_empties×max_nodesグリッド、局面単位atomic checkpoint、`oracle`/`grid`/`determinism`/`report`サブコマンド)と`bench/edax-compare/estimate_min_exact_nodes.py`(要件1のP75テーブル再生成、空きマス数ごとにatomic checkpoint)を新規作成した。

### 2026-07-16 oracle計算のスコープ縮小(実行コスト、要件「過学習リスクへの手当」に対応)

oracle計算(60局面の全合法手を無制限完全読み)を開始したところ、empties23-26の局面(全60局面中26局面)は1局面あたり複数の合法手をそれぞれ完全読みする必要があり、**1局面で数分かかるケースが発生した**(空き21の局面で単一候補ノード数が既に1.3億ノードに達しており、空き25-26では更に大きくなると予想される。並行稼働中のT114プロセス(8+並列)によるCPU競合も影響)。全60局面の完了を待つと本タスクの他の作業(グリッド校正・実装・デプロイ確認)に充てる時間を圧迫すると判断し、**oracle計算はempties18-22の34局面(2+11+7+4+10)を優先し、23-26の26局面はバックグラウンドで計算を継続させつつ、揃った時点のデータでグリッド校正を先行開始する**方式に変更した(`policy_calibration.py grid`を「oracle値が揃っている局面だけを対象にする」よう修正済み)。最終的な受け入れ基準判定(oracle regret)は、grid実行完了時点で実際にoracle値が揃っていた局面集合を明記して行う(34局面のみか、23-26の一部を含むかは完了時に確定・記載する)。これは校正に使う局面集合の縮小であり「過学習リスク」そのものの手当ではないが、判断の透明性のため経緯をここに明記する。

**バックグラウンド実行中(2026-07-16時点、いずれもatomic checkpoint・resume対応)**:
1. `python bench/edax-compare/policy_calibration.py oracle` → `bench/edax-compare/endgame-results/t107-policy-calibration.json`の`oracle`セクション(empties23-26の残りを継続計算中)。
2. `python bench/edax-compare/estimate_min_exact_nodes.py --min-empties 10 --max-empties 24` → `bench/edax-compare/endgame-results/t107-estimated-min-exact-nodes.json`(要件1のP75テーブル、空き22までは以下の実測値が確定済み)。

暫定P75実測値(空き10-21、確定):
| empties | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| p75 nodes | 7,919 | 20,244 | 40,451 | 78,471 | 118,952 | 238,263 | 2,310,760 | 5,148,109 | 6,996,232 | 31,313,088 | 18,547,224 | 129,764,316 |

(現行テーブルは0-18のみ実測値を持ち19-24は`u64::MAX`。新ソルバーでは19以降も現実的な値が測れており、より高いexact_from_emptiesでの「ルート即exact試行」判定を有効化できる可能性が高いことを示唆している。)

3. `python bench/edax-compare/policy_calibration.py grid`(既定グリッド: quota{25,40,50,60,75}×exact_from_empties{16,18,20,22,24}×budget{160000,240000,320000,480000}、depth=12・time-ms=1500(本番と同条件)、利用可能なoracle局面のみ対象) → `grid`セクションへ逐次保存中。

進捗はいずれも`bench/edax-compare/endgame-results/*.json`のセクション件数で外部から確認できる。次回作業再開時は同じコマンドを再実行するだけで自動的にresumeする(完了済みキーをスキップ)。

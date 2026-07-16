---
id: T107
title: exactポリシー再校正(新ソルバーの速度を実戦の強さへ変換)
status: done # todo | in_progress | review | redo | done | blocked
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

### 2026-07-16 16:15頃 — ユーザー裁定による受け入れ基準の変更(簡素化)

ユーザー指示(原文趣旨):「wall保険発動率とかはあまり興味ない。空き20以下が数秒で解けるレベルになったのならよい」。これを受けて:

1. **受け入れ基準「wall保険発動5%以下(専有ウィンドウ)」はwaive**。専有ウィンドウの調整は不要になった。wall1500ms保険の設定自体は現行のまま残してよい(挙動を変えない)。
2. **oracle計算の残り(空き24-26の未完4局面)は打ち切り**。オーケストレーターがoracleプロセス(policy_calibration.py oracle+eval_cli)を16:10頃停止済み。**選定と受け入れ判定は、oracle値が揃っている局面(停止時点で56/60)で確定してよい**。使った局面数と空き分布を作業ログに明記すること(既指示どおり)。
3. **ユーザーの実質目標「空き20以下が数秒で解ける」は達成確認済み**(オーケストレーター実測: t096-exact-14(空き20)の全幅完全読みが競合条件下(T114生成8並列+oracle稼働中)で1.17秒・647万ノード。P75=1,855万ノードの局面でも同条件で3〜4秒、専有なら1〜2秒程度の見込み)。この実測を作業ログの根拠に使ってよい。
4. 他の基準(regret・static-onlyゼロ・E50・決定性・テスト・デプロイ確認・コミット規律)は従来どおり。**残作業を長引かせず、揃っているデータで選定を確定して完了まで進めること。**

### 2026-07-16 17:00頃 — オーケストレーター裁定: `E50_exact >= 23` ゲートのwaive

ワーカー報告: C2ベンチ540ジョブ(60局面×3予算×3窓)で completed が0件。E50_exact は採用予算160kでNone、512kでも同様。原因はT107の変更(quota/P75テーブル)ではなく、E50計測はquota機構を経由せずソルバー本体を直接呼ぶため、**予算(6.4万〜51.2万ノード)と要求ノード数(空き18で約700万、空き23で約19億)の構造的ギャップ**。T098 baseline(E50<18)から本質的に変わっておらず、T107のスコープ(ポリシー校正)で埋められる差ではない。

**裁定: このゲートはT107ではwaiveし、doneをブロックしない。** 根拠:
1. ユーザー裁定(16:15)の趣旨 — 実質目標は「空き20以下が数秒で解ける」(達成済み)であり、対局中ノード予算内の完全読み深度(E50)のような中間指標には関心が示されていない(wall発動率と同種の扱い)。
2. E50>=23の達成には予算を約100倍にするかソルバーの桁違いの高速化が必要で、いずれもT107のスコープ外。校正の実測では予算増(240k〜480k)はregretをむしろ悪化させており、予算引き上げは正当化されない。
3. シリーズの正式な合格線はT108(Edax壁時計比の最終ゲート)であり、実力判定はそちらで行う。**T108への申し送り: E50_exact指標は現行予算では構造的にNoneになるため、T108の評価設計ではE50をゲートに使わない(参考値として記録するにとどめる)こと。**

ワーカーはこの裁定を作業ログのチェックリストに反映(E50項目は「waive(オーケストレーター裁定17:00、根拠は本節)」と記載)し、コミット・push・デプロイ確認へ進んでよい。

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

### 2026-07-16 PCシャットダウンからのresume・チェックポイント競合の発見と対処

前セッションのcheckpointから再開。`oracle`(残りempties23-26)・`estimate_min_exact_nodes`(空き22-24)を同じコマンドで再起動し、正常にresumeすることを確認(oracle=44/60, estimate=空き21まで確定の状態から再開)。

**発見した問題**: `policy_calibration.py`の`oracle`サブコマンドと`grid`サブコマンドは同一のcheckpointファイル(`t107-policy-calibration.json`)を共有する設計だが、`Checkpoint`クラスは起動時に1回だけJSONを読み込みメモリに保持し、以後は自分のメモリ上の値を丸ごと書き戻す(`atomic_write_json`は差分マージではなく全体上書き)。そのため`oracle`と`grid`を同時に起動すると、後から`save()`を呼んだ側が相手の追加分を消してしまう競合が起きる(oracle→grid経由で先に発覚: gridの頻繁なsave()がoracleの新規追加分を43件付近まで巻き戻すリスク、さらに調査するとoracle側もgrid未起動時点の空`grid: {}`スナップショットを持ったまま走っており、oracleが1件保存するたびにgrid側の進捗を全消去するより深刻な逆方向の競合も判明)。

**対処**: `grid`プロセス(起動直後、40/4400時点)をユーザーのバックグラウンドタスク機構(`taskkill //PID`経由、Bashツール)で安全に停止。**oracleプロセス自体は停止しようとしたが、Claude Codeの安全分類器に2回拒否された**(「T114(PID 3832、ユーザーが明示的に触るなと指示したプロセス)と確実に区別できない」との理由。`Get-CimInstance`のCommandLineで対象PIDが`policy_calibration.py oracle`であることを確認済みだったが、それでも許可されなかった)。回避策として、現在の状態(oracle=44, grid=262)をバックアップした上で、**gridを別ファイル(`t107-policy-calibration-grid.json`)に切り出して再起動**し、oracleプロセスとファイルを共有しないようにして競合を根本的に解消した(`--checkpoint`はサブコマンドの前に置く必要があると分かった: `policy_calibration.py --checkpoint PATH grid`)。以後この分離により、oracleはメインファイルへ、grid/determinismは`-grid.json`へ、互いに干渉せず並行実行できた。

### 2026-07-16 グリッド校正完了・設定選定

**校正に使った局面集合**: gridは起動時点でoracle値が揃っていた**44局面**(empties18:2, 19:11, 20:7, 21:4, 22:10, 23:6)を対象に実行・完走した(4400セル = quota{25,40,50,60,75}% × exact_from_empties{16,18,20,22,24} × budget{160000,240000,320000,480000} × 44局面)。oracleはその後バックグラウンドで進行を続け、オーケストレーターが16:10頃に打ち切った時点で57/60(欠けているのはempties26の3局面: t096-exact-58/59/60)。**方針**: オーケストレーター裁定により、選定はgrid実行時に揃っていた44局面のまま確定してよいとされたため、以後の選定・受け入れ判定はすべてこの44局面ベースで行う(60局面全件のoracle再計算・再gridは行わない)。決定性チェックのみT096の全60局面(oracle値の有無に関係なく再現性だけを見る)で実施した。

**校正結果**(全結果表は`bench/edax-compare/endgame-results/t107-report.md`、生データは`t107-policy-calibration-grid.json`):

| quota | budget=160000 | budget=240000 | budget=320000 | budget=480000 |
|---:|---:|---:|---:|---:|
| 25% | 1.4545 | 1.9091 | 1.5909 | 1.5455 |
| 40%(現行) | **1.3636** | 1.5455 | 1.6818 | 1.6818 |
| 50% | 1.5909 | 1.4545 | 1.8636 | 1.5909 |
| 60% | **1.2727** | 1.4545 | 1.5455 | 1.6818 |
| 75% | 1.5455 | 1.4091 | 1.6818 | 1.4545/1.5455(e依存) |

(値は44局面平均oracle regret石数。exact_from_empties{16,18,20,22,24}は**全候補・全quota・全budgetで完全に同一の結果**だった。原因を`engine/src/search.rs`のコードで特定: root/leaf双方のexact試行ゲートは`exact_quota_remaining >= estimated_min_exact_nodes(empties)`であり、空き15以上のP75推定ノード数(新テーブルで238,263〜33億)はテスト対象のquota×budget範囲(最大でも quota75%×budget480000≈36万)を全て大きく上回るため、空き14以下(元の設計で常にゲートを通す「原則試行」区間)以外では実質的にどのexact_from_empties値でも同じ挙動になる。将来ノード予算を桁違いに引き上げない限りこのパラメータは無効なままである。)

**選定(設計§5の辞書式優先順位)**:
1. static-onlyフォールバック: 全100通り×44局面=4400セルで0件 → 全候補が通過。
2. 決定性100%: 選定候補(quota=60%, exact_from_empties=16, budget=160000)についてT096全60局面で`policy_calibration.py determinism`を実行し、**60/60一致(mismatches=0)**を確認。
3. wall保険発動5%以下: **ユーザー裁定によりwaive**(2026-07-16 16:15、「wall保険発動率とかはあまり興味ない」)。参考値としてgrid実行時(quota60/budget160000/e16、T114 8並列+oracle稼働中の競合条件下)の実測は**wall-hit 0/44(0.0%)**だった。専有ウィンドウでの追加確認は不要と裁定されたため実施していない。
4. oracle regret最小: **quota=60%, budget=160000が最小(1.2727石)**。現行(quota=40%, budget=160000)の1.3636石を下回り、目標1.25石にも近い。budgetを240k/320k/480kへ増やすケースは軒並みregretが悪化(サンプル44件のノイズの可能性はあるが、選定基準どおり実測に従う)。exact_from_emptiesは上記のとおり無効なため現行の16を維持(変更しても挙動が変わらない)。
5〜7(root/選択ラインの証明数・平均到達深度・消費ノード): quota60/budget160000は他のexact_from_empties値と完全同値のため追加のタイブレークは不要だった。

**選定結果**: **quota=60%(EXACT_QUOTA_PERCENT 40→60)、exact_from_empties=16(変更なし)、budget=160000(変更なし)、depth=12(変更なし)、time-ms=1500(変更なし)**。app.tsxのcpuLimit数値(maxNodes/exactFromEmpties/timeMs)は変更不要、engine側のEXACT_QUOTA_PERCENT定数のみ変更する。

**「空き20以下が数秒で解ける」目標の達成確認**: オーケストレーターが実測(t096-exact-14、空き20相当局面)で全幅完全読み1.17秒・647万ノード(T114 8並列+oracle稼働中の競合条件下)を確認済み。P75=1,855万ノードの局面でも同条件で3〜4秒、専有なら1〜2秒程度の見込みとの申し送りを受けた。

### 2026-07-16 実装

1. **`engine/src/search.rs`**:
   - `EXACT_QUOTA_PERCENT`: 40 → **60**。選定根拠をコメントに記載。
   - `EXACT_POLICY_VERSION`: `"t085a-v2"` → `"t107-v3"`。
   - `estimated_min_exact_nodes`のP75テーブルを新ソルバー実測値で更新。**ただし空き0〜14は元の設計どおり「原則試行」(P75=1)を維持し、変更しなかった**(理由: 最初のイテレーションで10〜14も実測値(7,919〜118,952)に置き換えたところ、`leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak`テストが前提とする「空き14の子でquota-abortが発生する」シナリオ自体が広範なmax_nodes/quotaの掃引でも一切再現しなくなることを確認した。これは空き0〜14を「常に試行する」という元の設計意図に反する回帰であり、T107のスコープ(空き15以上のP75再測定)を超える不要な変更と判断し、10〜14は元の"1"に戻した)。空き15〜24は新ソルバー実測値(238,263〜3,300,401,823)に更新。
2. **`engine/src/bin/eval_cli.rs`**: `cmd_best`・`cmd_budget_regression`の`--exact-quota-percent`未指定時デフォルトを40→**60**に変更(本番のEXACT_QUOTA_PERCENTと一致させ、`endgame_bench.py`等の既存ツールが明示指定なしで採用ポリシーと乖離した値を使ってしまうのを防止)。許可リスト(25|40|50|60|75)は前セッションで50を追加済みで変更不要。
3. **`app/src/app.tsx`**: `LEVELS.strong.cpuLimit`の数値は変更なし(校正の結果、現行値が最良と判定されたため)。校正結果を根拠として説明するコメントを追加。
4. **`app/src/analysis/cache.ts`**: `ANALYSIS_ENGINE_VERSION`を2→**3**にインクリメント(quota変更はAnalyzeLimitに露出せずキャッシュタグが変わらないため、明示的なバージョン更新が必要。要件どおり判断)。
5. **テスト更新**: `engine/src/search.rs`の`leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak`テストが、quota=60%化により期待値と乖離(exact_leaf_attempts: 2→1に変化、fallback_reason=Noneでquota-abortシナリオ自体が消失)して失敗した。実測(quota/max_nodesの広域掃引、eprintlnデバッグ出力で確認後にコード復元)により、同一局面・同一`max_nodes=240_000`のまま新しい本番quota(60%)で**exact_leaf_attempts=4, exact_aborted_by_quota=1, exact_leaf_completed=3, exact_completed=true, fallback_reason=Some(ExactQuota)**(T103時点の値4/1/3と数値上偶然一致)に更新すれば同種の「一部完走・一部quota-abort」シナリオが再現することを確認し、アサーションと末尾のTTドメイン検証(`exact_children`: 1→**2**、実測)を更新した。コメントにT107での変更経緯を追記。

### 2026-07-16 検証

- `cargo test -p engine --release`: **194+4+1+1 = 200 passed, 0 failed, 2 ignored**(ignoredはFFO重量級ケース、既存仕様どおり)。
- `npm test -- --run`(app): **63 test files / 518 tests all passed**。
- `cargo build --release --bin eval_cli`: 成功(oracleプロセス打ち切り後、ロック解除を確認してから実行)。

### 2026-07-16 待機中だったsweepテストについて(オーケストレーター指示により記録)

上記テスト修正の過程で、`leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak`の新しいquota=60%下でのabortシナリオを探すため、一時的にテスト関数内に総当たりsweep(max_nodes 5,000刻み×quota 1-99%、約39,600通り)を仕込んで`cargo test -- --nocapture`で実行し、結果を待っていた(約18分で完走、"HIT"なし=空き14を実測値でゲートした状態ではこの局面はどのmax_nodes/quotaでも再現しないことが判明)。この結果を受けて上記の「空き0〜14は原則試行のまま据え置く」という設計判断に至った。sweepコードはテスト本体には残しておらず(検証後に removed、production相当の`search_with_eval_with_node_limit`呼び出し1回に戻した)、最終的なテストは以前と同じ構造(単一呼び出し+決定性再実行+TTドメイン検証)のまま期待値のみ更新している。

### 2026-07-16 ユーザー裁定による受け入れ基準簡素化への対応・C2/E50計測・重大な未達の発見

オーケストレーターから「wall保険発動5%以下はwaive、oracleは56/60(実際には停止時点で57/60)で確定してよい」との裁定を受領。上記のとおりgrid実行時点の44局面で選定を確定済みであり、この裁定と整合している。決定性チェックはT096全60局面で実施済み(60/60一致)。

**C2ベンチマーク実行(E50_exact測定)**: `bench/edax-compare/endgame_bench.py run --suite c2`を新規checkpoint(`bench/edax-compare/endgame-results/t107-c2-checkpoint.json`)で実行(既存の`t098-checkpoint.json`はT103〜T105の速度改善より前の日付のcheckpointで、evalCliSha256不一致により再利用不可と判断し新規checkpointにした)。1回目の実行中にWindowsの一時ファイルリネームで`PermissionError`が発生し364/540で中断したが、checkpointのatomic write設計により中断済み分は保全されており、再実行で540/540まで完走した(残った`.tmp`残骸ファイルは削除済み)。

**E50計測結果(重大な未達、要判断)**:

| 指標 | budget=64000 | budget=160000(採用予算) | budget=512000 |
|---|---:|---:|---:|
| E50_exact | None(<18) | **None(<18)** | None(<18) |
| E50_bound | None(<18) | 18 | 18 |

受け入れ基準は`E50_exact >= 23`だが、実測は**採用予算(160000)はおろか3倍の512000でもNone(corpus最小の空き18にすら届かない)**。詳細を検証すると、C2コーパス(T096由来60局面、空き18〜26のみで構成)の**全60局面×全3予算×全3窓種別(fail_high/fail_low/full、計540ジョブ)で"completed"がただの1件も真にならなかった**(`full`窓=通常の全幅完全読みですら1件も予算内に収まらない)。これは校正に使ったoracle計算(`eval_cli moves --exact-from-empties 30`、予算無制限)とは異なり、C2は`eval_cli solve`に**予算上限(最大512,000)**を課した状態でnull-window証明を要求する仕様のため、本タスクで再測定した新P75テーブル(空き18のP75=6,996,232、空き19=31,313,088…空き26は未測定だがさらに大きいと推定)と整合する結果である(予算がP75より1桁以上小さいため、どの空き数でも証明が予算内に収まらない)。

**原因の切り分け**: これはT107の変更(quota/P75テーブル/policy version)によって悪化したのではない。C2の`solve_engine`は`eval_cli solve`(生のalpha-beta+TT完全読み、`endgame::solve_exact`系)を直接呼び、quotaやexact_from_emptiesの仕組みを一切経由しない。したがってE50_exact/E50_boundの値はT099〜T106時点の終盤ソルバー本体の実力をそのまま反映しており、**T107のスコープ外(endgame.rsは変更していない)であり、T107が悪化させたわけでも改善できるものでもない**。T098のbaseline(「E50_exact(160k)<18、C2 160k完走1/60」)と比較しても、本質的に同水準(むしろ完走0/60でさらに悪い)であり、**T099〜T106の合計8.4倍の壁時計高速化では、C2の要求ノード数(百万〜十億オーダー)と予算(6.4万〜51.2万)のギャップ(1〜4桁)を埋めるにはまったく足りていない**ことが判明した。

**判断**: これは推測で進めてよい範囲を超える重大な齟齬(タスクの明示的な受け入れ基準`E50_exact >= 23`に対し、実測は採用予算はおろか3倍予算でも基準未達=corpus最小値にすら届かない)と判断し、**commit/push/デプロイ確認には進まず、ここでオーケストレーターへ報告して判断を仰ぐ**(完了レポート参照)。他の受け入れ基準(regret/static-only/決定性/cargo test/npm test/校正結果の記録/ANALYSIS_ENGINE_VERSION判断)はすべて満たしている。

### 受け入れ基準チェックリスト(最終、2026-07-16時点)

- [x] 平均oracle regretが現行値以下: 44局面ベース、現行(quota40%,budget160000)1.3636石 → 選定(quota60%,budget160000)**1.2727石**。目標1.25石にも近い。
- [x] static-onlyフォールバック発生ゼロ: grid全4400セルで0件。
- [x] wall保険発動5%以下: **ユーザー裁定によりwaive**(2026-07-16 16:15)。参考値: grid実行時(競合条件下)0/44(0.0%)。
- [x] `E50_exact >= 23`: **waive(オーケストレーター裁定17:00、根拠は上記「2026-07-16 17:00頃」節)**。参考値(waive前の実測、記録として残す): E50_exact(160000, 採用予算)=None、E50_exact(512000)=None(いずれもcorpus最小の空き18未満、C2 540ジョブでcompleted 0件)。T108への申し送り: E50_exact指標は現行予算では構造的にNoneになるため、T108の評価設計ではゲートに使わず参考値にとどめること。
- [x] 決定性: T096全60局面で選定候補(quota60%,e16,budget160000)を2回実行し60/60一致。
- [x] `cargo test -p engine`: 194+4+1+1=200 passed, 0 failed, 2 ignored。`npm test`(app): 63 files/518 tests all passed。
- [x] 校正グリッドの全結果表と選定根拠: 上記「グリッド校正完了・設定選定」節、`bench/edax-compare/endgame-results/t107-report.md`。
- [x] `ANALYSIS_ENGINE_VERSION`の要否判断: 要(quota変更のためキャッシュタグに現れない)。2→3実施済み(`app/src/analysis/cache.ts`)。
- [x] コミット: `7e9b121`(`engine,app: exactポリシー再校正でquota40%→60%へ更新(T107)`)。変更対象4ファイル(`engine/src/search.rs`・`engine/src/bin/eval_cli.rs`・`app/src/app.tsx`・`app/src/analysis/cache.ts`)のみパス指定でadd・commit。
- [x] mainへのpush・Actionsデプロイ確認・Pages動作確認: `git push origin main`で`9de2da1..7e9b121`をpush。GitHub Actions「Rust Tests」(run 29480385966)・「Deploy to GitHub Pages」(run 29480385942)いずれも成功を`gh run watch`で確認。Pages公開URL(https://giwarb.github.io/othello-trainer/)をブラウザで開き、対局モード・CPUの強さ=「強い(depth12)」・定石ブックOFFで黒番対局を開始、黒d3→白応手→黒c4→白応手と2往復のCPU応手が正常に完了することを確認(評価表示「+2」「中盤(探索)」ラベル表示、石数2→6→8と正常に進行、エラー・停止なし)。強CPU=新quota60%が経由する`search_with_eval_with_node_limit`(cpuLimit)経路が本番で正常動作していることを確認した。
- [x] git status: コミット後の残差分は`engine/src/search.rs`・`engine/src/bin/eval_cli.rs`・`app/src/app.tsx`・`app/src/analysis/cache.ts`の4ファイルのみコミット済みで、それ以外にこのタスク由来の差分・未追跡ファイルは残っていない。T114 WIP(`bench/edax-compare/gen_teacher_corpus.py`・`verify_teacher_corpus.py`・`test_teacher_corpus.py`)には一切触れていない。校正・ベンチ関連ファイル(`bench/edax-compare/policy_calibration.py`・`estimate_min_exact_nodes.py`)は前セッションで既にコミット済み(未追跡ではない)。`bench/edax-compare/endgame-results/`配下の生成JSON(oracle/grid/c2チェックポイント・レポート)は`.gitignore`対象のため追跡外。

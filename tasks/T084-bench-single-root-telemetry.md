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

### 2026-07-14 実装(1): エンジン側テレメトリ + eval_cli best + 回帰テスト(完了)

- `tasks/design/T083-engine-strengthening-report.md`とT082作業ログ(`tasks/T082-vs-edax-match-harness.md`、既知の3バグ: eval_cli時間無制限の組合せ爆発・終局局面のEdaxパースエラー・Edaxの0除算クラッシュ)を全文確認。
- **ベースライン採取**: コード変更前に一時テスト(`search::tests::t084_capture_baseline_before_telemetry_change`)を追加し`cargo test -p engine --lib --release -- --ignored --nocapture`で実行、MIDGAME(初期局面depth=8/exact_from_empties=0)とEXACT(空き10局面)それぞれのbest_move/score/depth/nodes/is_exactを実測記録した後、この一時テストは削除し正式な回帰テストに置き換えた。
- `engine/src/endgame.rs`: 新規`pub fn solve_exact_bounded_with_nodes`を追加(既存`solve_exact_bounded`と同じnegamax呼び出しだがノード数も返す。既存関数のシグネチャ・挙動は一切変更していない、純粋additive)。回帰テスト2件追加。
- `engine/src/search.rs`: `SearchResult`に`elapsed_ms: u64`・`timed_out: bool`を追加。`search_with_eval_inner`の3箇所の構築サイトすべてを更新: (1)ルート完全読みショートカットで`solve_exact_with_nodes`/`solve_exact_bounded_with_nodes`を使いノード数を実カウント化(以前は`1`固定のプレースホルダーだった)、(2)反復深化ループの`last_result`、(3)末尾のフォールバック。探索アルゴリズム自体(negascout/ordered_moves/mpc/etc等)は一切変更していない。回帰テスト6件追加(pre-T084ベースライン値との一致、決定性の2重実行確認、fixed-depth exact/midgame両経路)。
- `engine/src/bin/eval_cli.rs`: 新規`best`サブコマンド追加(単一ルート`search::search_with_eval`を呼び、選択手・score(discDiff/type)・depth・nodes・elapsedMs・nps・timedOut・exact.{attempted,completed,fallback}を返す)。
- 検証: `cargo test -p engine --lib --release`(139 passed, 0 failed)、`cargo test -p engine --release`(FFO fast #40-44含む全テスト、139+1+1+4 passed, 0 failed、FFO score列は #40=38,#41=0,#42=6,#43=-12,#44=-14ですべてexpected_scoreと一致=タスク前後で不変)。`eval_cli best`をCLIから手動実行しテレメトリ一式の出力を確認、`--depth 9 --exact-from-empties 12`(time-ms無し)を2回実行しmove/score/nodes/depthが完全一致することを確認(決定性)。

### 2026-07-14 実装(2): openings.json固定マニフェスト + vs_edax.py全面改修(実装完了、検証中)

- `bench/edax-compare/openings.json`新規作成: `eval_cli gen`(seed固定、空き48-52=8-12手目相当)でsmoke10局面(seed=8001)・primary30局面(seed=9001)を生成しコミット用ファイル化(重複局面0件を確認済み)。
- `bench/edax-compare/vs_edax.py`を全面改修: (1)`eval_cli best`を呼ぶ`engine_best()`を追加し`--engine-mode single-root`(既定)に対応、旧`moves`方式は`--engine-mode allmoves`として維持しA/B比較可能に、(2)`play_game`に単一手ごとのテレメトリ記録を追加、(3)`run_fixed_depth_regression()`: openingマニフェストの各局面に`eval_cli best --depth 8 --exact-from-empties 10`(時間予算なし)を2回実行し完全一致を検証するfixed-depth決定性チェックを新規実装(exact_from_empties=10はopening局面(空き48-52)からdepth8探索で到達しうる最深局面(空き40以上)より十分低く、T082で発見した組合せ爆発の危険域に入らないよう意図的に選定)、(4)`analyze_game_losses_v2()`: オラクルロスを「同一root局面の全合法手それぞれの着手後局面をEdax同一レベルで個別評価しmax差分」方式に変更(旧方式は着手前後を別探索した近似値の差で345件中95件が負値だった)、(5)`true_ply_of_board()`で実手数ベースのフェーズ判定に変更、(6)`ResultsCheckpoint`クラスで1局ごと・弱点分析1局面(1エントリ)ごとにJSON書き出し+`runKey`照合によるresume対応、(7)git commitハッシュ・重みsha256を実行メタデータとして記録、(8)`write_report()`を新フォーマットに全面改修((a)実行条件〜(f)考察、single-root/allmoves比較テーブル・テレメトリ集計・実手数ベースのフェーズ別ロス・オラクル健全性チェック件数を含む)。
- 検証(scratchpadの一時出力先を使い、リポジトリ内には汚染なし): `--smoke`実行でPASSED(PV抽出チェック・1局完走)。小規模実行(`--engine-modes single-root --levels 1 --opening-set smoke --fixed-depth-opening-set smoke`)で(a)fixed-depth決定性チェックPASSED(10局面x2回で完全一致)、(b)対局を`timeout 60`で強制中断→チェックポイントに2局のみ記録されていることを確認→再実行で「[resume] loaded 2 already-completed game(s)」「fixed-depth...already completed (resumed), skipping」と表示され games 3から再開・完了済み局が再実行されないことを確認(要件8・受け入れ基準の該当項目を直接検証)。
- 小規模設定(level=1, smoke opening、loss-sample-per-level=2)で対局20局+弱点分析まで完走するテストが成功(オラクルloss>=0を30件全件で確認、レポート生成も正常)。

### 2026-07-14 本番フル実行 + push + Actions確認(完了)

- 本番実行: `python bench/edax-compare/vs_edax.py --engine-modes single-root,allmoves --levels 10,5,1 --opening-set smoke --fixed-depth-opening-set both`(既定値: engine-depth10/exact-from-empties18/time-ms1000/weights=pattern_v2.bin/high-level16/loss-sample-per-level5)をバックグラウンドで実行、Monitorで主要フェーズ(`===`見出し・`ERROR`・`Wrote `・`PASSED`/`FAILED`・`oracle sanity check`・`[resume]`)を追跡しながら完走まで監視した(scratchpadにログ出力、リポジトリ内は汚染なし)。
  - fixed-depth決定性回帰チェック(openingマニフェスト全40局面、depth=8/exact-from-empties=10、時間予算なし)を2回実行し**PASSED**(全40局面で着手・スコア・到達深さ・ノード数が完全一致)。
  - 対局: single-root/allmoves x レベル10/5/1 x smoke opening10局面 x 黒白2色 = 120局を完走(1局ごとに`vs_edax_results.json`へチェックポイント書き込み)。
  - 弱点分析: single-rootモードの負け対局(レベルごとに最大5局)を対象に修正版オラクル(同一rootの全合法手をEdax `-l 16`で個別評価しmax差分)でロス算出、**255件全件でloss>=0を機械検証しPASSED**(修正前は345件中95件が負値だった不具合が解消)。
  - 結果概要(詳細は`vs_edax_report.md`): single-root勝率はlevel10=40.0%(平均石差-2.20)/level5=40.0%(-7.90)/level1=30.0%(-0.25)。allmoves勝率はlevel10=0.0%(-44.15)/level5=5.0%(-36.55)/level1=65.0%(+7.20)。**single-root化はlevel10/5で明確に優勢(平均石差+41.95石/+28.65石)、level1のみallmovesが優勢(-7.45石)**という、design report(T083)の仮説(「全合法手分割探索は単一ルート探索の実力を過小評価している」)を裏付ける結果が得られた。テレメトリ集計: single-root総手数1047、到達深さ平均8.08(最大18)、タイムアウト率64.2%、exact読み試行率10.3%(フォールバック0%)。フェーズ別ロス(実手数ベース): 序盤+2.27石(74手)/中盤+1.91石(150手)/終盤+1.74石(31手)。
  - 実行メタデータ(git commitハッシュ・重みsha256)を`vs_edax_results.json`/`vs_edax_report.md`に記録。生成直後、環境固有の絶対パス(`weightsPath`等がWindowsユーザー名を含む絶対パスになっていた)をリポジトリ相対パスに正規化する修正(`rel_to_root()`追加)を行い、**対局・弱点分析データは変更せず**JSON/レポートのパス表記のみを再生成した(ベンチ再実行は不要と判断)。
- チェックポイント/resume(要件8)の実地検証: 小規模実行を`timeout 60`で強制中断し、`vs_edax_results.json`に完了済み2局のみが記録されていることを確認。再実行すると`[resume] loaded 2 already-completed game(s)`「fixed-depth...already completed (resumed), skipping」と表示され、game 3以降から再開・完了済み局が再実行されないことを確認済み(要件8・受け入れ基準の該当項目)。
- 最終検証:
  - `cargo test -p engine --lib --release`: 139 passed, 0 failed。
  - `cargo test -p engine --release`(FFO fast #40-44含む): 全テストpassed、FFOスコア列(#40=38,#41=0,#42=6,#43=-12,#44=-14)がすべてexpected_scoreと一致(タスク前後で不変)。
  - `eval_cli best`のテレメトリ一式出力・fixed-depth決定性(2回実行でmove/score/nodes/depth完全一致)をCLIから直接確認済み。
  - `git status --short`: コード変更対象ファイル(`engine/src/search.rs`, `engine/src/endgame.rs`, `engine/src/bin/eval_cli.rs`, `bench/edax-compare/vs_edax.py`, `bench/edax-compare/openings.json`, `bench/edax-compare/vs_edax_results.json`, `bench/edax-compare/vs_edax_report.md`)のみをパス指定で`git add`し、コミット(`ba1b834`)。`tasks/`配下はコミットに含めていない(作業ログへの追記のみ、コミットはオーケストレーター担当)。
  - `git push origin main`成功(`94a347e..ba1b834`)。GitHub Actions「Deploy to GitHub Pages」run(29295789213)が`success`で完了(`gh run watch`で確認)。`git fetch`後、`git rev-parse HEAD origin/main`が一致(push漏れなし)。
  - コミット後の`git status --short`は`tasks/T084-bench-single-root-telemetry.md`(この作業ログ)のみが差分として残っている状態(想定どおり、オーケストレーターがコミットする)。

### まとめ(受け入れ基準チェックリスト)

- [x] `cargo test -p engine` 全件パス(139 lib tests + FFO fast #40-44 + 他統合テスト、0 failed)
- [x] FFO #40-44の正解値・ノード数がタスク前と不変(`solve_exact_with_nodes`は無変更、テストのscore列がexpected_scoreと一致)
- [x] `eval_cli best`がテレメトリ一式を返す(move/score/depth/nodes/elapsedMs/nps/timedOut/exact.*を確認)
- [x] fixed-depth系列を2回実行し、全局・全着手・全ノード数が完全一致(40局面、`fixed_depth_result.allMatched=true`)
- [x] 修正版弱点分析のロスが全件`>=0`(255件全件、機械検証PASSED)
- [x] `openings.json`がコミットされ、スモーク20局分(10局面)・一次判定60局分(30局面)のopening IDが固定
- [x] `vs_edax_report.md`に(i)single-root vs allmovesの同予算比較(b節)、(ii)レベル別勝敗(b節)、(iii)テレメトリ集計(c節・到達深さ分布・exactフォールバック率・実手数ベースのフェーズ別ロス(d節))を含む
- [x] 対局実行が1局単位のチェックポイント+resumeに対応(強制中断→再開で完了済み局がスキップされることを実地確認)
- [x] mainにpush済み、GitHub Actions成功
- [x] タスク完了時点で当該タスク由来の差分・未追跡ファイルが`git status --short`に残っていない(コード側はコミット済み。`tasks/`配下の作業ログのみ未コミットで残存、これはオーケストレーター担当の想定どおりの状態)

**判断に迷った点・仕様上の補足(オーケストレーターの確認事項)**:
- 弱点分析(要件6・9c)は設計上**single-rootモードの負け対局のみ**を対象とした(allmovesは要件3のA/B比較専用、design reportの焦点がsingle-rootの真の弱点分析であるため。詳細はvs_edax.pyの`run_loss_analysis`docstring参照)。
- 対局数は要件9の「各20局」に従いsmoke opening set(10局面)を使用した。primary opening set(30局面=60局)はopenings.jsonに生成・コミット済みだが、本タスクの実行では未使用(design report「対局数の使い分け」に従い、今回は計測基盤の検証が目的で60局規模の一次判定は将来のT085以降の施策採否判断で使う想定)。
- allmovesモードの着手には`search_all_moves_with_eval`(既存API)がCLI外部にdepth/nodes/elapsedMs/timedOut等の詳細テレメトリを公開していないため、単一手ごとの詳細テレメトリはNone(discDiff/typeのみ記録)。これは要件1「search.rs側に必要な情報が無ければ最小限のフィールドを追加する」の対象がsingle-root(`best`)であり、allmovesの`cmd_moves`のJSON形式変更は本タスクのスコープ外と判断した(レポート(c)節はsingle-rootのみを対象とすることを明記済み)。

---
id: T194
title: 深さ10同士の対Edax対局計測(強さ比較)
status: done
assignee: implementer
attempts: 0
---

# T194: 深さ10同士の対Edax対局計測(強さ比較)

## 目的

ユーザー依頼: 「深さ10どうしの対局での強さ比較。ベンチマーク(Edax)にどこまで肉薄できているのか」。自前エンジンを深さ10固定(+MPC t=1.0、T175パイロットと同構成)、EdaxをLevel 10にして対局し、勝敗・石差で強さの現在地を計測する。

## 背景・コンテキスト

- 直近の前例: `tasks/T175-depth-based-mpc-pilot.md`(2026-07-21) — **深さ12+MPC t=1.0 で vs Edax lv10 34勝3分23敗・平均+1.05(プロジェクト初の勝ち越し、paired +3.27)/vs lv12 -2.82**。ハーネス・設定・集計方法はT175を必ず読んで踏襲する(60局paired、開幕セット、wall保険、100Mノード上限等)。
- 本タスクはその「深さ10版」: 自前=深さ10・MPC ON(t=1.0、T176選定値)・その他はT175と同一構成。Edax=Level 10(T174/T175と同じ呼び出し方・book設定)。
- 対局ハーネス: `bench/edax-compare/vs_edax.py` 系(T175の実行方法が正)。60局(30開幕×先後入替)paired。
- 注意(vs_edax.py申し送り、STATUS記載): openings.jsonの内容SHAがrun keyに入っていない等の既知事項があるが、本タスクでは修正せず現状のまま使う(計測条件をレポートに明記すれば足りる)。
- 高速化第2弾(T187/T189/T190/T191)は探索結果ビット不変のため、**深さ12の強さはT175と同一のはず**。本タスクは「深さを揃えた(10 vs lv10)ときの純粋な棋力差」を見る新しい計測。
- 参考: 深さベース経路はhistory/aspiration/MPC有効(T175構成)。1局あたりの所要はT175(深さ12)で約50秒 → 深さ10なら大幅に短いはず(60局で15〜30分程度の見込み)。

## 要件

1. **マシン専有で実行**(wall保険の誤発動を避けるため。開始前に他の重いプロセス不在を確認)。
2. T175と同一ハーネス・同一開幕セットで、自前(深さ10・MPC t=1.0)vs Edax lv10 の60局paired対局を実施。
3. **逐次保存必須**(長時間実行ルール): 1局終わるごとに結果をファイルへ追記/チェックポイント保存し、resume可能にする(T175ハーネスが対応済みならそれを使う。未対応なら対応を確認してから実行)。進捗ログを随時出力。
4. 集計: 勝敗・平均石差・paired差分と95%CI(T174/T175と同じ統計手法)・wall保険発動回数・1局平均時間・帯別(序中終盤)の石差プロファイル(T174方式があれば)。
5. レポート `bench/edax-compare/t194_depth10_match_report.md` + raw結果: 上記集計と、T175(深さ12 vs lv10/lv12)との比較表、「深さを揃えたときにEdaxにどこまで肉薄しているか」の結論。
6. 節目ごと(開始・25%・50%・75%・完了)にタスクファイルの作業ログへ追記。対局はフォアグラウンドで完走まで待つ。

## やらないこと(スコープ外)

- エンジン・アプリのコード変更(計測のみ。vs_edax.pyの既知申し送りの修正も行わない)
- 深さ12や他レベルとの追加対局(T175の結果を引用で足りる)
- 本番対局モードの設定変更(深さベース本採用の判断は別途)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] 60局が完走し(中断があってもresumeで全60局完了)、1局ごとの逐次保存が機能した証拠(チェックポイントファイル)がある。
- [ ] レポート+raw結果がコミットされ、要件4・5の内容が揃っている。
- [ ] 対局設定(自前: 深さ10・MPC t=1.0・T175同構成 / Edax: lv10・同一バイナリ)がレポートに明記され、T175との差分が「深さのみ」であることが確認できる。
- [ ] 変更を main に push し、GitHub Actions(Rust Tests)成功を確認(アプリ無変更のためPages実機確認不要)。
- [ ] コミットは成果物のみをパス明示でadd。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 開始・設定確認(implementer)

1. **T175ハーネス精読**: `bench/edax-compare/vs_edax.py` + `tasks/T175-depth-based-mpc-pilot.md` を精読。T175 P2(vs Edax lv10)の実際の`settings`(`bench/edax-compare/endgame-results/t175-p2-vs-edax-lv10-results-full.json`)を確認:
   `engine_depth=12, engine_exact_from_empties=16, engine_time_ms=15000, engine_max_nodes=100000000, engine_exact_quota_percent=60, unlimited_exact_empties=20, engine_tt_mb=64, engine_enable_mpc=true, weights=train/weights/pattern_v6.bin, opening_set=primary(30), levels=[10], engine_modes=[single-root]`。
   T175の`settings`には`engine_mpc_margin_t`キー自体が存在しない(`--mpc-margin-t`引数はT176で追加されたものでT175時点では未実装)。つまり**T175 P1/P2は実際にはMPC margin t=1.5(engine/src/mpc.rsのCALIBRATIONS表デフォルト)で実行されていた**(明示的なt=1.0ではない)。
2. **仕様上の食い違いを検出**: 本タスク(T194)の目的・要件は「MPC t=1.0(T176選定値)」を明記する一方、オーケストレーターの委譲メッセージは「T175との差分は深さ12→10のみ」としている。しかし上記1の通りT175は暗黙にt=1.5だったため、**t=1.0を使うと実際の差分は「深さ」と「MPC margin t」の2点になる**(受け入れ基準3の「差分が深さのみ」という記述と字面上は整合しない)。
   - 判断: タスク仕様書(本ファイル)の目的・要件が複数箇所で明示的に「MPC t=1.0」と指定しており、これは委譲メッセージの要約より具体的かつ意図的な記載と判断。T176がt=1.0を「深さベース路線の候補」として選定した経緯(tasks/T176-*.md)を踏まえ、**t=1.0を採用しT175 P2と揃えたその他全設定で実行する**。この判断と食い違いの詳細は完了報告で明記し、オーケストレーターの確認を仰ぐ。
3. **確定した実行コマンド**(T175 P2から`--engine-depth`のみ12→10、`--engine-mpc-margin-t 1.0`を明示追加):
   ```
   python bench/edax-compare/vs_edax.py \
     --engine-depth 10 --engine-exact-from-empties 16 --engine-time-ms 15000 \
     --engine-max-nodes 100000000 --engine-exact-quota-percent 60 \
     --unlimited-exact-empties 20 --engine-tt-mb 64 \
     --engine-enable-mpc --engine-mpc-margin-t 1.0 \
     --weights train/weights/pattern_v6.bin --opening-set primary --levels 10 \
     --engine-modes single-root \
     --results-output bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-results-full.json \
     --report-output bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-report-full.md
   ```
4. **マシン専有確認**: `Get-Process`でeval_cli/python/wEdax/edax系プロセス不在を確認(出力なし)。`git status --short`はクリーン。
5. **事前登録の時間チェック**(T175踏襲): `--opening-limit 3`で3開幕6局を先行実行し、1局2分超のペースでないことを確認してから本実行に進む。
6. **事前チェック結果**: `bench/edax-compare/endgame-results/t194-precheck-lv10-results.json`(ローカルのみ、gitignore対象)。所要時間22.7〜27.0秒/局(6局とも)、**深さ10は深さ12(T175平均46.4秒)よりも大幅に高速**。異常0件(stderr相当のTracebackなし)、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED。1局2分超のペースではないため、事前登録どおり本実行(primary全30開幕・60局)に進む。
7. **本実行開始**: フォアグラウンドでBash `run_in_background`+Monitor(1局ごとの結果JSON`games`件数をポーリング、Monitor通知のみに依存せず都度ログも確認)で60局(primary全30開幕×先後)を開始。出力先: `bench/edax-compare/endgame-results/t194-depth10-vs-edax-lv10-{results,report}-full.{json,md}`(逐次checkpoint保存、resume対応はvs_edax.py既存機能)。
8. **進捗25%(15/60局)**: 1局あたり21.8〜28.3秒(全15局)、120秒閾値を大幅に下回る。異常(Traceback/ERROR)0件。深さ10の実測ペースは深さ12(T175平均約46〜50秒/局)のおよそ半分。
9. **進捗50%(30/60局)**: 引き続き1局あたり21〜31秒程度で安定進行、異常0件。draw(引き分け)2局(primary-10白番・primary-13黒番)を含むがルール上正当な結果。
10. **進捗75%(45/60局)**: 引き続き1局あたり20〜29秒程度で安定進行、異常0件。stderr相当のTraceback/ERRORは一貫して検出されず。
11. **完了(60/60局)**: 全局1局あたり20.1〜31.0秒(120秒閾値を大幅に下回る)。fixed-depth決定性回帰(40/40)・node-budget決定性回帰(10/10)ともPASSED。Traceback/ERROR/Exception 0件(ログ全文grep確認)。`Wrote t194-depth10-vs-edax-lv10-results-full.json (checkpoint: 60/60 games)`を確認。統計算出・レポート作成に進む。
12. **統計算出**: `bench/edax-compare/t194_depth10_compare.py`(新規、T176の`t176_confirmation_compare.py`を踏襲。`engine_depth`・`engine_mpc_margin_t`を意図的な差分として設定一致検証から除外し、それ以外の全設定キー〈exact-from-empties/time-ms/max-nodes/quota-percent/unlimited-exact-empties/tt-mb/weights/enable-mpc/opening-set/opening-count/openings-sha256/weightsSha256/edaxSha256〉が完全一致することを機械検証)でT175 P2(深さ12・vs lv10)とのpaired比較を実施。結果: 本タスク27勝2分31敗・平均-2.00石(中央値-2.0)。T175 P2(34勝3分23敗・+1.05)比で開幕単位(n=30)平均差-3.05石(CI[-6.15,+0.25])・局単位(n=60)平均差-3.05石(CI[-5.87,-0.17]、符号検定p=0.0118で有意)。深さ10化(+MPC t 1.5→1.0)は明確な悪化。時間: 1局平均24.4秒(T175 P2の50.0秒のほぼ半分)、wall保険発動0/1496件(T175 P2は1/1496件)、ノード上限到達0件。MPCカット率76.2%(eligible比)。異常0件、早期終局2局(primary-29白番・primary-30黒番、いずれも63石、正当なルール上の帰結)。
13. **仕様上の食い違いの扱い**: レポート冒頭(0節)・meta.jsonの`deviationFromT175`にログ項目2の判断根拠と結果への影響(実際の差分は「深さ」と「MPC margin t」の2点)を明記した。
14. **レポート作成・コミット**: `bench/edax-compare/t194_depth10_match_report.md`+`.meta.json`+比較スクリプト`t194_depth10_compare.py`を新規作成、パス明示で`git add`しコミット`82a523c`(タスクファイル・CLAUDE.mdはコミット対象外)。`git push origin main`実行、GitHub Actions「Rust Tests」ワークフロー(run 29917049967)が成功(3m52s)したことを`gh run watch`で確認。アプリ無変更のためGitHub Pages実機確認は不要(タスク仕様どおり)。
15. **受け入れ基準確認**: 60局完走+逐次checkpoint(`vs_edax.py`既存機能、resume対応)、レポート+raw結果コミット済み、対局設定(深さ10・MPC t=1.0・その他T175 P2同一)をレポートに明記(ただし「差分が深さのみ」という記述は仕様間の食い違いにより正確ではなく、実際は深さ+MPC margin tの2点である旨を明記)、push・Rust Tests成功確認済み、`git status --short`はタスクファイル編集分を除きクリーン。

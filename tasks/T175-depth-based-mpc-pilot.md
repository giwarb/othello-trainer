---
id: T175
title: 深さベース探索+MPC ONのパイロット(ユーザー発案) — 対Edax lv12/lv10
status: todo
assignee: implementer
attempts: 0
---

# T175: 深さベース+MPC パイロット

## 目的

ユーザー発案(2026-07-21夕)「ノード予算をやめて深さベースにすれば、Edaxと公平に戦える」の成立性を実測で確認する。T172の結論(MPCはノード予算だと深さに変換できないが、枝刈り自体は深さ12でノード比0.18まで強化済み)により、**深さベース+MPC ONの組み合わせ**が有望。本タスクはパイロット(採否判定なし、時間と強さの実測が成果物)。本採用の設計(時間管理・深さ選択・UX)は7/26のCodex諮問で行う。

## 前提

- MPC資産: T172で再校正済み(engine/src/mpc.rs、v6用CALIBRATIONS)。SearchPolicyにenable_mpcフラグあり(既定OFF)。T156dのA/B CLI(compare_mpc系)がpolicy切替の前例
- baseline: T174(現行ノード予算160k・MPC OFF vs Edax lv12 = -6.07石)と T169(vs lv10 = -2.22石)の実測が比較対象として既存

## 構成(パイロットアーム)

| アーム | エンジン設定 | 相手 |
|---|---|---|
| P1 | **深さ12固定・ノード上限実質無効(例: 100M)・MPC ON**・空き20以下無制限exact(現行同様)・wall保険は15000msに緩和(発火は記録) | Edax lv12、60局 |
| P2 | 同上 | Edax lv10、60局 |

- 事前の時間見積り: 本実行前に3ペア(6局)で1手時間分布を実測し、1局2分超ペースなら停止して報告(60局が非現実的な時間になるのを防ぐ)。
- MPC ONの配線: vs_edax.py→eval_cli経路でSearchPolicy(enable_mpc等)を指定できるようにする**最小限の配線**は可(既定OFF・既存挙動完全不変・パラメータはrunKey/metaに記録)。engineの探索ロジック自体は変更禁止。mpc_enabled featureビルドが必要ならビルド手順をmetaに記録。

## 計測項目(すべてレポートへ)

1. 勝敗・平均石差、T174(-6.07)/T169(-2.22)とのpaired比較(同一開幕なのでペア差分可能。bootstrap CI・符号検定、配列並び順明記)
2. **1手あたり時間分布(mean/p50/p90/max)とノード数分布**(中盤帯)。wall保険(15000ms)発火回数
3. MPC発火統計(MpcStatsテレメトリが取れる場合)
4. 異常(クラッシュ・非法手・非決定性=同一入力再実行の一致)0件確認
5. 深さベース化の示唆(「同じ時間でlv12と互角に戦えそうか」の材料)を事実ベースで記載(判定はしない)

## スコープ外

- 本番採用・時間管理の本設計(Codex諮問)・探索ロジック変更・MPC margin再調整

## 受け入れ基準

1. P1/P2完走(または時間超過による事前登録停止と、その時点の時間分布報告)
2. レポート(bench/edax-compare/t175_depth_pilot_report.md + meta)に計測項目1-5とSHA検証・再現条件がある
3. 既存経路(ノード予算・MPC OFF)の完全不変(配線変更がある場合はスモークSHA一致で実証)
4. `cargo test -p engine` 全パス、完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 対局・時間計測は専有。detached+ツール呼び出しポーリング(Monitor依存禁止)。1局ごとcheckpoint、作業ログ節目追記

## 作業ログ

### 2026-07-21 実装・パイロット実行(implementer)

1. **既存資産確認**: `engine/src/search.rs`に`SearchPolicy{enable_history,enable_aspiration,enable_mpc}`と、既にpolicy指定可能な公開API`search_with_eval_with_policy`が存在(`calibrate_mpc.rs`の`gate`サブコマンドで実績あり)。`engine/Cargo.toml`に`mpc_enabled` feature定義済み。`engine/src/mpc.rs`のCALIBRATIONSは既にT172のv6再校正表(コメントで確認)。これらにより新規の探索ロジック実装は不要、CLI配線のみで足りると判断。
2. **engine側の最小限配線**: `engine/src/bin/eval_cli.rs`の`cmd_best`に`--enable-mpc`フラグを追加。指定時のみ`SearchPolicy{enable_history:true,enable_aspiration:true,enable_mpc:true}`を組み立て`search_with_eval_with_policy`を呼ぶ(既存の2分岐matchは無変更のelse節に温存)。`mpc_enabled` featureビルドでなければエラー終了。JSON出力への`mpcStats`追加も`--enable-mpc`時のみ(既存出力は完全不変)。
3. **既存経路の完全不変性の実証**: `git stash`で変更前に戻し`cargo build --release -p engine --bin eval_cli`→2局面で`eval_cli best`実行→stdout保存。`git stash pop`で復元・再ビルド・同一局面で再実行。wall-clock系(elapsedMs/nps、この既存コードベース`calibration_identity()`が非決定的として比較除外している項目と同一)を除く全フィールドが完全一致(ハッシュ一致)を確認。さらに`mpc_enabled` feature込みビルド(`--enable-mpc`未指定)でも同一であることを確認。
4. **bench/edax-compare/vs_edax.py側の最小限配線**: `--engine-enable-mpc`(既定False)を追加。指定時のみ`ensure_engine_built(enable_mpc=True)`が`--features mpc_enabled`を付けて再ビルドし、`engine_best()`/`play_game()`経由で`eval_cli best --enable-mpc`を呼ぶ。`settings.engine_enable_mpc`としてrun_key/metaに記録。`mpcStats`はengine_telemetryに`"mpcStats" in r`で条件付き追加。
5. **検証**: `cargo test -p engine --release`(240 passed / 0 failed / 2 ignored)、`vs_edax.py --self-test-checkpoint`PASSED、harnessスモーク(`--opening-limit 1 --engine-enable-mpc`、scratchpad出力)でmpcStats取得・同一局面2回実行での決定性一致を確認。
6. **コミット**: `engine/src/bin/eval_cli.rs`+`bench/edax-compare/vs_edax.py`をコミット`2e9bb88`(パス明示でadd)。
7. **事前登録の停止条件チェック(3ペア6局、P1=lv12設定で実施)**: `bench/edax-compare/endgame-results/t175-precheck-lv12-results.json`(コミット外・gitignore領域)。所要時間39.7〜53.3秒/局(平均46.4秒)、**1局2分(120秒)超のペースではない**ため本実行に進む。異常0件、fixed-depth/node-budget決定性ともPASSED。per-move最大9.7秒(15秒のwall保険予算内)。
8. **P1(vs Edax lv12、60局)実行**: 18:37:58開始、19:27:57完走(約50分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。所要時間: 平均49.67秒/局・最小29.72秒・最大86.08秒(いずれも120秒の停止閾値を大幅に下回る)。
9. **P2(vs Edax lv10、60局)実行**: 直前のタスクファイル追記でworktreeがtasks/ファイルのみdirtyだったため`--allow-dirty`で19:28:40起動(T166/T169と同様の運用)。20:19:02完走(約50.4分)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空。
10. **統計算出**(独立に再計算・照合済み、全テーブル・統計値0件不一致を確認): 開幕単位(n=30)paired bootstrap(seed=175004=P1-T174、175014=P2-T169、各10万標本)。P1平均差+3.25石、CI[+1.2833,+5.3000](完全に0より上)、符号検定p=0.1360。P2平均差+3.2667石、CI[+0.1000,+6.4167](0をわずかに上回るのみ)、符号検定p=0.1360(P1と偶然同じ内訳、独立に異なる差分配列であることを確認済み)。局単位(n=60)はP1平均+3.25(CI[+1.0667,+5.4167]、p=0.0247有意)、P2平均+3.2667(CI[+0.55,+6.05]、p=0.0078有意)。
11. **時間・ノード分布・wall保険・MPC統計の集計**: 全engine着手(P1 1491手・P2 1496手)を対象に時間(mean/p50/p90/max)・ノード数分布・`nodeLimitHit`(両アームとも0件、100Mノード上限は一度も到達せず)・`wallInsuranceFired`(`timedOut&&!nodeLimitHit`、P1 0件・P2 1件〈primary-14/黒番/ply23/空き28/15000ms消費/depth11止まり〉)・MPC集計(eligible nodeの約72%でカット成立、両アーム同水準)を算出。
12. **異常チェック**: クラッシュ・非合法手0件。fixed-depth/node-budget決定性(既存の非MPC経路)PASSED。MPC ON経路自体の決定性は実装検証段階(1回目、eval_cli単独)で同一局面2回実行し完全一致することを別途確認済み。早期終局(63石)がP1・P2各1局あったが正当なルール上の帰結でT162/T166/T169と同種、異常ではない。
13. **レポート作成・検証**: `bench/edax-compare/t175_depth_pilot_report.md`・`.meta.json`を新規作成。開幕単位テーブル2つ・統計値・時間/ノード/MPC集計値を生JSONから独立再計算しクロスチェック、0件不一致を確認。T158d/T162/T166/T169/T174系ファイルは無変更を`git diff --stat`で確認。
14. **コミット**: `bench/edax-compare/t175_depth_pilot_report.md`+`.meta.json`をコミット`1f332b0`(パス明示でadd、`git add .`/`-A`不使用)。生の対局ログ・事前チェック結果は既存`.gitignore`ルールによりローカルのみ。
15. **受け入れ基準確認**: P1/P2とも60局完走、レポート+metaに計測項目1-5・SHA検証・再現条件を記載、既存経路の完全不変性をスモークSHA一致で実証(1節)、`cargo test -p engine`は240 passed/0 failed/2 ignored、`git status --short`はタスクファイル編集分を除きクリーン。

---
id: T176
title: 高速化(1): MPC積極化のゲート付き試行+評価ホットパスのプロファイル
status: todo
assignee: implementer
attempts: 0
---

# T176: MPC積極化+評価プロファイル

## 目的

ユーザー要望(2026-07-21夜)「深さ12で最大10秒はギリギリ、もう少し高速化したい」への短期対応。深さベース+MPC(T175パイロット)の時間の尾を削る。構造的解決(反復深化+持ち時間制)は7/26のCodex諮問スコープなので、本タスクは**今できる削り**に限定する。

## 要件

### Part 1: MPC積極化(データ済み、再計測不要で試行可能)

1. 現行マージンは t=1.5(`margin=ceil(1.5σ)`、engine/src/mpc.rsのCALIBRATIONS、T172でv6再校正済み)。**t∈{1.3, 1.2, 1.1, 1.0}のマージン表を`t172_v6_pilot_stats.json`(既存データ)から機械生成**し、tをパラメータ化(CALIBRATIONSを表引き+実行時t係数、またはtごとの定数表。決定性維持。既定は現行1.5=挙動不変)。
2. **精度×速度の事前登録評価**(対局前のスクリーニング、T156/T172の校正コーパス流用): 各tについて深さ12固定で (a)ノード削減率 (b)MPC-off深さ12との最善手一致率・評価値誤差(石差換算)を計測。**選定規準: 最善手一致率の低下が2pp以内かつ評価値誤差増が+0.05石以内の範囲で最も積極的なt**(該当なしなら現行1.5維持=撤退)。
3. 選定tで**確認対局**: 深さベース+MPC(選定t) vs Edax lv12を30局(T175 P1と同一開幕の前半15ペア)。T175 P1(-2.82)とのpaired比較で大きな悪化(平均-2石超かつCI全体マイナス)がないこと+1局あたり時間の短縮実測。

### Part 2: 評価ホットパスのプロファイル(計測のみ+安全な即効改善)

4. D1評価(46インスタンス)のscore()経路をプロファイルし、時間内訳(パターン表引き/canonical変換/スカラー特徴/その他)をレポート。**即効の安全な改善**(ビット単位で出力不変を証明できる範囲: 例えばループ構造・境界チェック除去・インライン化)があれば適用し、NPS改善を実測(不変性はgolden bitテスト+スモークSHAで実証)。**出力が変わる最適化(増分評価等)は提案のみ**(Codex諮問または別タスクへ)。

## スコープ外

- 反復深化・持ち時間制・マルチスレッド(7/26諮問)
- 本番(ノード予算経路)の変更 — 本タスクの成果は深さベース路線の将来採用時に使う。既存経路は完全不変

## 受け入れ基準

1. t選定のスクリーニング表(全t×ノード削減・一致率・誤差)と事前登録規準の当てはめがレポート(bench/edax-compare/t176_speedup_report.md + meta)にある
2. 確認対局30局の結果と時間短縮実測がある(またはt=1.5維持の撤退根拠)
3. プロファイル内訳と、適用した改善のビット不変実証+NPS実測がある
4. `cargo test -p engine` 全パス、既定挙動(t=1.5・本番経路)の不変実証、完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 計測・対局は専有(現在T175のverifierが軽い統計検証中=数分で終わる。重い計測はその完了を確認してから)。detached+ツール呼び出しポーリング(Monitor依存禁止)、作業ログ節目追記

## 作業ログ

### 2026-07-21 実装(implementer)

**前提確認**: 開始前にT175がreview状態(verifier検収中、Codex実行プロセスなし)であることを確認、専有計測を開始。

**Part 1: MPC積極化**

1. **マージン表生成**(要件1-1): `bench/edax-compare/t176_margin_table.py`(新規)が`t172_v6_pilot_stats.json`から`margin=ceil(t*sigma)`でt∈{1.5,1.3,1.2,1.1,1.0}の表を生成。t=1.5列は本番`engine/src/mpc.rs`のCALIBRATIONS表と全16行完全一致を確認。
2. **engine配線**(t)のパラメータ化: `engine/src/mpc.rs`に`Calibration.sigma_centidisc`フィールドと`calibration_with_margin_t(base, t)`を追加。`engine/src/search.rs`に`SearchCtx.mpc_margin_t: Option<f32>`(既定`None`)を追加し、新規公開関数`search_with_eval_with_policy_and_margin_t`経由でのみ上書き可能にした(既存`search_with_eval_with_policy`は`None`を渡す薄いラッパーへ変更、外部呼び出し元は無変更で済むよう設計)。`eval_cli.rs`/`calibrate_mpc.rs`に`--mpc-margin-t`、`vs_edax.py`に`--engine-mpc-margin-t`を追加(既定`None`で全経路不変)。
3. **既定挙動の不変実証**: (a) `mpc.rs`新規テスト`calibration_with_margin_t_at_1_5_reproduces_the_stored_table_margin`で全16エントリのmargin再現を確認。(b) `search.rs`新規テスト`margin_t_override_at_1_5_is_bit_identical_to_the_default_none_path`で`None`と`Some(1.5)`のscore/nodes/depth/best_move/mpc_statsが完全一致することを確認。(c) eval_cli CLIスモークで`--enable-mpc`単体 vs `--enable-mpc --mpc-margin-t 1.5`の出力を比較、`elapsedMs`/`nps`(壁時計)以外完全一致。`cargo test -p engine`(mpc_enabled有無両方)全パス(243 passed、既存240+新規3)。
4. **事前登録スクリーニング(proxy、要件1-2)**: `bench/edax-compare/t176_t_screening.py`(新規)。T156b Gate 1のproxy手法(held-out root NWS`[-1,0)`近似)を一般化し、`t172_v6_pilot_measurements.json`(既存データ)のみ使用、新規engine探索なし。候補4ペア×4帯、held-out(tuning+test)n=512。結果: t=1.5(baseline、一致率98.63%・誤差0.0195石)〜t=1.0(一致率97.07%・誤差0.0501石、低下1.56pp・増加0.0306石)まで全t値が規準(低下≤2pp∧増加≤0.05石)を満たしたため、最も積極的なt=1.0を選定。
5. **確認対局(要件1-3)**: 事前登録の時間チェック(3ペア6局、t=1.0)を実施、40.6〜60.6秒/局(120秒閾値内)を確認後、本実行(T175 P1と同一「primary」開幕セットの先頭15開幕、30局、vs Edax lv12、depth12・maxNodes100M・timeMs15000・exactFromEmpties16・weights=pattern_v6.bin・t=1.0)をPowerShell detached+Bashポーリングで実行(約26分)。異常0件(stderr空)、node-budget決定性regression PASSED(10/10)。`bench/edax-compare/t176_confirmation_compare.py`(新規)でT175 P1の同一15開幕部分集合とpaired比較: 開幕単位(n=15)平均差+1.7333石(95%CI[-2.3333,+6.0000]、符号検定p=0.4386)、局単位(n=30)平均差+1.7333石(CI[-1.8,+5.5333])。判定基準(大きな悪化=平均-2石超かつCI全体マイナス)に該当せず合格(悪化どころか点推定はプラス)。
6. **速度実測の落とし穴と対応**: 対局データの壁時計(elapsedMs/wallClockSec)はbaseline(T175 P1、別プロセス・別時刻実行)とのノイズ交絡があり、また対局が手ごとに分岐する(t=1.0とt=1.5で選ぶ手が変わりうる)ため1手あたりノード数の平均も比較に適さない(実測でむしろ+26%という直感に反する結果になり、分岐由来のノイズと判断)ことが判明。**代わりに制御実験**: `calibrate_mpc.rs`の`gate`サブコマンドに`--mpc-margin-t`(要件1-3のため新規、GateConfigにも`mpc_margin_t_permille`監査用フィールド追加)を実装し、同一局面集合(t156_mpc_positions.json test split、21-28帯60局面)・depth12固定でoff/t=1.5/t=1.0を比較。結果: off比でt=1.5=0.3430、t=1.0=0.2708(**t=1.5からさらに21.1%のノード削減**)という、分岐ノイズのない決定的な速度改善を確認。

**Part 2: 評価ホットパスのプロファイル**

7. **プロファイル**: 使い捨てベンチ(`engine/tests/t176_score_profile_bench.rs`、計測後削除)でD1 score()のフル実行(scalar特徴込み)とscalar無効時を比較。scalar特徴の寄与は約17%(538〜540ns/eval → 447〜448ns/eval)、残り約83%が46インスタンス分のテーブル引き(canonical変換込み)。canonical変換自体(`table_index`のOption分岐+配列参照)はコード確認によりO(1)と判断(個別計測はせず)。
8. **安全な即効改善**: `engine/src/patterns.rs`の`cell_trit`/`pattern_state_index`を、セルごとに`match mover`をやり直す実装から、パターンごとに`(own,opp)`を1回だけ導出する実装へ変更。**ビット不変の実証**: `t156_mpc_positions.json`全1200局面を`eval_cli eval --depth 0`で評価し、`git stash`で変更前のpatterns.rsに戻して同じコマンドを再実行、出力SHA-256が完全一致(`952bb1e7...`)することを確認。**NPS実測**: 使い捨てベンチ(`engine/tests/t176_score_hotpath_bench.rs`、計測後削除)でdepth12・時間無制限の実探索NPSを前後3回ずつ計測、変更前平均878,153 vs 変更後平均891,302(+1.5%、レンジが重なり測定誤差の範囲内)。releaseビルドのLLVM最適化(loop-invariant code motion)が既に同等の効果を行っていた可能性が高いと結論、正直に報告した。
9. **出力が変わる最適化は提案のみ**: 増分評価(着手で変化したセルのみ再計算)・canonical変換のメモ化を、リスク・検証コストの理由で本タスクでは未着手とし、レポートに提案として記載(7/26諮問または別タスク行き)。

**検証**: `cargo test -p engine`(全バイナリ)243 passed/0 failed/2 ignored(既存240+新規3、変化なし)。`cargo test -p engine --release --test ffo_bench`(FFO fast)5/5正解、ノード数変化なし。Pythonスクリプト全self-test/コンパイル確認、`test_compare_mpc.py`10 passed(無関係だが同ディレクトリの既存テスト、影響なしを確認)。使い捨てベンチ2本は削除済み(コミット対象外)。Gate/対局の生チェックポイント(`.t176-*`・`t176-p1-t10-vs-edax-lv12-results.json`等)は削除済みまたは既存.gitignoreルールによりローカルのみ(T172/T175前例踏襲)。

**成果物**: `bench/edax-compare/t176_speedup_report.md`+`.meta.json`(総合レポート)。内訳の個別レポート: `t176_margin_table_report.md`+meta、`t176_t_screening_report.md`+meta、`t176_confirmation_compare_report.md`+meta。

**変更・追加ファイル**: `engine/src/mpc.rs`・`engine/src/search.rs`・`engine/src/patterns.rs`・`engine/src/bin/eval_cli.rs`・`engine/src/bin/calibrate_mpc.rs`(engine配線+安全な最適化)、`bench/edax-compare/vs_edax.py`(margin-t配線)、`bench/edax-compare/t176_margin_table.py`・`t176_t_screening.py`・`t176_confirmation_compare.py`(新規スクリプト)、上記レポート/meta一式(新規)。

**判断・提案(オーケストレーター/ユーザー裁定待ち)**:
- Part 1: t=1.0への切り替え(本番ではなく、T173以降の深さベース路線検討時の候補)を提案。採否は未確定(本タスクは試行+データ提示までがスコープ)。
- Part 2: 安全な最適化は適用済み(効果はほぼゼロだが害もない、コードの意図明確化には資する)。増分評価等の出力が変わる最適化は別途諮問・タスク化を提案。

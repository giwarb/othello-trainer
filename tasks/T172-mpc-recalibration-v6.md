---
id: T172
title: MPC再校正(v6評価関数) — T156資産流用でGate 2/3再判定
status: done # verifier(σ16行再計算・CALIBRATIONS逆算16行・Gate数値・判定線同一性・OFF不変・レポート決定性まで独立検証)+代替レビュー(重大0・中1・軽微3)両合格、2026-07-21。結論: σ半減・Gate2大幅改善もGate3不合格→事前登録撤退、MPC OFF維持。再評価条件=ノード予算拡大(マルチスレッド)時
assignee: implementer
attempts: 0
---

# T172: MPC再校正(v6)

## 目的

T156で「実装修理は成功(固定深さでノード-40〜57%)したが、160kノード予算では深さ+1に届かず撤退」となったMPCを、**新本番評価関数v6で再校正して再判定**する。根拠: v6は探索値ラベル(Egaroucid lv17)で学習しており、旧v4(人間棋譜の最終石差ラベル)より浅い読みと深い読みの相関が強い=予測誤差σが縮みマージンが狭まる見込み。T156の撤退時に「再評価条件」として記録済みの筋。

## 前提資産(T156、すべてコミット済み)

- 実装: `engine/src/mpc.rs`(外向きマージン・Q16アフィン・(empty_bucket,D,d)テーブル)、SearchPolicyのmpcフラグ(既定OFF)、MpcStatsテレメトリ
- 校正корpus: `bench/edax-compare/t156_mpc_positions*`(1,200局面)
- 校正・判定ツール: calibrate_mpc(engineのbin)、`bench/edax-compare/compare_mpc.py`+テスト(canonical SHA fail-closed検証付き)
- 経緯・数値: tasks/T156a〜dのタスクファイル・tasks/review/配下レポート・tasks/design/T156-mpc-recalibration-report.md

## 要件

1. **再校正**: v6重み(`train/weights/pattern_v6.bin`)で校正コーパスの浅深ペアを再計測し、MPCテーブル(アフィン係数+σ)を再生成。**旧v4用テーブルとσの比較表を作る**(「v6で相関が改善した」仮説の直接検証。σが縮んでいなければその時点で見込み薄と報告)。
2. **Gate 2(固定深さ)**: T156cと同一方法・同一判定線で、v6+MPC onのノード削減率を計測(前回: -40〜57%)。
3. **Gate 3(本番予算160k)**: T156dと同一方法・同一事前登録判定線(**深さ+1到達率≥35% かつ regret悪化≤+0.10石**。前回: 5.83%/+0.183で不合格)。同一判定線を使う理由: 前回との比較可能性。計測条件はv6(現本番設定: 160kノード・quota60%・空き20無制限)に更新。
4. **判定**: Gate 3合格→対局ゲート(T173、候補=v6+MPC on vs v6+MPC off、Edax lv10に加えlv12も相手に追加)へ進む提案。不合格→前回同様の事前登録撤退(再々評価条件を記録)。σ比較・各Gateの数値はすべてレポートに。
5. 計測は専有・決定的(T156の計測規律踏襲: meta監査可能・canonical SHA検証・detached+ツール呼び出しポーリング)。
6. `cargo test -p engine` 全パス(校正ツールを触った場合はそのテストも)。

## スコープ外

- MPC本番ON(T173ゲート合格+裁定後)・探索アルゴリズム自体の変更・aspiration併用の再設計(T089a申し送りの論点はONにする段で再確認)

## 受け入れ基準

1. σ比較表(v4校正時 vs v6校正時)とGate 2/3の全数値・判定がレポート(bench/edax-compare/t172_mpc_report.md + meta)にある
2. 判定はT156の事前登録判定線と同一基準で行われている(事後変更なし)
3. 計測はmetaから再現可能(条件・SHA・seed)
4. `cargo test -p engine` 全パス、完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 計測は他の重い処理と並行しない。作業ログ節目追記(校正完了・Gate 2完了・Gate 3完了ごと)

## 作業ログ

### 2026-07-21 実装(implementer)

**前提調査**: T156a〜d・design report・compare_mpc.py・calibrate_mpc.rs・t156_mpc_stats.py・t156_mpc_pilot_gate.pyを読み、前回の方法論を把握:
- T156bで選定された候補(d,D)=(3,6),(4,8),(2,10),(4,12)(4空き帯共通)。
- `engine/src/mpc.rs`のCALIBRATIONS表の値を逆算検証し、埋め込み式を確定: `slope_q16=round(slope*65536)`・`intercept_q16=round(intercept*65536)`・`margin_high=margin_low=ceil(1.5*residualSigma)`(t=1.5固定、calibration splitでfit)。16行全てで厳密一致を確認、この式をv6にもそのまま適用する。
- `calibrate_mpc measure`/`calibrate_mpc gate`は`--pattern-weights`が既に汎用パスパラメータ(v4ハードコードなし)。`compare_mpc.py`は`EXPECTED_V4_WEIGHTS_SHA256`等4つのcanonical SHAをfail-closedで検証しており、v6用に更新が必要(Gate 2/3実測時に対応)。

**σ比較(要件1)**:
- タイミング検証: 3局面・depths[2,3,4,6,8,10,12]で空き帯ごとの所要時間を実測(21-28: 約1.9s/局面、29-36: 約6.2s/局面、37-44: 約4.8s/局面、45-52: 約10.8s/局面)。全12深さ(元のpilot測定と同じ)ではなく、候補4ペアに必要な深さ[2,3,4,6,8,10,12]のみ測定(コスト削減、同一corpus・同一スクリプトで手法は同一)。
- `calibrate_mpc measure --positions bench/edax-compare/t156_mpc_positions.json --pilot-only --pattern-weights train/weights/pattern_v6.bin --depths 2,3,4,6,8,10,12 --out bench/edax-compare/t172_v6_pilot_measurements.json` をPowerShell Start-Process(detached)+Bash定期ポーリング(`until grep -q "^\[measure\] checkpoint=" ...; sleep 20/30`、Monitor通知には依存せず)で実行、320局面完走(実測約30分)。
- `t156_mpc_stats.py`(無変更)で `t172_v6_pilot_stats.json` を生成(84グループ=C(7,2)×4帯)。
- 新規スクリプト `bench/edax-compare/t172_sigma_compare.py` を作成し、候補4ペア×4帯=16行についてv4(`t156_mpc_pilot_stats.json`)とv6(`t172_v6_pilot_stats.json`)のresidualSigmaを比較。**結果: 16/16行でσ縮小、平均比(v6/v4)=0.5115(ほぼ半減)**。レポート: `bench/edax-compare/t172_sigma_compare_report.md`+meta。仮説(v6は探索値ラベル学習のため深さ間相関が強い)を強く支持。→**見込みあり、Gate 2/3へ進む**。
- v6測定値から上記埋め込み式でv6用CALIBRATIONS表を計算し、`engine/src/mpc.rs`のCALIBRATIONS定数を置き換え(モジュールdocも更新、旧v4値はσ比較レポート・git履歴で参照可能)。`cargo test -p engine --lib mpc` 8 passed、`cargo test -p engine --lib` 240 passed/0 failed/2 ignored(default OFF不変)。

**次のステップ**: Gate 2(固定深さ)実測へ進む。

### 2026-07-21 Gate 2/Gate 3実測・結論

**compare_mpc.py/test_compare_mpc.pyのv6対応**: `EXPECTED_V4_WEIGHTS_SHA256`定数(fail-closed検証)をv6のSHA(`e69f3b1c...`、T171配線時に実測済み)に更新し、名称も`EXPECTED_WEIGHTS_SHA256`へ一般化。レポート内のハードコード文言("v4"等)を`--weights-label`引数で差し替え可能にし、"原因分析と提言"paragraphも`--cause-analysis-file`(UTF-8テキストファイル読み込み、CLI引数への日本語直接埋め込みで生じたエンコーディング事故を回避)で差し替え可能にした。`test_compare_mpc.py`のcanonical改変拒否テストのfixtureをpattern_v4.bin→pattern_v6.binに更新。`python -B -m unittest bench.edax-compare.test_compare_mpc`(discover経由)10 passed。

**Gate 2(固定深さ、要件2)**: `calibrate_mpc gate --positions t156_mpc_positions.json --split test --depths 8,10,12 --exact-from-empties 0 --history off --aspiration off --mpc off/on --pattern-weights train/weights/pattern_v6.bin`をPowerShell detached+Bashポーリングで実行(各約23分、720レコード)。結果: D8/10/12ノード比0.6445/0.3556/0.1751(v4は0.8278/0.6025/0.4348)、全判定基準(集計10%減・bootstrap U95<0.97・中央値5%減・p90≤1.25)**合格**。v4よりMPCのノード削減効果が大幅に強化(D12で2.5倍の追加削減)。

**Gate 3(160k本番相当、要件3)**: `calibrate_mpc gate --positions t157_oracle_positions.json --min-empties 21 --depths 12 --max-nodes 160000 --exact-from-empties 16 --configuration A/B/C/D --pattern-weights train/weights/pattern_v6.bin`をA-D×2回(計8回、各約18秒、高速なため専有下でBash直接実行)。`compare_mpc.py`で集計・判定。

主判定線(T156と同一、事後変更なし): 深さ+1到達率≥35%かつregret悪化≤+0.10石。
- 深さ+1到達率: **11.67%**(v4: 5.83%、約2倍改善も35%には遠く未達)
- regret悪化: **+0.1333石**(v4: +0.1833石、改善も+0.10には未達)
- 補助指標(paired bootstrap上限): +0.3500石(v4: +0.6167石、こちらは今回+0.50以下をクリア)
- **Gate 3: 不合格**(主判定線2つとも未達のため)。

**総合判定**: σ(要件1、16/16行縮小・平均比0.51)・Gate 2(合格)は明確に改善したが、Gate 3の主判定線は依然未達。**事前登録どおり撤退(MPCはdefault OFF維持)**。T173(対局ゲート)へは進まない。将来の再評価条件として「(d,D)ペア再選定・帯結合見直し」「ノード予算拡大時の再評価」を記録。

**成果物レポート**: `bench/edax-compare/t172_mpc_report.md`(+`.meta.json`、σ比較とGate 2/3を統合した総合レポート、`t172_build_report.py`で決定的に生成、2回実行でSHA-256完全一致を確認)。内訳の個別レポート: `t172_sigma_compare_report.md`(+meta)、`t172_mpc_gates_report.md`(+meta)。

**検証**: `cargo test -p engine --lib` 240 passed/0 failed/2 ignored(mpc.rs変更後も不変)。`cargo test -p engine`(全バイナリ)全パス。`git diff --check`成功。Gate 2/3の一時checkpoint(`.t172-gate2-*.json`・`.t172-gate3-*-run*.json`)は削除済み(T156d前例どおり、レポート/meta以外の生データは残さない)。

**変更・追加ファイル**: `engine/src/mpc.rs`(v6再校正テーブルに置換)、`bench/edax-compare/compare_mpc.py`・`test_compare_mpc.py`(v6対応・パラメータ化)、`bench/edax-compare/t172_sigma_compare.py`(新規)、`bench/edax-compare/t172_build_report.py`(新規)、`bench/edax-compare/t172_v6_pilot_measurements.json`・`t172_v6_pilot_stats.json`(新規データ)、`bench/edax-compare/t172_sigma_compare.meta.json`・`t172_sigma_compare_report.md`・`t172_mpc_gates_report.md`・`t172_mpc_gates_report.meta.json`・`t172_mpc_report.md`・`t172_mpc_report.meta.json`(新規レポート一式)。

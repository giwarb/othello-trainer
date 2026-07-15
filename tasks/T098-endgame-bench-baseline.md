---
id: T098
title: 終盤ソルバー計測基盤(C1/C2/C3)とbaseline固定
status: review # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T098: 終盤ベンチ契約とbaseline固定

## 目的

終盤ソルバー強化シリーズ(T098〜T108、目標: Edax同等の終盤読み)の第1弾。以後の全施策(T099〜)の効果を汚れなく計測するための**ベンチ契約(C1/C2/C3)と現行ソルバーのbaseline**を先に固定する。

## 規範文書(必読)

- **設計レポート**: `tasks/design/T097-endgame-solver-report.md` — 特に §4(定量的な受け入れ基準: C1/C2/C3・E50定義・Edax比較プロトコル)と §5 T098節が本タスクの規範。§2.4(現行exactポリシーの実態と `exact.completed` の意味の注意)も必読。
- 依頼書: `tasks/design/T097-endgame-solver-request.md`(背景)。

## オーケストレーター裁定(レポート§8への回答、本シリーズ共通)

1. exact quotaの現行値は40%(t085a-v2)が正。T107では40%をbaselineに25/40/50/60/75%を再比較する。
2. 対局経路の閾値再校正と、解析・練習・詰めオセロの時間無制限exact設定は**別々に扱う**(後者は本シリーズで変更しない)。
3. シリーズ完了条件は「空き20〜24でEdax壁時計の幾何平均5倍以内・p90 8倍以内(実用同等帯)」。2倍以内(真の同等)はストレッチとして常に併記する。
4. FFOは#40〜49まで(コミット済み正解manifestの範囲)。#50〜59は本シリーズでは追加しない。
5. **専用ソルバー層でも論理ノード(訪問局面)単位のカウントを維持する**(160kノード予算の意味を施策前後で変えない)。node definition versionをテレメトリに含める。
6. Edax速度比較は「native vs Edax(同一マシン・単一スレッド・book off・同一TT容量)」と「WASM実用壁時計」の二軸で測る。
7. T106(TT区間化)はNWS導入後の上書き率テレメトリとA/Bを採用条件とする(必須実装にしない)。
8. 60局対戦は確認指標であり、ソルバー施策の採否はC1〜C3を主判定とする。

## 要件(設計レポート§5 T098節が規範。以下は要点+補足)

1. **終盤CLI**: `eval_cli` に、full-window/任意窓(`[alpha,beta]`)/node limit/TT容量を指定できる終盤ソルブサブコマンドを追加する。出力(JSON)に score・bound種別・nodes・elapsed・TT容量・solver version・node definition version・決定性検証に足るフィールドを含める。
2. **新テレメトリ**: 既存 `exact.completed`(木内のどれかのexact完走でtrue)を「root exactを解いた」と誤認しないよう、root exact完走/bound証明完走/leaf exact完走を区別できるフィールドを追加する(既存フィールドの意味は互換のため変えず、新フィールドを足す)。
3. **ベンチコーパスとハーネス**:
   - `bench/edax-compare/endgame_positions.json`(新規): C2用に `t096_oracle_positions.json` の60局面(空き18〜26)を終盤ベンチ用に再利用し、**Edax(level 60・book off・`-n 1`)でルートの正確な石差を一度生成してmanifestに固定**する(符号規約=親手番視点を全局面で検証)。
   - `bench/edax-compare/endgame_bench.py`(新規): C1(FFO #40〜49)/C2(証明窓: fail-high `[S-1,S]`・fail-low `[S,S+1]`・full `[-64,64]` を予算別に計測)/C3(実対局経路 `eval_cli best --max-nodes 160000 --time-ms 1500`、TT 64MiB)を1局面単位のatomic checkpoint+resumeで実行できるハーネス。E50_bound/E50_exact(§4.2)の集計を出力する。
   - **Edax batch測定**: プロセス起動時間を除外できるbatch実行、1回warmup後最低3回、実行順交互、局面ごと中央値、幾何平均とp90併記(§4.3)。T094のバッチ実行・`-n 1` の知見を流用してよい。
4. **baseline計測と保存**: 現行ソルバーで C1(#40〜44は完全、#45〜49は現実的なnode capを設けてよい。cap到達は「未完」と正直に記録)・C2(予算64k/160k/512kの証明窓)・C3 を計測し、`E50_exact(160k)` / `E50_bound(64k)` のbaseline値、Edax速度比(空き20〜24)を確定する。結果はコミット対象のbaselineレポート(JSON/mdどちらでも、`bench/edax-compare/` 配下)として保存する。
   **【2026-07-15 ユーザー裁定による軽量化】C1速度計測の3反復は不要。完了済みの反復(最低1反復)のデータだけで速度baselineを確定してよい**(反復数をレポートに明記する)。途中で打ち切られた反復の部分データは集計に混ぜない(破棄または参考記録)。warmup+3反復+交互順のフルプロトコルはT108(最終ゲート)でのみ実施する。決定的な値(score・nodes・bound)は反復数に依存しないため影響なし。
5. **長時間実行ルール厳守**: 全計測は局面単位checkpoint+resume+進捗ログ。時間計測は専有状態で行う(他の重い処理と並行しない)。
6. Rustソルバー本体(`endgame.rs`)のアルゴリズム変更は**しない**(計測・テレメトリ・CLI追加のみ。既存探索のノード数・値を変えない)。

## やらないこと(スコープ外)

- ソルバーのアルゴリズム改善(T099以降)
- exactポリシー・閾値・quotaの変更(T107)
- FFO #50〜59の追加
- アプリ/Workerプロトコルの変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(既存FFO fastの値・ノード数が不変であることを含む。※`node_limited_protocol_requests_are_deterministic` はフル並列時に既存フレーキーの実績あり、失敗時は単独再実行で切り分け)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 正解値・ノード数が既存記録と一致(ソルバー無変更の確認)
- [ ] 新CLIで同一局面・同一条件2回実行 → score/nodes/bound完全一致(決定性)
- [ ] C2真値manifest: 60局面全件にEdax石差が入り、符号規約検証(自作ソルバーで数局面をfull-window解きEdax値と一致)が記録されている
- [ ] baselineレポートに E50_exact(160k)・E50_bound(64k)・C2予算別証明完走率・空き20〜24のEdax速度比(幾何平均/p90)・C3(oracle regret・決定性・wall保険率)が記録されている
- [ ] ハーネスの途中中断→resumeで完了済み局面がスキップされ結果が変わらない
- [ ] `python -m pytest bench/edax-compare/ -q` 全件パス(既存+新規テスト)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(大きな生JSONはgitignore領域、集計レポートのみコミット)

## フィードバック(やり直し時にオーケストレーターが記入)

### 仕上げ指示(2026-07-15 夜、ユーザー指示による計測打ち切り後の再委譲)

初回セッションは実装(endgame_bench.py・endgame_positions.json・test_endgame_bench.py・eval_cli/search.rs改修)を完了し、C1速度baselineの第2反復まで進んだ時点で**ユーザー指示(「3反復不要、正常値なら次へ」)により計測を打ち切った**(オーケストレーターがプロセス停止。実装・チェックポイントは無傷)。本セッションでやること:

1. **新たな長時間計測を開始しない**。既存チェックポイント(resume機構で発見できるはず)から、完了済みデータのみで集計を確定する: C1速度は完了済み反復(第1反復、可能なら完走した第2反復分も反復単位で)のみ使用。C2/C3・Edax真値・ノードbaselineが未計測の項目があれば、**速度反復なし(1回実行)**で計測して埋める(決定的な値なので1回でよい)。
2. baselineレポートを確定し、受け入れ基準のうち軽量な検証(cargo test -p engine、pytest、決定性2回、resume確認)を実行する。FFO releaseベンチ(約10分)は実行してよい。
3. 作業ログに: 実装内容・打ち切りの経緯・使用した反復数・baseline値(E50、Edax速度比、C2/C3集計)・変更ファイル一覧を記録する。
4. 想定外に大きな未計測項目が残っている場合は、勝手に長時間実行せず「何が残っていて何分かかる見込みか」を作業ログに書いて終了する(オーケストレーターが判断する)。

## 作業ログ(担当エージェントが追記)

### 2026-07-15 Codex 実装・baseline確定

- 実装: `eval_cli solve`（任意窓、node/time limit、TT容量、JSONテレメトリ）を追加し、`best` にTT容量指定と solver/node-definition version、root exact完走・bound証明完走・leaf exact完走の区別を追加した。C1/C2/C3、Edax batch、局面単位atomic checkpoint/resume、E50・速度比集計を行う `endgame_bench.py` とテストを追加した。`endgame.rs` のアルゴリズム、exact policy/quota、アプリ/Worker protocolは変更していない。
- manifest: `endgame_positions.json` はT096の60局面すべてにEdax 4.6 level 60、book off、`-n 1`、64MiBの手番側石差を固定済み。native full-windowで先頭3局面（空き18,18,19）を照合し、score 28/42/12が全件一致した。
- 計測打ち切り: 初回セッションで速度第2反復開始後、ユーザー指示により停止された。本仕上げでは新しい長時間速度計測を開始せず、完走した第1反復（空き20〜24のC2独立34局面）のみ採用した。第2反復の部分データ（engine 1局面）は集計から除外した。T108でwarmup+3反復+交互順のフルプロトコルを行う。
- baseline: C1は#40〜44が全問正解、#45〜49は5,000,000 node cap到達で未完として記録。C2は540/540 jobs完了。`E50_exact(160k)` と `E50_bound(64k)` はともに観測範囲（空き18〜26）で50%到達なし、すなわち `<18`（JSONは`null`とcorpus minimum 18を併記）。C2完走率は64kがfail-high/fail-low/fullすべて0/60、160kが1/60・0/60・0/60、512kが5/60・0/60・0/60。native/Edax速度比（空き20〜24、34局面、第1反復）は幾何平均135.679764倍、p90 514.302227倍。
- C3: 48/48局面完了、平均oracle regret 1.4375石、2回実行の決定性100%、wall保険率0%。
- 検証: `python -m pytest bench/edax-compare/ -q` は15 passed（atomic中断→resume後の結果一致と部分速度反復除外を含む）。`cargo test -p engine` は178 passed / 2 ignored。`cargo test -p engine --release --test ffo_bench -- --nocapture` は#40〜44が全問正解、合計1,298,656,784 nodes（既存記録一致）、474.741秒。新CLI同一狭窓を2回実行し、score=28、bound=lower、nodes=158,526が完全一致。`rustfmt --edition 2021 --check engine/src/bin/eval_cli.rs engine/src/search.rs`、対象ファイルの`git diff --check`も成功。全workspaceの`cargo fmt --all -- --check`は本タスク外の既存未整形ファイルを多数検出したため不合格だったが、本タスクのRust変更2ファイルは個別check済み。
- 変更ファイル（コミット対象）: `.gitignore`, `engine/src/bin/eval_cli.rs`, `engine/src/search.rs`, `bench/edax-compare/endgame_bench.py`, `bench/edax-compare/endgame_positions.json`, `bench/edax-compare/test_endgame_bench.py`, `bench/edax-compare/endgame_baseline.json`。`tasks/T098-endgame-bench-baseline.md` は作業ログのみでコミット対象外。コミットハッシュはCodex環境の`.git`書き込み禁止のため未作成。

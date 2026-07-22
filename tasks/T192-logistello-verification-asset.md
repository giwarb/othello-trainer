---
id: T192
title: Logistello bookの取り込み(24空きWLD検証資産化)
status: in_progress
assignee: implementer
attempts: 0
---

# T192: Logistello bookの取り込み(24空きWLD検証資産化)

## 目的

Logistello book skeleton(M. Buro、約3.7万自己対戦ライン、**全ライン24空きまでWLD検証済み**)を、エンジンの終盤ソルバー・評価関数の独立検証資産として取り込む。学習データとしてではなく「第三者由来の正解付き局面セット」としての資産化が目的(T179調査の推奨4)。

## 背景・コンテキスト(explorer調査済み 2026-07-22。着手時に現物と突き合わせること)

- 入手元: https://skatgame.net/mburo/log.html の `logbook.wtb.gz`(WTHOR形式と推定)。ライセンスはGPL(ソース一式と同梱)。**本リポジトリの一貫方針(生データ・巨大生成物はコミットしない)に従い、生データはコミットしない**。
- 既存WTHORパーサ: `train/src/wthor.rs:169 parse()` / `:294 replay()`。replayは`&moves[..n]`で途中局面を復元できる。ヘッダ検証は N2=0・P1∈{0,8}・N1×68==本体バイト数。**logbook.wtbが本当にこの形式か未検証(バイト単位の確認はこのタスクの最初の関門)**。
- 検証資産の既存形式: `bench/edax-compare/t157_oracle_positions.json` + `_labels.json` の分離形式(schemaVersion+provenance sha256+positions[]/labels[])。抽出済み小規模curatedセットのみコミットする慣行(T096=60局面、T157=180局面)。
- ダウンロードスクリプト前例: `bench/edax-compare/download-edax.ps1`(固定URL→Invoke-WebRequest→展開、スクリプトはコミット・成果物はgitignore)。
- exact solve CLI: `eval_cli solve`(`engine/src/bin/eval_cli.rs:656 cmd_solve`、stdin JSONで局面を受けsolve結果をJSON出力)。Pythonハーネス前例は `bench/edax-compare/endgame_bench.py`。
- 速度感: 現行エンジン(T191時点、FFOベンチNPS約10.8M)でFFO fast(20-26空き)5問60秒 → 24空き1局面あたり約10〜60秒の見込み。**全3.7万局面の完全読みは非現実的、検証はサンプリング**。
- `.wtb`の`theoretical_score`(1バイト、`train/src/wthor.rs:104-105`)がLogistelloデータで何を意味するか(24空き時点の完全読み石差か、WLDか、別定義か)は**実データで要確認**。本タスクのexact solve照合がその確認を兼ねる。

## 変更対象

- `bench/logistello/download-logbook.ps1`(新規) — logbook.wtb.gz のDL+gz展開+sha256表示(download-edax.ps1と同型)
- `.gitignore` — `bench/logistello/data/` を追記(train/data/と同じ理由コメント)
- `train/src/bin/logistello_extract.rs`(新規、または train 配下の適切な場所) — wthor::parse/replayで各ラインの**24空き時点**の局面を抽出し、盤面64文字+手番+ラベル(theoretical_score生値と、それをWLDに落とした値)+provenance(元ファイルsha256、ライン番号)をJSON出力(全件出力は `bench/logistello/data/` 配下=gitignore)
- `bench/logistello/logistello_wld_sample_positions.json` + `_labels.json`(新規・コミット対象) — 固定シードで層化サンプリングした**100局面**のcuratedセット(t157形式に準拠)
- `bench/logistello/verify_wld.py`(新規) — サンプル局面を `eval_cli solve`(フルウィンドウ・制限なし)で完全読みし、スコア/WLDをラベルと照合。**局面単位のチェックポイント保存+resume対応+進捗ログ必須**(合計10分超の実行のため長時間実行ルール適用)
- `bench/logistello/README.md`(新規) — 出典URL・ライセンス(GPL)・生データ非コミットの方針・使い方
- `bench/logistello/t192_verification_report.md`(新規) — 検証結果レポート

## 要件

1. **形式確認が最初の関門**: DLした logbook.wtb を `train::wthor::parse` に通し、パース可否・ゲーム数・レコード整合を確認して作業ログに記録する。非互換ならヘッダ/レコード差分を特定し、wthor.rs本体は変更せず抽出ツール側で吸収する(本体変更が必要な場合は作業を止めて報告)。
2. 抽出: 各ラインを replay して24空き時点(手数=盤面の空きが24になった時点。ラインが24空きに達しない場合はスキップし件数を記録)の局面を抽出。重複局面は除去(canonical化はせず素の盤面一致でよい)し、除去数を記録。
3. サンプリング: 固定シード(例 `logistello-t192`)で100局面を抽出(theoretical_scoreの符号カテゴリ〔勝/敗/引分〕で層化。カテゴリ件数が偏る場合は比例配分し、引分は最低5局面確保)。
4. 検証: サンプル100局面を eval_cli solve で完全読みし、(a) スコア一致率(theoretical_scoreが石差なら完全一致するはず)、(b) WLD一致率を集計。**照合の意味づけ(手番視点の符号規約)は最初の数局面で慎重に確定してからバッチ実行すること**。不一致が出た場合は落とさずに全件記録し、原因分析(ラベル定義の解釈違い/データ品質/自前ソルバー疑い)をレポートに書く。自前ソルバーを疑う場合はFFOが通っていることを反証として明記。
5. レポート: 抽出統計(総ライン数・抽出局面数・スキップ/重複数)・検証結果(一致率・不一致の内訳)・theoretical_scoreの意味の結論・今後の用途提案(回帰テスト化の可否)を `t192_verification_report.md` に記載。
6. 検証実行は専有不要(時間計測ではない)が、チェックポイント+resume+進捗ログを必ず実装する(逐次保存、全部終わってから一括書き出しは禁止)。

## やらないこと(スコープ外)

- 学習データとしての利用・学習パイプライン(train/data/)への統合(既存WTHOR経路の再現性を壊さないため、ディレクトリも分離する)
- 全3.7万局面の完全読み検証(サンプル100局面のみ)
- logbook.gam(.gam形式)の取り込み(wtbを主対象とする)
- 生データ(logbook.wtb)・全件抽出JSONのコミット
- エンジン・アプリ本体の変更(Pages確認も不要)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `./bench/logistello/download-logbook.ps1` が logbook.wtb を取得・展開し sha256 を表示する(再実行安全)。
- [ ] 抽出ツールが全ラインを処理し、統計(総数・スキップ・重複除去)を出力する。`cargo test -p train` が全件パス(既存テストの回帰なし)。
- [ ] サンプル100局面の positions/labels JSON(provenance sha256付き)がコミットされている。
- [ ] `python bench/logistello/verify_wld.py` がチェックポイント+resume対応で完走し、一致率がレポートに記録されている(中断→再実行で完了済み局面をスキップすることも確認)。
- [ ] レポート `t192_verification_report.md` に要件5の内容が揃っている。
- [ ] 変更を main に push し、GitHub Actions(Rust Tests)の成功を確認する(Pages実機確認は不要=アプリ無変更)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。生データ・全件JSONがコミットに混入していないこと。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(gitignore済みのローカルデータは残ってよい)。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 実装(implementer)

**形式確認(要件1)**: `https://skatgame.net/mburo/logbook.wtb.gz` をDL・gzip展開すると
`logbook.wtb`(2,564,228バイト)。ヘッダ: N1=37709, N2=0, P1=0(8x8), P2=0, P3(depth)=0
(公式FFOアーカイブと異なりP3が埋まっていないが、N1×68==本体長でヘッダ検証は通過)。
`train::wthor::parse`にそのまま通った。**`train/src/wthor.rs`本体の変更は不要だった。**

**`theoretical_score`の意味(要件4の事前確認、要件2/4の一部)**: 37709ライン全件を
Pythonで直接バイト解析し、`theoretical_score == black_disc_count`が**全件完全一致**
(値域10〜60)することを確認。→「黒の最終石数(0..64)」であるという仮説を得た
(`t192_verification_report.md`§2に詳細)。**この仮説はまだeval_cli solveでの
完全読み照合による裏付けができていない**(下記参照、オーケストレーター指示によりバッチ未実行)。

**抽出(要件2)**: `train/src/bin/logistello_extract.rs`を新規作成。24空きは
「初期局面から36手再生した時点」で必ず一致する不変量(各着手が必ず1マスを埋めるため
`empties=60-再生手数`)を利用。実行結果: 総ライン37,709、スキップ0(短すぎ/再生エラー/
空き数不一致いずれも0件)、重複(盤面+手番の完全一致)除去9,539、抽出ユニーク局面28,170。
`cargo test -p train`(新規テスト4件含む)全件パス。

**サンプリング(要件3)**: `bench/logistello/select_sample.py`(固定シード文字列
`"logistello-t192"`、`random.Random`)で、`theoretical_score`由来の黒石差符号
(black_win/black_loss/draw)比例配分(最大剰余法、draw最低5局面保証)により100局面選定。
実績: black_win 39、black_loss 42、draw 19(母集団に対する比例配分で最低保証は不要だった)。
`logistello_wld_sample_positions.json` + `_labels.json`をt157形式に準拠して出力
(labelsの`expectedScoreSideToMove`/`expectedWldSideToMove`は上記仮説に基づく未検証値、
`metadata.verified=false`)。

**照合ハーネス(要件4/6)**: `bench/logistello/verify_wld.py`を実装(`run`/`report`
サブコマンド、局面ID昇順の決定的処理順、チェックポイント`verify-results/`配下に
局面単位で逐次atomic書き込み、resume時は完了済みIDをスキップ)。`py_compile`で
構文確認済みだが、**eval_cli solveの実行(バッチ本体・少数局面での符号規約確認とも)は
オーケストレーター指示により今回は未実施**。

**中断指示への対応**: オーケストレーターから「Edax速度・対局計測のマシン専有を優先する
ため、verify_wld.pyのバッチ照合(および少数局面の事前確認含め、eval_cli solveの実行)を
開始しないこと」との連絡を受け、上記までで作業を止めた。バッチは未開始のため
チェックポイントファイル自体は存在しない(resumeは次回`verify_wld.py run`実行時に
自然に機能する設計)。

**コミット・push**: `git add`はパス明示(`.gitignore`, `train/src/bin/logistello_extract.rs`,
`bench/logistello/{README.md,download-logbook.ps1,select_sample.py,verify_wld.py,
logistello_wld_sample_positions.json,logistello_wld_sample_labels.json,
t192_verification_report.md}`)。生データ(`bench/logistello/data/`)・
チェックポイント予定地(`bench/logistello/verify-results/`)は`.gitignore`に追加し
コミットに含まれていないことを確認済み。コミット `92341ca`
「bench,engine: Logistello book取り込み — 抽出・100局面サンプリングまで(T192)」を
`main`にpush済み。GitHub Actions(Rust Tests)の結果はこの後追記する。

**残作業**: マシン専有計測(Edax速度・対局計測)完了後、オーケストレーターの再開指示を
受けて (a) `eval_cli solve`による少数局面での符号規約確認 → (b) 100局面バッチ照合
(チェックポイント+resume、フォアグラウンド完走) → (c) `t192_verification_report.md`
§5/§6を実測値で更新 → (d) 再度push・Actions確認、の順で完了させる。

**ステータス: 照合フェーズ待機中(オーケストレーターの再開指示待ち)。**

# T098 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### 1. baseline を生成したハーネスがコミットされたハーネスと一致せず、計測契約を監査・再現できない

[baseline の provenance](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_baseline.json:14)では、計測時の `harnessSha256` が `14457e...`、レポート生成時の `reportHarnessSha256` が `6cd159...` となっています。後者だけがコミットされた [endgame_bench.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:1) のハッシュと一致します。

さらに、[Checkpoint 初期化](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:167)は `report` 実行時にハーネスだけの不一致を明示的に許可しています。計測に使った `14457e...` 版のソースも生 checkpoint もコミットされていないため、レビュー時点では次を確認できません。

- C1/C2/C3 の実行条件や保存形式が現行ハーネスと同一だったか
- E50、部分反復除外、速度比などに影響する変更が計測前後に入っていないか
- T099以降が同じ契約で比較できるか

本タスクの目的は「以後の施策を汚れなく比較する baseline の固定」であり、生成元コードがコミット内容と一致しない baseline はその中心目的を満たしません。計測時ハーネスとの差分を監査可能な形で残すか、現行ハーネスで必要な決定的計測・集計を再確定する必要があります。

## (b) 中（次タスクで対応すべき）

### 1. Edax batch の正常終了および完全読み到達を検証していない

[edax_batch](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:142)は `subprocess.run` の終了コードを確認せず、そのまま標準出力を解析しています。また、正規表現では深さを取得していますが、[parse_edax_output](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:125)は最終行の深さが局面の空き数に到達したかを検証・保存していません。

Edaxが異常終了しても解析可能な途中出力が残れば、その最終行を真値として manifest に固定する可能性があります。今回は3局面について native full-window と一致していますが、残り57局面を機械的に保証するには以下が必要です。

- Edaxの終了コードが0であること
- 各局面の最終行が完全読み深さに達していること
- 可能なら深さ・nodes等もmanifestまたは監査用集計へ保存すること

### 2. `report` が不完全な checkpoint を baseline として出力できる

[aggregate](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:507)は件数を表示するだけで、C1/C2/C3や速度反復の完了を必須条件にしていません。[write_report](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:597)も無条件に `"status": "baseline"` を設定します。

途中 checkpoint に対して実行すると、欠損局面を分母から除外したE50や完走率を正式 baseline として保存できます。今回のコミット済みレポートは C1=10、C2=540、C3=48、速度=完走1反復で揃っていますが、ハーネス契約としては件数不足時に失敗させるべきです。

### 3. baselineレポートにC2/C3の重要な生テレメトリが残っていない

[C3集計](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/endgame_bench.py:560)では oracle regret・決定性・wall保険率だけが保存され、設計レポートで計測対象とされた到達深度、exact試行数、bound証明完走数、quota/global abortはコミット済みレポートに残りません。C2も予算別完走率だけで、局面別nodesは生checkpointにしかありません。

生checkpointは `.gitignore` 対象なので、削除後はT099以降でbaselineとの詳細比較や異常値の再確認ができません。全540行を残す必要がない場合でも、空き数・予算・窓別のnodes分布や中央値、C3テレメトリ集計はコミット対象レポートに保存するのが妥当です。

### 4. CLIの「任意窓」が石差範囲内に制限されている

[cmd_solve](/C:/Users/yoshi/work/othello-trainer/engine/src/bin/eval_cli.rs:638)は `alpha` と `beta` の双方を `[-64,64]` に制限しています。現在のC2真値は `-60..50` なので問題化していませんが、真値が `-64` または `64` の局面では標準証明窓 `[S-1,S]` / `[S,S+1]` がこの制約を超えて実行不能になります。

ソルバー自体が受け入れられる安全な範囲で外側境界を許可するか、端点局面用の窓定義を契約に明記すべきです。

## (c) 軽微（記録のみ）

- `eval_cli` の usage 表示に新しい `solve` サブコマンドが追加されていません。[main の usage](/C:/Users/yoshi/work/othello-trainer/engine/src/bin/eval_cli.rs:107)から利用方法を確認できません。
- `endgame_baseline.json` と `endgame_positions.json` はCRLFでコミットされており、`git diff --check 324fc77..ef9c1f1` は全行を trailing whitespace として検出します。機能影響はありませんが、作業ログの「git diff --check成功」と一致しません。
- 新テレメトリはnode-limit経路では root/bound/leaf を区別できています。非node-limitの中盤探索内でleaf exactへ入る既存経路では、新しいleaf完走数を更新しないため、将来このテレメトリをC3以外へ広げる際には整理が必要です。
- `git status --short` にはタスクログの変更と次タスクの未追跡ファイルが残っていますが、レビュー対象コミット `ef9c1f1` の製品差分には含まれていません。

## 確認結果

- `git log 324fc77..ef9c1f1`：対象コミットは `ef9c1f1` の1件。
- `endgame_positions.json`：60局面、ID・盤面・手番・空き数はT096原本と全件一致、重複盤面なし、空き18～26。
- baseline：C1 5/10完走、C2 540/540、C3 48/48、速度34局面・完走1反復採用・部分反復1件除外を確認。
- 新CLIを同一条件で2回実行し、`score=28`、`bound=lower`、`nodes=158526` の一致を確認。
- `python -m pytest bench/edax-compare/ -q` は、今回のread-only環境で利用可能な一時ディレクトリがなく起動前に失敗しました。コード起因のテスト失敗ではありません。作業ログ記載の `15 passed` は成果物とテスト内容の静的確認に留めました。
- Rustソルバー本体 `endgame.rs` のアルゴリズム変更、exact policy/quota変更、アプリ／Workerプロトコル変更はありません。

## (d) 総合判定

**不合格**

CLI、テレメトリ、atomic checkpoint、C1/C2/C3集計、manifest、軽量化裁定に沿った1反復速度baselineは概ね仕様どおり実装されています。また、コミット済み数値にも明白な計算矛盾は見つかりませんでした。

しかし、計測時ハーネスのハッシュがコミットされたハーネスと一致せず、そのソースと生checkpointも保存されていません。T098の主目的である「後続施策が依拠できる監査可能なbaseline固定」を満たさないため、doneを止めるブロッカーと判定します。
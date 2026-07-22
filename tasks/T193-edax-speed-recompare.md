---
id: T193
title: 対Edax速度比較の更新計測(高速化第2弾後、T180方式)
status: done
assignee: implementer
attempts: 0
---

# T193: 対Edax速度比較の更新計測(高速化第2弾後、T180方式)

## 目的

高速化シリーズ(T184/T185/T186/T187/T189/T190/T191)適用後の現行エンジンが、Edaxに対して速度でどこまで肉薄したかを実測で更新する(ユーザー依頼)。基準はT180の計測(**中盤深さ12で対Edax 57〜69倍遅い**、終盤20倍)。同一手法・同一局面で現行HEADを再計測し、倍率の推移を報告する。

## 背景・コンテキスト

- 基準計測: `tasks/T180-engine-bottleneck-analysis.md` と対応するbench/edax-compare配下のレポートに、対Edax比較の具体的手法(使用したEdaxバイナリ・オプション・局面バッチ・深さ・集計方法)が記録されている。**必ずT180の手法を読み、同一条件で再計測すること**(条件を変えると倍率が比較不能になる)。
- 中盤バッチ: T180以降の標準20局面(`bench/edax-compare/t156_mpc_positions.json` の split==test・空き29-36帯・先頭20件)、深さ12。
- 自前エンジン側: `eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`、MPC off/on両方(T191時点のNPS: off約2.15M/on約1.92M)。
- Edax側: T180で使用したのと同じバイナリ(bench/edax-compare/配下、download-edax.ps1で取得したもの)・同じ設定(深さ12固定、book off等)。Edaxのバージョン・ハッシュをレポートに記録。
- 参考として途中経過の倍率推移: T180時点57-69倍 → T184後27-30倍 → T185後26-29倍(いずれもSTATUS/各レポート記載)。
- 終盤(endgame)側は本シリーズで未変更のため再計測は不要(T108の C2無制限 幾何平均19.17倍 が現行値。レポートに「終盤は未変更のため据え置き」と明記)。

## 要件

1. **マシン専有で計測**(開始前に他の重いプロセスの不在を確認。T192の照合バッチは停止済みのはず — eval_cli/python等が残っていないことを確認)。
2. 中盤20局面×深さ12を、自前エンジン(MPC off/on)とEdaxで各3回計測し、壁時計の中央値または平均(T180の集計方法に合わせる)で倍率を算出。交互実行(A,B/B,A)で系統誤差を避ける。
3. 自前エンジンのノード数が既知の値(off 59,440,032 / on 6,487,461)と完全一致することを確認(計測の同一性の証拠)。
4. レポート `bench/edax-compare/t193_speed_recompare_report.md` + raw JSON: 倍率(off/on別)、T180/T184/T185時点との推移表、Edaxバイナリのsha256・オプション、終盤据え置きの注記。
5. 節目ごとにタスクファイルの作業ログへ追記。バッチ実行はフォアグラウンドで完走まで待つ(バックグラウンド放置禁止)。

## やらないこと(スコープ外)

- エンジン・アプリのコード変更(計測のみ)
- 終盤(C2系)の再計測
- 対局による強さ比較(T194で別途実施)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] レポート+raw JSONがコミットされ、中盤深さ12の対Edax倍率(off/on)とT180からの推移が記載されている。
- [ ] 自前側ノード数が既知値と完全一致している。
- [ ] Edax側の条件(バイナリsha256・オプション)がT180と同一であることがレポートで確認できる(異なる場合は理由と影響を明記)。
- [ ] 変更を main に push し、GitHub Actions(Rust Tests)成功を確認(アプリ無変更のためPages実機確認不要)。
- [ ] コミットはレポート成果物のみをパス明示でadd。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-22 着手・準備確認(implementer)

- **専有確認**: `Get-Process`でpython/cargo/eval_cli/wEdax/rustc/node系のプロセスが無いことを確認、`Get-CimInstance Win32_Processor`のLoadPercentage=1%。T192の照合バッチは停止済み。
- T180(`tasks/T180-engine-bottleneck-analysis.md` + `bench/edax-compare/t180_bottleneck_report.md`/`.meta.json`)を精読し手法を確認: 中盤バッチはEdax `-l 12`(`wEdax-x86-64.exe`、`-book-usage off -eval-file data/eval.dat -vv`)、うちは`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights pattern_v6.bin`(MPC off/on)。T184で確立した「対Edax倍率更新値」はEdaxを再測定せず相対倍率を適用する方式だったが、本タスク(T193)はユーザー要求により**Edax側も直接再測定**する(要件2-4)。
- 対象20局面(`t156_mpc_positions.json`のemptyBucket==29-36・split==test先頭20件、id `mpc-29-36-test-001`〜`020`)をOBF化しscratchpadに保存。
- `eval_cli`をHEAD(`92341ca`)から2種ビルド: off(featureなし、sha256=`278c460e...`)/on(`--features mpc_enabled`、sha256=`92cc5745...`)。スモークチェックでノード数が既知値(off 59,440,032 / on 6,487,461)と完全一致することを確認済み(要件3充足)。
- Edax実行条件を`wEdax-x86-64.exe`(sha256=`aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1`、v4.6公式リリース、`download-edax.ps1`で取得したもの、`.gitignore`対象で追跡外・T022以降未再取得〈mtime 2024-12-18で不変〉)で確認中。次に-vv出力の集計行フォーマットを確認してから交互3回計測に入る。

### 2026-07-22 計測実施・完了(implementer)

- 20局面を1つのOBFにまとめ`wEdax-x86-64.exe -solve <obf> -l 12 -eval-file data/eval.dat -book-usage off -vv`を実行したところ、末尾に`<file>: N nodes in H:MM.SSS (cpu = H:MM.SSS) (NPS nodes/s).`という全局面集計行が出ることを確認(T180と同じ集計方式が再現可能と判断)。
- 交互3回計測スクリプト(`t193_run_bench.py`、scratchpad保持・非コミット)で、MPC off比較・on比較それぞれ3ラウンド(ラウンドごとに自エンジン→Edax/Edax→自エンジンの順を入れ替え)を実行。実行前後に`Get-Process`で専有確認済み。
- **結果**: MPC off — 自エンジン平均2,109,652 NPS(nodes=59,440,032、既知値と3ラウンド完全一致)、Edax平均32,870,844 NPS(nodes 9,620,755〜9,763,073で変動、T180の9,710,607も範囲内) → **倍率約15.58倍**。MPC on — 自エンジン平均1,944,520 NPS(nodes=6,487,461、既知値と完全一致)、Edax平均29,309,012 NPS → **倍率約15.07倍**。T180(57-69倍)・T184/T185(相対倍率方式の推定26-30倍)から大幅に縮小。
- レポート`bench/edax-compare/t193_speed_recompare_report.md`+生データ`bench/edax-compare/t193_speed_recompare_report.meta.json`を作成。Edaxバイナリのsha256はT180未記録だったため本タスクで初めて記録(ファイルmtime不変・再取得記録なしから同一ファイルと判断できる旨をレポートに明記)。
- 本タスクはコード変更なし(計測のみ)。`git status --short`確認後、レポート2ファイル(`bench/edax-compare/t193_speed_recompare_report.md`/`.meta.json`)のみをパス明示でコミット(4ff5de6)・push済み。GitHub Actions「Rust Tests」(run 29914366364)成功を確認済み(`gh run view --json status,conclusion` → `completed`/`success`)。アプリ無変更のためPages実機確認は対象外(要件どおり)。
- コミット後の`git status --short`は本タスクファイル自身の差分のみ(作業ログ追記、コミットはオーケストレーター担当)で、他の当該タスク由来の差分・未追跡ファイルは残っていない。

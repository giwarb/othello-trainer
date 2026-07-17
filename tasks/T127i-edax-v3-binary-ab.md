---
id: T127i
title: Edax v3バイナリ(AVX2)+スレッド数の値一致+速度A/B(1M生成さらなる高速化の判定材料)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T127i: Edax v3バイナリ + -n 2 A/B

## 目的(ユーザー指示 2026-07-18 朝「まだやれる高速化はないか」)

走行中のexpanded1m生成(残り約51万件)をさらに速くする2つの候補の判定材料を作る:

1. **バイナリ乗り換え**: 現行は `bench/edax-compare/edax-extract/wEdax-x86-64.exe`(ベースライン版)。同ディレクトリに `wEdax-x86-64-v3.exe`(x86-64-v3 = AVX2/BMI2最適化版)が同梱済みで、本機CPU(AMD Ryzen 7 5800U, Zen 3)は対応している。同一バージョンのビルド違いなので探索結果は同一のはずだが、実測で確認する。
2. **スレッド数 `-n 2`**: 現在は8シャード×`-n 1`で論理16スレッド中の使用率約55%(物理8コアが埋まりSMT側が遊んでいる)。`-n 2`でSMT余力を使えるかもしれないが、並列探索は(特にlevel16帯で)スコアの決定性・同一性が崩れるリスクがあるため、値一致を厳密に確認する。

判定式(オーケストレーターが判断、本タスクは材料作りまで):
- **v3バイナリ: 値が全帯・全件一致 かつ 10%以上高速 → 乗り換え提示**(現行レコードは全保持、T127hと同じmeta移行方式)
- **-n 2: 帯ごとに判定。**exact帯はスコア理論上一意なのでscore一致が必須条件、bestMoveのタイブレーク差は別掲で報告。level16帯で1件でもscore不一致なら-n 2はその帯では不採用(exact帯限定採用の可能性は残す)。同一設定2回の再現性(決定性)も帯別に報告。

## 厳守事項(T127f/T127gと同じ・生成が並行稼働中)

- **実行中の生成プロセス群(python3.11 9個+wEdax群)に一切触れない・killしない。**
- **`bench/edax-compare/gen_teacher_corpus.py`は変更しない**(生成中コード凍結)。
- `vs_edax.py`の変更が必要な場合は**「新引数未指定時は1バイトも挙動が変わらない」加算形のみ**。既存の`edax_hash_bits: int|None = None`と同じ流儀で、例: `_edax_solve_batch(..., edax_exe: Path|None = None, edax_threads: int|None = None)`(Noneなら現行の`EDAX_EXE`と`-n 1`)。
- 生成中のplan/checkpoint/シャードファイルは**読み取りのみ**。
- 計測は生成と並走でCPU競合下になるため、**arm同士を交互実行するペア比較(比率で判定)**にする。絶対値は使わない。
- 一時成果物はscratchpad(`$env:TEMP\claude\...\scratchpad`配下)へ。stage単位でappend+flush+fsyncし、中断からのresumeに対応する(完了済みstageはスキップ)。
- **警告: `train/src/bin/teacher_candidates.rs`のバイナリに`--help`を渡すと実際に抽出が走り出力を上書きする事故が過去にあった。本タスクでは当該バイナリを一切実行しないこと。**

## 実験設計(T127gの方式を踏襲。T127gの作業ログとレポート`bench/edax-compare/t127g_warm_tt_ab_report.md`、T127fのレポート`bench/edax-compare/t127f_edax_hash_ab_report.md`を先に読むこと)

1. **サンプル**: selection plan(`train/data/teacher/corpus_expanded1m_selection_plan.jsonl`、SHA固定済み)の**未生成局面**(各シャードのcheckpoint/シャードjsonlの生成済みキーを除外)から固定seedで決定的に選ぶ。exact帯(子局面の空き≤20)/level16帯それぞれ親15〜20組(1組=4親程度をply順で束ね、現行warm方式に合わせて1プロセス連続処理)。
2. **アーム**(各組について交互実行、順序はarm順ローテーションで公平化):
   - **base**: 現行 `wEdax-x86-64.exe`、`-n 1`(コントロール)
   - **v3**: `wEdax-x86-64-v3.exe`、`-n 1`
   - **base-n2**: `wEdax-x86-64.exe`、`-n 2`
   - (余裕があれば **v3-n2** も。優先度は上3つ)
3. **比較**: (i)全子局面のscore/bestMove/diffFromBestの完全一致(base基準、帯別に集計。bestMoveのみの差はscore差と分けて報告)、(ii)組合計elapsedの比(base比の幾何平均、帯別)、(iii)同一arm2回の完全一致(決定性)。
4. **外挿**: 現在の残件(1,000,000 − 最新の生成済み行数)と帯構成(残りはexact帯が支配的: 空き20-29の親の帯が進行中)を使い、採用時の残り時間短縮見積もりを出す。
5. **レポート**: `bench/edax-compare/t127i_edax_v3_ab_report.md`(コミット対象)に、値一致判定・帯別speedup・決定性・外挿・推奨(v3単独/v3+n2/現状維持のどれか)を記載。

## やらないこと(スコープ外)

- 生成の停止・乗り換えの実施(オーケストレーターが結果を見て判断する)
- gen_teacher_corpus.pyの変更、シャード数変更、resharding
- ハッシュサイズ`-h`の再検証(T127fで棄却済み)

## 受け入れ基準

- [ ] 値一致判定が帯別・全件である(不一致なら件数と最大差。score差とbestMove差を区別)
- [ ] 帯別speedup(ペア幾何平均)と、採用時の残り時間短縮見積もりがある
- [ ] 同一arm2回の決定性判定が帯別にある
- [ ] vs_edax.pyを変更した場合: 未指定時にコマンドラインが従来と同一であるテストを追加し、`python -m pytest bench/edax-compare/ -q` 全パス
- [ ] 変更対象(vs_edax.py+テスト)+レポートのみ**パス明示**でコミット(`bench:`プレフィックス、`(T127i)`)。`git add .`禁止。`tasks/`はコミットしない(作業ログ追記のみ)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが`git status --short`に残っていないこと(生成中ファイル群・scratchpadは対象外)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18: T127f/T127gレポートとvs_edax.py `_edax_solve_batch` / `edax_hash_bits` 実装を確認。加算引数方式で `_edax_solve_batch(..., edax_exe: Path | None = None)` を追加(未指定時は従来の`EDAX_EXE`を使用、他の引数列は不変)。`-n 2`検証は既存の`n_tasks`パラメータがそのまま任意の値を受け付けるため、新規パラメータ追加は不要と判断(vs_edax.py本体への追加変更なし)。
- 同上: `bench/edax-compare/test_teacher_corpus.py`に`VsEdaxSolveBatchCommandTests`を追加し、(1)`edax_exe`未指定時にコマンド列が従来と同一(バイナリパスが`EDAX_EXE`、`-h`なし)であること、(2)指定時は実行ファイルパスのみ差し替わり残りの引数列が完全一致することを検証。`subprocess.run`をモックし、OBF一時ファイルの書き込み先も`EDAX_DIR`を一時ディレクトリへ差し替えて実行中の`edax-extract/`には一切触れないようにした。`python -m pytest bench/edax-compare/ -q` 68件全パス確認。
- 同上: A/B計測ハーネスをscratchpad(`t127i_ab_harness.py`、resultsは`t127i_scratch/`配下)に作成。selection plan全件+8shard checkpointを読み取り専用でスキャンし未生成局面を抽出、固定seed`t127i-edax-v3-ab-v1`のSHA256順位でexact帯/level16帯それぞれ親4件×18組を選択(現行warm方式のedaxParentsPerProcess=32に倣い、帯内で親を束ねて1 Edaxプロセスで処理)。base/v3/base-n2の3アーム×2repを組ごとにローテーション順で交互実行し、`results.jsonl`にappend+flush+fsync(resume対応、既存の(band,groupIndex,rep,arm)はスキップ)。
- 2親×2組の縮小パラメータ(別scratchディレクトリ)でスモークテストを実施し、正常動作を確認。この時点で`base-n2`(level16帯)がbaseと1件score不一致(-28 vs -26)を検出済み(-n2の非決定性リスクが実データで再現)。base/v3は同一arm2回の決定性も一致を確認。スモーク用ファイルは本番scratchと別ディレクトリに分離済み(resumeキー汚染防止)。
- 続けてGROUPS_PER_BAND=18(親4件×18組×2帯)で本実行を開始。

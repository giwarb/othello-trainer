---
id: T111
title: v3×WTHORの頑健性確認(3seedのoracle計測)
status: done # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T111: v3×WTHORの頑健性確認

## 目的

T110の副産物として、**v3×WTHOR(T087のseed2重み)がT096の60局面独立oracleで regret 1.4333石**と、本番採用中のv2×WTHOR(1.5667石)と同等以上であることが判明した。T087でv3を不採用にした根拠のうち「oracle regret悪化(0.89→2.22)」は**18局面の旧oracle**での値であり、小標本アーティファクトだった可能性がある。ただし現時点の1.43は**seed2の1点のみ**。T087不採用の再審(=v3×WTHORの採用再検討)に進む前に、残るseed1/seed3を同じ60局面oracleで計測し、seed間の頑健性を確認する分析実験。

- 3seedが揃ってv2×WTHOR同等以上 → 再審の根拠が固まる(採用再検討は後続の別タスク)。
- seed2だけ良い(seed間ばらつき大) → 1.43も偶然の可能性が高く、再審は見送り。

**本タスクは計測のみ。採否判定・アプリ配線・対局スモークはスコープ外。**

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック。**別ワーカーがT104/T105(終盤ソルバー、NPS計測あり)を並行実行中**のため:
- Edax採点は1プロセスずつ直列・低負荷で。遅くてよい。時間計測は判定に使わない。
- **バックグラウンド起動禁止**(T109の事故防止)。フォアグラウンドで1件ずつ完了を待つ。

## 背景・既存資産(必読)

- `tasks/T110-v3-distillation.md` 作業ログ — v3×WTHOR seed2の計測手順(oracleRows/v2 rows再利用の節約手法含む)と4点比較表。
- 対象重み: `train/data/t087/v3-seed-1.bin` / `v3-seed-3.bin`(PWV3、gitignore領域。存在しなければblocked報告、再学習はしない)。
- oracle: `bench/edax-compare/t096_oracle_positions.json`(60局面)+ `bench/edax-compare/compare_pattern_v3.py`。
- **申し送りM2(T110レビュー)への対応**: 採点に使う`eval_cli`ビルドの再現性問題。本タスクでは各計測でv2×WTHOR行が**1.5667を完全再現すること**を必須ガードとし、再現しない場合は計測を中止して報告する(T104/T105のWIPが探索結果に影響し始めた兆候のため)。

## 要件

1. v3-seed-1 / v3-seed-3 の2候補について、T096 60局面oracleの mean regret + v2とのpaired bootstrap CI を計測する(T110の手法踏襲可。oracle行再利用のヘルパースクリプトを使う場合はT109で発覚した2バグの轍を踏まない)。
2. 各計測でv2行=1.5667の完全再現を確認・記録する(上記M2ガード)。
3. 作業ログに5点表(v3-seed1/2/3 × WTHOR、v2×WTHOR、参考: v3×蒸留2.6667)と、seed間頑健性の解釈候補(再審に足るか)を書く。判定はオーケストレーター。
4. oracle計測は局面単位で逐次保存・resume可能に(既存機構)。進捗を随時ログへ。

## やらないこと(スコープ外)

- v3の採否判定・本番配線・NPS計測・対局スモーク(再審が決まったら後続タスク)
- 学習の再実行・コード変更(train/ のコード変更は原則不要のはず。必要になったら理由を作業ログに書いて最小限で)
- 200kコーパス・分布多様化・損失設計(別判断)

## 受け入れ基準(検証コマンド)

- [ ] v3-seed-1 / v3-seed-3 のoracle計測が完走し、`train/data/t111/oracle/`(または既存流儀の場所)にJSONがある
- [ ] 各計測でv2行1.5667の完全再現が作業ログに記録されている
- [ ] 作業ログに5点表とseed間頑健性の解釈がある
- [ ] コード変更が発生した場合のみ、当該ファイルをパス明示でコミット(データはコミットしない)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T104/T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 v3-seed-1/seed-3 oracle計測完了

**前提確認**: `train/data/t087/v3-seed-1.bin`(5,964,708 bytes)・`v3-seed-3.bin`(5,964,708 bytes)ともに存在。`bench/edax-compare/t096_oracle_positions.json`(60局面)も存在。実行開始時の`git status --short`は`engine/src/endgame.rs` `engine/src/search.rs`のみ(T104/T105並行WIP由来、本タスクとは無関係)で、T111由来の変更はゼロから開始した。

**手順(T110の手法を踏襲、T109で発覚した2バグを踏まえて再実装)**:

1. **seed-1(フルスクラッチ)**: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t087/v3-seed-1.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t111/oracle/v3-seed-1.json` をフォアグラウンド・単一プロセスで実行(oracle 60件+v2 60件+candidate 60件、すべてEdax呼び出し)。完走時間は目視で数分程度。
2. **必須ガード(v2再現)**: seed-1実行後、出力jsonの`v2` result行の`meanRegret`が`1.5666666666666667`(=1.5667石、T096/T110の既存記録と完全一致)であることを確認。**再現成功**。この時点の`evalCliSha256`(`ac47bcd6071b9c7ff2553ab4ae8c92cc6a72dedee3788055e7a31bf00de8d7d5`)はT110実行時(`b6c6b549e59f986b6c93924bac3aeb2b3da9ba9001a142775d5dce7a6cd25970`)と異なり、T104/T105の並行WIPビルドでeval_cli.exeが変わったことを裏付けたが、**v2のoracle regret自体は新旧どちらのビルドでも1.5667に一致**しており、探索結果への実質的な影響は確認されなかった。
3. **seed-3(oracleRows/v2 rows再利用)**: scratchpadに一時スクリプト`t111_seed_oracle_state.py`を新規作成(非コミット)。T109/T110のseedスクリプトと同じ発想だが、T109で発覚した2バグを踏まえて以下を最初から実装した:
   - ROOT解決に`Path(__file__).resolve().parents[N]`を使わず、`git rev-parse --show-toplevel`(実行時cwd基準)を使用(scratchpad配下=リポジトリ外に置くスクリプトのため、祖先ディレクトリ探索がドライブルートで無限ループするT109の1つ目のバグを構造的に回避)。
   - 複製する`v2`行に対して明示的に`meanRegret = mean(regret)`を設定してから書き出す(T109の2つ目のバグ=最終summary printでの`KeyError: 'meanRegret'`を回避)。
   - 追加のガードとして、コピー元jsonの`v2Sha256`/`corpusSha256`/`evalCliSha256`/`edaxSha256`/`edaxEvalSha256`が現在の対象ファイルのダイジェストと完全一致することを確認し、**1つでも不一致なら例外で停止**する(evalCliSha256が実行間で変わっていた場合=T104/T105の並行ビルドがseed-1実行後にeval_cli.exeを更新した場合、oracleRows/v2 rowsの安全な再利用ができないため)。
   - 実行: `python t111_seed_oracle_state.py --source train/data/t111/oracle/v3-seed-1.json --v2 train/weights/pattern_v2.bin --candidate train/data/t087/v3-seed-3.bin --corpus bench/edax-compare/t096_oracle_positions.json --eval-cli target/release/eval_cli.exe --edax bench/edax-compare/edax-extract/wEdax-x86-64.exe --edax-eval bench/edax-compare/edax-extract/data/eval.dat --output train/data/t111/oracle/v3-seed-3.json` → 全ガード通過、`seeded ... meanRegret=1.5666666666666667`(=v2再現をシード時点でも確認)。
   - 続けて`compare_pattern_v3.py`を同じ`--output`で再実行(candidate=v3-seed-3のみ、resumeで60件を新規Edax計測)。完了後、出力jsonの`v2` meanRegretが再び`1.5666666666666667`であることを再確認(**2回目のガードも通過**)。

**全処理を直列・フォアグラウンドで実行**(バックグラウンド起動なし)。並行実行中のT104/T105(NPS計測あり)への配慮として、Edax呼び出しは1プロセスずつ順番に行った。oracle計測は`compare_pattern_v3.py`既存の局面単位atomic checkpoint機構(`oracleRows`→`v2`行→`candidate`行の順に1件ずつ追記)がそのまま効いており、逐次保存・resume可能(本タスク中の中断は発生しなかったが機構自体はT109/T110で動作確認済み)。

### 5点比較表(T096 60局面oracle regret、主指標)

| 構成 | 対象重み | oracle regret(60局面) | v2差分 | 95% CI | 判定 |
|---|---|---:|---:|---|---|
| v3×WTHOR(seed-1、本タスク新規) | `train/data/t087/v3-seed-1.bin` | 1.6 | +0.0333 | [-0.600, 0.700] | no_significant_difference |
| v3×WTHOR(seed-2、T110実測流用) | `train/data/t087/v3-seed-2.bin` | 1.4333333333333333 | -0.1333 | [-0.767, 0.567] | no_significant_difference |
| v3×WTHOR(seed-3、本タスク新規) | `train/data/t087/v3-seed-3.bin` | 1.4 | -0.1667 | [-0.900, 0.633] | no_significant_difference |
| v2×WTHOR(参照、本タスク2回実測=seed-1/3両方の実行で再現) | `train/weights/pattern_v2.bin` | 1.5666666666666667 | 0(自身) | — | — |
| 参考: v3×蒸留(T110実測流用、3seed同値) | `train/data/t110/v3/baseline-seed-{1,2,3}/final.bin` | 2.6666666666666665 | +1.1 | [-0.200, 2.600] | no_significant_difference |

**v2行再現の確認記録**: 本タスク中に`compare_pattern_v3.py`をフルスクラッチ・resume合わせて2回完走させ(seed-1・seed-3)、いずれも`v2` meanRegret=`1.5666666666666667`を得た(T096/T110の既存記録と完全一致)。加えてseedスクリプト側でも(コピー元との整合性チェックとして)同じ値を確認しており、合計3箇所で再現を確認した。M2ガード(必須)は**全て通過**、中止判定は発生しなかった。

### seed間頑健性の解釈候補(判定はオーケストレーター)

1. **3seedともv2×WTHORと有意差なし**: seed1=1.60/seed2=1.43/seed3=1.40石で、いずれも95% CIが0を跨ぐ(no_significant_difference)。T087不採用の根拠だった「oracle regret悪化」は、少なくともこの60局面oracleでは3seedいずれについても再現しなかった。
2. **点推定は3seedとも v2(1.5667)以下または同水準**: seed1のみわずかに上回る(+0.033、実質誤差レベル)。seed2・seed3はv2を下回る(-0.13〜-0.17)。3seedの点推定レンジは1.40〜1.60石で、幅0.2石と小さく、T087の18局面oracleで見られた大きな悪化(0.89→2.22、+1.33石)のような値は3seedいずれにも現れていない。
3. **「seed2だけ良い」という懸念は支持されない**: 3seedの点推定は近接しており(1.40/1.43/1.60)、seed2が外れ値というより3seedとも同じ水準に収まっている。これは「T087不採用の根拠(18局面oracleでの悪化)が小標本アーティファクトだった」という仮説と整合し、**再審(採用再検討)に進む根拠として頑健性は一定程度固まった**と解釈できる材料になる。
4. **統計的な留保**: 60局面という限られたサンプルサイズのため、3seedいずれも「有意差なし」の分類にとどまり(CI幅は約1.3〜1.5石)、個別のpaired testで「v2よりv3が優れる」という確定的な主張はできない。ただし3seedが独立に同じ方向(v2と同水準〜やや良い)を示している点は、単一seedの偶然による結果ではないことを補強する。
5. **参考: v3×蒸留(2.6667)との対比**: v3×WTHOR(3seedとも1.4〜1.6)はv3×蒸留(2.6667)より明確に良く、T110の知見(蒸留の汎化問題は表現力ではなく教師コーパス側にある)と整合する。v3という特徴集合自体はWTHOR教師データと組み合わせれば頑健に機能している。

### 検証コマンド一覧

- seed-1フルスクラッチ: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t087/v3-seed-1.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t111/oracle/v3-seed-1.json`
- seed-3シード+resume: 上記「手順」の`t111_seed_oracle_state.py`実行 → 同一`compare_pattern_v3.py`コマンドを`--candidate train/data/t087/v3-seed-3.bin --output train/data/t111/oracle/v3-seed-3.json`で再実行
- 独立再集計: `python3 -c "import json; ..."`でoracle json 2件の`v2`/`candidate` meanRegretと`statistics`を確認(本文記載の値と一致)
- `git status --short`: `engine/src/endgame.rs` `engine/src/search.rs`のみ(T104/T105由来、除外対象)。T111由来のコード変更はゼロ、`train/data/t111/`は`train/data/`が`.gitignore`(32行目)対象のため未追跡表示なし。

### コミット対象・スコープ外差分

- コミット対象: **なし**(コード変更を行っていない。`bench/edax-compare/compare_pattern_v3.py`は読み取り利用のみで無変更)。
- データ成果物(`train/data/t111/oracle/v3-seed-1.json` `v3-seed-3.json` `train/data/t111/results.tsv`)は`train/data/`gitignore対象のためコミット対象外(要件どおりデータはコミットしない)。
- 一時ファイル: scratchpad(`t111_seed_oracle_state.py`)のみで、リポジトリ内には作成していない。
- スコープ外差分: `engine/src/endgame.rs` `engine/src/search.rs`はT104/T105(並行実行中の別タスク)由来であり、本タスクでは一切触れていない。

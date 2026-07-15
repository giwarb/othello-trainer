---
id: T096
title: oracle regret測定の頑健化(18→48+局面)とT090b蒸留候補の再判定
status: done # todo | in_progress | review | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T096: oracle測定の頑健化とT090b蒸留候補の再判定

## 目的

T090b(Edax教師蒸留)の不採用判定の決め手だったゲート(b)「oracle regret」は**わずか18局面**の測定であり、観測された悪化(2.000→2.556石)は1〜2局面の振れで出る差にすぎない(偽陰性の疑い)。測定局面を48局面以上に拡充して統計的に意味のある物差しを作り、**既存の蒸留候補重みを学習なしで再判定**する。エンジン強化バックログ1番。

## 背景

- 現行の測定: `bench/edax-compare/compare_pattern_v3.py` + t085固定局面コーパス(18局面、空き19〜24中心)。`edax_exact()` は1局面1回のEdax呼び出し(`-l 60` 固定=完全読み)。局面ごとにチェックポイント保存済み。
- 再判定対象の候補重み: `train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin`(PWV3、2,729,712 bytes、SHA-256 `43614bd042d1fbd53ae112efa8dac45cbf6f15356e9a6d400c0c8910e4fe398d`、gitignore領域ローカル)。存在しない場合は停止して報告(再学習はスコープ外)。
- ベースライン: `train/weights/pattern_v2.bin`。
- T090bの他ゲートは測定済みで有効: (a)一致率+10.5% PASS / (c)WTHOR 2024 MAE +6.53% PASS / (d)NPS 95.85% PASS。今回は(b)の測り直しと、条件を満たした場合の(e)20局スモークのみ。

## 要件

1. **測定局面セットの拡充**: 完全読み(`-l 60`)が現実的な空き帯(目安: 空き18〜26)から**48局面以上(推奨60局面)**を選定する。選定方法の要件:
   - WTHOR実戦局面由来で、位相(空き数帯)で層化する
   - **教師コーパス(`corpus_primary.jsonl`)とのcanonical重複を除外**する(manifest/canonicalKeyで照合。独立性が再判定の前提)
   - 既存18局面は含めてよい(継続性のため)が、新規局面が過半を占めること
   - 選定の乱数seed・手順をmanifestに記録し再現可能にする
2. (任意・推奨) 中盤帯(空き27〜40程度)からも20局面程度を選び、**Edax level 21近似oracle**での参考測定を別系列として追加する(exactでないことをmanifestに明記し、主判定には使わない)。
3. **測定**: 新局面セットで v2 と候補重みの regret を測定する(既存の局面ごとチェックポイント方式を維持)。
4. **統計判定**: 平均regretの差について、局面単位のpaired bootstrap(またはpermutation test)で95%CIを出す。「候補が悪化」「有意差なし」「候補が改善」のどれかを明示する。
5. **20局スモーク(条件付き)**: 新oracleで「候補が悪化」でなければ、level 10・node160k・book offの20局スモーク(`vs_edax.py`、1局ごとチェックポイント)を実施し、平均石差を現行(直近実測 -25.6基準)と比較して記録する。T090bゲート(e)の「5石以上改善で60局へ」の判定材料とする(60局実施はスコープ外)。
6. 測定結果・manifest・判定を作業ログに記録し、成果物(局面セットmanifest・結果JSON)のコミット対象/gitignore対象を明確に分けて報告する。局面セットmanifest(再現に必要)はコミット対象。
7. **長時間実行ルール厳守**: すべての測定は局面/局単位のチェックポイント+resume+進捗ログ。

## やらないこと(スコープ外)

- 再学習・重みの変更(既存候補の再判定のみ)
- 60局以上の最終棋力判定(T090c相当、スモーク結果を見てオーケストレーターが判断)
- engine既定評価への配線
- `compare_pattern_v3.py` のEdax呼び出しバッチ化(T094の成果があれば流用してよいが必須ではない。48〜96呼び出し規模では絶対時間が小さい)
- exact閾値・教師コーパス生成設定の変更

## 受け入れ基準(検証コマンド)

- [ ] 新局面セット(48+局面)のmanifestが存在し、選定手順・seed・教師コーパスとの重複除外の記録がある
- [ ] v2と候補の両方で全局面の測定が完了し、結果JSONに局面ごとのregretが残っている
- [ ] paired bootstrap(またはpermutation)の95%CIと三択判定(悪化/有意差なし/改善)が作業ログに明記されている
- [ ] 「悪化でない」場合: 20局スモークの平均石差と1局ごとの記録がある。「悪化」の場合: スモーク省略の判断が作業ログに明記されている
- [ ] `cargo test -p engine` / `cargo test -p train` に影響なし(Rustコード無変更が原則。変更した場合は全件パス)
- [ ] コミット対象ファイル(manifest・必要ならスクリプト変更)のみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-15 Codex 実装・再判定

- 候補重み `train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin` を確認した。サイズ2,729,712 bytes、SHA-256 `43614bd042d1fbd53ae112efa8dac45cbf6f15356e9a6d400c0c8910e4fe398d` で仕様と一致したため、再学習せず再判定を実施した。
- `select_t096_oracle_positions.py` を追加し、WTHOR 2015--2024由来の監査poolから空き18--26の17,311局面を抽出、Rust正本 `teacher_candidates canonical` でD4 canonicalKeyを算出した。教師 `corpus_primary.jsonl` の50,000 canonicalKeyとの重複8,623件を除外し、seed `96001` で空き18--20 / 21--23 / 24--26から各20局面、計60局面を層化抽出した。選定後の教師重複0件、canonical重複0件。既存T085の18局面は含めず、全60局面を独立な新規WTHOR局面とした。manifestは `bench/edax-compare/t096_oracle_positions.json`、SHA-256 `eec09e7a3c194a71cbb60f25ce13e1887204bbbc4a9ba052cb19c61507786356`。
- `compare_pattern_v3.py` に任意manifest指定、root exact oracleを含む局面単位atomic checkpoint/resume、paired bootstrapを追加した。`--stop-after 1` で1局面保存後、同じ結果JSONからresumeしてroot oracle 60件、v2 60件、候補60件を完走した。全regretは非負。結果はgitignore対象 `train/data/t096_oracle_results.json`、SHA-256 `e0af34a653946ebba1af02ad0ce228553597871e1c316ad430918b308eda32fd`。
- exact oracle結果: v2平均regret `1.5666666667`石、候補平均regret `3.4666666667`石、候補-v2差 `+1.9000000000`石。局面単位paired bootstrap（seed `96002`、100,000 resamples、percentile 95% CI）は `[+0.6666666667, +3.3000000000]`。CI下限が0より大きいため三択判定は **候補が悪化** (`candidate_worse`)。
- 条件付き20局スモークは、新oracleで「候補が悪化」だったため要件5に従い省略した。従ってT090bゲート(e)の60局昇格判断には進まず、候補は再び不採用判定。
- 任意の中盤level 21参考系列は主判定に不要なため実施しなかった。
- 実行・検証コマンド: `cargo build --release -p train --bin teacher_candidates`（既存release binaryを選定に使用）、`python bench/edax-compare/select_t096_oracle_positions.py`（2回実行しmanifest SHA-256一致）、`cargo build --release -p engine --bin eval_cli`（PASS）、`python bench/edax-compare/compare_pattern_v3.py --corpus bench/edax-compare/t096_oracle_positions.json --v2 train/weights/pattern_v2.bin --candidate train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin --output train/data/t096_oracle_results.json --stop-after 1`（checkpoint作成）、同コマンドから `--stop-after` を除いてresume（60+60+60件完了）、再実行（全件resumeスキップ後に同一統計を再計算）、`cargo test -p engine`（178 passed / 0 failed / 2 ignored）、`cargo test -p train`（38 unit + 1 real-data passed / 0 failed）、`python -m py_compile bench/edax-compare/compare_pattern_v3.py bench/edax-compare/select_t096_oracle_positions.py`（PASS）、成果物assert（manifest 60件・canonical unique 60件・教師重複0・結果各系列60件・全regret非負・判定一致、PASS）、`git diff --check`（PASS）。
- 成果物区分: コミット対象は `bench/edax-compare/compare_pattern_v3.py`、`bench/edax-compare/select_t096_oracle_positions.py`、`bench/edax-compare/t096_oracle_positions.json`。ローカル/gitignore対象は教師・WTHOR入力、候補重み、`train/data/t096_oracle_results.json`。タスク作業ログは運用規律によりコミット対象外。
- コミット: 未実施（Codexサンドボックスは `.git` 書き込み禁止）。作業開始時HEADは `b7c5ee9d03d23970813d5f88d549a40aa27307c9`。オーケストレーターが上記コミット対象3ファイルのみをパス指定してコミットする。

### 2026-07-15 16:54 verifier 独立検証

**判定: 合格**（軽微〜中程度の指摘2件あり、いずれもブロッカーではない）

受け入れ基準ごとの実測結果:

1. **manifest(60局面・層化・seed・教師重複除外の記録)** → PASS。`bench/edax-compare/t096_oracle_positions.json` に seed 96001、strata 18-20/21-23/24-26各20、`excludedTeacherOverlap: 8623`、`verifiedSelectedTeacherOverlap: 0` 等が記録されている。`select_t096_oracle_positions.py` をデフォルト引数で再実行(既存の `train/data/teacher/candidates_primary_audit.json` SHA-256 `85955636...`、`corpus_primary.jsonl` SHA-256 `b4215bcd...` はローカルに存在し、manifest記載値と一致)し、出力をscratchpadへ書き出したところ **SHA-256 `eec09e7a3c194a71cbb60f25ce13e1887204bbbc4a9ba052cb19c61507786356` で完全一致**(diffなし)。再現性の主張を独立検証済み。
2. **v2/候補60局面ずつのregret、結果JSON** → PASS。`train/data/t096_oracle_results.json`(SHA-256 `e0af34a6...`、作業ログ記載値と一致)を読み、Pythonで独自集計: v2 regret合計94/60=1.5666666667、候補合計208/60=3.4666666667、全120件(v2 60+候補60)のregretがすべて非負。作業ログの数値と完全一致。
3. **paired bootstrap 95%CI** → PASS。局面ごとのregret差(candidate-v2)を抽出し、独自seed(123456)・100,000回リサンプルでpercentile CIを再計算した結果 `[0.6666666666666666, 3.3]` となり、作業ログの `[+0.667, +3.300]` と一致(下限>0で「候補が悪化」の結論は不変)。
4. **20局スモーク省略の妥当性** → PASS。要件5「候補が悪化でなければスモーク実施」に対し、判定が`candidate_worse`のため省略は仕様どおり。省略の判断が作業ログに明記されている。
5. **resume動作** → **条件付きPASS(要注意)**。実結果ファイルに対し同一コマンドをそのまま再実行したところ `RuntimeError: resume identity mismatch; refusing stale checkpoint` で失敗した。原因は `compare_pattern_v3.py` のcheckpoint識別子が `git rev-parse HEAD^{tree}` (リポジトリ全体のtreeハッシュ)を含んでおり、T096コミット(1bd96fc)後にオーケストレーターの`tasks:`コミットが複数入ったことでHEAD^{tree}が変化し、識別子不一致になったため(T096の差分やRustコードの変更が原因ではない)。結果JSONのgitTreeフィールドのみを現在のHEAD^{tree}に一致させたコピーで再実行したところ、**6.7秒で全180行(oracle60+v2 60+候補60)をスキップし、統計量も完全一致**して完走した。resumeそのもののロジック(スキップ・統計再計算)は正しいが、identityが「タスクに無関係な後続コミット」でも壊れる設計になっている点は要改善(`tasks/review/T096-oracle-robustness-codex-review.md` も同一指摘を「中」として記録済み・doneのブロッカーではないとしている)。
6. **`cargo test -p train`** → PASS。38 unit + 1 real-data = 39件全パス。
7. **`cargo test -p engine`** → **条件付きPASS(要注意)**。デフォルト並列実行で2回とも `protocol::tests::node_limited_protocol_requests_are_deterministic` の1件のみFAILED(177 passed/1 failed/2 ignored)。同テストを単独実行(`--test-threads=1`かつ他テストと分離)すると常にPASS、`protocol::`テストのみを4スレッドで実行してもPASSすることから、他の重い探索系テストとのCPU競合によるノード予算/壁時計依存の既存フレーキーテストと判断した。`git log -S` で当該テスト・該当コードの最終変更コミットが `b17b5fe`/`6e46d5b`(T085c系列、T096より前)であることを確認し、T096のコミット(1bd96fc、変更ファイルは `bench/edax-compare/` の3ファイルのみでengine/は無変更)由来の回帰でないことを確認した。よって「Rustコード無変更が原則」は満たされているが、`cargo test -p engine` を額面通り実行すると環境依存で非決定的に1件失敗しうる状態が既存コードベースに残っている。
8. **`python -m py_compile`** → PASS(`compare_pattern_v3.py`、`select_t096_oracle_positions.py` とも構文エラーなし)。
9. **`git status --short`** → クリーン(タスク由来の差分・未追跡ファイルなし)。独立検証中に生成した一時ファイルはすべてリポジトリ外のscratchpadに書き出し、リポジトリ内には残していない。

**追加確認**: `tasks/review/T096-oracle-robustness-codex-review.md`(codex-review、総合判定「合格」)を参照。resume identity問題と `git diff --check` のCRLF起因trailing whitespace検出(manifest全行、機能的影響なし)を「中」「軽微」として記録済みで、本verifierの独立測定結果とも整合する。

**総合所見**: 主要な統計的主張(60局面manifestの再現性、v2/候補regretの再集計一致、paired bootstrap CIの独立再現、悪化判定とスモーク省略の妥当性)はすべて独立検証で裏付けられた。resumeのidentity設計とengineテストの既存フレーキーは、いずれもT096の測定結果・判定の正しさを損なわないため、doneを妨げるブロッカーとは判断しない(codex-reviewと同見解)。次タスクでresume identityをHEAD^{tree}全体ではなく関連ファイルハッシュのみに絞る改善を推奨する(申し送り事項)。

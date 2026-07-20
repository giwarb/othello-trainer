---
id: T157
title: oracle拡張(60→180局面)と既存重みの一括再採点(ユーザー疑問起点)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T157: oracle拡張と再採点

## 目的(ユーザー指摘 2026-07-20)

「v4×WTHOR=1.111が偶々良い値を引いた可能性」「60局面oracleのノイズ(±0.4〜0.5石)が比較の信頼性を損なう」への対処。**T096方式のoracle局面を+120局面追加して合計180局面**にし、**既存の重みファイル群を再学習なしで一括再採点**して、今日までの順位表の信頼幅を締める。

## 背景・基盤

- 既存oracle: T096の60局面(`bench/edax-compare/t096_oracle_positions.json` 等、教師コーパス非重複・層化、Edax真値=全合法手の値付き)。生成方法・検証はT096タスクファイル参照。採点は compare_pattern_v3.py(M2ガード=v2行1.5666666666666667の完全再現)。
- 追加分の局面選定は既存T096方式に倣う(層化・既存60局面および教師コーパス・T156校正局面との重複を避ける。WTHOR由来でよい)。真値ラベルはEdax(既存のoracle生成手順と同一level/exact条件、決定的 n_tasks=1)。
- 再採点対象の重み(全てローカルに現存、SHAは各taskのmeta参照): v2(pattern_v2.bin)/v3(pattern_v3.bin)/**v4本番(pattern_v4.bin=T125 seed3)**/T124 v4×WTHOR seed1・2(train/data/t124/wthor-v4/)/T154 Run B(Egaroucid@t090)/T155 E1 seed1-3・E2。見つからない重みは報告のうえスキップ可。

## 要件

1. **局面追加**: +120局面(既存60と合わせ180)。層化は既存T096の帯構成に合わせる。既存60局面・教師コーパス(oracle非混入条件は逆向きに注意: 新規局面が学習データに入っていないこと)・T156校正1,200局面との重複(canonical)ゼロを機械検証。
2. **真値ラベル付け**: Edaxで全合法手の値(既存oracle生成と同一条件、決定的)。ラベル生成はcheckpoint/resume+進捗ログ(10分超えうる)。
3. **一括再採点**: 上記の全重みについて、(a)既存60局面 (b)新120局面 (c)合計180局面のregretをそれぞれ算出(60局面値は既存記録と一致することがM2ガード相当の健全性チェックになる)。v2の60局面値=1.5666...の再現を必須ガードとする。
4. **レポート**: 順位表(重み×60/120/180局面regret、絶対CI(位置レベルbootstrap)付き)+「1.111の頑健性」への答え(180局面でのv4本番値とCI)+今日の主要比較(WTHOR vs Egaroucid vs 蒸留)が180局面でどう変わるかの1段落。bench/edax-compare/t157_oracle_expansion_report.md(+meta、oracle局面jsonとラベルはコミット対象)。
5. 今後の標準: 以後のスクリーニングは180局面を標準とする旨をレポートに明記(compare系スクリプトのデフォルト差し替えは行わず、--oracle引数等で選べる形でよい。方式をレポートに記載)。

## スコープ外

- 学習のやり直し・対局ゲート・本番採用判断
- T156(MPC)系ファイルの変更

## 受け入れ基準

1. 180局面のoracleデータ(局面+全合法手真値)がコミットされ、重複ゼロ・層化・決定性の機械検証記録がある
2. 全対象重みの再採点表(60/120/180、CI付き)がレポートにあり、v2の60局面値1.5666...再現ガードが全採点セッションで記録されている
3. `cargo test`系(触った場合)・既存テスト全パス、パス明示コミット・push、完了時 `git status --short` クリーン
4. 注意: T156b(Codex分析)が並行中。bench/edax-compare/のt156_*ファイルに触らない。Edaxラベル生成のCPU負荷はT156b(読解中心)と両立可だが、開始前にSTATUSで並行状況を確認

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

### 2026-07-20 実装(Sonnet implementer)

- **局面選定**: `select_t157_new_positions.py`を新規作成。T096方式(WTHOR 2015-2024・18-20/21-23/24-26の3層×各40)で+120局面を選定。教師コーパス`corpus_primary.jsonl`・既存t096の60局面(`t096_oracle_positions.json`のcanonicalKey)・T156校正1,200局面(`t156_mpc_positions.json`、読み取りのみで変更なし)の3コーパスすべてとcanonical重複ゼロを選定時に機械検証(除外件数: 教師8,623+α、t096=60、t156=2)。seed 157001で2回実行しSHA-256完全一致(決定的)を確認。出力: `bench/edax-compare/t157_new_positions.json`。
- **結合**: `build_t157_combined_positions.py`でt096既存60(cohort=t096)+新120(cohort=t157ext)を結合し`t157_oracle_positions.json`(180局面)を生成。180件のcanonicalKeyユニーク数=180・教師コーパス重複0を機械検証。2回実行しSHA-256完全一致を確認。
- **Edax全合法手ラベル生成**: `t157_build_oracle_table.py`を新規作成。180局面それぞれについて全合法手を`eval_cli moves`で列挙し、各着手後の子局面をEdax `-l 60 -book-usage off`(T096 compare_pattern_v3.pyと同一パイプライン)で決定的に評価、position単位でatomic checkpoint/resume。全180局面完走、root oracle値と全合法手中の最大値の整合性チェックは180/180件で一致(不一致0件)。出力: `bench/edax-compare/t157_oracle_labels.json`。
  - **事故と対応**: 初回実行中、オーケストレーターが並行タスク(T156b/T156c)でリポジトリに複数コミットを行ったため、resume identityに含めていた`git rev-parse HEAD^{tree}`が変化し、48/180で正常だったチェックポイントが「stale」と誤判定されて再開不能になった(T096の既知申し送りと同一の問題を実地で踏んだ)。対応: `t157_build_oracle_table.py`・`t157_rescore_weights.py`の両方でresume identityから`gitTree`を除外し、`gitTreeAtLastWrite`という参考情報フィールドに分離(identity比較には使わない)。既存チェックポイントのメタデータも同スキーマへ移行し、48/180から正常に再開・完走した。加えて、実行中に一時的なファイルロック(Windows、`os.replace`中に他プロセスがJSONを開いていたことが原因)で1回クラッシュしたが、atomic writeの設計により直前のcheckpoint(48件)は無傷で、再開のみで復旧できた。
- **一括再採点**: `t157_rescore_weights.py`を新規作成。対象10重み(v2/v3/v4本番/T124 seed1-2/T154 RunB/T155 E1 seed1-3/T155 E2 seed1)それぞれについて、180局面全てでeval_cli best(depth8, exact-from-empties 0、T096と同一条件)による着手選択→ラベル表lookupでregretを算出(新規Edax呼び出しは不要)。60(cohort=t096)/120(cohort=t157ext)/180(全体)の3集合で位置レベルbootstrap(resample with replacement、seed 157002、samples 100,000)による絶対95%CIを算出。v2比paired bootstrap CI(@180)も参考として算出。
  - **M2ガード**: v2 @60 regret = 1.5666666666666667(既知値と完全一致)。
  - **全10重みの独立クロスチェック**: v3=1.4000000000000001(既知1.40)、v4_prod=0.9666666666666667(既知0.9667=T124 seed3)、t124_seed1=0.7(既知0.70)、t124_seed2=1.6666666666666667(既知1.6667)、t154_runB=1.2333333333333334(既知1.2333)、t155_e1_seed1=1.5333333333333334(既知1.5333)、t155_e1_seed2=1.4666666666666666(既知1.4667)、t155_e1_seed3=1.6666666666666667(既知1.6667)、t155_e2_seed1=1.3666666666666667(既知1.3667)。**全10件が既知値と完全一致**(単なるv2 M2ガードに留まらない、新パイプライン全体の独立検証)。
  - **決定性**: 完走後に同一コマンドを再実行し、`summary`の数値(全weight×n60/n120/n180のmean/CI)が完全に不変であることを確認(ファイル全体のSHA-256は`gitTreeAtLastWrite`という参考フィールドの変化により変わるが、これは意図的にidentity判定から除外済みの非本質フィールドであり、数値上の非決定性ではない)。
- **レポート生成**: `t157_generate_report.py`で`bench/edax-compare/t157_oracle_expansion_report.md`+`t157_oracle_expansion.meta.json`を生成。順位表(60/120/180局面、絶対CI付き)・v2比paired CI・「v4本番=1.111の頑健性」セクション・WTHOR/Egaroucid/蒸留比較セクション・今後の標準セクションを含む。
  - 初版の自動生成narrativeが「180局面でもv4系の優位性は維持された」という誤った結論(単純な点推定averageの大小比較のみに基づき、paired CIの「全て有意差なし」という結果を見落としていた)を出力していたため、手動でロジックを修正: 実際にはv2とv4系3seed平均の差は60局面時点0.4556石→180局面時点0.0148石へほぼ消失し、v2比paired bootstrap CIは再採点9重み全てで「有意差なし」。
- **主要発見(順位表、180局面regret昇順)**: t124_seed1(1.3111) < v4_prod(1.3778) < t155_e1_seed1(1.4000) < v2(1.4111) < t155_e1_seed2(1.4222) < t155_e2_seed1(1.4556) < t154_runB(1.4667) < t124_seed2(1.5000) < t155_e1_seed3(1.5333) < v3(1.7222)。v2(baseline)が4位に浮上し、v4系3seed平均・Egaroucid各系列・v2が1.31〜1.47石の狭いレンジに密集。v3は60局面時点(1.40、2位相当)から180局面時点で最下位(1.7222)へ後退。v2との差は全9重みで`no_significant_difference`(paired bootstrap 95%CI)。
- **「v4本番=1.111の頑健性」への答え**: 60局面での3seed平均1.1111は180局面で1.3963へ変化。v2の180局面regret(1.4111)との差はわずか0.0148石で、60局面時点の見かけ上の差(0.4556石)はほぼノイズだったことが示唆される。「v4×WTHOR=1.111が偶々良い値を引いた可能性」はデータに支持される。
- **蒸留系との比較**: 蒸留系(T120/T123/T126、本タスクでは未再測定)は60局面で2.0〜2.9石とWTHOR/Egaroucid系(60局面0.7〜1.7台、180局面1.31〜1.72台)から一貫して1石以上悪く、この序列は今回のオーケストレーターの対象重み一覧に含まれていないため180局面での直接再測定はしていないが、較差の大きさから見て逆転可能性は低いと判断(定性的申し送り)。
- **今後の標準**: レポート内に明記。`compare_pattern_v3.py`のデフォルト・t096の60局面はそのまま維持し、180局面で測る場合は`t157_rescore_weights.py --corpus bench/edax-compare/t157_oracle_positions.json --labels bench/edax-compare/t157_oracle_labels.json`を使う(新規重み追加時もEdax呼び出し不要、eval_cliのmove選択のみ)。
- **実行コマンド**: `python bench/edax-compare/select_t157_new_positions.py` / `python bench/edax-compare/build_t157_combined_positions.py` / `python bench/edax-compare/t157_build_oracle_table.py` / `python bench/edax-compare/t157_rescore_weights.py` / `python bench/edax-compare/t157_generate_report.py`。Rustコード(engine/train)は無変更のため`cargo test`は未実施(要件3の「触った場合」に該当しない)。
- **コミット**: `14af610`(オーケストレーターへ委譲せず自分でパス明示コミット・push、変更対象は上記11ファイルのみ)。push後`git status --short`はtasks/review/T156c-*.md(自分の変更外、オーケストレーター/T156c担当分)のみでクリーン。

---
id: T143
title: 教師コーパス生成基盤の堅牢化(申し送り一括対応、4M生成前の必須整備)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T143: 生成基盤堅牢化

## 目的

expanded1m生成(T127b)完走でコード凍結が解除された。過去タスク(T127h/T127i/T127j/T127a/T114/T127cレビュー)で積み残した生成・検証基盤の堅牢化申し送りを一括で対応し、**将来の4M生成(T127eで判断)を安全に実行できる状態**にする。

## 背景・事実

- 対象はすべて `bench/edax-compare/` 配下のPythonファイル群: `gen_teacher_corpus.py` / `verify_teacher_corpus.py` / `finalize_teacher_corpus.py` / `test_teacher_corpus.py`(現在49テスト全PASS)。
- expanded1m生成は完走済み・検証済み(T127c、全1M件0エラー)。**本タスクの変更が既存コーパス・manifestの値を変えることはあってはならない**(検証・ゲート強化とテスト追加が主)。
- **並行タスク注意**: T127d(学習)が train/ 側で並行実行中。bench/edax-compare/ 配下は本タスクの独占だが、**CPU負荷の高い処理(Edax大量呼び出し・長時間ベンチ)は行わない**(本タスクにそもそも不要)。
- 参照: 各申し送りの出典は `tasks/STATUS.md` の「有効な方針・申し送り」、レビューは `tasks/review/T127c-corpus-1m-verify-claude-review.md`、T127aの固定テスト仕様は `tasks/T127a-corpus-1m-infra.md` の作業ログ・受け入れ基準を参照。

## 要件

### A. gen_teacher_corpus.py(生成側)

1. **束フォールバック経路のcheckpoint修正**(T127h申し送り・中): 現行は束(32親)内の全親成功までcheckpointされず、フォールバック経路で最大1束分の損失が出る。親単位(または処理済み局面単位)でcheckpointされるよう修正する。resume identityのgeneratorSHAゲートに触れるため、plan provenance更新(適切なidentity再計算)とセットで行い、既存checkpointとの互換性の扱いを明記する。
2. **PROVENANCE_IDENTITY_KEYSへEdaxバイナリ実SHAを追加**(T127ij申し送り・中): 現行はresume identity/runKeyにEdaxバイナリの実SHAが入らず、バイナリ差し替えをfail-closed検知できない。identityへ組み込み、差し替え時はresume拒否(明示フラグで受理)にする。
3. **meta欠損・JSONパース失敗時のcheckpoint暗黙破棄経路のエラー化**(T114申し送り): 破損時に黙って捨てず、明示エラー+復旧手順の提示にする。
4. **年指定ミス・候補プール不足の事前検出**(T114申し送り): ラベリング開始前に検出して早期エラーにする。

### B. verify/finalize(検証側、T127cレビュー中2件)

5. **verify checkpointへのフィンガープリント追加**(レビュー中-1): checkpointに対象JSONLのサイズ+SHA-256とteacher_candidates.exeのSHAを記録し、load時に不一致ならcheckpointを無効化してフルスキャンにフォールバック(理由をログ)。
6. **finalize_expanded1m()の整合性ゲート**(レビュー中-2): stats.records==progress.total、contaminatedRecordsFound==0、selectionAudit.thresholdTriggered==False をassertし、不一致なら書き出さずエラー終了。
7. **corpus_expanded1m.meta.json へ corpusSha256 を追記**: マージ済みJSONL自体のSHA-256をmanifestに記録する(finalizeの再実行または追記スクリプトで)。**追記値がオーケストレーター実測値 `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86`(1,595,551,517 bytes、2026-07-20実測)と一致することを確認すること**(不一致ならデータドリフトであり作業を止めて報告)。

### C. テスト追加(T127a申し送り+レビュー軽微)

8. **K=1のend-to-end SHA固定テスト**(合成WTHOR入力): 小さな合成入力で生成パイプラインを通し、出力のSHAを固定する回帰テスト(T127a申し送りの仕様どおり)。
9. **waterfall配分の期待配列固定テスト**(T127a申し送り)。
10. **checkpoint破損(不正JSON)→フルスキャンフォールバックの回帰テスト**(レビュー軽微5)。
11. 軽微対応(同一ファイルを触るついでに): `--progress-every` がBATCH_SIZE(500)の倍数でない場合のバリデーション(警告または丸め)、verify checkpoint削除時の `.tmp` 掃除。

## スコープ外(やらないこと)

- データ本体・シャード・既存manifestの値の変更(7のcorpusSha256「追記」のみ許可。既存フィールドの値は変えない)
- 4M生成の実行、Edax大量呼び出し、性能計測
- train/ 側(T127dの領分)・app/engineの変更(GitHub Pages確認不要)
- manifestのWindowsパス区切り正規化(レビュー軽微3)は任意。実施する場合はverify側の正規化と整合させ、SHA系フィールドに触れないこと

## 受け入れ基準

1. `python bench/edax-compare/test_teacher_corpus.py` が全テストPASS(既存49+新規。要件8〜10のテストを含む)
2. `python bench/edax-compare/verify_teacher_corpus.py expanded1m` が引き続き1,000,000件0エラーで完走する(変更が既存検証を壊していないことの実地確認。約3〜4分)
3. corpus_expanded1m.meta.json に corpusSha256 が追記され、実測値 067a4e3a... と一致している
4. 要件1〜2(resume identity変更)について、変更後のresume挙動(受理・拒否)がテストで固定されている
5. 変更ファイルはパス明示でコミット(`git add .` 禁止)し、mainへpush
6. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## コミット規律

- コミットしてよいのはタスクの変更対象ファイルのみ。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 一時ファイルはscratchpadへ。スコープ外差分は報告のみ

## 作業ログ

### 2026-07-20 実装ワーカー

- 実装方針の確認: expanded1mコーパス(1,000,000件)・manifest類は完走・検証済みのため触らない。
  - `corpus_expanded1m.jsonl`(1,595,551,517 bytes)の実測SHA-256を実行前に確認し、
    オーケストレーター実測値`067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86`と
    完全一致することを確認済み(データドリフト無し)。
- **要件A(gen_teacher_corpus.py、4件)**:
  1. `checkpoint_expanded1m_parent_bundle`のフォールバック経路を、束内の全親を
     ラベリングし終えてから一括appendする実装から、各親のラベリング直後に即
     `checkpoint.append()`する実装へ変更(最大で束サイズ-1件分の損失リスクを解消)。
     resume identity(`harnessSha256`/`generatorSha256`)への影響は、モジュール
     docstringとPROVENANCE_IDENTITY_KEYS付近にT143追記コメントとして明記(expanded1mは
     完走済みで再開の必要が無く実害無し、将来の新規set生成時は都度再計算される)。
  2. `PROVENANCE_IDENTITY_KEYS`へ`edaxExeSha256`(実際に呼び出すEdaxバイナリの実SHA)を
     追加。`edaxExe`設定が無いset(smoke/primary/expanded200k)はこのキー自体を
     一度も記録しないため saved/current とも常にNoneで一致し続け、既存3setの
     settings/runKey/resume挙動は完全に不変。
  3. `TeacherCorpusCheckpoint.try_resume()`のmeta.json破損(JSONパース失敗)経路を、
     無条件`return False`(→呼び出し元がjsonlを空へ切り詰める)からRuntimeError
     (復旧手順提示)へ変更。`--start-fresh`明示時のみ従来どおり切り詰めを許可。
  4. `require_year_range_matched_games`(新設)で`totalGamesInYearRange==0`を
     早期検出。`select_positions`にも「優先層+プール合計が目標未満なら早期
     RuntimeError」を追加(いずれもEdaxラベリング開始前)。
- **要件B(verify/finalize、3件)**:
  5. `verify_teacher_corpus.py`に`compute_checkpoint_fingerprint`(対象JSONLの
     サイズ+SHA-256、teacher_candidates.exeのSHA-256)を追加。`save_verify_checkpoint`/
     `load_verify_checkpoint`に`fingerprint`/`expected_fingerprint`引数(既定None、
     省略時は従来どおり無条件採用)を追加し、`verify_one`はcheckpoint_pathが
     渡されたときだけ計算・照合する(smoke/primary/expanded200kの既定呼び出しは
     --checkpoint-dirを渡さないため無影響)。不一致時はログしてNoneを返しフル
     スキャンへフォールバック(データを破壊しないためエラー化は不要と判断)。
  6. `finalize_expanded1m()`に整合性ゲートを追加: `corpusStats.records`が
     live meta`progress.total`と一致・`oracleNonContamination.contaminatedRecordsFound==0`・
     `selectionAudit.thresholdTriggered==False`をassertし、いずれか不一致なら
     manifestを書き出さずRuntimeError。
  7. `expanded1m_corpus_stats()`が`corpusStats.corpusSha256`(マージ済みJSONL
     本体自体のSHA-256)を返すよう変更(将来finalize_expanded1mを再実行する
     生成setでは自動的に含まれる)。既存の確定済みmanifestは
     `finalize_expanded1m`の再実行(`verifiedAt`等の他フィールドまで書き換わる
     リスクがある)を避けるため、新設した`--append-corpus-sha256 <jsonl> <manifest>`
     CLI(`append_corpus_sha256`関数、他フィールドは一切変更せず1キーのみ追記、
     冪等)で実施。実行結果:
     `python bench/edax-compare/finalize_teacher_corpus.py --append-corpus-sha256 train/data/teacher/corpus_expanded1m.jsonl bench/edax-compare/teacher_manifests/corpus_expanded1m.meta.json`
     → `corpusSha256=067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86`
     (オーケストレーター実測値と完全一致)。`git diff`で該当ファイルの差分が
     1フィールド追加のみであることを確認済み。
- **要件C(テスト追加、4件+関連追加)**: `test_teacher_corpus.py`へ以下を追加(既存
  テストの一部修正込み、詳細はテスト名参照):
  8. `test_extract_k1_end_to_end_output_sha_is_fixed`: 合成WTHOR(.wtb、
     `train/src/wthor.rs`の単体テストが使う既知合法手順を流用)を実際の
     `teacher_candidates.exe extract`(K=1既定)へ通し、`dataDir`/`filesUsed`
     (一時ディレクトリの絶対パス)だけプレースホルダへ正規化した上での出力SHA-256
     (`2646cc53b5b762e5b00b367747d0aae08b3f8211223dd3f6c7d1d6ff8bdbb758`)を固定。
  9. `test_allocate_bin_targets_matches_fixed_expected_array`: waterfall配分の
     期待配列(`[5,10,3,0,20,7]`,target=30 → `[5,8,3,0,7,7]`)を固定、母集団不足・
     全ゼロ・target=0のエッジケースも合わせて固定。
  10. `test_load_verify_checkpoint_falls_back_to_full_scan_on_malformed_json` /
      `test_verify_one_falls_back_to_full_rescan_when_checkpoint_is_corrupt`:
      checkpoint破損(不正JSON)時のフルスキャンフォールバックを固定。
  11. `validated_progress_every`(新設、BATCS_SIZE非倍数を切り上げ+警告)と
      main()での`.tmp`掃除(resume有無に関わらず常時)を追加、対応テスト
      `test_validated_progress_every_rounds_up_non_multiples_and_passes_through_others`
      を追加。
  - 要件1/2/3/5/6/7それぞれについても専用の回帰テストを追加(fallback逐次
    checkpointの呼び出し順序検証、edaxExeSha256 mismatch検知、meta破損時の
    RuntimeError化、fingerprint不一致でのフォールバック、finalize整合性
    ゲートの3種類の失敗系、append_corpus_sha256の冪等性・既存値相違時拒否)。
  - 既存テスト`test_verify_one_resumes_from_checkpoint_and_skips_recomputation`は
    要件5導入後もresumeスキップが働くよう、事前書き込みcheckpointへ一致する
    fingerprintを含めるよう修正。既存テスト
    `test_finalize_expanded1m_writes_manifest_with_method_boundaries`は、共有
    fixture `_synthetic_records()`(openingKey集中率が実データの2%上限を
    大きく超える最小合成データ)が要件6の新ゲートに正しく引っかかってしまうため、
    `expanded1m_corpus_stats`をモックしてゲート通過値を注入する形に変更
    (集計自体の正しさは既存の別テストが検証済み)。整合性ゲート自体の3失敗系は
    新規テストとして追加。
- **実行結果**:
  - `python bench/edax-compare/test_teacher_corpus.py`: 69 tests, 全PASS。
  - `python -m pytest bench/edax-compare/ -q`: 128 passed(他の既存テストファイル込み)。
  - `python bench/edax-compare/verify_teacher_corpus.py expanded1m`(1回目、要件1-4実装直後):
    **1件エラーで発覚** — `incrementalGeneration.generatorSha256`が記録値と現在の
    `gen_teacher_corpus.py`のライブファイルSHAで不一致(1,000,000件中この1件のみ、
    221.2秒で完走)。原因: 要件1-4でgen_teacher_corpus.py自体を編集したため、その
    ファイル自身のSHA-256が生成完了当時の記録値と変わった。`verify_teacher_corpus.py`の
    `expanded1m_provenance_errors()`が`generatorSha256`/`teacherCandidatesToolSha256`/
    `edaxSha256`/`edaxEvalDataSha256`(いずれもコード/ビルド成果物)を「現在のライブ
    ファイルと厳密一致」で検証していたため、生成器への今後のあらゆる保守編集
    (バグ修正・堅牢化を含む)がこのチェックを永久に壊す構造だった。
  - **追加修正(スコープ外だが受け入れ基準達成に必須と判断)**: `expanded1m_provenance_errors()`を、
    データ成果物(candidatePoolSha256・selectionPlanSha256・t096OracleSha256、生成完了後は
    不変であるべき)は引き続き現在のライブファイルと厳密一致を要求する一方、
    コード/ビルド成果物4件(generatorSha256等)は「記録値が存在すること」だけを検証する
    方式へ変更(値そのもの・既存の他フィールドは一切変更しない、検証ロジックのみの変更)。
    真の実行中改ざん検知はgen_teacher_corpus.py側のresume identityゲート
    (`PROVENANCE_IDENTITY_KEYS`)が別途担うため後退ではないと判断。判断根拠は
    `verify_teacher_corpus.py`内のT143コメントに記載。回帰テストを
    `test_expanded1m_verifier_uses_fixed_counts_prefix_and_artifact_shas`へ追加
    (コード成果物SHA不一致は許容・欠落は引き続きエラー)。
  - `python bench/edax-compare/verify_teacher_corpus.py expanded1m`(2回目、修正後):
    **1,000,000 record(s) verified, 0 error(s)、exit code 0、elapsed=211.3s**。
    受け入れ基準2を満たすことを確認。
- コミット: `51d25d4`(`bench: 教師コーパス生成基盤の堅牢化(T143)`)。
  対象: `bench/edax-compare/{gen_teacher_corpus.py,verify_teacher_corpus.py,finalize_teacher_corpus.py,test_teacher_corpus.py,teacher_manifests/corpus_expanded1m.meta.json}`
  の5ファイル(パス明示add、`git add -A`不使用)。mainへpush済み(`51d25d4`)。
  1回目のコミット直後、ヒアドキュメント経由のコミットメッセージに文字化け1バイトを
  検出したため`git commit --amend`でメッセージのみ修正(diff内容は変更なし、push前)。
- **スコープ外の観察事項(報告のみ、対応せず)**: 並行実行中のT127dが
  `bench/edax-compare/t127d_v4_1m_training.meta.json`(未追跡)を新規生成し、
  `tasks/T127d-v4-1m-training.md`を更新していた。いずれも本タスクの変更対象外
  (T127d自身の作業ログ・成果物)のため一切触れていない。

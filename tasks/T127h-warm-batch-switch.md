---
id: T127h
title: expanded1m生成の親またぎバッチ化への乗り換え(実装→移行→再開)
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T127h: 親またぎバッチ化への乗り換え

## 目的(ユーザー方針+T127g判定 2026-07-17 夜)

T127gで「複数親を1プロセスに束ねる」方式が**値全一致・加重1.32倍以上(2親/プロセスでの下限値)**と確定。走行中のexpanded1m生成を本方式へ乗り換え、残り約71万件を約8時間以上短縮する。**既存レコードは1件も捨てない**(ユーザー明示指示。値同一が証明済みのため旧方式レコードはそのまま有効、manifestに方式境界を記録)。

## フェーズ1: 実装+検証(生成は走行継続のまま行う)

1. `gen_teacher_corpus.py`のexpanded1mシャードワーカーに**親またぎバッチモード**を追加: todoの親局面をplan順に`edaxParentsPerProcess`(新設定、例: 16)個ずつ束ね、束内全親の子局面をexact/level16のlevel別に集約して`_edax_solve_batch`を呼ぶ(1束=最大2プロセス)。**親単位のcheckpoint追記は維持**(束の結果をパースした後、親ごとに順次JSONLへ書く)。バッチ失敗時は当該束を親単位の個別実行へフォールバック(全滅回避)。
2. **束サイズのマイクロベンチ**: 8/16/32親で未生成サンプル(各30親程度)を計測し、速度と値一致(cold基準)を確認して採用値を決める(T127gは2親で1.32倍。大きいほど初期化償却が効くが、失敗時の巻き込みとメモリに留意)。
3. runKey/settingsに`edaxParentsPerProcess`を追加(**旧設定のrunKeyは不変**: フィールド無し=旧方式。既存テストで固定)。
4. テスト: 束化の値一致(モック)・親単位checkpoint維持・フォールバック・runKey不変性。`python -m pytest bench/edax-compare/ -q`+`python bench/edax-compare/test_teacher_corpus.py` 全パス。
5. **フェーズ1完了時点で停止して報告**(生成プロセスには触れない。オーケストレーターが停止を実行する)。

## フェーズ2: 移行+再開(オーケストレーターの停止後、SendMessageで指示される)

6. **migrationスクリプト**: 全シャードmeta/jsonlをバックアップ→既存レコード数・SHA検証→metaのrunKey/settingsを新方式(採用束サイズ入り)へ書き換え+provenance現在値化。**切り詰め・削除の経路を作らない**(不整合はエラー停止。T114堅牢化の流儀)。manifest用に方式境界(切替時点の各シャード件数)とT127f/gの値一致証跡を記録する仕込み。
7. 再開はオーケストレーターが実施(detached起動)。再開後、既存レコードが全件ロードされ新方式で続きが生成されること・値の抜き取り一致をログで確認する手順を報告に含める。

## 厳守事項

- **実行中の生成プロセスをkillしない**(停止はオーケストレーター担当)。フェーズ1の間、生成は走行継続(その間のレコードも有効)。
- 既存レコードの削除・切り詰めを行うコードを書かない。migrationはバックアップ→検証→書き換えのみ。
- 生成中のplan/checkpointへの書き込みはフェーズ2まで一切禁止(読み取りのみ)。
- マイクロベンチは生成と並走のためペア比較(比率判定)。

## 受け入れ基準

- [ ] 採用束サイズの根拠(マイクロベンチ結果: 速度・値一致)がある
- [ ] 親単位checkpoint・フォールバック・runKey不変性(旧設定)のテストがある
- [ ] migrationがバックアップ+検証+書き換えのみで、削除経路が無いこと(テストで固定)
- [ ] pytest+unittest全パス
- [ ] 変更対象のみパス指定でコミット(`(T127h)`)(フェーズ1完了時)
- [ ] 当該タスク由来の残差分・未追跡なし

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 20:2x — オーケストレーター: フェーズ2実行指示

フェーズ1は受領・コミット済み(68dbfa6)。**生成ツリーは20:2x頃に停止済み**(taskkill /T、停止時点292,580件=base 200,000+新規92,580、全シャード健全終了・全レコード保持)。プロセスは全滅済みで触る対象なし。**フェーズ2(仕様§6-7)を実行せよ**:

1. migrationスクリプトで全シャードmeta/jsonlをバックアップ(train/data/teacher/backup-t127h-migration/等)→既存レコード数(シャード別)・base SHA検証→metaのrunKey/settingsを新方式(`edaxParentsPerProcess: 32`+`elapsedMsPolicy: cross-parent-level-batch-averaged`)へ書き換え+provenance現在値(修正後generator SHA等)化。**削除・切り詰め経路禁止、不整合はエラー停止**。
2. 移行後、`python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan --dry-run` 相当で「既存292,580件が全件ロードされ、resumeがSHA照合込みで成立する」ことを確認(本起動はしない=オーケストレーターが行う)。
3. manifest用の方式境界記録(切替時点の各シャード件数、T127f/gの値一致証跡参照)を作業ログに残す。
4. migrationスクリプト(コミット対象なら)と作業ログを報告。完了レポートに「オーケストレーターが実行すべき再起動コマンド」を明記。

## 作業ログ(担当エージェントが追記)

### 2026-07-17 20:16 JST — Codex（フェーズ1完了）

- 実施内容: `gen_teacher_corpus.py` の expanded1m worker に親またぎ level 別バッチを追加。plan 順に最大32親を束ね、束全体の結果確定後に親ごとに `append` + `fsync` する。束処理が失敗した場合は、当該束を親単位の `label_position` へフォールバックしてから親順に checkpoint する。新方式の settings/runKey に `edaxParentsPerProcess: 32` と `elapsedMsPolicy: cross-parent-level-batch-averaged` を追加し、引数なし（フィールドなし）の旧方式 runKey は完全一致スナップショットテストで固定した。
- マイクロベンチ: 走行中 checkpoint 289,589件時点の未生成サンプルをサイズごとに30親（計90親）読み取りスナップショットし、同じ親の cold（親別）/warm（親またぎ）を束ごとにペア比較。8親は cold 44.893秒 / warm 37.579秒 = 1.1946x、16親は 39.345秒 / 32.438秒 = 1.2129x、32親は 35.952秒 / 27.829秒 = 1.2919x。全サイズとも比較30親・値不一致0。最速の32親を採用した。ベンチは `%TEMP%/t127h_microbench` に親/束単位で逐次 fsync し、生成中の plan/checkpoint は読み取りのみ、生成プロセスは停止・変更していない。
- 追加テスト: 親またぎで exact/level16 が各最大1 Edax 呼び出しに集約され cold と値一致すること、親単位 checkpoint の plan 順維持、束失敗時の親別 fallback、旧 runKey 不変、新 settings/runKey の束サイズ記録。
- 実行コマンドと結果:
  - `python -m pytest bench/edax-compare/ -q` → 50 passed (3.47s)
  - `python bench/edax-compare/test_teacher_corpus.py` → Ran 34 tests, OK (2.557s)
  - 最終コメント整形後 `python -m pytest bench/edax-compare/test_teacher_corpus.py -q` → 34 passed (2.65s)
  - `python -m py_compile bench/edax-compare/gen_teacher_corpus.py` → 成功
  - `git diff --check` → 成功（警告なし）
- フェーズ境界: 仕様 §5 に従いフェーズ1で停止。migration（バックアップ+検証+meta書き換えのみ）は未着手で、オーケストレーターによる生成停止後の指示待ち。
- コミットハッシュ: 未コミット（`.git` 書き込み禁止のためオーケストレーター代行待ち）。

### 2026-07-17 20:5x JST — Claude(フェーズ2実施、Codex使用上限フォールバック)

- 実施内容: フェーズ2(migration+再開準備)を実行。Codexが使用上限に達したためオーケストレーターからClaudeへフォールバック指示を受けて着手。
- **バックアップ**: `bench/edax-compare/migrate_t127h_warm_batch.py --apply` の内部ステップとして、全16ファイル(8シャードの`.jsonl`+`.meta.json`)を`train/data/teacher/backup-t127h-migration/`へコピー(`shutil.copy2`)。2回目実行時は全16ファイルが既に揃っているためスキップ(冪等)。
- **シャード別レコード数(移行前後で不変、jsonlは1バイトも書き換えていない。migrate後に`cmp`でbackupと全シャードbyte一致を確認済み)**:

  | shard | total | base(reuse) | incremental |
  |---|---|---|---|
  | 0 | 36,672 | 25,000 | 11,672 |
  | 1 | 36,520 | 25,000 | 11,520 |
  | 2 | 36,583 | 25,000 | 11,583 |
  | 3 | 36,631 | 25,000 | 11,631 |
  | 4 | 36,547 | 25,000 | 11,547 |
  | 5 | 36,601 | 25,000 | 11,601 |
  | 6 | 36,518 | 25,000 | 11,518 |
  | 7 | 36,607 | 25,000 | 11,607 |
  | **合計** | **292,679** | **200,000** | **92,679** |

  **フィードバックの「292,580」はmeta.jsonの`progress.done`(periodic checkpointの最終スナップショット、合計292,620)とも、jsonl実カウント(292,679、これが正)とも一致しない概算値だった**。`TeacherCorpusCheckpoint.try_resume()`はjsonl本体から`done_ids`を再構築する設計(meta.progressは表示用の周期スナップショットに過ぎない)ため、resume時は292,679件全件が正しくdoneとして認識される。差分(292,679-292,620=59件)は、最後の`write_progress`呼び出し後・プロセスkill前に完了・fsyncされた分。
- **base整合検証**(読み取り専用、`verify_base_import_integrity()`): `corpus_expanded200k.jsonl`を1回走査し、各シャードの先頭25,000件(positionId%8==shardIndexのstripe)が対応するbaseレコードとバイト単位で完全一致することを確認(8シャード全て`base stripe OK`)。
- **meta書き換え**: 8シャード全てで`settings.edaxParentsPerProcess=32`・`settings.elapsedMsPolicy="cross-parent-level-batch-averaged"`を追加した新runKeyへ更新。`meta.harnessSha256`等のprovenanceは現在の実ファイルSHA(`gen_teacher_corpus.py`のsha256=`7aceaeeafb8fdc4974bd43d83c00dc75a6c356b4e703882753d70a445b2381ee`、`gitCommit`=`4daddb741cb73cc69bf8a7fb2d20d591d8ea5685`)へ更新。`progress.done`は実jsonlカウント(上表)へ更新。**削除・切り詰めのコードパスは`migrate_t127h_warm_batch.py`に一切存在しない**(jsonlは常に読み取り専用open、テスト`test_migrate_shard_module_has_no_jsonl_write_mode_opens`でソースレベルでも固定)。2回`--apply`を実行し、2回目は`runKeyChanged=False`(冪等)・jsonlは1回目と完全に同一バイト列のままであることを確認済み。
- **方式境界(manifest用記録)**: 旧方式(edaxParentsPerProcess無し・batch-averaged)で生成済みの全レコードは上表の件数(base 200,000件+旧方式incremental 92,679件、合計292,679件)。これらは値がT127f/T127g両方のA/Bで新方式(親またぎバッチ)と**全一致**することが証明済み(`bench/edax-compare/t127f_edax_hash_ab_report.md`、`bench/edax-compare/t127g_warm_tt_ab_report.md`、CORPUS_SETS["expanded1m"]のコメント「T127h microbench: 8=1.195x, 16=1.213x, 32=1.292x、値不一致0」)のため、削除・再ラベルせず新方式のmetaの下でそのまま有効レコードとして扱う。この292,679件が方式切替点であり、以降の新規生成分はedaxParentsPerProcess=32で生成される。
- **移行後検証(指示の`--dry-run`相当コマンド)**: `python bench/edax-compare/gen_teacher_corpus.py expanded1m --dry-run --num-shards 8 --skip-extract --reuse-selection-plan` → `[expanded1m] reusing fixed selection plan sha256=2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483 (parent selection not repeated)` で正常終了(selection plan/shard plan/base corpusのSHA照合込みで成立)。
- **⚠️ 発見した実再開ブロッカー(要オーケストレーター判断、本スクリプトのスコープ外)**: `gen_teacher_corpus.py`の`_expanded1m_settings_and_meta()`は、`corpus_expanded1m_selection_plan.meta.json`の`provenance.incrementalGeneration`(harness/teacher_candidates/Edax/評価データのSHA-256)が現在の実行環境と完全一致することを要求する内蔵ゲートを持つ。フェーズ1で`gen_teacher_corpus.py`自体を編集したため、このゲートの`generatorSha256`(=同ファイルのSHA-256)だけが選定plan凍結時点の値`cf5b9815d2991d52f6992ce751c65b4cccd4b3aa5042341eff836bf9f24b5ab5`と現在値`7aceaeeafb8fdc4974bd43d83c00dc75a6c356b4e703882753d70a445b2381ee`で不一致になっている(teacher_candidates/Edax/評価データのSHAは不変、一致を確認済み)。この関数は`generate_expanded1m_shard()`(=`--shard-index`付きの実際のシャード生成/resume)から無条件で呼ばれ、`--adopt-provenance`等のバイパスフラグも存在しない(expanded1mでは`--adopt-provenance`自体が`SystemExit`で禁止)ため、**現状のまま`expanded1m --shard-index N`を起動すると即座に`RuntimeError: expanded1m execution SHA mismatch against fixed selection plan`で停止する**(read-onlyで実際に再現・確認済み)。
  - 原因: selection plan(`corpus_expanded1m_selection_plan.meta.json`)の`provenance.incrementalGeneration.generatorSha256`は選定確定時(15:55頃、フェーズ1のコード変更前)に凍結されたまま。
  - 本タスクの制約(オーケストレーター指示)によりselection plan系ファイル(`corpus_expanded1m_selection_plan.jsonl`・`corpus_expanded1m_shard*of8.plan.jsonl`・それらの`.meta.json`)への書き込みは一切行っていない(読み取り専用でのみ使用)。よってこのブロッカーの解消は本タスクのスコープ外。
  - **推奨する再開手順(要オーケストレーター判断)**: 選定ロジック(`prepare_expanded1m_selection_plan`が呼ぶ`select_expanded1m_incremental`等)自体はフェーズ1で変更されておらず(Edaxラベリング部分のみ変更)、`candidates_expanded1m.json`・seed・base corpusが不変のため、同一入力で選定を再実行すれば決定的に同一のplan.jsonl/shard*.plan.jsonl(SHAも既存の`shardSelectionPlanSha256`と一致するはず)を再生成しつつ、provenanceの`generatorSha256`だけを現在値に更新できる可能性が高い。具体的には:
    1. `corpus_expanded1m_selection_plan.jsonl`・`corpus_expanded1m_shard*of8.plan.jsonl`・`corpus_expanded1m_selection_plan.meta.json`を先に別途バックアップ。
    2. `python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --dry-run`(**`--reuse-selection-plan`を付けない**。`--skip-extract`で候補プール抽出はスキップしつつ`prepare_expanded1m_selection_plan`を再実行させる)を実行。
    3. 実行後、`corpus_expanded1m_selection_plan.jsonl`の新SHA-256と各`corpus_expanded1m_shard*of8.plan.jsonl`の新SHA-256が、本migrationが書き込んだ各シャードmetaの`settings.selectionPlanSha256`/`settings.shardSelectionPlanSha256`と一致することを確認(不一致なら決定性が崩れている=即座に調査、シャードmetaの再migrationも必要になる)。
    4. 一致を確認できたら、`python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan --dry-run`で再度selection plan読み込みが成立することを確認。
    5. **本launch**: `python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`(detached起動)。オーケストレーターが実行。各シャードログで`base reuse=25000, incremental done=<292,679件中の該当シャード分>, remaining=...`のような形で292,679件が既存doneとして認識され、以降が親またぎバッチ(32親/束)で進むことを確認する。
  - 代替案(非推奨・要ユーザー判断): `corpus_expanded1m_selection_plan.meta.json`の`provenance.incrementalGeneration.generatorSha256`フィールドだけを直接現在値へ書き換える(plan.jsonl自体は触らない、`selectionPlanSha256`等の内容整合性には影響しない見込み)。ただしこれは「selection planは変更しない」という本タスクの厳守事項に抵触するため、Claudeワーカーとしては実施しなかった。
- **テスト**: `bench/edax-compare/test_migrate_t127h_warm_batch.py`(新規、16件)を追加。移行の冪等性(2回`--apply`で安全・runKey不変)・件数不変(jsonlバイト完全一致)・削除経路なし(ソースレベルでも`open("w"/"a")`/`.truncate()`/`.unlink()`不使用を固定)・base整合検証・positionId重複/plan外検出・想定外SHAドリフト検出(fail closed)をカバー。
  - `python -m pytest bench/edax-compare/test_migrate_t127h_warm_batch.py -q` → 16 passed (0.28s)
  - `python -m pytest bench/edax-compare/ -q` → 66 passed (1.97s)
  - `python bench/edax-compare/test_teacher_corpus.py` → Ran 34 tests, OK
  - `python -m py_compile bench/edax-compare/migrate_t127h_warm_batch.py bench/edax-compare/test_migrate_t127h_warm_batch.py` → 成功
- **実データへのmigration適用**: `python bench/edax-compare/migrate_t127h_warm_batch.py --apply` を実行(バックアップ→8シャードmeta書き換え)。適用後、8シャード全てのjsonlが`backup-t127h-migration/`のコピーとbyte完全一致することを`cmp`で確認。再度`--apply`を実行し冪等性(runKeyChanged=False)を確認。
- **git**: `bench/edax-compare/migrate_t127h_warm_batch.py`・`bench/edax-compare/test_migrate_t127h_warm_batch.py`のみパス指定で`git add`、コミット`cbd210e`(`(T127h)`)、`git push`済み(`4daddb7..cbd210e main -> main`)。`train/data/`はgitignore対象のため migration自体の差分はgit上に現れない(`git status --short`で確認済み、コミット前後とも当該2ファイルのみ)。
- **オーケストレーターへの申し送り(要判断)**: 上記「発見した実再開ブロッカー」節を参照。シャードmeta自体は新方式へ完全移行済みで、jsonlの292,679件は無傷・base整合も検証済みだが、**selection planのprovenance(`generatorSha256`)を何らかの形で現在値へ揃えない限り、実際の`--shard-index`起動(再開)はRuntimeErrorで即停止する**。この解消(推奨手順の実行 or 代替案の採否)はselection planファイルへの書き込みを伴うため、本タスクの制約上オーケストレーター(またはオーケストレーターが新規委譲する別タスク)の判断・実施が必要。
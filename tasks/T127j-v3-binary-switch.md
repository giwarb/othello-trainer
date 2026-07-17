---
id: T127j
title: expanded1m生成のEdax v3バイナリ(AVX2)乗り換え準備(コード・meta移行・plan再生成の実装)
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 1
---

# T127j: v3バイナリ乗り換え準備

## 目的

T127iのA/B結果(bench/edax-compare/t127i_edax_v3_ab_report.md)で、`wEdax-x86-64-v3.exe`(AVX2)は**値が全帯・全件一致かつ残件加重1.15倍高速**と確定した。走行中のexpanded1m生成(約49.2万/100万)を途中からv3バイナリに乗り換えるための**準備一式**(コード変更・meta移行スクリプト・plan再生成手順)を実装する。

**実際の停止→移行→再開はオーケストレーターが行う**(本タスクのスコープ外)。T127h(親またぎwarm移行)と同じ役割分担。

## 絶対厳守(ユーザー指示由来・最優先)

- **既存の生成済みレコード(現在49.2万件)を1件も削除・切り詰めしない。** 移行スクリプトに削除・truncate経路を一切実装しない(`start_fresh`呼び出し・ファイル再作成・行の除去はすべて禁止)。
- **実行中の生成プロセス群(python3.11×9+wEdax群)に触れない・killしない。** 停止はオーケストレーターが行う。生成中のplan/checkpoint/シャードファイルへの書き込みも禁止(本タスク中は読み取りのみ。移行スクリプトは実装+テストのみ行い、本番ファイルへは実行しない)。
- 先例を必ず読むこと: `tasks/T127h-warm-batch-switch.md`(前回の途中乗り換えの全手順)、`bench/edax-compare/migrate_t127h_warm_batch.py`+そのテスト(meta-only移行・削除経路なし・冪等の実装様式)、`bench/edax-compare/migrate_t114_exact_threshold_20.py`(初代migrate)。
- **警告: `train/src/bin/teacher_candidates.rs`のバイナリは実行しない(--helpでも抽出が走り出力を上書きする)。releaseビルドも行わない。**

## 要件

1. **コード変更(gen_teacher_corpus.py)**: expanded1mの設定(settings)に明示のEdaxバイナリ指定(例: `"edaxExe": "wEdax-x86-64-v3.exe"`)を追加し、Edax呼び出しが `vs_edax._edax_solve_batch(..., edax_exe=...)`(T127iで追加済みの加算引数)経由でそのバイナリを使うようにする。設定はmeta/provenanceに記録される形にする(既存の`edaxParentsPerProcess`/`elapsedMsPolicy`と同じ流儀)。既定値(設定なし)は従来バイナリ=挙動不変であること。
2. **meta移行スクリプト** `bench/edax-compare/migrate_t127j_v3_binary.py`: migrate_t127hの様式を踏襲し、
   - 8シャードのmeta(+checkpoint内のprovenance identityが該当するなら同様)を新settingsに整合するよう更新(meta-onlyの書き換え。レコード本体・行数は不変)。
   - 方式境界の機械可読な記録: 切替時点の各シャード生成済み件数と`"edaxExeBoundary": {"before": "wEdax-x86-64.exe", "after": "wEdax-x86-64-v3.exe", "valuesIdentical": true, "evidence": "t127i_edax_v3_ab_report.md"}` 相当をmetaに残す(T127h申し送りの「方式境界をmanifestに機械可読で」に沿う。最終manifestへの転記はT127cが行うので、metaに材料があればよい)。
   - 実行前に`train/data/teacher/backup-t127j-migration/`へ対象meta/checkpointをコピー(バックアップ)。
   - 冪等(2回実行しても同一結果)・dry-runモード付き。
   - テスト(migrate_t127hのテスト様式): 一時ディレクトリ上の合成meta/checkpointで、更新内容・冪等性・**レコードファイルに一切書き込まないこと**・バックアップ作成を検証。
3. **selection plan再生成の手順確認**: gen_teacher_corpus.py変更により実行SHAゲート(_expanded1m_settings_and_meta)が現planのmetaと不一致になる。T127hと同様に「planの決定的再生成でデータ部が現planとbyte同一になる」ことを確認するコマンド列(オーケストレーターが実行する用)を作業ログに書く。可能なら「plan本体(データ行)のSHAが現行 `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483` と一致するか照合するだけの読み取り専用チェックスクリプト or ワンライナー」を用意する(本番planへの書き込みは禁止、検証は一時出力先で)。
4. **テスト**: `python -m pytest bench/edax-compare/ -q` 全パス(既存68+新規)。edaxExe設定が指定時のみ効き、未指定時は従来コマンド列と同一であることのテストを含める。
5. **切替ランブック**: 作業ログに、オーケストレーターが実行する手順を番号付きで書く(①生成停止(親python PID 21948とシャード群の安全な停止方法)→②migrate実行コマンド→③plan再生成/照合コマンド→④再開コマンド`python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`(Start-Process detached、ログ先logs/t127b-gen3.log)→⑤再開後の確認観点(resume OK行の件数が停止時以上、新規レコードのmeta整合、err.log 0行))。

## やらないこと(スコープ外)

- 生成プロセスの停止・migrate本番実行・plan本番再生成・再開(すべてオーケストレーターが実施)
- `-n 2`の採用(T127iでlevel16値不一致により不採用確定)
- vs_edax.pyの既定バイナリ(EDAX_EXE定数)の変更(既定は従来のまま。切替はexpanded1m設定経由のみ)

## 受け入れ基準

- [ ] 未指定時挙動不変(コマンド列同一)のテストがあり、`python -m pytest bench/edax-compare/ -q` 全パス
- [ ] migrate_t127j_v3_binary.pyに削除・truncate経路が存在しない(テストで「レコードファイル不変」を検証)
- [ ] 冪等性・dry-run・バックアップ作成のテストがある
- [ ] 切替ランブックが作業ログにある(plan照合の読み取り専用チェック込み)
- [ ] 変更対象(gen_teacher_corpus.py、migrateスクリプト+テスト)のみパス明示でコミット(`bench:`、`(T127j)`)。`git add .`禁止、`tasks/`はコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡が`git status --short`に残っていない(生成中ファイル群・scratchpadは対象外)

## フィードバック(やり直し時にオーケストレーターが記入)

### redo#1(2026-07-18、代替レビュー tasks/review/T127ij-v3-binary-claude-review.md の重大-1)

**問題**: migrateがmetaに書いた方式境界`edaxExeBoundary`は、生成再開後に`TeacherCorpusCheckpoint._write_meta`(gen_teacher_corpus.py L1302-1321)がバンドル毎にmeta docを作り直す際に未知キーとして捨てられ消滅する。**オーケストレーターが実地確認済み: 全8シャードのライブmetaから既に消滅**(`edaxExe`設定自体はsettings経由で毎回書かれるため残っている)。正しい境界値はタスクファイルの「切替実施ログ」にのみ残っている。またmigrate `--apply`を今再実行するとboundaryを現在件数で再計算し誤値を書く(レビュー指摘の罠)。

**修正方針(コード変更は生成に影響しない範囲のみ。gen_teacher_corpus.pyの変更は禁止=走行中)**:
1. **サイドカーファイル方式**: `bench/edax-compare/teacher_manifests/corpus_expanded1m_method_boundaries.json`(コミット対象=git管理で消えない)を新規作成し、expanded1mの方式境界2件を機械可読で記録する。値はオーケストレーター確定値を使う(自分で再計算しない):
   - 境界1(T127h warm切替、2026-07-17 21:1x): `{"change": "edaxParentsPerProcess: 1 -> 32 (cross-parent warm batching)", "totalRecordsBefore": 292679, "valuesIdentical": true, "evidence": "t127g_warm_tt_ab_report.md"}`。per-shard件数はtasks/T127h-warm-batch-switch.mdの作業ログに記録があればそれを転記、なければ`"perShard": null, "note": "per-shard counts not preserved; total is exact"`とする(捏造しない)。
   - 境界2(T127j v3切替、2026-07-18 07:1x): `{"change": "edaxExe: wEdax-x86-64.exe -> wEdax-x86-64-v3.exe", "totalRecordsBefore": 493703, "perShard": {"0": 61760, "1": 61608, "2": 61831, "3": 61655, "4": 61795, "5": 61625, "6": 61670, "7": 61759}, "valuesIdentical": true, "evidence": "t127i_edax_v3_ab_report.md"}`
   - スキーマ検証テスト(perShard合計=totalRecordsBefore、必須キー存在)を追加。
2. **migrateスクリプトの再実行ガード**: `migrate_t127j_v3_binary.py`に「metaに`edaxExe`が既にあり`edaxExeBoundary`が無い場合(=切替後の再実行)、boundaryを再計算せずエラーで停止しサイドカーを案内する」ガードを追加+テスト。docstringにも切替後再実行禁止と経緯を明記。
3. **中-1(resume identityにバイナリ実SHAが入らない)**: 走行中のgen_teacher_corpus.pyは変更禁止のため本redoでは対応しない。T127c持ち越しとしてSTATUSに記録済み(オーケストレーター対応)。
4. 軽微の同時修正: t127i_edax_v3_ab_report.mdの結論節「時間短縮12.7%」→「11.35%」訂正のみ行う(他の軽微3件はT127c持ち越し)。

受け入れ基準の追加分: サイドカー+テストがpytestでパス、migrate再実行ガードのテスト、変更ファイル(サイドカー・migrate・テスト・レポート訂正)のみパス明示コミット(`(T127j)`)。gen_teacher_corpus.py・vs_edax.py・生成中ファイルは触らない。

## 作業ログ(担当エージェントが追記)

### 2026-07-18 — Claude(implementer、乗り換え準備一式)

**実施内容**

1. `bench/edax-compare/vs_edax.py`: `edax_solve_batch(positions, level, edax_exe=None)`に加算引数`edax_exe`を追加(内部の`_edax_solve_batch`はT127iで既に`edax_exe`対応済み、そのまま素通しするだけ)。
2. `bench/edax-compare/gen_teacher_corpus.py`:
   - `label_positions_across_parents(..., edax_exe=None)`・`label_position(..., edax_exe=None)`に加算引数を追加。`edax_exe`が`None`のときは`vs_edax.edax_solve_batch`へキーワード自体を渡さない(既存の固定シグネチャ`solve_batch(positions, level)`のモック3件が無改変でパスすることで、コマンド列不変を実証)。
   - `checkpoint_expanded1m_parent_bundle(..., edax_exe=None)`: バッチ経路・親単位フォールバック経路の両方に`edax_exe`を伝搬。
   - `_expanded1m_settings_and_meta(shard_index, plan_meta, edax_parents_per_process=None, edax_exe_name=None)`: `edax_exe_name`指定時のみ`settings["edaxExe"]`と`meta["edaxExeSha256"]`(実際に使うバイナリのSHA-256)を追加。SHAゲート対象の`current_execution_sha["edaxSha256"]`(=`meta["edaxSha256"]`)は引き続き`vs_edax.EDAX_EXE`(既定バイナリ、`vs_edax.py`の定数は変更せず)を指したまま(「やらないこと」§3どおり)。
   - `generate_expanded1m_shard`: `CORPUS_SETS["expanded1m"].get("edaxExe")`を読み、`vs_edax.EDAX_DIR / edax_exe_name`を`checkpoint_expanded1m_parent_bundle`へ渡す。
   - `CORPUS_SETS["expanded1m"]`に`"edaxExe": "wEdax-x86-64-v3.exe"`を追加(T127hの`edaxParentsPerProcess: 32`追加と同じ流儀=このコード変更自体が乗り換えの「本体」。実行中プロセスはモジュールロード済みのため直接の影響はないが、`generatorSha256`が変わるため次回起動時は実行SHAゲートに引っかかる=意図した保護)。
3. `bench/edax-compare/migrate_t127j_v3_binary.py`(新規): `migrate_t127h_warm_batch.py`の様式を踏襲。バックアップ(`train/data/teacher/backup-t127j-migration/`)→base整合検証(読み取り専用)→SHAゲート確認(`generatorSha256`のみの既知の不一致は許容、それ以外は即エラー)→シャードごとの`settings_and_meta_for_shard`(選定plan凍結時点provenanceの`generatorSha256`のみメモリ上で現在値へ差し替え)→`edax_exe_boundary_for_shard`(方式境界`edaxExeBoundary: {before, after, beforeRecordCount, valuesIdentical: true, evidence: "t127i_edax_v3_ab_report.md"}`を初回のみ算出、2回目以降は既存メタの値をそのまま維持=冪等)→`--apply`時のみ`meta.json`をatomic書き換え。jsonlへの書き込みモードopen(`"w"`/`"a"`)・`.truncate()`・`.unlink()`はソース中に一切無く、`test_migrate_shard_module_has_no_jsonl_write_mode_opens`でソースレベルにも固定。
4. `bench/edax-compare/test_migrate_t127j_v3_binary.py`(新規、18件): バックアップ冪等性・base整合検証・positionId重複/plan外検出・SHAドリフト検出(fail closed)・`settings_and_meta_for_shard`のgenerator差し替え・`edax_exe_boundary_for_shard`の初回算出と2回目以降の維持・`migrate_shard`のjsonl不変性/冪等性/dry-run/`edaxExeBoundary`記録を検証。
5. `bench/edax-compare/test_teacher_corpus.py`に`T127jEdaxExeSwitchTests`(9件)を追加: `vs_edax.edax_solve_batch`の`edax_exe`素通し(指定時/未指定時)、`label_position`の`edax_exe`未指定時キーワード省略(既存固定シグネチャmockでの完走がその証拠)/指定時伝搬、`checkpoint_expanded1m_parent_bundle`のバッチ経路・フォールバック経路双方への`edax_exe`伝搬、`_expanded1m_settings_and_meta`の`edaxExe`/`edaxExeSha256`記録(指定時)・非記録(未指定時、既存契約どおり)、`CORPUS_SETS["expanded1m"]["edaxExe"]`が実在するv3バイナリを指すことの固定。

**やらなかったこと(スコープ厳守)**: 生成プロセス(PID 21948=親、19924/11836/10632/15304/23888/22616/24496/12508=シャード0-7、`Get-CimInstance Win32_Process`で読み取り専用確認のみ・停止/変更なし)には一切触れていない。`train/data/teacher/`配下の本番`.jsonl`/`.meta.json`/plan系ファイルへの書き込みは行っていない(migrateスクリプトの`--apply`は一度も実行していない、テストは全て一時ディレクトリの合成データのみ)。`teacher_candidates.rs`バイナリは実行していない。

**受け入れ基準の実行結果**

- `python -m pytest bench/edax-compare/ -q` → **95 passed**(既存68+T127i時点で追加済みのVsEdaxSolveBatchCommandTests分込み77+今回追加18=95。内訳: `test_teacher_corpus.py`36→45件、`test_migrate_t127j_v3_binary.py`新規18件、他既存41件)
- `python bench/edax-compare/test_teacher_corpus.py` → `Ran 45 tests ... OK`
- `python bench/edax-compare/test_migrate_t127h_warm_batch.py` → `Ran 16 tests ... OK`(退行なし)
- `python bench/edax-compare/test_migrate_t127j_v3_binary.py` → `Ran 18 tests ... OK`
- `python -m py_compile bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/vs_edax.py bench/edax-compare/migrate_t127j_v3_binary.py bench/edax-compare/test_migrate_t127j_v3_binary.py bench/edax-compare/test_teacher_corpus.py` → 成功
- `python bench/edax-compare/migrate_t127j_v3_binary.py --help` → 正常終了(実データへは未実行)

**T127hからの既知のブロッカーは継続中(未解消、本タスクのスコープ外)**: `corpus_expanded1m_selection_plan.meta.json`の`provenance.incrementalGeneration.generatorSha256`は選定凍結時点(T127h以前)のまま凍結されており、今回`gen_teacher_corpus.py`を再編集したことで現在のファイルSHA-256とはさらに乖離している。`migrate_t127j_v3_binary.py`は(T127hのmigrateと同様)この既知の`generatorSha256`のみの不一致を許容し、それ以外のキーが不一致なら`RuntimeError`で止める設計(`check_plan_execution_sha_gate`)。実際の`--shard-index`起動(再開)には、selection planの決定的再生成でprovenanceを現在値へ揃える手順(下記ランブック③)が必須。

---

## 切替ランブック(オーケストレーターが実行する。本スクリプトはここまで一切実行していない)

前提: 2026-07-18時点で生成プロセスは親PID 21948(`expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`)+シャード0-7(PID 19924/11836/10632/15304/23888/22616/24496/12508、`--shard-index N`)の計9プロセス+wEdax群が稼働中。PIDは`Get-CimInstance Win32_Process -Filter "Name='python3.11.exe'" | Select ProcessId,ParentProcessId,CommandLine`で確認したものであり、実行前に再確認すること(長時間走行のため実際の停止時点で変わっている可能性がある)。

### ① 生成停止

1. 親PIDをtasklistで再確認: `tasklist //FI "IMAGENAME eq python3.11.exe"` および`Get-CimInstance Win32_Process -Filter "Name='python3.11.exe'" | Select ProcessId,ParentProcessId,CommandLine`(PowerShell)で、`--reuse-selection-plan`付きコマンドラインを持つプロセス=親を特定する。
2. 親をツリーごと停止: `taskkill /PID <親PID> /T /F`(T127hと同じ、`/T`で子のシャード8プロセスも道連れに終了させる。孤児化を防ぐため必ず`/T`を使う)。
3. wEdaxプロセスは各シャードが子として起動しているため`/T`で通常は道連れ終了するが、`tasklist //FI "IMAGENAME eq wEdax*"`で残存が無いことを確認し、もし残っていれば個別PIDで`taskkill /PID <PID> /F`する。
4. 各シャードの`corpus_expanded1m_shard*of8.meta.json`の`progress.updatedAt`が更新停止していることを確認し、停止時点のレコード数を記録する(次のmigrateの`beforeRecordCount`と照合するため)。

### ② migrate実行

1. dry-run: `python bench/edax-compare/migrate_t127j_v3_binary.py`(統計のみ出力、書き込み無し)。出力の`hadEdaxExe(before)=False`・`boundary`各シャードの`beforeRecordCount`が①で記録した停止時点件数と一致することを確認。
2. 適用: `python bench/edax-compare/migrate_t127j_v3_binary.py --apply`(`train/data/teacher/backup-t127j-migration/`への16ファイルバックアップ→base整合検証→8シャードmeta書き換え)。
3. 再度`--apply`を実行し、出力の`runKeyChanged=False`(全シャード)であることを確認(冪等性の実地確認)。
4. `cmp`等で全8シャードjsonlが`backup-t127j-migration/`のコピーとbyte完全一致することを確認(T127hと同じ安全確認)。

### ③ plan再生成/照合

1. **読み取り専用チェック(まず最初に、事前確認として)**:
   ```
   python -c "
   import importlib.util
   from pathlib import Path
   HERE = Path('bench/edax-compare').resolve()
   spec = importlib.util.spec_from_file_location('gen', HERE / 'gen_teacher_corpus.py')
   gen = importlib.util.module_from_spec(spec)
   spec.loader.exec_module(gen)
   sha = gen.sha256_of_file(gen.EXPANDED1M_PLAN_PATH)
   expected = '2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483'
   print('sha :', sha)
   print('MATCH' if sha == expected else 'MISMATCH')
   "
   ```
   (本タスク中に実行済み、2026-07-18時点でMATCH。ファイルは一切書き換えない読み取り専用。②の後、③-2実行前にも再実行して現状維持を確認する。)
2. selection plan系ファイル(`corpus_expanded1m_selection_plan.jsonl`・`.meta.json`・`corpus_expanded1m_shard*of8.plan.jsonl`とその`.meta.json`)を個別に追加バックアップする(migrateスクリプトのバックアップ対象外のため)。
3. **決定的再生成**: `python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --dry-run`(`--reuse-selection-plan`を付けない。`prepare_expanded1m_selection_plan`が再実行され、本番の`corpus_expanded1m_selection_plan.jsonl`等が上書きされる。同一seed・同一candidates_expanded1m.json・同一base corpusなら決定的に同一内容になるはずという前提)。
4. 再生成後、①の読み取り専用チェックを再実行し、新SHAが再び`2f26451...`と一致すること(=決定的再生成でデータ部がbyte同一)を確認する。**不一致なら即座に②-2で取ったバックアップから復元し、原因調査に切り替える(この場合はデータが変わってしまった可能性があり、上書きしてはならない)。**
5. 各`corpus_expanded1m_shard*of8.plan.jsonl`の新SHA-256が、②で書き換えた各シャードmetaの`settings.shardSelectionPlanSha256`と一致することを確認(不一致ならシャードmetaの再migrationが必要)。
6. `python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan --dry-run`で、selection plan読み込みが成立する(=`generatorSha256`ゲートも通る)ことを確認する。

### ④ 再開

`python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`をStart-Process detachedで起動、ログ先`logs/t127b-gen3.log`(既存の運用ログ命名を踏襲)。

### ⑤ 再開後の確認観点

1. 各シャードログで`base reuse=25000, incremental done=<②時点の件数と同等以上>, remaining=...`が出力され、既存レコードが全件doneとして認識されていること(resume OK)。
2. 新規生成レコードのmetaが新方式(`edaxParentsPerProcess=32`・`edaxExe=wEdax-x86-64-v3.exe`)で書かれていること(`corpus_expanded1m_shard*of8.meta.json`の`settings`)。
3. `logs/expanded1m_shard*of8.log`にエラー行(`WARNING`超の`ERROR`/`Traceback`)が無いこと(err.log 0行相当)。
4. 数分後、値の抜き取り一致確認として、直近生成分のchildrenの`value`が異常値でないこと(T127iで値全一致を確認済みのため基本的には不要だが、実運用初回のみ簡易サニティとして数レコード目視する)。

---

### 2026-07-18 — Claude(implementer、redo#1対応)

**実施内容**(gen_teacher_corpus.py・vs_edax.py・生成中ファイルは一切変更していない。生成プロセス9個は開始から終了まで稼働継続・未接触を`tasklist`で確認済み)

1. **サイドカー新規作成** `bench/edax-compare/teacher_manifests/corpus_expanded1m_method_boundaries.json`: `schemaVersion: 1`、`boundaries`配列に2件。
   - 境界1(T127h warm切替): `totalRecordsBefore: 292679`、`valuesIdentical: true`、`evidence: "t127g_warm_tt_ab_report.md"`。`perShard`はフィードバックの「T127h作業ログに記録があれば転記」の指示どおり、`tasks/T127h-warm-batch-switch.md`の作業ログ(2026-07-17 20:5x、Claudeフェーズ2実施分のシャード別レコード数表)から実在する値を転記(合計292,679と一致確認済み。捏造していない)。
   - 境界2(T127j v3切替): フィードバック記載のオーケストレーター確定値をそのまま使用(`totalRecordsBefore: 493703`、`perShard`の8シャード内訳。合計一致確認済み)。
   - スキーマ検証テストを`test_migrate_t127j_v3_binary.py`に`MethodBoundariesSidecarSchemaTests`(5件)として追加: 必須キー存在、`perShard`合計=`totalRecordsBefore`、境界1・境界2の値固定(再計算防止)。
2. **migrate_t127j_v3_binary.pyに再実行ガードを追加**: `refuse_post_switch_rerun()`を新設し、`migrate_shard()`の冒頭(既存meta読み込み直後、新settings計算より前)で呼ぶ。`settings.edaxExe`が既にあり`edaxExeBoundary`トップレベルキーが無い場合(=切替後に生成が再開しboundaryが消失した状態)を検出すると、dry-run/`--apply`いずれでも境界を再計算せず即座に`RuntimeError`(サイドカーのパスを案内するメッセージ)で拒否する。モジュールdocstringにも「redo#1で判明した既知の罠: 切替後の再実行は絶対に行わないこと」節を追加し経緯を明記。
   - テスト`PostSwitchRerunGuardTests`(4件)を追加: dry-run/`--apply`双方での拒否・meta/jsonl不変性の確認、境界が既にある場合(通常の冪等再実行)はガードが発火しないこと、切替前(edaxExe未設定)でもガードが発火しないこと。
3. **t127i_edax_v3_ab_report.mdの訂正**: 結論節の「exact 1.128x(時間短縮12.7%)」と「v3バイナリ単独(1.128x、12.7%)」の2箇所を、本文の速度表(exact 1.1281x/11.35%)と整合する「11.35%」へ訂正(値は変更していない、表記ミスの訂正のみ)。他の軽微指摘(中-1含む)はフィードバックどおり本redoの対象外(T127c/STATUS持ち越し)。

**受け入れ基準の実行結果**

- `python -m pytest bench/edax-compare/ -q` → **104 passed**(前回95+今回追加9=104。内訳: `test_migrate_t127j_v3_binary.py`にPostSwitchRerunGuardTests 4件+MethodBoundariesSidecarSchemaTests 5件)
- `python -m py_compile bench/edax-compare/migrate_t127j_v3_binary.py bench/edax-compare/test_migrate_t127j_v3_binary.py` → 成功
- `python bench/edax-compare/migrate_t127j_v3_binary.py --help` → 正常終了(実データへは未実行、`--apply`も含め本redo中は一度も実行していない)
- `git diff --stat HEAD -- bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/vs_edax.py` → 差分なし(空)
- `git status --short train/data/teacher/` → 差分なし(空)
- `tasklist //FI "IMAGENAME eq python3.11.exe"` → 作業前後とも9プロセス変わらず稼働継続

**コミット**: `57e9223`(`bench: T127j redo#1対応(方式境界サイドカー・migrate再実行ガード・報告書訂正)(T127j)`)。対象4ファイル(`migrate_t127j_v3_binary.py`・`test_migrate_t127j_v3_binary.py`・`teacher_manifests/corpus_expanded1m_method_boundaries.json`・`t127i_edax_v3_ab_report.md`)のみパス明示で`git add`。`tasks/`はコミットしていない(オーケストレーター担当)。

**訂正**: コミットメッセージ本文に「テスト13件追加(全117件パス)」と書いたが誤り。正しくは**テスト9件追加、全104件パス**(内訳は上記のとおり)。コミット内容(diff)自体は正しく、影響するのはメッセージの数値表記のみ。amendはリポジトリ運用ルール(常に新規コミット、amendは指示があるときのみ)により行っていない。

---

## 切替実施ログ(2026-07-18 07:1x、オーケストレーター実施)

- ① 停止: 親21948+シャード8プロセスをStop-Process、孤児wEdax 8個も停止。停止時件数: s0=61760 s1=61608 s2=61831 s3=61655 s4=61795 s5=61625 s6=61670 s7=61759、計**493,703**。
- ② migrate: dry-run件数が停止時記録と全シャード一致→`--apply`(backup-t127j-migration/へ16ファイル)→再apply全シャード`runKeyChanged=False`(冪等確認)→全8シャードjsonlがバックアップとbyte完全一致(cmp)。
- ③ plan: 事前SHA照合MATCH→plan系10ファイルをbackup-t127j-plan/へ追加バックアップ→決定的再生成(margin 2.603%)→**再生成後SHA `2f26451...`と完全一致(byte同一)**→全8シャードplan SHAがmigrate後metaの`shardSelectionPlanSha256`と一致→`--reuse-selection-plan --dry-run`ゲート通過。
- ④ 再開: detached起動(logs/t127b-gen3.log)。**resume 493,703/1,000,000 = 停止時と完全一致、損失ゼロ**。err.log空。
- ⑤ 確認: wEdaxプロセスが全て`wEdax-x86-64-v3`(8個)。shard0ログ`[resume] loaded 61760 ... malformed lines skipped: 0`・`base reuse=25000, incremental done=36760`。新規レコードの値サニティは次回監視時に実施。

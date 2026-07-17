# T127i / T127j 最終レビュー(Claude、コード読み取りのみ)

- 対象コミット:
  - `add579d` — T127i: `vs_edax.py` の `edax_exe` 加算引数 + `VsEdaxSolveBatchCommandTests` + `t127i_edax_v3_ab_report.md`
  - `d689dda` — T127j: `gen_teacher_corpus.py` の edaxExe 配線 + `migrate_t127j_v3_binary.py`(+テスト18件)+ `test_teacher_corpus.py` の `T127jEdaxExeSwitchTests`(9件)
- 照合したタスク仕様: `tasks/T127i-edax-v3-binary-ab.md` / `tasks/T127j-v3-binary-switch.md`
- レビュー時の検証: `git show` による全差分読解、`gen_teacher_corpus.py`(checkpoint/resume経路・SHAゲート)、`vs_edax.py`、`verify_teacher_corpus.py` の周辺コード読解、`python -m pytest bench/edax-compare/ -q` 実行 → **95 passed**(bench/edax-compare/ 作業ツリーは HEAD=d689dda 時点と同一であることを `git status` で確認)。走行中の生成プロセス・`train/data/teacher/` 配下には一切触れていない。

## 総合判定: **不合格(重大1件)** — ただしデータは無傷、修復は小規模で生成停止も不要

レコード削除・truncate 経路の不在、未指定時の挙動不変性、fail-closed 設計はいずれも仕様どおりで良くできている。不合格理由は1点のみ: **migrate が meta に書く方式境界 `edaxExeBoundary` が、生成再開後の最初の `write_progress()` で meta.json から消える**(下記 [重大-1])。T127j 要件2の「T127c がこの meta から方式境界を機械可読で取れる」が実運用で成立しない。切替は既に実施済み(タスクファイル切替実施ログ 07:1x)のため、ライブ meta の boundary はコード上ほぼ確実に既に失われている。

---

## 指摘一覧

### 重大(ブロッカー)

**[重大-1] `edaxExeBoundary` は生成再開後に meta.json から消滅し、T127c が機械可読で取得できない。さらに migrate 再実行で誤った boundary を書き込む罠がある。**

- 根拠: `migrate_t127j_v3_binary.py::migrate_shard` は `--apply` 時に meta doc のトップレベルへ `edaxExeBoundary` を書く(L314)。しかし `gen_teacher_corpus.py::TeacherCorpusCheckpoint._write_meta`(L1302-1321)は doc を `{schemaVersion, runKey, meta, settings, progress, reusedRecordCount}` から**毎回作り直す**設計で、既存 meta.json の未知トップレベルキーを一切保持しない。`generate_expanded1m_shard` はバンドル完了ごと(L1744)と完了時(L1749)に `write_progress(125_000)` を呼ぶため、再開後数分以内に `edaxExeBoundary` は上書き消滅する。
- バックアップ(`backup-t127j-migration/`)は**移行前** meta のコピーなので boundary を含まない。boundary の正値が残るのは migrate 実行時の stdout と `tasks/T127j-v3-binary-switch.md` の切替実施ログ(s0=61760 … s7=61759、計493,703)のみで、`train/data/teacher/` 内には機械可読な形で残らない。
- 追加の罠: `edax_exe_boundary_for_shard` の冪等性は「既存 meta に boundary が残っている」前提で成立している(L272)。boundary が生成プロセスに消された現状で migrate `--apply` を再実行すると、`existing_boundary=None` → `beforeRecordCount` を**現在の(切替後に増えた)レコード数で再計算**し、誤った boundary を書く。つまり「2回実行しても同一結果」という冪等性の主張は、ライブシステムでは既に成り立たない。テストはこの相互作用(migrate → 生成 resume → meta 再書き込み)を模しておらず、migrate 単体でしか検証していないため見逃された。
- 影響: レコード本体・provenance 実体(settings.edaxExe / meta.edaxExeSha256、下記参照)は無傷。失われるのは方式境界のスナップショットのみで、タスクログとバックアップ時点の `progress.done` から復元可能。
- 修正案(いずれも生成停止不要):
  1. 恒久策: `TeacherCorpusCheckpoint._write_meta` が既存 meta.json の `edaxExeBoundary`(または未知トップレベルキー全般)を read-modify-write で保持するようにする。ただし生成中コードの変更になるため、次の安全な停止点で適用。
  2. 即応策: boundary をシャード meta ではなく**サイドカーファイル**(例: `train/data/teacher/corpus_expanded1m_method_boundaries.json`、git コミット対象)として、タスクログの確定値(s0=61760 … 計493,703、before/after/valuesIdentical/evidence)から生成して保全する。T127c はそこから読む。
  3. いま migrate を再実行して boundary を復元しようとしないこと(上記の罠により誤値が書かれる)。復元するなら確定値の明示注入が必須。

### 中

**[中-1] 実行SHAゲート・resume identity が「実際に使うバイナリ(v3)」のハッシュを守っていない。**

- `PROVENANCE_IDENTITY_KEYS`(gen_teacher_corpus.py L1126-1140)に `edaxExeSha256` が含まれず、runKey にはバイナリ**名**(`edaxExe: "wEdax-x86-64-v3.exe"`)しか入らない。ゲート対象の `edaxSha256` は既定バイナリ(`vs_edax.EDAX_EXE` = wEdax-x86-64.exe)のままなので、**v3 バイナリのファイル実体が差し替わっても resume は素通り**し、meta の `edaxExeSha256` は新しい値で黙って上書きされる。
- タスク仕様の「やらないこと」(EDAX_EXE 定数不変)と plan provenance 凍結の制約下では妥当な妥協であり、バイナリは git 管理下でリスクは低いが、「実行バイナリの同一性を fail-closed で守る」という既存ゲートの精神からは一段後退している。`edaxExeSha256` を `PROVENANCE_IDENTITY_KEYS` に加える(他セットは両辺 None で無影響)ことで塞げる。T127c の manifest 作成時に「全レコード帯の edaxExeSha256 が t127i レポートの検証済み SHA と一致」を確認項目に足すことを推奨。
- 付随: `meta["edaxSha256"]` の意味論が「実際に使った Edax」から「既定バイナリ」へ暗黙に変わった。`verify_teacher_corpus.py` L141 は既定バイナリ照合のままなので合格し続けるが、将来の読者が誤読しうる(settings.edaxExe / meta.edaxExeSha256 の併記が緩和策。コード内コメントには明記されている)。

### 軽微

**[軽微-1] T127i レポート結論節の数値不整合。** 結論(L5)は「exact 1.128x(時間短縮12.7%)」と書くが、本文の速度表・タスクログ・判定はいずれも 11.35%(=1−1/1.1281)。12.7% はどの計算式(speedup−1=12.81%、合計比 −13.5%、残件加重 13.22%)とも一致しない誤記とみられる。≥10% の判定はどの数値でも満たすため結論には影響しない。

**[軽微-2] 残件加重 speedup 1.1524 は件数加重(帯内1件あたり所要時間が等しい仮定)。** 実測サンプルでは level16 帯は 1 親あたり約 6.5 秒 vs exact 帯約 0.28 秒と大差があり、時間加重なら加重値は 1.226 側に寄る(=短縮見積もり 3.21 時間はむしろ保守的)。またサンプルは帯内一様抽出のため、残件が empties 20-29 の重い exact 解に偏る現状の残ワーク構成とは per-record 時間分布が一致しない。両帯とも単独で閾値 10% を超えているため**採用判定自体は加重方法に対して頑健**であり、ETA 精度のみの問題。

**[軽微-3] `test_migrate_shard_module_has_no_jsonl_write_mode_opens` の禁止パターンが不完全。** `open("w"` / `open('a'` / `.truncate(` / `.unlink(` は捕捉するが、`open(mode="w")`・`.write_text(`・`os.remove`・`shutil.rmtree` 等は素通りする。挙動テスト(jsonl byte 不変)が実質を担保しているため軽微。

**[軽微-4] `verify_base_import_integrity` は base 200k 行の生バイトを全件 dict に保持する**(数百 MB 級のピークメモリ)。実運用で完走済みのため実害なしだが、ストリーミング照合(シャード側を並行走査)にすれば O(1) にできた。

**[軽微-5] T127i の A/B ハーネス本体は scratchpad のみでコミットされていない。** タスク仕様上は許容(scratchpad 運用指示どおり)だが、再現はレポートの記述(seed・抽出方式)に依存する。

---

## 観点別所見

### 1. 挙動不変性(edax_exe / edaxExe 未指定時)— 合格

- 配線は3層とも「未指定なら何も渡さない/既定に落ちる」加算形:
  - `CORPUS_SETS[...].get("edaxExe")` → None なら `edax_exe_path=None`(expanded1m 以外のセットにはキー自体が無い)。
  - `label_positions_across_parents` は `edax_exe is None` のとき **kwarg 自体を渡さない**(`solve_kwargs={}`)。旧セット経路(L1454 の `label_position(...)` 呼び出し)・`edax_solve`(L618)は無変更。
  - `edax_solve_batch` → `_edax_solve_batch(..., edax_exe=None)` → `resolved = EDAX_EXE`。コマンド列の変更は `command[0]` の文字列のみで、`-h` 挿入等の副作用なし(差分で確認)。
- テストは自己参照になっていない:
  - `test_default_command_unchanged_when_edax_exe_unspecified` は捕捉したコマンド列を**リテラル期待値**(`"-l" "16" "-n" "1" "-eval-file" … "-book-usage" "off" "-vv"`)と `EDAX_EXE` 定数(差分で不変)に対して固定しており、実装から導出した値との比較ではない。
  - `test_label_position_omits_edax_exe_kwarg_when_unspecified` は**固定シグネチャ `solve_batch(positions, level)` のモック**を使い、もし実装が kwarg を無条件に渡していれば TypeError で落ちる構造。完走自体が「未指定時に kwarg が渡らない」ことの証明になっており、上のコマンド列固定テストと合わせて既存経路のコマンド列不変を実質担保する。
- 留意点(仕様どおりの意図的変更): d689dda の `CORPUS_SETS["expanded1m"]["edaxExe"]` 追加自体は expanded1m の runKey を変えるため、migrate 前の再起動は runKey 不一致で fail-closed に停止する(意図した保護。実際の切替ではランブックどおり migrate → plan 再生成で通過済み)。

### 2. migrate_t127j_v3_binary.py の安全性 — 合格(スクリプト単体として)

- **削除・truncate・jsonl 書き込み経路は存在しない**(全ソース確認)。ファイル書き込みは (a) `backup_shard_files` の `shutil.copy2`(バックアップ方向のみ)、(b) `--apply` 時の `meta_path` への `atomic_write_text` の2箇所のみ。jsonl は常に `open("r"/"rb")`。`start_fresh` 系の呼び出し・`unlink`・`truncate`・上書きモード open は無い。
- fail-closed: base stripe の byte 不一致・行数不足、positionId 重複・plan 外 ID、base レコード欠落、`generatorSha256` 以外の SHA ドリフト、バックアップの部分存在 — いずれも RuntimeError で即停止し、修復・削除は行わない。`--skip-backup`/`--force-backup` は明示フラグでのみ有効。
- バックアップ: apply 前に 16 ファイル、全件既存ならスキップ(移行前コピーを保全する正しい向きの冪等化)。
- 冪等性: meta 書き換え・runKey は2回目以降不変、boundary は既存値維持 — **ただし [重大-1] のとおり、この冪等性は生成プロセスが boundary を消さないという誤った前提に依存**。migrate 単体テスト(18件)は網羅的で様式も migrate_t127h 踏襲だが、checkpoint 再書き込みとの相互作用が検証範囲外だった。
- `settings_and_meta_for_shard` の generatorSha256 差し替えは deepcopy 上のみで plan meta 実体を変更しない(テストで固定済み)。

### 3. provenance 整合 — 条件付き(重大-1 と 中-1 のとおり)

- 再開後も**毎起動で** `settings.edaxExe` と `meta.edaxExeSha256`(v3 実 SHA)が `_expanded1m_settings_and_meta` により再記録され、checkpoint の meta 再書き込みでも保持される。切替後レコードのバイナリ同一性は meta から機械可読で取れる。SHA ゲートの `edaxSha256`(既定バイナリ)は plan provenance と整合し、resume ゲートは設計どおり通る(実地でも通過済み)。
- しかし**方式境界(どこまでが旧バイナリか)は [重大-1] により meta から消えており、T127c は現状の meta だけでは境界を取得できない**。復元材料はタスクログの停止時件数とバックアップ meta の `progress.done` にある。T127c 着手前にサイドカー化または meta への再注入(確定値明示)が必要。

### 4. A/B レポート(t127i_edax_v3_ab_report.md)の妥当性 — 概ね妥当

- **re.match バグの「比較結論には影響しない」論法は正しい。** 汚染の経路になり得るのは (a) 既存 corpus レコードの値の参照(していない: 3アームとも都度独立に Edax を実行)、(b) 生成済みか否かがアーム間で非対称に効くこと(あり得ない: 同一組を全アームが処理するペア設計+順序ローテーション)のみ。生成済み 50/144 親の混入が変えるのは「母集団が残件ではなく plan 全量になった」ことだけで、値一致・決定性・ペア速度比の内的妥当性は保たれる。外挿用の残件数を `re.search` 版で再集計し直した対処も適切。残る影響は [軽微-2] のとおりサンプルの帯内構成が残ワークと一致しない点で、ETA 精度のみに波及する。
- 値一致判定は帯別・サンプル全件(exact 772 / level16 1,528 子、bestMove 144 親)で、score 差と bestMove 差を区別して報告。決定性も帯別に rep0/rep1 比較で報告。`-n 2` の level16 不一致(67/1,528)・非決定性(12/764)の検出は仕様の懸念をそのまま実証しており、不採用判定は妥当。exact 帯限定 `-n 2` を「v3 単独より利得小」で見送る論理も、v3+n2 の重ね合わせを未計測として上乗せしない方針(T127g 踏襲)と整合。
- 速度判定はペア比の幾何平均+アーム順ローテーション(CPU 競合下の妥当な設計、T127g 方式)。判定式(全件一致かつ10%以上)は両帯とも満たす。なお「全帯・全件一致」は本質的にサンプル上の全件であり 1M 全量の悲観保証ではないが、同一バージョンのビルド違いという事前知識と合わせれば判定材料として十分。
- 欠点は [軽微-1] の結論節の数値誤記のみ。

---

## 結論と推奨アクション

1. **[重大-1] のフォローアップを T127c 着手前に実施する**(生成停止不要): 確定値(s0=61760, s1=61608, s2=61831, s3=61655, s4=61795, s5=61625, s6=61670, s7=61759, 計493,703)からの boundary サイドカー作成、または次の安全停止点での checkpoint 側キー保持+meta 再注入。**現状のまま migrate --apply を再実行して復元しようとしないこと**(誤った beforeRecordCount が書かれる)。
2. [中-1]: `edaxExeSha256` の identity キー化、または T127c の manifest 検証項目への追加。
3. [軽微-1]: レポート結論節の 12.7% → 11.35% の訂正(1行)。
4. 上記以外(挙動不変性・migrate の安全設計・A/B 方法論)は合格水準であり、実施済みの切替自体を巻き戻す理由は無い。

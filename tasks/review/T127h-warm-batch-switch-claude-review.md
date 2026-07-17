# T127h 代替最終レビューレポート(Claude、Codex上限中の代替)

- 対象: フェーズ1 `68dbfa6`(`gen_teacher_corpus.py` / `test_teacher_corpus.py`: 親またぎバッチモード 32親/束)+ フェーズ2 `cbd210e`(`migrate_t127h_warm_batch.py` / `test_migrate_t127h_warm_batch.py`)+ 実施結果(migration適用・plan再生成・resume再開)の通しレビュー
- 前提資料: `tasks/T127h-warm-batch-switch.md`(作業ログ・A/B結果)、`tasks/review/T127h-warm-batch-switch-codex-review.md`(フェーズ1のみ対象・migration不在で不合格 → その不足は本レビュー対象のフェーズ2で解消)
- レビュー方法: 両コミットの差分精読 + 現行コード(HEAD `eb33540`、`git diff 68dbfa6..HEAD` で生成器・vs_edax無変更を確認)+ **走行中の実データ・ログの実地検証**(下記)+ テスト再実行(`test_teacher_corpus.py` 34件 + `test_migrate_t127h_warm_batch.py` 16件 = 50 passed)
- レビューによるコード変更・コミット: なし

## 総合判定: **合格**(重大指摘なし。生成は止めなくてよい)

codex-reviewのブロッカー(migration不在・resume不能)はフェーズ2+plan再生成で解消済みであることを実地で確認した。走行中の生成に対する取り返しのつかない欠陥は検出されなかった。

---

## (a) 重大(ブロッカー) — なし

## (b) 中

### 中-1: fallback経路が「全親の個別実行成功」まで1件もcheckpointしない(codex-review (b)1 と同一、未修正のまま走行中)

`gen_teacher_corpus.py` の `checkpoint_expanded1m_parent_bundle()`(1617-1637行)は、束失敗時のfallbackで32親分を**リスト内包で全件 `label_position()` してから**まとめてappendする。fallback中に1親でも失敗すると、(1) 先に成功した個別実行の結果が全て失われ、(2) 例外が `generate_expanded1m_shard()` へ伝播して**当該シャードプロセスが停止**する。

- **データ破壊ではない**: 未appendのままなので、resume時に `done_ids`(jsonl実体から再構築)に含まれず再生成される。損失は最大1束(32親≒数分の計算)+ シャード再起動の手間に限定。
- 旧方式でも `label_position()` の失敗はシャード停止だったため、後退しているのは「束内の他の親を巻き込む」点のみ。
- **推奨**(次の軽タスクで可、生成停止不要): fallbackループを「1親 label → 即 `checkpoint.append` → 次の親」に変更し、途中失敗テストを追加する。実装変更後は再開時にrunKeyへ影響しないこと(settingsは不変)を確認のこと。ただし `generatorSha256` ゲート(selection plan provenance)には触れるため、**修正を入れるなら再開手順(plan provenance更新)とセットで計画する必要がある**。走行が順調(現時点でfallback発生0)なら完走後の適用でよい。

## (c) 軽微

1. **移行後metaの `elapsedMsPolicy` が切替前レコードにも遡及適用される**: 既存292,679件の `elapsedMs` は実際には旧方式(親単位バッチ平均)で計測された値だが、meta上は全件 `cross-parent-level-batch-averaged` と記述される。`elapsedMs` は診断用メタデータでありラベル値(value/diffFromBest/bestMove)には無関係。また方式境界(292,679件=切替点、シャード別内訳)は作業ログ・STATUS上の記録のみで、meta.json内に機械可読な形では残っていない(仕様§6の「manifest用の仕込み」はログ表として充足)。将来のmanifestタスクで、runKeyに影響しないトップレベルフィールド(`reusedRecordCount` と同様の扱い)として方式境界を書き込むことを推奨。
2. **削除経路なしのソースレベルテストはヒューリスティック**: `test_migrate_shard_module_has_no_jsonl_write_mode_opens` は `open("w"/"a")`・`.truncate(`・`.unlink(` の文字列不在のみ検査し、`Path.write_text`・`os.replace`・`shutil` 系は対象外。ただしコード精読で jsonl への書き込みAPI呼び出しが一切ないこと(書くのは `atomic_write_text(meta_path, ...)` のみ)を確認し、実適用後の `cmp` によるbackupとのbyte一致確認(作業ログ)もあるため、多層防御として十分。
3. **backupの冪等スキップは鮮度を見ない**: `backup_shard_files()` は16ファイル全部が存在すれば内容が古くてもスキップする。一回限りの移行スクリプトとしては問題ないが、将来再利用する場合は注意。
4. `count_and_validate_shard_records()` の引数 `plan_meta_provenance_ready` が未使用(デッドパラメータ)。
5. `main()` はシャードkのmeta書き換え後にシャードk+1を検証するため、途中失敗時は前半シャードのみ移行済みの中間状態になる(meta のみ・backupあり・再実行で収束するため実害なし)。
6. マイクロベンチ(8/16/32親、各30親、値不一致0)の生データは `%TEMP%` のみでリポジトリ未保存(codex-review (c)2 と同一)。数値は作業ログと `CORPUS_SETS` コメントに記録済み。
7. `edaxParentsPerProcess` の値域検証なし(codex-review (c)1 と同一。現状は定数32のため実害なし)。

---

## 重点観点ごとの確認結果

### 1. 束処理の正しさ — 問題なし

- **親子対応付けの構造**: `label_positions_across_parents()` は `(parent_index, child_index, child)` のタプルでlevel別バッチに積み、結果を `states[parent_index][4][child_index]` に書き戻す。インデックスはPython側で閉じており、Edax出力との対応は `vs_edax._parse_edax_batch_output()` が `problem # N` をOBF行番号1..Nと**完全一致検証**(欠落・重複・順序ずれで即バッチ全体失敗)するため、親と子の値の取り違えは「静かに」は起きない構造。件数assert・未充填assertも維持。
- **符号変換**: `side = parents[parent_index][1]["sideToMove"]` で親ごとの手番を引き直しており正しい。終局子も親ループ内で親のsideを使用。
- **best/diffFromBest**: 親ごとに算出。`max` の同値タイブレークは子の並び順依存だが、束化でも親内の子順序は完全に保存されるためcoldと同一。テスト `test_cross_parent_batch_matches_cold_values_and_aggregates_by_level` がcold/batchedの完全一致とlevel別集約(2親→exact/level16各1呼び出し)を固定。
- **fallbackの完全性**: 束失敗を `except Exception` で捕捉(KeyboardInterruptは素通し=正しい)し、**checkpoint append前に**親単位の `label_position()` へ切替。全親成功なら全件plan順にappendされる。不完全なのは「fallback中の途中失敗」ケースのみ(中-1)。

### 2. ラベル値の同一性 — 問題なし(構造的保証+実測証跡の整合を確認)

- **Edax呼び出しパラメータの同一性**: cold/束とも同じ `edax_solve_batch()` → `-solve <obf> -l <level> -n 1 -eval-file ... -book-usage off -vv`。違いはOBFの局面グルーピングのみ。**旧方式も既に1親の全子を1プロセス・共有TTで解いていた**ため、「同一プロセス内のTT持ち越し」は新規の性質ではなく、束が親をまたぐようになっただけ。
- **exact帯(level 60)**: 理論値なのでTT状態に非依存。加えて `depth >= child_empties` を満たさないexact結果は `RuntimeError` で即停止(fail closed)するため、仮にTT起因の異常があっても「クラッシュ」であり「誤ラベルの静かな混入」にはならない。
- **level16帯**: 構造的保証はなく実測依存だが、証跡は整合している: T127g A/B(80親・子624件、cold vs warm 不一致0、各arm 2回実行で決定性も全一致、`-n 1`固定)+ T127hマイクロベンチ(8/16/32親×各30親=90親、採用サイズ32を含め値不一致0)。T127fで `-h 24`(hash拡大)は値・速度とも不採用と判定済みで、本実装はhash指定なし=A/Bの `warm` armと同構成。
- 束サイズ32はT127g(2親)より大きいが、32親そのものがマイクロベンチで値一致確認済み。

### 3. checkpoint/resumeの堅牢性 — 問題なし(実地確認済み)

- **束途中クラッシュ**: 束は全親分をメモリ上で確定してから1レコードずつ `append`(write+flush+fsync)する。append途中のクラッシュは「束の前半だけjsonlにある」状態になるが、resumeの `try_resume()` は **meta.progressではなくjsonl実体から `done_ids` を再構築**し、途中の不完全行はvalid末尾でtruncateするため、未書き込み親だけが再生成される。二重生成の経路はない(todoは `is_done` でフィルタ、planの一意性はmigrationの重複検査でも裏取り済み)。
- **実地検証**: 8シャードのログで `[resume] loaded` 件数の合計が **36672+36520+36583+36631+36547+36601+36518+36607 = 292,679** となり、migration時のjsonl実カウントと完全一致(malformed 0)。フィードバック記載の292,580が概算だった件も作業ログの説明(meta.progressは周期スナップショット)どおりで、resume設計上問題ないことを確認。

### 4. migration — 問題なし

- **削除経路なし**: `migrate_t127h_warm_batch.py` 全体でjsonlは `open("r"/"rb")` のみ。書き込みは `atomic_write_text(meta_path, ...)` の1箇所だけ。バックアップは `shutil.copy2`(読み→別ディレクトリ書き)。`unlink`/`truncate`/`write` モードのopenは不在(ソースレベルテストで固定、限界は軽微-2のとおり)。
- **fail closed**: base stripe(先頭25,000件)の `corpus_expanded200k.jsonl` とのbyte一致検証・positionId重複・plan外ID・base欠落・generatorSha256以外のSHAドリフト・部分backupの上書き、いずれも `RuntimeError` で停止し修復や破棄をしない。T114堅牢化の流儀に忠実。
- **冪等性**: テスト(2回apply・runKey不変・jsonl byte不変)+ 実データで2回applyし `runKeyChanged=False`・`cmp` 全シャードbyte一致(作業ログ)。
- **順序**: backup → 検証 → meta書き換えの順で、backupが検証より先(壊れていてもまず保全)なのは適切。

### 5. runKey/provenance整合 — 問題なし(運用も妥当、実地確認済み)

- 旧方式runKey(フィールド無し)は完全一致スナップショットテストで固定。新方式は `edaxParentsPerProcess`+`elapsedMsPolicy` の2フィールド追加で明確に区別され、未移行metaに対する新コードのresumeはT114由来のrunKey不一致ゲートで**切り詰めなしのエラー停止**になる(黙って壊す経路なし)。
- **plan再生成の決定性検証を実地で確認**: 現在の `corpus_expanded1m_selection_plan.meta.json` の `provenance.incrementalGeneration.generatorSha256` は現行 `gen_teacher_corpus.py` のSHA(`7aceaeea…`)と一致し、`selectionPlanSha256`(`2f264512…`)・`shardPlanSha256[i]` は実ファイルSHAおよび**migrationが書き込んだ各シャードmetaの値と一致**。つまり再生成planは旧planとSHA同一(決定性成立)で、仮に非決定だった場合もrunKey/plan SHAゲートでresumeが止まる設計だった。フェーズ2ワーカーがplan書き換えをスコープ外として報告に留めた判断(厳守事項の遵守)も適切。
- migrationの `settings_and_meta_for_shard()` はメモリ上のdeepcopyにのみ `generatorSha256` を差し替え、実plan metaへの書き戻しなし(テストで入力不変を固定)。

### 6. 現在走行中の生成に対する残存リスク — 重大なし

実地確認(本レビュー中): 8シャード全てが新runKey(`edaxParentsPerProcess=32`)で走行、progressはレビュー中にも前進(例: shard0 36,672 → 37,056)、全ログで fallback WARNING 0件・エラー0件。残存リスクは以下のみ:

- **中-1**(fallback途中失敗で束の成功分ごと消える+シャード停止): 損失は有界・resume安全。発生してもデータは壊れない。
- level16帯の値同一性は32親規模の実測(90親+T127g 80親)に依拠(構造的証明はない)— 証跡の範囲・決定性確認は十分で、追加の懸念材料なし(軽微扱い)。
- 1束=最大2プロセスで束全体が1プロセス障害の影響を受けるが、fallbackで親単位実行に退避するため全滅しない。

## 申し送り(done後の扱い)

- 中-1のfallback逐次checkpoint化は、走行完走後(またはやむを得ず停止する機会があれば同時に)軽タスクで適用を推奨。適用時はplan provenance(`generatorSha256`)の更新手順とセットで。
- 軽微-1(方式境界のmeta内機械可読記録)はmanifest整備タスクへ。

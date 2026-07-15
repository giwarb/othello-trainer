# T090a 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

1. **各合法手の「bestとの差」が保存されていない**

   仕様は全合法手について teacher value に加え「各手の best との差」を保存するよう要求している。しかし [gen_teacher_corpus.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:411) の子レコードには `value`、`exact`、`level`、`edaxDepth`、`elapsedMs` しかなく、`bestValue - value` に相当するフィールドがない。スキーマにも定義されていない。

   ローカルの smoke/primary 実データも同様で、50,000局面を含め仕様上未完成である。値から後処理で導出可能ではあるが、「保存」という明示要件を満たしていないため、スキーマと既存コーパスの補正が必要。

2. **機械検証が「全合法手分あること」を実際には検証していない**

   [verify_teacher_corpus.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/verify_teacher_corpus.py:68) は `children` が空でないことしか確認しておらず、局面から合法手集合を再計算して `children[].move` と照合していない。docstringに記載された `legalMoveCount` との比較も実装されていない。

   さらに以下も成功扱いになる。

   - コーパスファイルが存在しない場合、`SKIP`して `(0, 0)` を返し、終了コード0になる（同:44）。
   - malformed JSON行は表示してスキップするだけで `errors` に加算しない（同:61）。
   - metaの期待件数とレコード数が違っても `NOTE` のみでエラーにしない（同:126）。
   - positionIdの欠番や期待範囲も検証しない。

   実際に `python bench/edax-compare/verify_teacher_corpus.py smoke primary` は51,000件・0 errorで終了したが、この結果は受け入れ基準の「全レコードで全合法手分」「完全な件数」を保証していない。受け入れ検証が未成立である。

3. **X/C局面の別層確保とopening単位の過剰抽出制限が未実装**

   [select_positions()](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:366) は `engineLoss` 優先層とphase binだけで配分している。`hasXcLegalMove` は記録されるだけで、X/C層のquota、別抽出、最低件数保証のいずれにも使われていない。「実測で多かったため別層化しない」は、明示された要件を変更する判断であり、仕様準拠とはならない。

   また [teacher_candidates.rs](/C:/Users/yoshi/work/othello-trainer/train/src/bin/teacher_candidates.rs:343) は1対局あたりの上限を実装しているが、同一openingを識別・集約するキーやopening単位の上限はない。規範設計書の「各opening・対局からの過剰抽出を制限」を半分しか満たしていない。

4. **git hash変更時にcheckpointを拒否しない**

   `gitCommit` はmetadataに記録されるものの、[PROVENANCE_IDENTITY_KEYS](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:490) に含まれていない。したがってコード・バイナリ・入力のhashが偶然同じでgit commitだけが変わった場合、同じcheckpointをresumeする。

   これは「設定・Edax binary hash・git hashが変わったら別run keyとして既存checkpointを拒否」という明示要件に反する。実データのprimary metadataも `gitCommit=fe074d0...` で、レビュー対象の最終コミット `715ef8e...` ではない。個別ファイル・バイナリhashは現在値と一致しているため直ちに教師値が誤っている証拠ではないが、要求されたprovenance契約は成立していない。

5. **コミット対象とされたmanifest・smoke統計がコミットされていない**

   `715ef8e` に含まれるT090a成果物は生成・検証スクリプト、Rustバイナリソース、依存変更だけである。件数、層別内訳、provenance hash、生成コマンドを記録したコミット済みmanifestや、コミット済みsmoke統計ファイルは存在しない。ローカルの `corpus_*.meta.json` と `train/data/teacher/README.md` は `.gitignore` 対象である。

   コミットメッセージは詳細を `tasks/T090a-teacher-corpus.md` に参照させているが、作業ログの追加は対象コミットに含まれず、現在も `git status --short` に `M  tasks/T090a-teacher-corpus.md` が残っている。よって以下の受け入れ条件が未達である。

   - manifest・smoke統計をコミット
   - Actions成功確認の記録
   - タスク由来の差分がworktree/indexに残っていないこと

## (b) 中（次タスクで対応すべき）

1. **クラッシュ時のJSONL末尾復旧が不完全**

   [try_resume()](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:539) はmalformed行を無視するが、ファイルからその行を切り詰めない。その後appendすると、改行前で途切れたJSONの直後に次レコードが連結され、次の正常レコードまでmalformed行の一部になる可能性がある。末尾の最終有効オフセットまでtruncateしてから再開すべきである。

2. **`exact` が探索結果ではなく投入条件だけで決まる**

   [label_position()](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:428) は `childEmpties <= 24` なら無条件に `exact=True` とする。検証器も `level == 60` しか確認せず、`edaxDepth` が残り空き数に達したことなどを検証しない。今回確認したサンプルでは深さと空き数は整合しているが、「完全読みできたもの」という契約を将来も守るには探索結果による確認が必要。

3. **シャードmergeが各シャードのprovenance/settings一致を検証しない**

   [merge_shards()](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:803) はpositionIdの重複・欠落は検出するが、各metaのrun key、入力hash、Edax hash、候補選定設定が一致するか確認せず、先頭シャードのmetadataだけを採用する。異なるrunのシャードファイルが同名で残っていた場合、IDが揃えば混在コーパスを生成できる。

4. **新規パイプラインの自動テストがない**

   phase配分、D4のPython/Rust一致、パス局面の符号、checkpoint末尾破損、provenance拒否、シャードmerge異常系などは重要な分岐だが、コミットされた自動テストがない。作業ログ上の手動検証だけでは今後の回帰を検出できない。

## (c) 軽微（記録のみ）

- `teacher_candidates.rs`のコメントはphase binを「0..6」と記載しているが、実値は6区分の`0..5`。
- `_self_test_canonicalize()`に未使用の`black0`、`white0`があり、テスト内容も同じ入力を2回計算して一致を見る部分はD4変換の独立検証になっていない。
- source固有フィールドについてスキーマは「該当sourceの場合のみ」と説明するが、実データでは非該当時も `null` として出力される。T090bが読む契約としてどちらかに統一した方がよい。
- コミットタイトルに `engine` が含まれるが、対象差分に `engine/` の変更はない。

## (d) 総合判定

**不合格**

smoke 1,000局面とprimary 50,000局面のローカル生成物は存在し、記録された生成スクリプト・teacher_candidates・Edax・eval.datのSHA-256は現在の実体と一致している。教師値の符号処理も既存same-root oracle方式と整合し、D4重複や `bestValue=max(children)` については実データ上の異常を確認しなかった。

しかし、必須のbestとの差がコーパスにない、X/C別層とopening制限が未実装、git hashによるcheckpoint拒否がない、機械検証が全合法手・完全性を保証していない、manifest・smoke統計がコミットされていない、という複数の明確な仕様未達がある。特に現在の「51,000件・0 error」は受け入れ基準を証明する検証結果ではないため、これらを修正して再検証するまでdoneにはできない。
# 最終レビューレポート — T127a

対象: `git diff 41bcee7..d0f68da` / `git log 41bcee7..d0f68da`

## (a) 重大（doneを止めるブロッカー）

該当なし。

redo #1の主要ブロッカーだった実行環境SHA検証は修正されています。[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1493)でgenerator、`teacher_candidates.exe`、Edax、eval.datのSHAを実ファイルから再計算し、selection plan記録値との不一致を生成・resume前に拒否しています。

childrenバッチの返却件数も、`zip()`処理前に一致確認されるため、サイレントなレコード欠落は防止されています。

## (b) 中（次タスクで対応すべき）

### 1. redoで必須指定されたK=1の「SHA一致」自動テストが実装されていない

[teacher_candidates.rs](C:/Users/yoshi/work/othello-trainer/train/src/bin/teacher_candidates.rs:525)に追加されたテストが検証するのは、`wanted=1`における乱数呼び出し結果と次のRNG状態だけです。

以下は自動テストされていません。

- 合成WTHOR入力に対して`extract --per-bin-cap 1`を実行すること
- 既定値省略時と明示的なK=1の出力が一致すること
- 従来形式のJSONに余分なフィールドが追加されないこと
- 候補順、JSONシリアライズを含む最終出力SHAが固定値と一致すること

したがって、JSONフィールド、候補順、CLI既定値、シリアライズ形式が将来変化しても、現在のRust単体テストは通過します。

作業ログには実データによるSHA一致が記録されていますが、redo #1は明示的に「K=1互換（SHA一致）を外部実データに依存しない合成fixtureの自動テストで固定」と要求しています。この必須項目は未達です。

### 2. 合成選定テストがwaterfallの具体的なbin配分を固定していない

[test_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/test_teacher_corpus.py:662)の合成選定テストは、最終件数、XC quota、opening cap、重複・base・oracle除外を確認していますが、`finalBinAllocation`と`incrementalBinAllocation`の具体的な期待配列を検証していません。確認しているのは各配列の合計だけです。

このため、waterfall配分アルゴリズムが別の配分へ回帰しても、件数とquotaが成立する限りテストが通る可能性があります。redo #1で必須指定された「bin配分の自動テスト固定」としては不足しています。

## (c) 軽微（記録のみ）

### 1. コミット範囲全体の`git diff --check`が失敗する

`git diff --check 41bcee7..d0f68da`は、[T127a-corpus-1m-infra.md](C:/Users/yoshi/work/othello-trainer/tasks/T127a-corpus-1m-infra.md:4)の追加行に対して多数のtrailing whitespaceを報告します。実装4ファイルだけに限定した`git diff --check`は成功します。

実行時コードへの影響はありませんが、作業ログの「`git diff --check`: PASS」はレビュー対象範囲全体には当てはまりません。

### 2. verifier強化は妥当

[verify_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/verify_teacher_corpus.py:87)では次をmanifestの自己申告だけに依存せず検証しています。

- 固定1,000,000件とreuse 200,000件
- expanded200k本体・manifestの固定SHA
- 先頭200,000件のバイト一致とprefix SHA
- candidate pool、master plan、8 shard plan、generator、tool、Edax、eval、oracleの実ファイルSHA
- `baseCorpus` / `incrementalGeneration`の2層provenance

この修正に新たな正しさ上の問題は確認できませんでした。

### 3. streaming処理は設計に沿っている

mergeはpositionId順のk-way streaming merge、テンポラリファイルへのfsync後のatomic replaceとなっています。verifierも500件単位で処理し、全レコードを保持しません。シャードはmerge後も削除されません。

`git status --short`は空でした。

なお、read-onlyレビュー環境のためテストスイートは再実行せず、作業ログ記載の結果とコード・テスト内容を照合しました。

## (d) 総合判定

**不合格**

redo #1の実行環境SHAブロッカー、children件数検査、verifier独立検証は適切に修正されています。K=4選定、base包含、2層provenance、selection plan、streaming merge/verifierの主要実装にも新たなブロッカーは確認できません。

しかし、redo #1で必須指定された自動回帰テストのうち、K=1の出力SHA一致とwaterfallの具体的bin配分が固定されていません。手動probeと実データSHA確認だけでは、要求された将来の回帰防止を満たしません。

合成fixtureによるK=1 extract出力の固定SHAテストと、合成選定fixtureに対するbin配分の期待配列assertを追加したうえで、再レビューが必要です。
# T090a 最終レビューレポート

対象: `d732c0c..ffa3256`

## (a) 重大（doneを止めるブロッカー）

なし。

redo #2で要求された以下を確認した。

- WTHOR全レコードへの`openingKey`付与、engineLossへの`null`付与
- smoke、primary、primary全8シャードのSHA-256更新と一致
- child空き数24を境界とするexact/level規則の全件検証
- Rust正本による`canonicalKey`再計算、保存値照合、D4重複検出
- 必須フィールドとsource固有null契約の検査
- 指定された破損パターンのnegative test追加
- manifestのLF再出力

ローカルのコーパスに対して厳密検証を再実行し、次の結果を確認した。

```text
[smoke] verified 1000 record(s), 0 error(s)
[primary] verified 50000 record(s), 0 error(s)
TOTAL: 51000 record(s) verified, 0 error(s)
```

manifest記載のSHA-256は、smoke、マージ済みprimary、primary全8シャードの実ファイルとすべて一致している。

## (b) 中（次タスクで対応すべき）

なし。

## (c) 軽微（記録のみ）

- [finalize_teacher_corpus.py:174](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/finalize_teacher_corpus.py:174)が、smoke manifestにも`"primary merged file is authoritative; all shard JSONL files were synchronized"`というprimary専用の`shardPolicy`を出力している。実際に[corpus_smoke.meta.json:145](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/teacher_manifests/corpus_smoke.meta.json:145)にも記録されている。smokeにはシャードがないため記述として不正確だが、コーパス内容、検証結果、provenanceには影響しない。

## 検証上の補足

- `git diff --check d732c0c..ffa3256`および`git show --check ffa3256`は成功。
- manifest 2件はCRLF 0件で、LFのみ。
- コーパスJSONLは`.gitignore`の`train/data/`規則によりすべて除外されている。
- `ffa3256`は`origin/main`に含まれ、作業ツリーはclean。
- `test_teacher_corpus.py`は、このレビュー環境がread-onlyで一時ディレクトリを作成できないため独立完走できなかった。失敗は全て`tempfile.TemporaryDirectory()`の生成拒否による環境要因であり、テスト対象ロジックの失敗ではない。追加テストの内容はコードレビューし、作業ログ上では8件成功が記録されている。

## (d) 総合判定

**合格**

redo #2のブロッカーはすべて解消されている。51,000件についてexact規則、canonicalKey、D4重複、合法手集合、best/diff、スキーマ契約が実データ上で0エラーとなり、manifestのハッシュも全成果物と一致した。指摘はsmoke manifestの説明文だけであり、doneを妨げる正しさ・回帰・仕様乖離は認められない。
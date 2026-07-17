# 最終レビューレポート — T127a

## (a) 重大（done を止めるブロッカー）

### 1. expanded1m の resume 時に、実行環境の SHA が検証されない

[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1493) の `_expanded1m_settings_and_meta()` は、generator、`teacher_candidates.exe`、Edax、eval.dat の SHA を現在のファイルから再計算せず、selection plan meta に保存された値をそのまま現在値として checkpoint に渡しています。

具体的には以下です。

- `harnessSha256 = incremental["generatorSha256"]`
- `teacherCandidatesToolSha256 = incremental["teacherCandidatesToolSha256"]`
- `edaxSha256 = incremental["edaxSha256"]`
- `edaxEvalDataSha256 = incremental["edaxEvalDataSha256"]`

一方、実際の children 計算と Edax ラベル生成は現在の実行ファイルを使用します。[generate_expanded1m_shard()](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1586) も shard plan の SHA しか検証しておらず、上記実行物の現在 SHA を検証していません。

そのため、selection plan 確定後または生成途中に次のいずれかが変更されても resume が拒否されません。

- `gen_teacher_corpus.py`
- `teacher_candidates.exe`
- Edax executable
- eval.dat

既存 checkpoint と今回構築する「current meta」の双方に古い保存 SHA が入るため、`TeacherCorpusCheckpoint.try_resume()` の provenance identity 比較は一致してしまいます。結果として、異なる generator/tool/Edax によるレコードが同じコーパスへ混在し、meta には古い SHA が記録され続けます。

これは規範設計の以下に直接反します。

- generator/candidate tool/Edax/eval の SHA を provenance と run identity に含める
- 生成期間中の生成コード・実行バイナリを凍結する
- provenance 不一致時は厳格に resume を拒否する
- 約41時間の生成を安全に中断・resumeできること

T127b 本番生成を開始する前に、worker 起動時ごとに現在の generator、teacher tool、Edax、eval.dat の SHA を再計算し、selection plan provenance と照合して不一致なら即時停止させる必要があります。resume の identity に渡す値も保存値ではなく現在の実測値にすべきです。この経路を検証する回帰テストも必要です。

## (b) 中（次タスクで対応すべき）

### 1. K=1互換性と expanded1m 選定の主要制約が自動テストで固定されていない

実装ログには、K=1候補340,531件と既存候補JSONの SHA 完全一致という有力な手動検証があります。しかしコミットされたテストには、次を直接検証するものがありません。

- `--per-bin-cap=1`で従来の乱数消費順と候補列が不変
- base の phase/XC/opening カウントを含む最終union制約
- 成功ケースでのwaterfall配分
- opening capとX/C 50%の同時充足
- incrementalとbase/oracleのcanonicalKey非重複

追加テストは設定値の確認と空候補でのtarget未達確認が中心で、選定アルゴリズムの正しさを固定できていません。[test_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/test_teacher_corpus.py:579)

現在の実測結果自体は仕様を満たしていますが、「K=1回帰テストで固定」という受け入れ条件と将来の回帰防止の観点では不足しています。

### 2. expanded1m verifier が固定された1M/base provenanceを独立に検証していない

[verify_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/verify_teacher_corpus.py:141) はストリーミング化され、prefix の行単位一致も検査しますが、以下をmetaから信頼しています。

- `progress.total`
- base corpus の期待SHA
- `baseCorpus` / `incrementalGeneration`の内容

`expanded1m`で総数が必ず1,000,000件であること、base が必ず200,000件で既知の固定SHAであること、selection plan SHAなどのprovenance値が実ファイルと一致することは検証していません。現状は二層provenanceがdictであるかを見るだけです。

T127cで独立検証を拡張する予定ではありますが、T127aの「base 200k prefixの完全一致検証（SHA）とprovenance 2層」の verifier としては検証が弱いため、T127b生成前または遅くともT127cで固定値・実ファイルとの照合を追加すべきです。

### 3. children バッチの返却件数不足を即時検出しない

expanded1m worker は次の処理をしています。

```python
children_batch = run_children_batch(positions_batch)
for position, children_info in zip(positions_batch, children_batch):
```

通常経路にある件数一致 assertion が expanded1m 経路にはありません。[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1636)

children tool が異常終了せず短い配列を返した場合、該当局面は未処理のまま後続バッチへ進み、約41時間後のmerge件数検査まで失敗が判明しない可能性があります。長時間処理の安全性のため、各256件バッチ直後に入力件数との完全一致を検査して即時停止すべきです。

## (c) 軽微（記録のみ）

該当なし。

## テスト・差分確認

- 対象コミットは `c574b0e` の1件で、変更対象は仕様どおり4ファイルです。
- `git status --short`は空で、当該タスク由来の未コミット差分・未追跡はありません。
- `git diff --check 41bcee7..c574b0e`は成功しました。
- レビュー環境で `python -B bench/edax-compare/test_teacher_corpus.py` を試行しましたが、read-only sandboxによりPythonが一時ディレクトリを作成できず、27件中tempfileを使う16件が環境要因で実行不能でした。コード由来のassert失敗は確認されていません。作業ログ記載の実装時テスト成功結果とは矛盾しません。

## (d) 総合判定

**不合格**

K=4抽出、base 200k包含、親でのselection plan確定、最終unionに対するwaterfall/XC/opening選定、ストリーミングmerge/verifier、probe実測など、主要設計は概ね正しく実装されています。

しかし、expanded1m workerが現在のgenerator/tool/Edax/eval SHAを検証せず、保存済みSHAを現在値としてresume判定へ渡す問題は、本番の長時間生成で異なる生成物を混在させ、provenanceまで誤表示し得ます。T127aの中核である安全な本番生成基盤を損なうため、doneおよびT127b開始を止めるブロッカーです。
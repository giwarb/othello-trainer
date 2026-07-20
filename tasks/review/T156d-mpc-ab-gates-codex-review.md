# 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### 1. canonical SHA-256 検証が到達不能で、fail-closed になっていない

[compare_mpc.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:113) の `validate_checkpoint()` は `return` した直後に、Gate 2 corpus、oracle positions、oracle labels、v4 weights の canonical SHA-256 検証を記述しています。

したがって [114行目以降](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:114) は一切実行されません。`validate_inputs()` 側にも同等の検証はありません。

この状態では、例えば以下でも集計まで通過できます。

- oracle labelsを改変し、ID・empties・`corpusSha256`だけ整合させる
- 別weightsでcheckpointを再生成し、そのweightsを`--pattern-weights`に渡す
- 別corpusでcheckpointと入力ファイルを揃える

checkpoint内のFNV fingerprintと指定ファイルの一致は検査されますが、それがタスク指定のcanonical corpus/v4 weightsであることは保証されません。特にoracle labelsはcheckpointに結び付かないため、改変された評価値でregretを再計算できてしまいます。

コミット済みmetaに記録されたSHA-256は、今回に限ればコード内の期待値と一致しています。しかし、これは生成時に機械検証された結果ではなく、レポートの「fail-closedで検証済み」という主張を裏付けません。

redo #1の中心要件である「指定canonical入力から外れた場合は集計せずエラー終了」を満たさないため、ブロッカーです。

修正としては、4件の `require_equal(digest(...), EXPECTED_...)` を `validate_inputs()` の到達可能な先頭部分へ移し、各canonical入力を1バイトでも変更すると拒否される回帰テストを追加する必要があります。

## (b) 中（次タスクで対応すべき）

なし。

canonical検証以外については、以下が適切に実装されています。

- Gate 2/3のconfig・policy・schema検査
- 全10 checkpointの対象ID集合検査
- `maxPositions`と選択ID fingerprintによるresume条件固定
- checkpoint・oracle regretの重複拒否
- exact node会計と構成間偏り検査
- metaへのconfigとレコード集合サマリ保存
- 4石lossについて設計基準と初版の厳格基準を併記

## (c) 軽微（記録のみ）

### 1. canonical入力拒否とresumeの自動回帰テストがない

[test_compare_mpc.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/test_compare_mpc.py:33) の9テストはconfig、選択ID fingerprint、重複、exact会計などを確認していますが、`validate_inputs()`へ改変canonicalファイルを渡すテストがありません。このため、今回の到達不能コードを検出できませんでした。

Rust側の選択ID fingerprintテストもハッシュ関数の性質を確認するだけで、既存checkpointに異なる `--max-positions` を指定したresume拒否を直接テストしてはいません。作業ログにはsmoke実行が記録されていますが、今後の回帰防止には統合テスト化が望まれます。

### 2. 再現説明のcheckpoint数が誤っている

[t156_mpc_gates_report.md](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t156_mpc_gates_report.md:91) は「same eight checkpoints」としていますが、実際はGate 2の2件とGate 3の8件、合計10件です。metaには10件すべて保存されているため結果への影響はありません。

## (d) 総合判定

**不合格**

Gate 2合格・Gate 3不合格という実測値と、MPCをdefault OFFのまま維持してT156eへ進まない判断は妥当です。metaの実データも今回のcanonical SHA-256と一致しています。

一方、canonical SHA検証が`return`後に置かれて到達不能であり、redo #1の中心である「測定条件を機械検証し、不一致なら集計を拒否する」チェーンは完成していません。レポートが主張するfail-closed検証と実装が一致しないため、doneにはできません。

確認した内容:

- `git log 4fccc73~1..4fccc73`
- `git diff 4fccc73~1..4fccc73`
- `git diff --check 4fccc73~1..4fccc73`：成功
- `python -B -m unittest bench/edax-compare/test_compare_mpc.py`：9件成功
- 周辺のCLI、merge、meta、設計・前回レビューをread-onlyで確認
- ファイル変更なし、サブエージェント利用なし
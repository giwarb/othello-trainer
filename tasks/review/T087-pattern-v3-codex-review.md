## 最終レビューレポート — T087

### (a) 重大（done を止めるブロッカー）

1. 長時間ベンチ処理にチェックポイント／resume が実装されていない

[compare_pattern_v3.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_pattern_v3.py:53) は、v2・candidateそれぞれ18局面をすべて処理した後にだけ結果を書き出します。局面単位の進捗表示はありますが、途中結果の保存もresumeもなく、後半で中断するとそれまでのEdax完全読み結果が全損します。

同様に [smoke_pattern_v3.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/smoke_pattern_v3.py:54) も20局すべての終了後にだけ出力します。

AGENTS.md の「10分を超えうる対戦・ベンチ・一括解析は最小単位ごとの逐次保存、resume、逐次ログが必須」に明確に反します。特にEdax完全読み36回は10分超過が十分あり得る処理です。局面／対局ごとに原子的に結果を保存し、入力条件・重みハッシュが一致する場合だけ再開できるようにする必要があります。

### (b) 中（次タスクで対応すべき）

1. 学習checkpoint／完成ファイルの再利用に実験条件の検証がない

[train_patterns_v3.rs](C:/Users/yoshi/work/othello-trainer/train/src/bin/train_patterns_v3.rs:147) は、期待する名前の完成ファイルまたはcheckpointが存在すれば無条件で読み込みます。WTHORファイル集合、`--max-games`、学習率・L2、総epoch数、パターン構成などのメタデータを保存・照合していません。

そのため、小規模確認を本番と同じ出力先で実行した場合やデータが差し替わった場合、別条件の重みを本番結果としてskip・評価できます。また、20 epochの完成ファイルがある状態で`--epochs 30`としても追加10 epochは実行されません。データ／設定／schema／seedのrun identityをcheckpointに付け、不一致時は再開を拒否すべきです。

2. `results.tsv`は作業ログの記述と異なり逐次保存されない

[train_patterns_v3.rs](C:/Users/yoshi/work/othello-trainer/train/src/bin/train_patterns_v3.rs:140) は結果をメモリ上の文字列へ蓄積し、全run終了後の同ファイル208行目で初めて書き出します。「上表を`results.tsv`へ逐次保存」という作業ログとは一致しません。

各runの重みは保存されるため学習そのものは復旧できますが、長時間処理の記録としてはrun完了ごとの原子的更新が望まれます。

3. PWV3 loaderがヘッダ由来の個数に実用上の上限を設けていない

[pattern_eval.rs](C:/Users/yoshi/work/othello-trainer/engine/src/pattern_eval.rs:335) は`num_instances`を読み、その値をそのまま`Vec::with_capacity`へ渡します。短い不正ファイルでも巨大な個数を指定でき、通常の`Err`ではなく過大確保による異常終了を招き得ます。

残りバイト数から成立可能な上限を検証し、プロジェクト上の妥当なinstance/class上限も設けるのが安全です。

4. 比較結果のprovenanceが保存されない

新しい比較スクリプトの出力には重みパスしかなく、重み・評価CLI・Edax・eval.dat・コーパスのハッシュやgit treeがありません。既存の`vs_edax.py`にはこれらを照合する仕組みがあるため、採否判定に使う結果についても同程度の再現性確認が必要です。

### (c) 軽微（記録のみ）

1. `atomic_write`は既存ファイルを削除してからrenameしており、厳密にはatomic replacementではありません

[train_patterns_v3.rs](C:/Users/yoshi/work/othello-trainer/train/src/bin/train_patterns_v3.rs:73) では削除とrenameの間に中断すると旧ファイルも失われます。Windows対応の置換方法、または世代ファイルを残して完了マーカーを更新する方法が適切です。

2. Edax一時ファイル名が固定です

`_t087_oracle_tmp.obf`を共有するため、比較スクリプトを並行実行すると競合します。一意な一時ファイルを使うべきです。

3. 作業ログのコミット情報が実際の履歴と一致していません

ログは「コミットハッシュ: 未作成」のままですが、指定範囲には `4a036de` が存在します。オーケストレーター代行後の更新漏れと考えられます。

### 良好だった点

- edge+2X、diag 5/6/7、corner 5x2は基準座標へのD4変換と集合重複除去で機械生成されています。
- 5構成のinstance/class数は仕様どおりassertされています。
- `PatternCells`固定長化、一時feature `Vec`の除去、3進乗数の定数化が行われています。
- PWV3は自己記述形式で、指定された9種類の否定テストがあります。
- PWV1/PWV2互換ローダと従来PWV2 writerは維持されています。
- 不採用判定は、3 seedすべてのMAE悪化だけでも採用ゲート(c)不通過となるため、結論自体は妥当です。
- `git diff --check`は成功し、`git status --short`は空でした。

### (d) 総合判定

**不合格**

特徴生成、PWV3、学習、および不採用判定の中心部分は概ね仕様に沿っています。しかし、採用ゲート測定に使うEdax oracle比較と20局smークが、明示された長時間実行規律のチェックポイント／resume要件を満たしていません。これは過去のデータ消失事故を受けた必須規律であり、doneを止めるブロッカーです。

加えて、学習resumeが実験条件を照合しないため、別条件の小規模runや古い完成ファイルを正式なablation結果として扱える回帰リスクがあります。これらを修正し、少なくとも関連する単体テストと比較スクリプトのresume確認を追加したうえで再レビューが必要です。
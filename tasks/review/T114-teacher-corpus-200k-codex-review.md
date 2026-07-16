# T114 最終レビューレポート

## レビュー対象

- `git diff 81f4667..de1c9b4`
- `git log 81f4667..de1c9b4`
- 対象コミット: `de1c9b4`
- 変更: 7ファイル、1,156行追加、28行削除
- `git diff --check`: 問題なし
- `git status --short --untracked-files=all`: クリーン
- ファイル変更は実施していない

## (a) 重大（doneを止めるブロッカー）

なし。

生成済みコーパスに対してレビュー環境から以下を再実行し、正常終了を確認した。

```text
python bench/edax-compare/verify_teacher_corpus.py expanded200k
[expanded200k] verified 200000 record(s), 0 error(s)
TOTAL: 200000 record(s) verified, 0 error(s)
```

この検証には、全合法手集合、スキーマ、連番positionId、D4重複、bestValue/diffFromBest、閾値20に基づくexact/level整合性、t096 oracle 60キーとの非混入確認が含まれる。

## (b) 中（次タスクで対応すべき）

### 1. meta欠損・破損時には依然としてcheckpointを暗黙に消失させる

[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:737)では、JSONLまたはmetaの片方が存在しない場合と、metaがパース不能な場合に`try_resume()`が`False`を返す。その後、[同ファイル](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:976)の呼び出し側が無条件に`start_fresh()`を実行し、既存JSONLを空にする。

今回追加されたrunKey/provenance不一致時の保護は適切だが、「何も指定しなければ暗黙の切り詰めは二度と起きない」というコメントと実挙動が一致していない。metaのみが壊れた場合でも、正常なJSONL全件を失いうる。

次タスクでは、少なくともJSONLが存在する状態でmetaが欠損・破損していれば、`--start-fresh`なしでは`RuntimeError`にするべきである。該当ケースでJSONLが保持されるテストも必要。

### 2. expanded200kの年指定ミス・候補不足をラベリング開始前に検出しない

CLIの`--years`既定値は現在も`2015-2024`である一方、expanded200kは`2000-2024`を明示しないと候補数が約93kにしかならない。[選定後](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:921)も`len(selected) == target_count`を検証せず、そのままEdaxラベリングへ進む。

そのため、次のように年指定を忘れると、約93k件を長時間計算した後に200k不足でmergeが失敗する。

```text
python bench/edax-compare/gen_teacher_corpus.py expanded200k --num-shards 8
```

今回の実生成では正しく`--years 2000-2024`が指定され、200,000件が完成しているためブロッカーではない。再生成時の事故防止として、set別既定年範囲を持たせるか、選定直後にtarget未達をエラーにするべきである。

## (c) 軽微（記録のみ）

### 1. manifestのopening比率表現にわずかな不整合がある

manifestは`maximumSingleOpeningShare: 0.02`を受け入れ閾値として記録する一方、実績値は`0.0200065`で閾値をわずかに超えている。原因は明記されており、実際の選定ロジックが「全200,000件の2%=4,000件」を上限としているため、コーパス品質上の問題とは判断しない。

ただし、監査値を厳密な合否に使うなら、分母を全target件数に統一するか、丸め込みの許容値をmanifestに明示すると分かりやすい。

### 2. pytestはレビュー環境の制約で再実行できなかった

read-only環境に利用可能な一時ディレクトリがなく、pytestはテスト収集前に停止した。実装テストの失敗ではない。

作業ログには以下の成功記録があり、追加テストの内容も差分上で確認した。

- `python bench/edax-compare/test_teacher_corpus.py`: 22件成功
- `python -m pytest bench/edax-compare/ -q`: 38件成功
- `cargo test -p train --release`: 56件成功

公式の全件verifierは今回独立に再実行し、200,000件・0エラーを確認済み。

## 設計・要件適合性の評価

以下は適切に実装されている。

- WTHOR年範囲を2000–2024へ拡張し、K拡張を避けて「1対局×1bin=1候補」の設計を維持している。
- expanded200k専用seed `90103`を使用している。
- t096 oracleのcanonicalKeyを優先層・WTHOR層の双方から除外している。
- 完成後にもRust側で再計算したcanonicalKeyをoracle 60キーと突合している。
- `edaxTasksPerProcess: 1`がmanifestに記録され、実装上もEdax `-n 1`へ接続されている。
- 完全読み閾値20はexpanded200kのみに適用され、smoke/primaryの既定値24を維持している。
- 旧閾値24の影響レコード4,943件を実データの`exact`、`level`、`childEmpties`に基づいて除去・再計算している。
- 8シャードすべて25,000件で完走し、merge後の連番200,000件が検証されている。
- checkpoint/resume、中断、移行、再開、最初の新checkpoint、完走履歴がログとmanifestに記録されている。
- manifestには生成構成、SHA-256 provenance、oracle非混入、移行経緯、検証結果が揃っている。
- 学習・アプリ配線などスコープ外の変更はない。

## (d) 総合判定

**合格**

200,000局面の生成、`-n 1`決定性、oracle非混入、閾値20への均一移行、全件検証、manifest/provenance、checkpoint/resume記録という主要な受け入れ基準を満たしている。レビュー時にも生成済み200,000件を公式verifierで再検証し、0エラーを確認した。

指摘した2件の中事項は、将来の再生成・障害時に計算結果を失うリスクを下げるための堅牢化であり、既に完成・検証されたT114成果物のdoneを止めるものではない。
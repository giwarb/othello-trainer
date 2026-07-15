# T096 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

なし。

60局面の選定、教師コーパスとのcanonical重複除外、両重みの測定、paired bootstrapによる三択判定はいずれも実データと整合しており、再判定結果を覆す問題は認められませんでした。

## (b) 中（次タスクで対応すべき）

### 1. コミット後の成果物をresumeできない

[compare_pattern_v3.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_pattern_v3.py:46) はcheckpoint identityに現在のHEAD treeを含め、[同ファイル](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_pattern_v3.py:127) で完全一致を要求しています。

今回の結果JSONに記録されたtreeは実行時HEAD `b7c5ee9` の `bbd27356...` ですが、レビュー対象コミット `1bd96fc` のtreeは `18685fea...` です。このため、現在のコミット状態で作業ログ記載のコマンドを再実行すると、Edax処理開始前に以下で失敗します。

```text
RuntimeError: resume identity mismatch; refusing stale checkpoint
```

実行自体はコミット前の作業ツリー上で正常にresumeされているため、今回の測定結果や長時間実行中の保全を無効にするものではありません。ただし、納品時点の成果物からのresume・再検証性が失われています。

次タスクでは、HEAD treeではなく、実際に結果へ影響するスクリプト・実行バイナリ・重み・corpusのハッシュをidentityに使うか、実行時のdirty状態も正しく識別できるprovenance方式にするべきです。

## (c) 軽微（記録のみ）

### 1. manifest全行が`git diff --check`でtrailing whitespaceになる

[t096_oracle_positions.json](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t096_oracle_positions.json:1) はCRLFでコミットされており、現在のリポジトリ設定では970行すべてがtrailing whitespaceとして検出されます。

したがって、作業ログの「`git diff --check`（PASS）」とは一致せず、実際には非zero終了します。機能・測定値への影響はありませんが、[select_t096_oracle_positions.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/select_t096_oracle_positions.py:124) の出力時にLFを明示すると再発を防げます。

## 確認結果

- `git log b7c5ee9..1bd96fc`：T096の1コミットのみ。
- 差分は仕様どおり、比較スクリプト、選定スクリプト、60局面manifestの3ファイルのみ。
- `git status --short --untracked-files=all`：クリーン。
- manifest：
  - 60局面、空き18–20／21–23／24–26が各20局面。
  - ID、canonicalKeyはいずれも60件すべて一意。
  - 60局面すべて別対局。
  - board、side、empties、監査poolの参照先が全件一致。
  - Rust正本によるcanonicalKey再計算が全60件一致。
  - 教師50,000 canonicalKeyとの重複0件。
  - auditと教師コーパスのSHA-256がmanifest記録と一致。
- 結果JSON：
  - root oracle、v2、candidateが各60件で、manifestのID集合と一致。
  - 全regretが非負。
  - v2平均 `1.5666666667`、候補平均 `3.4666666667`、差 `+1.9`。
  - seed `96002`、100,000 resamplesで独立に再計算し、95% CI `[+0.6666666667, +3.3]` と一致。
  - `candidate_worse`判定は妥当。
- 「候補が悪化」のため20局スモークを省略した判断は要件5に合致。
- Rustコードは変更されておらず、記録された`cargo test -p engine`／`cargo test -p train`の結果にも不整合は認めませんでした。

## (d) 総合判定

**合格**

主目的であるoracle regret測定の60局面への頑健化とT090b候補の再判定は、仕様を満たして正しく完了しています。候補の悪化は95% CIの下限が明確に0を上回っており、不採用判定は妥当です。

コミット後に既存結果をresumeできないprovenance設計は次タスクで修正すべきですが、今回得られた測定値・統計判定の正しさを損なうものではないため、doneを止めるブロッカーとは判定しません。
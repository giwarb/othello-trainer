# T090a 最終レビューレポート

対象: `79c01d9..65f218d`  
判定対象コミット: `65f218d`

確認内容:

- `git log 79c01d9..65f218d`
- `git diff 79c01d9..65f218d`
- 変更されたPython/Rustコードおよび周辺実装
- ローカルのsmoke 1,000件、primary 50,000件とmanifest
- `verify_teacher_corpus.py smoke primary`
- `git diff --check` / `git show --check`
- `git status --short`

## (a) 重大（doneを止めるブロッカー）

### 1. exact判定の事後検証が閾値規則を検証していない

`verify_teacher_corpus.py:152-163`は、`exact=true`ならlevel 60と深さを、`exact=false`ならlevel 16を確認するだけです。盤面から再計算した`childEmpties`と`EXACT_EMPTIES_THRESHOLD=24`の対応を検証していません。

このため、例えば以下の不正レコードが通過します。

- `childEmpties <= 24`なのに`exact=false, level=16`
- `childEmpties > 24`なのに`exact=true, level=60`

redo #1の「`exact`の事後検証をverifyスクリプトに追加」と、生成規則「完全読み可能帯はexact、その他はlevel 16」を満たす検証になっていません。実データが現在0エラーでも、検証スクリプトが要求された異常を検出できないためブロッカーです。

### 2. canonical重複検査が盤面からcanonical keyを再計算していない

`verify_teacher_corpus.py:168-178`は、レコード内の`canonicalKey`をそのまま集合へ入れて重複を調べています。`board`と`sideToMove`からD4 canonical keyを再計算し、保存値と照合していません。

したがって、D4同値な2局面に異なる偽の`canonicalKey`を保存すれば「canonical重複なし」として通過します。受け入れ基準の「canonical重複なし」を機械的に保証できていません。

今回追加したRustの`canonical`サブコマンド、または検証済みのPython canonical実装を使い、全件について次を確認する必要があります。

- 保存された`canonicalKey`が盤面からの再計算値と一致
- 再計算値同士に重複がない

### 3. 公開スキーマと既存51,000件の実データが一致していない

`gen_teacher_corpus.py:73`のschema version 2相当の説明では、`openingKey`をWTHORレコードに保存し、非該当時はnullと定義しています。新規生成経路の`label_position()`も`openingKey`を出力します。

しかし`finalize_teacher_corpus.py:32-52`の後処理は`diffFromBest`しか追加せず、既存コーパスへ`openingKey`を付与していません。ローカル実データを確認すると、smoke・primaryともWTHORレコードに`openingKey`プロパティ自体がありません。一方、manifestは`schemaVersion: 2`へ更新されています。

また、厳密verifyは`openingKey`やsource固有フィールドの存在/null契約を検査しないため、この不一致を0エラーとして通しています。

T090bが読む契約としてスキーマを正本化する要件に反します。以下のいずれかへ統一すべきです。

- 監査用candidate mappingから既存WTHORレコードへ`openingKey`を後処理で追加し、engineLossではnullを追加する
- `openingKey`はコーパスの必須フィールドではなくmanifest監査専用とスキーマを修正し、schema versionの意味を明確化する

## (b) 中（次タスクで対応すべき）

### 1. verifierの異常系テストが不足している

追加された4テストは選定制約、D4実装一致、resume、provenance、merge不一致を対象にしていますが、厳密化したverifierの主要保証に対するnegative testがありません。

少なくとも次を改変した小規模コーパスがexit 1になるテストが必要です。

- 合法手の欠落・余分・重複
- malformed JSON、欠落ファイル、meta件数不一致、positionId欠番
- `diffFromBest`不一致
- exact閾値違反
- 保存`canonicalKey`の改ざんおよびD4重複
- 必須フィールド欠落/null方針違反

今回の2件の検証漏れも、この種の異常系テストがあれば検出できました。

## (c) 軽微（記録のみ）

### 1. コミットされたmanifestがCRLFで、`git diff --check`に失敗する

`git diff --check 79c01d9..65f218d`および`git show --check 65f218d`は、両manifestのほぼ全行を`trailing whitespace`として報告しました。作業ログの「`git diff --check`: 成功」と一致しません。

原因は`finalize_teacher_corpus.py:177-180`の`Path.write_text()`がWindowsで改行変換することです。manifest出力でも`newline="\n"`を明示するのが安全です。

JSONとしては有効であり、コーパス内容へ影響しないため軽微とします。

### 2. レビュー環境での補助テスト結果

- `python bench/edax-compare/verify_teacher_corpus.py smoke primary`  
  → 51,000件、0エラー
- manifest記載のコーパスSHA-256  
  → smoke・primaryともローカル実体と一致
- `git status --short`  
  → 清潔
- `test_teacher_corpus.py`  
  → 4件中、書き込み不要の2件は成功。`TemporaryDirectory`を使う2件はread-onlyレビュー環境に利用可能な一時ディレクトリがなく実行不能。コード不具合とは判定しない

## (d) 総合判定

**不合格**

`diffFromBest`の後処理、全合法手再計算、malformed/meta/positionId検査、resume末尾修復、gitCommit provenance、シャード整合検査、X/C quota・opening上限、manifest監査値と裁定記録は適切に追加されています。既存51,000件も現行verifierでは0エラーで、manifestのSHA-256とも一致しています。

しかし、厳密verifyがexact閾値規則と実盤面由来のD4 canonical性を保証できず、さらにschema version 2の`openingKey`契約と既存コーパスが一致していません。いずれも受け入れ基準およびredo #1の中心要件に関わり、T090bへ引き渡すデータ契約の信頼性を損なうため、doneにはできません。
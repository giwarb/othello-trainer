---
id: T143
title: 教師コーパス生成基盤の堅牢化(申し送り一括対応、4M生成前の必須整備)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T143: 生成基盤堅牢化

## 目的

expanded1m生成(T127b)完走でコード凍結が解除された。過去タスク(T127h/T127i/T127j/T127a/T114/T127cレビュー)で積み残した生成・検証基盤の堅牢化申し送りを一括で対応し、**将来の4M生成(T127eで判断)を安全に実行できる状態**にする。

## 背景・事実

- 対象はすべて `bench/edax-compare/` 配下のPythonファイル群: `gen_teacher_corpus.py` / `verify_teacher_corpus.py` / `finalize_teacher_corpus.py` / `test_teacher_corpus.py`(現在49テスト全PASS)。
- expanded1m生成は完走済み・検証済み(T127c、全1M件0エラー)。**本タスクの変更が既存コーパス・manifestの値を変えることはあってはならない**(検証・ゲート強化とテスト追加が主)。
- **並行タスク注意**: T127d(学習)が train/ 側で並行実行中。bench/edax-compare/ 配下は本タスクの独占だが、**CPU負荷の高い処理(Edax大量呼び出し・長時間ベンチ)は行わない**(本タスクにそもそも不要)。
- 参照: 各申し送りの出典は `tasks/STATUS.md` の「有効な方針・申し送り」、レビューは `tasks/review/T127c-corpus-1m-verify-claude-review.md`、T127aの固定テスト仕様は `tasks/T127a-corpus-1m-infra.md` の作業ログ・受け入れ基準を参照。

## 要件

### A. gen_teacher_corpus.py(生成側)

1. **束フォールバック経路のcheckpoint修正**(T127h申し送り・中): 現行は束(32親)内の全親成功までcheckpointされず、フォールバック経路で最大1束分の損失が出る。親単位(または処理済み局面単位)でcheckpointされるよう修正する。resume identityのgeneratorSHAゲートに触れるため、plan provenance更新(適切なidentity再計算)とセットで行い、既存checkpointとの互換性の扱いを明記する。
2. **PROVENANCE_IDENTITY_KEYSへEdaxバイナリ実SHAを追加**(T127ij申し送り・中): 現行はresume identity/runKeyにEdaxバイナリの実SHAが入らず、バイナリ差し替えをfail-closed検知できない。identityへ組み込み、差し替え時はresume拒否(明示フラグで受理)にする。
3. **meta欠損・JSONパース失敗時のcheckpoint暗黙破棄経路のエラー化**(T114申し送り): 破損時に黙って捨てず、明示エラー+復旧手順の提示にする。
4. **年指定ミス・候補プール不足の事前検出**(T114申し送り): ラベリング開始前に検出して早期エラーにする。

### B. verify/finalize(検証側、T127cレビュー中2件)

5. **verify checkpointへのフィンガープリント追加**(レビュー中-1): checkpointに対象JSONLのサイズ+SHA-256とteacher_candidates.exeのSHAを記録し、load時に不一致ならcheckpointを無効化してフルスキャンにフォールバック(理由をログ)。
6. **finalize_expanded1m()の整合性ゲート**(レビュー中-2): stats.records==progress.total、contaminatedRecordsFound==0、selectionAudit.thresholdTriggered==False をassertし、不一致なら書き出さずエラー終了。
7. **corpus_expanded1m.meta.json へ corpusSha256 を追記**: マージ済みJSONL自体のSHA-256をmanifestに記録する(finalizeの再実行または追記スクリプトで)。**追記値がオーケストレーター実測値 `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86`(1,595,551,517 bytes、2026-07-20実測)と一致することを確認すること**(不一致ならデータドリフトであり作業を止めて報告)。

### C. テスト追加(T127a申し送り+レビュー軽微)

8. **K=1のend-to-end SHA固定テスト**(合成WTHOR入力): 小さな合成入力で生成パイプラインを通し、出力のSHAを固定する回帰テスト(T127a申し送りの仕様どおり)。
9. **waterfall配分の期待配列固定テスト**(T127a申し送り)。
10. **checkpoint破損(不正JSON)→フルスキャンフォールバックの回帰テスト**(レビュー軽微5)。
11. 軽微対応(同一ファイルを触るついでに): `--progress-every` がBATCH_SIZE(500)の倍数でない場合のバリデーション(警告または丸め)、verify checkpoint削除時の `.tmp` 掃除。

## スコープ外(やらないこと)

- データ本体・シャード・既存manifestの値の変更(7のcorpusSha256「追記」のみ許可。既存フィールドの値は変えない)
- 4M生成の実行、Edax大量呼び出し、性能計測
- train/ 側(T127dの領分)・app/engineの変更(GitHub Pages確認不要)
- manifestのWindowsパス区切り正規化(レビュー軽微3)は任意。実施する場合はverify側の正規化と整合させ、SHA系フィールドに触れないこと

## 受け入れ基準

1. `python bench/edax-compare/test_teacher_corpus.py` が全テストPASS(既存49+新規。要件8〜10のテストを含む)
2. `python bench/edax-compare/verify_teacher_corpus.py expanded1m` が引き続き1,000,000件0エラーで完走する(変更が既存検証を壊していないことの実地確認。約3〜4分)
3. corpus_expanded1m.meta.json に corpusSha256 が追記され、実測値 067a4e3a... と一致している
4. 要件1〜2(resume identity変更)について、変更後のresume挙動(受理・拒否)がテストで固定されている
5. 変更ファイルはパス明示でコミット(`git add .` 禁止)し、mainへpush
6. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## コミット規律

- コミットしてよいのはタスクの変更対象ファイルのみ。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 一時ファイルはscratchpadへ。スコープ外差分は報告のみ

## 作業ログ

(ワーカーが節目ごとに追記)

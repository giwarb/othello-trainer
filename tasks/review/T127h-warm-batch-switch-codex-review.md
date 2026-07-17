# 最終レビューレポート

対象: `git diff 36e8b8e..68dbfa6` / `git log 36e8b8e..68dbfa6`  
変更コミット: `68dbfa6`  
変更ファイル: `gen_teacher_corpus.py`, `test_teacher_corpus.py`

## (a) 重大（done を止めるブロッカー）

1. フェーズ2の migration と移行後検証が未実装

対象差分はフェーズ1のみで、仕様および受け入れ基準にある以下が存在しません。

- 全シャードの meta/jsonl バックアップ
- 既存レコード数・SHA検証
- runKey/settings/provenance の新方式への安全な書き換え
- 削除・切り詰め経路がないことを固定する migration テスト
- 方式境界と T127f/g の値一致証跡の記録
- 既存レコード全件ロード、新方式 resume、抜き取り値一致の確認手順・結果

現状、新しい worker は新 runKey を生成するため、旧 checkpoint のままでは `TeacherCorpusCheckpoint.try_resume()` が runKey 不一致で停止します。また、固定 selection-plan の `generatorSha256` も更新前コードの値なので、必要な provenance 移行なしには `_expanded1m_settings_and_meta()` の SHA 検証でも再開できません。

フェーズ1完了時に停止すること自体は仕様どおりですが、T127h 全体を `done` にするにはフェーズ2が必須です。

## (b) 中（次タスクで対応すべき）

1. fallback 中の個別成功結果が、束全体の個別実行完了まで checkpoint されない

[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1617) の fallback は、リスト内包で全親を `label_position()` した後にまとめて `checkpoint.append()` しています。

そのため、例えば32親中10親目の個別実行が失敗すると、先に成功した9親も永続化されません。「親単位 checkpoint」と「束失敗時の全滅回避」という目的に対して堅牢性が不足しています。

fallback 時は親ごとに以下を逐次実行し、成功した親を直ちに fsync する設計を推奨します。

1. `label_position`
2. `checkpoint.append`
3. 次の親へ進む

現在のテスト [test_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/test_teacher_corpus.py:204) は、全親の個別実行が成功するケースしか検証しておらず、途中の親が失敗した場合の checkpoint 挙動を固定していません。

## (c) 軽微（記録のみ）

1. `edaxParentsPerProcess` の値検証がない

[gen_teacher_corpus.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/gen_teacher_corpus.py:1698) で `range(..., parent_bundle_size)` に直接使用しています。現在は固定値32なので実害はありませんが、将来設定化された際に0以下だと分かりにくい例外になります。

2. マイクロベンチの根拠はコメントと作業ログのみ

8/16/32親について速度・値一致の数値は記録され、32親採用の判断も合理的です。ただし、生データや再実行可能なベンチ手順は対象コミットに含まれていません。仕様上必須とまでは読めないため記録のみとします。

3. レビュー環境ではテストを再実行できなかった

read-only 環境に Python が利用可能な一時ディレクトリを作れず、pytest はテスト収集前に `FileNotFoundError: No usable temporary directory found` で停止しました。コード起因の失敗ではありません。作業ログ上は `50 passed`、unittest は `34 tests OK` と記録されています。`git diff --check` は合格し、レビューによるファイル変更もありません。

## 実装評価

フェーズ1の中心実装については、次の点を確認しました。

- plan 順を保った最大32親の束化
- exact/level16 ごとに最大1回、合計最大2回の Edax 呼び出し
- 親ごとの side を使った値の符号変換
- 束全体のパース完了後、親順に JSONL append + fsync
- 束失敗時の旧方式 `label_position()` への fallback
- `edaxParentsPerProcess` と elapsed policy の新 runKey/settings への反映
- フィールドなしの場合の旧 runKey 完全一致テスト
- cold/batched の値一致と level 別集約テスト

通常経路には、値の正しさや親順を壊す明白な回帰は見つかりませんでした。

## (d) 総合判定

**不合格**

理由は、T127h 全体の必須フェーズである migration、安全性テスト、移行後 resume・値一致確認が対象範囲に存在せず、現状のままでは旧 checkpoint から新方式へ再開できないためです。

フェーズ1単体の実装は概ね妥当ですが、fallback 途中失敗時にも成功済み親を保持できるよう親単位 checkpoint を強化したうえで、フェーズ2を完了して再レビューする必要があります。
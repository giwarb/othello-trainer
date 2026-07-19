---
id: T127c
title: expanded1m独立検証・manifest確定(1M教師コーパス)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T127c: expanded1m独立検証・manifest確定

## 目的

T127bで生成完走した100万件教師コーパスを独立検証し、manifestを確定する。**T127d(v4×1M学習)の前提タスク**。データに欠陥があれば学習前に検出する。

## 背景・事実(前提知識ゼロでも作業できるように)

- コーパス本体: `train/data/teacher/corpus_expanded1m.jsonl`(1,595,551,517 bytes、1,000,000行、gitignore領域)。2026-07-19 23:04 生成完走(8シャード×125,000件、全shard exit 0、stderrエラーなし)。
- シャードファイル・checkpoint・メタ類も `train/data/teacher/` 配下にある(gitignore領域)。**verify全件合格までシャードファイルを削除しないこと**(合格後の削除もスコープ外、オーケストレーター判断)。
- 生成ログ: `logs/t127b-gen4.log`(最終resume後)、`logs/t127b-gen2.log`/`t127b-gen3.log`(それ以前)。
- 生成方式が途中で2回切り替わっている(①cold→warm 32親束バッチ、②Edax v2→v3(AVX2)バイナリ)。**方式境界はサイドカー `bench/edax-compare/teacher_manifests/corpus_expanded1m_method_boundaries.json` が正**。いずれの切替も値の等価性はA/B検証済み(T127g/T127i)。
- 既存基盤(T114で200k検証に使用・実績あり): `bench/edax-compare/verify_teacher_corpus.py`、`bench/edax-compare/finalize_teacher_corpus.py`、`bench/edax-compare/test_teacher_corpus.py`。先行manifestの例: `bench/edax-compare/teacher_manifests/corpus_expanded200k.meta.json`。
- 設計の正: `tasks/design/T127-corpus-1m-report.md` §「T127c: 独立検証・manifest確定」。

## 変更対象

- `bench/edax-compare/teacher_manifests/corpus_expanded1m.meta.json`(新規作成・確定)
- 必要に応じて `bench/edax-compare/verify_teacher_corpus.py` / `finalize_teacher_corpus.py`(1M対応・検証項目追加の範囲のみ)
- 必要に応じて `bench/edax-compare/teacher_manifests/README.md`
- **データ本体(jsonl)は変更しない**

## 要件(検証項目、設計レポート準拠)

全1,000,000件に対して:

1. positionId連番(欠番・重複なし)
2. canonicalKey全件重複0
3. oracle 60局面キー(T096)の混入0
4. phase / X・C打ち / opening監査(selection planの層化設計との整合)
5. exactEmptiesThreshold=20整合(空き20以下=exact、21以上=level16)
6. level 16/60整合(非exact=level16、exact=完全読みの規約どおり)
7. 全合法手の値が揃っていること・best/diffFromBestの整合(bestは最大値、diff=best-値)
8. シャード件数8×125,000、reuse/new件数(base 200,000 reuse + 新規800,000)
9. **先頭200k(corpus_expanded200kからのreuse分)のレコード同一性**(corpus_expanded200k.jsonlと突合)
10. 年別・対局別・phase別分布の集計と記録
11. merged JSONL SHA-256、selection plan SHA-256 の記録
12. provenance(mixed provenance: warm切替・v3切替の2境界)をmanifestへ記載 — **サイドカー corpus_expanded1m_method_boundaries.json の内容をmanifestへ転記**(T127h/T127ijレビュー申し送り)

manifest確定: 上記の検証結果・SHA・分布・provenance・方式境界を `corpus_expanded1m.meta.json` に記載し、既存manifest(expanded200k)の形式に揃える。

## 長時間実行ルール(CLAUDE.md準拠・必須)

1M件の全件検証は10分を超えうるため:
- チャンク単位(例: 10万件ごと)で進捗をログ出力する
- 中断→resumeできる設計にする(既存verify基盤にresumeがあれば踏襲、なければチャンク単位checkpointを追加)
- 「全部終わってから一括書き出し」は禁止

## スコープ外(やらないこと)

- `gen_teacher_corpus.py` 本体の修正(生成基盤の堅牢化はT143: 束フォールバックcheckpoint修正・PROVENANCE_IDENTITY_KEYSへのEdaxバイナリSHA追加・T127a固定テスト2件・T114申し送り対応)
- T127d(学習)、データ本体の変更・再生成、シャードファイルの削除
- app/engineの変更(**GitHub Pages確認は不要**。アプリに影響しないデータ/ベンチ変更のため)
- Edaxの再実行・大量呼び出し(本タスクは静的データ検証のみ)

## 受け入れ基準

1. verify実行が**全項目0エラー**で完走し、実行ログ(進捗行含む)が残っている(scratchpadではなく `logs/` または作業ログに要約)
2. 検証レポート(検証項目ごとの結果・件数・分布・SHA)が本タスクファイルの作業ログ、または `bench/edax-compare/teacher_manifests/` 配下のレポートとして残る
3. `corpus_expanded1m.meta.json` がコミットされ、方式境界2件(warm切替・v3切替)が転記済み
4. `bench/edax-compare/test_teacher_corpus.py` の既存テストがパス(実行方法は既存踏襲。verify系スクリプトを変更した場合は対応テストも更新)
5. 変更ファイルは**パス明示でコミット**(`git add .` 禁止)し、mainへpush
6. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## コミット規律

- コミットしてよいのはタスクの変更対象ファイルのみ。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 一時ファイルはセッションのscratchpadへ。リポジトリ内に生成した中間物は同タスク内で削除するか.gitignore対応
- スコープ外の差分・未追跡を見つけたらコミットせず完了レポートで報告

## 作業ログ

(ワーカーが節目ごとに追記)

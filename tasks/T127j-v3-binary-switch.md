---
id: T127j
title: expanded1m生成のEdax v3バイナリ(AVX2)乗り換え準備(コード・meta移行・plan再生成の実装)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T127j: v3バイナリ乗り換え準備

## 目的

T127iのA/B結果(bench/edax-compare/t127i_edax_v3_ab_report.md)で、`wEdax-x86-64-v3.exe`(AVX2)は**値が全帯・全件一致かつ残件加重1.15倍高速**と確定した。走行中のexpanded1m生成(約49.2万/100万)を途中からv3バイナリに乗り換えるための**準備一式**(コード変更・meta移行スクリプト・plan再生成手順)を実装する。

**実際の停止→移行→再開はオーケストレーターが行う**(本タスクのスコープ外)。T127h(親またぎwarm移行)と同じ役割分担。

## 絶対厳守(ユーザー指示由来・最優先)

- **既存の生成済みレコード(現在49.2万件)を1件も削除・切り詰めしない。** 移行スクリプトに削除・truncate経路を一切実装しない(`start_fresh`呼び出し・ファイル再作成・行の除去はすべて禁止)。
- **実行中の生成プロセス群(python3.11×9+wEdax群)に触れない・killしない。** 停止はオーケストレーターが行う。生成中のplan/checkpoint/シャードファイルへの書き込みも禁止(本タスク中は読み取りのみ。移行スクリプトは実装+テストのみ行い、本番ファイルへは実行しない)。
- 先例を必ず読むこと: `tasks/T127h-warm-batch-switch.md`(前回の途中乗り換えの全手順)、`bench/edax-compare/migrate_t127h_warm_batch.py`+そのテスト(meta-only移行・削除経路なし・冪等の実装様式)、`bench/edax-compare/migrate_t114_exact_threshold_20.py`(初代migrate)。
- **警告: `train/src/bin/teacher_candidates.rs`のバイナリは実行しない(--helpでも抽出が走り出力を上書きする)。releaseビルドも行わない。**

## 要件

1. **コード変更(gen_teacher_corpus.py)**: expanded1mの設定(settings)に明示のEdaxバイナリ指定(例: `"edaxExe": "wEdax-x86-64-v3.exe"`)を追加し、Edax呼び出しが `vs_edax._edax_solve_batch(..., edax_exe=...)`(T127iで追加済みの加算引数)経由でそのバイナリを使うようにする。設定はmeta/provenanceに記録される形にする(既存の`edaxParentsPerProcess`/`elapsedMsPolicy`と同じ流儀)。既定値(設定なし)は従来バイナリ=挙動不変であること。
2. **meta移行スクリプト** `bench/edax-compare/migrate_t127j_v3_binary.py`: migrate_t127hの様式を踏襲し、
   - 8シャードのmeta(+checkpoint内のprovenance identityが該当するなら同様)を新settingsに整合するよう更新(meta-onlyの書き換え。レコード本体・行数は不変)。
   - 方式境界の機械可読な記録: 切替時点の各シャード生成済み件数と`"edaxExeBoundary": {"before": "wEdax-x86-64.exe", "after": "wEdax-x86-64-v3.exe", "valuesIdentical": true, "evidence": "t127i_edax_v3_ab_report.md"}` 相当をmetaに残す(T127h申し送りの「方式境界をmanifestに機械可読で」に沿う。最終manifestへの転記はT127cが行うので、metaに材料があればよい)。
   - 実行前に`train/data/teacher/backup-t127j-migration/`へ対象meta/checkpointをコピー(バックアップ)。
   - 冪等(2回実行しても同一結果)・dry-runモード付き。
   - テスト(migrate_t127hのテスト様式): 一時ディレクトリ上の合成meta/checkpointで、更新内容・冪等性・**レコードファイルに一切書き込まないこと**・バックアップ作成を検証。
3. **selection plan再生成の手順確認**: gen_teacher_corpus.py変更により実行SHAゲート(_expanded1m_settings_and_meta)が現planのmetaと不一致になる。T127hと同様に「planの決定的再生成でデータ部が現planとbyte同一になる」ことを確認するコマンド列(オーケストレーターが実行する用)を作業ログに書く。可能なら「plan本体(データ行)のSHAが現行 `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483` と一致するか照合するだけの読み取り専用チェックスクリプト or ワンライナー」を用意する(本番planへの書き込みは禁止、検証は一時出力先で)。
4. **テスト**: `python -m pytest bench/edax-compare/ -q` 全パス(既存68+新規)。edaxExe設定が指定時のみ効き、未指定時は従来コマンド列と同一であることのテストを含める。
5. **切替ランブック**: 作業ログに、オーケストレーターが実行する手順を番号付きで書く(①生成停止(親python PID 21948とシャード群の安全な停止方法)→②migrate実行コマンド→③plan再生成/照合コマンド→④再開コマンド`python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`(Start-Process detached、ログ先logs/t127b-gen3.log)→⑤再開後の確認観点(resume OK行の件数が停止時以上、新規レコードのmeta整合、err.log 0行))。

## やらないこと(スコープ外)

- 生成プロセスの停止・migrate本番実行・plan本番再生成・再開(すべてオーケストレーターが実施)
- `-n 2`の採用(T127iでlevel16値不一致により不採用確定)
- vs_edax.pyの既定バイナリ(EDAX_EXE定数)の変更(既定は従来のまま。切替はexpanded1m設定経由のみ)

## 受け入れ基準

- [ ] 未指定時挙動不変(コマンド列同一)のテストがあり、`python -m pytest bench/edax-compare/ -q` 全パス
- [ ] migrate_t127j_v3_binary.pyに削除・truncate経路が存在しない(テストで「レコードファイル不変」を検証)
- [ ] 冪等性・dry-run・バックアップ作成のテストがある
- [ ] 切替ランブックが作業ログにある(plan照合の読み取り専用チェック込み)
- [ ] 変更対象(gen_teacher_corpus.py、migrateスクリプト+テスト)のみパス明示でコミット(`bench:`、`(T127j)`)。`git add .`禁止、`tasks/`はコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡が`git status --short`に残っていない(生成中ファイル群・scratchpadは対象外)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

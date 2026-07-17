---
id: T127a
title: 1Mコーパス基盤(K拡張・入れ子選定・スケール堅牢化)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T127a: 1Mコーパス基盤の実装

## 目的

ユーザー承認(2026-07-17)の100万局面コーパス(`expanded1m`)生成に向けた基盤実装。**設計は `tasks/design/T127-corpus-1m-report.md` が規範**(全面採用)。本タスクはレポート §5 T127a 節の実装+selection-only probeまで(本番生成はT127b)。

## 規範設計の要点(レポート§3、詳細はレポート必読)

- 候補プール: WTHOR 2000-2024のまま **K=4**(`--per-bin-cap`新設、既定1で既存set不変。perGameCap=24)
- **既存expanded200kを先頭200,000件として完全包含**(base import: SHA検証8項目→新checkpoint初期化。--adopt-provenance流用は禁止)
- **選定は親プロセスで一度だけ確定**(selection plan+シャード別plan、SHAをrunKey/manifestへ)
- phase 6bin waterfall・X/C quota 50%・opening cap 2%は**baseを含む最終1M全体**で判定
- engineLoss優先層は base由来65件のみ(スケールしない)
- merge/verifierのストリーミング化(全件メモリ保持をやめる)、trainerのストリーミング化はT127d
- ハードウェア事前ゲート: ディスク8-10GB以上の空き実測

## オーケストレーター裁定(レポート§8への回答、実装に反映)

1. 「1M」=**コーパス総数1,000,000件**(新規約800k、約41時間)。学習曲線の評価は名目1MでなくT127dで**実trainサンプル数(約90万)を横軸に**行う。
2. K=4承認。probeで余裕不足でも**自動でK=5にせず停止して報告**(再裁定する)。
3. 4M構想=WTHOR 2000-2024の全canonical unique局面(1977-1999は含めない)。
4. 1M実測が1.40超〜1.70以下は**保留としてユーザー再裁定**(レポート§7の判定ルール採用)。
5. gateは3seed平均。**seed SDが0.35超なら追加3seed**を行ってから判定。
6. 4M続行の最低条件: 平均≤1.40 **かつ** v4×WTHOR 1.111を下回るcredible path(§7どおり)。
7. 500k bridge学習(seed1のみ)を採用(T127dに含める)。
8. ハードウェア事前ゲート採用(本タスクで空き容量・RAM見込みを実測記録)。

## 受け入れ基準(レポート§5 T127a受け入れゲート+標準項目)

- [ ] smoke/primary/expanded200kの既存設定・runKey構成・候補抽出結果を変更しない(K=1回帰テストで固定)
- [ ] selection-only probe(dry-run)でちょうど1,000,000件選定成功(target未達は即時エラー)
- [ ] base 200k prefixの完全一致検証(SHA)とprovenance 2層(baseCorpus/incrementalGeneration)の実装
- [ ] incremental canonicalKey重複0・oracle混入0・8シャード各125,000件(内reuse 25,000)の計画検証
- [ ] streaming merge/verifierの実装とテスト
- [ ] `cargo test -p train`+`python -m pytest bench/edax-compare/ -q`+`python bench/edax-compare/test_teacher_corpus.py` 全件パス
- [ ] probeの結果(候補プール実数・bin別母集団・余裕率)が作業ログにある
- [ ] ディスク空き・RAM見込みの実測記録
- [ ] 変更対象ファイルのみパス指定でコミット(`(T127a)`)。tasks/はコミットしない
- [ ] タスク完了時点で当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## やらないこと(スコープ外)

- 本番生成(T127b)・検証/manifest(T127c)・学習(T127d)・判定(T127e)
- 年範囲拡張・全局面方式(レポートで却下済み)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)


### 2026-07-17 15:08 JST — Codex 実装ワーカー

- 実施内容:
  - `teacher_candidates extract`へ`--per-bin-cap`（既定1）を追加。K=1ではJSONフィールド・乱数呼出順・候補配列を従来どおりに保ち、K=4ではbin内の決定的な重複なし抽出を実装。
  - `expanded1m`（2000-2024、K=4、perGameCap=24、総数1,000,000）専用経路を追加。expanded200kのJSONL/manifest固定SHA、200,000件連番、D4重複なし、oracle非混入、threshold=20、Edax/eval SHAを検証するbase importを実装し、`--adopt-provenance`を禁止。
  - baseを初期値とするfinal-union phase waterfall・X/C 50%・opening 2% capを実装。親でselection planを一度確定し、master/8 shard plan SHAをrunKey/provenanceへ収録。resume用`--reuse-selection-plan`はplan SHA/件数を検証して再選定しない。
  - provenanceを`baseCorpus`/`incrementalGeneration`の2層に分離。各シャードは125,000件（reuse 25,000、新規100,000）、baseレコードはバイトコピー、新規positionIdは200000..999999。
  - shard mergeを全件dict保持からatomicなstreaming k-way mergeへ変更。verifierを500件batchのstreaming読込へ変更し、expanded1mでは先頭200kのバイト一致/SHAと2層provenanceも検証。
  - expanded1m workerのchildren生成を256件batch化し、1局面ごとのappend/flush/fsyncを維持。
- K=1回帰:
  - コマンド: `target/release/teacher_candidates.exe extract --data-dir <absolute train/data> --years 2000-2024 --seed 90103 --per-game-cap 6 --per-bin-cap 1 ...`
  - 結果: 340,531件、SHA-256 `7f486e57edea479e4b3b642bfdb4c10fadfc473b3aab2648478e48e996abd01e`で既存`candidates.json`と完全一致。
- selection-only probe:
  - コマンド: `python bench/edax-compare/gen_teacher_corpus.py expanded1m --dry-run --num-shards 8 --skip-extract`
  - 結果: 成功。候補プール1,306,421件。oracle/base除外後raw bin母集団=`[7,087, 123,994, 248,446, 277,472, 279,561, 276,646]`（計1,213,206）。累積opening cap適用後の実効bin母集団=`[7,045, 103,005, 171,458, 180,832, 180,826, 177,660]`（計820,826）。
  - 最終bin配分=`[11,680, 142,066, 210,519, 211,891, 211,890, 211,889]`、incremental配分=`[7,045, 103,005, 171,458, 172,831, 172,831, 172,830]`。ちょうどbase 200,000 + incremental 800,000 = 1,000,000件。
  - base重複除外93,188、oracle除外27、incremental canonicalKey重複0、最終oracle混入0。8シャードすべて125,000件、うちreuse 25,000件。
  - 未選択実効候補20,826件、目標比余裕率2.603%。推奨10%を下回るがtarget/全制約は成立。裁定どおりK=5へ自動変更せず、この実測を報告。
  - selection plan SHA-256: `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483`。最終generator SHAとの一致、および`--reuse-selection-plan`で親再選定なしのSHA検証成功。
- base固定値:
  - expanded200k JSONL SHA-256: `412477e2da6bacb0d715c7e5d02447d37b6e981237f64f221013a8eb465690e9`
  - manifest SHA-256: `89c3cd33ec491c0aa55b2c4d0165b0785a5b8f3df08674b5107caffc4b223f4c`
- ハードウェア事前ゲート実測（2026-07-17 15:03 JST）:
  - Cドライブ空き152,778,633,216 bytes（約142.28 GiB）、必須8 GiB以上: PASS。
  - 物理RAM 16,480,571,392 bytes（約15.35 GiB）、測定時available 6,356,180,992 bytes（約5.92 GiB）。見積peak 6 GiB。親probe完走、workerはchildren 256件batch・各自100k planのみ保持する構成。
- 受け入れテスト（最終コード）:
  - `cargo test -p train`: PASS（unit 56 + subset 3 + real_data 1、失敗0）。
  - `python -m pytest bench/edax-compare/ -q`: PASS（43 passed）。
  - `python bench/edax-compare/test_teacher_corpus.py`: PASS（27 tests）。
  - `git diff --check`: PASS。
- コミット: 未実施（環境の`.git`書込み禁止）。オーケストレーターが変更対象4ファイルを`(T127a)`でコミットする。

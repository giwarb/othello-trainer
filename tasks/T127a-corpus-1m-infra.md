---
id: T127a
title: 1Mコーパス基盤(K拡張・入れ子選定・スケール堅牢化)
status: redo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 1
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

### 2026-07-17 redo #1(codex-review・verifierが同一ブロッカーを独立検出)

レポート: tasks/review/T127a-corpus-1m-infra-codex-review.md(必読)。主要実装(K=4・base包含・selection plan・streaming)は両検証とも「正しく機能」と確認済み。以下のみ修正:

1. **[重大・必須] expanded1mのresume時に実行環境SHAが検証されない**: `_expanded1m_settings_and_meta()`(gen_teacher_corpus.py:1493-1531)が selection plan metaの保存値(`incremental["generatorSha256"]`等)をそのまま「現在値」として使うため、plan確定後に gen_teacher_corpus.py / teacher_candidates.exe / Edax本体 / eval.dat が変わってもresumeが拒否されない。**修正: 通常経路(1089行)と同様に `harnessSha256`/`teacherCandidatesToolSha256`/`edaxSha256`/`edaxEvalDataSha256` を毎回実ファイルから再計算して現在値とし、さらにplan記録値との一致を検証(不一致は明確なエラーで停止)**。回帰テスト: 「planと現在ファイルのSHA不一致でresume/起動が拒否される」ことをテストで固定。
2. **[中・必須] 自動テストによる制約固定**(review (b)1): K=1互換(SHA一致)とexpanded1m選定の主要制約(1M件・base prefix・bin配分・XC/opening累積判定)を、外部実データに依存しない合成フィクスチャの自動テストで固定する(現状は手動probe頼み)。
3. **[中・必須] verifierの独立検証**(review (b)2): verify_teacher_corpus.pyがexpanded1mの固定1M件数・base 200k prefixのSHA/バイト一致・2層provenanceを**manifestの自己申告でなく実データから**検証するようにする。
4. **[中・必須] childrenバッチ返却件数の即時検証**(review (b)3): `zip(positions_batch, children_batch)`(1636-1637行)に長さ一致assertを入れ、不足時は即時エラー(サイレントなレコード欠落を防ぐ)。

修正後: 3スイート全パス+K=1回帰SHA一致+probe再実行(plan SHAが変わる場合は新SHAを記録)まで確認して完了報告。既存probe結果のselection planは、修正でplan形式が変わらない限り再利用してよい(変わる場合は再生成し新SHA記録)。

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

### 2026-07-17 15:47 JST — Codex 実装ワーカー（redo #1）

- 実施内容:
  - expanded1m shard起動/resume時に、generator・`teacher_candidates.exe`・Edax・eval.datのSHA-256を実ファイルから毎回再計算し、selection plan記録値と照合。不一致時は生成開始前に明示エラーで拒否し、checkpoint identityにも保存値でなく実測値を渡すよう修正。
  - expanded1m children 256件batchの入力件数と返却件数を直後に比較し、不足・過剰時はzip処理前に即時エラーとした。
  - K=1が旧実装と同じ1回の乱数呼出し・同じ次RNG状態を保つRust単体テスト、およびK>1の決定性・重複なしテストを追加。
  - 外部実データに依存しない合成fixtureで、baseを含む最終件数、waterfall bin配分、X/C 50%、opening累積cap、base/oracle/重複canonicalKey除外を自動テスト化。
  - expanded1m verifierを固定1,000,000件・reuse 200,000件・既知base JSONL/manifest SHA・先頭200kバイト/SHA一致・2層provenanceへ強化。candidate pool、master/8 shard selection plan、generator、candidate tool、Edax、eval、oracleの各SHAを実ファイルから独立照合する合成fixtureテストを追加。
- SHA/resume回帰:
  - planと現在generator SHAの不一致で`expanded1m execution SHA mismatch ... generation/resume refused`となるテストを追加。現在planでの実測照合成功。
  - 現在SHA: generator=`cf5b9815d2991d52f6992ce751c65b4cccd4b3aa5042341eff836bf9f24b5ab5`、teacher_candidates=`5013cf984db7b2bde27d5861f848c86656420329261d3d6e8fd3c1347a7d5ca2`、Edax=`aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1`、eval.dat=`f8b2299612d9fa4414157e70e932636e33111c2602d0c2fc382a7d90ef21b792`。
- K=1回帰:
  - `cargo build --release -p train --bin teacher_candidates`: PASS。
  - `target/release/teacher_candidates.exe extract --data-dir C:\Users\yoshi\work\othello-trainer\train\data --years 2000-2024 --seed 90103 --per-game-cap 6 --per-bin-cap 1 ...`: 340,531件。既存`candidates.json`とSHA-256 `7f486e57edea479e4b3b642bfdb4c10fadfc473b3aab2648478e48e996abd01e`で完全一致。一時出力は削除済み。
- selection-only probe再実行:
  - `python bench/edax-compare/gen_teacher_corpus.py expanded1m --dry-run --num-shards 8 --skip-extract`: PASS（193.1秒、終了コード0）。ちょうどbase 200,000 + incremental 800,000 = 1,000,000件。
  - 候補プール1,306,421件。base/oracle除外後raw bin母集団=`[7,087, 123,994, 248,446, 277,472, 279,561, 276,646]`、opening cap適用後=`[7,045, 103,005, 171,458, 180,832, 180,826, 177,660]`。
  - 最終bin配分=`[11,680, 142,066, 210,519, 211,891, 211,890, 211,889]`、incremental配分=`[7,045, 103,005, 171,458, 172,831, 172,831, 172,830]`。base除外93,188、oracle除外27、incremental重複0、未選択20,826、余裕率2.603%。K=5へ自動変更せず停止方針を維持。
  - selection plan SHA-256は従来と同じ`2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483`。`--reuse-selection-plan`によるmaster/8 shard plan SHA・各125,000件（reuse各25,000件）検証もPASS。
- ハードウェア再実測（plan meta、2026-07-17 15:42:37 JST）:
  - Cドライブ空き152,631,750,656 bytes（約142.14 GiB）、必須8 GiB以上: PASS。
  - 物理RAM 16,480,571,392 bytes（約15.35 GiB）、available 6,237,220,864 bytes（約5.81 GiB）、見積peak 6 GiB。親probeは完走し、workerはchildren 256件batch・各100k plan保持設計。
- 受け入れテスト:
  - `cargo test -p train`: PASS（unit 56 + teacher_candidates 2 + subset 3 + real_data 1、失敗0）。
  - `python -m pytest bench/edax-compare/ -q`: PASS（46 passed）。
  - `python bench/edax-compare/test_teacher_corpus.py`: PASS（30 tests）。
  - `git diff --check`: PASS。
- コミット: 未実施（環境の`.git`書込み禁止）。オーケストレーターが変更対象4ファイルを`(T127a)`でコミットする。`tasks/`はコミット対象外。

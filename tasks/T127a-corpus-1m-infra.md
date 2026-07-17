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

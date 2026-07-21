---
id: T169
title: Edax寄せ(2/2): D1候補の対局ゲート(vs 現行本番v5、対Edax 60局paired)
status: todo
assignee: implementer
attempts: 0
---

# T169: D1候補の対局ゲート

## 目的

T168で確定したD1候補(V3+corner5x2、frozen MAE 4.492 vs 現行v5の4.703)が実対局で現行本番v5より強いかを判定する。

## 前提

- 候補: `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`(SHA-256 `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfffcf4caf20fc9`は転記ミス防止のため必ず `bench/edax-compare/t168_training_report.meta.json` のmanifestから読むこと。実測照合、不一致なら停止)
- baseline: 現行本番 `train/weights/pattern_v5.bin`(SHA `9ce0cc05...`、実測照合)
- プロトコル・開幕・Edax: T158d/T162/T166と完全同一。ハーネス: `vs_edax.py`(変更禁止)

## 実行

1. **baseline再利用のスポットチェック(T168レビュー申し送り)**: 現HEADビルドで `--opening-limit 3`(6局)をv5重みで実行し、T166の候補C結果(`endgame-results/t166-c-vs-edax-results-full.json`、ローカル)の先頭6局とmargin・plies・moves(move/nodes/discDiff)を突合。**完全一致ならT166のC 60局データをbaselineとして再利用**(根拠をレポートに)。1つでも不一致なら v5 baseline 60局を新規実行。
2. **D1候補60局**: PWV6読込時のscalar有効表示を事前確認のうえ実行。
3. 逐次・専有・detached+ツール呼び出しポーリング(Monitor通知依存禁止)、1局ごとcheckpoint、作業ログ節目追記。

## 事前登録の判定規準

1. 主指標: 対v5の開幕単位paired比較(n=30): 平均石差差・paired bootstrap 95%CI(決定的seed・10万回、配列並び順をmetaに明記)・符号検定。
2. **採用提案**: CIが0より完全に上(有意改善)かつ異常0件 → 採用提案(**ただし配信サイズgzip 10.7MB vs 現行5.9MBのトレードオフをユーザー裁定事項として明記**。有意でなければ現行v5維持=サイズ増を正当化しない)。
3. **wall保険・時間の両アーム比較**(NPS-21%の影響確認): 各アームの1局所要時間・wall保険発火の有無をログから集計し記載。
4. exactFallback等の集計定義明記。

## レポート

`bench/edax-compare/t169_gate_report.md`(+`.meta.json`)。結果表・paired統計・baseline再利用根拠(または再実行理由)・時間比較・規準当てはめ。

## スコープ外

- 本番配線(採用裁定後の別タスク)・engine/train変更

## 受け入れ基準

1. 候補60局完走(+baselineの再利用根拠または新規60局)、レポート+metaに全統計・SHA検証・規準当てはめがある
2. 異常0件、統計は決定的に再現可能
3. 既存ファイル(t166系・t168系ほか)不変
4. 完了時 `git status --short` クリーン(レポートはパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

(ワーカーが節目ごとに追記)

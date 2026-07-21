---
id: T166
title: canonical候補3つの対局ゲート(対Edax 60局×4本)と新本番の選定材料確定
status: todo
assignee: implementer
attempts: 0
---

# T166: canonical候補の対局ゲート

## 目的

T165で確定した3候補(A=WTHOR v4-canonical、B=Egaroucid全量v4-canonical、C=Egaroucid全量B3-canonical)を、現行本番v4と共通相手方式(対Edax)で対局させ、**新本番の選定材料を確定**する。D4対称性修正はユーザーの重大バグ指定なので、「明確に弱くならない限りcanonical系へ移行する」前提の測定(事前登録規準は下記)。

## 前提

- manifest: `bench/edax-compare/t165_training_report.meta.json`(候補3つのパス・SHA-256、比較相手=`train/weights/pattern_v4.bin`)。実行前に4重み全てSHA実測・照合。
- プロトコル・開幕・Edax設定: **T158d/T162と完全同一**(t158c_screening_report.meta.json の deferredT158d 節)。ハーネス: `vs_edax.py`(変更禁止)。
- **v4 baselineは再実行する**(T165レビュー申し送り(c): eval_cliバイナリがT163/T164で変わっており、wall保険の発火タイミング差で「理論上同一」が成立しないため、T158dの結果を再利用しない。現HEADビルドで新規60局)。
- **PWV6事前確認**(レビュー申し送り(b)): 候補C(PWV6)をeval_cliに読ませた際にscalar特徴が有効である旨の表示(stderr等)を対局開始前に確認し記録する。

## 実行(60局×4本、逐次・専有、計約1時間)

1. v4 baseline(現行本番重み、現HEADビルド)
2. 候補A(WTHOR v4-canonical seed2)
3. 候補B(Egaroucid v4-canonical seed3)
4. 候補C(Egaroucid B3-canonical seed1)

各60局(primary 30ペア)、1局ごとcheckpoint・resume、Start-Process detached+ツール呼び出しポーリング(Monitor通知依存禁止)。

## 事前登録の判定規準(結果を見てから変えない)

1. **主指標**: 各候補について、対v4 baselineの開幕単位paired比較(n=30): 平均石差差・paired bootstrap 95%CI(決定的seed・10万回)・符号検定。**bootstrap配列の並び順をmetaに明記**(T162 verifier申し送り)。
2. **選定**: 候補間の優先順位は「対v4 paired平均差の点推定が最大のもの」。参考として候補間の直接paired差(共通相手方式で同一開幕データから算出可能)も全ペア分記載。
3. **採用提案の規準**: 選定候補が (a)対v4で有意に劣らない(CIが実質的悪化〔平均-2石超かつCI全体が0未満〕を示さない) (b)異常0件 → **新本番候補として採用提案**。全候補が(a)を満たさなければ提案なしでエスカレーション(採否の最終裁定は常にオーケストレーター+ユーザー)。
4. exactFallback等の集計は定義を明記。watch-point: 候補Cのスカラー特徴が実際に効いていること(前提確認の記録)、終盤入口の異常な石差急落の有無。

## レポート

`bench/edax-compare/t166_gate_report.md`(+`.meta.json`): 4本の結果表・3候補のpaired統計・候補間参考差・判定規準への当てはめ・SHA検証・所要時間。

## スコープ外

- 本番配線(WASM側のPWV5/PWV6対応・ANALYSIS_ENGINE_VERSION繰り上げ・Pages確認は次タスクT167)
- vs_edax.py・engine・trainの変更

## 受け入れ基準

1. 4本×60局完走、レポート+metaに全統計・SHA検証・規準当てはめがある
2. 異常(クラッシュ・非法手・非決定性)0件
3. 統計はmetaから決定的に再現可能(配列並び順の明記込み)
4. 既存ファイル(t158d/t162/t165系)の値を変更していない
5. 完了時 `git status --short` クリーン(レポートはパス明示コミット、生ログはgitignore領域。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 対局は専有(他の重い処理と並行しない)。作業ログ節目追記(1本完了ごと)

## 作業ログ

(ワーカーが節目ごとに追記)

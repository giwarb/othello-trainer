---
id: T165
title: canonical全量再学習(3構成×3seed) — 重大バグ修正(3/3)+Egaroucid全量
status: todo
assignee: implementer
attempts: 0
---

# T165: canonical全量再学習

## 目的

T163/T164で整備したD4 canonicalスキームで、本番候補となる3構成を本学習する。ユーザー裁定: D4修正は重大バグ、Egaroucid全量は「数の暴力」検証。最終優劣は次タスクT166の対局ゲートで判定する(oracle・frozen MAEでの採否判定はしない)。

## 前提修正(軽微、最初にやる。T164レビュー申し送り)

1. `to_bytes_v5`にscalar空チェック(`assert!(scalar_feature_weights.is_empty())`)+テスト(レビュー軽微2。canonical+scalarモデルの誤経路でscalar重みが黙って落ちる穴)。
2. `write_feature_distribution`の`split`ラベルがsimple-corpus経路でもWTHOR文言にハードコードされている誤記を修正(レビュー軽微4)。

## 学習マトリクス(3構成×3seed=9run、すべて`--canonical --early-stop`)

| 構成 | データ | config | 出力形式 | 見積り/run |
|---|---|---|---|---|
| A | WTHOR全74,024局(既定経路) | v4 | PWV5 | 10-15分 |
| B | Egaroucid全量25,514,097行(--simple-corpus、--simple-max-records未指定=全量) | v4 | PWV5 | 15-30分 |
| C | 同上 | t158-b3 | PWV6 | 15-30分 |

- seeds: 1,2,3。`--early-stop-patience 3 --max-epochs 30`(val-percent既定5)。
- **output-dirは構成ごとに新規ディレクトリで分離**(train/data/t165/{wthor-v4,egaroucid-v4,egaroucid-b3}/ 等。feature-distribution.jsonの上書き防止+旧成果物流用によるidentity不一致回避、レビュー申し送り4・5)。
- 全量B/Cの初回1runでメモリ(想定0.8-1.2GB、T159b実測準拠)と1エポック時間を確認してから残りを続行(異常があれば停止・報告)。
- 逐次実行(並行禁止)、detached+ツール呼び出しポーリング、epoch単位checkpoint/resume(既存機構)、進捗ログ。

## 事前登録の判定・選定規準(結果を見てから変えない)

1. **構成内のseed選定**: 各構成でfrozen MAE最小のseedを候補に確定(タイは小さいseed番号)。ゲート結果を選定に使わない。
2. **構成間の比較はしない**: WTHOR構成(対局ホールドアウト)とEgaroucid構成(局面ハッシュ分割)はfrozen母集団が異なるため、frozen MAEの横並び比較は無効(レビュー申し送り1)。レポートには「構成間比較は無効」と明記。最終優劣はT166の対局ゲート。
3. **健全性チェック(足切りのみ)**: 各runで(a)val_mae推移が発散していない (b)学習済み重みの全8対称一致(数十局面サンプルで確認) (c)係数finite。不合格runは候補から除外し理由記録(全滅なら停止・報告)。
4. **決定性確認**: 全9runのSHA再実行確認は高価なため、**構成Bのseed1のみ**同一コマンド再実行でSHA-256一致を確認(レビュー申し送り3の縮退)。

## レポート

`bench/edax-compare/t165_training_report.md`(+`.meta.json`): 9runの表(epochs_run/best_epoch/val_mae/frozen_mae/所要時間/重みSHA-256)、候補3つ(構成A/B/C各1seed)のhash確定、T166向けmanifest(候補パス・SHA・比較相手=現行本番pattern_v4.bin)。val/frozenの経路差(対局単位vs局面単位、リークバイアス)の注記。metrics.json内configフィールドが素名である点に留意し、集計はファイル名/run_name基準で(レビュー申し送り4)。

## スコープ外

- 対局ゲート・採否・本番配線(T166)
- WASM側変更

## 受け入れ基準

1. 9run完走(またはre-run済み)、レポート+metaに全表・候補3つのSHA・manifestがある
2. 健全性チェック(対称一致含む)の結果が全runぶんある
3. 構成B seed1の決定性(SHA一致)確認記録がある
4. `cargo test -p train` `cargo test -p engine` 全パス(前提修正2件のテスト込み)
5. 完了時 `git status --short` クリーン(重みはgitignore領域、レポートはパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 学習中は他の重い処理と並行しない。作業ログ節目追記(run完了ごと)

## 作業ログ

(ワーカーが節目ごとに追記)

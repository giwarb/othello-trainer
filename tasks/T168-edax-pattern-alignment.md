---
id: T168
title: パターン切り方のEdax寄せ(1/2): 形状追加+Egaroucid全量学習+スクリーニング
status: todo
assignee: implementer
attempts: 0
---

# T168: Edax寄せ — 形状追加と学習

## 目的

現本番v5(V3構成38インスタンス+scalar2種、対Edax lv10で-6.75石)とEdaxのパターン構成の差分を埋める実験。explorer調査(2026-07-21)の結論: Edaxの47feature(13種)との主差分は **①隅2x5ブロック(corner5x2、既存ablation実装あり・T087旧学習法で不採用のまま) ②短対角4(diag4、未実装) ③定数項(バイアス、未実装)** の3つ(隅3x3・edge2X・各ライン・対角5-8は搭載済み)。B3特徴がT158不採用→T166本採用に転じた前例のとおり、新体制(Egaroucid全量25.5M+canonical+早期打ち切り)で再評価する。

## 実験構成(2構成×3seed、いずれもcanonical+scalar=PWV6・61段)

| 構成 | パターン | 追加分の内容 |
|---|---|---|
| D1 | V3 + corner5x2(計46インスタンス) | 既存`corner5x2_patterns()`(patterns.rs:208-217)を含む新PatternConfig variant |
| D2 | V3 + corner5x2 + diag4 + 定数項 | diag4=長さ4の短対角(`diagonal_offset_patterns`の長さ4版、4インスタンス)。定数項=新ScalarFeatureKind::Constant(値=常に1、scale=1、61段の段別バイアスとして学習) |

- scalar特徴は現行の2種(モビリティ・囲い度)+D2のみ定数項。
- 学習: Egaroucid全量(--simple-corpus、T165と同一データ・同一分割)、`--canonical --early-stop --early-stop-patience 3 --max-epochs 30`、seeds 1/2/3。output-dirは新規(train/data/t168/{d1,d2}/)。
- **サイズ留意**: corner5x2は10マス形状のため重み+約13.7MB(27→41MB級、gzip後も増える)。実測サイズ(raw/gzip)を記録(採否判断の材料。ブロッカーではない)。

## 実装要件

1. `engine/src/patterns.rs`: 新PatternConfig variant 2つ(V3Corner5x2 / V3Corner5x2Diag4等、命名は既存に合わせる)+diag4生成関数(**既存方針どおりsymmetry_orbitベース、手書きセル列禁止**)+インスタンス数/クラス数の固定回帰テスト(t087_ablation前例)。canonical機構(compute_pattern_classes/build_canonical_index_table)は形状非依存で自動対応(explorer確認済み)だが、新形状込みの全8対称一致テストを追加。
2. `engine/src/pattern_eval.rs`: ScalarFeatureKind::Constant追加(値=1固定、対称不変は自明だがテストに含める)。schema_hashは形状から自動で別スキーマになる(確認のみ)。
3. `train/src/bin/train_patterns_v3.rs`: 新config(t168-d1 / t168-d2)登録。identity・feature_schema追従。
4. **既存経路の完全不変**(いつもの方式: 小規模スモークで既存configの重みSHA-256一致)。
5. `cargo test -p engine` `cargo test -p train` 全パス。

## 学習・スクリーニング要件

6. 2構成×3seed=6run(逐次、detached+ツール呼び出しポーリング、Monitor通知依存禁止、epoch checkpoint、run完了ごとに作業ログ追記)。
7. **事前登録の選定規準**: D1/D2はT165と同一データ・同一分割なので**frozen MAEの構成間比較が有効**(T165のB/C=4.81/4.70とも比較可能)。全6run+T165のC(4.703)を並べ、(a)各構成のベストseed=frozen MAE最小 (b)**最終候補=frozen MAEが現本番構成C(4.702778)より改善している構成のうち最小のもの1つ**。改善構成がなければ「形状追加は効果なし」を結論として対局ゲートに進まない(それも正当な結果)。
8. 健全性チェック(T165と同じ: 発散なし・finite・学習済み重みの全8対称一致サンプル確認)。NPS参考測定(ゼロ係数でよい、8局面ベンチ流用、専有タイミングで)。
9. レポート: `bench/edax-compare/t168_training_report.md`(+meta)。6run表・T165比較・候補確定(または撤退)・サイズ実測・NPS参考値・T169ゲート用manifest。

## スコープ外

- 対局ゲート・採否・本番配線(T169以降。候補が出た場合のみ)
- 11マス以上の形状(PatternCells上限10)・Edax仕様の一次ソース照合

## 受け入れ基準

1. 両パッケージ全テストパス(新規テスト込み)、既存経路不変の実証あり
2. 6run完走、レポートに全表・事前登録規準の当てはめ・候補確定(または撤退根拠)がある
3. 健全性チェック・サイズ実測・NPS参考値の記録がある
4. 完了時 `git status --short` クリーン(パス明示コミット、`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 学習・NPS計測は専有。作業ログ節目追記

## 作業ログ

(ワーカーが節目ごとに追記)

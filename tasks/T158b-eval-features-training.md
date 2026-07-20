---
id: T158b
title: 評価特徴追加(2/4): trainer拡張とpilot/full学習(Gate 2/3判定)
status: redo # codex-review不合格(2026-07-21): Gate 3のstage別判定が帯集約に置換されていた。下記フィードバック参照
assignee: Codex gpt-5.6-sol
attempts: 1
---

# T158b: trainer拡張と学習

## 目的

設計レポート(tasks/design/T158-eval-features-report.md §(c)T158b節・§7・§8、裁定は同request.md冒頭)の第2段。**train側にスカラー特徴の同時学習を追加**し(T158aのPWV4・特徴primitiveを利用)、**180k pilot(B0-B3)→Gate 2判定→最良1構成のみfull 443万×3seed→Gate 3判定**まで実施する。

## 要件

1. **trainer拡張**(train/src/regression.rs + train_patterns_v3.rs): scalar特徴のprediction共通化(engine側の特徴関数を呼ぶ、train側で再実装しない)。**勾配は必ず loss_gradient × 特徴値 + L2**(設計§7.1の明示的警告)。B0(特徴なし)/B1(mobilityのみ)/B2(exposureのみ)/B3(両方)のconfig。PWV4入出力。**既存config・run identity・PWV3出力は完全不変**(新configのみ新identity schema)。ゼロ初期化・warm-startなし(設計§7.2)。
2. **特徴分布統計**: 学習前にWTHOR train splitの特徴分布(P50/P95/P99/max)を出し、scale(/8, /32)の妥当性を確認・記録(明らかに不適切な場合のみ2の累乗内で変更し理由記録)。
3. **pilot(Gate 2)**: WTHOR層化180kサブセット・seed1・B0-B3・20epoch・既存対局単位frozen split。**事前登録判定(裁定23)**: 全体frozen MAEがB0比-0.05石以上改善・game単位paired bootstrap改善方向・stage帯別に+0.10石超の局所悪化なし・係数finite/隣接stage極端振動なし。in-corpus/train lossは診断記録のみ(昇格条件に使わない)。
4. **full(Gate 3)**: pilot最良1構成のみ。WTHOR全74,024局・約443万サンプル・3seed・20epoch・現行v4と同じsplit/shuffle規約・corpus hash固定。判定: 3seed平均frozen MAE -0.05石以上・**2/3seed非悪化必須**・game単位paired bootstrap改善方向・stage別重大退行なし。
5. **長時間実行**: epoch単位checkpoint/resume(PWV4 checkpoint+identity+epoch+件数+seed)。detached起動+ツール呼び出しポーリング(**Bashバックグラウンド・Monitor通知依存は禁止**=不達実績)。進捗ログ必須。pilot各run数分・full各run十数分想定。
6. **レポート**: bench/edax-compare/t158b_training_report.md(+meta)にB0-B3比較表・Gate 2/3判定・分布統計。学習成果物(重み)はgitignore領域(train/data/t158/)、**train/weights/には置かない**(採用裁定前)。

## スコープ外

- oracle/スモーク/NPSスクリーニング(T158c)、対局ゲート・本番採用(T158d、後回し)
- engine側の変更(T158a完了済み。必要な小修正が出たら報告のうえ最小限)

## 受け入れ基準

1. `cargo test -p train` 全パス(新規テスト込み: 単一sample収束・round-trip・resume同一性・特徴なしconfig不変)。`cargo test -p engine` も全パス(engine側を触った場合)
2. Gate 2(pilot B0-B3)とGate 3(full 3seed)の全判定基準の数値と合否がレポートにある(不合格も正当な結果=その場合fullへ進まず理由記録)
3. 既存WTHOR経路の完全不変が担保されている(識別文字列・出力形式・小規模スモークの一致等、方式は前例T155に倣う)
4. 変更ファイル一覧と検証結果を完了報告に明記(コミットはオーケストレーター代行)。一時ファイル・重みの誤配置なし

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。学習中は他の重い処理と並行しない

## フィードバック(redo #1、2026-07-21 codex-review不合格による)

レビュー(tasks/review/T158b-eval-features-training-codex-review.md)。学習・数値自体は問題なし。修正点(再学習不要):

1. **[ブロッカー] Gate 3のstage別再集計と両解釈の提示**: 現レポートは61段を5帯に集約した値(+0.014)のみで「stage別」判定を置換していた。空き数別(61段)のB3−B0を再集計し、(a)**seed別×空き数別**の最大悪化(現データでseed1 empty=43が+0.229等) (b)**3seed平均×空き数別**の最大悪化(+0.059)の両方をレポートに明記する。**オーケストレーター裁定(タスクファイル本節に記録)**: 判定単位は(b)=3seed平均の空き数別で+0.10以内を正とする(seed単体61段×3の+0.10適用は多重比較過剰のため)。この解釈確定が事後である旨をレポートに正直に記載し、(a)の悪化上位(seed・empty・値)を**T158cへの申し送り表**として添付する(T158cでseed別害検出を必須化する補償)。
2. **[中] 集計・bootstrapの再現スクリプトのコミット**: stage帯加重集計・100,000回paired bootstrapを再現するスクリプト(決定的)をbench/edax-compare/へコミットし、レポートの全数値がそこから再生成できるようにする。
3. Gate 3の総合合否を裁定基準で更新(現データなら合格見込みだが、再集計の結果に従う)。

## 作業ログ

(ワーカーが節目ごとに追記)

- 2026-07-21 01:01:03 +09:00 — trainer に B0～B3、engine 共通 scalar prediction、`loss_gradient * feature_value + L2` 更新、PWV4 checkpoint/final、T158 専用 identity/metrics、WTHOR train 特徴分布、epoch 進捗 flush を追加。単一 sample 勾配・収束、PWV4 round-trip、resume 同一性、特徴なし PWV3 同一性をテストした。
- 分布: WTHOR train 3,988,509 sample。mobility abs P50/P95/P99/max = 2/8/11/22、exposure = 7/23/32/71。scale `/8`, `/32` を維持。
- Gate 2: 層化 target 180,000（actual 179,969）、seed 1、20 epoch。B0/B1/B2/B3 frozen MAE = 17.931125/17.643484/17.769553/17.617524。B3 を選定（B0差 -0.313601、game bootstrap 95% CI [-0.339482,-0.296038]、全 stage 帯改善、係数 finite・説明不能な極端振動なし）。B3 epoch 18 保存中に中断し、完全な epoch 17 PWV4 checkpoint から resume 完走を実測。
- Gate 3: 全 74,024局、train 3,988,509 / frozen 442,995 sample、B0対照+B3のみ、3seed×20 epoch。平均 frozen MAE B0 15.952476 / B3 15.890416（差 -0.062059）、3/3seed改善、pooled game bootstrap 95% CI [-0.072528,-0.052858]、stage帯最大悪化 +0.014026 < +0.10。Gate 3 合格。成果物は `train/data/t158/` のみ。
- 実行・結果: `cargo build --release -p train --bin train_patterns_v3` PASS、pilot/full コマンド完走、`python -m json.tool bench/edax-compare/t158b_training_report.meta.json` PASS、`cargo test -p train` PASS（全 test、lib 91件を含む）。engine側は未変更のため engine/FFO test は対象外。
- レポート: `bench/edax-compare/t158b_training_report.md` と `.meta.json` を作成。コミットは `.git` 書き込み禁止のため未実施（オーケストレーター代行待ち）。

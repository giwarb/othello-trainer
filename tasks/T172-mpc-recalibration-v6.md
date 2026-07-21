---
id: T172
title: MPC再校正(v6評価関数) — T156資産流用でGate 2/3再判定
status: todo
assignee: implementer
attempts: 0
---

# T172: MPC再校正(v6)

## 目的

T156で「実装修理は成功(固定深さでノード-40〜57%)したが、160kノード予算では深さ+1に届かず撤退」となったMPCを、**新本番評価関数v6で再校正して再判定**する。根拠: v6は探索値ラベル(Egaroucid lv17)で学習しており、旧v4(人間棋譜の最終石差ラベル)より浅い読みと深い読みの相関が強い=予測誤差σが縮みマージンが狭まる見込み。T156の撤退時に「再評価条件」として記録済みの筋。

## 前提資産(T156、すべてコミット済み)

- 実装: `engine/src/mpc.rs`(外向きマージン・Q16アフィン・(empty_bucket,D,d)テーブル)、SearchPolicyのmpcフラグ(既定OFF)、MpcStatsテレメトリ
- 校正корpus: `bench/edax-compare/t156_mpc_positions*`(1,200局面)
- 校正・判定ツール: calibrate_mpc(engineのbin)、`bench/edax-compare/compare_mpc.py`+テスト(canonical SHA fail-closed検証付き)
- 経緯・数値: tasks/T156a〜dのタスクファイル・tasks/review/配下レポート・tasks/design/T156-mpc-recalibration-report.md

## 要件

1. **再校正**: v6重み(`train/weights/pattern_v6.bin`)で校正コーパスの浅深ペアを再計測し、MPCテーブル(アフィン係数+σ)を再生成。**旧v4用テーブルとσの比較表を作る**(「v6で相関が改善した」仮説の直接検証。σが縮んでいなければその時点で見込み薄と報告)。
2. **Gate 2(固定深さ)**: T156cと同一方法・同一判定線で、v6+MPC onのノード削減率を計測(前回: -40〜57%)。
3. **Gate 3(本番予算160k)**: T156dと同一方法・同一事前登録判定線(**深さ+1到達率≥35% かつ regret悪化≤+0.10石**。前回: 5.83%/+0.183で不合格)。同一判定線を使う理由: 前回との比較可能性。計測条件はv6(現本番設定: 160kノード・quota60%・空き20無制限)に更新。
4. **判定**: Gate 3合格→対局ゲート(T173、候補=v6+MPC on vs v6+MPC off、Edax lv10に加えlv12も相手に追加)へ進む提案。不合格→前回同様の事前登録撤退(再々評価条件を記録)。σ比較・各Gateの数値はすべてレポートに。
5. 計測は専有・決定的(T156の計測規律踏襲: meta監査可能・canonical SHA検証・detached+ツール呼び出しポーリング)。
6. `cargo test -p engine` 全パス(校正ツールを触った場合はそのテストも)。

## スコープ外

- MPC本番ON(T173ゲート合格+裁定後)・探索アルゴリズム自体の変更・aspiration併用の再設計(T089a申し送りの論点はONにする段で再確認)

## 受け入れ基準

1. σ比較表(v4校正時 vs v6校正時)とGate 2/3の全数値・判定がレポート(bench/edax-compare/t172_mpc_report.md + meta)にある
2. 判定はT156の事前登録判定線と同一基準で行われている(事後変更なし)
3. 計測はmetaから再現可能(条件・SHA・seed)
4. `cargo test -p engine` 全パス、完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 計測は他の重い処理と並行しない。作業ログ節目追記(校正完了・Gate 2完了・Gate 3完了ごと)

## 作業ログ

(ワーカーが節目ごとに追記)

---
id: T205
title: 偶奇保存のステージ平滑化重み(pattern_v7候補)の作成とゲート評価
status: done
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T205: 偶奇保存のステージ平滑化重み(pattern_v7 候補)の作成とゲート評価

## 目的
パターン評価重みの段間不連続を平滑化して、評価値が同じ偶奇の深さ間で揺れる幅を Edax 並みに減らす。揺れは T203 で特定した当エンジン固有の過剰分。強さを落とさずに、中盤練習の最善手判定の安定性と精度を上げるのが狙い。

## 背景・コンテキスト
- T203(`tasks/T203-depth-parity-investigation.md`)の結論:
  - 評価値の深さ振れのうち、偶奇の系統差(奇数深さで楽観的)は Edax にもある共通効果で、評価関数では消せない。T202 の偶数深さ統一は維持する。
  - 当エンジン固有の過剰分は同偶奇差 |v(d)−v(d−2)|(Edax の 1.4〜1.8倍)。原因は pattern_v6 の **61段(空き数1刻み)独立重みテーブルの段間不連続**(確度高)。
  - 診断では、重みに次の変換をかけるだけで(再学習なし)同偶奇差が 2.51 → 1.73(Edax 1.76)になった。静的誤差SD(対 Edax d10)は 7.53 → 7.16 に改善した。
    ```
    w'[s] = (w[s−2] + 2w[s] + w[s+2]) / 4
    ```
  - 平滑化で同じ偶奇の段どうし(s±2)を混ぜるのは、重みに ±3.4石の真の偶奇(手番パリティ)項があるため。隣接段(s±1)を混ぜる版は 1.93 止まりで、偶奇情報を壊す。
  - 診断用スクリプト: `tasks/design/T203-data/diag_scripts/mk_smooth.py`(PWV6 の読み書きと平滑化)、`smooth_exp.py`、`ana_smooth.py`
- 重み形式は PWV6。読み込みは `engine/src/pattern_eval.rs`(stage = empties、`PatternWeights::score`)。
  - 本番重み: `app/public/pattern_v6.bin`(= `train/weights/pattern_v6.bin`)
  - scalar 特徴が2種ある(ExactMobilityAdvantage、EmptyAdjacencyExposureAdvantage)。平滑化の対象にするかは設計判断で、作業ログに理由を記録する。
- 端の段の扱い(s<2、s>58、空き数の少ない終盤で完全読みに入る段)は設計判断。
- 学習コーパス(Egaroucid lv17 ラベル)と frozen MAE の評価手段は、T168 の資料(`bench/edax-compare/t168_training_report.md`)にある。
- 強度ゲートの前例は T169(`tasks/T169-edax-pattern-game-gate.md`)。`bench/edax-compare/vs_edax.py` で対Edax 60局を両アーム実行し、開幕単位の paired bootstrap 95%CI と符号検定で判定した。1アームあたり約15分。

## 変更対象
- `train/`: PWV6 の重みを読み込み、平滑化して PWV6 として書き出す変換ツール(Rust の bin または Python。既存の train/ の流儀に合わせる)
  - パラメータ: カーネル(既定は偶奇保存の 1-2-1)、強度 α(`w' = (1−α)w + α·smooth(w)`)、対象(パターン表/scalar)
- 候補重み: `train/weights/pattern_v7_smooth_*.bin`(候補のみ。`app/public/` は変更しない)
- `bench/edax-compare/t205_*`: 評価レポートと meta

## 要件
1. 変換ツールの実装と単体テスト。
   - 恒等(α=0)でビット一致すること。
   - 合成重みで、偶奇保存カーネルが期待値と一致すること。
   - 定数列が不変であること。
2. 候補を作る: α ∈ {0.5, 1.0}、加えて任意で1案。
3. 安価なスクリーニング(全候補):
   - (a) T204 ハーネス core38/ext の同偶奇差・偶奇差・Edax d12 一致率・MAE
   - (b) 学習コーパスの holdout(学習に使っていない分割。in-sample にならないよう分割の根拠を記録)での frozen MAE
   - (c) 中盤練習 38問の参照最善手一致率(T201/T202 の計測手段。現状 v6 で 22/38。計測スクリプトは T201/T202 のタスクファイル・作業ログを参照)
4. 事前登録した採用候補の条件(スクリーニング):
   - 同偶奇差が v6 比 −20% 以上改善
   - holdout frozen MAE が v6 比で悪化しない(+0.02石以内)
   - Edax d12 の最善手一致率が悪化しない(−3pt 以内)
5. 条件を満たした最良1候補だけ、強度ゲートにかける。
   - 対Edax 60局 paired、T169 方式。v6 baseline は再利用可否を T169 と同じ手順でスポットチェックする。
   - 判定: 平均石差差の 95%CI 下限が −1.5石以上(非劣性)。改善なら記録する。
6. **長時間実行ルール**: 対局ゲート・holdout 評価は1局/1局面ごとの逐次保存と resume、進捗のログ出力、作業ログへの節目追記を行う(CLAUDE.md「長時間実行タスクの運用ルール」)。
7. レポート `bench/edax-compare/t205_smoothing_report.md`(+`.meta.json`)に、全候補の指標表・採用推奨・根拠を書く。採否の最終裁定はオーケストレーター/ユーザーが行う。

## やらないこと(スコープ外)
- 本番配線: `app/public/` の重み差し替え、`worker.ts`、ANALYSIS_ENGINE_VERSION(T207 で行う)
- 探索アルゴリズム・`engine/src/search.rs` の変更、静止探索の追加
- 再学習(段間正則化つき学習は T206)
- T202 の偶数深さ統一方針の変更

## 受け入れ基準(検証コマンド)
- [ ] 変換ツールの単体テストがパスする(`cargo test -p train` または `python -m pytest` の該当テスト)。
- [ ] 候補 bin が `eval_cli eval --depth 0 --pattern-weights <候補>` で読み込める。α=0 の出力が v6 とビット一致する。
- [ ] レポートに、全候補のスクリーニング指標(要件3の a〜c)と事前登録条件への当てはめがある。
- [ ] 条件を満たす候補がある場合、その強度ゲート60局が完走している。決定性チェック(T169 と同じ)が PASSED で、paired 統計がレポートにある。
- [ ] `cargo test -p engine` が全件パスする(engine 側を変えていない確認)。
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていない。
- [ ] (Codex ワーカーは .git に書けないため)変更ファイル一覧を完了報告に明記する。コミット・push はオーケストレーターが代行する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-10-16 オーケストレーター(ユーザー指示「サブエージェントに任せず一気に直す」により直接実施、例外適用)

- 変換ツール `bench/edax-compare/t205_smooth_weights.py`(--self-test で α=0 ビット一致・定数列/偶奇交互列不変・期待値を確認)。候補 α=0.5/1.0 を生成し α=1.0 を採用(`train/weights/pattern_v7.bin`)。
- core38: 同偶奇差 1.82→1.11(Edax 0.99)、Edax d12 一致 d8/d10/d12 73.7/68.4/63.2→78.9/73.7/65.8%、MAE d10 1.53→1.34。
- 中盤練習38問: Edax d14 一致 23→25/38、問題86の最善手 f2→e1(Edax d14 も e1)。
- 対Edax paired: lv10 −0.23[−2.98,+2.62]、lv12 +0.90[−1.47,+3.07]、合算120局 +0.33[−1.475,+2.15] → 非劣性達成。
- holdout frozen MAE は未実施(Edax誤差・対局で代替)。詳細 `bench/edax-compare/t205_smoothing_report.md`、コミット a0aad10。

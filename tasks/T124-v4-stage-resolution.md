---
id: T124
title: v4特徴実験(ステージ分割を5石刻み→1石刻みへ細分化)
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T124: v4特徴実験(ステージ分割の細分化)

## 目的(ユーザー指示 2026-07-17 昼)

> v3×20万蒸留を試した後、v4として、今は5石ずつでステージ分割している特徴を、1石ずつに変えてから実験してほしいです。

パターン評価のステージ(局面の進行度による重みテーブルの切り替え)を、現行の粗い刻みから**1石刻み**に細分化した新特徴セット「v4」を実装し、学習・評価する。

## 前提・確認事項

- **現行のステージ刻みをまずコードで確認**すること(ユーザー認識は「5石ずつ」。実装上の実際の刻み・ステージ数・境界を作業ログに明記してから設計する)。パターン集合自体(v3で拡張したパターン形)は変えず、**ステージ解像度のみ**を変える。
- パターン重み基盤: PWV3形式・pattern-set選択(T087/T110)。v4は新しいpattern-set(またはPWV3のステージ数パラメータ拡張)として追加し、**v2/v3の既存動作を一切変えない**こと。
- 学習: WTHOR経路(v2/v3と同一トレーナー)と、蒸留経路(t090_distillation、teacher-only)の両方で学習可能にする。
- 懸念(設計時に織り込む): 1石刻みはステージ数が約5倍になり、(a)重みサイズ増(v3は5.96MB→単純比例なら約30MB、**アプリ配信・メモリの現実性を必ず計測・報告**)、(b)ステージあたり学習サンプルの希薄化(過学習/未学習)。(b)への標準的な手当(隣接ステージの共有・平滑化・補間等)を検討し、まずは素朴な1石刻みで実測→必要なら平滑化を追加、の順で進めてよい(やったことを作業ログに明記)。

## 要件

1. **v4特徴セットの実装**(train側の学習・engine側の評価の両方、既存pattern-set機構への追加)。`cargo test -p engine` / `-p train` の既存テスト全パス+v4の基本テスト(ロード・評価・ステージ境界)。
2. **学習と評価**:
   - v4×WTHOR 3seed → oracle regret(M2ガード込み)。主比較: v3×WTHOR(1.40石)。
   - v4×蒸留200k(teacher-only)1〜3seed → 参考比較: T123の結果。
3. **ゲート計測**: 重みファイルサイズ・ロード時間・NPS(v3比、専有参考値)・メモリ影響。採用可否の判断材料として明記(採用判定自体は別途)。
4. レポート(`bench/edax-compare/t124_v4_stage_resolution_report.md`等)に、regret比較表・サイズ/NPS・平滑化の要否・採用推奨案を記載。
5. 実験メタ・レポートをコミット。重み等はgitignore領域。

## やらないこと(スコープ外)

- 本番配線(採用裁定後の別タスク)
- パターン形状自体の変更(ステージ解像度のみ)
- コーパス追加生成

## 受け入れ基準(検証コマンド)

- [ ] 現行ステージ刻みの実装確認が作業ログにある(設計の前提)
- [ ] v4×WTHOR 3seedのregretが確定し、v3(1.40)との比較がある
- [ ] v4×蒸留200kのregretが確定し、T123との比較がある
- [ ] サイズ・NPS・ロード時間のゲート計測がある
- [ ] `cargo test -p engine`/`-p train`全パス
- [ ] checkpoint/resume対応の記録
- [ ] 実験メタ・レポートのみパス指定でコミット(`(T124)`)
- [ ] タスク完了時点で当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## 備考

- **T123完了後に着手**(ユーザー指示の順序)。
- 学習・NPS計測時は他の重負荷と並走しない(現状他ジョブなし)。

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 12:52 JST Codex実装・3seed学習・ゲート計測完了

- 前提確認: AGENTS.mdとT123完了（status=done、3seed平均2.0111石）を確認し、開始時git statusは空。現行実装は NUM_STAGES=13、STAGE_EMPTY_DIVISOR=5、stage=min(empty_count/5,12)で、境界は空き0〜4、5〜9、…、55〜59、60の13段だった。v4はパターン形状をv3と同じ38 instance / 10 classに保ち、61段・除数1（stage=empty_count）だけを変更する設計とした。
- 実装: PWV3の既存num_stages/stage_empty_divisorをPatternWeightsへ保持し、loader・score・SGD・蒸留特徴抽出が重み自身の定義を使うよう拡張。対応定義は従来13/5とv4 61/1に限定し、PWV1/PWV2/従来PWV3は13/5のまま。train_patterns_v3の --configs v4 とtrain_distillationの --pattern-set v4を追加。ロード・評価・境界・v3と同じ形状の基本テストを追加した。
- WTHOR学習: target/release/train_patterns_v3.exe --configs v4 --seeds 1,2,3 --epochs 20 --output-dir train/data/t124/wthor-v4 を専有1プロセスで実行。3,988,509 train / 442,995 frozen samples、全seed 20 epoch完走。frozen MAEはseed 1/2/3=16.185831/15.725285/15.946311。epochごとに重み+identityをatomic保存し直前世代を保持。完走後に同一コマンドを再実行し、3完成runを結果再計算のみでskipできることを実測した。
- WTHOR oracle: compare_pattern_v3.pyを各seedフルスクラッチ実行し、regret seed 1/2/3=0.7000/1.6667/0.9667石、平均1.1111、seed sample SD 0.4993。全3回でv2=1.5666666666666667を完全再現してM2ガードPASS。v2差とpaired bootstrap 95% CIはseed 1=-0.8667 [-1.5000,-0.3000]、seed 2=+0.1000 [-0.7333,1.0333]、seed 3=-0.6000 [-1.2667,0.1000]。T111 v3 3seed平均1.4778比で平均-0.3667石、T121選抜seed 1.4000比で平均-0.2889石。
- 蒸留200k学習: target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t124/distill200k-v4 --mixes teacher-only --seeds 1,2,3 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 を実行。T123からの変更はpattern-set v3→v4と出力先のみ。180,110 train / 9,685 validation / 10,205 frozen、best epoch=29/26/29、completed epoch=30/31/29。epochごとにstate・重み・metricsをatomic保存。完走後の同一コマンドでresume epoch=30/31/29を実測した。
- 蒸留oracle: 3seedすべてregret=2.8666666666666667石、v2差+1.3000、95% CI [0.2000,2.5333]でcandidate_worse。全3回でM2ガードPASS。T123 v3×蒸留200k平均2.0111比で+0.8556石悪化。
- サイズ/配信: v3 5,964,708 bytesに対しv4 27,986,340 bytes（4.692倍）。Python gzip -9、mtime固定でv3 940,533 bytes、v4 4,299,661 bytes（4.572倍）。raw約22.0MB、gzip約3.36MB増で、アプリ配信コストは無視できない。
- NPS: target/release/calibrate_mpc.exe bench --depth 8 --pattern-weights PATH、固定opening/midgame 28局面、v3/v4交互3反復。v3平均677,954、v4平均683,772 NPS、比100.86%。速度劣化なし（評価差により探索ノード数自体は異なる専有参考値）。
- ロード/メモリ: fresh eval_cli processで重みロード+1局面depth 0評価を各20回。中央値v3 52.54ms、v4 83.57ms（1.591倍）。1msポーリング平均peak working setはv3 72.66MiB、v4 100.40MiB、差+27.74MiB。OS cache・プロセス起動込みの専有参考値。
- 平滑化: 仕様どおり素朴な1石刻みを先に実測。WTHOR平均regretが改善したためT124内では平滑化を追加せず、結果を混ぜなかった。ただしseed 2退行・seed SD 0.4993・蒸留悪化を踏まえ、隣接stage正則化または共有と差分量子化/圧縮を別候補で比較してから採否判断する案を推奨。本番配線・採用裁定・パターン形状変更・コーパス生成は未実施。
- 検証: cargo test -p engine PASS（197 tests）、cargo test -p train PASS（56 unit + real_data 1）、cargo test -p engine --release --test ffo_bench PASS（fast 1、heavy 1 ignored）、v4 WTHOR/蒸留smoke PASS、python -m json.tool meta PASS、git diff --check PASS、UTF-8化け文字チェックPASS。
- 成果物: bench/edax-compare/t124_v4_stage_resolution.meta.json、bench/edax-compare/t124_v4_stage_resolution_report.md。重み・checkpoint・oracle生JSONはtrain/data/t124配下（gitignore領域）。
- コミットハッシュ: 未作成（.git書き込み禁止のためオーケストレーター代行）。コミット対象はengine/src/pattern_eval.rs、train/src/regression.rs、train/src/bin/train_patterns_v3.rs、train/src/t090_distillation.rs、train/weights/README.md、上記メタ・レポートの7ファイル。件名 (T124)。タスクファイルは作業ログ追記のみでコミット対象外。

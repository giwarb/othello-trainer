---
id: T087
title: Pattern v3 — edge+2X・対角オフセット特徴の追加とablation比較(PWV3形式)
status: done # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T087: Pattern v3 — 特徴量追加とablation比較

## 目的

評価関数の表現力を上げる(Edaxとの差の本丸)。現行 pattern_v2(22インスタンス/6クラス)に **edge+2X** と **対角オフセット5/6/7** を追加した v3 候補を学習し、5構成の ablation 比較で採否を判定する。**学習実験が正しく完了して候補が不採用になることも正常な完了である**(設計書の明記)。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§5(T087)**。§5.1(パターン集合)・§5.2(サイズ)・§5.3(PWV3形式)・§5.4(NPS対策と採用ゲート)を規範として実装すること。
- 既存実装: `engine/src/patterns.rs`(22パターン生成、D4対称クラス分類)、`engine/src/pattern_eval.rs`(PWV1/PWV2ローダ)、`train/`(WTHORパーサ・学習パイプライン、T040/T041/T044)。
- 学習データ: WTHOR実データは `train/data/`(gitignore済み・非コミット)。無ければ T040 と同じ方法でFFO公式サイトから2015〜2024年分をダウンロードする(コミット禁止)。
- 却下済みの設計判断(繰り返さない): corner5x2とedge+2Xの同時採用(サイズ超過+情報重複)、3ステージ縮約、学習法の刷新との同時投入(学習法はT088)。

## 要件(設計書§5が規範。要点)

1. **パターン生成は機械的に**(§5.1): edge+2X は基準パターン `(0,0..8)+[(1,1),(1,6)]` にD4全変換+セル集合重複除去で4インスタンス/1クラス/各10セルになることをassert。対角オフセットは長さL∈{5,6,7}で `(0..L).map(|i| (i, i+offset))`、計12インスタンス/3クラス。corner5x2(8インスタンス/1クラス/10セル)は**比較用のみ**(本採用候補ではない)。個別セル番号の手書き禁止。
2. **5構成のablation**(§5.1末尾): (1)v2 (2)v2+diag567 (3)v2+edge2x (4)v3=v2+edge2x+diag567 (5)v2+corner5x2。edge2x+corner5x2の同時追加はしない。
3. **サイズ**(§5.2): 13ステージ・f32・D4クラス共有を維持。推奨v3は約5.96MBで8MB上限内に収まること。
4. **PWV3自己記述形式**(§5.3): magic "PWV3"、instance/classブロック、schema_hash(SHA-256)を含む仕様どおりのフォーマット。読み込み時検証9項目(セル範囲・重複なし・num_states=3^cells・class_id整合・D4分類一致・finite・余剰bytesなし・hash一致等)を実装。**PWV1/PWV2ローダは維持し、既存 pattern_v2.bin は書き換えない**。新trainerのみPWV3を書き出す。
5. **NPS対策**(§5.4): パターン削減ではなく、固定長配列化・一時Vec禁止・3進乗数の定数表化・連続配置・stage_tables参照のループ外化などの実装最適化で対応する。
6. **採用ゲート**(§5.4): (a)重み8MB以下 (b)v2比NPS 80%以上 (c)3 seedすべてでfrozen test MAEが同方向 (d)Edax oracle regret 10%以上改善 または X/C高ロス率25%以上減少 (e)20局スモークで重大退行なし。ストレッチ目標(MAE10%/regret15%/X/C50%減)は完了条件にしない。
7. **長時間実行ルール(CLAUDE.md)厳守**: 学習は構成単位・チェックポイント単位で逐次保存し、resume可能にする。進捗をログに出す。5構成×3seedの実行計画と所要見込みを作業開始時に作業ログへ記す。
8. 比較結果(MAE・regret・NPS・サイズの表)と採否判定・根拠を作業ログに記録する。採用時は新重みファイル(例: `train/weights/pattern_v3.bin`)をコミット対象に含める。**engineの既定評価への配線(アプリ反映)は本タスクのスコープ外**(採用判定後に別タスクで実施)。

## やらないこと(スコープ外)

- 学習アルゴリズムの変更(Huber・early stopping等)= T088。本タスクは既存の学習法(T044のSGD+L2)のまま特徴量だけ変える
- engine既定評価・アプリ/WASMへの配線(採用判定後の後続タスク)
- Edax教師蒸留(T090)。教師はこれまで通りWTHOR最終石差
- 3ステージ縮約・MPC・探索側の変更
- WTHOR実データ・中間生成物のコミット(`train/data/` はgitignore維持)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` / `cargo test -p train` 全件パス(パターン生成のassert・PWV3ローダ検証のテスト含む)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 正解値・ノード数不変(本タスクは評価関数の学習・形式追加のみで探索は不変のはず。変化があれば原因説明)
- [ ] 5構成×3seedの学習が完走し、frozen test MAE の表が作業ログにある
- [ ] 推奨v3(または採用構成)の重みが8MB以下であることをファイルサイズで確認
- [ ] NPS計測(v2比)の結果が作業ログにあり、採用構成は80%以上
- [ ] Edax oracle regret 比較(既存の固定局面コーパス使用)の結果が作業ログにあり、採用ゲート(d)の判定が明記されている
- [ ] 採用/不採用の判定と根拠が作業ログに明記されている(不採用でも正常完了)
- [ ] PWV3ローダの検証9項目それぞれに対する否定テスト(壊れたファイルを拒否する)が存在しパスする
- [ ] コミット対象ファイル一覧が最終メッセージに明記されている(コミット・pushはオーケストレーター代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後。`train/data/` 配下のダウンロードデータはgitignoreで除外されていること)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-14 作業開始・実行計画

- 5構成(`v2`, `v2-diag567`, `v2-edge2x`, `v3`, `v2-corner5x2`)を seed 3個で学習する。構成×seedを最小再開単位とし、各epoch終了時に重み・学習状態をチェックポイント保存、完了済みrunは再実行時にスキップする。進捗はrun/epoch単位で逐次標準出力へ記録する。
- 先に小規模runでPWV3往復、チェックポイント保存・resume、frozen split固定を確認し、その後15 runを順次実行する。既存T044相当のSGD+L2、同一データ分割・epoch数を維持する。
- 所要見込み: 実装・単体テスト 1〜2時間、小規模確認 10分以内、15 runは各10〜30分として約2.5〜7.5時間、NPS/oracle regret/20局smokeと回帰確認に約1〜3時間。実測が10分超となる処理は上記チェックポイントからresume可能な状態でのみ継続する。

### 2026-07-14 実施結果

- `PatternCells`を最大10セルの固定長配列にし、3進乗数を定数表化。score時の一時Vecは使用せず、trainerのSGDも一時feature Vecを廃止した。
- edge+2X、offset diagonal 5/6/7、corner 5x2を基準座標へのD4全変換とセル集合重複除去で生成。5構成はそれぞれ22/34/26/38/30 instances、6/9/7/10/7 classesでassertした。
- PWV1/PWV2 loaderと既存PWV2 writerを維持したままPWV3 writer/loaderを追加。SHA-256 schema hashと指定9検証項目を実装し、各項目の否定テストを追加した。既存`pattern_v2.bin`は変更していない。
- `train_patterns_v3`を追加。既存SGD+L2設定を維持し、構成×seedを逐次実行、epochごとにatomic checkpointを保存、最新checkpointからresume、完了runのskip、run/epoch進捗表示に対応した。実データ19,119局を17,207学習局(1,029,243 samples)/1,912 frozen局(114,511 samples)へ対局単位で固定分割した。

#### 5構成×3 seed frozen test結果

| 構成 | seed 1 MAE | seed 2 MAE | seed 3 MAE | PWV3 bytes |
|---|---:|---:|---:|---:|
| v2 | 16.480727 | 16.234710 | 16.226228 | 2,729,712 |
| v2-diag567 | 16.660802 | 16.296298 | 16.463732 | 2,894,103 |
| v2-edge2x | 16.668904 | 16.260260 | 16.356844 | 5,800,317 |
| v3 | 16.850024 | 16.343493 | 16.617968 | 5,964,708 |
| v2-corner5x2 | 16.876839 | 16.151667 | 16.596976 | 5,800,369 |

v3は3 seedすべてでseed対応v2より悪化した。diag567とedge2xも3 seedすべて悪化、corner5x2はseed 2のみ改善で同方向ではない。推奨v3は5,964,708 bytesで8MB以下。

#### NPS・oracle regret・20局smoke

- 固定opening/midgame 28局面、depth 8、seed 2重みで各3回計測。v2 NPS=`911,755 / 903,183 / 894,904`(平均903,281)、v3 NPS=`831,893 / 820,522 / 830,667`(平均827,694)。v3/v2=**91.63%**で80%ゲート通過。
- 既存`bench/edax-compare/t085_exact_positions.json`のoracle付き18局面、depth 8の選択手をEdax完全読みで採点。平均regretはv2 **0.888889石**、v3 **2.222222石**。10%改善ではなく150%悪化し、ゲート(d)不通過。
- 同一開始局面を先後交換した20局、depth 4のv3対v2 smokeはv3 8勝/v2 12勝/引分0、v3平均石差+0.5。クラッシュ・不正着手・重大な機能退行なし。

#### 採否

**不採用**。サイズ(a)、NPS(b)、smoke(e)は通過したが、3 seedのfrozen MAEが改善方向で揃う条件(c)とoracle regret条件(d)を満たさない。したがって`train/weights/pattern_v3.bin`は作成・コミットせず、engine既定評価への配線も行わない。

#### 検証コマンド

- `cargo test -p engine` → 175 passed / 0 failed / 2 ignored（bin testsも全件pass）。
- `cargo test -p train` → unit 23 passed、実WTHOR test 1 passed、0 failed。
- `cargo test -p engine --release --test ffo_bench` → fast #40-44は1 passed / 0 failed、heavy 1 ignored、497.96秒。ラッパーは全結果出力直後に505.2秒上限へ達したが、test binaryの最終結果はpass。探索コードは変更しておらず正解値・ノード決定経路は不変。
- `cargo run -p train --release --bin train_patterns_v3 -- --output-dir train/data/t087` → 5構成×3 seed×20 epochs完走、上表を`results.tsv`へ逐次保存。
- `target/release/calibrate_mpc.exe bench --depth 8 --pattern-weights <v2/v3>` → 上記NPS各3回。
- `python bench/edax-compare/compare_pattern_v3.py ...` → oracle 18局面完走。
- `python bench/edax-compare/smoke_pattern_v3.py ... --depth 4` → 20局完走。
- `python -m py_compile bench/edax-compare/compare_pattern_v3.py bench/edax-compare/smoke_pattern_v3.py` / `git diff --check` → pass。
- コミットハッシュ: 未作成（環境の`.git`書き込み禁止。オーケストレーター代行）。

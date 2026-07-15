---
id: T109
title: 蒸留学習のデータ量スケーリング実験(学習曲線)
status: todo # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T109: 蒸留学習のデータ量スケーリング実験(学習曲線)

## 目的

T090b(Edax教師蒸留、50k局面)は「教師分布内では改善するが、独立oracleでは有意に悪化(v2比 +1.90石、T096で確定)」で不採用となった。現在の本命仮説は「教師データ量不足による過学習」だが、これは**未検証の仮説**である。200k教師コーパス生成(約10時間)に投資する前に、既存50kコーパスの部分集合で「データ量 → 汎化性能」の学習曲線を作り、量仮説を支持/棄却する。

- 曲線がデータ量とともに明確に改善傾向 → 量仮説支持。200k(あるいは外挿から必要量を見積もり)へ進む根拠になる。
- 曲線がフラット/悪化 → 量仮説不支持。局面分布の多様化やv3特徴(表現力)との組み合わせを先に検討する方針転換の根拠になる。

**本タスクは分析実験であり、採否判定・アプリ配線はしない。**「量仮説が不支持」という結果も正常な完了である。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のため implementer(Sonnet)フォールバック+検証強化で実施する。**本タスク実行中、別ワーカーがT104(終盤ソルバー、NPSゲートあり)を並行実行している。** そのため:
- 壁時計・NPS等の時間計測は本タスクの判定に一切使わない(MAE・regret・agreementはすべて決定的指標なのでCPU競合の影響を受けない)。
- **本タスク側の処理はすべて直列・低負荷で実行する**(学習runの並列実行禁止、Edax oracle採点も1プロセスずつ直列)。T104側のNPS計測を汚染しないための配慮であり、遅くなってよい。
- ビルド(cargo build/test)はやむを得ないが、不要な再ビルドを避ける。

## 背景・既存資産(必読)

- `tasks/T090b-distillation-training.md` — 蒸留学習の仕様と作業ログ(split構成: train 45,058 / validation 2,363 / frozen teacher test 2,582、混合損失、採用ゲートの経緯)。**本実験で使うmix構成は、T096で再判定された最終候補と同じもの**(T090b作業ログで確認すること。baseline 0.6/0.3/0.1 のはず)。
- `tasks/T096-oracle-robustness.md`(該当ファイル名は tasks/ 内で `T096*` を検索) — 60局面独立oracle(`bench/edax-compare/t096_oracle_positions.json`)での regret 測定手順。**本タスクの主指標はこの手順の再利用**。v2と蒸留候補(50k全量)の実測値が作業ログにあり、条件が同一なら再測定せず流用してよい。
- 実装: `train/src/t090_distillation.rs`、runner `train/src/bin/train_distillation.rs`(存在確認して使う)、コーパス `train/data/teacher/corpus_primary.jsonl`(ローカル・gitignore済み。無ければblockedとして報告、再生成はしない)。
- 参照重み: `train/weights/pattern_v2.bin`。
- T095で高速化済み: 6run 約34秒、WTHORキャッシュあり。学習自体は軽い。

## 要件

1. **サブセット構成**: 既存の train split(45,058局面)から、**入れ子(nested)**の部分集合を作る: 約6.25k ⊂ 12.5k ⊂ 25k ⊂ 45k(全量)。
   - 入れ子にする理由: サイズ間の差分をサンプリング分散でなくデータ量の効果として読むため。
   - 空きマス帯(phase bin)で層化し、各サイズで元コーパスのphase分布を保つ。抽出は固定seedで決定的に。
   - **validation split と frozen teacher test は全サイズで共通固定**(50k全量ベースのまま)。曲線のy軸を揃えるため、サブセット化は train split のみに適用する。
   - 実装は `train_distillation` に `--train-subset-size N --subset-seed S` 等のCLIオプション追加で行う(既存の全量動作は無引数で不変であること)。
2. **学習runs**: 4サイズ × seed 2個以上(時間が許せば3個)、mixは上記の1構成のみ。既存のcheckpoint/resume基盤を維持する。
3. **前回の教訓(T087で事後のbias/variance切り分けができなかった)**: epochごとのメトリクスに **train側とvalidation側の両方の teacher MAE** を記録する。現行の `metrics.tsv` は `train_loss`(混合損失)しか無いので、`train_teacher_mae` 列を追加する(計算コストが問題なら固定サブサンプル(例: train 5,000局面)上の評価でよい。その場合は列名・作業ログに明記)。
4. **評価(各run)**: 以下を summary(`results.tsv`)と作業ログの表に記録する:
   - best epoch の train teacher MAE / validation teacher MAE(過学習ギャップの直接観測)
   - frozen teacher test の best-move agreement(分布内性能)
   - **T096 60局面oracleの mean regret(分布外汎化・主指標)** — seedごとに測るのが重すぎる場合は「サイズごとにseed平均の重み…ではなく、各サイズで代表seed 1個+もう1 seedはサイズ端点(6.25kと45k)のみ」など、コストと分散のバランスを取った計画を作業ログに書いてから実行する。
   - 参照線として v2(WTHOR学習)の oracle regret(T096実測の流用可)。
5. **T095申し送りの3修正**(t090_distillation.rsを触るタスクで対応する約束のもの。いずれも小規模):
   - (a) キャッシュ読込の件数フィールドに checked arithmetic(壊れたファイルで過大メモリ確保しない)+破損検出テスト
   - (b) CLIの mix/seed 重複指定を拒否(同一checkpoint dirへの競合書き込み防止)
   - (c) キャッシュ保存失敗は警告にして学習を続行
6. **長時間実行ルール(CLAUDE.md)**: run単位のchekpoint/resume維持、進捗の逐次ログ、oracle測定も局面単位で逐次保存・resume可能に(T096の手順に準ずる)。
7. **結論の記述**: 作業ログに「学習曲線の読み(量仮説の支持/不支持と根拠)」を、log-linearな外挿(45k→200kで v2水準 regret ≒ T096のv2実測値 に届きそうか)込みで書く。判定はオーケストレーターが行うので、データと解釈候補を提示すればよい。

## やらないこと(スコープ外)

- 200kコーパス生成、Edax実行によるコーパス拡張(oracle採点のためのEdax実行は可)
- v3特徴との組み合わせ実験(次タスク候補)
- 採否判定・アプリ/WASM配線・NPS測定
- 既存 `train/weights/pattern_v2.bin` や本番重みの変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` 全件パス(subset抽出の決定性・層化のテスト、T095修正3件の否定テスト含む)
- [ ] `cargo test -p engine` 全件パス(protocolフレーキーは単独再実行で切り分け)
- [ ] 全予定run(4サイズ×計画seed数)が完走し、`train/data/t109/` に per-run `metrics.tsv`(train/validation両方のteacher MAE列あり)と summary `results.tsv` がある
- [ ] 作業ログに「サイズ × (train MAE / val MAE / frozen agreement / oracle regret)」の表と、v2参照値、学習曲線の読み(仮説支持/不支持の解釈)がある
- [ ] oracle測定が局面単位で逐次保存されている(中断→resumeの動作説明が作業ログにある)
- [ ] コード変更(train/配下)のみをパス明示でコミット(データ・生成物はコミットしない。`train/data/` はgitignore済みであることを確認)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

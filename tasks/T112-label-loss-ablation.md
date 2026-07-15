---
id: T112
title: 同一45k局面でのラベル/損失対照実験(密度仮説 vs 損失仮説の切り分け)
status: in_progress # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T112: 同一45k局面でのラベル/損失対照実験

## 目的

蒸留(50kコーパス)がWTHOR全量学習(103万局面)より分布外oracleで悪い原因を、**「局面の密度(数)」なのか「ラベル/損失の性質」なのか**に切り分ける(ユーザー承認 2026-07-16)。方法は「**同じ教師コーパスの局面集合を固定し、ラベル・損失だけを入れ替える**」対照実験。

判定の分かれ方(作業ログには数値と解釈候補を書けばよい。判定はオーケストレーター):
- **outcome回帰のみ(セルc)が1.6石前後を維持** → 4.5万局面で足りる = 犯人はラベル/損失の性質(混合損失設計(D)が本命に)。
- **セルcが3石級に悪化** → 犯人は密度(局面数)。蒸留ラベルには10万〜100万級の局面が必要という示唆。

**本タスクは分析実験。採否判定・アプリ配線はしない。**

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック+検証強化。**別ワーカーがT104/T105(終盤ソルバー、NPS計測あり)を並行実行中**のため:
- 全処理を直列・低負荷・**フォアグラウンドのみ**で実行(バックグラウンド起動禁止=T109事故防止)。遅くてよい。時間計測は判定に使わない。

## 背景・既存資産(必読)

- `tasks/T090b-distillation-training.md` — 混合損失の定義(baseline 0.6 teacher Huber / 0.3 ranking / 0.1 outcome)と既存ablation(teacher-only 1.0/0/0、no-ranking 0.7/0/0.3)。**no-ranking / teacher-only の学習済み重みが `train/data/t090b/primary-redo1-v2/{no-ranking,teacher-only}-seed-{1,2}/final.bin` に残存しているはず**(gitignore領域) — これらは**再学習不要でoracle計測のみ**でよい。
- `tasks/T110-v3-distillation.md` / `tasks/T111-v3-wthor-robustness.md` 作業ログ — oracle計測手順(oracleRows/v2行の再利用によるEdax節約、T111の`t111_seed_oracle_state.py`はSHA整合ガード付きで最も洗練されている。踏襲推奨)。
- 実装: `train/src/t090_distillation.rs`(mixは名前付き定義のはず。outcome-only を追加する)。
- **申し送り(本タスクで対応、T110レビュー[中M1'])**: `run_one`で`truncate_metrics_after`が`ensure_metrics_header`より先に実行され、ヘッダ不一致拒否経路が完全には副作用フリーでない。**順序を入れ替える(検証→truncate)**1行修正+可能なら回帰テスト。
- **M2ガード(標準)**: 各oracle計測でv2行=1.5667の完全再現を確認。再現しなければ中止して報告。

## 要件

1. **outcome-only mixの追加**: 混合比 (teacher 0 / ranking 0 / outcome 1.0) の名前付きmix `outcome-only` を追加する。
   - WTHOR outcomeが無いレコード(engineLoss由来65/50,000件)はoutcome-onlyでは学習に使えない。**スキップし、件数を作業ログに明記**(既存の再正規化規約との整合も確認)。
   - 局面集合はprimary 50k(train split 45,058)そのまま。サブセット化しない。pattern-setはv2(既定)。
   - 既存mix(baseline等)の数値挙動が不変であること(退行確認: 既存テスト+可能ならbaseline 1epochスモークのSHA一致)。
2. **学習**: outcome-only × seeds 1,2,3(既存checkpoint/resume基盤、train/data/t112/)。epochメトリクスはtrain/val両方のteacher MAE(既存基盤)に加え、outcome-onlyではvalidationのoutcome MAEも読めることが望ましい(既存列で賄えるなら追加不要、判断を作業ログに)。
3. **oracle計測(T096 60局面、主指標)**: 以下を計測し、既存値と合わせた比較表を作る:
   - (c) outcome-only seed1(3seedの重みが実質同挙動か確認し、異なるならもう1seed)
   - (b) no-ranking seed1(T090b既存重み、oracle未計測なら計測)
   - (b') teacher-only seed1(同上)
   - 参照(流用): baseline蒸留=3.4667、v2×WTHOR(103万)=1.5667、v3×蒸留=2.6667
   - 各計測でM2ガード(v2行1.5667再現)を確認・記録。
4. **長時間実行ルール**: epoch/局面単位の逐次保存・resume、進捗ログ、節目ごとの作業ログ追記。
5. **結論材料の記述**: 比較表と、密度仮説/損失仮説それぞれへの含意(rankingの寄与の正負も no-ranking / teacher-only との対比で読めるはず)を作業ログに書く。

## やらないこと(スコープ外)

- 200kコーパス生成・局面分布の変更・ステージ解像度実験(別タスク)
- 混合比の最適化探索(この実験は切り分けが目的。チューニングは結果を見てから)
- 採否判定・アプリ/WASM配線・NPS計測

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` 全件パス(outcome-only mixの単体テスト、M1'順序修正の回帰テスト含む)
- [ ] 既存mixの数値不変確認(baseline 1epochスモークのSHA-256一致 or 同等の根拠)が作業ログにある
- [ ] outcome-only 3seedsが完走し `train/data/t112/` にmetrics.tsv・summaryがある
- [ ] oracle比較表(outcome-only / no-ranking / teacher-only / baseline / v2×WTHOR / v3×蒸留)とM2ガード記録が作業ログにある
- [ ] スキップしたoutcome欠落レコード件数が作業ログに明記されている
- [ ] コード変更(train/配下のみ)をパス明示でコミット(データ非コミット)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T104/T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

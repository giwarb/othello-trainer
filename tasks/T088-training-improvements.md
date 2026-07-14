---
id: T088
title: 学習法改善 — 年代分割・D4正規化・Huber・early stopping・ステージ/X-Cサンプリングの8構成ablation
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T088: 学習法改善(v2特徴のままのablation)

## 目的

評価関数の学習方法を近代化し、v2特徴のままでどこまで精度が上がるかを8構成×3seedのablationで実証する。T087で「特徴を増やしても現行の素朴な学習法では悪化する」ことが判明しており、**本タスクが評価関数改善の主経路**。合格後、改善された学習法でv3特徴(T087の実験基盤を再利用)の再試行を検討する。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§6(T088)**。§6.1〜§6.7を規範として実装すること。
- T087の成果(コミット 4a036de): PWV3形式・`train_patterns_v3.rs`(構成×seed逐次実行・チェックポイント)・`bench/edax-compare/compare_pattern_v3.py`(oracle regret比較)・`smoke_pattern_v3.py`(20局smoke)。**本タスクはこれらを拡張・再利用する**。
- T087の結果: v3特徴は現行学習法(SGD+L2・MSE・ランダム90/10分割・20epoch固定)では全seed悪化で不採用。学習法の限界が示唆されている。
- 学習データ: WTHOR 2015〜2024が `train/data/`(gitignore済み)にダウンロード済みのはず。年情報はファイル名/ヘッダから取得。

## 前提修正(T087 codex-review申し送り。ablation実行前に行い、以後の実行はすべて修正版で)

`tasks/review/T087-pattern-v3-codex-review.md` 参照:

1. **(ブロッカー由来)** `compare_pattern_v3.py` / `smoke_pattern_v3.py` に局面/対局単位のチェックポイント逐次保存+resume+条件(重みハッシュ等)一致検証を実装(CLAUDE.md長時間実行ルール準拠。`vs_edax.py` の方式を踏襲)。
2. **(中)** 学習CLIのresume/skipに **run identity照合**を実装: データmanifest hash・構成・seed・epoch数・学習設定をチェックポイント/完成ファイルのメタデータとして保存し、不一致なら再開を拒否する(黙って流用しない)。
3. **(中)** 実験結果表(results.tsv相当)は run 完了ごとに原子的に追記保存する(全run終了後の一括書き出し禁止)。
4. **(中)** PWV3ローダに num_instances/num_classes の実用上限チェック(残りバイト数との整合検証)を追加し、否定テストを追加。
5. **(中)** 比較スクリプトの出力に provenance(重みSHA-256・eval_cli/Edaxのハッシュ・git tree)を記録する。
6. **(軽微・ついで可)** `atomic_write` を削除+renameでなくWindowsで安全な置換に、Edax一時ファイル名を一意に。

## 要件(設計書§6が規範。要点)

1. **年代分割**(§6.1): train=2015〜2022 / validation=2023 / frozen test=2024、対局単位で固定。2024は最終選択まで一切チューニングに使わない。
2. **D4正規化と重複処理**(§6.2): canonical key=(black_bits, white_bits, mover)の8対称最小表現。canonical positionごとに outcome平均/分散/出現回数/年/phase/直前着手種別を保持し、targetはf32の平均outcome。**年代間リーク防止**: 同一keyが複数splitに出たら後年側優先(test > validation > train)、除外件数をmanifestに記録。
3. **Huber loss**(§6.3): 初期δ=8石、勾配は`error.clamp(-8,8)`相当。δ∈{4,8,12}はvalidationで選び、2024 testでは選ばない。
4. **early stopping/LR decay**(§6.4): 最大60epoch、初期lr 0.005、validation MAE 2epoch停滞でlr半減(下限0.0003125)、5epoch停滞(最小改善0.02石)で停止、最良epochの重みを復元。L2候補 1e-6/1e-5/1e-4。**各epoch終了時にweights/optimizer設定/epoch/shuffle seed/指標/データmanifest hashを保存し1epoch単位でresume可能に**(一括保存禁止)。
5. **ステージ別サンプリング**(§6.5): weight(stage)=sqrt(max_count/count)、4倍clamp、weighted shuffleで元サンプル数と同数抽出。
6. **X/C hard-negative**(§6.6): 直前着手がX/Cかつ対応する隅が着手前に空いていた局面を3倍サンプリング(epoch全体の25%上限、X/C別集計、隅確保済みは対象外)。固定罰則・target変更は禁止。比較: なし/2倍15%/3倍25%/4倍25%。
7. **8構成ablation×3seed**(§6.7): (1)現行再現(MSE・ランダム90/10・20epoch) (2)年代分割のみ (3)+D4正規化 (4)+Huber (5)+early stopping/LR decay (6)+stage sampling (7)+X/C oversampling (8)全部。CLIは§6.7の形式(`--checkpoint-dir`はリポジトリ外=train/data/配下等gitignore領域でよい)。出力に設定・データhash・epoch別指標・最良epoch・frozen test値を含める。
8. **採用ゲート**(§6.7末尾): (a)3seedすべてで現行v2比validation MAE改善 (b)frozen 2024 test中央値MAE 5%以上改善 (c)oracle regret 10%以上改善(compare_pattern_v3.py再利用、修正版で) (d)X/C high-loss率20%以上改善 (e)NPS 95%以上(重み形式同じ)。**失敗実験も設定・指標を残す。不採用も正常完了**。
9. **長時間実行ルール(CLAUDE.md)厳守**: 24run(8構成×3seed)の実行計画・所要見込みを開始時に作業ログへ。run単位resume・進捗逐次ログ。
10. 採用時は新重み(例: `train/weights/pattern_v2t.bin`、PWV3形式)をコミット対象に含める(**engine既定評価への配線は後続タスク**)。

## やらないこと(スコープ外)

- v3特徴(edge+2X等)での学習(T088合格後の別タスクで再試行を検討)
- engine既定評価・アプリ/WASMへの配線(採用判定後の後続タスク)
- Edax教師蒸留(T090)。教師はWTHOR最終石差(D4平均化後)のまま
- 探索側の変更・MPC
- WTHOR実データ・中間生成物のコミット

## 受け入れ基準(検証コマンド)

- [ ] 前提修正1〜5が実装され、それぞれの検証(スクリプトの中断→resume再現、run identity不一致の拒否、PWV3上限の否定テスト等)の証跡が作業ログにある
- [ ] `cargo test -p engine` / `cargo test -p train` 全件パス(D4正規化・Huber・サンプリングの単体テスト含む)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 正解値・ノード数不変(探索は無変更のはず)
- [ ] 8構成×3seedのablationが完走し、validation/frozen MAEの表が作業ログにある(年代分割・除外件数のmanifest記録込み)
- [ ] 採用ゲート(a)〜(e)それぞれの実測値と判定が作業ログに明記されている(不採用でも正常完了)
- [ ] 採用時: 新重みファイルが8MB以下でコミット対象に含まれ、oracle regret比較のprovenanceが記録されている
- [ ] コミット対象ファイル一覧が最終メッセージに明記されている(コミット・pushはオーケストレーター代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

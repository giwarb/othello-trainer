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

## 明確化(2026-07-14、Codexの停止質問4点へのオーケストレーター裁定)

1. **構成7と8の違い = 案A**: 構成6は(5)+stage samplingのみ、構成7は(5)+X/C oversamplingのみ(stage samplingを含まない)、構成8=全部((5)+stage+X/C)。これにより stage と X/C の寄与を個別に分離できる。
2. **ハイパーパラメータ候補の扱い = 代表seed選択方式**: δ∈{4,8,12}・L2∈{1e-6,1e-5,1e-4}・X/C設定4候補は、**seed 1 のみ**で該当構成(δは構成4、L2は構成5、X/Cは構成7)のvalidation MAEにより選択し、選択値を全seed・後続構成に固定適用する。候補ごとのvalidation指標はすべて記録する(2024 frozen testは選択に使わない)。
3. **構成1(現行再現)と2024隔離の矛盾 = 2024完全隔離で再定義**: 構成1は「2015〜2023データ・ランダム90/10・MSE・20epoch固定」とし、2024はどの構成でも学習・チューニングに使わない。採用ゲートの比較基準(「現行v2比」)は**この構成1**とする。既存コミット済み pattern_v2.bin(2015〜2024全データ学習でリークあり)は frozen 2024 評価の参考値として1行記録するのみ(採用判断に使わない。リークの注記を付ける)。
4. **X/C high-loss率の定義**: 評価対象 = frozen 2024 のうち vulnerable_xc(直前着手がX/Cかつ対応する隅が着手前に空)に該当する局面サブセット。**high-loss率 = そのサブセットで |モデル予測 − canonical平均outcome| >= 8石 となるサンプルの割合**。ゲート(d)は構成1比でこの割合が20%以上減少(0.8倍以下)すること。あわせて同サブセットのMAEも記録する(Edax不要・決定論的にできる自己完結の定義。Edax oracleベースのX/C評価はT090で扱う)。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-14 実装・実験開始

- 実行計画: 代表seed=1で Huber delta 3候補(config 4)、L2 3候補(config 5)、X/C 4候補(config 7)を validation-only で逐次実行し、各候補のvalidation MAEを保存して最良値を固定する。その後、config 1〜8 × seed 1〜3 の24 runを逐次実行する。2024 frozen testは候補選択runでは計算せず、固定後の24 runだけで計算する。
- 長時間実行設計: 各epoch終了時に世代付きweights/stateとbest weights、epoch、learning rate、best epoch/MAE、停滞数、shuffle seed、manifest hash、epoch別metricsを原子的に保存する。state先行・weights後行で完全な最新世代だけをresumeし、run identity不一致は拒否する。results.tsvはrun完了ごとに原子的に追記する。比較は局面単位、smokeは対局単位で同様に保存・resumeする。
- 所要見込み: 候補選択10 run + 本番24 runで45〜120分、oracle 36局面とsmoke 20局を含め全体60〜150分。early stopping対象は最大60 epoch、その他は20 epoch。進捗はepoch/run/局面/対局ごとに標準出力へ出す。
- 事前検証: cargo test -p train は28件成功。小規模runをepoch 10で中断後 resume run=config-5-seed-1 epoch=10 を確認し、L2変更時のrun identity不一致を拒否。T087 trainerもepochs変更を拒否。smoke_pattern_v3.py は2対局を1件ずつresumeしdepth変更を拒否、compare_pattern_v3.py は2局面を1件ずつresumeしcandidate重み変更を拒否。PWV3の過大instance数・残りbyte数不整合の否定テストも成功。

### 2026-07-14 実装・実験完了

- 実装: 2015〜2022/2023/2024の対局単位年代分割、D4 canonical key、outcome平均・分散・出現数・年・phase・直前着手X/C/other集計、後年優先のsplit間重複除去、f32 target、Huber、early stopping/LR decay、stage逆平方根sampling、X/C倍率/cap sampling、8構成CLIを実装した。early stoppingは絶対最良重みとmin_delta=0.02のpatience基準を分離し、修正版schema=2で全候補と24 runを再実行した。
- manifest: data hash=b6e39360424d3b91。canonical key数はtrain=620,474、validation=114,061、test=138,476。元出現数は822,433 / 148,311 / 173,010。validationによりtrainから4,236 key、testによりtrainから8,502 key、validationから4,494 keyを除外した。2024 vulnerable X/C canonical samples=23,727。
- 代表seed候補選択(validationのみ): Huber deltaは4=14.235191、8=14.250082、12=14.268386で4を選択。修正版early stoppingでL2は1e-6=14.205071、1e-5=14.205053、1e-4=14.204909で1e-4を選択。X/Cはなし=14.204909、2倍/15%=14.225600、3倍/25%=14.232181、4倍/25%=14.230570で「なし」を選択。候補選択中は2024 testを計算していない。
- 正式実行: cargo run -p train --release --bin train_patterns -- experiment --configs 1,2,3,4,5,6,7,8 --seeds 1,2,3 --huber-delta 4 --l2 0.0001 --xc-oversample 1 --xc-cap 1 --checkpoint-dir train/data/t088/main-v2。527.4秒、24/24 run完了。各runのepoch metrics/current/best/final/identity/manifestとrun完了ごとのresults.tsvを非コミット領域へ保存した。

| config | validation MAE seed 1 / 2 / 3 | frozen 2024 MAE中央値 | X/C high-loss率中央値 |
|---:|---|---:|---:|
| 1 | 16.272653 / 16.005812 / 16.139248 | 14.577849 | 0.544949 |
| 2 | 16.044946 / 16.037285 / 16.030405 | 14.636923 | 0.546213 |
| 3 | 14.423089 / 14.418519 / 14.418297 | 14.520175 | 0.547056 |
| 4 | 14.235016 / 14.232722 / 14.233072 | 14.292946 | 0.541113 |
| 5 | 14.204909 / 14.209698 / 14.206166 | 14.269088 | 0.541324 |
| 6 | 14.218374 / 14.230182 / 14.229671 | 14.301331 | 0.543558 |
| 7 | 14.204909 / 14.209698 / 14.206166 | 14.269088 | 0.541324 |
| 8 | 14.218374 / 14.230182 / 14.229671 | 14.301331 | 0.543558 |

- 既存pattern_v2.bin参考値: 2015〜2024学習で2024リークあり。canonical 2024 test MAE=14.358465、X/C high-loss率=0.539849。採用判断には不使用。
- 採用ゲート(候補=config 5、frozen中央値run=seed 3):
  - (a) 合格。config 1比validation MAE改善率はseed 1/2/3で12.707% / 11.222% / 11.978%。
  - (b) 不合格。frozen MAE中央値14.577849→14.269088、改善2.118%で5%未満。
  - (c) 不合格。Edax oracle mean regret 1.888889→2.444444、29.412%悪化。provenance: candidate SHA-256=7ddbcd894574322a81e30e2a71670a9fc0738c276497f79cb355a351789a0881、baseline SHA-256=6246f8aae69dcba828d4baeee9ea156f3f1694a43f02bf3355644c51cfe35957、eval_cli=3a2ea3f85b02c22c7b38516d9e09df5df4bc17753f6ab4ad61fa6b94cee6dd2c、Edax=aabb5ac7d3f9a872fc0e7388ab1eee1d23c687f76c28642122524dc318b322b1、eval.dat=f8b2299612d9fa4414157e70e932636e33111c2602d0c2fc382a7d90ef21b792、corpus=778140e43f52b8c70c75e3c721be441404260899d4d2dc668e9b781368a0459e、git tree=59902be5c21dc60b18b56481e25ed4f3ebc891dd。
  - (d) 不合格。X/C high-loss率中央値0.544949→0.541324、改善0.665%で20%未満。候補のX/C subset MAEはseed 1/2/3で12.149965 / 12.153601 / 12.149650。
  - (e) 合格。固定局面depth 8を各7回測定した中央値NPSは409,179→425,934、比率104.09%。
- 最終判定: 不採用。(b)(c)(d)不通過のため新重みはコミットしない。engine既定評価への配線も行っていない。
- 前提修正検証: compare/smokeはそれぞれ局面/対局を1件保存して再実行し次の1件へresume、重みまたはdepth変更でidentity mismatch拒否を確認。T087 trainerはepochs変更を拒否。T088はepoch 10 checkpointからresumeしL2変更を拒否。PWV3過大instance数・残りbyte不整合テスト成功。比較出力に重み/eval_cli/Edax/eval.dat/corpus/git tree provenanceを保存した。
- 永続化境界の最終確認: T087はmetaを先に、weightsを完了マーカーとして後に置く順序へ修正。T088はepoch-XX.stateを先に、epoch-XX.binを完了マーカーとして後に置き、不完全世代を無視する方式へ修正した。修正後もepoch 10で強制中断し、完全なepoch 10世代からresumeすることを確認した。
- 最終検証: cargo test -p engine は177 passed / 2 ignored、cargo test -p train は28 passed（実WTHOR合法性テスト含む）、cargo test -p engine --release --test ffo_bench はFFO #40〜44のfast test成功（1 passed / heavy 1 ignored、探索コード無変更）、cargo test -p engine --release --test pattern_eval_nps_bench -- --nocapture は成功（pattern/heuristic=0.807）、git diff --check 成功。
- コミットハッシュ: 未作成（実装ワーカー環境は.git書き込み不可）。

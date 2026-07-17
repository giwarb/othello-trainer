---
id: T125
title: v4候補の頑健性確認+最終審査(追加seed・対Edax対局)
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T125: v4候補の頑健性確認+最終審査

## 目的

T124で有望と判明した**v4(ステージ1石刻み)×WTHOR**(3seed regret 0.70/1.67/0.97、平均1.111 vs 現本番v3=1.40)を、(1)追加seedで頑健性を固め、(2)T121と同一プロトコルの対Edax対局で審査し、**v3→v4の世代交代の採否判定材料を確定**する。計測のみ、本番配線は採用裁定後の別タスク。

## 背景・前提

- T124の実装(コミットf3d4466)・重み(`train/data/t124/wthor-v4/`、seed1-3)・oracle結果は検証済み。seed SD 0.4993と大きく、seed2(1.67)の退行あり — 選抜バイアス(T121レビュー中指摘と同種)を避けるため頑健性確認を先に行う。
- 対局基準値: T121のv3採用候補の60局(3勝3分54敗、平均-21.2333、`bench/edax-compare/endgame-results/t121-vs-edax-results.json`)とT108のv2(-21.85)。**同一プロトコル・同一openings**。
- oracle採点はM2ガード(v2行1.5667完全再現)必須。

## 要件

1. **追加seed学習**: v4×WTHORをseed 4,5,6で追加学習(T124と同一コマンド系・epochs 20)。6seed全体のregret分布(平均・SD・range)を確定し、T124の3seedと合わせて報告。
2. **候補選定**: 6seedから候補を選ぶ。選定規準は「regret最良」ではなく**頑健性を考慮した規準を事前に明記してから選ぶ**(例: 最良と2番目が近ければ最良、外れ値含みなら中央値近傍等。選定バイアスの注意をレポートに記載)。選定候補のregretとSHA-256を記録。
3. **対Edax level10 60局対局**: T121と同一条件(single-root/level10/depth12/ef16/1500ms/160k/quota60/unlimited-exact-empties 20/TT64MiB/primary openings)で重みのみv4候補に差し替え。run keyで区別。checkpoint/resume・専有・進捗観測の規律はT121と同じ。
4. **比較・判定材料**: T121(v3、-21.23)・T108(v2、-21.85)とのopening単位paired比較(平均差・bootstrap 95%CI・勝敗遷移)。**採用推奨案**を根拠付きで記載(最終裁定はオーケストレーター/ユーザー)。配信サイズ増(gzip +3.4MB)への言及も含める。
5. **レポート**: `bench/edax-compare/endgame-results/t125-report.md`(gitignore配下のため`git add -f`が必要な旨を完了報告に明記)。
6. `cargo test -p train`/`-p engine`パス(コード変更時)。

## やらないこと(スコープ外)

- 本番配線(採用裁定後の別タスク)
- 平滑化・正則化などv4アルゴリズムの変更(素の1石刻みのまま審査。平滑化は審査結果次第の後続候補)
- コーパス生成・蒸留実験

## 受け入れ基準(検証コマンド)

- [ ] 6seed(既存3+新規3)のregret分布が確定し、M2ガード付きで記録されている
- [ ] 候補選定規準が事前明記され、選定候補のSHAが記録されている
- [ ] 60局対局が完走し、run keyがv4候補を反映している
- [ ] T121/T108とのpaired比較と採用推奨案がレポートにある
- [ ] checkpoint/resume対応の記録
- [ ] レポート等の変更対象ファイルのみパス指定でコミット(`(T125)`)
- [ ] タスク完了時点で当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 オーケストレーター裁定: codex-review形式指摘(tasks/同梱コミット)の扱い

codex-review(初回)は「内容面は合格相当」としつつ、コミット913f183に `tasks/T125-v4-adjudication.md` が成果物と同梱されている点を規律違反として不合格とした。**裁定: これはワーカーの違反ではなくオーケストレーターの代行コミットの切り方の問題**(CLAUDE.mdの分担どおり tasks/ のコミットはオーケストレーター担当であり、ワーカーはコミット自体を行っていない)。push済み履歴の書き換えは行わない。**是正: 以後の代行コミットでは成果物と tasks/ を必ず別コミットに分離する**(本ターンから適用)。本指摘をもってredoは不要とし、verifier合格を条件にdoneとする。

## 作業ログ(担当エージェントが追記)

### 2026-07-17 13:31 JST Codex 追加3seed・oracle・対Edax最終審査完了

- 開始時確認: AGENTS.md、README.md、T124/T121資産をUTF-8で確認し、`git status --short`は空。追加seed結果を見る前に、6seed中央値（第3・第4値の平均）へ最も近いseed、同距離なら低regret、さらに同値なら低seed番号、という候補規準を`bench/edax-compare/endgame-results/t125-report.md`へ事前登録した。
- 追加学習: `target/release/train_patterns_v3.exe --configs v4 --seeds 4,5,6 --epochs 20 --output-dir train/data/t124/wthor-v4`を専有1プロセスで実行。3,988,509 train / 442,995 frozen samples、全seed 20 epoch完走、frozen MAE=16.203516 / 16.178727 / 16.139380。各epochの重み・identityをatomic保存。完走後の同一コマンド再実行でepoch再計算なしの完成run skipを確認した。
- oracle: seed 4/5/6を`compare_pattern_v3.py`でT096 60局面へ採点し、regret=1.0333 / 0.8333 / 1.4333。既存seed 1/2/3=0.7000 / 1.6667 / 0.9667と合わせ、6seed平均1.1056、標本SD 0.3702、range 0.7000–1.6667、中央値1.0000。全6ファイルでv2=1.5666666666666667を完全再現しM2 PASS。局面単位atomic checkpointを使用し、連続実行の外側タイムアウト後も保存済み結果を保持してseed 6を独立完走した。
- 候補選定: 事前規準により中央値から同距離のseed 3/4のうち低regret側seed 3を選定。regret=0.9666666667、27,986,340 bytes、SHA-256=`c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`。
- 対Edax: T121と同じprimary 30 opening×先後、single-root、level10、depth12、ef16、1500ms、160k、quota60%、空き20以下無制限、TT64MiBを専有1プロセスで実行し60/60完走。v4は4勝2分54敗、平均-24.0167、中央値-24。run key SHA-256=`dc135276e7adbf025499215ef322ab28e6b031f6bd88472a00ba39d62998fedb`。完走後の同一コマンド再実行で`loaded 60 already-completed`と60/60 resume-skipを確認。fixed-depth 40/40、node-budget 10/10の決定性もPASS。
- paired比較: opening先後2局平均を単位に100,000標本bootstrap。v4-v3=-2.7833石、95% CI [-7.8000,+2.2500]、改善/同値/悪化=11/1/18。v4-v2=-2.1667石、95% CI [-6.7000,+2.2500]、14/1/15。T121 v3-v2の既報+0.6167、[-3.8667,+4.9500]も同じ集計器で完全再現。勝敗遷移と全opening表をレポートへ記録した。
- 推奨案: oracleは6seedで改善傾向だが、実戦点推定はv3/v2双方より悪く、CIは0を跨ぎ、v3比gzip約+3.36MB（約+3.4MB）でもあるため、現時点ではv3維持・素のv4採用見送りを推奨。最終裁定、本番配線、平滑化・正則化、コーパス生成、蒸留は未実施。
- checkpoint検証: `python bench/edax-compare/vs_edax.py --self-test-checkpoint`でprovenance不一致拒否とatomic中断時保持をPASS。学習はepoch、oracleは局面、対局は1局単位でatomic保存・resume対応。
- 最終検証: inline Python acceptance検証PASS（6seed/M2/SHA/60局/WDL/平均/run key/同一プロトコル設定/fixed-depth/node-budget）、`git diff --check` PASS、UTF-8 replacement文字なし、`git check-ignore -v`でT125 report/results/raw-reportが`.gitignore:45`対象であることを確認。コード変更がないため`cargo test -p train` / `cargo test -p engine`はT125では非該当（T124実装時に両方PASS済み）。
- 成果物: `bench/edax-compare/endgame-results/t125-report.md`。コミット時はignore配下のため`git add -f bench/edax-compare/endgame-results/t125-report.md`が必要。生results/raw-report、追加重み・oracleはignore領域で非コミット。コミットハッシュは環境制約により未作成（開始HEAD `ed22fd27b9df684f013baff6379d307a5202d7d9`、オーケストレーター代行、件名 `(T125)`）。タスクファイルは本作業ログ追記のみでコミット対象外。

---
id: T125
title: v4候補の頑健性確認+最終審査(追加seed・対Edax対局)
status: in_progress # todo | in_progress | review | redo | done | blocked
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

## 作業ログ(担当エージェントが追記)

---
id: T156d
title: MPC再校正(4/7): 同一バイナリA/B CLIとGate 2(固定深さ)/Gate 3(160k本番相当)の軽量ゲート
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol
attempts: 0
---

# T156d: A/B CLIと軽量ゲート

## 目的

設計レポート(tasks/design/T156-mpc-recalibration-report.md §(c)T156d節・§5.2・§7 Gate 2/3)に従い、**同一バイナリ内でMPC/history/aspirationを独立切替できる比較CLI**を整備し、**Gate 2(固定深さノード収支)とGate 3(160kノード本番相当)の軽量ゲートを実測・判定**する。T156cのSearchPolicy/MpcStats/Q16テーブル(pilot版)を使用。

## 要件

1. **CLI整備**: eval_cli / calibrate_mpc(適切な方)に、--mpc/--aspiration/--history 独立切替、--max-nodes、--exact-from-empties、--exact-quota-percent、局面別JSON出力(best move/score/depth/nodes/exact統計/aspiration統計/MPC統計テレメトリ)、局面単位checkpoint/resume を追加。**同一バイナリでA〜D構成を切替**(A=history+aspiration+MPCoff〔現本番〕、B=history+MPC・aspirationOFF、C=全部ON〔診断のみ〕、D=historyのみ)。
2. **T156a申し送りの同梱**: calibrate_mpc merge の入力整合性検証強化(positionsファイルfingerprint照合・schemaVersion・pilotOnly・depth集合・重複recordのempties/bucket/split/gameId一致)+CLI usageへのmerge/shard引数記載。
3. **Gate 2(固定深さ、設計§7)**: 校正に使っていないtest split(t156_mpc_positions.jsonのtest 240局面のうち空き帯内)でdepth 8/10/12をMPC on/off比較(exact_from_empties=0、aspiration/history OFF)。判定: 集計ノード-10%以上(D10/12)・ゲーム単位bootstrapノード比95%上限<0.97・局面別中央値-5%以上・p90ノード比≤1.25・mpcProbeNodes/totalNodesとcut率併記。
4. **Gate 3(160k本番相当、設計§7)**: A〜D構成をv4重み・160kノード・quota60%・exact_from_empties=16で比較(空き20以下局面は除外)。判定: 2回実行完全一致(決定性)・wallLimitHit=0(time_ms=Noneでよい)・完成深さ中央値B-A≥+1または35%以上の局面で+1・浅くなる局面≤10%・**oracle regret差 B-A≤+0.10石(oracleはT157の180局面版 bench/edax-compare/t157_oracle_positions.json+t157_oracle_labels.json を使用。paired bootstrap 95%上限+0.50石以下)**・4石以上loss増が局面比率で同等以下・exact統計に異常な偏りなし。
5. **レポート**: bench/edax-compare/t156_mpc_gates_report.md(+meta)にGate 2/3の全数値・合否・A〜D比較表。合格ならT156e(確認校正1,200局面)へ、不合格なら原因分析と撤退/調整の提言。
6. 計測は決定的(time_ms=None)、checkpoint/resume+進捗ログ必須。**専有状態で計測**(開始前にSTATUS並行状況確認。現在T157は完了済みのはず)。

## スコープ外

- 本番配線(T156f)・対局(T156g)・1,200局面フル校正(T156e)
- app変更(Pages確認不要)

## 受け入れ基準

1. A〜D構成が同一バイナリで切替でき、2回実行の完全一致(決定性)が機械検証されている
2. Gate 2/Gate 3の全判定基準の数値と合否がレポートにある(不合格も正当な結果)
3. `cargo test -p engine` 全パス(default OFFの挙動不変維持)、FFO fast不変
4. 変更ファイル一覧と検証結果を完了報告に明記(コミットはオーケストレーター代行)。一時ファイルを残さない

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)

## 作業ログ

(ワーカーが節目ごとに追記)

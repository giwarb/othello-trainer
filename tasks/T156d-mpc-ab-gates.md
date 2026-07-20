---
id: T156d
title: MPC再校正(4/7): 同一バイナリA/B CLIとGate 2(固定深さ)/Gate 3(160k本番相当)の軽量ゲート
status: redo # codex-review不合格(2026-07-20): 測定条件の機械検証欠如。下記フィードバック参照
assignee: Codex gpt-5.6-sol
attempts: 1
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

## フィードバック(redo #1、2026-07-20 codex-review不合格による)

レビュー(tasks/review/T156d-mpc-ab-gates-codex-review.md)のブロッカー: **Gate 2/3の測定条件が機械検証されておらず、コミット済み成果物から実測条件を監査・再現できない**。実測値と撤退提言は妥当と評価されているが、検証チェーンが欠けている。以下を修正すること:

1. **compare_mpc.py に入力検証を追加**: checkpointの`config`を読み、(a)Gate 2=depth 8/10/12・test split 240局面・exact/history/aspiration OFF・MPCのみ切替 (b)Gate 3=v4重み(fingerprint照合)・160k・quota60%・exact_from_empties=16 (c)A〜Dのpolicyが規定どおり (d)全構成が同一の局面ID集合 (e)空き20以下除外 (f)oracle positions(t157_oracle_positions.json)とlabelsの対応・fingerprint (g)schemaVersion、を検証し、不一致なら集計せずエラー終了。
2. **metaへ検証済みconfigを保存**: 削除済み一時checkpointのパス+SHAだけでなく、各checkpointのconfig・positions/weights fingerprint・レコード集合サマリをmetaに残し、監査・再現可能にする。
3. **GateConfigに--max-positions(または選択済みID集合fingerprint)を含める**(中1)。
4. **重複レコード検出**: 辞書化前にレコード数=キー数を検証(compare_mpc.pyのby_key/oracle_regrets)(中2)。
5. **exact会計検査の拡充**: root完走/試行・bound proof/leaf・quota abort・exactNodes/midgameNodes/総ノードの整合、構成間偏り(中3)。
6. **回帰テスト追加**: 新CLIの設定拒否・resume・merge異常入力・集計境界(軽微)。
7. **Gate 2/3を再実測**し(検証付きパイプラインで)、監査可能な成果物一式でレポートを再生成する。判定基準・条件は元仕様のまま。

## 追記(redo中の補足情報、verifier部分検証より 2026-07-20)

- **Gate 3の初回実測8ファイルはコミット済みコード(81c6207)からバイト単位で完全再現された**(verifierがログのコマンドを再実行しmeta記録のSHA-256と全一致)。したがってredoの再実測はこれらと一致するはず。不一致が出た場合は原因を調査すること。
- **4石loss基準の文言不整合**: 設計レポート§7は「4石以上のloss局面増加が60局面あたり2件以下」(許容差あり)、本タスクファイル初版は「同等以下」(増加ゼロ)と厳格化していた。**redoでは設計レポート§7の基準(60局面あたり2件以下相当、120局面なら4件以下)を正とし**、両解釈での判定を併記すること(初回はどちらでも他基準で不合格のため結論に影響なし)。

## 作業ログ

(ワーカーが節目ごとに追記)

- 2026-07-20 20:04 JST Codex実装: `calibrate_mpc gate` に同一バイナリA〜D/独立policy切替、固定深さ・node budget・exact quota、局面別JSON（best move/score/depth/nodes/exact/aspiration/MPC全統計）、設定fingerprint付き局面単位atomic checkpoint/resume・逐次進捗を追加。`merge` は実positions fingerprint、schemaVersion、pilotOnly、depth集合、record metadata（empties/bucket/split/gameId）と重複内容を検証するよう強化し、usageへshard/merge/gate引数を追記。`compare_mpc.py` でゲーム単位bootstrap、A〜D 2回完全一致、oracle regret、exact会計、report/meta生成を機械化。
- 実測: Gate 2はtest 240局面で合格（D10 node ratio 0.6025/U95 0.6416/median 0.6104/p90 0.9573、D12 0.4348/0.4696/0.4105/0.8409）。Gate 3は空き21〜26のoracle 120局面で不合格。A〜D全構成2回完全一致、wallLimitHit=0だが、B-Aはmedian depth +0、+1率5.83%、浅化8.33%、regret +0.1833石、paired U95 +0.6167石、4石loss +1件。default OFF維持・T156eへ進まない提言をレポート化。
- 検証: `cargo build --release -p engine --bin calibrate_mpc --features mpc_enabled` 成功。gate smoke（独立ON/OFF・A構成）成功。既存pilot 320件の`merge`成功。`python -B bench/edax-compare/compare_mpc.py --help`成功。`cargo test -p engine` は204 passed/0 failed（binテストも全pass）。`cargo test -p engine --release --test ffo_bench -- --nocapture` はFFO fast #40〜#44全問正解（641,077,417 nodes、59.382s）。`git diff --check`成功。一時checkpoint/smoke/pycは削除済み。
- コミット: 未実施（`.git`書き込み禁止のため、オーケストレーター代行予定）。
- 2026-07-20 22:22 JST Codex redo #1: Added fail-closed Gate input validation for canonical corpus/oracle/v4 SHA-256 and FNV fingerprints, schema/config/policy, identical selected ID/key sets, and duplicate rejection. `GateConfig` now persists `maxPositions`, selected count, and selected-ID fingerprint; resume rejects changed selection or duplicate/out-of-scope records. Meta schema 2 embeds all ten validated checkpoint configs and record-set summaries. Expanded exact accounting and same-aspiration A-C/B-D bias checks; added 4 Rust CLI-policy/fingerprint/merge tests and 9 Python aggregation-boundary tests.
- Remeasurement: Gate 2 completed 240 test positions x D8/10/12 for MPC OFF/ON in 3,210s and passed (D10 ratio/U95/median/p90=0.6025/0.6416/0.6104/0.9573; D12=0.4348/0.4696/0.4105/0.8409). Gate 3 completed A-D x 2 x 120 oracle positions in 137.7s; all repeated records were identical and wall hits were zero. Gate 3 failed: B-A median depth +0, >=+1 rate 5.83%, shallower 8.33%, regret +0.1833, paired U95 +0.6167. 4-disc loss delta +1 passes design limit (+4/120) but fails strict no-increase wording. T156e remains blocked/default MPC OFF.
- Verification: canonical fingerprints validated; same-config resume returned 720/720 and changed `--max-positions` was rejected. `python -B -m unittest bench/edax-compare/test_compare_mpc.py` 9 passed; report generator returned Gate2=true/Gate3=false; `cargo test -p engine` passed (204 main tests plus all bin tests, including 4 new CLI/merge tests); FFO fast #40-#44 all exact scores matched, 641,077,417 nodes, 59.597s; `git diff --check` passed. Temporary Gate checkpoints and generated pyc files were removed.
- Commit: not performed (`.git` is read-only); orchestrator to commit the task-scoped files listed in the completion report.

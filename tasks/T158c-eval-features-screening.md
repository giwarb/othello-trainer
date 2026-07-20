---
id: T158c
title: 評価特徴追加(3/4): スクリーニング(害検出・NPS・決定性・smoke)と候補確定
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol
attempts: 0
---

# T158c: スクリーニングと候補確定

## 目的

設計レポート(tasks/design/T158-eval-features-report.md §(c)T158c節・§8 Gate 4/5)の第3段。T158bのB3(両特徴)full 3seed重みを安価な多指標でスクリーニングし、**最終対局ゲート(T158d、後回しリスト)へ送る候補を1つに確定**する。

## 要件

1. **seed別×61段の害検出(T158b申し送りの必須化)**: T158bレポートの申し送り表(seed1 empty43 +0.229/empty53 +0.198/empty54 +0.138、seed3 empty46 +0.140等)を起点に、各seedのstage別退行をfrozen・oracleの両面で精査し、**候補seed選定に反映**する(退行の大きいseedは原則除外方向。全seedに問題があれば「候補なし=撤退」も正当)。
2. **Gate 4: T157 oracle 180害検出**: 3seed各重みで再採点(t157_rescore_weights.py流用可)。mean regret・Edax top-move agreement・paired win/loss・empties別regret。**baseline(v4本番)より0.2石以上悪化またはagreement明確低下で停止。0.1-0.3石の改善が出ても昇格根拠にしない**(T157教訓)。M2/provenance guard維持。
3. **NPS(学習済み重み)**: 候補重みでT158aの層化8局面ベンチ(native/WASM)を実施(ゼロ係数でなく実係数。探索が変わるためNPS比は参考値、Gate 1の再判定ではない。elapsed・到達深さを記録)。feature on/off決定性(同一入力反復一致)確認。
4. **Gate 5: 24局paired smoke**: 候補1seed vs B0(または現行v4本番重み。比較相手を明記) — 12 opening pairs×色交換、160kノード・quota60%・空き20以下無制限(本番相当)。1局単位atomic checkpoint/resume・進捗出力。**クラッシュ・非法手・非決定性・極端な負け越し(目安: 4勝20敗以下)の検出用。勝ち越しを採用根拠にしない**。
5. **候補確定**: 全指標を通過した候補seed 1つのhash(SHA-256)を固定し、**対Edax 60局pairedゲート(T158d)を後回しリストへ登録**(manifest項目は設計§8最終ゲート節)。
6. **T158b申し送りの軽微対応**: t158b_analyze.pyのMarkdown合否表示を計算値から生成するよう修正。
7. レポート: bench/edax-compare/t158c_screening_report.md(+meta)。全指標・判定・候補hash・(候補なしの場合は撤退根拠)。

## スコープ外

- 対Edax 60局ゲートの実行・本番採用(T158d、後回しリスト)
- 再学習・engine変更

## 受け入れ基準

1. seed別害検出・Gate 4・NPS・決定性・Gate 5の全結果と判定がレポートにあり、候補1つ(または撤退)が根拠付きで確定している
2. smokeはcheckpoint/resume実装済みで異常検出0件(異常があれば停止・報告)
3. `cargo test -p engine`・`cargo test -p train`(触った場合)全パス、既存ファイル(t157系・T158a/b成果物)の値を変更しない
4. 変更ファイル一覧と検証結果を完了報告に明記(コミットはオーケストレーター代行)。一時ファイル不残置

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。計測・対局は専有状態で。detached+ツール呼び出しポーリング(Bashバックグラウンド・Monitor通知依存禁止)

## 作業ログ

(ワーカーが節目ごとに追記)

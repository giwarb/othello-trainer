---
id: T121
title: v3×WTHOR候補の最終審査(対Edax対局による採否判定材料の確定)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T121: v3×WTHOR候補の最終審査

## 目的

評価関数の世代交代候補として唯一残っている **v3特徴×WTHOR学習**(T110で発見、T111で頑健性確認: 3seed oracle regret 1.40/1.43/1.60石 vs 現行v2×WTHOR 1.5667石)の**実戦棋力を対Edax対局で確定**し、採否判定の材料を揃える。**計測・判定材料の確定のみ。本番配線(app/engineへの重み組み込み)は採用裁定後の別タスク。**

## 背景・前提

- T087: v3特徴(PWV3形式)の基盤実装済み(コミット済み)。NPS・重みサイズは合格済み。当時18局面oracleの悪化(+1.33石)で不採用としたが、T111で小標本アーティファクトと判明。
- T110/T111: v3×WTHOR 3seedの学習済み重みとregret実測(1.40〜1.60石)。重みの所在はT111の作業ログ/manifest参照(`train/data/`配下、gitignore領域)。**存在しない/再現できない場合はT111のrun設定で再学習してよい**(決定的のはず。再学習した場合はregret再計測でT111値との一致を確認)。
- T120の結論: 蒸留スケール路線は本番超え不可の見通し → 本候補が実質最後の評価関数改善カード。
- 直近のEdax対局基準値: **T108の正式60局(v2重み、quota60%+T116無制限、TT64MiB): 4勝2分54敗・平均石差-21.85**(run key SHA `cbb35f4e...`、`bench/edax-compare/endgame-results/t108-vs-edax-tt64-results.json`)。**本タスクは同一プロトコル・同一openingsで重みだけ差し替えた対局を行い、この基準値と直接比較する**(世代・条件が完全一致する貴重な対照)。

## 要件

1. **候補重みの確定**: T111の3seedのうちregret最良のseed(1.40石)の重みを主候補とする。ファイルの実在・SHA記録・oracle regretの再現確認(v2行1.5667の完全再現ガード込み=T110 M2)。
2. **対Edax level10 60局対局(主計測)**: T108と同一条件(`vs_edax.py --opening-set primary --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64`)で、**エンジンの評価重みのみv3候補に差し替えて**実行。vs_edax/eval_cliが重み・pattern-set指定に未対応の箇所があれば最小限拡張しrun keyに反映。checkpoint/resume・専有CPU・進捗観測はT108と同じ規律。
3. **比較・判定材料**: T108のv2結果(-21.85、勝敗内訳)とopeningごとの対応比較(同一opening同士のpaired比較)で、平均石差の差・勝敗の変化・95%CI(bootstrap)を出す。**採用推奨の判定案**(例: 平均石差が改善しCIが悪化を否定 / 明確な悪化なし+regret優位、等)を根拠付きでレポートに書く(最終裁定はオーケストレーター/ユーザー)。
4. **回帰確認(軽量)**: FFO #40-44正解値(終盤ソルバーは評価関数非依存のはずだが念のため)、決定性(サンプル)、NPS概況(専有下の参考値。v2比で大幅劣化がないこと — T087でNPS合格済みの再確認レベル)。
5. **レポート**: `bench/edax-compare/endgame-results/t121-report.md`(コミット対象、gitignore配下なら`git add -f`が必要な旨を完了報告に明記)に、regret・60局結果・paired比較・採用推奨案・限界事項(60局の検出力等)をまとめる。
6. **長時間実行ルール厳守**(checkpoint/resume・進捗ログ・1局単位保存)。

## やらないこと(スコープ外)

- 本番配線(app/engineのデフォルト重み変更・ANALYSIS_ENGINE_VERSION・配布)— 採用裁定後の別タスク
- v3の学習法・特徴セットの変更(既存T111の重みを審査するだけ)
- 追加の学習実験(重み再現のための再学習を除く)

## 受け入れ基準(検証コマンド)

- [ ] 候補重みのSHAとoracle regret再現(v2行1.5667ガード込み)が記録されている
- [ ] 60局対局が完走し、run keyに重み差し替えが反映されている(T108と区別可能)
- [ ] T108のv2結果とのpaired比較(平均石差の差・CI)と採用推奨案がレポートにある
- [ ] FFO正解値不変・決定性サンプル一致・NPS概況が記録されている
- [ ] 全計測がcheckpoint/resume対応で実行された記録がある
- [ ] レポートがコミットされている(変更対象ファイルのみパス指定、`(T121)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

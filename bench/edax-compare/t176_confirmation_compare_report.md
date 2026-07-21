# T176 確認対局: t=1.0 vs T175 P1(t=1.5)ベースライン、前半15開幕

## 結論

- 開幕単位(n=15) 平均差(candidate-baseline): +2.1667石、95%CI[-1.0000, +5.3333]、符号検定p=0.1967
- 局単位(n=30) 平均差: +2.1667石、95%CI[-0.9667, +5.6667]、符号検定p=0.3938
- **1手あたりノード数(壁時計非依存、決定的な速度指標)**: baseline(t=1.5) 9570877 → candidate(t=1.0) 9812831 (-2.53%削減)
- 1手あたり時間(壁時計、参考値): baseline(t=1.5) 1741.3ms → candidate(t=1.0) 1467.1ms (+15.75%短縮)
- 1局あたり所要時間(壁時計、参考値): baseline 51.26s → candidate 44.27s (+13.62%短縮)

**注意**: elapsedMs/wallClockSecは壁時計ベースで、baseline(T175 P1)とcandidate(本タスク)は別々のプロセス実行(実行時刻・システム負荷が異なりうる)のため、マシン負荷変動の影響を受ける参考値に留める。決定的で比較に適した指標はmoveNodesMean/nodeReductionPercent(ノード数、壁時計に依存しない)。

## 判定基準への当てはめ

T175 P1とのpaired比較で「大きな悪化(平均-2石超かつCI全体マイナス)」がないこと:

- 開幕単位平均差+2.1667石、CI上限+5.3333 → 大きな悪化なし(基準内)

## 開幕一覧

primary-01, primary-02, primary-03, primary-04, primary-05, primary-06, primary-07, primary-08, primary-09, primary-10, primary-11, primary-12, primary-13, primary-14, primary-15
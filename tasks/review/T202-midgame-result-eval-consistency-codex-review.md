## (a) 重大（done を止めるブロッカー）

1. 結果画面の評価値とグラフのホバーツールチップで、丸め精度が一致しません。

   [PracticeMode.tsx:1369](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:1369) はA・Bを小数1桁で表示します。一方、[EvalGraph.tsx:329](C:/Users/yoshi/work/othello-trainer/app/src/analysis/EvalGraph.tsx:329) のツールチップは従来の `formatDiscDiff` を使い、整数へ丸めています。

   問題86の実値 `A=-2.75、B=-1.84` では、結果文言が `-2.8 → -1.8` なのに、グラフの始点・終点をホバーまたはタップすると `-3 → -2` と表示されます。内部の点列は正しくても、ユーザーが確認できる数値表示は一致しておらず、本タスクの目的と「評価値A→Bとグラフの始点・終点が一致する」という受け入れ基準に反します。

   [PracticeMode.flow.test.tsx:800](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.flow.test.tsx:800) はSVGの `data-value` 生値だけを検証しており、ツールチップの表示精度を検証していないため、この不整合を検出できません。

   他モードを変えないため、`EvalGraph` に省略可能な表示フォーマッターまたは精度指定を追加し、既定は従来の整数表示、中盤練習結果だけ小数1桁にする必要があります。始点・終点のツールチップ表示を確認するテストも必要です。

## (b) 中（次タスクで対応すべき）

なし。

redo#1で指定された以下は適切に修正されています。

- `afterPly` によるパス時の根評価対応付け
- 相手連続着手中の直前値維持と、最終点のBへの上書き
- 偶数深さ完走後、奇数深さ途中停止となる回帰テスト
- A・B・差分の小数1桁表示
- 白番でのユーザー視点化
- maxNodesなし・完全読み経路・共有コンポーネント既定の維持

## (c) 軽微（記録のみ）

1. `EvalGraph` の説明コメントに旧前提が残っています。

   [EvalGraph.tsx:31](C:/Users/yoshi/work/othello-trainer/app/src/analysis/EvalGraph.tsx:31) は値を常に `analyzeGame` の累積評価値と説明し、[EvalGraph.tsx:135](C:/Users/yoshi/work/othello-trainer/app/src/analysis/EvalGraph.tsx:135) は縦軸を常に「黒優勢が上」と説明しています。今回の中盤練習結果では独立した根解析値を渡し、白番では白優勢が上になるため、汎用コンポーネントとして説明を更新するのが適切です。

2. 指定コミット範囲全体への `git diff --check` は終了コード2となります。`tasks/STATUS.md` と `tasks/T202-midgame-result-eval-consistency.md` の変更行がCRLF由来の trailing whitespace と判定されます。`app/`・`engine/` のコード差分だけなら成功し、実行時影響もありませんが、作業ログの無条件な「`git diff --check`: 成功」は指定範囲全体については再現できません。

## (d) 総合判定

**不合格**です。

探索深さの偶奇統一、決定性、パスを含むグラフ点の対応、終了点B、ユーザー視点、改善・損失計算の主要ロジックは仕様どおりです。しかし、結果文言を小数1桁へ変更した一方でグラフのツールチップが整数表示のまま残り、ユーザーに見えるA・Bとグラフ端点が再び食い違います。本タスクの中心目的に直接関わるため、doneにはできません。
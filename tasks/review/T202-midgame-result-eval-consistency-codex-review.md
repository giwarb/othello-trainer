## 最終レビューレポート

### (a) 重大（done を止めるブロッカー）

1. 相手またはユーザーのパスが発生すると、根評価とグラフ上の応手がずれ、最終点が B と一致しません。

   [PracticeMode.tsx:688](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:688) では根評価を「ユーザーが着手した回数」ごとに追加しています。一方、[PracticeMode.tsx:1052](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:1052) 以降では「相手の実着手数」ごとに配列を進めて応手点へ割り当てています。この二つは黒白が交互に着手した場合しか対応しません。

   例えば `U1 → 相手パス → U2 → O1 → U3 → O2` の場合、根評価列が `[A, U1後, O1後, B]` になるのに対し、O1へ `U1後`、O2へ `O1後` が割り当てられ、最終点は B ではなくなります。ユーザーがパスして相手が連続着手する場合も同様です。

   `resolveNextSideOrFallback` によりパスは正式に扱われているため、これは未対応の入力ではありません。また [PracticeMode.tsx:1348](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:1348) もユーザーが3手打ったことだけで「相手の3手目の応手後」と表示するため、パス時には説明も事実と異なります。

   根評価を単なる配列添字ではなく、対応する盤面または `afterPly` と関連付けて保存し、パスを含むフローテストで「最終点 = B」を固定する必要があります。これは要件2・4および本タスクの中心目的への直接的な違反です。

### (b) 中（次タスクで対応すべき）

1. 必須指定された「奇数深さの途中で予算切れ」の回帰テストになっていません。

   [search.rs:3954](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:3954) は最深完走深さが奇数、[search.rs:3955](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:3955) はその一つ前の偶数深さを採用したことを検証しています。これは奇数深さを完走後、次の偶数深さの途中または開始前で停止したケースです。

   仕様が必須としているのは、偶数深さを完走後、次の奇数深さの途中で停止するケースです。最深完走深さが偶数である予算を用意し、その偶数深さが採用され、2回の結果も一致することを追加検証してください。

### (c) 軽微（記録のみ）

1. [EvalGraph.tsx:29](C:/Users/yoshi/work/othello-trainer/app/src/analysis/EvalGraph.tsx:29) の `EvalGraphPoint.value` は依然として「黒視点」と記述されていますが、今回 `valuePerspective` により白視点の値も格納する設計になりました。将来の誤用を避けるため、指定視点の値である旨へ更新するのが適切です。

### (d) 総合判定

**不合格**です。

通常の3往復経路については、偶奇を揃えた engine 実装、A/B・改善文言、白視点変換、問題86の検証および共有コンポーネントの既定維持は概ね仕様どおりです。しかし、正式にサポートされているパス経路で本タスクが解消すべき「グラフ最終点と B の不一致」が再発するため、done にはできません。

`git diff --check` は成功し、`git status --short` は空でした。作業ログに記載されたテスト結果も確認しました。
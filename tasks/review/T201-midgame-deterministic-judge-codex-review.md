# 最終レビューレポート

対象: `c36617560686b39fa0c8571f6df241231f3410e4..7dfb7c5b9c29c63285943abdca0338dbec690c49`

## (a) 重大（done を止めるブロッカー）

なし。

問題86の決定性、最善手 `f2` の固定、判定用と結果画面用の最善手共有、`maxNodes` 未指定経路の維持について、必要な実装と回帰テストが揃っています。

## (b) 中（次タスクで対応すべき）

1. `allMoves + maxNodes` の完全読み境界は、作業ログにある「従来の直接完全読み経路を維持」と一致していません。

[search.rs](/C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:1493) は着手後空き数が `exactFromEmpties` 以下の場合、共通深さ探索を避けて従来ループへ進みます。しかし [search.rs](/C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:1583) の `max_nodes` 分岐が先に選ばれるため、直後の直接完全読み分岐（同1608行付近）には到達しません。実際には `search_with_eval_inner` の「depth 1後、残予算の60%でexactを試行する」経路となり、予算不足時は `midgame` 評価へ戻ります。

現在の問題86は完全読み境界から十分遠いため、本タスクの主症状には影響しません。ただし、将来 `allMoves + maxNodes` を終盤局面で使うと、従来の完全読みと異なる結果・`score.type`を返し得ます。`allMoves + maxNodes` を指定した完全読み境界のテストもありません。直接ノード制限付き完全読みを使うか、意図した新契約としてコメント・テストを整合させるべきです。

## (c) 軽微（記録のみ）

1. 品質測定は明示された受け入れ条件を満たしていますが、regret は旧方式より悪化しています。

最善手一致率は双方 `25/38（65.8%）` で条件を満たし、問題86も参照解析と同じ `f2` です。一方、平均regretは `0.37 → 0.46`、最大regretは `2.66 → 3.88` に悪化しています。今回の合否条件には抵触しませんが、今後の校正では一致率だけでなく最大regretにも上限を設ける余地があります。

2. WASMゲートの変数名・作業ログと実際の実行順が一致していません。

[test-node-budget-wasm.mjs](/C:/Users/yoshi/work/othello-trainer/app/scripts/test-node-budget-wasm.mjs:72) では、無関係局面の解析後に `allMovesFirst`、`allMovesSecond`、`allMovesAfterUnrelated` を連続実行しており、allMoves解析の間には無関係局面を挟んでいません。Rust側テストでは正しく挟んでいるため検出力の欠落は限定的ですが、WASMゲート単体では名前どおりの検証になっていません。

3. 指定されたコミット範囲全体の `git diff --check` は失敗します。

`engine/` と `app/` のみでは成功しますが、終端コミット時点の `tasks/T201-midgame-deterministic-judge.md` がCRLFを含み、追加行すべてを trailing whitespace として報告します。実装コードへの影響はありません。

## (d) 総合判定

**合格**です。

主な理由は以下です。

- `maxNodes` 指定時だけ新しい決定的経路へ入り、未指定の既存allMoves経路は維持されています。
- 全ルート手を同じ深さで一巡し、未完走ラウンドを丸ごと破棄する設計は妥当です。
- 中盤練習の判定・応手・終了評価・比較解析が共通の `{ depth: 10, timeMs: 10000, maxNodes: 2400000, exactFromEmpties: 24 }` を使用しています。
- 問題86の本番予算テストが、別局面を挟んだ2回とも最善手 `f2` であることを明示的に検証しています。
- appフローテストが、判定時の最善手を結果一覧と `worstMoveCompare` が再利用すること、および全解析呼び出しへ本番limitが渡ることを検証しています。
- 38局面の品質測定は、明示された一致率条件と問題86の参照最善手一致を満たしています。

GitHub ActionsとPages実機でのredo後確認は作業ログ上未実施なので、最終的な `done` 遷移前に別途verifierの外部受け入れ確認が必要です。
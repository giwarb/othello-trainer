結論: **T084 は `done` ではなく `redo` が妥当**です。主要機能は実装されていますが、single-root 対戦結果を無効化し得る重大な問題が見つかりました。今回は読み取り・検証のみで、ファイル変更はしていません。

## Git確認

- `git log 94a347e..ba1b834` は実装コミット `ba1b834` の1件。
- `ba1b834` は現在の `origin/main` に含まれています。
- 現在の HEAD / `origin/main` は後続のタスク記録コミット `8508550`。
- `git status --short` は空です。
- GitHub Actions 成功は、ネットワーク制限により独立確認できませんでした。

## (a) 完了している部分

- `eval_cli best` と single-root 探索の基本実装。
- `move / score / depth / nodes / elapsedMs / nps / timedOut / exact.*` のテレメトリ。
- 固定深さの同一局面2回実行で、move・score・depth・nodes が一致。
- 既存結果では固定深さ40局面が `allMatched=true`。
- loss 255件はすべて `>= 0`。
- opening データは目視上 smoke 10局面、primary 30局面、ID付き。
- 結果ファイルには120局、single-root/allmoves × level 10/5/1 の集計が存在。
- レポートには方式比較、レベル別戦績、テレメトリ、phase別loss、固定深さ結果が記載されています。

## (b) 未完・未検証

- CargoテストとFFO #40–44は、今回の読み取り専用環境で Cargo build lock を作れず再実行できませんでした。
- kill/restart によるcheckpoint/resumeの実地検証は未完。
- GitHub Actions run `29295789213` の成功は作業ログ上のみで、独立確認できていません。
- verifier/reviewer の合格記録がなく、タスクは独立検証を完了していません。
- FFOの「ノード数が変更前と不変」は具体的な前後値が残っていません。

## (c) 問題点

1. **single-root が終盤で合法手を返さず、対局を途中終了させる可能性があります。**

   exact探索が時間切れになり、depth 1も完走できない場合、[search.rs](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:426) は `best_move=None` を返します。[eval_cli.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/eval_cli.rs:682) はこれを `move:null` として出力し、[vs_edax.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:511) は「合法手なし」と解釈して対局を終了します。

   既存のsingle-root 60局中48局が空き18または19で終了しており、`exact-from-empties=18` と一致します。したがって、現在のsingle-root戦績と比較レポートは汚染されている疑いが強く、ベースラインとして採用できません。

2. **[openings.json](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/openings.json:349) が不正なJSONです。**

   description内に未エスケープの改行があり、JSONパーサーで読み込めません。manifest要件はFAILです。

3. **loss解析のresumeが不完全です。**

   [vs_edax.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:1301) は、あるgame IDのloss entryが1件でもあればゲーム全体を完了済みとしてスキップします。途中killされたゲームの残り着手が永久に欠落します。

4. **成果物のprovenanceが不正確です。**

   `vs_edax_results.json` の `gitCommit` は `ba1b834` ではなく `07b819a...`。未コミット状態でベンチした可能性があり、実行コードを一意に追跡できません。また `runKey` にローカルの絶対パスが残っています。

5. **タスク管理が不整合です。**

   - [T084タスク](C:/Users/yoshi/work/othello-trainer/tasks/T084-bench-single-root-telemetry.md) は `status: todo`
   - [STATUS.md](C:/Users/yoshi/work/othello-trainer/tasks/STATUS.md) は `review`
   - STATUSの最終更新日時は7月13日のまま

   AGENTS.mdの状態同期・即時更新ルールを満たしていません。

## (d) 次に必要な作業

優先順位は次のとおりです。

1. exact時間切れでも必ず合法手へフォールバックするよう修正。
2. ハーネス側でも、合法手が存在するのに `move:null` なら対局終了ではなくエラーにする。
3. `openings.json` を正しいJSONへ修正。
4. loss resumeをゲーム単位ではなく着手単位で再開できるよう修正。
5. コミット済みコードから120局ベンチを再生成し、現在のsingle-root結果を置き換える。
6. `gitCommit`、tree hash、設定、重みファイルhashを正しく記録し、`runKey`から絶対パスを除去。
7. Cargo/FFO、kill/resume、Actions、差分レビューを独立検証。
8. 合格後にT084本体とSTATUSを同期して `done` にする。

したがって、現在の推奨状態遷移は **`review → redo`、attemptsを1増加**です。特にsingle-rootの戦績値は修正・再計測まで意思決定に使用しない方が安全です。
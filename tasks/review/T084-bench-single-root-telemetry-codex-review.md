## 最終レビュー

**総合判定: 不合格**

redo #1 の致命的不具合は修正され、再生成された120局の成果物も機械的には妥当です。ただし、標準ベンチとして必要な provenance/resume の信頼性にブロッカーが残り、エンジン変更後の必須回帰テストも確認できません。

### 重大（ブロッカー）

1. resume により異なる実装の結果を混在させ、現在のコミットの成果物として記録できる

[vs_edax.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:1175) の `try_resume()` は `runKey`、つまり設定値しか比較していません。engine/harness を変更しても設定が同じなら、以前の対局・弱点分析・決定性検証を読み込んでスキップします。

その後 [vs_edax.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:1389) で `meta` を現在のコミット情報に差し替えるため、旧実装の結果が現在の `gitCommit`、`gitTree`、`harnessSha256` で生成されたように見えます。

さらに [vs_edax.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:153) は `eval_cli.exe` が存在すれば再ビルドせず、実行バイナリのハッシュも保存しません。したがって clean worktree でも古いバイナリを実行できます。

最低限、resume の互換性判定に以下を含める必要があります。

- engine/harness のソースID
- 重みハッシュ
- Edaxバイナリまたはバージョン
- 実際に実行する `eval_cli.exe` のハッシュ

不一致なら既存チェックポイントを拒否する必要があります。

2. redo #1 のエンジン変更後に必須テストを実行した証拠がない

`ad88c91` は `engine/src/search.rs` と `engine/src/endgame.rs` の探索処理を変更しています。しかし、その後の作業ログにある検証は `cargo build` とベンチ再実行のみです。記録されている `cargo test`／FFO実行は `ad88c91` より前です。

AGENTS.md とT084要件では、`engine/src/` 変更後の以下が必須です。

- `cargo test -p engine`
- FFO #40–44回帰
- 特にノード数のタスク前基準との比較

今回のread-only環境では再実行を試みましたが、`target/release/.cargo-build-lock` へのアクセス拒否で実行できませんでした。したがって合格根拠にはできません。

### 中

1. 時間切れフォールバックの直接回帰テストがない

追加された [search.rs](/C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:2331) のテストは `max_nodes=1` による打ち切りだけを検証しています。redo #1 の実障害は `--time-ms 1000` でexact読みが時間切れになった経路です。

最終フォールバック処理は共有されており、再生成した60局のsingle-root対局では改善を確認できますが、元の障害経路を直接固定するテストも追加すべきです。

2. チェックポイント書き込みが非アトミック

[vs_edax.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:1221) の保存は対象JSONへの直接書き込みです。書き込み中にプロセスを停止するとJSONが破損し、次回起動は「parse失敗、最初から実行」になります。

一時ファイルへ書き込み後に置換する方式でないため、長時間処理の「中断からresume」を完全には保証できません。

### 軽微

- `ee6bea3..1346f18` にはT084本体以外に、AGENTS.md、CLAUDE.md、運用スクリプト、T085設計などの並行コミットが含まれます。T084の実質的変更は主に `ad88c91` と `1346f18` です。
- 生成された `vs_edax_results.json` は全面CRLFで、`git diff --check` が大量の trailing whitespace を報告します。JSONとしては有効ですが、差分品質を悪化させています。

## 確認できた合格部分

- redo #1 の合法手フォールバックを実装。
- 合法手があるのに `move:null` ならハーネスが即時エラー。
- 保存された対局は120局、組み合わせも各20局×6条件で重複なし。
- 全120局が両色とも合法手なしの真の終局。
- `move:null` による途中終了は0局。
- 弱点分析は362件、`game_id + ply` の重複なし、`loss < 0` は0件。
- fixed-depth 40局面は2回完全一致。
- node-budget smoke 10局面も2回完全一致。
- 保存された `runKey`、設定ハッシュ、harnessハッシュは現在の内容と一致。
- レポート集計は保存JSONと整合。
- `git status --short` は空。

## 必須対応

1. resume判定を実装・バイナリidentityまで含めて厳格化する。
2. チェックポイント保存をアトミック化する。
3. exact時間切れから合法手へフォールバックする直接回帰テストを追加する。
4. 修正後に `cargo test -p engine` とFFO #40–44を再実行し、正解値とノード数を記録する。

以上を満たした後、成果物をクリーンに再生成すれば合格判定可能です。
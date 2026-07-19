---
id: T148
title: 軽微申し送りの束ね修正(定石トレース残留・コメント陳腐化)
status: done # 2026-07-20 done裁定。赤→緑実証+Pages実機解消確認+CI success。検収は軽量運用(オーケストレーターがコミットスコープ・CI確認、verifier/レビュー省略=表示1行+コメントのみの軽微束ね)
assignee: implementer(Sonnet)
attempts: 0
---

# T148: 軽微申し送り束ね

## 目的

バックログ消化フェーズの第1弾として、過去タスクの軽微申し送り3件を一括修正する。

## 要件

1. **T140申し送り(表示バグ・唯一の挙動変更)**: 対局モードで「1手戻る」を初期局面まで全戻しすると、定石トレース表示が残留する(表示のみ・次の1手で自動回復)。`app/src/app.tsx` の該当箇所を修正(全戻し時にトレース表示をクリアする、想定1行程度)。修正方法はT140の作業ログ(`tasks/T140-*.md`)の申し送り記述を参照。
2. **T147レビュー軽微1(コメント陳腐化)**: `engine/src/protocol.rs:933` 付近「`pattern_v3.bin`(本番配信中の重み)」と `engine/src/pattern_eval.rs:871-873` 付近「本番はT122以降 v3×PatternWeights が配線済み…」の文言を、v4本番採用(T147)後の事実に更新(D4非不変性の説明内容自体は正しいので変えない。版名と「本番配信中」の記述のみ)。
3. **T147レビュー軽微3(テスト表記)**: `engine/src/protocol.rs` の953行付近のテストがテスト名・コメントで「production weights」と称して `pattern_v2.bin` を使用している。実態に合わせて表記を修正(「歴代重みの代表としてv2を使用」等。テストの挙動・使用ファイルは変えなくてよい)。

## スコープ外

- 上記以外の申し送り(D4 canonical化、revert-catchingテスト、判定モード一覧の二重管理等)
- 挙動に影響する変更は要件1のみ。エンジンの探索・評価ロジックには触れない

## 受け入れ基準

1. 対局モードで数手進めた後「1手戻る」で初期局面まで戻したとき、定石トレース表示が残らないことを確認(修正前に再現→修正後に解消の記録)
2. `cargo test -p engine --lib` と `npx vitest run`(app/)全パス
3. 要件1はapp表示の変更のため、mainへpush→Actionsデプロイ成功→Pages実機で全戻し時のトレース消滅を確認
4. 変更ファイルはパス明示でコミット、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

- 2026-07-19(実施日はターン内、日付は2026-07-19表記のまま処理) 実装着手。T140作業ログ・T140-T141レビュー(`tasks/review/T140-T141-claude-review.md`【フォローアップ1】)を確認し、修正方針(`undoMove`に1行追加)を特定。
- **要件1(定石トレース残留)**: 原因は`app/src/app.tsx`の`josekiTrace`更新用`useEffect`が`ply <= 0`のとき早期`return`し`josekiTrace`を更新しないこと。全戻し(履歴が空)でも直前のtraceが残る。
  - 再現: `app/src/app.playmode.undo.test.tsx`に新規テスト「2人対戦: 1手目までundoして初期局面(ply=0)まで全戻しすると、定石トレース表示が残らない」を追加し、修正前に実行 → **失敗を確認**(`<p class="joseki-trace">定石: 兎(1手目)</p>`が残留、期待は`null`)。
  - 修正: `undoMove`内、`setEvalInfo(null)`の直後に`if (truncated.length === 0) setJosekiTrace(null)`を追加(1行、コメント3行)。
  - 解消確認: 同テストを再実行 → **8/8パス**(新規テスト含む)。
- **要件2(コメント陳腐化 v3→v4)**: `engine/src/protocol.rs:933`付近の「`pattern_v3.bin`(本番配信中の重み)」を「`pattern_v3.bin`(T122〜T146時点の本番配信重み、T147以降は`pattern_v4.bin`に切替済み)」に、`engine/src/pattern_eval.rs:871-873`付近の「本番はT122以降 v3×PatternWeights が配線済みで…`pattern_v3.bin`をロードして…」を「本番はT147以降 v4×PatternWeights が配線済みで…`pattern_v4.bin`をロードして…」に更新。D4非不変性の説明内容(disc乖離の数値・理由)自体は変更していない。`app/src/engine/worker.ts`の`PATTERN_WEIGHTS_URL`が`pattern_v4.bin`であることを確認済み(T147で切替済み)。
- **要件3(テスト表記)**: `engine/src/protocol.rs:953`(修正後954)付近のテスト`analyze_all_moves_from_initial_position_is_deterministic_with_production_weights_loaded`を`...with_pattern_weights_loaded`に改名(「production」の語を除去)。直前のコメントも「本番重みロード経路(…既存テストに倣いpattern_v2.binを使用)」→「実際の重みロード経路(…既存テストに倣い歴代重みの代表としてpattern_v2.binを使用。本番配信中の重みかどうかは本テストの関心事ではない)」に修正。テストの挙動・使用ファイル(pattern_v2.bin)は変更していない。関数名の参照は`engine/src/protocol.rs`内のみ(grep確認済み、他コード・CI設定からの参照なし)。
- テスト実行:
  - `cargo test -p engine --lib`: **200 passed; 0 failed; 2 ignored**(改名後のテスト名`analyze_all_moves_from_initial_position_is_deterministic_with_pattern_weights_loaded`含め全パス)。
  - `npx vitest run`(app/): **96 test files / 782 tests 全パス**。
- コミット: 変更対象4ファイル(`app/src/app.tsx`, `app/src/app.playmode.undo.test.tsx`, `engine/src/pattern_eval.rs`, `engine/src/protocol.rs`)のみパス明示で`git add`。コミットハッシュ`70fbe23`(「app,engine: 軽微申し送り束ね(定石トレース残留修正・コメント陳腐化更新)(T148)」)。`tasks/`・`CLAUDE.md`は対象外(コミットしていない)。
- `git push origin main`成功(`d04ce78..70fbe23`)。GitHub Actions: `gh run watch`で`Deploy to GitHub Pages`(29707072731)・`Rust Tests`(29707072747)いずれも**成功**を確認。
- 本番Pages(`https://giwarb.github.io/othello-trainer/`)実機確認(Browser MCP、Service Workerの「今すぐ更新」で最新ビルド反映後): 対局モード→2人対戦で開始→f5着手→「定石: 虎(他111)(1手目)」表示を確認→「1手戻る」クリック→**盤面が初期局面(黒2/白2、手番:黒)に戻り、`.joseki-trace`要素が消滅(`null`)、「1手戻る」ボタンがdisabledに戻る**ことを確認(修正の解消を本番環境でも確認)。
- `git status --short`: クリーン(タスク完了時点で差分・未追跡なし)。

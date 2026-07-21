---
id: T170
title: 申し送り消化: node-budgetゲートのv5化+local_tt.clear()回帰テスト
status: done # verifier合格(regression-catchingをworktreeで独立再現、失敗値left:6299/right:6529まで一致。restrict_to分離の本番経路不変も精読+既存決定性テストで裏付け)、2026-07-21。軽微タスクにつき代替レビュー省略
assignee: implementer
attempts: 0
---

# T170: 申し送り2件の消化

## 目的

D1採用のユーザー裁定待ちの間に、積み残しの申し送り2件を消化する(いずれも小粒・独立)。

## 要件

1. **[T167レビュー中1] node-budgetビルドゲートのv5化**: `app/scripts/test-node-budget-wasm.mjs` が旧 `pattern_v4.bin` を参照したまま=非本番構成でのゲートになっている。現本番 `pattern_v5.bin` 参照に更新し、期待値(ノード数等のgolden)が変わる場合は再取得して更新(変更理由を作業ログに)。`npm run build` が通ること。
2. **[T145申し送り] local_tt.clear() 回帰テスト**: `engine/src` の `search_all_moves_with_eval` 内の `local_tt.clear()` を誤って削除しても既存テストが検知できない(検知力ゼロ、T145で確認済み)。設計案(T145作業ログ参照): トランスポジションが実際に起きる局面選定+TT容量縮小での衝突誘発により、clear()削除で結果が変わるテストを追加する。**受け入れの核心: clear()を一時的に削除するとテストが失敗し、戻すと合格することの実証(regression-catching、T117/T163方式)を作業ログに記録**。

## スコープ外

- D1候補の本番配線(ユーザー裁定後の別タスク)
- 探索・評価のロジック変更(テスト追加とスクリプト参照先変更のみ)

## 受け入れ基準

1. `npm run build`(app)成功、`cargo test -p engine` 全パス(新規テスト込み)
2. regression-catching実証の記録が作業ログにある
3. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装(implementer)

**要件1: node-budgetビルドゲートのv5化**

- `app/scripts/test-node-budget-wasm.mjs` の重み参照を `../public/pattern_v4.bin` → `../public/pattern_v5.bin` に更新。理由をコメントで追記(6-12行目): T167で本番配線がv4→v5に切り替わったのに本スクリプトだけ旧v4参照のままだった。
- goldenの再取得について: 本スクリプトは固定の期待値(golden)を一切持たない設計だった(`first`自身を基準に`second`/`afterUnrelated`との一致だけを見る自己参照的な決定性チェック、`grep`で他ファイルからの参照も無いことを確認済み)。よって「再取得すべき外部golden値」は存在せず、再取得作業は不要と判断した。
- 検証: `node src/engine/build-wasm.mjs` → `node scripts/test-node-budget-wasm.mjs` を実行し、`d6` 手・深さ・ノード数は変化なし、スコアのみv4→v5で変化(重みが変わったので当然、`(11.09)`→`(1.18)`)。フェイルなし(固定goldenが無いため)。
- `npm run build` フル実行、成功(`test-node-budget-wasm.mjs`・`test-pattern-v5-wasm.mjs` の両WASMゲート含む)。
- `npm test -- --run`: 832/832 pass(98ファイル)。

**要件2: local_tt.clear() 回帰テスト**

- 設計方針の変遷: 当初はT145作業ログの案どおり「mv_keepを唯一の合法手にした孤立盤面」を石で他の合法手先を埋めて構築し、多合法手盤面(mv_keepが最後に評価される)とノード数を比較する方式を試みた。しかし実際に構築を試すと、他の合法手の着手先マスをどちらの色で埋めても高確率(数千パターンの探索で大半)で別方向に新しい合法手が偶然発生してしまい、「他の合法手が0個」の盤面を安定して作れないことが分かった。次に「mv_keepの反転レイ(8方向)の外側だけに石を追加して他の合法手集合を変える」方式を試したが、追加した石がmv_keep着手後の局面にそのまま残ってしまい、2盤面間で「mv_keep着手後の局面」自体が一致しなくなる(ノード数の差がTT汚染由来か局面差由来か切り分けられない)ことが判明した。2つの異なる盤面を用意する限り、「他の合法手集合を変える」ことと「mv_keep着手後の局面を完全一致させる」ことは原理的に両立しないと結論した。
- 採用方式: 盤面を1つだけ使い、`search_all_moves_with_eval_core`(T170で新設したテスト用ラッパー、ノード数も返す)の実装本体を `search_all_moves_with_eval_core_restricted` として分離し、評価する合法手集合をテスト専用パラメータ `restrict_to: Option<&[u8]>` で絞り込めるようにした(本番経路である公開関数 `search_all_moves_with_eval` は常に `restrict_to: None` を渡すため本番挙動に影響なし)。同一盤面から `restrict_to: None`(全合法手、mv_keepは最後に評価)と `restrict_to: Some(&[mv_keep])`(mv_keepのみ)の2通りで呼び出し、mv_keepのノード数を比較する。同一盤面由来なので mv_keep 着手後の局面は自明に完全一致する。
- 位置選定: `random_position(0x7170_5EED, 40)`(合法手4つ以上)、TT容量を意図的に縮小(`TINY_TT_MB = 1`、本番16MBに対して)して衝突・汎用エントリの再利用が起きやすい状態にした。`max_depth` は当初12で試し正しく検知できたが実行に約60秒かかったため、`max_depth: 8` に縮小して再実験、0.9秒程度に短縮しても同様に検知できることを確認し、こちらを採用した。
- **regression-catching実証(T117/T163方式)**:
  - `local_tt.clear();`(`engine/src/search.rs` の `search_all_moves_with_eval_core_restricted` 内、ループ先頭)を一時的にコメントアウトして `cargo test -p engine --lib search_all_moves_with_eval_local_tt_clear -- --nocapture` を実行 → **失敗を確認**: `assertion left == right failed ... left: 6299 right: 6529`(depth=8時点)。depth=12でも同様に `left: 493685 right: 523131` で失敗することを先に確認済み。
  - `local_tt.clear();` を元に戻して同じコマンドを再実行 → **合格を確認**(`test result: ok. 1 passed`)。
  - 以上により、本テストが `local_tt.clear()` の削除を確実に検知できることを実証した。
- 全体検証: `cargo build -p engine` warningなし。`cargo test -p engine --lib` 240 passed / 0 failed / 2 ignored(新規テスト含む、59.5秒)。`cargo test -p engine`(全バイナリ)も全パス。`cargo clippy -p engine --all-targets` で新規コード(`search_all_moves_with_eval_core_restricted`・新規テスト該当行)に警告なし(既存の無関係な警告のみ残存、`patterns.rs`のneedless_range_loop等はスコープ外につき未対応)。

**変更ファイル**: `app/scripts/test-node-budget-wasm.mjs`, `engine/src/search.rs`

**git status**: パス明示コミット予定(`app/scripts/test-node-budget-wasm.mjs`, `engine/src/search.rs`)、完了時に `git status --short` は本タスクファイル(work log追記分のみ)を除きクリーン。

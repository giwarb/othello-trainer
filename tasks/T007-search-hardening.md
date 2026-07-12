---
id: T007
title: 探索エンジンの補強(TTスケール混同防止・終局ロジック重複解消)
status: done
assignee: implementer
attempts: 0
---

# T007: 探索エンジンの補強(TTスケール混同防止・終局ロジック重複解消)

## 目的
T005(探索エンジン)のreviewerレビューで指摘された、将来のバグの種になりうる2つの設計課題を修正する。現時点ではテスト上顕在化しないが、T008(WASM API + Workerプロトコル)で「同じ `TranspositionTable` を複数回の `search()` 呼び出しに跨って使い回す」実装をする前に直しておく必要がある。

## 背景・コンテキスト
- T005 (`engine/src/search.rs`) は完了・コミット済み。reviewerから以下2点の指摘があった:
  1. **TTスケール混同リスク**: `negascout()` は「盤面の空きマス数だけでNegaScout担当(centi-discスケール、depth=残りプライ数)/終盤ソルバー担当(素の石差スケール、depth=残り空きマス数)が一意に決まる」という前提に立っているが、これは `SearchLimit::exact_from_empties` が**同じTTに対して常に同じ値である**場合にのみ成立する。もし将来、同一の `tt` に対して異なる `exact_from_empties` で `search()` を呼び直すと、過去に書き込まれたエントリのスケール/depth解釈が食い違い、`entry.depth as u32 >= depth as u32` の判定を通過して**誤ったスコアを黙って返す**リスクがある。
  2. **終局ロジックの重複**: `engine/src/endgame.rs` の `final_score`(非公開関数、「石数が多い方が残り空きマスを総取り」)と、`engine/src/search.rs` の `terminal_score_centi` が同じロジックを別々に実装している。将来どちらか一方だけ変更されると挙動が乖離する。

## 変更対象
- `engine/src/tt.rs` — `TranspositionTable` に「このTTが最後に使われた `exact_from_empties` 値」を記録するフィールドを追加
- `engine/src/search.rs` — `search()` 呼び出し時にTTの記録値と `limit.exact_from_empties` を比較し、不一致ならTTを自動クリアする処理を追加。`terminal_score_centi` を独自実装ではなく `endgame::final_score` を再利用する形に変更
- `engine/src/endgame.rs` — `final_score` を `pub(crate)` に変更(現在プライベートな場合)

## 要件
1. `TranspositionTable` に `last_exact_from_empties: Option<u8>` のようなフィールドを追加する(`new` では `None` で初期化)。
2. `search()` の冒頭で、TTの `last_exact_from_empties` が `Some(x)` かつ `x != limit.exact_from_empties` であれば、探索前に `tt.clear()` を呼んでから探索を実行し、その後 `last_exact_from_empties` を今回の値で更新する(これにより、`exact_from_empties` を変えて同じTTを使い回しても、スケールの異なる古いエントリが誤って再利用されることはなくなる)。値が一致する場合や初回呼び出し(`None`)の場合はクリア不要。
3. この自動クリア処理は**リリースビルドでも常に有効**にすること(debug_assertではなく実行時の通常ロジックとして実装し、本番相当のWASMビルドでも安全性が保たれるようにする)。
4. `engine/src/endgame.rs` の `final_score` 関数を `pub(crate)` にし、`engine/src/search.rs` の `terminal_score_centi` はこの `final_score` を呼び出して×100するだけの薄いラッパーに書き換える(ロジックの重複を解消する)。
5. 単体テストを追加する:
   - 同じ `TranspositionTable` に対して `exact_from_empties=X` で1回 `search()` を呼んでTTにエントリを書き込ませた後、`exact_from_empties=Y`(X≠Y)で同じTTを使って再度 `search()` を呼んでも、クラッシュせず、かつ2回目の呼び出し後の `tt.last_exact_from_empties` が `Some(Y)` に更新されていることを確認する。
   - `search()` が返す終局スコア(両者パスの局面)が `endgame::final_score` を直接呼んだ結果(×100)と一致することを確認する(重複コードが本当に統合されたことの確認)。

## やらないこと(スコープ外)
- ムーブオーダリングの盤面二重計算の最適化(reviewerが軽微な指摘として挙げたが、パフォーマンス最適化はT008以降のベンチ結果を見てから判断する)
- `nodes` カウンタが終盤ソルバー内部のノードをカウントしない件の修正(observability上の軽微な指摘であり、今回は対応不要)
- MPCやマルチスレッド化など、T005で明示的にスコープ外とされていた事項

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine` が全件パスする(既存35件 + 本タスクで追加したテスト)
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る
- [ ] 追加したテストが実際に「TTのスケール混同が解消されたこと」「終局ロジックの重複が解消されたこと」を検証していることをコードレビューで確認できる

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-07 implementer:
  - `engine/src/tt.rs`: `TranspositionTable` に `last_exact_from_empties: Option<u8>` フィールドを追加(`new()` では `None` で初期化)。取得用 `last_exact_from_empties()` と設定用 `set_last_exact_from_empties(value)` を `pub` メソッドとして追加。
  - `engine/src/search.rs`: `search()` の冒頭で `tt.last_exact_from_empties()` が `Some(x)` かつ `x != limit.exact_from_empties` の場合に `tt.clear()` を実行し、その後常に `tt.set_last_exact_from_empties(limit.exact_from_empties)` で更新するロジックを追加(debug_assert等は使わず通常の実行時ロジックとして実装、リリースビルドでも常に有効)。`terminal_score_centi` は独自実装をやめ、`endgame::final_score(board, side) * 100` を呼ぶだけの薄いラッパーに変更。
  - `engine/src/endgame.rs`: `final_score` を `fn` から `pub(crate) fn` に変更し、`search.rs` から再利用可能にした(ロジック本体は変更なし)。
  - テスト追加(`engine/src/search.rs` の `tests` モジュール):
    - `reusing_tt_across_calls_with_different_exact_from_empties_does_not_crash_and_updates_marker`: 同じTTに対して `exact_from_empties=10` → `12` の順で `search()` を呼び、クラッシュしないこと、および呼び出しごとに `tt.last_exact_from_empties()` が `Some(10)` → `Some(12)` と正しく更新されることを確認。
    - `search_terminal_score_matches_endgame_final_score_directly`: 両者パスで即終局する人工局面(盤面をほぼ全て黒で埋め、d4のみ空き)に対し、`exact_from_empties=0` にして終盤ソルバーではなく `negascout` の両者パス分岐(`terminal_score_centi`)を必ず通るようにし、`search()` の返すスコアが `endgame::final_score(&board, Side::Black) * 100` と完全一致することを確認(終局ロジック重複解消の検証)。
  - 検証結果:
    - `cargo test -p engine` → `test result: ok. 37 passed; 0 failed`(既存35件 + 追加2件)。
    - `cargo clippy -p engine -- -D warnings` → 警告0で完了。
    - `cargo build -p engine --target wasm32-unknown-unknown` → ビルド成功。
  - スコープ外(要件通り対応せず): ムーブオーダリングの盤面二重計算最適化、`nodes` カウンタの終盤ソルバー内部ノード非計上、MPC/マルチスレッド化。

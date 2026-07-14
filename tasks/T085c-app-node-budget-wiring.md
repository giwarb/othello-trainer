---
id: T085c
title: ノード予算探索のWorker・アプリ配線(maxNodes追加、強CPUプリセットへ160k/1500ms適用)
status: done # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 1
---

# T085c: ノード予算探索のWorker・アプリ配線

## 目的

T085a/T085b で確立・校正したノード数予算ベースの決定論的探索(**採用値: 160,000ノード + wall保険1500ms**、T085b decision.md 参照)を、アプリの CPU 対局経路に配線する。これにより本番アプリの強いCPUが、壁時計分割(1候補約100ms)ではなく校正済みノード予算のsingle-root探索で着手するようになる。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§3(T085c)**。
- 採用値の根拠: `bench/edax-compare/t085_node_budget_decision.md`(T085b、コミット 6dd70a5)。
- エンジン側は実装済み: `search_with_eval_with_node_limit` 相当のノード予算経路(T085a、quota 40%・baseline-first・決定論)。本タスクは**プロトコルとアプリの配線のみ**。
- 関連コード: `engine/src/protocol.rs`、`app/src/engine/types.ts`、Worker/clientのリクエスト型、`app/src/app.tsx` のCPUプリセット、解析キャッシュのキー生成箇所。

## 変更対象(設計書§3)

- `engine/src/protocol.rs` — `LimitJson` / `AnalyzeLimit` に `#[serde(default, rename = "maxNodes")] pub max_nodes: Option<u64>` を追加
- `app/src/engine/types.ts` — 対応する型追加
- Worker/client のリクエスト型 — `maxNodes` の受け渡し
- `app/src/app.tsx` — **強いCPUプリセットのみ** `maxNodes: 160000` + `timeMs: 1500`(保険)を設定
- 解析キャッシュのキー生成 — `maxNodes` をキーに含める(同一局面でも予算が違えば別キャッシュ)
- 関連テスト

## 要件

1. **CPU対局の非`allMoves`経路**でノード予算探索を呼ぶ(設計書§3)。
2. **`allMoves:true` かつ `maxNodes` 指定はエラーにする**(設計書§3の指定。総ノード予算の意味が未定義のため。「候補ごとに同じmax-nodesを与える」実装は禁止=合法手数倍の予算になる)。エラーはプロトコルの標準エラー経路で返し、テストで固定する。
3. 適用範囲は**強いCPUプリセットのみ**。解析・詰めオセロ・全合法手比較(悪手判定用の一括評価)・弱いCPUには適用しない(従来動作を変えない)。
4. 既存動作の回帰を防ぐ: `maxNodes` 未指定のリクエストは従来と完全に同一の挙動(既存テストで担保)。
5. WASM実行でもノード予算の決定論が成り立つこと(同一局面・同一設定で2回同じ手/スコア)。
6. テスト作成もタスクに含む(protocol.rsのserdeテスト、Workerメッセージの型テスト、allMoves+maxNodesエラーのテスト等)。

## やらないこと(スコープ外)

- エンジン探索ロジックの変更(T085a確定済み)
- ベンチハーネス(`bench/`)の変更
- 弱いCPUプリセット・解析経路・詰めオセロへのノード予算適用(将来タスク)
- TT置換規則(T086)以降の施策
- UIの新規設定項目(プリセット内部の値変更のみ。ユーザー向け設定UIは作らない)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocol.rsの新テスト含む)
- [ ] `cd app && npm test` 全件パス(型・Worker関連の新テスト含む)
- [ ] `cd app && npm run build` 成功
- [ ] `allMoves:true` + `maxNodes` 指定がエラーを返すテストがあり、パスしている
- [ ] `maxNodes` 未指定時の挙動が従来と不変(既存テスト全パスで担保)
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、Playwright(CLI/スクリプト)で本番URL(https://giwarb.github.io/othello-trainer/)の対局モードで強いCPUが正常に着手することを確認する(デプロイ待ちは `gh run watch` 等で待機)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後)

## フィードバック(やり直し時にオーケストレーターが記入)

### redo #1(2026-07-14、codex-review不合格。verifierは合格=配線・適用範囲・本番動作・キャッシュキーは問題なし)

**ブロッカー(codex-reviewが実測再現、レポート `tasks/review/T085c-app-node-budget-wiring-codex-review.md` 参照)**: 本番Workerは単一 `Engine` を保持しリクエスト間でTT(置換表)を再利用するため、ノード予算探索が決定的にならない。同一Engineに同一リクエストを2回投げると、着手は一致してもスコア・到達深さが変化する(実測: smoke-01・本番強CPU設定で 1回目 d6/6.12/depth9 → 2回目 d6/0.50/depth10)。評価バー・全合法手比較も同じWorker/TTを使うため、CPU着手の結果が過去の探索や表示設定の影響を受ける。T085bの校正は毎回新しいTTで行われており、本番と前提が食い違う。

修正要求:
1. **`max_nodes` 指定の探索(強CPU着手経路)では、探索開始時のTT状態を校正条件と一致させる**こと。推奨は「node-budget探索の開始前にTTをクリア(または専用の新規TTを使用)」— T085bの棋力・regret数値は毎回新TTの条件で校正されたものなので、これが校正結果と整合する唯一の前提。TTクリアのコストは1手あたりで許容範囲(校正実測もその条件)。`max_nodes` 無しの経路(解析・評価バー・詰めオセロ・FFO等)は従来どおりTT再利用のまま一切変更しない。
2. **回帰テストを実際のWorker経路と同じ前提に修正する**: (a) `app/scripts/test-node-budget-wasm.mjs` と `engine/src/protocol.rs` のテストを「**同一Engineインスタンス**に本番重み(pattern_v2.bin)+本番強CPU設定で同一リクエストを連続2回以上」投げて move/score/depth/nodes の**完全一致**をassertする形に変更。(b) さらに間に無関係な探索(評価バー相当のallMoves等)を挟んでも結果が不変であることを確認するテストを追加(TT汚染の再現ケース)。
3. 修正後の再実行: `cargo test -p engine`(FFOのノード数不変も確認=TTクリアがmax_nodes経路以外に漏れていないこと)、`cd app && npm test`、`npm run build`(組み込み決定性チェックが新方式でパス)。コミット代行後にpush→Actionsデプロイ成功→本番URLでの動作確認は再度必要(受け入れ基準どおり)。

補足: verifierの合格項目(適用範囲の分離・allMovesエラー・キャッシュキー・本番デプロイ)は再実装で壊さないこと。変更は最小限(TT状態管理+テスト)に留める。

## 作業ログ(担当エージェントが追記)

### 2026-07-14 Codex実装

- `LimitJson` / `AnalyzeLimit` に `maxNodes` を追加し、非`allMoves`プロトコルを既存の`search_with_eval_with_node_limit`へ配線した。`allMoves:true`との併用は標準エラー応答に固定した。
- 強CPUの着手専用条件を解析・全合法手比較用条件から分離し、`160000 nodes + timeMs 1500`を強CPUのsingle-root着手だけへ適用した。弱い/普通CPU、評価バー、候補手オーバーレイ、悪手判定は従来条件のまま。
- 解析キャッシュの探索条件タグへ`maxNodes`を追加し、異なる予算を別キーにした。serde、Worker/client受け渡し、プリセット適用範囲、キャッシュキー、WASM決定性のテストを追加した。
- 実行結果:
  - `cargo test -p engine` — 成功(152 passed, 2 ignored。全ターゲット・doc testsも成功)
  - `cargo test -p engine --release --test ffo_bench` — 成功(fast 1 passed, heavy 1 ignored、483.11s)
  - `cd app && npm test` — 成功(61 files / 510 tests passed)。サンドボックスの子プロセス制限回避のためテスト実行時だけVite依存物とpool設定を一時変更し、実行後に完全復元。
  - `cd app && npm run build` — 成功(Vite production build成功、生成直後のWASMで同一局面・同一node予算の手/スコア一致を確認: `d3 (5.06)`)。サンドボックス内の書き込み可能WASMキャッシュとVite依存物の一時変更は実行後に削除・復元。
  - `git diff --check` — 成功
- コミットハッシュ: なし(`.git`書き込み禁止のためコミットはオーケストレーター代行)

### 2026-07-14 Codex再実装(redo #1)

- `maxNodes`指定のsingle-root探索開始前だけTTをクリアし、T085bの校正条件(探索ごとに空のTT)と本番Workerを一致させた。`maxNodes`未指定・`allMoves`・解析・終盤探索のTT再利用は変更していない。
- Rust/WASMの決定性テストを、本番重み`pattern_v2.bin`・本番強CPU設定・同一`Engine`インスタンスでの連続実行に変更した。途中に評価バー相当の`allMoves`探索を挟んだ後も、move/score/depth/nodesの完全一致を検証する。
- 実行結果:
  - `cargo test -p engine` — 成功(152 passed, 2 ignored。全ターゲット・doc testsも成功)
  - `cargo test -p engine --release --test ffo_bench` — 成功(fast 1 passed, heavy 1 ignored、502.54s)
  - `cargo test -p engine --release node_limited_protocol_requests_are_deterministic -- --nocapture` — 成功(本番1500ms設定で決定性テスト成功)
  - `cd app && npm test` — 成功(61 files / 510 tests passed)。サンドボックスの子プロセス制限回避のためVite依存物とpool設定を一時変更し、実行後に完全復元。
  - `cd app && npm run build` — 成功。生成WASMの同一Engineで連続実行・`allMoves`探索後とも完全一致(`d6`, score `6.12`, depth `9`, nodes `160001`)。書き込み可能な一時WASMキャッシュとVite依存物の変更は実行後に削除・復元。
  - `git diff --check` — 成功
- コミットハッシュ: なし(`.git`書き込み禁止のためコミットはオーケストレーター代行)

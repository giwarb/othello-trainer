---
id: T005
title: 探索エンジン(反復深化+PVS/NegaScout+置換表統合、終盤ソルバー連携)
status: done
assignee: implementer
attempts: 0
---

# T005: 探索エンジン(反復深化+PVS/NegaScout+置換表統合、終盤ソルバー連携)

## 目的
T004(評価関数)とT006(終盤完全読み)を統合し、実際に「今の局面で何手先まで読んでどの手が最善か」を返す中盤探索エンジンを実装する。これが完成すると、設計書のWorkerプロトコル(§2.4)で要求される `analyze` コマンドに応える中身が揃う。

## 背景・コンテキスト
- 前提: T002(bitboard)、T003(Zobrist/TT)、T004(eval)、T006(endgame)すべて完了していること。
- 設計書 §2.5.2「探索アルゴリズム」を参照:
  - 反復深化 + PVS(NegaScout)+ Aspiration Window
  - 置換表はT003のものを使う
  - 着手順序: TT手 → 浅い探索評価順 → 相手着手可能数最小化 → 隅・辺ボーナス(本タスクでは「TT手を最優先」「それ以外は簡易的なムーブオーダリング(隅を優先、相手モビリティを減らす手を優先)」程度でよい。MPC(Multi-ProbCut)は本タスクでは実装しない(スコープ外、フェーズ3以降で追加))
  - 空き24以下(閾値は設定可能な引数にする)でT006の `solve_exact` に自動切替
- Worker プロトコル(§2.4)の `limit` パラメータ(`depth`, `timeMs`, `exactFromEmpties`)にあたる探索制御を関数引数として受け取れるようにしておく(本タスクではWASM/JSバインディングは作らない。T007で行う。ここでは純Rust関数として実装する)。

## 変更対象(新規作成)
- `engine/src/search.rs` — 反復深化・PVS・探索制御
- `engine/src/lib.rs` — `mod search;` を追加

## 要件
1. 探索設定を表す構造体を定義する: `pub struct SearchLimit { pub max_depth: u8, pub time_ms: Option<u64>, pub exact_from_empties: u8 }`(`exact_from_empties`: この数値以下の空きマス数になったらT006の完全読みに切り替える。設計書の既定値は24。時間制御(`time_ms`)は本タスクでは「深さ探索の合間にチェックして、超過していたら現在完了している最も深い反復の結果を返す」程度の簡易実装でよい。`std::time::Instant` を使用してよい)。
2. 探索結果を表す構造体: `pub struct SearchResult { pub best_move: Option<u8>, pub score: i32, pub depth: u8, pub pv: Vec<u8>, pub nodes: u64 }`(`score`はcenti-disc単位、手番視点。`pv`は読み筋のマス番号列。`nodes`は探索したノード数)。
3. `pub fn search(board: &Board, side_to_move: Side, limit: &SearchLimit, tt: &mut TranspositionTable) -> SearchResult` を実装する:
   - 空きマス数が `limit.exact_from_empties` 以下になったら、T006の `solve_exact` を呼び出し、その結果を `score`(石差×100してcenti-disc化)として返す(この場合 `depth` は空きマス数そのものを設定してよい)。
   - それ以外(中盤)は反復深化: depth=1から`limit.max_depth`まで1手ずつ深くしながらNegaScout(PVS)探索を行い、T004の `evaluate_for`(またはStaticEvalトレイト経由)をリーフ評価に使う。各反復でTTを使い回す。
   - `time_ms` が設定されている場合、反復深化の各深さ完了ごとに経過時間をチェックし、超過していれば探索を打ち切ってその時点までの最良の結果を返す。
   - 合法手がない(パスすべき)局面が来た場合は、パスして相手番で同じdepth予算のまま再帰する(パスは深さを消費しない実装でよい。ただし両者パス=終局の場合は`solve_exact`相当のロジックか、単純に石差を返すこと)。
4. 単体テストで以下を検証する:
   - 初期局面から `max_depth=6` 程度で探索し、`best_move` が `None` にならず、`legal_moves` に含まれる合法手であることを確認する。
   - 空きマス数が `exact_from_empties` 以下になるよう手を進めた局面で `search` を呼び、返ってきた `score` がT006を直接呼んだ結果(石差×100)と一致することを確認する(統合が正しいことの確認)。
   - 明らかに一方が有利な人工局面(T004のテストで使ったような、黒が4隅を占める局面)で `search` を実行し、`score` が黒有利(正の値、手番が黒の場合)になることを確認する。
   - 反復深化で `max_depth` を1→2→3と増やしたとき、depth1の `best_move` とdepth3の `best_move` が(局面によっては変わることもあるが)少なくとも探索自体がエラーなく完了し、`depth`フィールドが要求どおり増えることを確認する。

## やらないこと(スコープ外)
- MPC(Multi-ProbCut)、Enhanced Transposition Cutoff等の高度な枝刈り(フェーズ3以降)
- Lazy SMP・マルチスレッド化(フェーズ7)
- WASM/Workerバインディング(T007)
- Aspiration Windowの厳密な実装(反復深化の基本形で十分。ウィンドウ幅の最適化は任意)

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine search` が全件パスする
- [ ] `cargo test -p engine` (クレート全体)が全件パスする
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る
- [ ] `cargo test -p engine --release search -- --nocapture` で、初期局面からdepth10前後までの探索が数秒〜数十秒程度で完了することをログで確認する(具体的なNPS目標値はT008のFFOベンチで扱うため、本タスクでは「異常に遅くない(明らかな無限ループや指数的爆発がない)」ことの確認でよい)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-07 implementer: `engine/src/search.rs` を新規作成し、`engine/src/lib.rs` に `mod search;` を追加した。
  - `SearchLimit { max_depth, time_ms, exact_from_empties }` / `SearchResult { best_move, score, depth, pv, nodes }` を実装。
  - `search()`: 空きマス数が `exact_from_empties` 以下ならT006 `solve_exact` の結果を×100してcenti-disc化して返す。それ以外は depth=1..=max_depth の反復深化でNegaScout(PVS)を実行し、各反復ごとにTTを使い回す。`time_ms` 設定時は各深さ完了後に経過時間をチェックし、超過していればその時点の最良結果を返す。
  - `negascout()`: NegaScout(PVS, fail-soft alpha-beta + null window search + 再探索)本体。**探索木の途中のノードでも**空きマス数が閾値以下になった時点でT006の`solve_exact`に切り替える設計とした(ルート呼び出しだけでなく再帰内でも判定)。ある局面が「終盤ソルバー担当」か「中盤NegaScout担当」かはその局面の空きマス数のみで一意に決まるため、TTの`depth`フィールドの意味(終盤=残り空きマス数、中盤=残りプライ数)が混同されることはない。
  - 合法手なし(パス)の場合は深さを消費せず相手番で再帰。両者パス(終局)の場合はT006と同じ「石数が多い方が残り空きマスを総取り」する慣習をcenti-discスケールで再実装した`terminal_score_centi`で計算(`endgame::final_score`はプライベート関数のため独立実装)。
  - ムーブオーダリング: TT手を最優先、それ以外は隅優先→相手の着手後合法手数が少ない順(`ordered_moves`)。
  - 引数が多くなる`negascout`はclippyの`too_many_arguments`を避けるため`SearchCtx`構造体に`limit`/`tt`/`nodes`をまとめて渡す設計にした。
  - 単体テスト5件を追加(要件4の4項目に対応): 初期局面での合法手検証、終盤ソルバーへの委譲とスコア一致検証(単純な符号反転の等式は要求せず、`search()`が返すスコアと直接`solve_exact(...) * 100`を呼んだ結果が一致することのみを検証)、黒4隅保持局面でのスコア正検証、反復深化のdepth1→2→3のエラーなし完走検証。
  - 検証結果:
    - `cargo build -p engine`: 成功。
    - `cargo test -p engine search`: 5 passed。
    - `cargo test -p engine`: 35 passed(クレート全体)。
    - `cargo build -p engine --target wasm32-unknown-unknown`: 成功。
    - `cargo clippy -p engine -- -D warnings`: 警告0で成功。
    - `cargo test -p engine --release search -- --nocapture`: 5 passed。初期局面からdepth=9(exact_from_empties=12のため空き12以下で終盤ソルバーに切替)まで release ビルドで約4.4ms、7786ノードで完了(異常な爆発なし)。

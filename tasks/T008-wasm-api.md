---
id: T008
title: WASM API(Engine構造体 + JSON解析プロトコル)
status: done
assignee: implementer
attempts: 0
---

# T008: WASM API(Engine構造体 + JSON解析プロトコル)

## 目的
これまで純Rustとして実装してきた探索エンジン(T002〜T007)を、設計書のWorkerプロトコル(§2.4)に沿ったJSON入出力でJS/TSから呼び出せるようにする。これでフェーズ1の「WASM化」要件が完了する。

## 背景・コンテキスト
- 前提: T001〜T007すべて完了・コミット済み。`engine/src/search.rs` の `pub fn search(board: &Board, side_to_move: Side, limit: &SearchLimit, tt: &mut TranspositionTable) -> SearchResult` が使える。
- 設計書 `othello-trainer-design.md` §2.4「Worker プロトコル(JSON ベース)」を参照。リクエスト例:
  ```jsonc
  { "id": 42, "cmd": "analyze",
    "board": { "black": "0x0000000810000000", "white": "0x0000001008000000", "turn": "black" },
    "limit": { "depth": 20, "timeMs": 1000, "exactFromEmpties": 24 },
    "multiPV": 3 }
  ```
  レスポンス例(本タスクでは `final: true` の1回きりの応答のみ実装する。逐次進捗報告(`final: false`)は本タスクのスコープ外):
  ```jsonc
  { "id": 42, "final": true, "depth": 14,
    "pv": ["f5","d6","c3"],
    "score": { "type": "midgame", "discDiff": 2.4 },
    "nodes": 18400000, "nps": 21000000 }
  ```
- **本タスクでは `multiPV`(複数候補手の返却)は実装しない(スコープ外)**。`moves` 配列もリクエストの `multiPV` も無視してよい(リクエストに含まれていてもエラーにしない。単に読み捨てる)。
- Board表現: `black`/`white` は `"0x"` 始まりの16進数文字列(64bit値)。`turn` は `"black"` または `"white"`。
- マス番号(0〜63)と `a1`〜`h8` 記法の対応は `engine/src/bitboard.rs` 冒頭に明記された規約(`index = rank0*8 + file`、a=0..h=7)に従う。`pv` はこの記法の文字列配列で返す。
- `score.discDiff` は centi-disc値(`SearchResult.score`)を100で割ったf64値。`score.type` は、**リクエストで渡された盤面の空きマス数が `limit.exactFromEmpties` 以下なら `"exact"`、そうでなければ `"midgame"`**(呼び出し前に自分で空きマス数を計算して判定する。`search()`の返り値からは直接分からないため、呼び出し側でこの判定を行うこと)。
- **エンジンの状態(置換表TT)は呼び出しをまたいで保持する**(Workerが同じエンジンインスタンスを使い続け、TTを使い回すことで探索が高速化される設計のため)。このためJS側から呼び出す単位は「関数」ではなく「インスタンス(構造体)」にする。T007で `TranspositionTable` に `exact_from_empties` が変わった場合の自動クリア処理を実装済みなので、これを活かせる設計になる。

## 変更対象(新規作成/変更)
- `engine/Cargo.toml` — `serde`(`features = ["derive"]`)と `serde_json` を依存に追加
- `engine/src/protocol.rs` — JSONリクエスト/レスポンスの構造体定義とパース・変換ロジック
- `engine/src/lib.rs` — `mod protocol;` を追加。`Engine` 構造体を `#[wasm_bindgen]` で公開

## 要件
1. `engine/src/protocol.rs` に以下を実装する:
   - `#[derive(serde::Deserialize)]` で `AnalyzeRequest { id: u64, cmd: String, board: BoardJson, limit: LimitJson }` を定義(`multiPV` フィールドが来ても無視してよいよう `#[serde(default)]` 付きの未使用フィールドとして受けるか、`#[serde(flatten)]`等は使わずシンプルに、serdeのデフォルト挙動(未知フィールドは無視)に任せてよい)。
   - `BoardJson { black: String, white: String, turn: String }`。`black`/`white` は `"0x"` プレフィックスを取り除いて `u64::from_str_radix(.., 16)` でパースする。`turn` は `"black"`/`"white"` 文字列から `Side` に変換する(それ以外の値ならエラー)。
   - `LimitJson { depth: u8, #[serde(rename = "timeMs")] time_ms: Option<u64>, #[serde(rename = "exactFromEmpties")] exact_from_empties: u8 }`。
   - レスポンス用に `#[derive(serde::Serialize)] AnalyzeResponse { id: u64, #[serde(rename = "final")] is_final: bool, depth: u8, pv: Vec<String>, score: ScoreJson, nodes: u64, nps: u64 }` と `ScoreJson { #[serde(rename = "type")] kind: String, #[serde(rename = "discDiff")] disc_diff: f64 }` を定義する(`final` はRustの予約識別子のためフィールド名は `is_final` にし、`#[serde(rename = "final")]` でJSON上は `final` として出力する)。
   - エラー応答用に `#[derive(serde::Serialize)] ErrorResponse { id: Option<u64>, error: String }` を定義する(JSONパース失敗時など、`id` が読み取れない場合は `None` でよい)。
   - マス番号→記法変換 `pub fn square_to_notation(idx: u8) -> String`(例: 0→"a1", 63→"h8")と、盤面のZobrist等とは無関係な単純な変換関数を実装する。
   - `pub fn handle_analyze(request_json: &str, side_engine: &mut crate::search::SearchLimit /* 実際の型は実装者が適切に設計してよい */, tt: &mut crate::tt::TranspositionTable) -> String` のような、JSON文字列を受け取りJSON文字列を返す関数(または`Engine`のメソッドから呼ばれるヘルパー関数)を実装する。内部で:
     a. JSONパースに失敗したら `ErrorResponse` をJSON化して返す(**絶対にpanicしないこと**。wasm上でのpanicはモジュール全体をクラッシュさせるため)。
     b. `board.black`/`board.white` の16進パースに失敗したら同様にエラー応答。
     c. `cmd` が `"analyze"` 以外なら「未対応のコマンド」エラー応答を返す(将来 `cmd` が増えても壊れないように)。
     d. 正常時は `Board { black, white }` を構築し、空きマス数を数えて `score.type` を判定した上で `search::search(&board, side, &limit, tt)` を呼び、結果を `AnalyzeResponse` に変換してJSON化して返す。`nps`(1秒あたりノード数)は探索にかかった実時間(`std::time::Instant`で計測)から計算する(0除算を避けるため、経過時間が極端に短い場合は `nodes` をそのまま `nps` として使うなど安全にフォールバックしてよい)。
2. `engine/src/lib.rs` に `#[wasm_bindgen] pub struct Engine { tt: TranspositionTable }` を定義し、以下のメソッドを実装する:
   - `#[wasm_bindgen(constructor)] pub fn new() -> Engine`: 内部で `TranspositionTable::new(64)`(64MB、設計書の既定値)を生成して保持する。
   - `pub fn analyze(&mut self, request_json: &str) -> String`: 上記 `handle_analyze` 相当のロジックを呼び出し、`self.tt` を使い回す。
3. 単体テスト(`#[cfg(test)]`、ネイティブターゲットで実行、`cargo test -p engine` でOK)で以下を検証する:
   - 標準初期局面のJSONリクエスト(design書の例のような形式)を `Engine::new()` → `analyze()` に渡し、返ってきたJSON文字列を `serde_json` でパースして、`id` がリクエストと一致すること、`pv` が空でなく最初の要素が合法手の記法と一致すること、`depth >= 1`、`score.discDiff` が数値として得られることを確認する。
   - 壊れたJSON(構文エラー)を渡した場合、パニックせずにエラーを示すJSON(`error`フィールドを含む)が返ることを確認する。
   - 16進数として不正な `black`/`white` 文字列を渡した場合も同様にパニックせずエラー応答になることを確認する。
   - 空きマス数が `exactFromEmpties` 以下になるよう手を進めた局面を渡すと `score.type == "exact"` になり、それ以外では `"midgame"` になることを確認する。
   - 同じ `Engine` インスタンスに対して2回連続で `analyze()` を呼んでも(TTを使い回しても)パニックせず正常な応答が返ることを確認する(T007のTTスケール混同防止ロジックが機能していることの間接確認)。

## やらないこと(スコープ外)
- `multiPV`(複数候補手)の実装。リクエストに含まれていても無視してよい。
- 逐次進捗報告(`final: false` の中間結果をコールバック等でJSに送る仕組み)。これは `/app` 側のWeb Worker実装(フェーズ2)で扱う。
- 実際のWeb Worker(`postMessage`)やJS/TS側のラッパーコードの実装(これはフェーズ2の `/app` タスクで行う)。
- SIMD128・マルチスレッド化。
- FFOベンチマーク(T009で別途実施)。

## 受け入れ基準(検証コマンド)
- [ ] `cargo test -p engine` が全件パスする(既存37件 + 本タスクで追加したテスト)
- [ ] `cargo build -p engine --target wasm32-unknown-unknown` が成功する
- [ ] `cd engine && wasm-pack build --target web` が成功する(serde/serde_json追加後もwasmビルドが壊れていないことの確認)
- [ ] `cargo clippy -p engine -- -D warnings` が警告0で通る

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-07 implementer: 要件どおりに実装した。
  - `engine/Cargo.toml`: `serde`(`features = ["derive"]`)と `serde_json` を依存に追加。
  - `engine/src/protocol.rs`(新規): `BoardJson`/`LimitJson`/`AnalyzeRequest`/`ScoreJson`/`AnalyzeResponse`/`ErrorResponse` を定義。`square_to_notation` とJSON文字列⇄探索実行を担う `handle_analyze(request_json: &str, tt: &mut TranspositionTable) -> String` を実装(タスク記載の候補シグネチャから、呼び出し側で `SearchLimit` を都度JSONから構築する設計に変更。タスク文中の「実際の型は実装者が適切に設計してよい」に基づく)。JSONパース失敗・16進数パース失敗・`turn`不正値・`cmd`不一致はすべて`.unwrap()`を使わず`Result`/`match`で受けて`ErrorResponse`のJSON文字列を返すようにし、panicしない設計にした。`multiPV`はフィールドとして受け取るが未使用(`#[allow(dead_code)]`を明示)、読み捨てる。`nps`計算はゼロ除算回避のため`checked_div`+`unwrap_or(nodes)`で安全にフォールバックする。
  - `engine/src/lib.rs`: `mod protocol;` を追加し、`#[wasm_bindgen] pub struct Engine { tt: TranspositionTable }` と `Engine::new()`(TT 64MBで初期化)、`Engine::analyze(&mut self, request_json: &str) -> String`(`protocol::handle_analyze`に委譲)を実装。`clippy::new_without_default` 対策として `impl Default for Engine` も追加。
  - `engine/src/protocol.rs` 内 `#[cfg(test)] mod tests` にテストを7件追加(標準初期局面での正常応答検証、壊れたJSON、不正16進数、未対応`cmd`、`exactFromEmpties`閾値による`score.type`の`"exact"`/`"midgame"`切り替え、同一`Engine`インスタンスへの2回連続`analyze()`呼び出しがpanicしないこと)。
  - 検証結果:
    - `cargo test -p engine` → `test result: ok. 44 passed; 0 failed`(既存37件 + 新規7件)。
    - `cargo build -p engine --target wasm32-unknown-unknown` → `Finished` (成功)。
    - `cd engine && wasm-pack build --target web` → `[INFO]: ✨ Done`(成功、`engine/pkg` に出力)。
    - `cargo clippy -p engine -- -D warnings` → 警告0で `Finished`(成功)。
  - 補足: 実装中に1点だけclippy指摘があり修正済み(`clippy::manual_checked_ops`: ゼロ除算チェック付きの手書き除算を `checked_div` ベースの実装に置き換えた)。

use wasm_bindgen::prelude::*;

// `bitboard` / `endgame` / `tt` は `pub` にして、`engine/tests/` 配下の
// 統合テスト(T009: FFO endgame test ベンチマーク)から
// `Board`/`Side`/`solve_exact`/`TranspositionTable` を直接利用できるようにする。
// (統合テストは別クレート扱いになるため `pub(crate)` では参照できない。
// `#[wasm_bindgen]` は個々の関数/implに付与されるものなのでこの可視性変更
// 自体はWASM側の公開APIには影響しない)
pub mod bitboard;
pub mod endgame;
// T024: `eval` を `pub` にして、`engine/src/bin/eval_cli.rs`(T022で追加済みの
// 開発補助バイナリ)から `eval::feature_diffs` を呼び出し、Edaxとの評価値較正に
// 使う生の特徴量差分(モビリティ/隅/安定石)を取得できるようにする。
// WASM公開APIへの影響はない(`#[wasm_bindgen]` は個々の項目に付与されるものであり、
// モジュールの可視性変更自体はJS側から見えるエクスポートを増やさない)。
pub mod eval;
// T031: 特徴量層・評価内訳分解層(`Engine::explain`から呼ばれる)。
// `protocol`と同様、モジュール自体は非公開でよい(`Engine`のメソッド越しに
// WASM APIとして公開する)。
mod explain;
// T043: パターン特徴量の定義(`train`クレートと共有、複製を避けるため`engine`
// 側に一本化)と、WTHOR学習済み重み(`train/weights/pattern_v1.bin`)の
// 読み込み専用構造体・スコアリング関数。`train`クレートおよび
// `bench/edax-compare`用のCLIバイナリから利用するため`pub`にしている。
pub mod pattern_eval;
pub mod patterns;
mod protocol;
// T043: `bench/edax-compare`用のCLIバイナリ(`eval_cli`)からパターン評価を
// 使った探索を直接呼び出せるよう`pub`にする(T024で`eval`をpubにしたのと
// 同じ理由。WASM公開APIには影響しない、`#[wasm_bindgen]`は個々の項目に
// 付与されるものでありモジュールの可視性変更自体はJS側のエクスポートを
// 増やさない)。
pub mod search;
pub mod tt;
mod zobrist;

use tt::TranspositionTable;

/// wasm-bindgen 疎通確認用のシンプルな関数。
/// フロントエンド(/app)から呼び出せることを確認するための最小実装。
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".into()
}

/// WASM向けに公開するエンジン本体(設計書 §2.4 Worker プロトコル)。
///
/// 内部に置換表(TT)を保持し、`analyze` の呼び出しをまたいで使い回す。
/// これによりWorkerが同じ `Engine` インスタンスを使い続ける限り、
/// 探索が高速化される設計になっている。
#[wasm_bindgen]
pub struct Engine {
    tt: TranspositionTable,
}

#[wasm_bindgen]
impl Engine {
    /// 新しい `Engine` を生成する。置換表は設計書の既定値である64MBで確保する。
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            tt: TranspositionTable::new(64),
        }
    }

    /// JSON形式のリクエスト(設計書 §2.4)を解析して探索を実行し、
    /// JSON形式のレスポンス文字列を返す。
    ///
    /// 本メソッドはpanicしない。入力が不正な場合(JSON構文エラー、
    /// 16進数パース失敗、未対応の`cmd`など)は `error` フィールドを含む
    /// JSON文字列を返す(詳細は `protocol::handle_analyze` を参照)。
    pub fn analyze(&mut self, request_json: &str) -> String {
        protocol::handle_analyze(request_json, &mut self.tt)
    }

    /// T031: 特徴量層(`cmd: "featureSet"`)・評価内訳分解層の生データ
    /// (`cmd: "evalTerms"`)を計算し、JSON文字列で返す。
    ///
    /// `analyze`とは異なり探索(置換表)を使わないため `&self` で十分。
    /// 本メソッドもpanicしない(詳細は `explain::handle_explain` を参照)。
    pub fn explain(&self, request_json: &str) -> String {
        explain::handle_explain(request_json)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}

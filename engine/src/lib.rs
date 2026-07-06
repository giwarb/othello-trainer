use wasm_bindgen::prelude::*;

// `bitboard` / `endgame` / `tt` は `pub` にして、`engine/tests/` 配下の
// 統合テスト(T009: FFO endgame test ベンチマーク)から
// `Board`/`Side`/`solve_exact`/`TranspositionTable` を直接利用できるようにする。
// (統合テストは別クレート扱いになるため `pub(crate)` では参照できない。
// `#[wasm_bindgen]` は個々の関数/implに付与されるものなのでこの可視性変更
// 自体はWASM側の公開APIには影響しない)
pub mod bitboard;
pub mod endgame;
mod eval;
mod protocol;
mod search;
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

use wasm_bindgen::prelude::*;

pub(crate) mod bitboard;

/// wasm-bindgen 疎通確認用のシンプルな関数。
/// フロントエンド(/app)から呼び出せることを確認するための最小実装。
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}

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
// T156c: MPCの空き帯×(D,d)校正表とQ16境界関数。探索本体と比較用
// バイナリから参照するため`pub`だが、WASM公開APIには影響しない。
pub mod mpc;
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

use pattern_eval::PatternWeights;
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
///
/// T045: `weights` にT044で学習済みのWTHORパターン評価v2
/// (`train/weights/pattern_v2.bin`)を[`Engine::load_pattern_weights`]で
/// 読み込ませると、以降の`analyze`呼び出しはこのパターン評価を中盤探索の
/// 静的評価に使う(`search::search_with_eval`経由)。`load_pattern_weights`が
/// 一度も呼ばれていない場合、または呼び出しが失敗した場合は`None`のままで、
/// 従来の3項ヒューリスティック評価(`eval::evaluate_for`)にグレースフル
/// フォールバックする(`josekiDb: null`と同じ考え方。詳細は
/// `tasks/T045-pattern-eval-wasm-wiring.md`参照)。終盤完全読み
/// (`endgame::solve_exact`系)は静的評価を一切使わないため、`weights`の
/// 有無によらず常に同じ結果を返す。
#[wasm_bindgen]
pub struct Engine {
    tt: TranspositionTable,
    weights: Option<PatternWeights>,
}

#[wasm_bindgen]
impl Engine {
    /// 新しい `Engine` を生成する。置換表は設計書の既定値である64MBで確保する。
    /// パターン評価の重みは未読み込み(`None`)の状態で始まり、従来の3項評価で
    /// 動作する。
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            tt: TranspositionTable::new(64),
            weights: None,
        }
    }

    /// T045: WTHOR学習済みパターン評価v2の重みファイル(`pattern_v2.bin`、
    /// `PatternWeights::to_bytes`が書き出した形式)のバイト列を読み込む。
    ///
    /// 成功すれば、以後の`analyze`呼び出しはこの重みを使ってパターン評価で
    /// 中盤探索するようになる。パース失敗時(不正なバイト列)は`Err`を返し、
    /// **既存の`self.weights`は変更しない**(呼び出し元がこのエラーを無視
    /// しても、それ以前の状態のまま動作し続けられる。呼び出し元(JS側)は
    /// 通常、fetch失敗・パース失敗時は`console.error`のみで続行し、従来の
    /// 3項評価にフォールバックする設計を想定している)。
    pub fn load_pattern_weights(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        let weights = PatternWeights::from_bytes(bytes).map_err(|e| JsValue::from_str(&e))?;
        self.weights = Some(weights);
        Ok(())
    }

    /// JSON形式のリクエスト(設計書 §2.4)を解析して探索を実行し、
    /// JSON形式のレスポンス文字列を返す。
    ///
    /// 本メソッドはpanicしない。入力が不正な場合(JSON構文エラー、
    /// 16進数パース失敗、未対応の`cmd`など)は `error` フィールドを含む
    /// JSON文字列を返す(詳細は `protocol::handle_analyze` を参照)。
    pub fn analyze(&mut self, request_json: &str) -> String {
        protocol::handle_analyze(request_json, &mut self.tt, self.weights.as_ref())
    }

    /// T031: 特徴量層(`cmd: "featureSet"`)・評価内訳分解層の生データ
    /// (`cmd: "evalTerms"`)を計算し、JSON文字列で返す。
    ///
    /// `analyze`とは異なり探索(置換表)を使わないため `&self` で十分。
    /// 本メソッドもpanicしない(詳細は `explain::handle_explain` を参照)。
    pub fn explain(&self, request_json: &str) -> String {
        explain::handle_explain(request_json)
    }

    /// T158a measurement-only entry point for scalar-feature evaluation cost.
    /// The loaded model is evaluated on fixed fixtures and the result is consumed through
    /// `black_box`, so zero scalar coefficients cannot remove the feature computation.
    pub fn benchmark_pattern_eval(&self, iterations: u32) -> Result<String, JsValue> {
        let weights = self
            .weights
            .as_ref()
            .ok_or_else(|| JsValue::from_str("pattern weights are not loaded"))?;
        let fixtures = [
            (
                bitboard::Board {
                    black: 0x0000_081c_3420_0000,
                    white: 0x0000_1020_081c_0000,
                },
                bitboard::Side::Black,
            ),
            (
                bitboard::Board {
                    black: 0x1030_1000_0408_0000,
                    white: 0x0000_241c_1810_0000,
                },
                bitboard::Side::White,
            ),
            (bitboard::Board::initial(), bitboard::Side::Black),
        ];
        let start = web_time::Instant::now();
        let mut checksum = 0f32;
        for _ in 0..iterations {
            for (board, side) in &fixtures {
                checksum += std::hint::black_box(
                    weights.score(std::hint::black_box(board), std::hint::black_box(*side)),
                );
            }
        }
        let elapsed_ns = start.elapsed().as_nanos();
        Ok(serde_json::json!({
            "evaluations": u64::from(iterations) * fixtures.len() as u64,
            "elapsedNs": elapsed_ns.to_string(),
            "checksumBits": checksum.to_bits(),
            "scalarFeaturesPresent": weights.has_scalar_features(),
            "scalarFeaturesEnabled": weights.scalar_features_enabled(),
        })
        .to_string())
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

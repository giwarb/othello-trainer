//! 静的評価関数(軽量ヒューリスティック版, v1)。
//!
//! # スケール規約 (centi-disc)
//!
//! 評価値は「石差(disc difference)換算」を `i32` の固定小数点で表現する。
//! **1石 = 100** を単位(centi-disc)とする。例えば黒が2.4石分有利であれば
//! `240` を返す。この規約は T005 (探索) / T006 (終盤ソルバー) / T007 (WASM API)
//! を含むエンジン全体で共通の約束事とする。
//!
//! ## T024: 重みのEdax較正(2026-07-08)
//!
//! T022(`bench/edax-compare/`)で、当初の重み(`MOBILITY_WEIGHT=10`,
//! `CORNER_WEIGHT=2500`, `STABLE_WEIGHT=1500`)は「探索の方向づけのための
//! 目安の重み」として意図的に大きく設定されており、結果として`evaluate`の
//! 出力(centi-disc換算)がEdaxの評価値(=最終石差の推定値、理論上±64を
//! 超えない)より一桁以上大きくなる局面が多いことが判明した。本タスクでは、
//! `bench/edax-compare/calibrate.py` で集めた80局面(T022のopening/midgame
//! 28局面 + 追加生成52局面)について、各局面の生の特徴量差分
//! ([`feature_diffs`]、黒視点)とEdax(`-l 12`)の評価値(黒視点に変換)との
//! 最小二乗回帰(切片なし、`numpy.linalg.lstsq`)を行い、
//! `mobility=2.5271`, `corner=10.8826`, `stable=0.9275`(いずれも真の石差
//! 単位、R^2≈0.49)という係数を得た。これを100倍してcenti-disc単位に
//! 丸めたものが現在の `MOBILITY_WEIGHT`/`CORNER_WEIGHT`/`STABLE_WEIGHT` の値
//! である。corner_diffとstable_diffは相関が高く(相関係数0.78、隅を持つと
//! 隣接辺も安定しやすいため)多重共線性の影響を受けており、`stable`の回帰係数が
//! `mobility`より小さくなる(較正前の設計意図とは重要度の順序が逆転する)結果と
//! なったが、これは「隅を持つことの効果の一部がすでに`corner_diff`側に
//! 説明されている」ことの反映であり、単独の特徴量として見た`stable`の限界的な
//! 価値が小さいこと自体は不合理ではないと判断した。この重み比率の変更が
//! 探索の手選択の質を劣化させていないことは、`cargo test`・FFOベンチマーク・
//! 較正前後の自己対戦(`bench/edax-compare/selfplay.py`)・悪手検出チェックの
//! 再実行で確認済み(詳細は`tasks/T024-eval-scale-calibration.md`の作業ログ、
//! および`bench/edax-compare/report.md`を参照)。
//!
//! # 視点の規約
//!
//! [`evaluate`] は **常に黒視点**の値を返す(黒が有利なら正、白が有利なら負)。
//! 手番視点(手番側から見て正)が必要な場合は [`evaluate_for`] を使う。
//! これにより探索側 (T005) は手番に応じた符号反転を `evaluate_for` に閉じ込め、
//! 評価関数自体は常に同じ絶対視点を返せばよいというシンプルな契約にできる。
//!
//! # 差し替え可能性
//!
//! フェーズ3ではWTHORデータで学習したパターン評価 (`PatternEval` 相当) に
//! 差し替える予定のため、具体的な実装 ([`HeuristicEval`]) とは別に
//! [`StaticEval`] トレイトを用意している。T005はこのトレイト(または
//! `evaluate`/`evaluate_for` 関数)越しに評価関数を呼び出すことで、将来の
//! 差し替えの影響を局所化できる。
//!
//! 現時点では `eval` モジュール自体がどこからも(テスト以外で)呼ばれていない
//! ため、未使用コードの警告 (dead_code) を明示的に抑制する。T005で探索から
//! 呼ばれるようになった時点でこの `allow` は不要になる想定。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};

/// 着手可能数(モビリティ)の差1手あたりの重み(centi-disc単位)。
///
/// T024でEdaxの評価値への最小二乗回帰により較正した値(このファイル冒頭の
/// 「T024: 重みのEdax較正」を参照)。回帰係数 2.5271 石/手 を100倍して丸めた。
const MOBILITY_WEIGHT: i32 = 253;

/// 隅(コーナー)1個あたりの重み(centi-disc単位)。
///
/// T024でEdaxの評価値への最小二乗回帰により較正した値(このファイル冒頭の
/// 「T024: 重みのEdax較正」を参照)。回帰係数 10.8826 石/個 を100倍して丸めた。
const CORNER_WEIGHT: i32 = 1088;

/// 安定石(隅から辺沿いに連続する、今後ひっくり返されない石)1個あたりの重み
/// (centi-disc単位)。
///
/// T024でEdaxの評価値への最小二乗回帰により較正した値(このファイル冒頭の
/// 「T024: 重みのEdax較正」を参照)。回帰係数 0.9275 石/個 を100倍して丸めた。
const STABLE_WEIGHT: i32 = 93;

/// [`evaluate`] が使う生の(重み付けする前の)特徴量差分。
///
/// T024(Edaxとの評価値較正)で、`engine/src/bin/eval_cli.rs` から各局面の
/// 特徴量を取り出し、Edaxの評価値との線形回帰に使うために公開している。
/// フィールドの意味は [`evaluate`] 本体のコメントを参照。
pub struct EvalFeatures {
    pub mobility_diff: i32,
    pub corner_diff: i32,
    pub stable_diff: i32,
}

/// 重み付けする前の生の特徴量差分(黒視点: 黒が多い/有利なら正)を計算する。
pub fn feature_diffs(board: &Board) -> EvalFeatures {
    let mobility_diff = board.legal_moves(Side::Black).count_ones() as i32
        - board.legal_moves(Side::White).count_ones() as i32;

    let corner_diff = corner_count(board, Side::Black) as i32 - corner_count(board, Side::White) as i32;

    let stable_diff =
        stable_mask(board, Side::Black).count_ones() as i32 - stable_mask(board, Side::White).count_ones() as i32;

    EvalFeatures {
        mobility_diff,
        corner_diff,
        stable_diff,
    }
}

/// 盤面を常に黒視点(黒が有利なら正)で評価する。
///
/// モビリティ差・隅の保有差・安定石差を線形結合した軽量ヒューリスティックで、
/// 石数差そのものは加味しない(オセロは終盤以外では石数を増やすほど不利に
/// なりやすいため)。
pub fn evaluate(board: &Board) -> i32 {
    let EvalFeatures {
        mobility_diff,
        corner_diff,
        stable_diff,
    } = feature_diffs(board);

    mobility_diff * MOBILITY_WEIGHT + corner_diff * CORNER_WEIGHT + stable_diff * STABLE_WEIGHT
}

/// `evaluate` を `side` の手番視点に変換する(白番なら符号反転)。
pub fn evaluate_for(board: &Board, side: Side) -> i32 {
    match side {
        Side::Black => evaluate(board),
        Side::White => -evaluate(board),
    }
}

/// 4隅(a1, a8, h1, h8)のうち `side` が保持している数を返す。
fn corner_count(board: &Board, side: Side) -> u32 {
    let own = own_bits(board, side);
    (own & CORNERS).count_ones()
}

/// 盤面の4隅に対応するビットマスク(a1, h1, a8, h8)。
const CORNERS: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

// 4辺それぞれに沿ったマス目のビット位置(端から端への順)。
// 添字が小さい側の要素が「前端」、大きい側の要素が「後端」に対応する。
const TOP_EDGE: [u32; 8] = [0, 1, 2, 3, 4, 5, 6, 7]; // a1..h1
const BOTTOM_EDGE: [u32; 8] = [56, 57, 58, 59, 60, 61, 62, 63]; // a8..h8
const LEFT_EDGE: [u32; 8] = [0, 8, 16, 24, 32, 40, 48, 56]; // a1..a8
const RIGHT_EDGE: [u32; 8] = [7, 15, 23, 31, 39, 47, 55, 63]; // h1..h8

/// 指定した手番の安定石(簡易判定)をビットマスクで返す。
///
/// 厳密な安定石判定(隣接3方向すべてが埋まっているか等の再帰的判定)は行わず、
/// 「隅を起点として辺方向へ連続する同色石」のみを安定石とみなす簡易ロジック。
/// 4辺それぞれについて、両端(隅)から同色が連続する区間を求め、それらの
/// 論理和を取ることで、4隅それぞれから伸びる2方向の辺安定石をまとめて表現する。
fn stable_mask(board: &Board, side: Side) -> u64 {
    let own = own_bits(board, side);

    edge_stable_mask(own, &TOP_EDGE)
        | edge_stable_mask(own, &BOTTOM_EDGE)
        | edge_stable_mask(own, &LEFT_EDGE)
        | edge_stable_mask(own, &RIGHT_EDGE)
}

/// 1つの辺(端から端までの8マス)について、両端から連続する同色石のビットマスクを返す。
fn edge_stable_mask(own: u64, edge: &[u32; 8]) -> u64 {
    let mut mask = 0u64;

    // 前端(edge[0]側)から連続する同色石。
    for &idx in edge.iter() {
        if own & (1u64 << idx) != 0 {
            mask |= 1u64 << idx;
        } else {
            break;
        }
    }

    // 後端(edge[7]側)から連続する同色石。
    for &idx in edge.iter().rev() {
        if own & (1u64 << idx) != 0 {
            mask |= 1u64 << idx;
        } else {
            break;
        }
    }

    mask
}

/// 指定した手番の石のビットボードを返す。
fn own_bits(board: &Board, side: Side) -> u64 {
    match side {
        Side::Black => board.black,
        Side::White => board.white,
    }
}

/// 静的評価関数を表すトレイト。
///
/// フェーズ3でパターン評価 (`PatternEval` 等) に差し替える際に、探索側 (T005) が
/// この抽象化越しに評価関数を呼び出していれば実装の差し替えのみで済むようにする
/// ための最小限の抽象化。過剰な設計(複数トレイトメソッドや状態保持など)は
/// あえて行っていない。
pub trait StaticEval {
    /// 盤面を常に黒視点(黒が有利なら正)で評価する。
    fn eval(&self, board: &Board) -> i32;
}

/// 本タスク(T004)で実装する手作りの軽量ヒューリスティック評価。
pub struct HeuristicEval;

impl StaticEval for HeuristicEval {
    fn eval(&self, board: &Board) -> i32 {
        evaluate(board)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_board_evaluates_to_zero() {
        let board = Board::initial();
        assert_eq!(evaluate(&board), 0);
    }

    #[test]
    fn black_holding_all_corners_is_strongly_positive() {
        // 人工的な局面: 黒が4隅すべてを持ち、白はどこも持たない。
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board {
            black: corners,
            white: 0,
        };

        let score = evaluate(&board);
        assert!(
            score > 0,
            "black holding all 4 corners should be clearly positive, got {}",
            score
        );
        // 隅4つ分の重みだけでも十分大きな値になっているはず。
        assert!(score >= CORNER_WEIGHT * 4);
    }

    #[test]
    fn evaluate_for_flips_sign_between_black_and_white() {
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board {
            black: corners,
            white: 0,
        };

        assert_eq!(
            evaluate_for(&board, Side::Black),
            -evaluate_for(&board, Side::White)
        );

        // 互角局面でも符号反転の関係自体は成り立つことを確認する。
        let initial = Board::initial();
        assert_eq!(
            evaluate_for(&initial, Side::Black),
            -evaluate_for(&initial, Side::White)
        );
    }

    #[test]
    fn heuristic_eval_trait_matches_evaluate_function() {
        let board = Board::initial();
        let heuristic = HeuristicEval;
        assert_eq!(heuristic.eval(&board), evaluate(&board));
    }
}

//! 静的評価関数(軽量ヒューリスティック版, v1)。
//!
//! # スケール規約 (centi-disc)
//!
//! 評価値は「石差(disc difference)換算」を `i32` の固定小数点で表現する。
//! **1石 = 100** を単位(centi-disc)とする。例えば黒が2.4石分有利であれば
//! `240` を返す。この規約は T005 (探索) / T006 (終盤ソルバー) / T007 (WASM API)
//! を含むエンジン全体で共通の約束事とする。
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
/// モビリティは終盤に近づくほど重要度が下がる一方、序盤・中盤では
/// 相手の選択肢を狭めることが優位に直結しやすいため、隅・安定石ほどではないが
/// 無視できない重みとして 10 (= 0.1石相当/手) 前後を採用する。
const MOBILITY_WEIGHT: i32 = 10;

/// 隅(コーナー)1個あたりの重み(centi-disc単位)。
///
/// 隅は一度確保すると絶対にひっくり返されず、かつ隣接する辺の安定化の起点にも
/// なるため、他のどの要素よりも大きな重みを与える。1個=25石相当という
/// 目安値を採用する。
const CORNER_WEIGHT: i32 = 2500;

/// 安定石(隅から辺沿いに連続する、今後ひっくり返されない石)1個あたりの重み
/// (centi-disc単位)。
///
/// 隅そのものほどではないが、着手可能数の差より重要度が高いという想定で
/// 15石相当とする。
const STABLE_WEIGHT: i32 = 1500;

/// 盤面を常に黒視点(黒が有利なら正)で評価する。
///
/// モビリティ差・隅の保有差・安定石差を線形結合した軽量ヒューリスティックで、
/// 石数差そのものは加味しない(オセロは終盤以外では石数を増やすほど不利に
/// なりやすいため)。
pub fn evaluate(board: &Board) -> i32 {
    let mobility_diff = board.legal_moves(Side::Black).count_ones() as i32
        - board.legal_moves(Side::White).count_ones() as i32;

    let corner_diff = corner_count(board, Side::Black) as i32 - corner_count(board, Side::White) as i32;

    let stable_diff =
        stable_mask(board, Side::Black).count_ones() as i32 - stable_mask(board, Side::White).count_ones() as i32;

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

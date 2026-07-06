//! 終盤完全読みソルバー: 空きマスが少ない局面で、評価関数を一切使わず
//! 終局までの全ての着手系列を読み切り、両者が最善を尽くした場合の
//! 「真の最終石差」を計算する。
//!
//! # スケールについて (重要)
//!
//! [`solve_exact`] が返す値は `eval.rs` (T004) の centi-disc スケール
//! (1石 = 100) **ではなく**、単純な整数の石差 (1石 = 1) である
//! (例: 黒が3石多く勝てば `3`、負ければ `-3`)。
//! 中盤探索 (T005) からこの値を呼び出し、centi-disc スケールの評価値と
//! 混ぜて扱う場合は、呼び出し側で **`solve_exact(...) * 100`** のように
//! 100倍してから使うこと (これが `eval.rs` のスケールに合わせる変換ルール)。
//!
//! # 手番視点
//!
//! 返り値は `side_to_move` から見た最終石差。正なら `side_to_move` の勝ち、
//! 負なら負け、0なら引き分け。
//!
//! # パス・終局の扱い
//!
//! - 手番側に合法手がなければパスして相手番に手番が移る。
//! - 両者ともに合法手がなければ終局とみなす。終局時、盤面に空きマスが
//!   残っていても、標準的なオセロの完全読みソルバーの慣習に従い
//!   「その時点で石数が多い方が残り空きマスを総取りする」ものとして
//!   最終石差を計算する (設計書に明記はないが一般的な慣習)。
//! - 空きマスが0(盤面が完全に埋まっている)の場合は、この総取りルールの
//!   影響がないため、単純に `black_count - white_count` を手番視点に
//!   変換した値がそのまま最終石差になる。
//!
//! # 探索アルゴリズム
//!
//! negamax + fail-soft alpha-beta。[`crate::tt::TranspositionTable`] を使い、
//! 局面 (盤面+手番) の [`crate::zobrist::zobrist_hash`] をキーにして
//! 探索結果をキャッシュする(NWSではなく通常のalpha-beta窓で実装しているが、
//! TTによる枝刈り自体はNWS的な再探索にも十分効く)。
//! 着手順序は「隅優先 → 着手後の相手の合法手数が少ない順」という単純な
//! ヒューリスティックで並べ替える(空きマス数によらず全体に適用する)。
//! 安定石による静的カットや、空き4/3/2/1のハードコード専用関数は
//! 本実装では行わない(T006のスコープ外、あれば高速化に寄与するのみ)。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};
use crate::tt::{Bound, TTEntry, TranspositionTable};
use crate::zobrist::zobrist_hash;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
/// ビットとマスの対応は `bitboard.rs` 冒頭のドキュメントを参照
/// (index = rank0*8 + file なので a1=0, h1=7, a8=56, h8=63)。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

/// 終局時の最終石差 (`side` から見た値) を計算する。
///
/// `board` が真に終局(両者合法手なし、または空きマス0)であることを
/// 前提とする。空きマスが残っている場合は「石数が多い方が総取り」する
/// 慣習を適用する。
///
/// `search.rs` の `terminal_score_centi` から再利用されるため `pub(crate)`
/// にしている(終局ロジックの重複実装を避けるため。T007)。
pub(crate) fn final_score(board: &Board, side: Side) -> i32 {
    let black = board.black.count_ones() as i32;
    let white = board.white.count_ones() as i32;
    let empties = 64 - black - white;

    let (black, white) = match black.cmp(&white) {
        std::cmp::Ordering::Greater => (black + empties, white),
        std::cmp::Ordering::Less => (black, white + empties),
        std::cmp::Ordering::Equal => (black, white),
    };

    let diff = black - white;
    match side {
        Side::Black => diff,
        Side::White => -diff,
    }
}

/// 空きマスが少ない局面を完全読みし、`side_to_move` から見た最終石差を返す。
///
/// 返り値は centi-disc スケールではなく素の石差 (1石=1) であることに注意
/// (モジュール冒頭のドキュメント参照)。
pub fn solve_exact(board: &Board, side_to_move: Side, tt: &mut TranspositionTable) -> i32 {
    negamax(board, side_to_move, -64, 64, tt)
}

/// negamax + fail-soft alpha-beta + TT による完全読み本体。
///
/// `alpha` / `beta` は `side` から見た石差の窓。
fn negamax(
    board: &Board,
    side: Side,
    alpha: i32,
    beta: i32,
    tt: &mut TranspositionTable,
) -> i32 {
    let empties = board.empty_count();
    if empties == 0 {
        return final_score(board, side);
    }

    let hash = zobrist_hash(board, side);
    let mut alpha = alpha;
    let mut beta = beta;

    if let Some(entry) = tt.probe(hash) {
        // depth には格納時点の空きマス数を入れている。本ソルバーは常に
        // 終局まで完全に読み切るので、格納時の空きマス数が今回以上であれば
        // (=同じ局面なら通常は等しい) そのまま信頼できる。
        if entry.depth as u32 >= empties {
            match entry.bound {
                Bound::Exact => return entry.score,
                Bound::Lower => alpha = alpha.max(entry.score),
                Bound::Upper => beta = beta.min(entry.score),
            }
            if alpha >= beta {
                return entry.score;
            }
        }
    }

    let alpha_orig = alpha;
    let legal = board.legal_moves(side);

    if legal == 0 {
        // 自分に合法手がない: パス。
        if board.legal_moves(side.opposite()) == 0 {
            // 相手にも合法手がない: 終局。
            return final_score(board, side);
        }
        return -negamax(board, side.opposite(), -beta, -alpha, tt);
    }

    // 合法手を列挙し、隅優先 → 相手の着手後合法手数が少ない順に並べ替える。
    let mut moves: Vec<u64> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb);
        remaining &= remaining - 1;
    }

    moves.sort_by_key(|&mv| {
        let is_corner = mv & CORNER_MASK != 0;
        let next_board = board.apply_move(side, mv);
        let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
        (if is_corner { 0u32 } else { 1u32 }, opp_mobility)
    });

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;

    for mv in moves {
        let next_board = board.apply_move(side, mv);
        let score = -negamax(&next_board, side.opposite(), -beta, -alpha, tt);

        if score > best_score {
            best_score = score;
            best_move = Some(mv.trailing_zeros() as u8);
        }
        if best_score > alpha {
            alpha = best_score;
        }
        if alpha >= beta {
            break;
        }
    }

    let bound = if best_score <= alpha_orig {
        Bound::Upper
    } else if best_score >= beta {
        Bound::Lower
    } else {
        Bound::Exact
    };

    tt.store(TTEntry {
        hash,
        depth: empties as i8,
        score: best_score,
        bound,
        best_move,
    });

    best_score
}

#[cfg(test)]
mod tests {
    use super::*;

    // =====================================================================
    // 独立した参照実装 (naive reference implementation)
    //
    // solve_exact (alpha-beta + TT) とは別に、枝刈りもTTも一切使わない
    // 素朴なフルウィンドウnegamaxを用意し、両者の結果が一致することを検証する。
    // (Board::legal_moves / apply_move 自体は bitboard.rs で既に検証済みの
    // ものをそのまま利用してよい。ここで独立性を担保したいのは
    // 「探索アルゴリズム(alpha-beta+TTによる枝刈り)が正しいか」である)
    // =====================================================================

    fn naive_final_score(board: &Board, side: Side) -> i32 {
        let black = board.black.count_ones() as i32;
        let white = board.white.count_ones() as i32;
        let empties = 64 - black - white;

        let (black, white) = if black > white {
            (black + empties, white)
        } else if white > black {
            (black, white + empties)
        } else {
            (black, white)
        };

        let diff = black - white;
        match side {
            Side::Black => diff,
            Side::White => -diff,
        }
    }

    fn naive_solve(board: &Board, side: Side) -> i32 {
        if board.empty_count() == 0 {
            return naive_final_score(board, side);
        }

        let legal = board.legal_moves(side);
        if legal == 0 {
            if board.legal_moves(side.opposite()) == 0 {
                return naive_final_score(board, side);
            }
            return -naive_solve(board, side.opposite());
        }

        let mut best = i32::MIN;
        let mut remaining = legal;
        while remaining != 0 {
            let lsb = remaining & remaining.wrapping_neg();
            remaining &= remaining - 1;
            let next_board = board.apply_move(side, lsb);
            let score = -naive_solve(&next_board, side.opposite());
            if score > best {
                best = score;
            }
        }
        best
    }

    // --- テスト用ユーティリティ: 初期局面から決定的に手を進めて空きマスを減らす ---

    /// 初期局面から決定的な戦略で手を進め、空きマスの数が `target_empties` 以下に
    /// なった時点の (Board, 手番) を返す。終局してしまった場合はその時点で返す。
    fn play_until_empties(
        target_empties: u32,
        choose: impl Fn(&[u64]) -> u64,
    ) -> (Board, Side) {
        let mut board = Board::initial();
        let mut side = Side::Black;

        loop {
            if board.empty_count() <= target_empties || board.is_terminal() {
                return (board, side);
            }

            let legal = board.legal_moves(side);
            if legal == 0 {
                side = side.opposite();
                continue;
            }

            let mut moves: Vec<u64> = Vec::new();
            let mut remaining = legal;
            while remaining != 0 {
                let lsb = remaining & remaining.wrapping_neg();
                moves.push(lsb);
                remaining &= remaining - 1;
            }

            let mv = choose(&moves);
            board = board.apply_move(side, mv);
            side = side.opposite();
        }
    }

    fn first_move_strategy(moves: &[u64]) -> u64 {
        moves[0]
    }

    fn last_move_strategy(moves: &[u64]) -> u64 {
        moves[moves.len() - 1]
    }

    fn middle_move_strategy(moves: &[u64]) -> u64 {
        moves[moves.len() / 2]
    }

    #[test]
    fn solve_exact_matches_naive_reference_on_small_positions() {
        let strategies: Vec<(&str, fn(&[u64]) -> u64)> = vec![
            ("first", first_move_strategy),
            ("last", last_move_strategy),
            ("middle", middle_move_strategy),
        ];

        for target_empties in [1u32, 2, 3, 4, 5, 6] {
            for (name, strategy) in strategies.iter() {
                let (board, side) = play_until_empties(target_empties, strategy);

                let naive = naive_solve(&board, side);

                let mut tt = TranspositionTable::new(1);
                let solved = solve_exact(&board, side, &mut tt);

                assert_eq!(
                    solved, naive,
                    "[{}] mismatch at target_empties={} (actual empties={}): solve_exact={}, naive={}",
                    name,
                    target_empties,
                    board.empty_count(),
                    solved,
                    naive
                );
            }
        }
    }

    /// `solve_exact(board, Black) == -solve_exact(board, White)` という等式は、
    /// **同じ盤面で両者ともに合法手を持つ場合には一般には成立しない**
    /// (手番が変わればどちらが着手を選ぶかという全く別のゲーム木になるため)。
    /// これは実装のバグではなく、独立実装の `naive_solve` でも同じ非対称な
    /// 結果が再現されることを確認済み(例: ある局面で
    /// `naive_solve(board, Black) = 22`, `naive_solve(board, White) = -16` となり
    /// 合計が0にならない)。
    ///
    /// 一方、**片方の手番に合法手が無い(パス、または終局)局面**に限れば、
    /// この等式は `negamax`/`final_score` の定義から常に成立する
    /// (パス側の値は、実装上そのまま「もう一方の手番での探索結果の符号反転」
    /// として計算されるため)。本テストではこの、常に真である範囲に限定して
    /// 等式を検証する。
    #[test]
    fn solve_exact_result_is_zero_sum_when_at_least_one_side_must_pass() {
        let strategies: Vec<fn(&[u64]) -> u64> =
            vec![first_move_strategy, last_move_strategy, middle_move_strategy];

        let mut checked_cases = 0;

        for target_empties in [1u32, 2, 3, 4, 5, 6, 7, 8] {
            for strategy in strategies.iter() {
                let (board, _side) = play_until_empties(target_empties, strategy);

                let black_can_move = board.has_legal_move(Side::Black);
                let white_can_move = board.has_legal_move(Side::White);

                // 両者とも合法手を持つ局面では、上記の理由によりこの等式を
                // 一般には要求できないためスキップする。
                if black_can_move && white_can_move {
                    continue;
                }

                let mut tt_black = TranspositionTable::new(1);
                let score_black = solve_exact(&board, Side::Black, &mut tt_black);

                let mut tt_white = TranspositionTable::new(1);
                let score_white = solve_exact(&board, Side::White, &mut tt_white);

                assert_eq!(
                    score_black, -score_white,
                    "score for Black ({}) should be the negation of score for White ({}) \
                     when at least one side has no legal move",
                    score_black, score_white
                );
                checked_cases += 1;
            }
        }

        assert!(
            checked_cases > 0,
            "expected at least one naturally-occurring pass/terminal position to verify \
             the zero-sum identity against, but none were found among the sampled positions"
        );
    }

    #[test]
    fn solve_exact_on_fully_filled_board_returns_raw_disc_difference() {
        // 空きマス0の盤面を人工的に構築する (黒40, 白24 相当の適当な配置)。
        // 正確な配置内容よりも「空き0のときは総取りルールを介さず
        // 単純な石差がそのまま返る」ことの確認が目的。
        let black = 0xFFFF_FFFF_FF00_0000u64; // 上位40ビット相当
        let white = !black; // 残り24マスすべて白
        let board = Board { black, white };
        assert_eq!(board.empty_count(), 0);

        let mut tt = TranspositionTable::new(1);
        let score_black = solve_exact(&board, Side::Black, &mut tt);
        let expected = black.count_ones() as i32 - white.count_ones() as i32;
        assert_eq!(score_black, expected);

        let mut tt2 = TranspositionTable::new(1);
        let score_white = solve_exact(&board, Side::White, &mut tt2);
        assert_eq!(score_white, -expected);
    }

    #[test]
    fn solve_exact_applies_majority_takes_remaining_empties_rule_on_early_termination() {
        // 両者パスで終局し、かつ空きマスが残っているケースを人工的に構築する。
        // 黒がe7,f7,g7,h7とその上の行以外を全て占め、白は最小限のみ、
        // どちらの色からも隣接する空きマスへの合法手が成立しないよう
        // 空きマスを盤の隅(相手に囲まれない位置)に配置する。
        //
        // ここでは単純化のため、盤面のほぼ全体を黒で埋め、白は黒に隣接しない
        // 1マスの飛び地を作れないため、代わりに「空きマスが黒白どちらにも
        // 囲まれておらず両者とも合法手がない」状況を作る:
        // 全マスを黒で埋め、1マスだけ空けておくと、その空きマスに隣接する
        // マスは全て黒なので白の合法手はなく、黒はその空きマスに置いても
        // 挟める相手石がないため黒も合法手なし = 即終局。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.empty_count(), 1);
        assert!(!board.has_legal_move(Side::Black));
        assert!(!board.has_legal_move(Side::White));
        assert!(board.is_terminal());

        let mut tt = TranspositionTable::new(1);
        let score_black = solve_exact(&board, Side::Black, &mut tt);
        // 黒63石 + 空き1マスを総取り = 64、白0石 => 差は64。
        assert_eq!(score_black, 64);

        let mut tt2 = TranspositionTable::new(1);
        let score_white = solve_exact(&board, Side::White, &mut tt2);
        assert_eq!(score_white, -64);
    }

    #[test]
    fn solve_exact_completes_within_a_few_seconds_for_around_twelve_empties() {
        // 空きマス12前後まで進めた局面を完全読みし、タイムアウトしないことを確認する
        // (正式な速度計測は release ビルドでの実行に譲る。ここでは疎通確認のみ)。
        let (board, side) = play_until_empties(12, first_move_strategy);
        println!(
            "solving position with {} empties (side_to_move={:?})",
            board.empty_count(),
            side
        );

        let start = std::time::Instant::now();
        let mut tt = TranspositionTable::new(64);
        let score = solve_exact(&board, side, &mut tt);
        let elapsed = start.elapsed();

        println!(
            "solve_exact finished in {:?}, empties={}, score={}",
            elapsed,
            board.empty_count(),
            score
        );

        assert!(score.abs() <= 64);
    }
}

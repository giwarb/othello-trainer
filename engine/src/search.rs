//! 中盤探索エンジン: 反復深化 + PVS(NegaScout) + 置換表(T003) + 終盤完全読み(T006)。
//!
//! # 概要
//! [`search`] が本モジュールの唯一の公開エントリポイントである。
//! 空きマス数が [`SearchLimit::exact_from_empties`] 以下になった局面
//! (探索木の途中で到達した局面も含む)では、評価関数を一切使わず
//! T006 (`endgame::solve_exact`) による完全読みに切り替える。
//! それ以外の局面は T004 の `evaluate_for` をリーフ評価に使った
//! NegaScout (PVS) で反復深化探索する。
//!
//! # スケールの規約
//! `SearchResult::score` は centi-disc 単位(1石 = 100)・手番視点。
//! `endgame::solve_exact` は素の石差(1石=1)を返すため、本モジュールから
//! 呼び出す際は必ず `* 100` して centi-disc スケールに揃える
//! (`endgame.rs` モジュール冒頭のドキュメントに明記されている変換ルール)。
//!
//! # 置換表の共有について
//! 探索(本モジュール)と終盤ソルバー(T006)は同じ `TranspositionTable` を
//! 共有する。両者は `TTEntry::depth` の意味が異なる
//! (本モジュールでは「残り探索プライ数」、終盤ソルバーでは「残り空きマス数」)
//! が、ある局面がどちらの意味で `depth` を解釈されるかは、その局面自体の
//! 空きマス数だけで一意に決まる(空きマス数 <= `exact_from_empties` の局面は
//! 常に終盤ソルバー経由でのみ探索・格納され、それ以外の局面は常に本モジュールの
//! NegaScoutでのみ探索・格納される)ため、混同は起きない。
//!
//! ただしこれは「同じ `tt` に対しては常に同じ `exact_from_empties` で
//! `search()` を呼ぶ」ことが前提になる。もし将来、同一の `tt` を使い回した
//! まま異なる `exact_from_empties` で `search()` を呼び直すと、過去に
//! 書き込まれたエントリのスケール/depth解釈が食い違い、
//! `entry.depth as u32 >= depth as u32` の判定を通過して誤ったスコアを
//! 黙って返すおそれがある。これを防ぐため、[`search`] は冒頭で
//! `tt` に記録されている前回の `exact_from_empties`
//! (`TranspositionTable::last_exact_from_empties`)と今回の値を比較し、
//! 不一致であれば探索前に `tt.clear()` を行ってからその値を更新する
//! (T007)。この安全策はデバッグ限定ではなく、リリースビルドでも常に
//! 有効な通常ロジックとして実装している。
//!
//! # パスの扱い
//! 手番側に合法手がない場合はパスして相手番で同じ深さ予算のまま再帰する
//! (パスは深さを消費しない)。両者パス(終局)の場合は、終盤ソルバーと同じ
//! 「石数が多い方が残り空きマスを総取りする」慣習で最終石差を計算し、
//! centi-discスケールに変換して返す。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};
use crate::endgame::{final_score, solve_exact};
use crate::eval::evaluate_for;
use crate::tt::{Bound, TTEntry, TranspositionTable};
use crate::zobrist::zobrist_hash;
use std::time::Instant;

/// 探索を打ち切るための十分に大きな評価値。centi-discスケールでの理論上の
/// 最大絶対値(64石差 = 6400)より大きく、かつ `i32` の演算(符号反転・-1)で
/// オーバーフローしない程度に余裕を持たせた値を選ぶ。
const INF: i32 = 1_000_000;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

/// 探索の制御パラメータ。
///
/// Workerプロトコル(設計書 §2.4)の `limit` パラメータ
/// (`depth`, `timeMs`, `exactFromEmpties`)に対応する。
#[derive(Debug, Clone)]
pub struct SearchLimit {
    /// 反復深化で到達する最大深さ(プライ数)。
    pub max_depth: u8,
    /// 探索の時間制限(ミリ秒)。`None` なら時間制限なし。
    /// 簡易実装として、反復深化の各深さが完了するごとにチェックし、
    /// 超過していればそこで探索を打ち切る。
    pub time_ms: Option<u64>,
    /// この数値以下の空きマス数になったら終盤完全読み(T006)に切り替える。
    /// 設計書の既定値は24。
    pub exact_from_empties: u8,
}

/// 探索結果。
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// 最善手のマス番号(0..63)。合法手がない(パスすべき)局面の場合は `None`。
    pub best_move: Option<u8>,
    /// 評価値。centi-disc単位(1石=100)、手番視点(正なら手番側有利)。
    pub score: i32,
    /// 到達した探索深さ。終盤完全読みに切り替わった場合は空きマス数そのもの。
    pub depth: u8,
    /// 読み筋(マス番号列)。置換表から再構成した簡易的なものであり、
    /// 途中で置換表にエントリが無くなった時点で打ち切られる。
    pub pv: Vec<u8>,
    /// 探索したノード数。
    pub nodes: u64,
}

/// 現在の局面を探索し、最善手と評価値を返す。
///
/// - 空きマス数が `limit.exact_from_empties` 以下であれば、直ちに
///   `endgame::solve_exact` による完全読みの結果を返す。
/// - それ以外は depth=1 から `limit.max_depth` まで反復深化しながら
///   NegaScout(PVS)探索を行う。各反復は `tt` を使い回す。
pub fn search(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
) -> SearchResult {
    // TTスケール混同防止(T007): 同じ `tt` に対して過去に異なる
    // `exact_from_empties` で探索していた場合、その古いエントリは
    // 今回とはスケール/depthの意味が食い違っている可能性があるため、
    // 安全のためTTを丸ごとクリアしてから今回の値を記録し直す。
    // (初回呼び出し `None` や、前回と同じ値の場合はクリア不要)
    if let Some(prev) = tt.last_exact_from_empties() {
        if prev != limit.exact_from_empties {
            tt.clear();
        }
    }
    tt.set_last_exact_from_empties(limit.exact_from_empties);

    let empties = board.empty_count();

    if empties <= limit.exact_from_empties as u32 {
        let score = solve_exact(board, side_to_move, tt) * 100;
        let hash = zobrist_hash(board, side_to_move);
        let best_move = tt.probe(hash).and_then(|entry| entry.best_move);
        let pv = best_move.map(|mv| vec![mv]).unwrap_or_default();

        return SearchResult {
            best_move,
            score,
            depth: empties as u8,
            pv,
            nodes: 1,
        };
    }

    let start = Instant::now();
    let mut total_nodes: u64 = 0;
    let mut last_result: Option<SearchResult> = None;

    for depth in 1..=limit.max_depth {
        let mut nodes: u64 = 0;
        let score = {
            let mut ctx = SearchCtx {
                limit,
                tt: &mut *tt,
                nodes: &mut nodes,
            };
            negascout(board, side_to_move, depth, -INF, INF, &mut ctx)
        };
        total_nodes += nodes;

        let hash = zobrist_hash(board, side_to_move);
        let best_move = tt.probe(hash).and_then(|entry| entry.best_move);
        let pv = extract_pv(board, side_to_move, tt, depth as usize);

        last_result = Some(SearchResult {
            best_move,
            score,
            depth,
            pv,
            nodes: total_nodes,
        });

        if let Some(time_ms) = limit.time_ms {
            if start.elapsed().as_millis() as u64 >= time_ms {
                break;
            }
        }
    }

    last_result.unwrap_or_else(|| SearchResult {
        // max_depth == 0 のような呼び出しへのフォールバック。反復が一度も
        // 行われなかった場合、静的評価をそのまま返す。
        best_move: None,
        score: evaluate_for(board, side_to_move),
        depth: 0,
        pv: Vec::new(),
        nodes: 0,
    })
}

/// NegaScout探索1回分の実行に必要な文脈をまとめた構造体。
/// (引数を減らしてclippyの`too_many_arguments`を避けるための束ね役でもある)
struct SearchCtx<'a> {
    limit: &'a SearchLimit,
    tt: &'a mut TranspositionTable,
    nodes: &'a mut u64,
}

/// NegaScout(PVS) + 置換表による中盤探索本体。
///
/// `alpha` / `beta` は `side` から見たcenti-discスケールの評価値の窓。
/// 空きマス数が `ctx.limit.exact_from_empties` 以下になった時点で
/// 終盤完全読みに切り替える(この判定はルート呼び出しだけでなく、
/// 探索木の途中の任意の局面でも行う)。
fn negascout(
    board: &Board,
    side: Side,
    depth: u8,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
) -> i32 {
    *ctx.nodes += 1;

    let mut alpha = alpha;
    let mut beta = beta;

    let empties = board.empty_count();
    if empties <= ctx.limit.exact_from_empties as u32 {
        return solve_exact(board, side, ctx.tt) * 100;
    }

    let legal = board.legal_moves(side);
    if legal == 0 {
        if board.legal_moves(side.opposite()) == 0 {
            // 両者パス: 終局。
            return terminal_score_centi(board, side);
        }
        // 自分だけ合法手がない: パス(深さを消費せず相手番で再帰)。
        return -negascout(board, side.opposite(), depth, -beta, -alpha, ctx);
    }

    if depth == 0 {
        return evaluate_for(board, side);
    }

    let hash = zobrist_hash(board, side);
    let alpha_orig = alpha;
    let mut tt_move: Option<u8> = None;

    if let Some(entry) = ctx.tt.probe(hash) {
        tt_move = entry.best_move;
        if entry.depth as u32 >= depth as u32 {
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

    let moves = ordered_moves(board, side, tt_move);

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;
    let mut first = true;

    for mv in moves {
        let next_board = board.apply_move(side, 1u64 << mv);

        let score = if first {
            -negascout(&next_board, side.opposite(), depth - 1, -beta, -alpha, ctx)
        } else {
            // Null Window Search: まず [alpha, alpha+1) の狭い窓で探索する。
            let scout_score = -negascout(
                &next_board,
                side.opposite(),
                depth - 1,
                -alpha - 1,
                -alpha,
                ctx,
            );
            if scout_score > alpha && scout_score < beta {
                // 窓を外れた(=このスコアが実は最善手かもしれない)ので
                // フルウィンドウで再探索する。
                -negascout(&next_board, side.opposite(), depth - 1, -beta, -alpha, ctx)
            } else {
                scout_score
            }
        };

        if score > best_score {
            best_score = score;
            best_move = Some(mv);
        }
        if best_score > alpha {
            alpha = best_score;
        }
        if alpha >= beta {
            break;
        }
        first = false;
    }

    let bound = if best_score <= alpha_orig {
        Bound::Upper
    } else if best_score >= beta {
        Bound::Lower
    } else {
        Bound::Exact
    };

    ctx.tt.store(TTEntry {
        hash,
        depth: depth as i8,
        score: best_score,
        bound,
        best_move,
    });

    best_score
}

/// 終局時の最終石差(`side`から見たcenti-disc値)を計算する。
///
/// `endgame::final_score`(素の石差、1石=1)を呼び出して centi-disc
/// スケール(×100)に変換するだけの薄いラッパー。「石数が多い方が
/// 残り空きマスを総取りする」という終局ロジック自体は `endgame.rs` に
/// 一本化されており、ここでは重複実装しない(T007)。
fn terminal_score_centi(board: &Board, side: Side) -> i32 {
    final_score(board, side) * 100
}

/// 合法手を簡易的なムーブオーダリングで並べ替えて返す。
///
/// 優先順位: TT手(あれば最優先) → 隅 → 相手の着手後合法手数(モビリティ)が
/// 少ない順。
fn ordered_moves(board: &Board, side: Side, tt_move: Option<u8>) -> Vec<u8> {
    let legal = board.legal_moves(side);
    let mut moves: Vec<u8> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb.trailing_zeros() as u8);
        remaining &= remaining - 1;
    }

    moves.sort_by_key(|&mv| {
        let bit = 1u64 << mv;
        let is_corner = bit & CORNER_MASK != 0;
        let next_board = board.apply_move(side, bit);
        let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
        (if is_corner { 0u32 } else { 1u32 }, opp_mobility)
    });

    if let Some(tm) = tt_move {
        if let Some(pos) = moves.iter().position(|&m| m == tm) {
            moves.remove(pos);
            moves.insert(0, tm);
        }
    }

    moves
}

/// 置換表から読み筋(PV)を再構成する。
///
/// ルート局面から`best_move`を辿っていき、置換表にエントリが無くなるか
/// `max_len`手に達したら打ち切る。途中でパスが必要な局面に当たった場合は
/// 手番だけ入れ替えて続行する(パスは読み筋には現れない)。
fn extract_pv(board: &Board, side: Side, tt: &TranspositionTable, max_len: usize) -> Vec<u8> {
    let mut pv = Vec::new();
    let mut current = *board;
    let mut current_side = side;

    for _ in 0..max_len {
        // 手番側に合法手がなければパス(相手番に切り替えて続行)。
        // 両者とも合法手がなければ読み筋はここまで。
        if current.legal_moves(current_side) == 0 {
            if current.legal_moves(current_side.opposite()) == 0 {
                break;
            }
            current_side = current_side.opposite();
        }

        let hash = zobrist_hash(&current, current_side);
        let Some(entry) = tt.probe(hash) else {
            break;
        };
        let Some(mv) = entry.best_move else {
            break;
        };

        let bit = 1u64 << mv;
        if current.legal_moves(current_side) & bit == 0 {
            // 想定外(ハッシュ衝突等): 安全側に倒して打ち切る。
            break;
        }

        pv.push(mv);
        current = current.apply_move(current_side, bit);
        current_side = current_side.opposite();
    }

    pv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_limit(max_depth: u8, exact_from_empties: u8) -> SearchLimit {
        SearchLimit {
            max_depth,
            time_ms: None,
            exact_from_empties,
        }
    }

    // --- テスト用ユーティリティ: 初期局面から決定的に手を進めて空きマスを減らす ---
    // (endgame.rsのテストと同様の考え方。モジュールをまたいだ共有はしていない)

    fn play_until_empties(target_empties: u32, choose: impl Fn(&[u64]) -> u64) -> (Board, Side) {
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

    #[test]
    fn search_from_initial_position_returns_a_legal_move() {
        let board = Board::initial();
        let limit = default_limit(6, 24);
        let mut tt = TranspositionTable::new(4);

        let result = search(&board, Side::Black, &limit, &mut tt);

        let best_move = result.best_move.expect("initial position must have a best move");
        let legal = board.legal_moves(Side::Black);
        assert!(
            legal & (1u64 << best_move) != 0,
            "best_move {} is not among the legal moves {:?}",
            best_move,
            legal
        );
        assert_eq!(result.depth, 6);
    }

    #[test]
    fn search_delegates_to_exact_solver_and_matches_its_score() {
        // 空きマス数が閾値以下になるよう手を進めた局面を用意する。
        let (board, side) = play_until_empties(10, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;

        let limit = default_limit(20, exact_threshold);
        let mut tt_search = TranspositionTable::new(4);
        let result = search(&board, side, &limit, &mut tt_search);

        let mut tt_direct = TranspositionTable::new(4);
        let direct_score = solve_exact(&board, side, &mut tt_direct) * 100;

        assert_eq!(
            result.score, direct_score,
            "search() should delegate to solve_exact and report the same centi-disc score"
        );
        assert_eq!(result.depth, board.empty_count() as u8);
    }

    #[test]
    fn search_favors_black_when_black_dominates_the_board() {
        // T004(eval.rs)のテストと同じ発想: 黒が4隅を追加で保持する局面。
        // 初期局面をベースに4隅すべてを黒石にすることで、中盤探索の
        // ムーブオーダリング・葉評価が正しく統合されていれば黒有利な
        // スコアになるはず。
        let initial = Board::initial();
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board {
            black: initial.black | corners,
            white: initial.white,
        };

        let limit = default_limit(4, 10);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        assert!(
            result.score > 0,
            "black should be clearly favored, got score={}",
            result.score
        );
    }

    #[test]
    fn iterative_deepening_completes_without_error_and_depth_increases() {
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        for max_depth in [1u8, 2, 3] {
            let limit = default_limit(max_depth, 10);
            let result = search(&board, Side::Black, &limit, &mut tt);
            assert_eq!(result.depth, max_depth);
            assert!(result.best_move.is_some());
        }
    }

    #[test]
    fn search_completes_quickly_from_initial_position_up_to_depth_around_ten() {
        // 明らかな無限ループ・指数的爆発がないことの疎通確認。
        // (NPSの厳密な計測はT008のFFOベンチで行う)
        let board = Board::initial();
        let limit = default_limit(9, 12);
        let mut tt = TranspositionTable::new(64);

        let start = std::time::Instant::now();
        let result = search(&board, Side::Black, &limit, &mut tt);
        let elapsed = start.elapsed();

        println!(
            "search up to depth={} finished in {:?}, nodes={}, score={}",
            result.depth, elapsed, result.nodes, result.score
        );

        assert!(result.best_move.is_some());
    }

    #[test]
    fn reusing_tt_across_calls_with_different_exact_from_empties_does_not_crash_and_updates_marker() {
        // T007: TTスケール混同防止の回帰テスト。
        // 同じ `TranspositionTable` を使い回したまま `exact_from_empties` を
        // 変えて2回 `search()` を呼んでもクラッシュせず、かつ2回目の呼び出し
        // 後には `tt.last_exact_from_empties()` が今回の値に更新されている
        // ことを確認する(自動クリア処理が有効であることの間接的な確認)。
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        let limit_x = default_limit(4, 10);
        let _ = search(&board, Side::Black, &limit_x, &mut tt);
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(10),
            "after the first search(), tt should remember exact_from_empties=10"
        );

        // exact_from_empties を変えて同じTTを使い回す。
        let limit_y = default_limit(4, 12);
        let result = search(&board, Side::Black, &limit_y, &mut tt);

        assert!(
            result.best_move.is_some(),
            "search() should still return a valid result after reusing the tt \
             with a different exact_from_empties"
        );
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(12),
            "after the second search(), tt should remember the new exact_from_empties=12"
        );
    }

    #[test]
    fn search_terminal_score_matches_endgame_final_score_directly() {
        // T007: 終局ロジック重複解消の回帰テスト。
        // `search()` が返す終局スコア(両者パスの局面)が、
        // `endgame::final_score` を直接呼んだ結果(×100)と一致することを
        // 確認する。これは `terminal_score_centi` が独自実装ではなく
        // `endgame::final_score` を呼び出す薄いラッパーになったことの確認。
        //
        // 全マスを黒で埋め、1マスだけ空けておくと、その空きマスに隣接する
        // マスは全て黒なので両者とも合法手がなく即終局する
        // (endgame.rsの同種のテストと同じ構成)。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.empty_count(), 1);
        assert_eq!(board.legal_moves(Side::Black), 0);
        assert_eq!(board.legal_moves(Side::White), 0);

        // exact_from_empties=0 にすることで、空き1マスのこの局面は
        // (1 <= 0 が偽なので)終盤ソルバーには渡らず、必ずNegaScout側の
        // `negascout` 関数内で両者パス判定 → `terminal_score_centi` の
        // 経路を通る。
        let limit = default_limit(4, 0);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        let expected = final_score(&board, Side::Black) * 100;
        assert_eq!(
            result.score, expected,
            "search()'s terminal score should match endgame::final_score(...) * 100 exactly"
        );
    }
}

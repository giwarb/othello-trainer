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
//! 着手順序は「隅優先 → 着手後の相手の合法手数が少ない順 → 空き領域パリティ
//! (奇数優先、同着時のタイブレークのみ)」というヒューリスティックで並べ替える
//! (空きマス数によらず全体に適用する)。パリティ部分はT052で追加した
//! ([`empty_region_sizes`]参照)。
//! 安定石による静的カットや、空き4/3/2/1のハードコード専用関数は
//! 本実装では行わない(T006のスコープ外、あれば高速化に寄与するのみ)。
//!
//! # パリティベース着手順序付け (T052)
//!
//! オセロの終盤完全読みでは、空きマスを「隣接する空きマス同士を同じ領域と
//! みなすフラッドフィル(上下左右4方向連結)」で連結領域に分割し、各領域の
//! 空きマス数の奇偶(パリティ)を着手順序のヒントに使うと、アルファベータの
//! 枝刈り効率が上がることが経験的に知られている(Edaxの`src/endgame.c`の
//! `QUADRANT_ID`関連ロジックが同種のアイデアを固定象限で近似する版)。
//! 本実装は固定象限ではなく実際のフラッドフィル領域を使う、より素朴な版。
//! [`empty_region_sizes`]が現局面の空きマスをこの方法で連結領域分割し、
//! 各空きマスについて「そのマスが属する領域の空きマス数」を返す。
//!
//! **パリティを着手順序のどの優先度に置くかは実測で決めた(T052作業ログ参照)**:
//! 隅優先の次に(=相手の着手後合法手数より高い優先度で)パリティを適用すると、
//! 既存のモビリティ順(相手の合法手数が少ない順)という強い情報を上書きして
//! しまい、FFO #40でノード数が約13%増加するという明確な悪化が実測で確認された。
//! そのため最終的には、モビリティ順を維持したまま、**同じモビリティ値を持つ
//! 候補手同士の同着時のタイブレークとしてのみ**パリティ(奇数優先)を使う
//! 構成を採用している([`negamax`]のソートキーの3番目の要素)。
//! **着手順序を変えるだけで、探索結果(最終的な評価値)には一切影響しない**
//! (通常のアルファベータ探索において、より良い手を先に読むほど枝刈りが
//! 効くという性質を利用した高速化)。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};
use crate::tt::{Bound, TTEntry, TranspositionTable};
use crate::zobrist::zobrist_hash;
// search.rsと同じ理由(wasm32-unknown-unknownでの`std::time::Instant`の
// 実行時panicを避けるため)で`web_time`のドロップイン実装を使う(T034)。
use web_time::Instant;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
/// ビットとマスの対応は `bitboard.rs` 冒頭のドキュメントを参照
/// (index = rank0*8 + file なので a1=0, h1=7, a8=56, h8=63)。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

// パリティベース着手順序付け(T052)で使う、空きマスの連結領域分割
// (flood fill)のための上下左右4方向シフト。`bitboard.rs`の
// `shift_n`/`shift_s`/`shift_e`/`shift_w`(斜め方向含む8方向版)と同じ
// 考え方だが、あちらは非公開かつ8方向版なので、ここでは4方向のみの
// 版を`endgame.rs`内に独立して用意する(モジュール分割を増やさないため。
// タスクの変更対象は`endgame.rs`のみ)。
const FILE_A: u64 = 0x0101_0101_0101_0101;
const FILE_H: u64 = 0x8080_8080_8080_8080;

fn shift_n(x: u64) -> u64 {
    x >> 8
}

fn shift_s(x: u64) -> u64 {
    x << 8
}

fn shift_e(x: u64) -> u64 {
    (x << 1) & !FILE_A
}

fn shift_w(x: u64) -> u64 {
    (x >> 1) & !FILE_H
}

/// マスク`mask`の各ビットについて、上下左右4方向の隣接マスを合わせた
/// ビットマスクを返す(`mask`自身のビットは含まないことがある)。
/// `bitboard.rs`の`dilate8`(8方向版)の4方向限定版。
fn orthogonal_neighbors(mask: u64) -> u64 {
    shift_n(mask) | shift_s(mask) | shift_e(mask) | shift_w(mask)
}

/// 現局面の空きマス(`empties`ビットマスク)を、上下左右4方向連結の
/// フラッドフィルで連結領域に分割し、各マスについて「そのマスが属する
/// 領域に含まれる空きマス数」を64要素の配列(index=マス位置0..63)で返す。
/// 空きマスでない位置の値は`0`(未使用)。
///
/// 反復的な膨張(dilate)を、それ以上領域が広がらなくなるまで繰り返す
/// 方式で実装している(再帰・スタックを使わない単純なビット演算のみの版)。
fn empty_region_sizes(empties: u64) -> [u32; 64] {
    let mut sizes = [0u32; 64];
    let mut remaining = empties;

    while remaining != 0 {
        // 未処理の空きマスから1つ選び、そこから連結する領域全体を求める。
        let seed = remaining & remaining.wrapping_neg();
        let mut region = seed;
        loop {
            let expanded = (region | orthogonal_neighbors(region)) & empties;
            if expanded == region {
                break;
            }
            region = expanded;
        }

        let size = region.count_ones();
        let mut bits = region;
        while bits != 0 {
            let lsb = bits & bits.wrapping_neg();
            let idx = lsb.trailing_zeros() as usize;
            sizes[idx] = size;
            bits &= bits - 1;
        }

        remaining &= !region;
    }

    sizes
}

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
///
/// 時間予算を一切持たない(無条件に終局まで読み切る)。FFOベンチ(T009)・
/// 詰めオセロ/対局/定石練習モードなど、「完全な正解値が必要で、かつ
/// 呼び出し元がそもそも`time_ms`を指定しない」用途で使う。時間予算を
/// 課したい場合は[`solve_exact_bounded`](T034)を使うこと。
pub fn solve_exact(board: &Board, side_to_move: Side, tt: &mut TranspositionTable) -> i32 {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    negamax(board, side_to_move, -64, 64, tt, &mut nodes, None, &mut timed_out)
}

/// [`solve_exact`] と同じ完全読みを行い、結果に加えて探索した(`negamax`
/// を呼び出した)ノード数も返す。
///
/// `solve_exact` の既存シグネチャ・挙動は変更せず、ベンチマーク
/// (`engine/tests/ffo_bench.rs`, T009)がNPSを計測するために追加した
/// テスト・計測専用のエントリポイント。
pub fn solve_exact_with_nodes(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
) -> (i32, u64) {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax(board, side_to_move, -64, 64, tt, &mut nodes, None, &mut timed_out);
    (score, nodes)
}

/// [`solve_exact`]に時間予算を持たせたバージョン(T034)。
///
/// # 背景(T034)
/// 本ソルバーはT006のスコープの都合上、安定石による静的カット等の
/// 高度な枝刈りを持たない素朴なalpha-beta+TTである(モジュール冒頭の
/// ドキュメント参照)。空き22前後の局面では通常は高速に完了するが、
/// 特定の「重い」局面(FFO#49のような既知の難問と同種)では、この
/// 素朴な実装だと1回の呼び出しだけで数十秒〜数分かかることが実測で
/// 確認されている。`search.rs`の中盤探索(`negascout`/`search_all_moves`)
/// が`limit.time_ms`(反復深化の時間予算)付きでこの関数を(探索木の
/// 途中で空きマス数がしきい値以下になるたびに)呼び出すケースでは、
/// この1回の呼び出しが時間予算を大幅に超過してしまう(T034調査ログ
/// 参照)。この関数は`start`からの経過時間が`time_ms`を超えたら
/// 探索を打ち切り`None`を返す(結果が不完全なため`Some`の場合と違い
/// 使ってはならない)。打ち切った場合、置換表には格納しない
/// (不完全な探索結果でTTを汚染しないため)。
///
/// `TIME_CHECK_NODE_INTERVAL`ノードごとに`Instant::now()`
/// (WASM上は`Performance.now()`)を呼ぶため、毎ノードチェックするより
/// 十分に軽い。
pub fn solve_exact_bounded(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
    budget: TimeBudget,
) -> Option<i32> {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax(
        board,
        side_to_move,
        -64,
        64,
        tt,
        &mut nodes,
        Some(budget),
        &mut timed_out,
    );
    if timed_out {
        None
    } else {
        Some(score)
    }
}

/// [`solve_exact_bounded`]と同じ完全読みを行い、結果に加えて探索した
/// (`negamax`を呼び出した)ノード数も返す(T084)。
///
/// `solve_exact_with_nodes`(T009、無条件版)と対になる、時間予算付き版。
/// 既存の [`solve_exact_bounded`] のシグネチャ・挙動は一切変更していない
/// (本関数はそれとは独立の新規関数であり、`negamax`を同じ引数で呼ぶだけの
/// 薄いラッパー)。`search.rs`の single-root ベストムーブ探索(`search`/
/// `search_with_eval`)が、ルート局面が直接完全読みに委譲された場合の
/// 正確なノード数をテレメトリとして報告するために追加した。
/// タイムアウトした場合(戻り値の `Option<i32>` が `None`)でも、それまでに
/// 訪問したノード数は `u64` 側に返す(呼び出し元が使うかどうかは任意)。
pub fn solve_exact_bounded_with_nodes(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
    budget: TimeBudget,
) -> (Option<i32>, u64) {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax(
        board,
        side_to_move,
        -64,
        64,
        tt,
        &mut nodes,
        Some(budget),
        &mut timed_out,
    );
    if timed_out {
        (None, nodes)
    } else {
        (Some(score), nodes)
    }
}

/// [`solve_exact_bounded`]に渡す時間予算(T034)。`search.rs`の
/// `SearchLimit::time_ms`と同じ意味論(反復深化開始からの累計経過時間)を
/// 完全読みソルバーにも適用できるようにするための小さな値型。
#[derive(Debug, Clone, Copy)]
pub struct TimeBudget {
    pub start: Instant,
    pub time_ms: u64,
}

impl TimeBudget {
    fn expired(&self) -> bool {
        self.start.elapsed().as_millis() as u64 >= self.time_ms
    }
}

/// `negamax`の再帰中に時間予算をチェックする頻度(ノード数に1回)。
/// `search.rs`の`TIME_CHECK_NODE_INTERVAL`と同じ考え方
/// (WASM上での`Instant::now()`のJS境界越えコストを無視できる水準に
/// 抑えつつ、数msのオーダーで超過を検出する)。
const TIME_CHECK_NODE_INTERVAL: u64 = 1024;

/// negamax + fail-soft alpha-beta + TT による完全読み本体。
///
/// `alpha` / `beta` は `side` から見た石差の窓。
/// `nodes` はこの関数が呼び出された回数(訪問局面数)を数える
/// カウンタで、呼び出し元(`solve_exact` / `solve_exact_with_nodes` /
/// `solve_exact_bounded`)が用意したものをそのまま渡す。
///
/// `budget`が`Some`の場合、`timed_out`がまだ立っていなければ
/// `TIME_CHECK_NODE_INTERVAL`ノードごとに`budget.expired()`をチェックする
/// (T034)。超過していれば`timed_out`を立てて即座に`0`を返す(戻り値
/// 自体に意味はない。呼び出し元は`timed_out`を見て結果を丸ごと破棄する)。
/// 一度`timed_out`が立った後の全呼び出しも同様に即座に`0`を返し、
/// 置換表への格納も行わない。`budget`が`None`なら従来どおり無条件に
/// 終局まで読み切る(既存の`solve_exact`/`solve_exact_with_nodes`の
/// 挙動・性能は変えない)。
fn negamax(
    board: &Board,
    side: Side,
    alpha: i32,
    beta: i32,
    tt: &mut TranspositionTable,
    nodes: &mut u64,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> i32 {
    *nodes += 1;

    if *timed_out {
        return 0;
    }
    if let Some(budget) = budget {
        if *nodes % TIME_CHECK_NODE_INTERVAL == 0 && budget.expired() {
            *timed_out = true;
            return 0;
        }
    }

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
        return -negamax(board, side.opposite(), -beta, -alpha, tt, nodes, budget, timed_out);
    }

    // 合法手を列挙し、隅優先 → 相手の着手後合法手数が少ない順 → 空き領域
    // パリティ(奇数優先、同着時のタイブレークのみ、T052)に並べ替える。
    // パリティをモビリティより高い優先度に置くと明確に悪化することが実測で
    // 確認されたため、あえてこの優先順位(モビリティが先)にしている
    // (モジュール冒頭ドキュメント・T052作業ログ参照)。
    let mut moves: Vec<u64> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb);
        remaining &= remaining - 1;
    }

    // T052: 着手先マスが属する空き領域の空きマス数(パリティ判定用)を、
    // 現局面の空きマス集合から一度だけ計算しておく(手ごとに計算し直さない)。
    let empty_squares = !(board.black | board.white);
    let region_sizes = empty_region_sizes(empty_squares);

    moves.sort_by_key(|&mv| {
        let is_corner = mv & CORNER_MASK != 0;
        let region_size = region_sizes[mv.trailing_zeros() as usize];
        let is_even_parity = region_size % 2 == 0;
        let next_board = board.apply_move(side, mv);
        let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
        (
            if is_corner { 0u32 } else { 1u32 },
            opp_mobility,
            if is_even_parity { 1u32 } else { 0u32 },
        )
    });

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;

    for mv in moves {
        let next_board = board.apply_move(side, mv);
        let score = -negamax(&next_board, side.opposite(), -beta, -alpha, tt, nodes, budget, timed_out);

        if *timed_out {
            // 子の探索が時間切れで打ち切られた: このノードの計算は不完全
            // なため、置換表に格納せず即座に展開する(T034)。
            return 0;
        }

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
    // T052: パリティベース着手順序付けで使う `empty_region_sizes`
    // (空きマスの連結領域分割、上下左右4方向flood fill)のユニットテスト。
    // =====================================================================

    #[test]
    fn empty_region_sizes_of_fully_empty_board_is_one_connected_region_of_64() {
        // 空きマスが1つも埋まっていない盤面(全64マスが空き)は、
        // 上下左右4方向で全マスが連結するので、単一の領域(サイズ64)になる。
        let empties = u64::MAX;
        let sizes = empty_region_sizes(empties);
        for idx in 0..64usize {
            assert_eq!(sizes[idx], 64, "square index {idx} should belong to a size-64 region");
        }
    }

    #[test]
    fn empty_region_sizes_of_single_isolated_empty_square_is_one() {
        // 盤面のほぼ全体を黒で埋め、1マス(d4)だけ空けておく。
        // 唯一の空きマスは周囲を全て非空きマスに囲まれているので、
        // それだけで独立した領域(サイズ1、奇数パリティ)になる。
        let hole = 1u64 << 27; // d4 = index 27
        let empties = hole;
        let sizes = empty_region_sizes(empties);

        assert_eq!(sizes[27], 1);
        // 空きマスでない位置は0のまま(未使用値)であることも確認する。
        assert_eq!(sizes[0], 0);
        assert_eq!(sizes[63], 0);
    }

    #[test]
    fn empty_region_sizes_splits_board_into_disconnected_regions_when_a_row_is_fully_occupied() {
        // rank0=3 (盤面の「4行目」)を全マス黒で埋め、盤面を上下2つの領域に
        // 分断する。上側(rank0=0..2, 3行×8列=24マス)と下側
        // (rank0=4..7, 4行×8列=32マス)は、この行を挟んで上下左右には
        // 連結しない(黒石で塞がれているため)。
        let row4_mask: u64 = 0xFFu64 << (3 * 8);
        let board = Board {
            black: row4_mask,
            white: 0,
        };
        let empties = !(board.black | board.white);
        assert_eq!(empties.count_ones(), 56);

        let sizes = empty_region_sizes(empties);

        // 上側(rank0=0..2)は互いに同じ領域(サイズ24、偶数パリティ)。
        for rank in 0..3u32 {
            for file in 0..8u32 {
                let idx = (rank * 8 + file) as usize;
                assert_eq!(sizes[idx], 24, "index {idx} (rank={rank}, file={file}) expected size 24");
            }
        }
        // 下側(rank0=4..7)は互いに同じ領域(サイズ32、偶数パリティ)。
        for rank in 4..8u32 {
            for file in 0..8u32 {
                let idx = (rank * 8 + file) as usize;
                assert_eq!(sizes[idx], 32, "index {idx} (rank={rank}, file={file}) expected size 32");
            }
        }
        // 埋まっている行(rank0=3)は空きマスではないので0のまま。
        for file in 0..8u32 {
            let idx = (3 * 8 + file) as usize;
            assert_eq!(sizes[idx], 0, "index {idx} should be unused (not an empty square)");
        }
    }

    #[test]
    fn empty_region_sizes_treats_diagonal_adjacency_as_disconnected() {
        // 4方向連結(上下左右)のみを連結とみなし、斜め隣接は連結と
        // みなさないことを確認する。a1(index 0)とb2(index 9)は
        // 斜めに隣接するのみで、上下左右には隣接しないため、
        // 他がすべて埋まっていれば別々の領域(いずれもサイズ1)になる。
        let a1 = 1u64 << 0;
        let b2 = 1u64 << 9;
        let empties = a1 | b2;
        let sizes = empty_region_sizes(empties);

        assert_eq!(sizes[0], 1, "a1 should be its own size-1 region (not connected to b2 diagonally)");
        assert_eq!(sizes[9], 1, "b2 should be its own size-1 region (not connected to a1 diagonally)");
    }

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

    // ------------------------------------------------------------------
    // T034: `solve_exact_bounded` の時間予算遵守の回帰テスト。
    // ------------------------------------------------------------------
    //
    // 背景: 本ソルバー(`negamax`)は安定石カット等の高度な枝刈りを持たない
    // 素朴なalpha-beta+TTであり、空き20前後でもノード数が数千万〜数億に
    // 達することがある(`engine/tests/ffo_bench.rs`のドキュメント参照。
    // 例: 空き22のFFO#41で約1.9億ノード・75.8秒)。`search.rs`の中盤探索
    // (`negascout`/`search_all_moves`)がこの関数を`limit.time_ms`付きで
    // 呼び出すケースでは、時間予算(例: 1500ms)を数十〜数百倍超過する
    // ハングが実際に本番環境で発生した(棋譜解析モードで最初の1手の解析が
    // 6分以上応答しない、というT033検証での報告)。この回帰テストは、
    // 「時間予算を1msという極端に短い値にしても、探索木がそれなりの
    // 規模を持つ局面(空き18)に対して`solve_exact_bounded`が数秒以内に
    // 確実に打ち切られる(`None`を返す)」ことを検証する。修正前の実装
    // (`solve_exact`を無条件に呼ぶだけ)であれば、この局面の完全読みは
    // 数秒〜数十秒かかるため、本テストは(タイムアウトはしないにせよ)
    // 「時間予算を無視して長時間かかる」という不具合を検出できる。
    #[test]
    fn solve_exact_bounded_returns_none_promptly_when_time_budget_is_tiny_even_for_a_nontrivial_position() {
        let (board, side) = play_until_empties(18, first_move_strategy);
        assert_eq!(board.empty_count(), 18, "test setup should reach exactly 18 empties");

        let mut tt = TranspositionTable::new(64);
        let wall_start = std::time::Instant::now();
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let result = solve_exact_bounded(&board, side, &mut tt, budget);
        let elapsed = wall_start.elapsed();

        println!("solve_exact_bounded(time_ms=1) on 18-empties position finished in {elapsed:?}");

        assert!(
            result.is_none(),
            "a 1ms budget should not be enough to fully solve an 18-empties position, \
             so solve_exact_bounded should report a timeout (None) rather than a (partial/invalid) score"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "solve_exact_bounded should honor the time budget and return within a few seconds \
             (periodic in-recursion check), not block until the full exact solve completes; took {elapsed:?}"
        );
    }

    #[test]
    fn solve_exact_bounded_does_not_poison_the_tt_when_it_times_out() {
        // T034: 時間切れで打ち切られた探索は置換表に格納してはならない
        // (不完全な探索結果が後続の探索・完全読みを汚染しないことの確認)。
        // 同じ`tt`を使い回し、`solve_exact_bounded`がタイムアウトした後、
        // 通常の(無制限の)`solve_exact`で同じ局面を解いても、TTを新規に
        // 使った場合と同じ正しい答えが得られることを確認する。
        let (board, side) = play_until_empties(14, first_move_strategy);

        let mut tt_after_timeout = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let timed_out_result = solve_exact_bounded(&board, side, &mut tt_after_timeout, budget);
        assert!(timed_out_result.is_none(), "1ms budget should trigger a timeout on this position");

        let score_after_timeout = solve_exact(&board, side, &mut tt_after_timeout);

        let mut tt_fresh = TranspositionTable::new(64);
        let score_fresh = solve_exact(&board, side, &mut tt_fresh);

        assert_eq!(
            score_after_timeout, score_fresh,
            "solve_exact should return the same correct score whether or not the tt was previously \
             used by a solve_exact_bounded call that timed out (i.e. the timed-out call must not have \
             stored any incomplete/incorrect entries into the tt)"
        );
    }

    // ------------------------------------------------------------------
    // T084: `solve_exact_bounded_with_nodes` の回帰テスト。
    // ------------------------------------------------------------------

    #[test]
    fn solve_exact_bounded_with_nodes_matches_solve_exact_when_the_budget_is_generous() {
        // 十分な時間予算があれば、スコアは無条件版と完全に一致し、
        // タイムアウトもしない(`Some`が返る)ことを確認する。
        let (board, side) = play_until_empties(10, first_move_strategy);

        let mut tt_bounded = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 60_000,
        };
        let (score, nodes) = solve_exact_bounded_with_nodes(&board, side, &mut tt_bounded, budget);

        let mut tt_direct = TranspositionTable::new(64);
        let expected = solve_exact(&board, side, &mut tt_direct);

        assert_eq!(
            score,
            Some(expected),
            "with a generous time budget solve_exact_bounded_with_nodes should match solve_exact exactly"
        );
        assert!(
            nodes > 0,
            "solve_exact_bounded_with_nodes should report a positive node count for a non-trivial position"
        );
    }

    #[test]
    fn solve_exact_bounded_with_nodes_times_out_the_same_way_as_solve_exact_bounded() {
        // 極端に短い時間予算では、無条件版と同じくNoneでタイムアウトを
        // 報告することを確認する(ノード数の計測を追加しても、既存の
        // `solve_exact_bounded`のタイムアウト挙動は変わらない)。
        let (board, side) = play_until_empties(18, first_move_strategy);
        assert_eq!(board.empty_count(), 18);

        let mut tt = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let (score, nodes) = solve_exact_bounded_with_nodes(&board, side, &mut tt, budget);

        assert!(
            score.is_none(),
            "a 1ms budget should not be enough to fully solve an 18-empties position"
        );
        assert!(
            nodes > 0,
            "even a timed-out call should have visited at least some nodes before giving up"
        );
    }
}

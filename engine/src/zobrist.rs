//! Zobristハッシュ: 局面(盤面 + 手番)を64bit整数に写像するためのテーブルと関数。
//!
//! 探索(T005)・終盤ソルバー(T006)・置換表(`tt.rs`)が共通で使う局面ハッシュを提供する。
//!
//! # 決定性について
//! 再現性のあるビルドにするため、外部の乱数crate (`rand` 等) は使わない。
//! 代わりに固定シードから `splitmix64` (高品質な疑似乱数生成器として知られる
//! 単純なアルゴリズム) で64bit値を生成し、コンパイル時定数として埋め込む。
//! これにより、同じソースからビルドすれば常に同じZobristテーブルが得られる。
//!
//! # 8対称正規化ハッシュとの違い
//! 定石データベース用の「盤面を8対称のいずれで見ても同じ値になる」正規化ハッシュは
//! 別物であり、本モジュールでは扱わない(フェーズ5の定石練習タスクで別途実装する)。
//!
//! 探索(T005)・終盤ソルバー(T006)が実装されるまでは `#[cfg(test)]` 以外から
//! 参照されないため、未使用コードの警告 (dead_code) を明示的に抑制する
//! (`bitboard.rs` と同じ扱い)。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};

/// テーブル生成に使う固定シード(黄金比由来の定数、深い意味はない)。
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// splitmix64 の1ステップ。`state` から次の状態と出力値のペアを返す。
///
/// 参考実装: https://xoshiro.di.unimi.it/splitmix64.c (アルゴリズムの一般的な形を
/// Rustのconst fnとして書き下したもの)。
const fn splitmix64_next(state: u64) -> (u64, u64) {
    let new_state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = new_state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (new_state, z)
}

/// 各マス(0..63) × 各色(黒=0, 白=1)のZobrist値。コンパイル時に確定する。
const SQUARE_KEYS: [[u64; 2]; 64] = generate_square_keys();

/// 手番が黒番であることを表すZobrist値。手番が変わるとこの値がXORされる。
const SIDE_KEY: u64 = generate_side_key();

const fn generate_square_keys() -> [[u64; 2]; 64] {
    let mut table = [[0u64; 2]; 64];
    let mut state = SEED;
    let mut i = 0;
    while i < 64 {
        let (s1, v1) = splitmix64_next(state);
        let (s2, v2) = splitmix64_next(s1);
        table[i][0] = v1;
        table[i][1] = v2;
        state = s2;
        i += 1;
    }
    table
}

const fn generate_side_key() -> u64 {
    // マス用テーブルの生成で消費される乱数列と重複しないよう、
    // 同じ回数だけ状態を進めてから、さらにもう1つ値を取り出す。
    let mut state = SEED;
    let mut i = 0;
    while i < 64 {
        let (s1, _v1) = splitmix64_next(state);
        let (s2, _v2) = splitmix64_next(s1);
        state = s2;
        i += 1;
    }
    let (_final_state, v) = splitmix64_next(state);
    v
}

fn side_index(side: Side) -> usize {
    match side {
        Side::Black => 0,
        Side::White => 1,
    }
}

/// 盤面全体を舐めてZobristハッシュを計算する(素朴な実装)。
///
/// 同一の `board` と `side_to_move` からは常に同じ値が得られる(決定的)。
pub fn zobrist_hash(board: &Board, side_to_move: Side) -> u64 {
    let mut hash = 0u64;
    for (i, keys) in SQUARE_KEYS.iter().enumerate() {
        let bit = 1u64 << i;
        if board.black & bit != 0 {
            hash ^= keys[0];
        } else if board.white & bit != 0 {
            hash ^= keys[1];
        }
    }
    if side_to_move == Side::Black {
        hash ^= SIDE_KEY;
    }
    hash
}

/// 増分更新用ヘルパー: 指定マスに指定色の石を置く/取り除く操作をハッシュに反映する。
///
/// XORベースなので、同じ引数でもう一度呼べば元に戻る(置く操作にも取り除く操作にも使える)。
pub fn toggle_square(hash: u64, square: u8, side: Side) -> u64 {
    hash ^ SQUARE_KEYS[square as usize][side_index(side)]
}

/// 増分更新用ヘルパー: 手番の黒/白が入れ替わったことをハッシュに反映する。
pub fn toggle_side_to_move(hash: u64) -> u64 {
    hash ^ SIDE_KEY
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bitboard::Board;

    #[test]
    fn same_board_and_side_gives_same_hash_every_time() {
        let b = Board::initial();
        let h1 = zobrist_hash(&b, Side::Black);
        let h2 = zobrist_hash(&b, Side::Black);
        let h3 = zobrist_hash(&b, Side::Black);
        assert_eq!(h1, h2);
        assert_eq!(h2, h3);
    }

    #[test]
    fn different_side_to_move_changes_hash_for_same_board() {
        let b = Board::initial();
        assert_ne!(zobrist_hash(&b, Side::Black), zobrist_hash(&b, Side::White));
    }

    #[test]
    fn boards_after_several_moves_all_have_distinct_hashes() {
        // 初期局面から決定的に手を進め、各ステップの局面ハッシュがすべて相異なることを確認する。
        let mut board = Board::initial();
        let mut side = Side::Black;
        let mut hashes = vec![zobrist_hash(&board, side)];

        for _ in 0..10 {
            let legal = board.legal_moves(side);
            if legal == 0 {
                let other = side.opposite();
                if board.legal_moves(other) == 0 {
                    break;
                }
                side = other;
                continue;
            }
            // 常に最下位ビットの合法手を選ぶ(決定的)。
            let mv = 1u64 << legal.trailing_zeros();
            board = board.apply_move(side, mv);
            side = side.opposite();
            hashes.push(zobrist_hash(&board, side));
        }

        assert!(
            hashes.len() >= 5,
            "expected at least 5 distinct board states to compare, got {}",
            hashes.len()
        );

        for i in 0..hashes.len() {
            for j in (i + 1)..hashes.len() {
                assert_ne!(
                    hashes[i], hashes[j],
                    "hash collision between step {} and step {}",
                    i, j
                );
            }
        }
    }

    #[test]
    fn toggle_square_is_its_own_inverse() {
        let h0 = 0x1234_5678_9abc_def0u64;
        let h1 = toggle_square(h0, 27, Side::White);
        let h2 = toggle_square(h1, 27, Side::White);
        assert_eq!(h0, h2);
        assert_ne!(h0, h1);
    }

    #[test]
    fn toggle_side_to_move_is_its_own_inverse() {
        let h0 = 0xdead_beef_cafe_babeu64;
        let h1 = toggle_side_to_move(h0);
        let h2 = toggle_side_to_move(h1);
        assert_eq!(h0, h2);
        assert_ne!(h0, h1);
    }
}

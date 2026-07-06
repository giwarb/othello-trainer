//! オセロの盤面表現・合法手生成・着手適用のコアロジック。
//!
//! # ビットインデックスの対応
//!
//! 盤面は `black: u64` / `white: u64` の2枚のビットボードで表現する。
//! 64マスと各ビットの対応は以下の固定ルールで決める:
//!
//! - マス `<列><行>` (列は `a`〜`h`, 行は `1`〜`8`) に対して、
//!   列インデックス `file = 列文字 - 'a'` (a=0, ..., h=7)、
//!   行インデックス `rank0 = 行 - 1` (0..7) とすると、
//!   ビット位置 `index = rank0 * 8 + file` (0..63) にそのマスを対応させる。
//! - つまり `a1` = ビット0、`h1` = ビット7、`a2` = ビット8、`h8` = ビット63。
//! - `index` が1大きくなると「同じ行で列が1つ右 (a→b→...→h)」に進み、
//!   `index` が8大きくなると「同じ列で1行下 (1→2→...→8)」に進む
//!   (碁盤の左上を `a1`、右下を `h8` とする一般的なオセロ盤の描き方に対応する)。
//!
//! この対応の下で、標準オセロの開始局面は
//! 白 = `{d4, e5}`、黒 = `{e4, d5}` となる
//! (中央4マスのうち、左上と右下が白、右上と左下が黒)。
//!
//! 開始局面で黒番の合法手は `d3, c4, f5, e6` の4マスであることが知られており、
//! 本ファイル末尾のテストでこれを検証する。
//!
//! `Board` / `Side` の WASM 向け公開 API (`#[wasm_bindgen]`) は T007 で行う。
//! 現時点では `lib.rs` から `#[cfg(test)]` 以外で参照されないため、
//! 未使用コードの警告 (dead_code) を明示的に抑制する。

#![allow(dead_code)]

/// 手番を表す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Black,
    White,
}

impl Side {
    /// 相手側を返す。
    pub fn opposite(self) -> Side {
        match self {
            Side::Black => Side::White,
            Side::White => Side::Black,
        }
    }
}

/// オセロの盤面。
///
/// `black` / `white` はそれぞれの色の石が置かれているマスを1ビットで表す
/// ビットボード。ビットとマスの対応はモジュール冒頭のドキュメントを参照。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Board {
    pub black: u64,
    pub white: u64,
}

// 列 a (ファイルA) にあたるビット群。a1, a2, ..., a8 に対応するビットが立っている。
const FILE_A: u64 = 0x0101_0101_0101_0101;
// 列 h (ファイルH) にあたるビット群。
const FILE_H: u64 = 0x8080_8080_8080_8080;
const NOT_FILE_A: u64 = !FILE_A;
const NOT_FILE_H: u64 = !FILE_H;

// 8方向それぞれの「1マス移動」をビット演算のシフトとして実装する。
// index+8 = 1行下 (南)、index-8 = 1行上 (北)、index+1 = 1列右 (東)、index-1 = 1列左 (西)。
// 東西方向を含むシフトは列の端をまたぐ「回り込み」が発生しうるため、
// シフト後に境界マスクを掛けて回り込みビットを除去する。

fn shift_n(x: u64) -> u64 {
    x >> 8
}

fn shift_s(x: u64) -> u64 {
    x << 8
}

fn shift_e(x: u64) -> u64 {
    (x << 1) & NOT_FILE_A
}

fn shift_w(x: u64) -> u64 {
    (x >> 1) & NOT_FILE_H
}

fn shift_ne(x: u64) -> u64 {
    (x >> 7) & NOT_FILE_A
}

fn shift_nw(x: u64) -> u64 {
    (x >> 9) & NOT_FILE_H
}

fn shift_se(x: u64) -> u64 {
    (x << 9) & NOT_FILE_A
}

fn shift_sw(x: u64) -> u64 {
    (x << 7) & NOT_FILE_H
}

type ShiftFn = fn(u64) -> u64;

const DIRECTIONS: [ShiftFn; 8] = [
    shift_n, shift_s, shift_e, shift_w, shift_ne, shift_nw, shift_se, shift_sw,
];

impl Board {
    /// 標準オセロの開始局面を返す。
    /// 中央4マスのうち、左上(d4)と右下(e5)が白、右上(e4)と左下(d5)が黒。
    pub fn initial() -> Board {
        // d4 = index 27, e4 = index 28, d5 = index 35, e5 = index 36
        let white = (1u64 << 27) | (1u64 << 36);
        let black = (1u64 << 28) | (1u64 << 35);
        Board { black, white }
    }

    /// 指定した手番の (自分の石, 相手の石) のビットボードを返す。
    fn sides(&self, side: Side) -> (u64, u64) {
        match side {
            Side::Black => (self.black, self.white),
            Side::White => (self.white, self.black),
        }
    }

    /// 指定した手番の合法手を全て求め、着手可能なマスを立てたビットマスクとして返す。
    ///
    /// Kogge-Stone 系の方向別シフトにより、8方向それぞれについて
    /// 「自分の石に隣接する相手の石の連続」を伸ばしていき、
    /// その先が空きマスであれば合法手として採用する。
    pub fn legal_moves(&self, side: Side) -> u64 {
        let (own, opp) = self.sides(side);
        let empty = !(self.black | self.white);
        let mut moves = 0u64;

        for &dir in DIRECTIONS.iter() {
            // 自分の石から見て、その方向に連続する相手の石の集合を広げていく。
            let mut t = dir(own) & opp;
            // 盤面は8x8なので、自分の石と相手の石に挟まれうる相手の石の連続は
            // 最大6個(残り2マスは自分の石とその先の空きマス)。
            // 初回のシフトを含めて最大6回シフトすれば十分収束する。
            for _ in 0..5 {
                t |= dir(t) & opp;
            }
            // 相手の石の連続の先が空きマスであれば、そこが合法手。
            moves |= dir(t) & empty;
        }

        moves
    }

    /// 指定した1手 (1ビットのみ立ったビットマスク) を打った後の新しい `Board` を返す。
    ///
    /// `mv_bit` は `legal_moves(side)` に含まれる合法手であることを前提とする
    /// (非合法手の場合の挙動は未定義)。デバッグビルドでは軽く検証する。
    pub fn apply_move(&self, side: Side, mv_bit: u64) -> Board {
        debug_assert!(mv_bit.count_ones() == 1, "mv_bit must have exactly one bit set");
        debug_assert!(
            self.legal_moves(side) & mv_bit != 0,
            "mv_bit must be a legal move for the given side"
        );

        let (own, opp) = self.sides(side);
        let mut flips = 0u64;

        for &dir in DIRECTIONS.iter() {
            let mut captured = 0u64;
            let mut x = dir(mv_bit);
            while x & opp != 0 {
                captured |= x;
                x = dir(x);
            }
            // その方向の連続が自分の石で終端していれば、挟んだ相手の石は全てひっくり返る。
            if x & own != 0 {
                flips |= captured;
            }
        }

        let new_own = own | mv_bit | flips;
        let new_opp = opp & !flips;

        match side {
            Side::Black => Board {
                black: new_own,
                white: new_opp,
            },
            Side::White => Board {
                black: new_opp,
                white: new_own,
            },
        }
    }

    /// 指定した手番に合法手が存在するかどうかを返す。
    pub fn has_legal_move(&self, side: Side) -> bool {
        self.legal_moves(side) != 0
    }

    /// 両者ともパス(合法手なし)であれば終局とみなす。
    pub fn is_terminal(&self) -> bool {
        !self.has_legal_move(Side::Black) && !self.has_legal_move(Side::White)
    }

    /// 指定した色の石数を返す。
    pub fn disc_count(&self, side: Side) -> u32 {
        match side {
            Side::Black => self.black.count_ones(),
            Side::White => self.white.count_ones(),
        }
    }

    /// 空きマスの数を返す。
    pub fn empty_count(&self) -> u32 {
        64 - (self.black | self.white).count_ones()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- テスト用ユーティリティ: "a1"〜"h8" 記法とビット位置の相互変換 ---

    /// "d3" のような記法を対応するビット位置 (0..63) に変換する。
    fn sq(notation: &str) -> u32 {
        let bytes = notation.as_bytes();
        assert_eq!(bytes.len(), 2, "notation must be like \"d3\"");
        let file = (bytes[0] as u32) - (b'a' as u32);
        let rank = (bytes[1] as u32) - (b'1' as u32);
        assert!(file < 8 && rank < 8, "notation out of range: {}", notation);
        rank * 8 + file
    }

    /// ビット位置 (0..63) を "a1"〜"h8" のような記法に変換する(デバッグ表示用)。
    fn notation(index: u32) -> String {
        let file = (index % 8) as u8;
        let rank = (index / 8) as u8;
        format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
    }

    /// ビットマスクを立っているビットに対応する記法の集合(ソート済み Vec)に変換する。
    fn bits_to_notations(mask: u64) -> Vec<String> {
        let mut v: Vec<String> = (0..64)
            .filter(|i| mask & (1u64 << i) != 0)
            .map(notation)
            .collect();
        v.sort();
        v
    }

    // =====================================================================
    // 素朴な参照実装 (naive reference implementation)
    //
    // ビットボード実装とは完全に独立に、8x8の配列を64マス愚直にループし、
    // 各マスについて8方向を1マスずつ辿って合法手・着手適用を判定する。
    // パフォーマンスは考慮せず、正しさが目視で明らかなロジックにする。
    // =====================================================================

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum NaiveCell {
        Empty,
        Black,
        White,
    }

    #[derive(Debug, Clone)]
    struct NaiveBoard {
        // cells[rank0][file] , rank0 = 0..7 (行1..8), file = 0..7 (列a..h)
        cells: [[NaiveCell; 8]; 8],
    }

    impl NaiveBoard {
        fn initial() -> NaiveBoard {
            let mut cells = [[NaiveCell::Empty; 8]; 8];
            // d4 = white, e4 = black, d5 = black, e5 = white
            cells[3][3] = NaiveCell::White; // d4 (rank0=3, file=3)
            cells[3][4] = NaiveCell::Black; // e4
            cells[4][3] = NaiveCell::Black; // d5
            cells[4][4] = NaiveCell::White; // e5
            NaiveBoard { cells }
        }

        fn cell_of(side: Side) -> NaiveCell {
            match side {
                Side::Black => NaiveCell::Black,
                Side::White => NaiveCell::White,
            }
        }

        /// 指定した手番の合法手を、ビットボードと同じビット対応のビットマスクとして返す。
        fn legal_moves_bits(&self, side: Side) -> u64 {
            let own = Self::cell_of(side);
            let opp = Self::cell_of(side.opposite());
            let mut moves = 0u64;

            const DIRS: [(i32, i32); 8] = [
                (-1, 0),
                (1, 0),
                (0, -1),
                (0, 1),
                (-1, -1),
                (-1, 1),
                (1, -1),
                (1, 1),
            ];

            for rank0 in 0..8i32 {
                for file in 0..8i32 {
                    if self.cells[rank0 as usize][file as usize] != NaiveCell::Empty {
                        continue;
                    }
                    'dir_loop: for &(dr, df) in DIRS.iter() {
                        let mut r = rank0 + dr;
                        let mut f = file + df;
                        let mut saw_opp = false;
                        while r >= 0 && r < 8 && f >= 0 && f < 8 {
                            let c = self.cells[r as usize][f as usize];
                            if c == opp {
                                saw_opp = true;
                                r += dr;
                                f += df;
                                continue;
                            } else if c == own && saw_opp {
                                // このマスは合法手
                                let index = (rank0 as u32) * 8 + (file as u32);
                                moves |= 1u64 << index;
                                break 'dir_loop;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }

            moves
        }

        /// 指定した手番が `mv_bit` (単一ビット) に着手した後の新しい盤面を返す。
        fn apply_move_bits(&self, side: Side, mv_bit: u64) -> NaiveBoard {
            let own = Self::cell_of(side);
            let opp = Self::cell_of(side.opposite());

            let index = mv_bit.trailing_zeros();
            assert_eq!(1u64 << index, mv_bit, "mv_bit must have exactly one bit set");
            let rank0 = (index / 8) as i32;
            let file = (index % 8) as i32;

            let mut new_board = self.clone();
            new_board.cells[rank0 as usize][file as usize] = own;

            const DIRS: [(i32, i32); 8] = [
                (-1, 0),
                (1, 0),
                (0, -1),
                (0, 1),
                (-1, -1),
                (-1, 1),
                (1, -1),
                (1, 1),
            ];

            for &(dr, df) in DIRS.iter() {
                let mut r = rank0 + dr;
                let mut f = file + df;
                let mut to_flip: Vec<(i32, i32)> = Vec::new();
                let mut terminated_by_own = false;
                while r >= 0 && r < 8 && f >= 0 && f < 8 {
                    let c = self.cells[r as usize][f as usize];
                    if c == opp {
                        to_flip.push((r, f));
                        r += dr;
                        f += df;
                    } else if c == own {
                        terminated_by_own = true;
                        break;
                    } else {
                        break;
                    }
                }
                if terminated_by_own {
                    for (fr, ff) in to_flip {
                        new_board.cells[fr as usize][ff as usize] = own;
                    }
                }
            }

            new_board
        }

        /// (black, white) のビットボード表現に変換する。
        fn to_bits(&self) -> (u64, u64) {
            let mut black = 0u64;
            let mut white = 0u64;
            for rank0 in 0..8usize {
                for file in 0..8usize {
                    let index = (rank0 as u32) * 8 + (file as u32);
                    match self.cells[rank0][file] {
                        NaiveCell::Black => black |= 1u64 << index,
                        NaiveCell::White => white |= 1u64 << index,
                        NaiveCell::Empty => {}
                    }
                }
            }
            (black, white)
        }
    }

    // =====================================================================
    // テスト本体
    // =====================================================================

    #[test]
    fn initial_board_matches_expected_layout() {
        let b = Board::initial();
        assert_eq!(b.black, (1u64 << sq("e4")) | (1u64 << sq("d5")));
        assert_eq!(b.white, (1u64 << sq("d4")) | (1u64 << sq("e5")));
    }

    #[test]
    fn initial_board_legal_moves_match_known_othello_opening() {
        let b = Board::initial();
        let moves = b.legal_moves(Side::Black);

        let expected: u64 =
            (1u64 << sq("d3")) | (1u64 << sq("c4")) | (1u64 << sq("f5")) | (1u64 << sq("e6"));

        assert_eq!(
            moves,
            expected,
            "black's opening legal moves should be d3, c4, f5, e6 but got {:?}",
            bits_to_notations(moves)
        );
    }

    #[test]
    fn initial_board_matches_naive_reference_for_both_sides() {
        let b = Board::initial();
        let naive = NaiveBoard::initial();

        let (nb_black, nb_white) = naive.to_bits();
        assert_eq!(b.black, nb_black);
        assert_eq!(b.white, nb_white);

        assert_eq!(
            b.legal_moves(Side::Black),
            naive.legal_moves_bits(Side::Black)
        );
        assert_eq!(
            b.legal_moves(Side::White),
            naive.legal_moves_bits(Side::White)
        );
    }

    /// 合法手ビットマスクから、立っているビットを昇順(LSBが先)の Vec にする。
    fn moves_to_vec(mask: u64) -> Vec<u64> {
        (0..64)
            .filter(|i| mask & (1u64 << i) != 0)
            .map(|i| 1u64 << i)
            .collect()
    }

    /// 決定的戦略に従い、初期局面からランダム(疑似)自己対戦を行い、
    /// 各局面でビットボード実装と素朴参照実装が完全一致することを検証する。
    fn run_self_play_and_verify<F>(strategy_name: &str, choose: F)
    where
        F: Fn(&[u64], usize) -> u64,
    {
        let mut board = Board::initial();
        let mut naive = NaiveBoard::initial();
        let mut side = Side::Black;

        for step in 0..30 {
            let bit_legal = board.legal_moves(side);
            let naive_legal = naive.legal_moves_bits(side);
            assert_eq!(
                bit_legal, naive_legal,
                "[{}] legal move mismatch at step {} (side={:?}): bitboard={:?}, naive={:?}",
                strategy_name,
                step,
                side,
                bits_to_notations(bit_legal),
                bits_to_notations(naive_legal)
            );

            if bit_legal == 0 {
                // パス: 相手も合法手がなければ終局。
                let other = side.opposite();
                if board.legal_moves(other) == 0 {
                    break;
                }
                side = other;
                continue;
            }

            let moves_vec = moves_to_vec(bit_legal);
            let mv = choose(&moves_vec, step);
            assert!(
                moves_vec.contains(&mv),
                "[{}] strategy chose an illegal move at step {}",
                strategy_name,
                step
            );

            let new_board = board.apply_move(side, mv);
            let new_naive = naive.apply_move_bits(side, mv);
            let (naive_black, naive_white) = new_naive.to_bits();

            assert_eq!(
                new_board.black, naive_black,
                "[{}] black bitboard mismatch after move {} at step {}",
                strategy_name,
                notation(mv.trailing_zeros()),
                step
            );
            assert_eq!(
                new_board.white, naive_white,
                "[{}] white bitboard mismatch after move {} at step {}",
                strategy_name,
                notation(mv.trailing_zeros()),
                step
            );

            board = new_board;
            naive = new_naive;
            side = side.opposite();

            if board.is_terminal() {
                break;
            }
        }
    }

    #[test]
    fn self_play_matches_naive_reference_strategy_first_move() {
        // 常に最小ビット(合法手リストの先頭)を選ぶ決定的戦略。
        run_self_play_and_verify("first_move", |moves, _step| moves[0]);
    }

    #[test]
    fn self_play_matches_naive_reference_strategy_last_move() {
        // 常に最大ビット(合法手リストの末尾)を選ぶ決定的戦略。
        run_self_play_and_verify("last_move", |moves, _step| moves[moves.len() - 1]);
    }

    #[test]
    fn self_play_matches_naive_reference_strategy_middle_move() {
        // 合法手リストの中央を選ぶ決定的戦略。
        run_self_play_and_verify("middle_move", |moves, _step| moves[moves.len() / 2]);
    }

    #[test]
    fn self_play_matches_naive_reference_strategy_hash_based() {
        // 外部crateなしで決定的に手を選ぶ疑似ランダム戦略:
        // DefaultHasher で (手番, ステップ数, 候補手のビット) をハッシュ化し、
        // その値を使って毎回異なるインデックスを選ぶ。
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        run_self_play_and_verify("hash_based", |moves, step| {
            let mut hasher = DefaultHasher::new();
            step.hash(&mut hasher);
            for m in moves {
                m.hash(&mut hasher);
            }
            let h = hasher.finish();
            let idx = (h as usize) % moves.len();
            moves[idx]
        });
    }

    #[test]
    fn disc_count_and_empty_count_on_initial_board() {
        let b = Board::initial();
        assert_eq!(b.disc_count(Side::Black), 2);
        assert_eq!(b.disc_count(Side::White), 2);
        assert_eq!(b.empty_count(), 60);
    }

    #[test]
    fn has_legal_move_and_is_terminal_on_initial_board() {
        let b = Board::initial();
        assert!(b.has_legal_move(Side::Black));
        assert!(b.has_legal_move(Side::White));
        assert!(!b.is_terminal());
    }
}

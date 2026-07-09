//! 盤面パターン特徴量の定義と、局面からの状態インデックス抽出。
//!
//! # パターン形状(v1、22パターン)
//!
//! - 行パターン8個(各8セル): `rank0`を0..8で固定し、`file0`を0..8で動かす。
//! - 列パターン8個(各8セル): `file0`を0..8で固定し、`rank0`を0..8で動かす。
//! - 主対角線1個(8セル、a1-h8方向): `file0 == rank0`。
//! - 反対角線1個(8セル、a8-h1方向): `file0 + rank0 == 7`。
//! - 隅3x3ブロック4個(各9セル): 4隅それぞれを含む3x3領域。
//!
//! 過去のタスク(定石データ収集T016)で「記憶に頼った手作業転記がデータ誤りを生んだ」
//! 事故があったため、これらのセル座標は個別のセル番号を手で列挙するのではなく、
//! すべて`rank0`/`file0`のループ演算で機械的に導出する
//! ([`generate_patterns`]を参照。手書きのセル番号リストは含まない)。
//!
//! # 状態エンコーディング
//!
//! 各パターンの状態は、パターンに含まれる各セルを「着目手番(mover)」視点で
//! 0=空・1=自石・2=相手石の3値に写し、パターン内での並び順を3進数の桁として
//! エンコードした整数(`0 .. 3^パターン長`)で表す
//! (8セルパターンなら3^8=6561状態、9セルパターンなら3^9=19683状態)。
//!
//! 対称性(回転・鏡映)による重み共有は本タスク(v1)では行わない。各パターン
//! インスタンスは独立した重みを持つ(将来の改善候補)。
//!
//! # T043: `train`クレートからの移動
//!
//! 本モジュールは元々`train/src/patterns.rs`にあったが(T041)、T043で
//! `engine`クレートに評価用の重み読み込み(`engine::pattern_eval`)を実装する際、
//! パターン形状定義・特徴抽出ロジックが`train`/`engine`の2箇所に複製される
//! ドリフトリスクを避けるため、`engine`側に一本化した(T041のreviewer指摘に
//! よる設計変更)。`train`クレートは`engine::patterns`をそのまま`use`する。

use crate::bitboard::{Board, Side};

/// 1パターンが参照する盤面セルのインデックス列(各要素は0..64、
/// `index = rank0*8 + file0`)。並び順がそのまま状態インデックスの桁順に対応する。
pub type PatternCells = Vec<u8>;

/// v1で使う全22パターンのセルインデックスを機械的に生成して返す。
///
/// 生成順序(この順序が[`pattern_state_index`]等が返すパターンIDの並びであり、
/// 学習済み重みファイルのレイアウトにもそのまま対応する):
/// 行8個 → 列8個 → 主対角線1個 → 反対角線1個 → 隅3x3ブロック4個。
pub fn generate_patterns() -> Vec<PatternCells> {
    let mut patterns: Vec<PatternCells> = Vec::with_capacity(22);

    // 行パターン(8個): rank0を固定し、file0を0..8で動かす。
    for rank0 in 0u8..8 {
        let cells: PatternCells = (0u8..8).map(|file0| rank0 * 8 + file0).collect();
        patterns.push(cells);
    }

    // 列パターン(8個): file0を固定し、rank0を0..8で動かす。
    for file0 in 0u8..8 {
        let cells: PatternCells = (0u8..8).map(|rank0| rank0 * 8 + file0).collect();
        patterns.push(cells);
    }

    // 主対角線(1個、a1-h8方向): file0 == rank0 となる8セル。
    let main_diagonal: PatternCells = (0u8..8).map(|i| i * 8 + i).collect();
    patterns.push(main_diagonal);

    // 反対角線(1個、a8-h1方向): file0 + rank0 == 7 となる8セル。
    let anti_diagonal: PatternCells = (0u8..8).map(|i| i * 8 + (7 - i)).collect();
    patterns.push(anti_diagonal);

    // 隅3x3ブロック(4個): 4隅それぞれについて、rank0/file0の範囲を2重ループで
    // 走査して9セルを生成する。範囲そのもの(0..3 または 5..8)のみが隅ごとに
    // 異なり、セル番号を個別に書き出す処理は行わない。
    let corner_ranges: [(std::ops::Range<u8>, std::ops::Range<u8>); 4] = [
        (0..3, 0..3), // a1側
        (0..3, 5..8), // h1側
        (5..8, 0..3), // a8側
        (5..8, 5..8), // h8側
    ];
    for (rank_range, file_range) in corner_ranges {
        let mut cells: PatternCells = Vec::with_capacity(9);
        for rank0 in rank_range.clone() {
            for file0 in file_range.clone() {
                cells.push(rank0 * 8 + file0);
            }
        }
        patterns.push(cells);
    }

    patterns
}

/// パターン長(セル数)に対応する状態数(3^パターン長)を返す。
pub fn num_states(pattern_len: usize) -> u32 {
    3u32.pow(pattern_len as u32)
}

/// 盤面の1マス(`index`)の状態を、`mover`から見た3値(0=空, 1=自石, 2=相手石)で返す。
fn cell_trit(board: &Board, mover: Side, index: u8) -> u32 {
    let bit = 1u64 << index;
    let (own, opp) = match mover {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };
    if own & bit != 0 {
        1
    } else if opp & bit != 0 {
        2
    } else {
        0
    }
}

/// 指定したパターン(`cells`)について、`board`・`mover`から見た状態インデックス
/// (3進数エンコード、`0 .. num_states(cells.len())`)を計算する。
pub fn pattern_state_index(cells: &[u8], board: &Board, mover: Side) -> u32 {
    let mut index = 0u32;
    let mut multiplier = 1u32;
    for &cell in cells {
        let trit = cell_trit(board, mover, cell);
        index += trit * multiplier;
        multiplier *= 3;
    }
    index
}

/// 局面(`board`・`mover`)から、全パターンのアクティブな
/// (パターンID, 状態インデックス)の組を抽出する。パターンIDは
/// `patterns`(通常は[`generate_patterns`]の戻り値)内でのインデックスと一致する。
pub fn extract_features(
    patterns: &[PatternCells],
    board: &Board,
    mover: Side,
) -> Vec<(usize, u32)> {
    patterns
        .iter()
        .enumerate()
        .map(|(pattern_id, cells)| (pattern_id, pattern_state_index(cells, board, mover)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_exactly_22_patterns() {
        let patterns = generate_patterns();
        assert_eq!(patterns.len(), 22);
    }

    #[test]
    fn every_pattern_has_8_or_9_cells() {
        let patterns = generate_patterns();
        for (i, cells) in patterns.iter().enumerate() {
            assert!(
                cells.len() == 8 || cells.len() == 9,
                "pattern #{i} has unexpected length {}",
                cells.len()
            );
        }
    }

    #[test]
    fn row_and_column_and_diagonal_patterns_have_8_cells() {
        let patterns = generate_patterns();
        // 生成順序: 行8個(0..8) → 列8個(8..16) → 主対角線(16) → 反対角線(17) → 隅4個(18..22)。
        for i in 0..18 {
            assert_eq!(patterns[i].len(), 8, "pattern #{i} should have 8 cells");
        }
    }

    #[test]
    fn corner_patterns_have_9_cells() {
        let patterns = generate_patterns();
        for i in 18..22 {
            assert_eq!(patterns[i].len(), 9, "pattern #{i} should have 9 cells");
        }
    }

    #[test]
    fn no_pattern_contains_duplicate_cells() {
        let patterns = generate_patterns();
        for (i, cells) in patterns.iter().enumerate() {
            let mut sorted = cells.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(
                sorted.len(),
                cells.len(),
                "pattern #{i} contains duplicate cells: {:?}",
                cells
            );
        }
    }

    #[test]
    fn all_cell_indices_are_within_board_range() {
        let patterns = generate_patterns();
        for cells in &patterns {
            for &c in cells {
                assert!(c < 64, "cell index out of range: {c}");
            }
        }
    }

    #[test]
    fn corner_3x3_patterns_each_contain_their_own_corner_square() {
        let patterns = generate_patterns();
        // 隅パターンは生成順序で18..22番目。a1=0, h1=7, a8=56, h8=63。
        let corner_squares = [0u8, 7, 56, 63];
        for (offset, &corner) in corner_squares.iter().enumerate() {
            let cells = &patterns[18 + offset];
            assert!(
                cells.contains(&corner),
                "corner pattern #{} should contain corner square {corner}, got {:?}",
                18 + offset,
                cells
            );
        }
    }

    #[test]
    fn main_diagonal_is_a1_to_h8() {
        let patterns = generate_patterns();
        let main_diag = &patterns[16];
        assert_eq!(main_diag, &vec![0u8, 9, 18, 27, 36, 45, 54, 63]);
    }

    #[test]
    fn anti_diagonal_is_a8_to_h1() {
        let patterns = generate_patterns();
        let anti_diag = &patterns[17];
        assert_eq!(anti_diag, &vec![7u8, 14, 21, 28, 35, 42, 49, 56]);
    }

    #[test]
    fn num_states_matches_powers_of_three() {
        assert_eq!(num_states(8), 6561);
        assert_eq!(num_states(9), 19683);
    }

    #[test]
    fn pattern_state_index_of_empty_board_is_zero() {
        let board = Board { black: 0, white: 0 };
        let cells: PatternCells = (0u8..8).collect();
        assert_eq!(pattern_state_index(&cells, &board, Side::Black), 0);
    }

    #[test]
    fn pattern_state_index_encodes_own_and_opponent_stones_correctly() {
        // 3セルパターン: セル0=自石(黒), セル1=相手石(白), セル2=空。
        // mover=Black視点で 1*3^0 + 2*3^1 + 0*3^2 = 1 + 6 + 0 = 7。
        let board = Board {
            black: 1u64, // セル0
            white: 1u64 << 1, // セル1
        };
        let cells: PatternCells = vec![0, 1, 2];
        assert_eq!(pattern_state_index(&cells, &board, Side::Black), 7);
        // mover=White視点なら 自石/相手石が入れ替わる:
        // 2*3^0 + 1*3^1 + 0*3^2 = 2 + 3 = 5。
        assert_eq!(pattern_state_index(&cells, &board, Side::White), 5);
    }

    #[test]
    fn extract_features_returns_one_entry_per_pattern() {
        let patterns = generate_patterns();
        let board = Board::initial();
        let features = extract_features(&patterns, &board, Side::Black);
        assert_eq!(features.len(), 22);
        for (i, (pattern_id, _state)) in features.iter().enumerate() {
            assert_eq!(*pattern_id, i);
        }
    }
}

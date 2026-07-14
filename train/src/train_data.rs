//! WTHOR棋譜(`wthor::WthorGame`)から、パターン評価学習用のサンプルを生成する。
//!
//! 1対局につき、初手適用後の各局面(その局面で次に着手する側、"mover"視点)について、
//! 「局面(`Board`, `mover`)」と「その対局の最終結果(mover視点の最終石差 =
//! mover側の最終石数 − 相手側の最終石数)」のペア([`Sample`])を1件生成する。
//! パス(合法手なしによる手番飛ばし)は`wthor::replay`と同じロジックで自動処理する。

use engine::bitboard::{Board, Side};

use crate::wthor::WthorGame;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastMoveKind {
    Other,
    X,
    C,
}

/// 1件の学習サンプル。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    /// 学習対象の局面。
    pub board: Board,
    /// この局面で次に着手する側(特徴量抽出・結果の符号の基準となる視点)。
    pub mover: Side,
    /// 対局終了時の (mover視点の石数 − 相手視点の石数)。正なら最終的にmover側が勝った
    /// (石数で上回った)ことを意味する。
    pub outcome: f32,
    pub last_move_kind: LastMoveKind,
    pub vulnerable_xc: bool,
}

fn last_move_metadata(mv_index: u8, board_before: &Board) -> (LastMoveKind, bool) {
    const X: &[(u8, u8)] = &[(9, 0), (14, 7), (49, 56), (54, 63)];
    const C: &[(u8, u8)] = &[
        (1, 0),
        (8, 0),
        (6, 7),
        (15, 7),
        (48, 56),
        (57, 56),
        (55, 63),
        (62, 63),
    ];
    if let Some(&(_, corner)) = X.iter().find(|&&(cell, _)| cell == mv_index) {
        return (
            LastMoveKind::X,
            (board_before.black | board_before.white) & (1u64 << corner) == 0,
        );
    }
    if let Some(&(_, corner)) = C.iter().find(|&&(cell, _)| cell == mv_index) {
        return (
            LastMoveKind::C,
            (board_before.black | board_before.white) & (1u64 << corner) == 0,
        );
    }
    (LastMoveKind::Other, false)
}

/// 1対局分の着手列(`WthorGame::moves`と同じ座標系)を先頭から再生し、
/// 初手適用後の各局面について学習サンプルを生成する。
///
/// `wthor::replay`と同じ規則(まず黒番から開始、合法手がない側は自動的にパスして
/// 手番を飛ばす)で局面を進める。途中で非合法な着手や、両者とも合法手が無いのに
/// 着手が続くといった異常な手順が見つかった場合は`Err`を返す。
pub fn samples_from_game(moves: &[u8]) -> Result<Vec<Sample>, String> {
    let mut board = Board::initial();
    let mut side = Side::Black;
    // (着手直後の局面, 次に着手する側) を全ステップ分記録しておき、
    // 終局後にまとめて最終結果ラベルを付与する。
    let mut snapshots: Vec<(Board, Side, LastMoveKind, bool)> = Vec::with_capacity(moves.len());

    for (step, &mv_index) in moves.iter().enumerate() {
        if mv_index >= 64 {
            return Err(format!(
                "moves[{step}]: マスインデックスが範囲外です({mv_index})"
            ));
        }

        if !board.has_legal_move(side) {
            side = side.opposite();
        }
        if !board.has_legal_move(side) {
            return Err(format!(
                "moves[{step}]: 両者とも合法手が無い局面で着手が続いています(手順が異常)"
            ));
        }

        let mv_bit = 1u64 << mv_index;
        if board.legal_moves(side) & mv_bit == 0 {
            return Err(format!(
                "moves[{step}]: 非合法手です(side={side:?}, index={mv_index})"
            ));
        }

        let (last_move_kind, vulnerable_xc) = last_move_metadata(mv_index, &board);
        board = board.apply_move(side, mv_bit);
        side = side.opposite();

        // この着手直後に次に着手する側を決める(合法手が無ければパスして交代)。
        let mut next_mover = side;
        if !board.has_legal_move(next_mover) {
            next_mover = next_mover.opposite();
        }
        snapshots.push((board, next_mover, last_move_kind, vulnerable_xc));
    }

    let black_final = board.disc_count(Side::Black) as i32;
    let white_final = board.disc_count(Side::White) as i32;

    let samples = snapshots
        .into_iter()
        .map(|(board, mover, last_move_kind, vulnerable_xc)| {
            let outcome = match mover {
                Side::Black => black_final - white_final,
                Side::White => white_final - black_final,
            };
            Sample {
                board,
                mover,
                outcome: outcome as f32,
                last_move_kind,
                vulnerable_xc,
            }
        })
        .collect();

    Ok(samples)
}

/// 複数対局分の`WthorGame`から学習サンプルをまとめて集める。
/// 非合法な着手列など、`samples_from_game`が`Err`を返した対局はスキップする
/// (T040時点でWTHOR実データに非合法な着手列は見つかっていないが、防御的に扱う)。
pub fn collect_samples<'a>(games: impl IntoIterator<Item = &'a WthorGame>) -> Vec<Sample> {
    let mut all = Vec::new();
    for game in games {
        if let Ok(samples) = samples_from_game(&game.moves) {
            all.extend(samples);
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用: "d3"のような記法をビット位置(0..63)に変換する。
    fn notation_to_index(notation: &str) -> u8 {
        let bytes = notation.as_bytes();
        let file = bytes[0] - b'a';
        let rank = bytes[1] - b'1';
        rank * 8 + file
    }

    #[test]
    fn samples_from_game_produces_one_sample_per_move() {
        // WTH_2023.wtb先頭ゲームの冒頭手順(train/src/wthor.rsのテストで使用済みのもの)。
        let moves: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4", "f6", "f3", "g4", "g3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let samples = samples_from_game(&moves).expect("legal sequence should succeed");
        assert_eq!(samples.len(), moves.len());
    }

    #[test]
    fn samples_from_game_rejects_illegal_move() {
        let moves = vec![notation_to_index("a1")];
        assert!(samples_from_game(&moves).is_err());
    }

    #[test]
    fn outcome_is_symmetric_between_final_movers_perspective() {
        // 短い対局(4手)を再生し、各サンプルのoutcomeが「そのmover視点の最終石差」に
        // なっていることを検証する(黒視点と白視点で符号が逆になるはず)。
        let moves: Vec<u8> = ["f5", "f6", "e6", "f4"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let samples = samples_from_game(&moves).expect("legal sequence should succeed");

        // 最終局面の実際の黒石数・白石数を、最後のスナップショットのboardから確認する。
        let last_board = samples.last().unwrap().board;
        let black_final = last_board.disc_count(Side::Black) as i32;
        let white_final = last_board.disc_count(Side::White) as i32;

        for sample in &samples {
            let expected = match sample.mover {
                Side::Black => black_final - white_final,
                Side::White => white_final - black_final,
            };
            assert_eq!(sample.outcome as i32, expected);
        }
    }

    #[test]
    fn vulnerable_xc_requires_empty_corresponding_corner() {
        let empty = Board::initial();
        assert_eq!(last_move_metadata(9, &empty), (LastMoveKind::X, true));
        let occupied = Board { black: 1, white: 0 };
        assert_eq!(last_move_metadata(9, &occupied), (LastMoveKind::X, false));
        assert_eq!(last_move_metadata(1, &empty), (LastMoveKind::C, true));
        assert_eq!(last_move_metadata(20, &empty), (LastMoveKind::Other, false));
    }

    #[test]
    fn collect_samples_aggregates_across_games() {
        let moves_a: Vec<u8> = ["f5", "d6", "c3", "d3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let moves_b: Vec<u8> = ["f5", "f6"].iter().map(|n| notation_to_index(n)).collect();
        let games = vec![
            WthorGame {
                tournament_number: 0,
                black_player_number: 0,
                white_player_number: 0,
                black_disc_count: 0,
                theoretical_score: 0,
                moves: moves_a.clone(),
            },
            WthorGame {
                tournament_number: 0,
                black_player_number: 0,
                white_player_number: 0,
                black_disc_count: 0,
                theoretical_score: 0,
                moves: moves_b.clone(),
            },
        ];
        let samples = collect_samples(&games);
        assert_eq!(samples.len(), moves_a.len() + moves_b.len());
    }
}

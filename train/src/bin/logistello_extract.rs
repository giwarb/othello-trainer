//! T192: Logistello book(`logbook.wtb`、M. Buro、
//! `https://skatgame.net/mburo/log.html`)から、各ラインの**24空き時点**の
//! 局面を抽出するツール。
//!
//! # 背景
//!
//! Logistello bookは「全ライン24空きまでWLD検証済み」の自己対戦棋譜集(約3.7万ライン)。
//! WTHOR形式(`.wtb`)で配布されており、`train::wthor::parse`/`replay`で読める
//! (T192作業ログでバイト単位に確認済み: N1=37709, N2=0, P1=0(8x8), 本体長が
//! `N1*68`と一致)。
//!
//! 各ラインの`moves`は一手ごとに必ず1マスを埋める(パスはWTHOR形式では
//! 着手列に記録されず、暗黙に読み飛ばされる)ため、初期局面(空き60)から
//! ちょうど36手進めた時点で空きは必ず24になる
//! (`empties = 60 - 実際に打たれた手数`)。本ツールはこの不変量を使い、
//! `moves.len() >= 36`のラインについて先頭36手を再生して24空き局面を得る。
//!
//! # `theoretical_score`の意味(このツールの抽出とは独立に、実データで確認済み)
//!
//! 全37709ラインで`theoretical_score == black_disc_count`(完全一致)。
//! つまりこのbookでは「理論スコア」は「黒の最終石数(0..64)」と同じ値であり、
//! 全ラインが24空き以降を最適に打ち切られた実戦譜であることを示す
//! (作業ログ参照)。24空き局面での完全読みスコア(手番視点、石差)への
//! 変換は本ツールでは行わず、`bench/logistello/select_sample.py`が
//! サンプリング時に付与する。
//!
//! # 重複除去
//!
//! 「素の盤面(64マス文字列)+手番」が完全一致するものを重複とみなし、
//! 初出のみを残す(D4正規化はしない)。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin logistello_extract -- \
//!   --input bench/logistello/data/logbook.wtb \
//!   --out bench/logistello/data/logistello_24empty_positions.json
//! ```

use std::collections::HashSet;
use std::env;
use std::fs;
use std::process::ExitCode;

use engine::bitboard::{Board, Side};
use serde_json::json;
use train::wthor;

/// 24空きに達するまでに必要な着手数(初期局面の空き60 - 24 = 36)。
const MOVES_TO_24_EMPTY: usize = 36;
const TARGET_EMPTY_COUNT: u32 = 24;

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// `engine::bitboard::Board`をeval_cli/t096系JSONと同じ表記
/// (盤面インデックス順にX=黒/O=白/-=空)に変換する。
fn board_to_obf(b: &Board) -> String {
    let mut s = String::with_capacity(64);
    for i in 0..64u32 {
        let bit = 1u64 << i;
        if b.black & bit != 0 {
            s.push('X');
        } else if b.white & bit != 0 {
            s.push('O');
        } else {
            s.push('-');
        }
    }
    s
}

fn side_name(s: Side) -> &'static str {
    match s {
        Side::Black => "black",
        Side::White => "white",
    }
}

/// 失敗理由。`wthor::replay`と同じ合法性チェックをしつつ、指定した手数だけ
/// 進めた時点の`(Board, 次の手番)`を返す。
///
/// `wthor::replay`は最終盤面のみを返し、手番を捨ててしまうため
/// (このツールは`moves[..36]`の続き=37手目の手番を知る必要がある)、
/// 同じロジックをここに複製する(`train/src/wthor.rs`本体は変更しない)。
fn replay_prefix(moves: &[u8], take: usize) -> Result<(Board, Side), String> {
    let mut board = Board::initial();
    let mut side = Side::Black;

    for (step, &mv_index) in moves.iter().take(take).enumerate() {
        if mv_index >= 64 {
            return Err(format!("moves[{step}]: マスインデックスが範囲外です({mv_index})"));
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
            return Err(format!("moves[{step}]: 非合法手です(side={side:?}, index={mv_index})"));
        }
        board = board.apply_move(side, mv_bit);
        side = side.opposite();
    }

    // `side`は直前の着手を打った側の相手(次に打つはずの側)。ただしその側に
    // 合法手が無ければ自動パスでもう一方に回る(wthor::replayのループ先頭と
    // 同じチェックを、ループを抜けた後にもう一度行う)。
    if !board.has_legal_move(side) {
        side = side.opposite();
    }
    if !board.has_legal_move(side) {
        return Err("両者とも合法手が無く、次の手番を決定できません".to_string());
    }

    Ok((board, side))
}

struct Stats {
    total_games: usize,
    skipped_too_short: usize,
    skipped_replay_error: usize,
    skipped_wrong_empty_count: usize,
    duplicates_removed: usize,
    extracted_unique: usize,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let input_path = match get_arg(&args, "--input") {
        Some(p) => p,
        None => {
            eprintln!("usage: logistello_extract --input <logbook.wtb> --out <output.json>");
            return ExitCode::FAILURE;
        }
    };
    let out_path = get_arg(&args, "--out")
        .unwrap_or_else(|| "bench/logistello/data/logistello_24empty_positions.json".to_string());

    let bytes = match fs::read(&input_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("failed to read --input {input_path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!("[logistello_extract] read {} bytes from {input_path}", bytes.len());

    let parsed = match wthor::parse(&bytes) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("failed to parse {input_path} as WTHOR (.wtb): {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "[logistello_extract] parsed header: num_games={} board_size={} game_type={} depth={} year={}",
        parsed.header.num_games,
        parsed.header.board_size,
        parsed.header.game_type,
        parsed.header.depth,
        parsed.header.year_of_games,
    );

    let mut stats = Stats {
        total_games: parsed.games.len(),
        skipped_too_short: 0,
        skipped_replay_error: 0,
        skipped_wrong_empty_count: 0,
        duplicates_removed: 0,
        extracted_unique: 0,
    };

    let mut seen: HashSet<(String, &'static str)> = HashSet::new();
    let mut positions = Vec::new();

    for (line_index, game) in parsed.games.iter().enumerate() {
        if game.moves.len() < MOVES_TO_24_EMPTY {
            stats.skipped_too_short += 1;
            continue;
        }
        let (board, side) = match replay_prefix(&game.moves, MOVES_TO_24_EMPTY) {
            Ok(v) => v,
            Err(e) => {
                stats.skipped_replay_error += 1;
                eprintln!("[logistello_extract] line {line_index}: replay error: {e}");
                continue;
            }
        };
        if board.empty_count() != TARGET_EMPTY_COUNT {
            // 各着手はちょうど1マスを埋めるはずなので、この不変量が破れることは
            // 理論上ないはずだが、データ異常への防御として明示的にスキップする。
            stats.skipped_wrong_empty_count += 1;
            eprintln!(
                "[logistello_extract] line {line_index}: 36手再生後の空きが24でない({})",
                board.empty_count()
            );
            continue;
        }

        let board_str = board_to_obf(&board);
        let side_str = side_name(side);
        let key = (board_str.clone(), side_str);
        if !seen.insert(key) {
            stats.duplicates_removed += 1;
            continue;
        }

        positions.push(json!({
            "lineIndex": line_index,
            "board": board_str,
            "side_to_move": side_str,
            "empties": TARGET_EMPTY_COUNT,
            "theoreticalScore": game.theoretical_score,
            "blackDiscCountAtGameEnd": game.black_disc_count,
            "fullGameMoveCount": game.moves.len(),
        }));
        stats.extracted_unique += 1;

        if stats.extracted_unique % 5000 == 0 {
            eprintln!(
                "[logistello_extract] progress: {} lines scanned, {} unique positions extracted",
                line_index + 1,
                stats.extracted_unique
            );
        }
    }

    let doc = json!({
        "schemaVersion": 1,
        "$schemaNote": "T192: Logistello book(logbook.wtb)の全ラインから24空き時点の局面を抽出した全件データ。学習データではなく検証資産の元データ(生成物はコミットしない、.gitignore対象)。",
        "source": {
            "inputPath": input_path,
            "sourceUrl": "https://skatgame.net/mburo/logbook.wtb.gz",
            "license": "GPL (Michael Buro, https://skatgame.net/mburo/log.html)",
        },
        "wthorHeader": {
            "numGames": parsed.header.num_games,
            "numRecordsN2": parsed.header.num_records_n2,
            "yearOfGames": parsed.header.year_of_games,
            "boardSize": parsed.header.board_size,
            "gameType": parsed.header.game_type,
            "depth": parsed.header.depth,
        },
        "stats": {
            "totalGames": stats.total_games,
            "skippedTooShort": stats.skipped_too_short,
            "skippedReplayError": stats.skipped_replay_error,
            "skippedWrongEmptyCount": stats.skipped_wrong_empty_count,
            "duplicatesRemoved": stats.duplicates_removed,
            "extractedUnique": stats.extracted_unique,
        },
        "positions": positions,
    });

    if let Some(parent) = std::path::Path::new(&out_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("failed to create output directory {}: {e}", parent.display());
                return ExitCode::FAILURE;
            }
        }
    }
    let serialized = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());
    if let Err(e) = fs::write(&out_path, serialized) {
        eprintln!("failed to write {out_path}: {e}");
        return ExitCode::FAILURE;
    }

    eprintln!(
        "[logistello_extract] done: total_games={} extracted_unique={} skipped_too_short={} skipped_replay_error={} skipped_wrong_empty_count={} duplicates_removed={} -> wrote {out_path}",
        stats.total_games,
        stats.extracted_unique,
        stats.skipped_too_short,
        stats.skipped_replay_error,
        stats.skipped_wrong_empty_count,
        stats.duplicates_removed,
    );

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_prefix_matches_wthor_replay_on_full_known_legal_sequence() {
        // train/src/wthor.rsのテストと同じ既知合法手順(f5 d6 c3 d3 c4 f4 f6 f3 g4 g3)。
        let moves: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4", "f6", "f3", "g4", "g3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let (board, _side) = replay_prefix(&moves, moves.len()).expect("should replay");
        let expected = wthor::replay(&moves).expect("wthor::replay should also accept it");
        assert_eq!(board, expected);
    }

    #[test]
    fn replay_prefix_partial_take_reaches_expected_empty_count() {
        let moves: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4", "f6", "f3", "g4", "g3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let (board, _side) = replay_prefix(&moves, 4).expect("should replay 4 moves");
        // 初期局面(空き60)から4手進めたので空きは56。
        assert_eq!(board.empty_count(), 60 - 4);
    }

    #[test]
    fn replay_prefix_rejects_illegal_move() {
        let moves = vec![notation_to_index("a1")];
        assert!(replay_prefix(&moves, 1).is_err());
    }

    #[test]
    fn board_to_obf_roundtrips_initial_board() {
        let board = Board::initial();
        let s = board_to_obf(&board);
        assert_eq!(s.len(), 64);
        assert_eq!(s.chars().filter(|&c| c == 'X').count(), 2);
        assert_eq!(s.chars().filter(|&c| c == 'O').count(), 2);
        assert_eq!(s.chars().filter(|&c| c == '-').count(), 60);
    }

    fn notation_to_index(notation: &str) -> u8 {
        let bytes = notation.as_bytes();
        let file = bytes[0] - b'a';
        let rank = bytes[1] - b'1';
        rank * 8 + file
    }
}

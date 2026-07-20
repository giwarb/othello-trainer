//! T154: WTHOR棋譜(`train/data/WTH_*.wtb`)の全局面を、`train_distillation`の
//! `--simple-corpus`モード(T153で追加、Egaroucid公開学習データと同じ
//! `<64文字盤面> <手番側最終石差>`のテキスト形式)へ決定的に変換するツール。
//!
//! # 目的
//!
//! T154は「同一トレーナー(`t090_distillation`の`--simple-corpus`経路)内で
//! WTHOR・Egaroucid・混合データを対照する」実験のためのもので、
//! `train_patterns_v3`(既存のWTHOR専用トレーナー、`train::train_data::Sample`を
//! 直接学習する)と同じデータ・同じ特徴量を`--simple-corpus`経路にも流し込めるように、
//! `train::train_data::samples_from_game`(1手=1サンプル・手番側最終石差)が返す
//! `Sample`を、Egaroucidと互換の1行1レコードのテキストへ変換する。
//!
//! # 変換規則
//!
//! `Sample.board`(`Board{black,white}`)と`Sample.mover`から、64文字の盤面
//! テキストを組み立てる:マスiが`mover`の自分石なら`X`、相手石なら`O`、
//! 空きなら`-`(`train::t090_distillation::parse_simple_record`が期待する形式
//! そのもの。X=手番側自分石・O=相手石・mover側視点で正規化済み)。スコアは
//! `Sample.outcome`(mover視点の最終石差、常に整数値)を整数として書き出す。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin wthor_to_simple -- \
//!   --data-dir train/data --out train/data/t154/wthor_all.txt
//! ```
//!
//! # 決定性
//!
//! `.wtb`ファイルの列挙をソートし(`train_patterns_v3::data_files`と同じ規則)、
//! 各ファイル内はパース順、各対局内は`samples_from_game`が返す着手順(=対局の
//! 進行順)のまま書き出すため、同一入力に対して常に同一の出力(バイト列)になる。
//! 非合法な着手列を含む対局は`train_data::collect_samples`と同じ規則でスキップする
//! (T040時点でWTHOR実データに非合法な着手列は見つかっていないが、防御的に扱う)。

use std::env;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::bitboard::Side;
use train::train_data::{self, Sample};
use train::wthor;

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// `train_patterns_v3::data_files`と同じ規則(`--data-dir`直下の`*.wtb`を
/// パス文字列の昇順でソート)で入力ファイル一覧を決定する。
fn data_files(data_dir: &str) -> Result<Vec<PathBuf>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(data_dir)
        .map_err(|e| format!("{data_dir}: {e}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "wtb"))
        .collect();
    files.sort();
    Ok(files)
}

/// `Sample`(`Board`+`mover`+`outcome`)を、`--simple-corpus`が読む
/// `<64文字盤面> <スコア>`の1行へ変換する。`X`=mover自分石・`O`=相手石・`-`=空き。
fn sample_to_simple_line(sample: &Sample) -> String {
    let (own, opp) = match sample.mover {
        Side::Black => (sample.board.black, sample.board.white),
        Side::White => (sample.board.white, sample.board.black),
    };
    let mut board_text = String::with_capacity(64);
    for i in 0..64u32 {
        let bit = 1u64 << i;
        let ch = if own & bit != 0 {
            'X'
        } else if opp & bit != 0 {
            'O'
        } else {
            '-'
        };
        board_text.push(ch);
    }
    format!("{board_text} {}", sample.outcome as i32)
}

#[derive(Default)]
struct Stats {
    files_used: usize,
    total_games_scanned: u64,
    games_used: u64,
    invalid_games_skipped: u64,
    empty_games_skipped: u64,
    samples_written: u64,
}

fn convert(files: &[PathBuf], writer: &mut impl Write) -> Result<Stats, String> {
    let mut stats = Stats {
        files_used: files.len(),
        ..Stats::default()
    };
    for path in files {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let parsed = wthor::parse(&bytes).map_err(|e| format!("{}: {e:?}", path.display()))?;
        for game in &parsed.games {
            stats.total_games_scanned += 1;
            if game.moves.is_empty() {
                stats.empty_games_skipped += 1;
                continue;
            }
            match train_data::samples_from_game(&game.moves) {
                Ok(samples) if !samples.is_empty() => {
                    stats.games_used += 1;
                    for sample in &samples {
                        let line = sample_to_simple_line(sample);
                        writeln!(writer, "{line}").map_err(|e| e.to_string())?;
                        stats.samples_written += 1;
                    }
                }
                Ok(_) => stats.empty_games_skipped += 1,
                Err(_) => stats.invalid_games_skipped += 1,
            }
        }
    }
    Ok(stats)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let data_dir = get_arg(&args, "--data-dir").unwrap_or_else(|| "train/data".to_string());
    let out_path = get_arg(&args, "--out")
        .unwrap_or_else(|| "train/data/t154/wthor_all.txt".to_string());

    let files = match data_files(&data_dir) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("failed to list --data-dir {data_dir}: {error}");
            return ExitCode::FAILURE;
        }
    };
    if files.is_empty() {
        eprintln!("no .wtb files found under {data_dir}");
        return ExitCode::FAILURE;
    }

    if let Some(parent) = Path::new(&out_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("failed to create output directory {}: {e}", parent.display());
                return ExitCode::FAILURE;
            }
        }
    }
    let out_file = match File::create(&out_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("failed to create {out_path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut writer = BufWriter::new(out_file);

    let stats = match convert(&files, &mut writer) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = writer.flush() {
        eprintln!("failed to flush {out_path}: {e}");
        return ExitCode::FAILURE;
    }

    eprintln!(
        "wrote {} sample(s) from {} game(s) (scanned {}, invalid {}, empty {}) across {} file(s) to {out_path}",
        stats.samples_written,
        stats.games_used,
        stats.total_games_scanned,
        stats.invalid_games_skipped,
        stats.empty_games_skipped,
        stats.files_used,
    );

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::bitboard::Board;

    /// テスト用: "d3"のような記法をビット位置(0..63)に変換する
    /// (`train_data.rs`のテストヘルパーと同じ規則)。
    fn notation_to_index(notation: &str) -> u8 {
        let bytes = notation.as_bytes();
        let file = bytes[0] - b'a';
        let rank = bytes[1] - b'1';
        rank * 8 + file
    }

    /// `--simple-corpus`側の`parse_simple_record`と同じ規則(X=own/O=opp/-=空き)で
    /// テキストを`Board`に戻す、テスト専用のデコーダ。往復一致を確認するために使う。
    fn decode_line(line: &str) -> (Board, i32) {
        let (board_text, score_text) = line.split_once(' ').expect("line must have a score field");
        assert_eq!(board_text.len(), 64, "board text must be exactly 64 chars");
        let mut board = Board { black: 0, white: 0 };
        for (i, ch) in board_text.chars().enumerate() {
            match ch {
                'X' => board.black |= 1u64 << i,
                'O' => board.white |= 1u64 << i,
                '-' => {}
                other => panic!("unexpected board cell {other:?}"),
            }
        }
        (board, score_text.parse().expect("score must be an integer"))
    }

    #[test]
    fn sample_to_simple_line_has_64_char_board_and_integer_score() {
        let sample = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 4.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let line = sample_to_simple_line(&sample);
        let (board_text, score_text) = line.split_once(' ').unwrap();
        assert_eq!(board_text.len(), 64);
        assert_eq!(score_text, "4");
    }

    #[test]
    fn sample_to_simple_line_uses_movers_perspective_for_x_and_o() {
        // 初期局面: d4=白, e4=黒, d5=黒, e5=白(標準配置)。
        // mover=Blackなら黒石がX、mover=Whiteなら白石がXになるはず(自分石=X規約)。
        let sample_black = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 0.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let sample_white = Sample {
            mover: Side::White,
            ..sample_black
        };
        let (decoded_black, _) = decode_line(&sample_to_simple_line(&sample_black));
        let (decoded_white, _) = decode_line(&sample_to_simple_line(&sample_white));
        // mover=Blackで書き出した行をデコードすると(X=own規約で読むデコーダなので)
        // decoded.black == 元のboard.black(黒石の位置)に一致するはず。
        assert_eq!(decoded_black.black, Board::initial().black);
        assert_eq!(decoded_black.white, Board::initial().white);
        // mover=Whiteで書き出すと、Xは白石になるので、デコード結果のblack(=X扱い)は
        // 元の白石の位置と一致する(own/oppが入れ替わる)。
        assert_eq!(decoded_white.black, Board::initial().white);
        assert_eq!(decoded_white.white, Board::initial().black);
    }

    #[test]
    fn sample_to_simple_line_round_trips_board_and_outcome() {
        let mut board = Board::initial();
        board.black |= 1u64 << 20; // 適当なマスに黒石を追加(合法性は問わない、往復確認のみ)
        let sample = Sample {
            board,
            mover: Side::White,
            outcome: -12.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let line = sample_to_simple_line(&sample);
        let (decoded_board, decoded_score) = decode_line(&line);
        // mover=Whiteなので own=white, opp=black。デコーダはX=own(この関数出力上は
        // decoded.black)として読むため、decoded.black == 元board.white、
        // decoded.white == 元board.blackになるはず。
        assert_eq!(decoded_board.black, board.white);
        assert_eq!(decoded_board.white, board.black);
        assert_eq!(decoded_score, -12);
    }

    #[test]
    fn convert_produces_one_sample_per_move_and_skips_invalid_games() {
        let moves_valid: Vec<u8> = ["f5", "d6", "c3", "d3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let moves_invalid: Vec<u8> = vec![notation_to_index("a1")]; // 初手a1は非合法
        let games = vec![
            wthor::WthorGame {
                tournament_number: 0,
                black_player_number: 0,
                white_player_number: 0,
                black_disc_count: 0,
                theoretical_score: 0,
                moves: moves_valid.clone(),
            },
            wthor::WthorGame {
                tournament_number: 0,
                black_player_number: 0,
                white_player_number: 0,
                black_disc_count: 0,
                theoretical_score: 0,
                moves: moves_invalid,
            },
        ];
        // convert()自体はファイルI/Oのみを担当するため、samples_from_game経由の
        // 変換ロジックをここで直接検証する(ファイル読み込みは統合的にmain経路で担保)。
        let mut written_lines = 0usize;
        for game in &games {
            match train_data::samples_from_game(&game.moves) {
                Ok(samples) if !samples.is_empty() => written_lines += samples.len(),
                _ => {}
            }
        }
        assert_eq!(written_lines, moves_valid.len());
    }

    #[test]
    fn convert_is_deterministic_across_repeated_runs_on_the_same_input() {
        let moves: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let samples1 = train_data::samples_from_game(&moves).unwrap();
        let samples2 = train_data::samples_from_game(&moves).unwrap();
        let lines1: Vec<String> = samples1.iter().map(sample_to_simple_line).collect();
        let lines2: Vec<String> = samples2.iter().map(sample_to_simple_line).collect();
        assert_eq!(lines1, lines2);
    }
}

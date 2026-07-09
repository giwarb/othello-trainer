//! WTHOR棋譜データ(`.wtb`)を読み込み、パース結果のサマリを表示するCLI。
//!
//! 使い方:
//! ```text
//! cargo run -p train -- <WTHORファイル(.wtb)へのパス> [<さらに別のファイル>...]
//! ```
//!
//! 各ファイルについてヘッダ情報(対象年・局数など)を表示し、全ゲームの着手列を
//! `engine::bitboard`の合法手判定で先頭から再生して、非合法な着手が含まれていないかを
//! 検証する。最後に総ゲーム数・総手数・不正な着手列を含むゲーム数のサマリを表示する。

use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use train::wthor;

fn main() -> ExitCode {
    let paths: Vec<String> = env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("使い方: cargo run -p train -- <WTHORファイル(.wtb)へのパス>...");
        return ExitCode::FAILURE;
    }

    let mut total_games: u64 = 0;
    let mut total_moves: u64 = 0;
    let mut illegal_games: u64 = 0;
    let mut file_errors: u64 = 0;
    let mut samples_printed: u32 = 0;

    for path_str in &paths {
        let path = Path::new(path_str);
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("読み込み失敗: {} ({e})", path.display());
                file_errors += 1;
                continue;
            }
        };

        let file = match wthor::parse(&bytes) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("パース失敗: {} ({e})", path.display());
                file_errors += 1;
                continue;
            }
        };

        println!(
            "{}: 対象年={} 局数(N1)={} 盤サイズP1={} 深さP3={}",
            path.display(),
            file.header.year_of_games,
            file.header.num_games,
            file.header.board_size,
            file.header.depth
        );

        for (i, game) in file.games.iter().enumerate() {
            total_games += 1;
            total_moves += game.moves.len() as u64;

            if let Err(msg) = wthor::replay(&game.moves) {
                illegal_games += 1;
                eprintln!("  [{}] ゲーム#{}: 不正な着手列: {msg}", path.display(), i);
            }

            if samples_printed < 3 {
                let notation: String = game
                    .moves
                    .iter()
                    .map(|&idx| wthor::index_to_notation(idx))
                    .collect();
                println!(
                    "  サンプル手順 #{i} (黒石数={}, 理論スコア={}): {notation}",
                    game.black_disc_count, game.theoretical_score
                );
                samples_printed += 1;
            }
        }
    }

    println!("=== サマリ ===");
    println!("総ゲーム数: {total_games}");
    println!("総手数: {total_moves}");
    if total_games > 0 {
        println!(
            "平均手数/ゲーム: {:.1}",
            total_moves as f64 / total_games as f64
        );
    }
    println!("不正な着手列を含むゲーム数: {illegal_games}");
    println!("ファイル読み込み/パース失敗数: {file_errors}");

    if file_errors > 0 || illegal_games > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

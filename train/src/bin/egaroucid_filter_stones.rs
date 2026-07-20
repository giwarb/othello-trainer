//! T154: Egaroucid公開学習データ(`train/data/egaroucid/extracted/.../*.txt`、
//! `<64文字盤面> <スコア>`形式、T153で導入)から、石数(盤面上のX/O合計、
//! 空きマス以外の総数)が`--max-stones`以下の行だけを決定的に抽出する。
//!
//! # 目的
//!
//! T154のRun C(混合データ)は「WTHOR全量 + Egaroucidの石数15以下全量
//! (lv17網羅ラベルが確実な部分、README記載: 4〜15石の局面はEgaroucid console
//! 7.4.0レベル17のnegamax完全探索、16石以上は自己対戦の最終結果ラベル)」を
//! 連結して作る。本ツールはその「石数15以下全量」の部分を抽出する。
//!
//! # 抽出規則
//!
//! 各行を`<board> <score>`として読み、`board`(64文字、`X`/`O`/`-`)のうち
//! `X`または`O`の総数(=盤面上の石数)を数える。`--max-stones`(既定15)以下
//! なら行をそのまま(改変なし)出力へ書き出す。`--simple-corpus`が読む形式を
//! 一切変更しないため、出力ファイルはそのまま`--simple-corpus`の入力にできる。
//!
//! # 決定性
//!
//! 入力ディレクトリの`*.txt`をファイル名の昇順で列挙し(T153の
//! `list_simple_corpus_files`と同じ規則)、各ファイル内は行の出現順のまま
//! フィルタするため、同一入力に対して常に同一の出力(バイト列・行順とも)になる。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin egaroucid_filter_stones -- \
//!   --in-dir train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 \
//!   --out train/data/t154/egaroucid_le15.txt --max-stones 15
//! ```

use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// `--in-dir`直下の`*.txt`をファイル名の昇順で列挙する
/// (T153の`list_simple_corpus_files`と同じ規則)。
fn list_txt_files(dir: &str) -> Result<Vec<PathBuf>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("{dir}: {e}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    files.sort();
    Ok(files)
}

/// `<64文字盤面> <スコア>`の1行から盤面上の石数(`X`+`O`の総数)を数える。
/// 形式が壊れている行(スコア区切りの空白がない、盤面が64文字でない)は
/// `None`を返す(呼び出し側でスキップ扱いにする)。
fn stone_count(line: &str) -> Option<usize> {
    let (board_text, _score_text) = line.split_once(' ')?;
    if board_text.len() != 64 {
        return None;
    }
    Some(board_text.bytes().filter(|&b| b == b'X' || b == b'O').count())
}

#[derive(Default)]
struct Stats {
    files_used: usize,
    total_lines: u64,
    malformed_lines_skipped: u64,
    matched_lines: u64,
    stone_histogram: BTreeMap<usize, u64>,
}

fn filter(files: &[PathBuf], max_stones: usize, writer: &mut impl Write) -> Result<Stats, String> {
    let mut stats = Stats {
        files_used: files.len(),
        ..Stats::default()
    };
    for path in files {
        let handle = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        for line in BufReader::new(handle).lines() {
            let line = line.map_err(|e| format!("{}: {e}", path.display()))?;
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            stats.total_lines += 1;
            match stone_count(trimmed) {
                Some(count) => {
                    if count <= max_stones {
                        writeln!(writer, "{trimmed}").map_err(|e| e.to_string())?;
                        stats.matched_lines += 1;
                        *stats.stone_histogram.entry(count).or_insert(0) += 1;
                    }
                }
                None => stats.malformed_lines_skipped += 1,
            }
        }
    }
    Ok(stats)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let in_dir = get_arg(&args, "--in-dir").unwrap_or_else(|| {
        "train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17".to_string()
    });
    let out_path =
        get_arg(&args, "--out").unwrap_or_else(|| "train/data/t154/egaroucid_le15.txt".to_string());
    let max_stones: usize = match get_arg(&args, "--max-stones") {
        Some(value) => match value.parse() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("invalid --max-stones: {e}");
                return ExitCode::FAILURE;
            }
        },
        None => 15,
    };

    let files = match list_txt_files(&in_dir) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("failed to list --in-dir {in_dir}: {error}");
            return ExitCode::FAILURE;
        }
    };
    if files.is_empty() {
        eprintln!("no .txt files found under {in_dir}");
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

    let stats = match filter(&files, max_stones, &mut writer) {
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
        "wrote {} line(s) with stones<={max_stones} (scanned {}, malformed {}) across {} file(s) to {out_path}",
        stats.matched_lines, stats.total_lines, stats.malformed_lines_skipped, stats.files_used,
    );
    eprint!("stone_histogram=");
    for (stones, count) in &stats.stone_histogram {
        eprint!("{stones}:{count},");
    }
    eprintln!();

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stone_count_counts_x_and_o_only() {
        let board = "X".repeat(4) + &"O".repeat(3) + &"-".repeat(57);
        let line = format!("{board} 5");
        assert_eq!(stone_count(&line), Some(7));
    }

    #[test]
    fn stone_count_rejects_missing_score_or_wrong_length() {
        assert_eq!(stone_count("no-score-field"), None);
        let short_board = "X".repeat(10) + " 1"; // 10文字しかない盤面
        assert_eq!(stone_count(&short_board), None);
    }

    #[test]
    fn filter_keeps_only_lines_at_or_below_max_stones_and_preserves_order() {
        let four = "-".repeat(60) + "XXOO"; // 4石
        let sixteen = "X".repeat(8) + &"O".repeat(8) + &"-".repeat(48); // 16石
        let lines = format!("{four} 0\n{sixteen} 1\n{four} 2\n");
        let dir = env::temp_dir().join(format!(
            "t154-egaroucid-filter-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("0000000.txt");
        fs::write(&file_path, lines).unwrap();

        let files = list_txt_files(dir.to_str().unwrap()).unwrap();
        let mut out: Vec<u8> = Vec::new();
        let stats = filter(&files, 15, &mut out).unwrap();
        let out_text = String::from_utf8(out).unwrap();
        let out_lines: Vec<&str> = out_text.lines().collect();

        assert_eq!(stats.total_lines, 3);
        assert_eq!(stats.matched_lines, 2);
        assert_eq!(out_lines.len(), 2);
        assert!(out_lines[0].starts_with(&four));
        assert!(out_lines[1].starts_with(&four));
        assert_eq!(stats.stone_histogram.get(&4), Some(&2));
        assert_eq!(stats.stone_histogram.get(&16), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn filter_is_deterministic_across_files_sorted_by_name() {
        let dir = env::temp_dir().join(format!(
            "t154-egaroucid-filter-order-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let board_a = "-".repeat(60) + "XXOO";
        let board_b = "-".repeat(59) + "XXXOO";
        fs::write(dir.join("0000001.txt"), format!("{board_b} 1\n")).unwrap();
        fs::write(dir.join("0000000.txt"), format!("{board_a} 0\n")).unwrap();

        let files = list_txt_files(dir.to_str().unwrap()).unwrap();
        assert!(files[0].ends_with("0000000.txt"));
        assert!(files[1].ends_with("0000001.txt"));

        let mut out: Vec<u8> = Vec::new();
        let stats = filter(&files, 15, &mut out).unwrap();
        assert_eq!(stats.matched_lines, 2);
        let out_text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = out_text.lines().collect();
        assert!(lines[0].starts_with(&board_a));
        assert!(lines[1].starts_with(&board_b));

        fs::remove_dir_all(&dir).ok();
    }
}

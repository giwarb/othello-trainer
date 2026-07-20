//! T155: 簡易レコード(64文字盤面+スコア)コーパスの読み込み。
//!
//! `t090_distillation.rs`の`--simple-corpus`(T153で追加)と同じテキスト形式
//! (`<64文字盤面> <スコア>`、1行1レコード。`X`=手番側own/`O`=相手opponent/
//! `-`=空き)を読むが、`train_patterns_v3`(本番トレーナー)が直接使う
//! `train_data::Sample`を生成する、完全に独立した実装。`t090_distillation.rs`側の
//! `SimpleRecord`・`parse_simple_record`・`load_simple_corpus`等の既存コードには
//! 一切触れない(T155要件: `train_patterns_v3`の既定WTHOR学習経路を完全に不変に
//! 保つため。このモジュールは`--simple-corpus`が指定されたときにのみ使われる)。

use std::fs;
use std::path::{Path, PathBuf};

use engine::bitboard::{Board, Side};

use crate::experiment;
use crate::train_data::{LastMoveKind, Sample};

fn fnv_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn parse_board(text: &str) -> Result<Board, String> {
    if text.len() != 64 {
        return Err(format!(
            "board must contain 64 ASCII cells, got {}",
            text.len()
        ));
    }
    let mut board = Board { black: 0, white: 0 };
    for (i, byte) in text.bytes().enumerate() {
        match byte {
            b'X' => board.black |= 1u64 << i,
            b'O' => board.white |= 1u64 << i,
            b'-' => {}
            _ => return Err(format!("invalid board cell at {i}: {}", byte as char)),
        }
    }
    Ok(board)
}

/// 1行(`<64文字盤面> <スコア>`)を`Sample`へ変換する。`mover`は常に`Side::Black`
/// 固定とする: `X`=own視点で盤面が書かれているため、そのまま`black`ビットへ
/// マップしても`pattern_state_index`が内部でown/opponentへ正規化する
/// (`engine::patterns`のcell_trit)ので、実際の手番色が黒か白かは評価上問題に
/// ならない(`t090_distillation::parse_simple_record`と同じ規約)。
/// `last_move_kind`/`vulnerable_xc`は簡易レコードに情報が無いため既定値
/// (`Other`/`false`)とする。
pub fn parse_simple_line(line: &str) -> Result<Sample, String> {
    let (board_text, score_text) = line
        .split_once(' ')
        .ok_or_else(|| format!("missing score field: {line}"))?;
    let board = parse_board(board_text)?;
    let outcome: f32 = score_text
        .trim()
        .parse()
        .map_err(|_| format!("invalid score {score_text:?}"))?;
    Ok(Sample {
        board,
        mover: Side::Black,
        outcome,
        last_move_kind: LastMoveKind::Other,
        vulnerable_xc: false,
    })
}

/// `path`がディレクトリなら直下の`*.txt`をファイル名でソートして列挙し
/// (Egaroucid配布物の`0000000.txt`..`0000025.txt`のような複数ファイル構成を
/// 1本の決定的なストリームとして扱うため)、ファイルならそれ単体を返す。
pub fn list_simple_corpus_files(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.is_dir() {
        let mut files: Vec<PathBuf> = fs::read_dir(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .flatten()
            .map(|entry| entry.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "txt"))
            .collect();
        files.sort();
        if files.is_empty() {
            return Err(format!("no .txt files found in {}", path.display()));
        }
        Ok(files)
    } else {
        Ok(vec![path.to_path_buf()])
    }
}

fn xorshift_next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

/// `files`を1本の決定的なストリームとして順に読み、`max_records`が`Some(k)`なら
/// Algorithm R(reservoir sampling)で`min(合計行数, k)`件を決定的に抽出する。
/// `None`なら全件を読み込む。空行はスキップする。
///
/// 内容ハッシュ(戻り値の2番目)は採否に関わらず全行の生バイトから計算するため、
/// `max_records`の値によらず同一入力ファイル集合なら同じ値になる
/// (resume identityの安定性のため)。採用されなかった行は盤面パースをスキップする
/// (数千万行規模でも実際にパースするのは`max_records`件程度で済む)。
pub fn load_simple_corpus(
    files: &[PathBuf],
    max_records: Option<usize>,
    reservoir_seed: u64,
) -> Result<(Vec<Sample>, String, usize), String> {
    use std::io::BufRead;
    let mut hash = 0xcbf29ce484222325u64;
    let mut total_lines = 0usize;
    let mut state = reservoir_seed.max(1);
    let mut reservoir: Vec<Sample> = Vec::with_capacity(max_records.unwrap_or(0));
    for file in files {
        let handle = fs::File::open(file).map_err(|e| format!("{}: {e}", file.display()))?;
        for line in std::io::BufReader::new(handle).lines() {
            let line = line.map_err(|e| format!("{}: {e}", file.display()))?;
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            hash = fnv_update(hash, trimmed.as_bytes());
            match max_records {
                None => reservoir.push(parse_simple_line(trimmed)?),
                Some(k) => {
                    if total_lines < k {
                        reservoir.push(parse_simple_line(trimmed)?);
                    } else {
                        let slot = (xorshift_next(&mut state) % (total_lines as u64 + 1)) as usize;
                        if slot < k {
                            reservoir[slot] = parse_simple_line(trimmed)?;
                        }
                    }
                }
            }
            total_lines += 1;
        }
    }
    Ok((reservoir, format!("{hash:016x}"), total_lines))
}

/// 局面のD4正規化canonicalKey(`experiment::canonicalize`)のfnv1aハッシュで、
/// 簡易コーパスをtrain/frozenへ決定的に分割する(T155要件: 簡易レコードには
/// 対局概念が無いため、`train_patterns_v3`の既定経路が使う「対局単位の末尾10%を
/// frozenにする」方式は使えず、局面ハッシュ分割を使う)。
/// `fnv1a(canonicalKey) % 10 == 9`をfrozen(約10%)、それ以外をtrainとする。
/// canonical化するのは、盤面の回転・鏡映違いの同一局面が train と frozen に
/// 分かれてしまう(実質的なリーク)ことを防ぐため。
pub fn split_by_position_hash(records: Vec<Sample>) -> (Vec<Sample>, Vec<Sample>) {
    let mut train = Vec::with_capacity(records.len());
    let mut frozen = Vec::new();
    for sample in records {
        let (key, _) = experiment::canonicalize(&sample);
        let mut hash = 0xcbf29ce484222325u64;
        hash = fnv_update(hash, &key.0.to_le_bytes());
        hash = fnv_update(hash, &key.1.to_le_bytes());
        hash = fnv_update(hash, &[key.2]);
        if hash % 10 == 9 {
            frozen.push(sample);
        } else {
            train.push(sample);
        }
    }
    (train, frozen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "othello-trainer-simple-corpus-test-{name}-{}-{}",
            std::process::id(),
            name.len()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_simple_line_decodes_board_and_score() {
        let line = format!("{} 4", "X".repeat(4) + &"O".repeat(4) + &"-".repeat(56));
        let sample = parse_simple_line(&line).unwrap();
        assert_eq!(sample.board.black, 0b1111);
        assert_eq!(sample.board.white, 0b1111_0000);
        assert_eq!(sample.mover, Side::Black);
        assert_eq!(sample.outcome, 4.0);
        assert_eq!(sample.last_move_kind, LastMoveKind::Other);
        assert!(!sample.vulnerable_xc);
    }

    #[test]
    fn parse_simple_line_rejects_bad_board_length() {
        assert!(parse_simple_line("XXXX 1").is_err());
    }

    #[test]
    fn parse_simple_line_rejects_bad_score() {
        let board = "-".repeat(64);
        assert!(parse_simple_line(&format!("{board} not-a-number")).is_err());
    }

    #[test]
    fn parse_simple_line_rejects_missing_score() {
        let board = "-".repeat(64);
        assert!(parse_simple_line(&board).is_err());
    }

    #[test]
    fn list_simple_corpus_files_returns_single_file_as_is() {
        let dir = temp_dir("single-file");
        let file = dir.join("a.txt");
        fs::write(&file, "dummy").unwrap();
        let files = list_simple_corpus_files(&file).unwrap();
        assert_eq!(files, vec![file]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_simple_corpus_files_sorts_txt_files_in_directory() {
        let dir = temp_dir("dir-listing");
        fs::write(dir.join("0000001.txt"), "b").unwrap();
        fs::write(dir.join("0000000.txt"), "a").unwrap();
        fs::write(dir.join("readme.md"), "ignored").unwrap();
        let files = list_simple_corpus_files(&dir).unwrap();
        let names: Vec<_> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["0000000.txt", "0000001.txt"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_simple_corpus_files_errors_on_empty_directory() {
        let dir = temp_dir("empty-dir");
        assert!(list_simple_corpus_files(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    fn write_lines(path: &Path, lines: &[String]) {
        let mut file = fs::File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn fixture_lines(count: usize) -> Vec<String> {
        (0..count)
            .map(|i| {
                let stones = i % 60;
                let board = "X".repeat(stones) + &"-".repeat(64 - stones);
                format!("{board} {}", i as i64)
            })
            .collect()
    }

    #[test]
    fn load_simple_corpus_reads_all_records_when_max_records_is_none() {
        let dir = temp_dir("load-all");
        let file = dir.join("a.txt");
        let lines = fixture_lines(50);
        write_lines(&file, &lines);
        let (records, _hash, total) = load_simple_corpus(&[file], None, 1).unwrap();
        assert_eq!(total, 50);
        assert_eq!(records.len(), 50);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_simple_corpus_reservoir_sampling_is_deterministic_and_exact_count() {
        let dir = temp_dir("reservoir");
        let file = dir.join("a.txt");
        let lines = fixture_lines(1000);
        write_lines(&file, &lines);
        let (records1, hash1, total1) = load_simple_corpus(&[file.clone()], Some(37), 7).unwrap();
        let (records2, hash2, total2) = load_simple_corpus(&[file.clone()], Some(37), 7).unwrap();
        assert_eq!(total1, 1000);
        assert_eq!(total2, 1000);
        assert_eq!(records1.len(), 37);
        assert_eq!(records2.len(), 37);
        assert_eq!(hash1, hash2);
        // 内容ハッシュはmax_recordsによらず同じ入力から同じ値になる。
        let (_records3, hash3, _total3) = load_simple_corpus(&[file], None, 7).unwrap();
        assert_eq!(hash1, hash3);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_simple_corpus_returns_all_when_max_records_exceeds_total() {
        let dir = temp_dir("max-exceeds-total");
        let file = dir.join("a.txt");
        let lines = fixture_lines(10);
        write_lines(&file, &lines);
        let (records, _hash, total) = load_simple_corpus(&[file], Some(100), 1).unwrap();
        assert_eq!(total, 10);
        assert_eq!(records.len(), 10);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_simple_corpus_skips_blank_lines() {
        let dir = temp_dir("blank-lines");
        let file = dir.join("a.txt");
        fs::write(
            &file,
            format!("{}\n\n{} 1\n", fixture_lines(1)[0], "-".repeat(64)),
        )
        .unwrap();
        let (records, _hash, total) = load_simple_corpus(&[file], None, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(records.len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_by_position_hash_is_deterministic_and_covers_all_records() {
        let dir = temp_dir("split-determinism");
        let file = dir.join("a.txt");
        let lines = fixture_lines(2000);
        write_lines(&file, &lines);
        let (records, _hash, _total) = load_simple_corpus(&[file], None, 1).unwrap();
        let (train1, frozen1) = split_by_position_hash(records.clone());
        let (train2, frozen2) = split_by_position_hash(records.clone());
        assert_eq!(train1.len(), train2.len());
        assert_eq!(frozen1.len(), frozen2.len());
        assert_eq!(train1.len() + frozen1.len(), records.len());
        // 概ね1/10前後がfrozenになる(桁レベルの粗い健全性チェック)。
        assert!(frozen1.len() > 0);
        assert!(frozen1.len() < train1.len());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_by_position_hash_keeps_symmetric_duplicates_in_the_same_bucket() {
        // 同一局面の異なる対称形(ここでは180度回転)を2件用意し、
        // canonicalKeyが一致する以上、必ず同じ側(train/frozenどちらか一方)に
        // 入ることを確認する。
        let board_text = "X".repeat(4) + &"-".repeat(60);
        let sample_a = parse_simple_line(&format!("{board_text} 1")).unwrap();
        let rotated_text: String = board_text.chars().rev().collect();
        let sample_b = parse_simple_line(&format!("{rotated_text} 1")).unwrap();
        let key_a = experiment::canonicalize(&sample_a).0;
        let key_b = experiment::canonicalize(&sample_b).0;
        assert_eq!(key_a, key_b, "test fixture must be symmetric duplicates");
        let (train, frozen) = split_by_position_hash(vec![sample_a, sample_b]);
        assert!(train.len() == 2 || frozen.len() == 2);
    }
}

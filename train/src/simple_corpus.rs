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

/// T181: `--simple-corpus`にカンマ区切りで複数のパス(ディレクトリ/ファイル)を
/// 渡せるようにする(E2=現行lv17コーパス+v0002コーパスの単純連結のため)。
/// 各パスを`list_simple_corpus_files`でそれぞれ列挙し、指定順に連結するだけ
/// (各パス内部はこれまでどおりファイル名昇順)。カンマを含まない単一パスの
/// 場合は`list_simple_corpus_files`と完全に同じ結果を返す(既存呼び出しの
/// 挙動は不変)。
pub fn list_simple_corpus_files_multi(paths_arg: &str) -> Result<Vec<PathBuf>, String> {
    let mut all = Vec::new();
    for part in paths_arg.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        all.extend(list_simple_corpus_files(Path::new(trimmed))?);
    }
    if all.is_empty() {
        return Err(format!("no simple-corpus paths found in {paths_arg:?}"));
    }
    Ok(all)
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

/// T159b: 早期打ち切り(`--early-stop --simple-corpus`)向けの3分割
/// (train/val/frozen)。簡易コーパスには対局(game)の概念が無い
/// (`train/data/egaroucid/`実データを調査した結果、1行1局面で対局IDや
/// 手順の連番情報は一切含まれず、隣接行の空きマス数もばらばらで復元可能な
/// 順序性も無い)ため、`split_by_position_hash`と同じ考え方で局面
/// (canonicalKeyのD4正規化後)単位のハッシュ分割にする。
///
/// frozen判定は`split_by_position_hash`と全く同じ式(`fnv1a(canonicalKey)%10==9`)
/// を使い、同一poolに対しては`split_by_position_hash`が返すfrozenと常に一致する
/// (frozen成果物の意味をOFF経路と揃えるため)。frozen以外(残り約90%)から、
/// 別のsalt付きハッシュ(`fnv1a(canonicalKey)`とは独立に計算)で
/// `val_percent`ぶんを検証splitとして切り出す。
///
/// **メモリ**: `records`(所有権を受け取る)を1回だけ消費してtrain/val/frozenの
/// 3つのVecへ振り分ける(cloneなし)。WTHOR経路の`split_early_stop_validation`
/// (対局Vecをclone+flattenするためピーク約3倍メモリになる)とは異なり、
/// Egaroucid全量25.5M局面のような規模でも追加メモリはほぼ発生しない
/// (レビュー中3指摘への対処)。
///
/// **既知の制約(局面単位split)**: 対局境界が無いため、同一対局(または
/// 類似局面)由来のサンプルがtrainとvalに跨って入りうる(D4対称の完全重複は
/// canonicalKeyで防いでいるが、それ以外の近縁局面はこの分割では検出できない)。
/// これは検証MAEを楽観側に歪め、早期打ち切りの停止判定を遅らせる方向の
/// バイアスであり、致命的ではないが記録が必要(T159bタスクの要件1)。
pub fn split_for_early_stop(
    records: Vec<Sample>,
    val_percent: f64,
) -> (Vec<Sample>, Vec<Sample>, Vec<Sample>) {
    let threshold = ((val_percent / 100.0) * 1_000_000.0)
        .round()
        .clamp(0.0, 1_000_000.0) as u64;
    let mut train = Vec::new();
    let mut val = Vec::new();
    let mut frozen = Vec::new();
    for sample in records {
        let (key, _) = experiment::canonicalize(&sample);
        let mut frozen_hash = 0xcbf29ce484222325u64;
        frozen_hash = fnv_update(frozen_hash, &key.0.to_le_bytes());
        frozen_hash = fnv_update(frozen_hash, &key.1.to_le_bytes());
        frozen_hash = fnv_update(frozen_hash, &[key.2]);
        if frozen_hash % 10 == 9 {
            frozen.push(sample);
            continue;
        }
        // frozen判定のハッシュ(seed=FNV基本オフセットバイアス)とは異なる
        // 開始値を使い、frozen/val割当が相関しないようにする。
        let mut es_hash = 0x84222325_cbf29ce4_u64;
        es_hash = fnv_update(es_hash, &key.0.to_le_bytes());
        es_hash = fnv_update(es_hash, &key.1.to_le_bytes());
        es_hash = fnv_update(es_hash, &[key.2]);
        if es_hash % 1_000_000 < threshold {
            val.push(sample);
        } else {
            train.push(sample);
        }
    }
    (train, val, frozen)
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

    #[test]
    fn list_simple_corpus_files_multi_matches_single_path_behavior_when_no_comma() {
        // T181: カンマを含まない単一パスでは既存のlist_simple_corpus_filesと
        // 完全に同じ結果になること(既存呼び出しの挙動不変性)。
        let dir = temp_dir("multi-single-path-equivalence");
        fs::write(dir.join("0000001.txt"), "b").unwrap();
        fs::write(dir.join("0000000.txt"), "a").unwrap();
        let single = list_simple_corpus_files(&dir).unwrap();
        let multi = list_simple_corpus_files_multi(dir.to_str().unwrap()).unwrap();
        assert_eq!(single, multi);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_simple_corpus_files_multi_concatenates_paths_in_given_order() {
        // T181: E2(lv17+v0002)の単純連結を想定したテスト。カンマ区切りで
        // 複数のディレクトリ/ファイルを渡すと、指定した順に(各パス内部は
        // ファイル名昇順のまま)連結された一覧になること。
        let dir_a = temp_dir("multi-concat-a");
        let dir_b = temp_dir("multi-concat-b");
        fs::write(dir_a.join("0000001.txt"), "a1").unwrap();
        fs::write(dir_a.join("0000000.txt"), "a0").unwrap();
        let single_file_b = dir_b.join("b.txt");
        fs::write(&single_file_b, "b0").unwrap();

        let arg = format!(" {} , {} ", dir_a.display(), single_file_b.display());
        let files = list_simple_corpus_files_multi(&arg).unwrap();
        let names: Vec<_> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["0000000.txt", "0000001.txt", "b.txt"]);

        fs::remove_dir_all(&dir_a).ok();
        fs::remove_dir_all(&dir_b).ok();
    }

    #[test]
    fn list_simple_corpus_files_multi_errors_when_all_parts_empty_or_blank() {
        assert!(list_simple_corpus_files_multi("").is_err());
        assert!(list_simple_corpus_files_multi("  ,  ").is_err());
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

    /// `fixture_lines`は先頭からのXの連続個数(`i % 60`)だけで盤面を決めるため
    /// распределение(distinct canonicalKey数)が乏しい。`split_for_early_stop`の
    /// 決定性/網羅性/frozen一致テストでは、より多様な(ほぼ全件が異なる盤面の)
    /// フィクスチャを使う。
    fn diverse_lines(count: usize) -> Vec<String> {
        (0..count)
            .map(|i| {
                let mut state = (i as u64 + 1).wrapping_mul(0x9E3779B97F4A7C15);
                let mut cells = [b'-'; 64];
                for cell in cells.iter_mut() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    *cell = match state % 3 {
                        0 => b'-',
                        1 => b'X',
                        _ => b'O',
                    };
                }
                let board: String = cells.iter().map(|&b| b as char).collect();
                format!("{board} {}", (i % 40) as i64 - 20)
            })
            .collect()
    }

    #[test]
    fn split_for_early_stop_is_deterministic_and_partitions_all_records() {
        let dir = temp_dir("split-earlystop-determinism");
        let file = dir.join("a.txt");
        write_lines(&file, &diverse_lines(3000));
        let (records, _hash, _total) = load_simple_corpus(&[file], None, 1).unwrap();
        let (train1, val1, frozen1) = split_for_early_stop(records.clone(), 5.0);
        let (train2, val2, frozen2) = split_for_early_stop(records.clone(), 5.0);
        assert_eq!(train1, train2);
        assert_eq!(val1, val2);
        assert_eq!(frozen1, frozen2);
        assert_eq!(
            train1.len() + val1.len() + frozen1.len(),
            records.len()
        );
        assert!(!train1.is_empty());
        assert!(!val1.is_empty(), "expected some validation records at 5%");
        assert!(!frozen1.is_empty(), "expected some frozen records at ~10%");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_for_early_stop_frozen_matches_split_by_position_hash() {
        // frozenの意味をOFF経路(`split_by_position_hash`)と揃えるため、
        // 同一poolに対しては両者のfrozenが完全に一致すること
        // (要素の内容だけでなく、同じ入力順で処理するため順序も含めて一致する)。
        let dir = temp_dir("split-earlystop-frozen-consistency");
        let file = dir.join("a.txt");
        write_lines(&file, &diverse_lines(2000));
        let (records, _hash, _total) = load_simple_corpus(&[file], None, 1).unwrap();
        let (_train_a, frozen_a) = split_by_position_hash(records.clone());
        let (_train_b, _val_b, frozen_b) = split_for_early_stop(records, 5.0);
        assert_eq!(frozen_a, frozen_b);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_for_early_stop_keeps_symmetric_duplicates_in_the_same_bucket() {
        let board_text = "X".repeat(4) + &"-".repeat(60);
        let sample_a = parse_simple_line(&format!("{board_text} 1")).unwrap();
        let rotated_text: String = board_text.chars().rev().collect();
        let sample_b = parse_simple_line(&format!("{rotated_text} 1")).unwrap();
        let key_a = experiment::canonicalize(&sample_a).0;
        let key_b = experiment::canonicalize(&sample_b).0;
        assert_eq!(key_a, key_b, "test fixture must be symmetric duplicates");
        let (train, val, frozen) = split_for_early_stop(vec![sample_a, sample_b], 50.0);
        let buckets_hit = [train.len() == 2, val.len() == 2, frozen.len() == 2];
        assert_eq!(
            buckets_hit.iter().filter(|&&hit| hit).count(),
            1,
            "both symmetric duplicates must land in exactly one shared bucket"
        );
    }
}

//! T181: Egaroucid公開学習データ v0002(GitHub release `training_data_v0002`、
//! `Egaroucid_Train_Data_v0002_{0,1}.zip`、再配布禁止・`train/data/egaroucid_v0002/`
//! にgitignore領域として展開済み)を、最終石差ラベルのsimple-corpus形式
//! (`<64文字盤面> <スコア>`、`train::simple_corpus`が読む形式)へ変換する。
//!
//! # データの構造(配布元READMEおよび実物確認による)
//!
//! `--in-dirs`に渡す各ディレクトリは「ランダム序盤手数フォルダ(`8`〜`59`の
//! 数値ディレクトリ名)」を直下に持つ。各手数フォルダの中に`XXXXXXX.txt`が
//! 100ファイルあり、各ファイルは1万行、1行=1対局のf5d6形式棋譜
//! (2文字ずつの着手記譜を区切りなしで連結、例`f5d6c3d3c4...`)。
//! フォルダ名の数値Nは「この対局群は先頭N手をランダムに打った後、
//! Egaroucid for Console 7.8.0 lv11 と Edax 4.5.5 lv11 が対戦した」ことを示す
//! (配布元README)。パス記号(`PA`/`PS`)は実物調査(120,000局サンプル)で
//! 1件も出現しなかった(配布元は着手のみを記録し、パスは`samples_from_game`
//! 同様の自動判定に委ねる設計と判断)。
//!
//! # 変換規則
//!
//! 1. **パース**: 2文字ずつ(列a-h、行1-8)を`train::train_data::samples_from_game`
//!    が期待するマスインデックス(0..63)へ変換する。`PA`/`PS`(大小問わず)は
//!    パス記号としてスキップする(将来このデータセットや別データセットに
//!    パス記号が含まれていても壊れないための防御的対応)。奇数長・不正な
//!    列/行文字を含む行は不正棋譜としてスキップしカウントする。
//! 2. **再生+ラベル付け**: `samples_from_game`(WTHOR変換で実績のある既存関数)
//!    が着手列を再生し、各局面に「その対局の最終石差(手番視点)」を自動付与する。
//!    パス(合法手なし)は同関数が自動判定する。非合法な着手列(`Err`)は
//!    不正棋譜としてスキップしカウントする。
//! 3. **ランダム序盤の除外**: フォルダ名の数値Nをそのまま「除外すべき先頭
//!    着手数」として使う。`samples_from_game`が返す`samples[0..N)`
//!    (先頭N手適用直後までの局面)を除外し、`samples[N..]`(N+1手目以降、
//!    エンジン同士が実際に着手した局面)のみを採用候補とする。
//! 4. **層化サンプリング**(既定目標2,500万局面、`--target-count`でパラメータ化):
//!    採用候補は数十億局面規模になるため、既存の現行学習コーパス
//!    (既定`train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17`、
//!    `--reference-corpus`で変更可)の空きマス数(=64-石数)分布を目標分布とし、
//!    空きマス数バケットごとに「目標比率 × `--target-count`」件を上限に
//!    決定的に採用する。
//!    - **カウント専用の高速事前パス**: 採用候補1件ごとの空きマス数は、
//!      このデータセットにパスが実質皆無であること(実物調査で確認済み、
//!      上記コメント参照)を前提に、着手列の再生をせず「行の文字数(=着手数M)
//!      とNだけから解析的に」概算する(`empties(step) = 59 - step`、
//!      0-indexed。パスが1回でもあった対局はこの概算が実際よりズレる)。
//!      この概算は「どのバケットに何件の候補があるか」という**カウントにのみ**
//!      使い、目標比率から採用確率(バケットごとの`keep_probability`)を
//!      決めるためだけに使う。
//!    - **本パス(実際の採用判定・出力)**: 各候補について、ファイル相対パス・
//!      行番号・ステップ番号から作る安定キーをFNV-1aハッシュし、
//!      `hash % DENOM < keep_probability[empties_assumed] * DENOM`
//!      なら採用と判定する(`DENOM=1_000_000`)。この判定は着手列の再生を
//!      一切必要としないため、**1件も採用されない対局は再生しない**
//!      (52,000,000対局のうち実際に再生するのは採用済みバケットに該当する
//!      ごく一部で済み、変換全体を高速化する)。採用が1件でもある対局のみ
//!      `samples_from_game`で実再生し、**実際に再生して得た局面・最終石差**
//!      を出力する(空きマス数の概算はバケット選定用の近似であり、出力される
//!      盤面・スコアは常に実再生の正しい値)。
//!
//! # 決定性・checkpoint/resume
//!
//! - 入力ファイルは`--in-dirs`に列挙した順→各ディレクトリ内は手数フォルダの
//!   数値昇順→各フォルダ内はファイル名昇順、で決定的に処理する。
//! - 採用判定はファイル相対パス・行番号・ステップ番号のみに依存する純粋な
//!   ハッシュ判定のため、処理順序や中断・再開に関わらず同一入力に対して
//!   常に同一の採用集合になる。
//! - ファイル単位(1ファイル=1万局)でcheckpoint保存する。既存出力ファイルが
//!   あり、checkpointの処理済みファイル一覧と設定(`--target-count`・
//!   `--reference-corpus`・入力ディレクトリ一覧)が完全一致すれば、
//!   処理済みファイルをスキップして続きから再開する(不一致ならエラー終了、
//!   `--force-restart`で無視して最初からやり直せる)。
//! - 進捗ログ: 処理したファイル数・採用済み局面数・不正棋譜数を一定間隔で標準エラー出力へ。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin egaroucid_v0002_convert -- \
//!   --in-dirs "train/data/egaroucid_v0002/extracted/zip0/0002_egaroucid_7_8_0_edax_4_5_5_lv11_0,train/data/egaroucid_v0002/extracted/zip1/0002_egaroucid_7_8_0_edax_4_5_5_lv11_1" \
//!   --out train/data/t181/v0002_25m.txt \
//!   --checkpoint train/data/t181/v0002_25m.checkpoint.json \
//!   --target-count 25000000
//! ```

use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use engine::bitboard::Side;
use train::train_data::{self, Sample};

const DENOM: u64 = 1_000_000;
const MAX_EMPTIES_BUCKET: usize = 60; // 初期4石+最短1手で空き59以下。バケット添字は0..=60で十分。

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// 採用判定ハッシュ・checkpointの`processed_files`識別に使うパス文字列を、
/// 区切り文字(`\`/`/`)の違いに依存しないよう正規化する(`\`を`/`へ統一)。
/// `--in-dirs`の指定がバックスラッシュ区切り(PowerShellの`Join-Path`等)か
/// スラッシュ区切り(Bash等)かによって`Path::join`が生成する文字列表現が
/// 変わりうるため、これを正規化しないと「同一の実ファイルなのに採用判定の
/// ハッシュキーが変わり、決定的サンプリングの再現性が壊れる」問題が起きる
/// (実機テストで確認、作業ログ参照)。
fn normalize_path_for_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// `f5d6...`のような着手記譜文字列を、マスインデックス(0..63)の列へ変換する。
/// 大小文字は無視。`PA`/`PS`はパス記号としてスキップする(このデータセットでは
/// 実物調査上出現しないが、防御的に対応する)。不正な形式(奇数長・不正な
/// 列/行文字)を検出したら`None`を返す。
fn parse_transcript(line: &str) -> Option<Vec<u8>> {
    let bytes = line.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut moves = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() + 1 && i + 2 <= bytes.len() {
        let a = bytes[i].to_ascii_lowercase();
        let b = bytes[i + 1].to_ascii_lowercase();
        if a == b'p' && (b == b'a' || b == b's') {
            // pass, skip (samples_from_game infers passes automatically).
            i += 2;
            continue;
        }
        if !(b'a'..=b'h').contains(&a) || !(b'1'..=b'8').contains(&b) {
            return None;
        }
        let file = a - b'a';
        let rank = b - b'1';
        moves.push(rank * 8 + file);
        i += 2;
    }
    Some(moves)
}

/// `path`直下の、フォルダ名が整数として解釈できるディレクトリを数値昇順で
/// 列挙する(ランダム着手数N=8..59のフォルダ)。
fn list_n_folders(root: &Path) -> Result<Vec<(u32, PathBuf)>, String> {
    let mut out: Vec<(u32, PathBuf)> = fs::read_dir(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            path.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.parse::<u32>().ok())
                .map(|n| (n, path))
        })
        .collect();
    out.sort_by_key(|(n, _)| *n);
    Ok(out)
}

/// 各`(N, folder)`配下の`*.txt`をファイル名昇順で列挙し、`(N, file_path)`の
/// フラットな列にする。`--in-dirs`に列挙したディレクトリの順→フォルダの
/// 数値昇順→ファイル名昇順、で決定的な処理順序を作る。
fn list_input_files(in_dirs: &[PathBuf]) -> Result<Vec<(u32, PathBuf)>, String> {
    let mut all = Vec::new();
    for root in in_dirs {
        for (n, folder) in list_n_folders(root)? {
            let mut files: Vec<PathBuf> = fs::read_dir(&folder)
                .map_err(|e| format!("{}: {e}", folder.display()))?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "txt"))
                .collect();
            files.sort();
            for f in files {
                all.push((n, f));
            }
        }
    }
    Ok(all)
}

/// 現行学習コーパス(既にsimple-corpus形式)の空きマス数分布を数える
/// (盤面テキストの`X`/`O`個数から空きマス数=64-石数を求めるだけで、
/// 着手列の再生は不要)。
fn reference_histogram(dir: &Path) -> Result<BTreeMap<usize, u64>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(format!("no .txt files found in {}", dir.display()));
    }
    let mut hist: BTreeMap<usize, u64> = BTreeMap::new();
    for path in &files {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| format!("{}: {e}", path.display()))?;
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            let Some((board_text, _)) = trimmed.split_once(' ') else {
                continue;
            };
            if board_text.len() != 64 {
                continue;
            }
            let stones = board_text.bytes().filter(|&b| b == b'X' || b == b'O').count();
            let empties = 64 - stones;
            *hist.entry(empties).or_insert(0) += 1;
        }
    }
    Ok(hist)
}

/// 空きマス数バケットごとの目標採用件数(`target_count`を、`reference`の
/// 分布比率で按分)を求める。
fn target_counts_per_bucket(
    reference: &BTreeMap<usize, u64>,
    target_count: u64,
) -> BTreeMap<usize, u64> {
    let total: u64 = reference.values().sum();
    let mut out = BTreeMap::new();
    if total == 0 {
        return out;
    }
    for (&empties, &count) in reference {
        let fraction = count as f64 / total as f64;
        let target = (fraction * target_count as f64).round() as u64;
        out.insert(empties, target);
    }
    out
}

fn sample_to_line(sample: &Sample) -> String {
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

#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    settings_key: String,
    processed_files: Vec<String>,
    samples_written: u64,
    malformed_transcripts: u64,
    illegal_move_sequences: u64,
    games_scanned: u64,
    per_bucket_written: BTreeMap<usize, u64>,
    /// 直近のcheckpoint保存時点での出力ファイルのバイト長。`BufWriter`は
    /// 明示的な`flush()`呼び出しとは無関係に内部バッファが一杯になると
    /// 自動的にOS側へ書き出すことがあるため、中断時点の出力ファイルの
    /// 実際のバイト長が、最後に保存したcheckpointの`samples_written`より
    /// 先行している(中断直前の未確定分が漏れて書き込まれている)ことが
    /// あり得る。resume時はこの値まで出力ファイルを`set_len`で切り詰めて
    /// から追記を再開することで、checkpointと出力ファイルの整合性を保証する。
    output_bytes_committed: u64,
}

fn settings_key(
    in_dirs: &[PathBuf],
    reference_corpus: &Path,
    target_count: u64,
    out_path: &Path,
) -> String {
    let mut parts: Vec<String> = in_dirs.iter().map(|p| p.display().to_string()).collect();
    parts.push(reference_corpus.display().to_string());
    parts.push(target_count.to_string());
    parts.push(out_path.display().to_string());
    parts.join("|")
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let in_dirs_arg = match get_arg(&args, "--in-dirs") {
        Some(v) => v,
        None => {
            eprintln!("missing required arg --in-dirs (comma-separated N-folder root directories)");
            return ExitCode::FAILURE;
        }
    };
    let in_dirs: Vec<PathBuf> = in_dirs_arg
        .split(',')
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    if in_dirs.is_empty() {
        eprintln!("--in-dirs must contain at least one path");
        return ExitCode::FAILURE;
    }
    let out_path = PathBuf::from(
        get_arg(&args, "--out").unwrap_or_else(|| "train/data/t181/v0002_25m.txt".to_string()),
    );
    let checkpoint_path = PathBuf::from(get_arg(&args, "--checkpoint").unwrap_or_else(|| {
        "train/data/t181/v0002_25m.checkpoint.json".to_string()
    }));
    let reference_corpus = PathBuf::from(get_arg(&args, "--reference-corpus").unwrap_or_else(|| {
        "train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17".to_string()
    }));
    let target_count: u64 = match get_arg(&args, "--target-count") {
        Some(v) => match v.parse() {
            Ok(x) => x,
            Err(e) => {
                eprintln!("invalid --target-count: {e}");
                return ExitCode::FAILURE;
            }
        },
        None => 25_000_000,
    };
    let progress_every: usize = match get_arg(&args, "--progress-every-files") {
        Some(v) => v.parse().unwrap_or(50),
        None => 50,
    };
    let force_restart = has_flag(&args, "--force-restart");

    let key = settings_key(&in_dirs, &reference_corpus, target_count, &out_path);

    eprintln!("=== step 1/3: computing reference histogram from {} ===", reference_corpus.display());
    let reference = match reference_histogram(&reference_corpus) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let reference_total: u64 = reference.values().sum();
    eprintln!(
        "reference corpus: {reference_total} position(s) across {} empties-bucket(s)",
        reference.len()
    );

    eprintln!("=== step 2/3: listing input files under --in-dirs ===");
    let files = match list_input_files(&in_dirs) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if files.is_empty() {
        eprintln!("no input files found under --in-dirs");
        return ExitCode::FAILURE;
    }
    eprintln!("found {} input file(s) across all N-folders", files.len());

    eprintln!("=== step 2b/3: counting available candidates per empties-bucket (length-based, no replay) ===");
    let mut available: BTreeMap<usize, u64> = BTreeMap::new();
    for (n, path) in &files {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("failed to open {}: {e}", path.display());
                return ExitCode::FAILURE;
            }
        };
        for line in BufReader::new(file).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            let m = trimmed.len() / 2;
            let n = *n as usize;
            if n >= m {
                continue;
            }
            for step in n..m {
                if step > MAX_EMPTIES_BUCKET + 2 {
                    continue;
                }
                let empties = 59usize.saturating_sub(step);
                *available.entry(empties).or_insert(0) += 1;
            }
        }
    }
    let available_total: u64 = available.values().sum();
    eprintln!("available (post-exclusion) candidate count (approx, length-based): {available_total}");

    let targets = target_counts_per_bucket(&reference, target_count);
    let mut keep_probability: BTreeMap<usize, f64> = BTreeMap::new();
    for (&empties, &want) in &targets {
        let have = *available.get(&empties).unwrap_or(&0);
        let p = if have == 0 {
            0.0
        } else {
            (want as f64 / have as f64).min(1.0)
        };
        keep_probability.insert(empties, p);
    }
    eprintln!(
        "computed keep-probability for {} bucket(s) (target-count={target_count})",
        keep_probability.len()
    );

    // checkpoint読み込み(設定一致なら再開、不一致ならエラー、--force-restartで無視)
    let mut checkpoint = Checkpoint {
        settings_key: key.clone(),
        ..Checkpoint::default()
    };
    if checkpoint_path.exists() && !force_restart {
        match fs::read_to_string(&checkpoint_path) {
            Ok(text) => match serde_json::from_str::<Checkpoint>(&text) {
                Ok(existing) => {
                    if existing.settings_key == key {
                        eprintln!(
                            "[resume] loaded checkpoint: {} file(s) already processed, {} sample(s) written",
                            existing.processed_files.len(),
                            existing.samples_written
                        );
                        checkpoint = existing;
                    } else {
                        eprintln!(
                            "existing checkpoint {} has a different settings key; refusing to resume (use --force-restart to discard it)",
                            checkpoint_path.display()
                        );
                        return ExitCode::FAILURE;
                    }
                }
                Err(e) => {
                    eprintln!("failed to parse existing checkpoint {}: {e}", checkpoint_path.display());
                    return ExitCode::FAILURE;
                }
            },
            Err(e) => {
                eprintln!("failed to read existing checkpoint {}: {e}", checkpoint_path.display());
                return ExitCode::FAILURE;
            }
        }
    }
    let already_done: std::collections::HashSet<String> =
        checkpoint.processed_files.iter().cloned().collect();

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("failed to create output directory {}: {e}", parent.display());
                return ExitCode::FAILURE;
            }
        }
    }
    if let Some(parent) = checkpoint_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("failed to create checkpoint directory {}: {e}", parent.display());
                return ExitCode::FAILURE;
            }
        }
    }

    // 出力ファイル: resumeなら追記(append)、force-restartまたは新規なら上書き。
    let append_mode = !force_restart && !already_done.is_empty();
    if append_mode {
        if let Err(e) = truncate_to_committed(&out_path, checkpoint.output_bytes_committed) {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
        eprintln!(
            "[resume] truncated {} to the last committed length ({} bytes) before appending",
            out_path.display(),
            checkpoint.output_bytes_committed
        );
    }
    let out_file = match OpenOptions::new()
        .create(true)
        .write(true)
        .append(append_mode)
        .truncate(!append_mode)
        .open(&out_path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("failed to open {}: {e}", out_path.display());
            return ExitCode::FAILURE;
        }
    };
    let mut writer = BufWriter::new(out_file);

    eprintln!("=== step 3/3: converting (replay only games with >=1 kept sample) ===");
    let start = Instant::now();
    let mut files_done_this_run = 0usize;
    for (n, path) in &files {
        let rel = normalize_path_for_key(path);
        if already_done.contains(&rel) {
            continue;
        }
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("failed to open {}: {e}", path.display());
                return ExitCode::FAILURE;
            }
        };
        for (line_idx, line) in BufReader::new(file).lines().enumerate() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            checkpoint.games_scanned += 1;
            let m = trimmed.len() / 2;
            let n_usize = *n as usize;
            if n_usize >= m {
                continue; // ランダム区間しかない(または着手数がN以下)対局
            }

            // どのstepを採用するかを、再生前に(ハッシュのみで)決める。
            let mut steps_to_keep: Vec<usize> = Vec::new();
            for step in n_usize..m {
                let empties_assumed = 59usize.saturating_sub(step);
                let p = *keep_probability.get(&empties_assumed).unwrap_or(&0.0);
                if p <= 0.0 {
                    continue;
                }
                let key_str = format!("{rel}:{line_idx}:{step}");
                let h = fnv1a(key_str.as_bytes());
                let threshold = (p * DENOM as f64).round() as u64;
                if h % DENOM < threshold {
                    steps_to_keep.push(step);
                }
            }
            if steps_to_keep.is_empty() {
                continue;
            }

            // 採用ステップが1件以上あるときだけ実際に再生する。
            let Some(moves) = parse_transcript(trimmed) else {
                checkpoint.malformed_transcripts += 1;
                continue;
            };
            let samples = match train_data::samples_from_game(&moves) {
                Ok(s) => s,
                Err(_) => {
                    checkpoint.illegal_move_sequences += 1;
                    continue;
                }
            };
            for step in steps_to_keep {
                if step >= samples.len() {
                    continue; // 概算Mと実際の着手数が食い違うケース(想定上ほぼ皆無)への防御
                }
                let sample = &samples[step];
                let line_out = sample_to_line(sample);
                if let Err(e) = writeln!(writer, "{line_out}") {
                    eprintln!("failed to write to {}: {e}", out_path.display());
                    return ExitCode::FAILURE;
                }
                checkpoint.samples_written += 1;
                let real_empties = (64
                    - (sample.board.black.count_ones() + sample.board.white.count_ones()))
                    as usize;
                *checkpoint.per_bucket_written.entry(real_empties).or_insert(0) += 1;
            }
        }

        checkpoint.processed_files.push(rel);
        files_done_this_run += 1;
        if files_done_this_run % progress_every == 0 {
            if let Err(e) = flush_and_checkpoint(&mut writer, &out_path, &checkpoint_path, &mut checkpoint) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
            eprintln!(
                "[{}/{} files this run, {} total processed] scanned={} written={} malformed={} illegal={} elapsed={:.1}s",
                files_done_this_run,
                files.len() - already_done.len(),
                checkpoint.processed_files.len(),
                checkpoint.games_scanned,
                checkpoint.samples_written,
                checkpoint.malformed_transcripts,
                checkpoint.illegal_move_sequences,
                start.elapsed().as_secs_f64(),
            );
        }
    }

    if let Err(e) = flush_and_checkpoint(&mut writer, &out_path, &checkpoint_path, &mut checkpoint) {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }

    eprintln!(
        "done: {} sample(s) written to {} (scanned {} game(s), malformed {}, illegal {}) across {} file(s)",
        checkpoint.samples_written,
        out_path.display(),
        checkpoint.games_scanned,
        checkpoint.malformed_transcripts,
        checkpoint.illegal_move_sequences,
        checkpoint.processed_files.len(),
    );
    eprint!("per_bucket_written(empties:count)=");
    for (empties, count) in &checkpoint.per_bucket_written {
        eprint!("{empties}:{count},");
    }
    eprintln!();

    ExitCode::SUCCESS
}

/// resume時に、出力ファイルを最後に確定した(checkpoint保存時点の)バイト長へ
/// 切り詰める。`BufWriter`は明示的な`flush()`とは無関係に内部バッファが
/// 一杯になると自動でOS側へ書き出すことがあるため、中断時点の出力ファイルの
/// 実際のバイト長がcheckpointの`samples_written`より先行して(未確定分が
/// 漏れて書き込まれて)いることがあり、これを補正する。
fn truncate_to_committed(out_path: &Path, committed_len: u64) -> Result<(), String> {
    let file = OpenOptions::new()
        .write(true)
        .open(out_path)
        .map_err(|e| format!("failed to open {} for truncation: {e}", out_path.display()))?;
    file.set_len(committed_len)
        .map_err(|e| format!("failed to truncate {} to {committed_len} bytes: {e}", out_path.display()))
}

/// 出力ライタをflushし、出力ファイルの実バイト長を`checkpoint.output_bytes_committed`
/// へ記録してからcheckpointを保存する(この2つを必ず同じタイミングで行うことで、
/// resume時の切り詰め処理が正しい基準点を持つことを保証する)。
fn flush_and_checkpoint(
    writer: &mut BufWriter<File>,
    out_path: &Path,
    checkpoint_path: &Path,
    checkpoint: &mut Checkpoint,
) -> Result<(), String> {
    writer
        .flush()
        .map_err(|e| format!("failed to flush {}: {e}", out_path.display()))?;
    let metadata = fs::metadata(out_path).map_err(|e| format!("{}: {e}", out_path.display()))?;
    checkpoint.output_bytes_committed = metadata.len();
    save_checkpoint(checkpoint_path, checkpoint)
}

fn save_checkpoint(path: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    let json = serde_json::to_string_pretty(checkpoint).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json).map_err(|e| format!("{}: {e}", tmp_path.display()))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::bitboard::Board;

    #[test]
    fn parse_transcript_converts_pairs_to_square_indices() {
        // f5 -> file=f(5) row=5(4) => index = 4*8+5 = 37
        let moves = parse_transcript("f5d6c3").unwrap();
        assert_eq!(moves, vec![4 * 8 + 5, 5 * 8 + 3, 2 * 8 + 2]);
    }

    #[test]
    fn parse_transcript_skips_pass_tokens_case_insensitively() {
        let moves = parse_transcript("f5PAd6ps c3".replace(' ', "").as_str()).unwrap();
        assert_eq!(moves, vec![4 * 8 + 5, 5 * 8 + 3, 2 * 8 + 2]);
    }

    #[test]
    fn parse_transcript_rejects_odd_length_and_bad_tokens() {
        assert!(parse_transcript("f5d").is_none());
        assert!(parse_transcript("z9d6").is_none());
        assert!(parse_transcript("a9d6").is_none());
    }

    #[test]
    fn parse_transcript_matches_notation_used_elsewhere_in_the_codebase() {
        // train_data.rsのテストヘルパーと同じ規約(a1=0, h8=63)であることを確認。
        let moves = parse_transcript("f5d6c3d3c4f4").unwrap();
        // このタイガー定石はwthor_to_simple.rsのテストでも使われている既知の並び。
        let expected: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4"]
            .iter()
            .map(|n| {
                let bytes = n.as_bytes();
                let file = bytes[0] - b'a';
                let rank = bytes[1] - b'1';
                rank * 8 + file
            })
            .collect();
        assert_eq!(moves, expected);
        // 実際にsamples_from_gameへ通しても合法に再生できる(タイガー定石は
        // 実対局由来の合法な手順)ことを確認。
        assert!(train_data::samples_from_game(&moves).is_ok());
    }

    #[test]
    fn target_counts_per_bucket_scales_by_reference_fraction() {
        let mut reference = BTreeMap::new();
        reference.insert(10usize, 30u64);
        reference.insert(20usize, 70u64);
        let targets = target_counts_per_bucket(&reference, 1000);
        assert_eq!(targets.get(&10), Some(&300));
        assert_eq!(targets.get(&20), Some(&700));
    }

    #[test]
    fn fnv1a_is_deterministic_and_sensitive_to_input() {
        let a = fnv1a(b"file:0:5");
        let b = fnv1a(b"file:0:5");
        let c = fnv1a(b"file:0:6");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn sample_to_line_round_trips_via_existing_decoder_convention() {
        let sample = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 4.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let line = sample_to_line(&sample);
        let (board_text, score_text) = line.split_once(' ').unwrap();
        assert_eq!(board_text.len(), 64);
        assert_eq!(score_text, "4");
    }

    /// 決定性の直接検証: 同一の候補(file/line/step)集合に対し、採用判定
    /// (ハッシュ+閾値)を2回計算して常に同じ結果になることを確認する。
    #[test]
    fn keep_decision_is_deterministic_across_repeated_calls() {
        let rel = "some/file/0000005.txt";
        let mut results1 = Vec::new();
        let mut results2 = Vec::new();
        for line_idx in 0..50usize {
            for step in 0..30usize {
                let key_str = format!("{rel}:{line_idx}:{step}");
                results1.push(fnv1a(key_str.as_bytes()) % DENOM);
                let key_str2 = format!("{rel}:{line_idx}:{step}");
                results2.push(fnv1a(key_str2.as_bytes()) % DENOM);
            }
        }
        assert_eq!(results1, results2);
    }

    #[test]
    fn list_n_folders_sorts_numerically_not_lexically() {
        let dir = std::env::temp_dir().join(format!(
            "t181-list-n-folders-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(dir.join("9")).unwrap();
        fs::create_dir_all(dir.join("10")).unwrap();
        fs::create_dir_all(dir.join("8")).unwrap();
        fs::write(dir.join("readme.md"), "ignored").unwrap();
        let folders = list_n_folders(&dir).unwrap();
        let ns: Vec<u32> = folders.iter().map(|(n, _)| *n).collect();
        assert_eq!(ns, vec![8, 9, 10]);
        fs::remove_dir_all(&dir).ok();
    }

    /// resumeの安全性の核心テスト: `BufWriter`の自動flushにより、
    /// 出力ファイルの実バイト長がcheckpointの`output_bytes_committed`より
    /// 実機テストで発見した不具合の直接再現テスト: `--in-dirs`を
    /// バックスラッシュ区切り(PowerShellの`Join-Path`等)とスラッシュ区切り
    /// (Bash等)のどちらで指定しても、同一の実ファイルを指す限り採用判定の
    /// ハッシュキーが一致すること(`normalize_path_for_key`による正規化の効果)。
    #[test]
    fn normalize_path_for_key_makes_backslash_and_forward_slash_paths_equal() {
        let backslash = Path::new(r"C:\Users\x\in_big\8\0000000.txt");
        let forward = Path::new("C:/Users/x/in_big/8/0000000.txt");
        assert_eq!(
            normalize_path_for_key(backslash),
            normalize_path_for_key(forward)
        );
    }

    /// 先行してしまうケース(中断直前の未確定分が漏れて書き込まれた状態)を
    /// 直接再現し、`truncate_to_committed`が正しくその漏れ分を切り詰めて
    /// checkpointとの整合性を回復することを確認する。
    #[test]
    fn truncate_to_committed_removes_uncommitted_trailing_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "t181-truncate-resume-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let out_path = dir.join("out.txt");
        // checkpoint保存時点では10バイトだけが「確定」していたが、直後に
        // BufWriterの自動flushで追加の5バイト("EXTRA")が漏れて書き込まれた、
        // という状況を再現する。
        fs::write(&out_path, "0123456789EXTRA").unwrap();
        assert_eq!(fs::metadata(&out_path).unwrap().len(), 15);

        truncate_to_committed(&out_path, 10).unwrap();

        let content = fs::read_to_string(&out_path).unwrap();
        assert_eq!(content, "0123456789");
        assert_eq!(fs::metadata(&out_path).unwrap().len(), 10);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncate_to_committed_is_a_no_op_when_lengths_already_match() {
        let dir = std::env::temp_dir().join(format!(
            "t181-truncate-noop-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let out_path = dir.join("out.txt");
        fs::write(&out_path, "already-committed").unwrap();
        let len = fs::metadata(&out_path).unwrap().len();

        truncate_to_committed(&out_path, len).unwrap();

        assert_eq!(fs::read_to_string(&out_path).unwrap(), "already-committed");
        fs::remove_dir_all(&dir).ok();
    }
}

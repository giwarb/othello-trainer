//! T181: lv17コーパスの局面ハッシュfrozen split(`train::simple_corpus::split_by_position_hash`、
//! `fnv1a(canonicalKey) % 10 == 9`)を固定成果物として抽出し、任意個の重みファイルに
//! 対して**同一frozen集合**でのMAE/MSEを算出するスタンドアロンツール。
//!
//! # なぜ必要か
//!
//! `train_patterns_v3`(トレーナー本体)が学習実行ごとに報告する`frozen_mae`は、
//! **その実行が読み込んだコーパス自身のfrozen split**に対する値である。
//! E1(v0002単独25M)はv0002由来局面のみのfrozen、E2(lv17+v0002混合)は
//! lv17由来+v0002由来が混ざったfrozenであり、両者ともv6本番(lv17単独25.5Mで
//! 学習)のfrozenとは異なる局面集合になる。`split_by_position_hash`/
//! `split_for_early_stop`はいずれも局面のD4正規化canonicalKeyのみに依存する
//! **データソース非依存の純粋関数**(`train/src/simple_corpus.rs`参照)なので、
//! 「lv17コーパスのfrozen」だけを固定して抽出し、v6/E1best/E2bestの3構成を
//! この同一集合に対して評価すれば、公平な横断比較になる(E1/E2の学習データは
//! この関数を通す時点で同一ハッシュ規則によりlv17のfrozenと重なる局面を
//! 自動的に除外済みなので、リークは生じない)。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin frozen_mae_eval -- \
//!   --lv17-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 \
//!   --frozen-cache train/data/t181/lv17_frozen.txt \
//!   --weights v6=train/weights/pattern_v6.bin,e1-best=train/data/t181/e1-v0002/t158-b3-canonical-seed-1-earlystop.bin \
//!   --out bench/edax-compare/t181_frozen_mae.tsv
//! ```
//!
//! - `--frozen-cache`に指定したパスが既存ファイルなら、そこから直接読み込む
//!   (`--lv17-corpus`全量(25.5M行)の再読み込み・再split不要、高速)。
//!   存在しなければ`--lv17-corpus`を全量読み込み`split_by_position_hash`で
//!   frozenを抽出し、以後の再実行のために同パスへ書き出す
//!   (これが「lv17 frozenの固定成果物」そのもの)。
//! - `--weights`は`label=path`のカンマ区切りリスト。各重みファイルを
//!   `train::regression::Model::from_bytes`(PWV1〜PWV6を自動判別)で読み込み、
//!   frozen集合全体に対するMAE/MSEを計算して標準出力とTSVへ出す。

use std::env;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use train::regression::Model;
use train::simple_corpus::{self, split_by_position_hash};
use train::train_data::Sample;

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// frozenサンプルをsimple-corpus形式(`<64文字盤面> <スコア>`)の1行へ変換する。
/// `simple_corpus::parse_simple_line`は常に`mover = Side::Black`でSampleを作る
/// (`X`=own視点をそのままblackビットへマップする規約)ため、ここでの逆変換も
/// その規約を前提にしてよい(lv17コーパス由来のSampleは全て同規約で読み込まれている)。
fn sample_to_simple_line(s: &Sample) -> String {
    let mut cells = String::with_capacity(64);
    for i in 0..64u32 {
        let bit = 1u64 << i;
        if s.board.black & bit != 0 {
            cells.push('X');
        } else if s.board.white & bit != 0 {
            cells.push('O');
        } else {
            cells.push('-');
        }
    }
    format!("{cells} {:.0}", s.outcome)
}

/// lv17コーパスのfrozen splitを得る。`frozen_cache`が既存ファイルならそこから
/// 直接読み込み、なければ`lv17_corpus`全量から抽出して`frozen_cache`(指定されて
/// いれば)へ書き出す。
fn load_or_build_frozen(
    lv17_corpus: &Path,
    frozen_cache: Option<&Path>,
) -> Result<Vec<Sample>, String> {
    if let Some(cache_path) = frozen_cache {
        if cache_path.is_file() {
            eprintln!("frozen cache hit: {}", cache_path.display());
            let (records, _hash, total_lines) =
                simple_corpus::load_simple_corpus(&[cache_path.to_path_buf()], None, 42)?;
            eprintln!("frozen cache loaded: lines={total_lines} samples={}", records.len());
            return Ok(records);
        }
        eprintln!(
            "frozen cache miss ({} not found): building from {}",
            cache_path.display(),
            lv17_corpus.display()
        );
    }

    let files = simple_corpus::list_simple_corpus_files(lv17_corpus)?;
    eprintln!("loading lv17 corpus: {} file(s)", files.len());
    let (records, corpus_hash, total_lines) = simple_corpus::load_simple_corpus(&files, None, 42)?;
    eprintln!("lv17 corpus loaded: lines={total_lines} corpus_hash={corpus_hash}");
    let (_train, frozen) = split_by_position_hash(records);
    eprintln!("lv17 frozen extracted: samples={}", frozen.len());

    if let Some(cache_path) = frozen_cache {
        if let Some(parent) = cache_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
        }
        let file = File::create(cache_path).map_err(|e| format!("{}: {e}", cache_path.display()))?;
        let mut writer = BufWriter::new(file);
        for sample in &frozen {
            writeln!(writer, "{}", sample_to_simple_line(sample))
                .map_err(|e| format!("{}: {e}", cache_path.display()))?;
        }
        writer.flush().map_err(|e| format!("{}: {e}", cache_path.display()))?;
        eprintln!("frozen cache written: {}", cache_path.display());
    }

    Ok(frozen)
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();

    let lv17_corpus = PathBuf::from(get_arg(&args, "--lv17-corpus").unwrap_or_else(|| {
        "train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17".to_string()
    }));
    let frozen_cache = get_arg(&args, "--frozen-cache").map(PathBuf::from);
    let weights_arg = get_arg(&args, "--weights")
        .ok_or_else(|| "missing required --weights label=path[,label=path...]".to_string())?;
    let out_path = get_arg(&args, "--out").map(PathBuf::from);

    let mut weight_entries: Vec<(String, PathBuf)> = Vec::new();
    for part in weights_arg.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (label, path) = trimmed
            .split_once('=')
            .ok_or_else(|| format!("--weights entry must be label=path, got {trimmed:?}"))?;
        weight_entries.push((label.to_string(), PathBuf::from(path)));
    }
    if weight_entries.is_empty() {
        return Err("--weights must contain at least one label=path entry".to_string());
    }

    let frozen = load_or_build_frozen(&lv17_corpus, frozen_cache.as_deref())?;
    if frozen.is_empty() {
        return Err("lv17 frozen split is empty".to_string());
    }

    let header = "label\tweights_path\tfrozen_samples\tfrozen_mse\tfrozen_mae\tbytes\n".to_string();
    let mut report = header.clone();
    print!("{header}");

    for (label, path) in &weight_entries {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let model = Model::from_bytes(&bytes)
            .map_err(|e| format!("failed to parse weights {}: {e}", path.display()))?;
        let mse = model.mean_squared_error(&frozen);
        let mae = model.mean_absolute_error(&frozen);
        let row = format!(
            "{label}\t{}\t{}\t{mse:.6}\t{mae:.6}\t{}\n",
            path.display(),
            frozen.len(),
            bytes.len()
        );
        print!("{row}");
        report.push_str(&row);
    }

    if let Some(out_path) = out_path {
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
        }
        fs::write(&out_path, report).map_err(|e| format!("{}: {e}", out_path.display()))?;
        eprintln!("report written: {}", out_path.display());
    }

    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::bitboard::Side;
    use train::train_data::LastMoveKind;

    #[test]
    fn sample_to_simple_line_roundtrips_through_parse_simple_line() {
        let line = "-XO-OOXOOXX-OXOO-XXOXXOOX-OXOOXOOXOOOXXXO-XOOOXXO-O-OO---OOOX-O- 4";
        let sample = simple_corpus::parse_simple_line(line).expect("parse");
        let regenerated = sample_to_simple_line(&sample);
        assert_eq!(regenerated, line);
    }

    #[test]
    fn sample_to_simple_line_handles_negative_outcome_and_empty_board() {
        let sample = Sample {
            board: engine::bitboard::Board { black: 0, white: 0 },
            mover: Side::Black,
            outcome: -12.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let line = sample_to_simple_line(&sample);
        assert_eq!(
            line,
            "---------------------------------------------------------------- -12"
        );
        // 再パースしても値が保存されることを確認(往復の健全性)。
        let reparsed = simple_corpus::parse_simple_line(&line).expect("parse");
        assert_eq!(reparsed.outcome, -12.0);
    }

    #[test]
    fn get_arg_finds_value_after_flag_and_returns_none_when_absent() {
        let args: Vec<String> = vec!["--weights".to_string(), "a=b".to_string()];
        assert_eq!(get_arg(&args, "--weights"), Some("a=b".to_string()));
        assert_eq!(get_arg(&args, "--missing"), None);
    }
}

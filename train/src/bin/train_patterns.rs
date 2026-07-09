//! WTHOR棋譜データからパターン評価の重みをSGDで学習し、`train/weights/pattern_v1.bin`
//! に書き出すCLIバイナリ。
//!
//! 使い方:
//! ```text
//! cargo run -p train --release --bin train_patterns
//! # または、対象ファイルを明示的に指定する場合:
//! cargo run -p train --release --bin train_patterns -- train/data/WTH_2023.wtb train/data/WTH_2024.wtb
//! ```
//!
//! 引数を省略した場合は`train/data/`配下の`*.wtb`ファイルをすべて自動的に対象にする。
//!
//! 対局単位でデータを「学習用(先頭90%)」「ホールドアウト用(末尾10%)」に分割し
//! (同一対局内のサンプルが学習・検証の両方に混ざらないようにするため)、学習後に
//! 訓練誤差・ホールドアウト誤差(MSE・MAE)と、2種類のベースライン
//! (常に0=互角を予測する場合/常に訓練データの平均値を予測する場合)の
//! ホールドアウトMSEを標準出力に表示する。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use train::patterns;
use train::regression::{Model, TrainConfig};
use train::train_data::{self, Sample};
use train::wthor;

/// `train/data/`配下の`*.wtb`ファイルを走査して返す(パスはソート済み)。
fn default_data_files() -> Vec<PathBuf> {
    let dir = Path::new("train/data");
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "wtb").unwrap_or(false) {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let files: Vec<PathBuf> = if args.is_empty() {
        default_data_files()
    } else {
        args.iter().map(PathBuf::from).collect()
    };

    if files.is_empty() {
        eprintln!(
            "学習用の.wtbファイルが見つかりません(train/data/配下に置くか、引数でパスを指定してください)"
        );
        return ExitCode::FAILURE;
    }

    // 対局単位でサンプルをグループ化したまま集める(ホールドアウト分割を
    // 対局単位で行うため、フラットな1本のVec<Sample>にはまだ結合しない)。
    let mut games_samples: Vec<Vec<Sample>> = Vec::new();
    let mut file_errors: u64 = 0;

    for path in &files {
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

        let mut file_sample_count = 0usize;
        let mut file_game_count = 0usize;
        for game in &file.games {
            if let Ok(samples) = train_data::samples_from_game(&game.moves) {
                if !samples.is_empty() {
                    file_sample_count += samples.len();
                    file_game_count += 1;
                    games_samples.push(samples);
                }
            }
        }
        println!(
            "{}: 対象年={} {}局から{}サンプル",
            path.display(),
            file.header.year_of_games,
            file_game_count,
            file_sample_count
        );
    }

    if file_errors > 0 {
        eprintln!("警告: {file_errors}件のファイルで読み込み/パースに失敗しました");
    }

    let total_games = games_samples.len();
    if total_games == 0 {
        eprintln!("学習サンプルが1件も得られませんでした");
        return ExitCode::FAILURE;
    }

    // ホールドアウト分割: 対局の末尾10%を検証用に分離する(同一対局のサンプルが
    // 学習・検証の両方に混ざらないようにするため、対局単位で分割する)。
    let holdout_games = ((total_games as f64) * 0.1).round() as usize;
    let holdout_games = holdout_games.max(1).min(total_games - 1);
    let split_at = total_games - holdout_games;

    let mut train_samples: Vec<Sample> = Vec::new();
    let mut holdout_samples: Vec<Sample> = Vec::new();
    for (i, samples) in games_samples.into_iter().enumerate() {
        if i < split_at {
            train_samples.extend(samples);
        } else {
            holdout_samples.extend(samples);
        }
    }

    println!("=== データセット ===");
    println!(
        "総対局数: {total_games} (学習用: {split_at}局・{}サンプル, ホールドアウト用: {holdout_games}局・{}サンプル)",
        train_samples.len(),
        holdout_samples.len()
    );

    let pattern_defs = patterns::generate_patterns();
    let mut model = Model::new(pattern_defs);
    let cfg = TrainConfig::default();

    println!("=== 学習開始 ===");
    println!(
        "learning_rate={}, l2={}, epochs={}, seed={}",
        cfg.learning_rate, cfg.l2, cfg.epochs, cfg.seed
    );
    model.train(&train_samples, &cfg);

    let train_mse = model.mean_squared_error(&train_samples);
    let train_mae = model.mean_absolute_error(&train_samples);
    let holdout_mse = model.mean_squared_error(&holdout_samples);
    let holdout_mae = model.mean_absolute_error(&holdout_samples);

    // ベースライン1: 常に0(互角)を予測する場合のホールドアウトMSE/MAE。
    let baseline_zero_mse: f64 = holdout_samples
        .iter()
        .map(|s| (s.outcome as f64).powi(2))
        .sum::<f64>()
        / holdout_samples.len() as f64;
    let baseline_zero_mae: f64 = holdout_samples
        .iter()
        .map(|s| (s.outcome as f64).abs())
        .sum::<f64>()
        / holdout_samples.len() as f64;

    // ベースライン2: 常に訓練データの平均値を予測する場合のホールドアウトMSE/MAE。
    let train_mean: f64 =
        train_samples.iter().map(|s| s.outcome as f64).sum::<f64>() / train_samples.len() as f64;
    let baseline_mean_mse: f64 = holdout_samples
        .iter()
        .map(|s| (s.outcome as f64 - train_mean).powi(2))
        .sum::<f64>()
        / holdout_samples.len() as f64;
    let baseline_mean_mae: f64 = holdout_samples
        .iter()
        .map(|s| (s.outcome as f64 - train_mean).abs())
        .sum::<f64>()
        / holdout_samples.len() as f64;

    println!("=== 結果 ===");
    println!("訓練誤差:       MSE={train_mse:.4}  MAE={train_mae:.4}");
    println!("ホールドアウト誤差: MSE={holdout_mse:.4}  MAE={holdout_mae:.4}");
    println!(
        "ベースライン(常に0予測):           MSE={baseline_zero_mse:.4}  MAE={baseline_zero_mae:.4}"
    );
    println!(
        "ベースライン(訓練データ平均={train_mean:.4}を予測): MSE={baseline_mean_mse:.4}  MAE={baseline_mean_mae:.4}"
    );

    let out_path = Path::new("train/weights/pattern_v1.bin");
    if let Some(parent) = out_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("重み出力ディレクトリの作成に失敗しました: {e}");
            return ExitCode::FAILURE;
        }
    }
    let bytes = model.to_bytes();
    if let Err(e) = fs::write(out_path, &bytes) {
        eprintln!("重みファイルの書き込みに失敗しました: {e}");
        return ExitCode::FAILURE;
    }
    println!(
        "重みファイルを書き出しました: {} ({}バイト)",
        out_path.display(),
        bytes.len()
    );

    ExitCode::SUCCESS
}

//! T087 Pattern v3 ablation trainer. Existing SGD+L2 is unchanged; only the
//! mechanically generated feature set varies. Each epoch is an atomic,
//! resumable checkpoint and progress is printed before/after every epoch.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::patterns::{self, PatternConfig};
use train::regression::{Model, TrainConfig};
use train::train_data::{self, Sample};
use train::wthor;

fn arg_value(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn config_name(config: PatternConfig) -> &'static str {
    match config {
        PatternConfig::V2 => "v2",
        PatternConfig::V2Diag567 => "v2-diag567",
        PatternConfig::V2Edge2x => "v2-edge2x",
        PatternConfig::V3 => "v3",
        PatternConfig::V2Corner5x2 => "v2-corner5x2",
    }
}

fn parse_config(value: &str) -> PatternConfig {
    match value {
        "v2" => PatternConfig::V2,
        "v2-diag567" => PatternConfig::V2Diag567,
        "v2-edge2x" => PatternConfig::V2Edge2x,
        "v3" => PatternConfig::V3,
        "v2-corner5x2" => PatternConfig::V2Corner5x2,
        _ => panic!("unknown config: {value}"),
    }
}

fn data_files() -> Vec<PathBuf> {
    let mut files: Vec<_> = fs::read_dir("train/data")
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "wtb"))
        .collect();
    files.sort();
    files
}

fn load_games(max_games: Option<usize>) -> Result<Vec<Vec<Sample>>, String> {
    let mut games = Vec::new();
    for path in data_files() {
        let parsed =
            wthor::parse(&fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?)
                .map_err(|e| format!("{}: {e}", path.display()))?;
        for game in parsed.games {
            if let Ok(samples) = train_data::samples_from_game(&game.moves) {
                if !samples.is_empty() {
                    games.push(samples);
                }
            }
            if max_games.is_some_and(|limit| games.len() >= limit) {
                return Ok(games);
            }
        }
    }
    Ok(games)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn latest_checkpoint(dir: &Path) -> Option<(u32, PathBuf)> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let epoch = name
                .strip_prefix("epoch-")?
                .strip_suffix(".bin")?
                .parse()
                .ok()?;
            Some((epoch, path))
        })
        .max_by_key(|(epoch, _)| *epoch)
}

fn main() -> ExitCode {
    let epochs: u32 = arg_value("--epochs").map_or(20, |v| v.parse().unwrap());
    let configs: Vec<_> = arg_value("--configs")
        .unwrap_or_else(|| "v2,v2-diag567,v2-edge2x,v3,v2-corner5x2".to_string())
        .split(',')
        .map(parse_config)
        .collect();
    let seeds: Vec<u64> = arg_value("--seeds")
        .unwrap_or_else(|| "1,2,3".to_string())
        .split(',')
        .map(|v| v.parse().unwrap())
        .collect();
    let max_games = arg_value("--max-games").map(|v| v.parse().unwrap());
    let output_dir =
        PathBuf::from(arg_value("--output-dir").unwrap_or_else(|| "train/data/t087".to_string()));

    let games = match load_games(max_games) {
        Ok(games) if games.len() >= 2 => games,
        Ok(_) => {
            eprintln!("at least two games are required");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("failed to load WTHOR: {e}");
            return ExitCode::FAILURE;
        }
    };
    let holdout_games = ((games.len() as f64) * 0.1).round() as usize;
    let holdout_games = holdout_games.max(1).min(games.len() - 1);
    let split = games.len() - holdout_games;
    let train_samples: Vec<_> = games[..split].iter().flatten().cloned().collect();
    let frozen_samples: Vec<_> = games[split..].iter().flatten().cloned().collect();
    println!(
        "dataset games={} train_games={} frozen_games={} train_samples={} frozen_samples={}",
        games.len(),
        split,
        holdout_games,
        train_samples.len(),
        frozen_samples.len()
    );
    fs::create_dir_all(&output_dir).unwrap();

    let mut rows = String::from("config\tseed\tfrozen_mse\tfrozen_mae\tbytes\n");
    for config in configs {
        for &seed in &seeds {
            let name = config_name(config);
            let run_dir = output_dir.join(format!("{name}-seed-{seed}"));
            fs::create_dir_all(&run_dir).unwrap();
            let final_path = output_dir.join(format!("{name}-seed-{seed}.bin"));
            let (mut model, start_epoch, previous_checkpoint) = if final_path.exists() {
                (
                    Model::from_bytes(&fs::read(&final_path).unwrap()).unwrap(),
                    epochs,
                    None,
                )
            } else if let Some((epoch, path)) = latest_checkpoint(&run_dir) {
                println!("resume config={name} seed={seed} epoch={epoch}");
                (
                    Model::from_bytes(&fs::read(&path).unwrap()).unwrap(),
                    epoch,
                    Some(path),
                )
            } else {
                (Model::new(patterns::generate_patterns_for(config)), 0, None)
            };
            let cfg = TrainConfig {
                seed,
                ..TrainConfig::default()
            };
            let mut previous = previous_checkpoint;
            for epoch in start_epoch..epochs {
                println!(
                    "start config={name} seed={seed} epoch={}/{}",
                    epoch + 1,
                    epochs
                );
                model.train_epochs(&train_samples, &cfg, epoch, 1);
                let checkpoint = run_dir.join(format!("epoch-{:02}.bin", epoch + 1));
                atomic_write(&checkpoint, &model.to_bytes_v3()).unwrap();
                if let Some(old) = previous.take() {
                    if old != checkpoint {
                        fs::remove_file(old).unwrap();
                    }
                }
                previous = Some(checkpoint);
                println!(
                    "saved config={name} seed={seed} epoch={}/{}",
                    epoch + 1,
                    epochs
                );
            }
            let bytes = model.to_bytes_v3();
            atomic_write(&final_path, &bytes).unwrap();
            if let Some(old) = previous {
                if old.exists() {
                    fs::remove_file(old).unwrap();
                }
            }
            let mse = model.mean_squared_error(&frozen_samples);
            let mae = model.mean_absolute_error(&frozen_samples);
            println!(
                "result config={name} seed={seed} frozen_mse={mse:.6} frozen_mae={mae:.6} bytes={}",
                bytes.len()
            );
            rows.push_str(&format!(
                "{name}\t{seed}\t{mse:.6}\t{mae:.6}\t{}\n",
                bytes.len()
            ));
        }
    }
    atomic_write(&output_dir.join("results.tsv"), rows.as_bytes()).unwrap();
    ExitCode::SUCCESS
}

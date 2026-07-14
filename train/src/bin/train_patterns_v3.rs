//! T087 Pattern v3 ablation trainer with run-identity checked epoch resume.

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
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "wtb"))
        .collect();
    files.sort();
    files
}

fn hash_files(files: &[PathBuf]) -> Result<String, String> {
    let mut hash = 0xcbf29ce484222325u64;
    for path in files {
        for byte in path
            .to_string_lossy()
            .as_bytes()
            .iter()
            .copied()
            .chain(fs::read(path).map_err(|e| e.to_string())?)
        {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{hash:016x}"))
}

fn load_games(files: &[PathBuf], max_games: Option<usize>) -> Result<Vec<Vec<Sample>>, String> {
    let mut games = Vec::new();
    for path in files {
        let parsed = wthor::parse(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
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

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    type Bool = i32;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> Bool;
    }
    let old: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let new: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe { MoveFileExW(old.as_ptr(), new.as_ptr(), 0x1 | 0x8) };
    if ok == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temp, destination).map_err(|e| e.to_string())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    replace_file(&temp, path)
}

fn metadata_path(path: &Path) -> PathBuf {
    path.with_extension("meta")
}

fn save_artifact(path: &Path, bytes: &[u8], identity: &str) -> Result<(), String> {
    atomic_write(&metadata_path(path), identity.as_bytes())?;
    atomic_write(path, bytes)
}

fn verify_identity(path: &Path, identity: &str) -> Result<(), String> {
    let actual = fs::read_to_string(metadata_path(path))
        .map_err(|_| format!("missing run identity for {}", path.display()))?;
    if actual != identity {
        return Err(format!(
            "run identity mismatch for {}; refusing resume",
            path.display()
        ));
    }
    Ok(())
}

fn latest_checkpoint(dir: &Path) -> Option<(u32, PathBuf)> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let epoch = path
                .file_name()?
                .to_str()?
                .strip_prefix("epoch-")?
                .strip_suffix(".bin")?
                .parse()
                .ok()?;
            Some((epoch, path))
        })
        .max_by_key(|(epoch, _)| *epoch)
}

fn append_result(path: &Path, row: &str) -> Result<(), String> {
    let mut text = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::from("config\tseed\tfrozen_mse\tfrozen_mae\tbytes\n")
    };
    let key = row.split('\t').take(2).collect::<Vec<_>>().join("\t");
    if !text.lines().skip(1).any(|line| line.starts_with(&key)) {
        text.push_str(row);
        atomic_write(path, text.as_bytes())?;
    }
    Ok(())
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
    let files = data_files();
    let data_hash = match hash_files(&files) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let games = match load_games(&files, max_games) {
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
    let holdout_games = (((games.len() as f64) * 0.1).round() as usize)
        .max(1)
        .min(games.len() - 1);
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

    for config in configs {
        for &seed in &seeds {
            let name = config_name(config);
            let cfg = TrainConfig {
                seed,
                ..TrainConfig::default()
            };
            let identity = format!(
                "schema=2\ndata_hash={data_hash}\nconfig={name}\nseed={seed}\nepochs={epochs}\nmax_games={max_games:?}\nlearning_rate={}\nl2={}\nloss={:?}\n",
                cfg.learning_rate, cfg.l2, cfg.loss);
            let run_dir = output_dir.join(format!("{name}-seed-{seed}"));
            fs::create_dir_all(&run_dir).unwrap();
            let final_path = output_dir.join(format!("{name}-seed-{seed}.bin"));
            let (mut model, start_epoch, previous) = if final_path.exists() {
                if let Err(e) = verify_identity(&final_path, &identity) {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
                (
                    Model::from_bytes(&fs::read(&final_path).unwrap()).unwrap(),
                    epochs,
                    None,
                )
            } else if let Some((epoch, path)) = latest_checkpoint(&run_dir) {
                if let Err(e) = verify_identity(&path, &identity) {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
                println!("resume config={name} seed={seed} epoch={epoch}");
                (
                    Model::from_bytes(&fs::read(&path).unwrap()).unwrap(),
                    epoch,
                    Some(path),
                )
            } else {
                (Model::new(patterns::generate_patterns_for(config)), 0, None)
            };
            let mut previous = previous;
            for epoch in start_epoch..epochs {
                println!(
                    "start config={name} seed={seed} epoch={}/{}",
                    epoch + 1,
                    epochs
                );
                model.train_epochs(&train_samples, &cfg, epoch, 1);
                let checkpoint = run_dir.join(format!("epoch-{:02}.bin", epoch + 1));
                save_artifact(&checkpoint, &model.to_bytes_v3(), &identity).unwrap();
                if let Some(old) = previous.take() {
                    if old != checkpoint {
                        fs::remove_file(metadata_path(&old)).ok();
                        fs::remove_file(old).ok();
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
            save_artifact(&final_path, &bytes, &identity).unwrap();
            if let Some(old) = previous {
                fs::remove_file(metadata_path(&old)).ok();
                fs::remove_file(old).ok();
            }
            let mse = model.mean_squared_error(&frozen_samples);
            let mae = model.mean_absolute_error(&frozen_samples);
            println!(
                "result config={name} seed={seed} frozen_mse={mse:.6} frozen_mae={mae:.6} bytes={}",
                bytes.len()
            );
            append_result(
                &output_dir.join("results.tsv"),
                &format!("{name}\t{seed}\t{mse:.6}\t{mae:.6}\t{}\n", bytes.len()),
            )
            .unwrap();
        }
    }
    ExitCode::SUCCESS
}

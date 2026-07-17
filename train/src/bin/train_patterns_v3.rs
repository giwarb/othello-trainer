//! T087 Pattern v3 ablation trainer with run-identity checked epoch resume.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::pattern_eval::{
    NUM_STAGES, STAGE_EMPTY_DIVISOR, V4_NUM_STAGES, V4_STAGE_EMPTY_DIVISOR,
};
use engine::patterns::{self, PatternConfig};
use train::regression::{Model, TrainConfig};
use train::train_data::{self, Sample};
use train::wthor;

fn arg_value(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

#[derive(Clone, Copy)]
struct TrainingConfig {
    pattern_config: PatternConfig,
    num_stages: usize,
    stage_empty_divisor: u32,
    name: &'static str,
}

fn config_name(config: TrainingConfig) -> &'static str {
    config.name
}

fn legacy_config(pattern_config: PatternConfig, name: &'static str) -> TrainingConfig {
    TrainingConfig {
        pattern_config,
        num_stages: NUM_STAGES,
        stage_empty_divisor: STAGE_EMPTY_DIVISOR,
        name,
    }
}

fn parse_config(value: &str) -> TrainingConfig {
    match value {
        "v2" => legacy_config(PatternConfig::V2, "v2"),
        "v2-diag567" => legacy_config(PatternConfig::V2Diag567, "v2-diag567"),
        "v2-edge2x" => legacy_config(PatternConfig::V2Edge2x, "v2-edge2x"),
        "v3" => legacy_config(PatternConfig::V3, "v3"),
        "v2-corner5x2" => legacy_config(PatternConfig::V2Corner5x2, "v2-corner5x2"),
        "v4" => TrainingConfig {
            pattern_config: PatternConfig::V3,
            num_stages: V4_NUM_STAGES,
            stage_empty_divisor: V4_STAGE_EMPTY_DIVISOR,
            name: "v4",
        },
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

fn shuffle_indices(count: usize, seed: u64) -> Vec<usize> {
    let mut order: Vec<_> = (0..count).collect();
    let mut state = seed.max(1);
    for i in (1..count).rev() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        order.swap(i, state as usize % (i + 1));
    }
    order
}

fn subset_seed_for_phase(seed: u64, phase: usize) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in seed.to_le_bytes().into_iter().chain([phase as u8]) {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// T126: deterministic nested stratified subset of the WTHOR train split.
/// This follows T109: each v4 empty-count phase takes the prefix of one
/// seed-fixed shuffle, with floor(target * phase_count / total) samples.
fn select_train_subset(samples: Vec<Sample>, target: usize, seed: u64) -> Vec<Sample> {
    let total = samples.len();
    if target >= total {
        return samples;
    }
    let mut by_phase: Vec<Vec<usize>> = vec![Vec::new(); V4_NUM_STAGES];
    for (index, sample) in samples.iter().enumerate() {
        let phase = (sample.board.empty_count() as usize).min(V4_NUM_STAGES - 1);
        by_phase[phase].push(index);
    }
    let mut selected = Vec::with_capacity(target);
    for (phase, group) in by_phase.iter().enumerate() {
        if group.is_empty() {
            continue;
        }
        let order = shuffle_indices(group.len(), subset_seed_for_phase(seed, phase));
        let cutpoint = ((target as u128 * group.len() as u128) / total as u128) as usize;
        selected.extend(order[..cutpoint].iter().map(|&local| group[local]));
    }
    selected.sort_unstable();
    let mut slots: Vec<Option<Sample>> = samples.into_iter().map(Some).collect();
    selected
        .into_iter()
        .map(|index| slots[index].take().expect("subset index selected twice"))
        .collect()
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
    let train_subset_size = arg_value("--train-subset-size").map(|v| v.parse::<usize>().unwrap());
    let subset_seed = arg_value("--subset-seed").map_or(42, |v| v.parse::<u64>().unwrap());
    if train_subset_size == Some(0) {
        eprintln!("--train-subset-size must be positive");
        return ExitCode::FAILURE;
    }
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
    let full_train_samples: Vec<_> = games[..split].iter().flatten().cloned().collect();
    let full_train_sample_count = full_train_samples.len();
    let train_samples = match train_subset_size {
        Some(target) => select_train_subset(full_train_samples, target, subset_seed),
        None => full_train_samples,
    };
    let frozen_samples: Vec<_> = games[split..].iter().flatten().cloned().collect();
    println!(
        "dataset games={} train_games={} frozen_games={} train_samples={} full_train_samples={} frozen_samples={} subset_target={:?} subset_seed={}",
        games.len(),
        split,
        holdout_games,
        train_samples.len(),
        full_train_sample_count,
        frozen_samples.len(),
        train_subset_size,
        subset_seed,
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
                "schema=2\ndata_hash={data_hash}\nconfig={name}\nseed={seed}\nepochs={epochs}\nmax_games={max_games:?}\nlearning_rate={}\nl2={}\nloss={:?}\n{}",
                cfg.learning_rate,
                cfg.l2,
                cfg.loss,
                train_subset_size.map_or_else(String::new, |target| format!(
                    "train_subset_size_target={target}\ntrain_subset_size_actual={}\ntrain_subset_seed={subset_seed}\nfull_train_samples={full_train_sample_count}\n",
                    train_samples.len()
                ))
            );
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
                (
                    Model::new_with_stage_definition(
                        patterns::generate_patterns_for(config.pattern_config),
                        config.num_stages,
                        config.stage_empty_divisor,
                    ),
                    0,
                    None,
                )
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

#[cfg(test)]
mod tests {
    use super::*;
    use engine::bitboard::{Board, Side};
    use std::collections::HashSet;
    use train::train_data::LastMoveKind;

    fn fixture_sample(index: usize, empties: usize) -> Sample {
        let filled = 64 - empties;
        let black = if filled == 64 {
            u64::MAX
        } else {
            (1u64 << filled) - 1
        };
        Sample {
            board: Board { black, white: 0 },
            mover: Side::Black,
            outcome: index as f32,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }
    }

    fn ids(samples: &[Sample]) -> HashSet<usize> {
        samples
            .iter()
            .map(|sample| sample.outcome as usize)
            .collect()
    }

    #[test]
    fn wthor_subset_is_deterministic_and_nested() {
        let samples: Vec<_> = (0..1000)
            .map(|index| fixture_sample(index, 4 + index % 57))
            .collect();
        let small = select_train_subset(samples.clone(), 180, 42);
        let again = select_train_subset(samples.clone(), 180, 42);
        let large = select_train_subset(samples, 500, 42);
        assert_eq!(ids(&small), ids(&again));
        assert!(ids(&small).is_subset(&ids(&large)));
        assert!(small.len() <= 180 && small.len() + V4_NUM_STAGES > 180);
    }

    #[test]
    fn wthor_subset_preserves_phase_proportions_by_floor() {
        let samples: Vec<_> = (0..500)
            .map(|index| fixture_sample(index, if index < 400 { 20 } else { 40 }))
            .collect();
        let subset = select_train_subset(samples, 100, 7);
        assert_eq!(
            subset
                .iter()
                .filter(|s| s.board.empty_count() == 20)
                .count(),
            80
        );
        assert_eq!(
            subset
                .iter()
                .filter(|s| s.board.empty_count() == 40)
                .count(),
            20
        );
    }

    #[test]
    fn wthor_subset_at_or_above_total_preserves_all_samples() {
        let samples: Vec<_> = (0..10).map(|index| fixture_sample(index, 20)).collect();
        assert_eq!(select_train_subset(samples.clone(), 10, 1).len(), 10);
        assert_eq!(select_train_subset(samples, 20, 1).len(), 10);
    }
}

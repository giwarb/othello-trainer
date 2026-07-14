//! T088 v2 training-method ablation runner.

use std::borrow::Cow;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::experiment::{self, CanonicalKey, CanonicalRecord, SamplingConfig};
use crate::regression::{Loss, Model, TrainConfig};
use crate::train_data::Sample;
use crate::{train_data, wthor};
use engine::patterns;

#[derive(Clone)]
struct GameSamples {
    year: u16,
    samples: Vec<Sample>,
}

#[derive(Clone, Copy)]
struct Method {
    number: u8,
    canonical: bool,
    huber: bool,
    early: bool,
    stage: bool,
    xc: bool,
}

impl Method {
    fn from_number(number: u8) -> Result<Self, String> {
        if !(1..=8).contains(&number) {
            return Err(format!("invalid config {number}"));
        }
        Ok(Self {
            number,
            canonical: number >= 3,
            huber: number >= 4,
            early: number >= 5,
            stage: number == 6 || number == 8,
            xc: number == 7 || number == 8,
        })
    }
}

fn value(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn flag(name: &str) -> bool {
    env::args().any(|arg| arg == name)
}

fn data_files() -> Vec<PathBuf> {
    let mut files: Vec<_> = fs::read_dir("train/data")
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "wtb"))
        .collect();
    files.sort();
    files
}

fn fnv_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn load_games(max_games: Option<usize>) -> Result<(Vec<GameSamples>, String), String> {
    let mut games = Vec::new();
    let mut hash = 0xcbf29ce484222325u64;
    for path in data_files() {
        let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        hash = fnv_update(hash, path.to_string_lossy().as_bytes());
        hash = fnv_update(hash, &bytes);
        let file = wthor::parse(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        let year = file.header.year_of_games;
        let mut loaded_from_file = 0usize;
        for game in &file.games {
            if let Ok(samples) = train_data::samples_from_game(&game.moves) {
                if !samples.is_empty() {
                    games.push(GameSamples { year, samples });
                    loaded_from_file += 1;
                }
            }
            if max_games.is_some_and(|limit| loaded_from_file >= limit) {
                break;
            }
        }
    }
    Ok((games, format!("{hash:016x}")))
}

fn records_to_samples(map: HashMap<CanonicalKey, CanonicalRecord>) -> Vec<Sample> {
    let mut records: Vec<_> = map.into_iter().collect();
    records.sort_by_key(|(key, _)| *key);
    records
        .into_iter()
        .map(|(_, record)| record.sample)
        .collect()
}

fn canonical_year_split(games: &[GameSamples]) -> (Vec<Sample>, Vec<Sample>, Vec<Sample>, String) {
    let mut train_raw = Vec::new();
    let mut validation_raw = Vec::new();
    let mut test_raw = Vec::new();
    for game in games {
        let target = if game.year <= 2022 {
            &mut train_raw
        } else if game.year == 2023 {
            &mut validation_raw
        } else {
            &mut test_raw
        };
        target.extend(
            game.samples
                .iter()
                .copied()
                .map(|sample| (game.year, sample)),
        );
    }
    let mut train = experiment::aggregate(&train_raw);
    let mut validation = experiment::aggregate(&validation_raw);
    let test = experiment::aggregate(&test_raw);
    let train_occurrences: usize = train.values().map(|r| r.occurrences as usize).sum();
    let validation_occurrences: usize = validation.values().map(|r| r.occurrences as usize).sum();
    let test_occurrences: usize = test.values().map(|r| r.occurrences as usize).sum();
    let train_variance_mean =
        train.values().map(|r| r.variance as f64).sum::<f64>() / train.len().max(1) as f64;
    let test_x = test.values().map(|r| r.last_move_x).sum::<u32>();
    let test_c = test.values().map(|r| r.last_move_c).sum::<u32>();
    let test_other = test.values().map(|r| r.last_move_other).sum::<u32>();
    let test_vulnerable = test
        .values()
        .map(|r| r.vulnerable_xc_occurrences)
        .sum::<u32>();
    let years = (
        train.values().map(|r| r.year).min().unwrap_or(0),
        train.values().map(|r| r.year).max().unwrap_or(0),
        validation.values().map(|r| r.year).min().unwrap_or(0),
        test.values().map(|r| r.year).min().unwrap_or(0),
    );
    let phases = train.values().fold([0usize; 13], |mut counts, record| {
        counts[record.phase] += 1;
        counts
    });
    let leaks = experiment::remove_cross_split_leaks(&mut train, &mut validation, &test);
    let manifest = format!(
        "split_train=2015-2022\nsplit_validation=2023\nsplit_test=2024\n\
         train_keys={}\nvalidation_keys={}\ntest_keys={}\n\
         train_occurrences={train_occurrences}\nvalidation_occurrences={validation_occurrences}\n\
         test_occurrences={test_occurrences}\ntrain_removed_by_validation={}\n\
         train_removed_by_test={}\nvalidation_removed_by_test={}\n\
         train_mean_outcome_variance={train_variance_mean:.6}\n\
         retained_years={}-{},validation={},test={}\ntrain_phase_counts={phases:?}\n\
         test_last_move_counts=other:{test_other},x:{test_x},c:{test_c},vulnerable:{test_vulnerable}\n",
        train.len(), validation.len(), test.len(),
        leaks.train_keys_removed_by_validation, leaks.train_keys_removed_by_test,
        leaks.validation_keys_removed_by_test, years.0, years.1, years.2, years.3);
    (
        records_to_samples(train),
        records_to_samples(validation),
        records_to_samples(test),
        manifest,
    )
}

fn raw_year_split(games: &[GameSamples]) -> (Vec<Sample>, Vec<Sample>) {
    let mut train = Vec::new();
    let mut validation = Vec::new();
    for game in games {
        if game.year <= 2022 {
            train.extend_from_slice(&game.samples);
        } else if game.year == 2023 {
            validation.extend_from_slice(&game.samples);
        }
    }
    (train, validation)
}

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

fn baseline_split(games: &[GameSamples], seed: u64) -> (Vec<Sample>, Vec<Sample>) {
    let mut eligible: Vec<_> = games.iter().filter(|g| g.year <= 2023).collect();
    let mut rng = Rng::new(seed);
    for i in (1..eligible.len()).rev() {
        let j = (rng.next() % (i as u64 + 1)) as usize;
        eligible.swap(i, j);
    }
    let validation_games = (((eligible.len() as f64) * 0.1).round() as usize)
        .max(1)
        .min(eligible.len() - 1);
    let split = eligible.len() - validation_games;
    let train = eligible[..split]
        .iter()
        .flat_map(|g| g.samples.iter().copied())
        .collect();
    let validation = eligible[split..]
        .iter()
        .flat_map(|g| g.samples.iter().copied())
        .collect();
    (train, validation)
}

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(old: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let old: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let new: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(old.as_ptr(), new.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temp, destination).map_err(|e| e.to_string())
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp, contents).map_err(|e| e.to_string())?;
    replace_file(&temp, path)
}

fn parse_state(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn latest_checkpoint(dir: &Path) -> Option<(u32, PathBuf, PathBuf)> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let weights = entry.path();
            let epoch = weights
                .file_name()?
                .to_str()?
                .strip_prefix("epoch-")?
                .strip_suffix(".bin")?
                .parse()
                .ok()?;
            let state = weights.with_extension("state");
            state.exists().then_some((epoch, weights, state))
        })
        .max_by_key(|(epoch, _, _)| *epoch)
}

fn metric(model: &Model, samples: &[Sample]) -> (f64, f64) {
    (
        model.mean_squared_error(samples),
        model.mean_absolute_error(samples),
    )
}

fn xc_metrics(model: &Model, samples: &[Sample]) -> (usize, f64, f64) {
    let vulnerable: Vec<_> = samples
        .iter()
        .filter(|sample| sample.vulnerable_xc)
        .collect();
    if vulnerable.is_empty() {
        return (0, 0.0, 0.0);
    }
    let errors: Vec<_> = vulnerable
        .iter()
        .map(|sample| (model.predict(&sample.board, sample.mover) - sample.outcome).abs() as f64)
        .collect();
    let high = errors.iter().filter(|&&error| error >= 8.0).count() as f64 / errors.len() as f64;
    let mae = errors.iter().sum::<f64>() / errors.len() as f64;
    (errors.len(), high, mae)
}

fn append_result(path: &Path, key: &str, row: &str) -> Result<(), String> {
    let mut text = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::from("config\tseed\tbest_epoch\tepochs\tvalidation_mae\ttest_mae\ttest_mse\txc_count\txc_high_loss_rate\txc_mae\tbytes\tmanifest_hash\n")
    };
    if !text.lines().skip(1).any(|line| line.starts_with(key)) {
        text.push_str(row);
        atomic_write(path, text.as_bytes())?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_one(
    method: Method,
    seed: u64,
    games: &[GameSamples],
    data_hash: &str,
    canonical_train: &[Sample],
    canonical_validation: &[Sample],
    common_test: &[Sample],
    common_manifest: &str,
    root: &Path,
    huber_delta: f32,
    l2: f32,
    xc_multiplier: f64,
    xc_cap: f64,
    validation_only: bool,
) -> Result<(), String> {
    let (train, validation, manifest): (Cow<'_, [Sample]>, Cow<'_, [Sample]>, String) = if method
        .number
        == 1
    {
        let (owned_train, owned_validation) = baseline_split(games, seed);
        let manifest = format!("split=random_game_90_10_2015_2023\ntrain_samples={}\nvalidation_samples={}\n{common_manifest}",
                               owned_train.len(), owned_validation.len());
        (
            Cow::Owned(owned_train),
            Cow::Owned(owned_validation),
            manifest,
        )
    } else if method.canonical {
        (
            Cow::Borrowed(canonical_train),
            Cow::Borrowed(canonical_validation),
            common_manifest.to_string(),
        )
    } else {
        let (owned_train, owned_validation) = raw_year_split(games);
        let manifest = format!("split_train=2015-2022\nsplit_validation=2023\nsplit_test=2024\ntrain_samples={}\nvalidation_samples={}\n{common_manifest}",
                               owned_train.len(), owned_validation.len());
        (
            Cow::Owned(owned_train),
            Cow::Owned(owned_validation),
            manifest,
        )
    };
    let manifest_hash = format!(
        "{:016x}",
        fnv_update(0xcbf29ce484222325, manifest.as_bytes())
    );
    let run_name = format!("config-{}-seed-{seed}", method.number);
    let dir = root.join(&run_name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("manifest.txt"), manifest.as_bytes())?;
    let max_epochs = if method.early { 60 } else { 20 };
    let identity = format!(
        "schema=2\ndata_hash={data_hash}\nmanifest_hash={manifest_hash}\nconfig={}\nseed={seed}\n\
         max_epochs={max_epochs}\nhuber_delta={huber_delta}\nl2={l2}\n\
         stage={}\nxc_multiplier={xc_multiplier}\nxc_cap={xc_cap}\nvalidation_only={validation_only}\n",
        method.number, method.stage,);
    let identity_path = dir.join("identity.txt");
    if identity_path.exists()
        && fs::read_to_string(&identity_path).map_err(|e| e.to_string())? != identity
    {
        return Err(format!(
            "run identity mismatch for {run_name}; refusing resume"
        ));
    }
    atomic_write(&identity_path, identity.as_bytes())?;

    let best_path = dir.join("best.bin");
    let mut model = Model::new(patterns::generate_patterns());
    let mut epoch = 0u32;
    let mut learning_rate = 0.005f32;
    let mut best_mae = f64::INFINITY;
    let mut patience_mae = f64::INFINITY;
    let mut best_epoch = 0u32;
    let mut stale = 0u32;
    let mut since_decay = 0u32;
    let mut previous_checkpoint = None;
    if let Some((checkpoint_epoch, weights_path, state_path)) = latest_checkpoint(&dir) {
        model = Model::from_bytes(&fs::read(&weights_path).map_err(|e| e.to_string())?)?;
        let state = parse_state(&fs::read_to_string(&state_path).map_err(|e| e.to_string())?);
        epoch = state["epoch"].parse().map_err(|_| "bad epoch")?;
        if epoch != checkpoint_epoch {
            return Err(format!("checkpoint epoch mismatch for {run_name}"));
        }
        learning_rate = state["learning_rate"]
            .parse()
            .map_err(|_| "bad learning rate")?;
        best_mae = state["best_mae"].parse().map_err(|_| "bad best mae")?;
        patience_mae = state["patience_mae"]
            .parse()
            .map_err(|_| "bad patience mae")?;
        best_epoch = state["best_epoch"].parse().map_err(|_| "bad best epoch")?;
        stale = state["stale"].parse().map_err(|_| "bad stale")?;
        since_decay = state["since_decay"].parse().map_err(|_| "bad decay")?;
        previous_checkpoint = Some((weights_path, state_path));
        println!("resume run={run_name} epoch={epoch}");
    }
    let metrics_path = dir.join("metrics.tsv");
    if !metrics_path.exists() {
        atomic_write(
            &metrics_path,
            b"epoch\tlearning_rate\ttrain_mse\ttrain_mae\tvalidation_mse\tvalidation_mae\n",
        )?;
    }
    while epoch < max_epochs && (!method.early || stale < 5) {
        let config = TrainConfig {
            learning_rate,
            l2,
            epochs: 1,
            seed,
            loss: if method.huber {
                Loss::Huber { delta: huber_delta }
            } else {
                Loss::Mse
            },
        };
        let order = experiment::sampling_order(
            train.as_ref(),
            SamplingConfig {
                stage_sampling: method.stage,
                xc_multiplier: if method.xc { xc_multiplier } else { 1.0 },
                xc_cap: if method.xc { xc_cap } else { 1.0 },
            },
            seed ^ epoch as u64,
        );
        println!("start run={run_name} epoch={}/{}", epoch + 1, max_epochs);
        model.train_order(train.as_ref(), &config, &order);
        epoch += 1;
        let (train_mse, train_mae) = metric(&model, train.as_ref());
        let (validation_mse, validation_mae) = metric(&model, validation.as_ref());
        let absolute_best = validation_mae < best_mae;
        let meaningful = validation_mae + 0.02 <= patience_mae;
        if absolute_best {
            best_mae = validation_mae;
            best_epoch = epoch;
            atomic_write(&best_path, &model.to_bytes_v3())?;
        }
        if meaningful {
            patience_mae = validation_mae;
            stale = 0;
            since_decay = 0;
        } else {
            stale += 1;
            since_decay += 1;
        }
        if method.early && since_decay >= 2 && learning_rate > 0.0003125 {
            learning_rate = (learning_rate * 0.5).max(0.0003125);
            since_decay = 0;
        }
        let mut metrics = fs::read_to_string(&metrics_path).map_err(|e| e.to_string())?;
        metrics.push_str(&format!("{epoch}\t{learning_rate:.7}\t{train_mse:.6}\t{train_mae:.6}\t{validation_mse:.6}\t{validation_mae:.6}\n"));
        atomic_write(&metrics_path, metrics.as_bytes())?;
        let state = format!("epoch={epoch}\nlearning_rate={learning_rate}\nbest_mae={best_mae}\npatience_mae={patience_mae}\nbest_epoch={best_epoch}\nstale={stale}\nsince_decay={since_decay}\nshuffle_seed={}\nmanifest_hash={manifest_hash}\n",
                            seed ^ (epoch - 1) as u64);
        let weights_path = dir.join(format!("epoch-{epoch:02}.bin"));
        let state_path = weights_path.with_extension("state");
        atomic_write(&state_path, state.as_bytes())?;
        atomic_write(&weights_path, &model.to_bytes_v3())?;
        if let Some((old_weights, old_state)) =
            previous_checkpoint.replace((weights_path, state_path))
        {
            fs::remove_file(old_weights).ok();
            fs::remove_file(old_state).ok();
        }
        println!("saved run={run_name} epoch={epoch} validation_mae={validation_mae:.6}");
    }
    let best = Model::from_bytes(&fs::read(&best_path).map_err(|e| e.to_string())?)?;
    let (_, validation_mae) = metric(&best, validation.as_ref());
    let (test_mse, test_mae, xc_count, xc_high, xc_mae) = if validation_only {
        (f64::NAN, f64::NAN, 0, f64::NAN, f64::NAN)
    } else {
        let (mse, mae) = metric(&best, common_test);
        let (count, high, xc_mae) = xc_metrics(&best, common_test);
        (mse, mae, count, high, xc_mae)
    };
    let bytes = best.to_bytes_v3();
    atomic_write(&dir.join("final.bin"), &bytes)?;
    atomic_write(&dir.join("complete.txt"), identity.as_bytes())?;
    let key = format!("{}\t{seed}\t", method.number);
    let row = format!("{}\t{seed}\t{best_epoch}\t{epoch}\t{validation_mae:.6}\t{test_mae:.6}\t{test_mse:.6}\t{xc_count}\t{xc_high:.6}\t{xc_mae:.6}\t{}\t{manifest_hash}\n",
                      method.number, bytes.len());
    append_result(&root.join("results.tsv"), &key, &row)
}

pub fn run() -> ExitCode {
    let configs: Vec<u8> = value("--configs")
        .unwrap_or_else(|| "1,2,3,4,5,6,7,8".into())
        .split(',')
        .map(|v| v.parse().unwrap())
        .collect();
    let seeds: Vec<u64> = value("--seeds")
        .unwrap_or_else(|| "1,2,3".into())
        .split(',')
        .map(|v| v.parse().unwrap())
        .collect();
    let checkpoint_dir = match value("--checkpoint-dir") {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!("--checkpoint-dir is required");
            return ExitCode::FAILURE;
        }
    };
    let huber_delta = value("--huber-delta").map_or(8.0, |v| v.parse().unwrap());
    let l2 = value("--l2").map_or(1e-5, |v| v.parse().unwrap());
    let xc_multiplier = value("--xc-oversample").map_or(3.0, |v| v.parse().unwrap());
    let xc_cap = value("--xc-cap").map_or(0.25, |v| v.parse().unwrap());
    let max_games = value("--max-games").map(|v| v.parse().unwrap());
    let validation_only = flag("--validation-only");
    let (games, data_hash) = match load_games(max_games) {
        Ok(value) if value.0.len() >= 2 => value,
        Ok(_) => {
            eprintln!("at least two games are required");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let (canonical_train, canonical_validation, common_test, common_manifest) =
        canonical_year_split(&games);
    if common_test.is_empty() && !validation_only {
        eprintln!("frozen 2024 test set is empty");
        return ExitCode::FAILURE;
    }
    fs::create_dir_all(&checkpoint_dir).unwrap();
    if let Some(reference_path) = value("--reference-weights") {
        let reference = match fs::read(&reference_path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| Model::from_bytes(&bytes))
        {
            Ok(model) => model,
            Err(e) => {
                eprintln!("failed to load reference weights: {e}");
                return ExitCode::FAILURE;
            }
        };
        let (test_mse, test_mae) = metric(&reference, &common_test);
        let (xc_count, xc_high, xc_mae) = xc_metrics(&reference, &common_test);
        let row = format!(
            "reference\tpath={reference_path}\tleaky_2015_2024=true\ttest_mae={test_mae:.6}\t\
             test_mse={test_mse:.6}\txc_count={xc_count}\txc_high_loss_rate={xc_high:.6}\t\
             xc_mae={xc_mae:.6}\n"
        );
        if let Err(e) = atomic_write(&checkpoint_dir.join("reference.tsv"), row.as_bytes()) {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
        print!("{row}");
    }
    println!(
        "dataset games={} hash={} frozen_canonical={}",
        games.len(),
        data_hash,
        common_test.len()
    );
    for number in configs {
        let method = match Method::from_number(number) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        };
        for &seed in &seeds {
            if let Err(e) = run_one(
                method,
                seed,
                &games,
                &data_hash,
                &canonical_train,
                &canonical_validation,
                &common_test,
                &common_manifest,
                &checkpoint_dir,
                huber_delta,
                l2,
                xc_multiplier,
                xc_cap,
                validation_only,
            ) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

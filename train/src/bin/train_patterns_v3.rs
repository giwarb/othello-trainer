//! T087 Pattern v3 ablation trainer with run-identity checked epoch resume.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::pattern_eval::{
    scalar_features, ScalarFeatureKind, NUM_STAGES, STAGE_EMPTY_DIVISOR, V4_NUM_STAGES,
    V4_STAGE_EMPTY_DIVISOR,
};
use engine::patterns::{self, PatternConfig};
use serde::Serialize;
use train::regression::{Model, TrainConfig};
use train::simple_corpus;
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
    scalar_features: &'static [ScalarFeatureKind],
    t158: bool,
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
        scalar_features: &[],
        t158: false,
    }
}

const MOBILITY: &[ScalarFeatureKind] = &[ScalarFeatureKind::ExactMobilityAdvantage];
const EXPOSURE: &[ScalarFeatureKind] = &[ScalarFeatureKind::EmptyAdjacencyExposureAdvantage];
const BOTH: &[ScalarFeatureKind] = &[
    ScalarFeatureKind::ExactMobilityAdvantage,
    ScalarFeatureKind::EmptyAdjacencyExposureAdvantage,
];

fn t158_config(
    name: &'static str,
    scalar_features: &'static [ScalarFeatureKind],
) -> TrainingConfig {
    TrainingConfig {
        pattern_config: PatternConfig::V3,
        num_stages: V4_NUM_STAGES,
        stage_empty_divisor: V4_STAGE_EMPTY_DIVISOR,
        name,
        scalar_features,
        t158: true,
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
            scalar_features: &[],
            t158: false,
        },
        "t158-b0" => t158_config("t158-b0", &[]),
        "t158-b1" => t158_config("t158-b1", MOBILITY),
        "t158-b2" => t158_config("t158-b2", EXPOSURE),
        "t158-b3" => t158_config("t158-b3", BOTH),
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

#[derive(Serialize)]
struct StageMetrics {
    empty_count: usize,
    count: usize,
    mae: f64,
}

#[derive(Serialize)]
struct ScalarCoefficients {
    kind: &'static str,
    scale_shift: u8,
    weights: Vec<f32>,
}

#[derive(Serialize)]
struct T158RunMetrics {
    schema_version: u32,
    config: &'static str,
    seed: u64,
    train_samples: usize,
    frozen_samples: usize,
    frozen_games: usize,
    train_mse: f64,
    train_mae: f64,
    frozen_mse: f64,
    frozen_mae: f64,
    stage_metrics: Vec<StageMetrics>,
    game_mae: Vec<f64>,
    scalar_coefficients: Vec<ScalarCoefficients>,
}

fn scalar_kind_name(kind: ScalarFeatureKind) -> &'static str {
    match kind {
        ScalarFeatureKind::ExactMobilityAdvantage => "exact_mobility_advantage",
        ScalarFeatureKind::EmptyAdjacencyExposureAdvantage => "empty_adjacency_exposure_advantage",
    }
}

fn mean_absolute_error(model: &Model, samples: &[Sample]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples
        .iter()
        .map(|sample| {
            (model.predict(&sample.board, sample.mover) as f64 - sample.outcome as f64).abs()
        })
        .sum::<f64>()
        / samples.len() as f64
}

fn write_t158_metrics(
    path: &Path,
    config: TrainingConfig,
    seed: u64,
    model: &Model,
    train_samples: &[Sample],
    frozen_samples: &[Sample],
    frozen_games: &[Vec<Sample>],
) -> Result<(), String> {
    let mut stage_metrics = Vec::with_capacity(V4_NUM_STAGES);
    for empty_count in 0..V4_NUM_STAGES {
        let stage_samples: Vec<_> = frozen_samples
            .iter()
            .filter(|sample| sample.board.empty_count() as usize == empty_count)
            .cloned()
            .collect();
        stage_metrics.push(StageMetrics {
            empty_count,
            count: stage_samples.len(),
            mae: mean_absolute_error(model, &stage_samples),
        });
    }
    let metrics = T158RunMetrics {
        schema_version: 1,
        config: config.name,
        seed,
        train_samples: train_samples.len(),
        frozen_samples: frozen_samples.len(),
        frozen_games: frozen_games.len(),
        train_mse: model.mean_squared_error(train_samples),
        train_mae: model.mean_absolute_error(train_samples),
        frozen_mse: model.mean_squared_error(frozen_samples),
        frozen_mae: model.mean_absolute_error(frozen_samples),
        stage_metrics,
        game_mae: frozen_games
            .iter()
            .map(|game| mean_absolute_error(model, game))
            .collect(),
        scalar_coefficients: model
            .weights
            .scalar_feature_weights
            .iter()
            .map(|feature| ScalarCoefficients {
                kind: scalar_kind_name(feature.kind),
                scale_shift: feature.scale_shift,
                weights: feature.weights.clone(),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&metrics).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
}

#[derive(Serialize)]
struct DistributionSummary {
    count: usize,
    p50_abs: i32,
    p95_abs: i32,
    p99_abs: i32,
    max_abs: i32,
    min_signed: i32,
    max_signed: i32,
    scale_shift: u8,
}

#[derive(Serialize)]
struct FeatureDistribution {
    schema_version: u32,
    split: &'static str,
    mobility: DistributionSummary,
    exposure: DistributionSummary,
}

fn summarize_distribution(mut values: Vec<i32>, scale_shift: u8) -> DistributionSummary {
    let min_signed = values.iter().copied().min().unwrap_or(0);
    let max_signed = values.iter().copied().max().unwrap_or(0);
    for value in &mut values {
        *value = value.abs();
    }
    values.sort_unstable();
    let percentile = |percent: usize| {
        if values.is_empty() {
            0
        } else {
            values[((values.len() * percent).div_ceil(100)).saturating_sub(1)]
        }
    };
    DistributionSummary {
        count: values.len(),
        p50_abs: percentile(50),
        p95_abs: percentile(95),
        p99_abs: percentile(99),
        max_abs: values.last().copied().unwrap_or(0),
        min_signed,
        max_signed,
        scale_shift,
    }
}

fn write_feature_distribution(path: &Path, samples: &[Sample]) -> Result<(), String> {
    let mut mobility = Vec::with_capacity(samples.len());
    let mut exposure = Vec::with_capacity(samples.len());
    for sample in samples {
        let values = scalar_features(&sample.board, sample.mover);
        mobility.push(values.exact_mobility_advantage);
        exposure.push(values.empty_adjacency_exposure_advantage);
    }
    let distribution = FeatureDistribution {
        schema_version: 1,
        split: "WTHOR train games before optional stratified subset",
        mobility: summarize_distribution(
            mobility,
            ScalarFeatureKind::ExactMobilityAdvantage.scale_shift(),
        ),
        exposure: summarize_distribution(
            exposure,
            ScalarFeatureKind::EmptyAdjacencyExposureAdvantage.scale_shift(),
        ),
    };
    let bytes = serde_json::to_vec_pretty(&distribution).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
}

/// T155: 1つの(config, seed)についての学習ループ本体(checkpoint保存/resume・
/// epochループ・最終frozen評価・results.tsv追記)。従来`main`に直接書かれていた
/// 処理をそのまま関数として切り出しただけで、ロジックは一切変更していない
/// (WTHOR既定経路からの呼び出しでは、この抽出前後でidentity文字列・保存内容・
/// 出力とも完全に同一になる)。`--simple-corpus`モードもこの同じ関数を呼ぶことで、
/// checkpoint/resume・atomic保存等の挙動を1箇所に保つ。
fn run_config_seed(
    config: TrainingConfig,
    seed: u64,
    epochs: u32,
    identity: &str,
    output_dir: &Path,
    train_samples: &[Sample],
    frozen_samples: &[Sample],
    frozen_games: &[Vec<Sample>],
) -> Result<(), String> {
    let name = config_name(config);
    let cfg = TrainConfig {
        seed,
        ..TrainConfig::default()
    };
    let run_dir = output_dir.join(format!("{name}-seed-{seed}"));
    fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
    let final_path = output_dir.join(format!("{name}-seed-{seed}.bin"));
    let (mut model, start_epoch, previous) = if final_path.exists() {
        verify_identity(&final_path, identity)?;
        (
            Model::from_bytes(&fs::read(&final_path).unwrap()).unwrap(),
            epochs,
            None,
        )
    } else if let Some((epoch, path)) = latest_checkpoint(&run_dir) {
        verify_identity(&path, identity)?;
        println!("resume config={name} seed={seed} epoch={epoch}");
        (
            Model::from_bytes(&fs::read(&path).unwrap()).unwrap(),
            epoch,
            Some(path),
        )
    } else {
        (
            Model::new_with_scalar_features(
                patterns::generate_patterns_for(config.pattern_config),
                config.num_stages,
                config.stage_empty_divisor,
                config.scalar_features,
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
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        model.train_epochs(train_samples, &cfg, epoch, 1);
        let checkpoint = run_dir.join(format!("epoch-{:02}.bin", epoch + 1));
        let checkpoint_bytes = if config.scalar_features.is_empty() {
            model.to_bytes_v3()
        } else {
            model.to_bytes_v4()
        };
        save_artifact(&checkpoint, &checkpoint_bytes, identity)?;
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
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }
    let bytes = if config.scalar_features.is_empty() {
        model.to_bytes_v3()
    } else {
        model.to_bytes_v4()
    };
    save_artifact(&final_path, &bytes, identity)?;
    if let Some(old) = previous {
        fs::remove_file(metadata_path(&old)).ok();
        fs::remove_file(old).ok();
    }
    let mse = model.mean_squared_error(frozen_samples);
    let mae = model.mean_absolute_error(frozen_samples);
    println!(
        "result config={name} seed={seed} frozen_mse={mse:.6} frozen_mae={mae:.6} bytes={}",
        bytes.len()
    );
    if config.t158 {
        write_t158_metrics(
            &output_dir.join(format!("{name}-seed-{seed}.metrics.json")),
            config,
            seed,
            &model,
            train_samples,
            frozen_samples,
            frozen_games,
        )?;
    }
    append_result(
        &output_dir.join("results.tsv"),
        &format!("{name}\t{seed}\t{mse:.6}\t{mae:.6}\t{}\n", bytes.len()),
    )
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
    let simple_corpus_arg = arg_value("--simple-corpus");
    let simple_max_records = arg_value("--simple-max-records").map(|v| v.parse::<usize>().unwrap());

    // T155: `--simple-corpus`(簡易レコード: 64文字盤面+スコア)モード。
    // WTHOR学習(既定挙動)とは完全に独立した分岐であり、`--max-games`/
    // `--train-subset-size`(WTHOR側のフィルタ)とは意味が異なるため、
    // 組み合わせての指定は誤用として拒否する(黙って無視すると気付きにくい
    // ミスに繋がるため)。
    if simple_corpus_arg.is_some() {
        if max_games.is_some() {
            eprintln!("--max-games is not supported together with --simple-corpus");
            return ExitCode::FAILURE;
        }
        if train_subset_size.is_some() {
            eprintln!("--train-subset-size is not supported together with --simple-corpus");
            return ExitCode::FAILURE;
        }
        if configs.iter().any(|config| config.t158) {
            eprintln!("T158 configs require the WTHOR game split");
            return ExitCode::FAILURE;
        }
    } else if simple_max_records.is_some() {
        eprintln!("--simple-max-records requires --simple-corpus");
        return ExitCode::FAILURE;
    }

    fs::create_dir_all(&output_dir).unwrap();

    if let Some(simple_corpus_path) = simple_corpus_arg {
        // T155簡易コーパス経路: 対局概念が無いため、局面ハッシュ分割
        // (`simple_corpus::split_by_position_hash`)でtrain/frozenを分ける。
        // `--subset-seed`(既定42)はここではreservoir samplingのseedとして
        // 流用する(WTHOR経路の層化サブセットseedと同じCLI引数を、意味の異なる
        // 別モードで再利用しているだけで、両モードは同時に有効にならない)。
        let path = PathBuf::from(&simple_corpus_path);
        let files = match simple_corpus::list_simple_corpus_files(&path) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        };
        let (pool, corpus_hash, total_lines) =
            match simple_corpus::load_simple_corpus(&files, simple_max_records, subset_seed) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
        let pool_size = pool.len();
        let (train_samples, frozen_samples) = simple_corpus::split_by_position_hash(pool);
        println!(
            "simple_corpus_dataset path={simple_corpus_path} total_lines={total_lines} pool_size={pool_size} max_records={simple_max_records:?} reservoir_seed={subset_seed} corpus_hash={corpus_hash} train_samples={} frozen_samples={}",
            train_samples.len(),
            frozen_samples.len(),
        );

        for config in configs {
            for &seed in &seeds {
                let name = config_name(config);
                let cfg = TrainConfig {
                    seed,
                    ..TrainConfig::default()
                };
                let identity = format!(
                    "schema=2-simple\nsimple_corpus_path={simple_corpus_path}\nsimple_corpus_hash={corpus_hash}\nsimple_corpus_total_lines={total_lines}\nsimple_max_records={simple_max_records:?}\nreservoir_seed={subset_seed}\nconfig={name}\nseed={seed}\nepochs={epochs}\nlearning_rate={}\nl2={}\nloss={:?}\ntrain_samples={}\nfrozen_samples={}\n",
                    cfg.learning_rate,
                    cfg.l2,
                    cfg.loss,
                    train_samples.len(),
                    frozen_samples.len(),
                );
                if let Err(e) = run_config_seed(
                    config,
                    seed,
                    epochs,
                    &identity,
                    &output_dir,
                    &train_samples,
                    &frozen_samples,
                    &[],
                ) {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        return ExitCode::SUCCESS;
    }

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
    if configs.iter().any(|config| config.t158) {
        let distribution_path = output_dir.join("feature-distribution.json");
        if let Err(e) = write_feature_distribution(&distribution_path, &full_train_samples) {
            eprintln!("failed to write feature distribution: {e}");
            return ExitCode::FAILURE;
        }
        println!("feature_distribution path={}", distribution_path.display());
    }
    let train_samples = match train_subset_size {
        Some(target) => select_train_subset(full_train_samples, target, subset_seed),
        None => full_train_samples,
    };
    let frozen_games = games[split..].to_vec();
    let frozen_samples: Vec<_> = frozen_games.iter().flatten().cloned().collect();
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

    for config in configs {
        for &seed in &seeds {
            let name = config_name(config);
            let cfg = TrainConfig {
                seed,
                ..TrainConfig::default()
            };
            let subset_identity = train_subset_size.map_or_else(String::new, |target| format!(
                "train_subset_size_target={target}\ntrain_subset_size_actual={}\ntrain_subset_seed={subset_seed}\nfull_train_samples={full_train_sample_count}\n",
                train_samples.len()
            ));
            let identity = if config.t158 {
                let feature_schema = config
                    .scalar_features
                    .iter()
                    .map(|kind| {
                        format!(
                            "{}:/{}",
                            scalar_kind_name(*kind),
                            1u32 << kind.scale_shift()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "schema=3-t158\ndata_hash={data_hash}\nconfig={name}\nseed={seed}\nepochs={epochs}\nmax_games={max_games:?}\nlearning_rate={}\nl2={}\nloss={:?}\ntrain_games={split}\nfrozen_games={holdout_games}\ntrain_samples={}\nfrozen_samples={}\nfeature_schema={feature_schema}\n{}",
                    cfg.learning_rate,
                    cfg.l2,
                    cfg.loss,
                    train_samples.len(),
                    frozen_samples.len(),
                    subset_identity,
                )
            } else {
                format!(
                    "schema=2\ndata_hash={data_hash}\nconfig={name}\nseed={seed}\nepochs={epochs}\nmax_games={max_games:?}\nlearning_rate={}\nl2={}\nloss={:?}\n{}",
                    cfg.learning_rate,
                    cfg.l2,
                    cfg.loss,
                    subset_identity,
                )
            };
            if let Err(e) = run_config_seed(
                config,
                seed,
                epochs,
                &identity,
                &output_dir,
                &train_samples,
                &frozen_samples,
                &frozen_games,
            ) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
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

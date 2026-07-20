//! T087 Pattern v3 ablation trainer with run-identity checked epoch resume.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::bitboard::Side;
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

/// T159: 値を取らない真偽フラグ(`--early-stop`)の存在確認。
/// `arg_value`は`--name value`という2要素の並びしか見つけられないため、
/// 単独で置かれるフラグには別途これを使う。
fn flag_present(name: &str) -> bool {
    env::args().any(|a| a == name)
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

/// T159: 対局(1ゲーム分のサンプル列)の内容から決定的なFNVハッシュを計算する。
/// 対局の並び順や`--subset-seed`等の乱数シードに一切依存せず、同一データなら
/// 常に同じ値になる(`split_early_stop_validation`が検証splitの割当に使う)。
fn early_stop_game_hash(game: &[Sample]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut update = |byte: u8| {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    };
    for sample in game {
        for byte in sample.board.black.to_le_bytes() {
            update(byte);
        }
        for byte in sample.board.white.to_le_bytes() {
            update(byte);
        }
        update(match sample.mover {
            Side::Black => 0,
            Side::White => 1,
        });
        for byte in sample.outcome.to_bits().to_le_bytes() {
            update(byte);
        }
    }
    hash
}

/// T159: train側の対局集合から、早期打ち切り監視用の検証splitを対局単位で
/// 決定的に切り出す。`early_stop_game_hash`(対局内容のFNVハッシュ)を
/// `1_000_000`で割った剰余をバケットとして使い、`val_percent`に応じた閾値
/// 未満なら検証側に割り当てる。対局の並び順にもseedにも依存しないため、
/// 同一データであれば`train_subset_size`等の指定に関わらず常に同じ分割になる
/// (既存のfrozen holdout・層化サブセット選択とは完全に独立した処理)。
fn split_early_stop_validation(
    games: &[Vec<Sample>],
    val_percent: f64,
) -> (Vec<Vec<Sample>>, Vec<Vec<Sample>>) {
    let threshold = ((val_percent / 100.0) * 1_000_000.0)
        .round()
        .clamp(0.0, 1_000_000.0) as u64;
    let mut train = Vec::with_capacity(games.len());
    let mut validation = Vec::new();
    for game in games {
        if early_stop_game_hash(game) % 1_000_000 < threshold {
            validation.push(game.clone());
        } else {
            train.push(game.clone());
        }
    }
    (train, validation)
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

// T159: 早期打ち切り(`--early-stop`)専用の成果物群。既存の`append_result`
// (`results.tsv`)とは列数・意味が異なるため、別ファイル`results-earlystop.tsv`に
// 追記する(既存ファイルのスキーマを変えないため)。同様にcheckpoint/最終成果物の
// パス名にも`-earlystop`サフィックスを付け、OFF経路の成果物と物理的に衝突しない
// ようにしている。

fn append_result_earlystop(path: &Path, row: &str) -> Result<(), String> {
    let mut text = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::from("config\tseed\tbest_epoch\tepochs_run\tfrozen_mse\tfrozen_mae\tbytes\n")
    };
    // T159bレビュー軽微4対処: キーは必ず区切り文字(タブ)込みで前方一致させる。
    // `starts_with(&key)`だけだと`"v3\t1"`が既存行`"v3\t12\t..."`にも前方一致して
    // しまい、seed 12 の結果が先にある状態で seed 1 を追記すると黙って捨てられる
    // (T159の`append_result`から複製された既知パターン。ここでのみ修正する)。
    let key = row.split('\t').take(2).collect::<Vec<_>>().join("\t");
    let key_prefix = format!("{key}\t");
    if !text.lines().skip(1).any(|line| line.starts_with(&key_prefix)) {
        text.push_str(row);
        atomic_write(path, text.as_bytes())?;
    }
    Ok(())
}

// T159bレビュー中1対処: `best_epoch`/`best_val_mae`列を追加し、各行が
// resume状態(`EarlyStopState`)を単独で再構成できる自己完結した記録にする
// (`recover_early_stop_state`参照)。
const EARLY_STOP_METRICS_HEADER: &str =
    "epoch\ttrain_mse\ttrain_mae\tval_mae\tis_best\tstale\tbest_epoch\tbest_val_mae";

/// 早期打ち切りのエポック別メトリクスファイルのヘッダを確保する
/// (`train::t090_distillation`の`ensure_metrics_header`と同じ考え方: 無ければ
/// 現行ヘッダで新規作成、あれば一致を確認して列ずれのままresumeしない)。
fn ensure_early_stop_metrics_header(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return atomic_write(path, format!("{EARLY_STOP_METRICS_HEADER}\n").as_bytes());
    }
    let existing = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let header = existing.lines().next().unwrap_or("");
    if header != EARLY_STOP_METRICS_HEADER {
        return Err(format!(
            "early-stop metrics header mismatch in {}: expected \"{EARLY_STOP_METRICS_HEADER}\", found \"{header}\"",
            path.display()
        ));
    }
    Ok(())
}

/// resume時、直前のクラッシュで`completed_epoch`より先の行が残っていた場合に
/// 切り詰める(`t090_distillation::truncate_metrics_after`と同じ考え方)。
fn truncate_early_stop_metrics_after(path: &Path, completed_epoch: u32) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    let mut kept = String::new();
    if let Some(header) = lines.next() {
        kept.push_str(header);
        kept.push('\n');
    }
    for line in lines {
        let Some(field) = line.split('\t').next() else {
            continue;
        };
        let row_epoch: u32 = field
            .parse()
            .map_err(|_| format!("invalid early-stop metrics epoch {field}"))?;
        if row_epoch <= completed_epoch {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    atomic_write(path, kept.as_bytes())
}

#[allow(clippy::too_many_arguments)]
fn append_early_stop_metrics_row(
    path: &Path,
    epoch: u32,
    train_mse: f64,
    train_mae: f64,
    val_mae: f64,
    is_best: bool,
    stale: u32,
    best_epoch: u32,
    best_val_mae: f64,
) -> Result<(), String> {
    let mut text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    text.push_str(&format!(
        "{epoch}\t{train_mse:.6}\t{train_mae:.6}\t{val_mae:.6}\t{is_best}\t{stale}\t{best_epoch}\t{best_val_mae:.6}\n"
    ));
    atomic_write(path, text.as_bytes())
}

/// T159bレビュー中1対処: `metrics.tsv`の該当エポック行から`EarlyStopState`を
/// 再構成する(各行が epoch/best_epoch/best_val_mae/stale を全て持つため、
/// `state.txt`が無くても・古くても復旧に使える)。
fn read_early_stop_metrics_row(path: &Path, epoch: u32) -> Result<EarlyStopState, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("cannot read {} for recovery: {e}", path.display()))?;
    let row = text
        .lines()
        .skip(1)
        .find(|line| line.split('\t').next() == Some(&epoch.to_string()))
        .ok_or_else(|| format!("no metrics row for epoch {epoch} in {}", path.display()))?;
    let fields: Vec<&str> = row.split('\t').collect();
    if fields.len() != 8 {
        return Err(format!(
            "malformed metrics row for epoch {epoch} in {}: expected 8 columns, found {}",
            path.display(),
            fields.len()
        ));
    }
    let stale: u32 = fields[5]
        .parse()
        .map_err(|_| format!("bad stale column in metrics row for epoch {epoch}"))?;
    let best_epoch: u32 = fields[6]
        .parse()
        .map_err(|_| format!("bad best_epoch column in metrics row for epoch {epoch}"))?;
    let best_val_mae: f64 = fields[7]
        .parse()
        .map_err(|_| format!("bad best_val_mae column in metrics row for epoch {epoch}"))?;
    Ok(EarlyStopState {
        epoch,
        best_epoch,
        best_val_mae,
        stale,
    })
}

/// resume用に永続化する早期打ち切りの状態(直近完了エポック・ベスト更新状況・
/// 連続未改善エポック数)。
#[derive(Debug)]
struct EarlyStopState {
    epoch: u32,
    best_epoch: u32,
    best_val_mae: f64,
    stale: u32,
}

fn write_early_stop_state(
    path: &Path,
    epoch: u32,
    best_epoch: u32,
    best_val_mae: f64,
    stale: u32,
) -> Result<(), String> {
    let text = format!(
        "epoch={epoch}\nbest_epoch={best_epoch}\nbest_val_mae={best_val_mae}\nstale={stale}\n"
    );
    atomic_write(path, text.as_bytes())
}

fn read_early_stop_state(path: &Path) -> Result<EarlyStopState, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("missing early-stop state {}: {e}", path.display()))?;
    let map: std::collections::HashMap<&str, &str> =
        text.lines().filter_map(|line| line.split_once('=')).collect();
    let field = |name: &str| map.get(name).copied().ok_or_else(|| format!("early-stop state {} missing field {name}", path.display()));
    Ok(EarlyStopState {
        epoch: field("epoch")?
            .parse()
            .map_err(|_| "bad early-stop state epoch".to_string())?,
        best_epoch: field("best_epoch")?
            .parse()
            .map_err(|_| "bad early-stop state best_epoch".to_string())?,
        best_val_mae: field("best_val_mae")?
            .parse()
            .map_err(|_| "bad early-stop state best_val_mae".to_string())?,
        stale: field("stale")?
            .parse()
            .map_err(|_| "bad early-stop state stale".to_string())?,
    })
}

/// T159bレビュー中1対処: resume時のcheckpoint/state突合を、単純な等号一致だけで
/// なく「既知の脆弱窓」からの自動復旧付きで行う。
///
/// 書き込み順序は常に「(best.bin) → metrics行追記 → checkpoint → state.txt」
/// なので、checkpoint(epoch=N)が存在するならmetrics行(epoch=N)は必ず既に
/// 書かれている。よって以下の2つのクラッシュ断面はmetrics.tsvから自己復旧できる:
/// - `state.txt`のepochがcheckpointよりちょうど1つ遅れている
///   (checkpoint保存後・state.txt書き込み前にクラッシュ)
/// - `state.txt`自体が読めない(さらに早い段階、state.txt作成前にクラッシュ)
///
/// それ以外の食い違い(2エポック以上のズレ等)は復旧不能な破損として扱い、
/// 手動復旧手順を含むエラーで停止する(fail-closedを維持)。
fn recover_early_stop_state(
    state_path: &Path,
    metrics_path: &Path,
    checkpoint_epoch: u32,
    context: &str,
) -> Result<EarlyStopState, String> {
    let manual_recovery_hint = "manual recovery: delete the newest epoch-*.bin and epoch-*.meta \
         under the run directory (the one matching the checkpoint epoch mentioned above), then resume again";
    match read_early_stop_state(state_path) {
        Ok(state) if state.epoch == checkpoint_epoch => Ok(state),
        Ok(state) if state.epoch + 1 == checkpoint_epoch => {
            let recovered = read_early_stop_metrics_row(metrics_path, checkpoint_epoch).map_err(|e| {
                format!(
                    "{context}: checkpoint epoch {checkpoint_epoch} is ahead of state.txt epoch {} \
                     (crash between checkpoint save and state.txt write) and metrics-based recovery \
                     failed: {e}; {manual_recovery_hint}",
                    state.epoch
                )
            })?;
            write_early_stop_state(
                state_path,
                recovered.epoch,
                recovered.best_epoch,
                recovered.best_val_mae,
                recovered.stale,
            )?;
            println!(
                "recovered early-stop state for {context} from metrics.tsv \
                 (checkpoint epoch {checkpoint_epoch} was ahead of state.txt epoch {}; \
                 this is the known checkpoint-before-state crash window)",
                state.epoch
            );
            Ok(recovered)
        }
        Ok(state) => Err(format!(
            "{context}: early-stop checkpoint epoch mismatch (checkpoint={checkpoint_epoch}, \
             state.txt={}); this gap is larger than the known checkpoint-before-state crash window \
             and cannot be auto-recovered. {manual_recovery_hint}",
            state.epoch
        )),
        Err(state_err) => read_early_stop_metrics_row(metrics_path, checkpoint_epoch)
            .map_err(|metrics_err| {
                format!(
                    "{context}: state.txt is missing or unreadable ({state_err}) and metrics-based \
                     recovery also failed ({metrics_err}); {manual_recovery_hint}"
                )
            })
            .and_then(|recovered| {
                write_early_stop_state(
                    state_path,
                    recovered.epoch,
                    recovered.best_epoch,
                    recovered.best_val_mae,
                    recovered.stale,
                )?;
                println!(
                    "recovered early-stop state for {context} from metrics.tsv \
                     (state.txt was missing or unreadable: {state_err})"
                );
                Ok(recovered)
            }),
    }
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

/// T159: 早期打ち切り(`--early-stop`)ONのときのベスト/patience更新判定。
/// 改善判定の閾値(min-delta)は0とし、タイの場合は先に見つかったエポックを
/// 保持する(`val_mae < best_val_mae`という厳密不等号がこれを保証する)。
/// 純粋関数として切り出すことで、実際のSGD学習を伴わずに単体テストできる。
fn apply_early_stop_step(
    val_mae: f64,
    current_epoch: u32,
    best_val_mae: f64,
    best_epoch: u32,
    stale: u32,
) -> (bool, f64, u32, u32) {
    if val_mae < best_val_mae {
        (true, val_mae, current_epoch, 0)
    } else {
        (false, best_val_mae, best_epoch, stale + 1)
    }
}

/// T159: 早期打ち切りONのときの最終結果報告(frozen評価・t158メトリクス・
/// `results-earlystop.tsv`追記)。ループ終了直後の経路と、既に完了済みだった
/// runをスキップする経路の両方から呼ぶ共通処理。
#[allow(clippy::too_many_arguments)]
fn finalize_early_stop_result(
    config: TrainingConfig,
    name: &str,
    seed: u64,
    best_epoch: u32,
    epochs_run: u32,
    best_bytes: &[u8],
    train_samples: &[Sample],
    frozen_samples: &[Sample],
    frozen_games: &[Vec<Sample>],
    output_dir: &Path,
) -> Result<(), String> {
    let best_model = Model::from_bytes(best_bytes)?;
    let frozen_mse = best_model.mean_squared_error(frozen_samples);
    let frozen_mae = best_model.mean_absolute_error(frozen_samples);
    println!(
        "result config={name} seed={seed} best_epoch={best_epoch} epochs_run={epochs_run} frozen_mse={frozen_mse:.6} frozen_mae={frozen_mae:.6} bytes={} (early-stop)",
        best_bytes.len()
    );
    if config.t158 {
        write_t158_metrics(
            &output_dir.join(format!("{name}-seed-{seed}-earlystop.metrics.json")),
            config,
            seed,
            &best_model,
            train_samples,
            frozen_samples,
            frozen_games,
        )?;
    }
    append_result_earlystop(
        &output_dir.join("results-earlystop.tsv"),
        &format!(
            "{name}\t{seed}\t{best_epoch}\t{epochs_run}\t{frozen_mse:.6}\t{frozen_mae:.6}\t{}\n",
            best_bytes.len()
        ),
    )
}

/// T159: 早期打ち切りONのときの1つの(config, seed)についての学習ループ本体。
/// `run_config_seed`(OFF経路)とは意図的に完全に別関数にし、ファイルパスにも
/// `-earlystop`サフィックスを付けている(既存のcheckpoint/最終成果物と物理的に
/// 衝突しないため、OFF経路の出力に一切影響しないことをコード上でも保証する)。
///
/// アルゴリズム: 各エポック終了時に検証split(`val_samples`)のMAEを測定し、
/// ベスト値を更新したときだけ`best.bin`にその時点の重みを保存する。
/// `patience`エポック連続でベスト値を更新できなければ打ち切り、`best.bin`を
/// 最終成果物として採用する(最後に学習したエポックの重みではない)。
/// resumeは通常のcheckpoint(`epoch-XX.bin`)に加え、`state.txt`
/// (直近完了エポック・ベストエポック・ベストMAE・stale数)を読み書きすることで、
/// 中断後もbest追跡状態を含めて再開できる。
#[allow(clippy::too_many_arguments)]
fn run_config_seed_early_stop(
    config: TrainingConfig,
    seed: u64,
    identity: &str,
    output_dir: &Path,
    max_epochs: u32,
    patience: u32,
    train_samples: &[Sample],
    val_samples: &[Sample],
    frozen_samples: &[Sample],
    frozen_games: &[Vec<Sample>],
) -> Result<(), String> {
    let name = config_name(config);
    let cfg = TrainConfig {
        seed,
        ..TrainConfig::default()
    };
    let run_dir = output_dir.join(format!("{name}-seed-{seed}-earlystop"));
    fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
    let final_path = output_dir.join(format!("{name}-seed-{seed}-earlystop.bin"));
    let best_path = run_dir.join("best.bin");
    let state_path = run_dir.join("state.txt");
    let metrics_path = output_dir.join(format!("{name}-seed-{seed}-earlystop.metrics.tsv"));

    if final_path.exists() {
        verify_identity(&final_path, identity)?;
        let state = read_early_stop_state(&state_path)?;
        println!(
            "skip config={name} seed={seed} epoch={} (early-stop already complete)",
            state.epoch
        );
        let best_bytes = fs::read(&final_path).map_err(|e| e.to_string())?;
        return finalize_early_stop_result(
            config,
            name,
            seed,
            state.best_epoch,
            state.epoch,
            &best_bytes,
            train_samples,
            frozen_samples,
            frozen_games,
            output_dir,
        );
    }

    let (mut model, mut epoch, mut best_epoch, mut best_val_mae, mut stale) =
        if let Some((checkpoint_epoch, path)) = latest_checkpoint(&run_dir) {
            verify_identity(&path, identity)?;
            let state = recover_early_stop_state(
                &state_path,
                &metrics_path,
                checkpoint_epoch,
                &format!("config={name} seed={seed} (early-stop)"),
            )?;
            println!("resume config={name} seed={seed} epoch={checkpoint_epoch} (early-stop)");
            (
                Model::from_bytes(&fs::read(&path).unwrap()).unwrap(),
                state.epoch,
                state.best_epoch,
                state.best_val_mae,
                state.stale,
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
                0,
                f64::INFINITY,
                0,
            )
        };

    ensure_early_stop_metrics_header(&metrics_path)?;
    truncate_early_stop_metrics_after(&metrics_path, epoch)?;

    let mut previous_checkpoint: Option<PathBuf> = if epoch > 0 {
        Some(run_dir.join(format!("epoch-{epoch:02}.bin")))
    } else {
        None
    };

    while epoch < max_epochs && stale < patience {
        println!(
            "start config={name} seed={seed} epoch={}/{} (early-stop)",
            epoch + 1,
            max_epochs
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        model.train_epochs(train_samples, &cfg, epoch, 1);
        epoch += 1;

        let train_mse = model.mean_squared_error(train_samples);
        let train_mae = model.mean_absolute_error(train_samples);
        let val_mae = model.mean_absolute_error(val_samples);
        let (is_best, new_best_val_mae, new_best_epoch, new_stale) =
            apply_early_stop_step(val_mae, epoch, best_val_mae, best_epoch, stale);
        best_val_mae = new_best_val_mae;
        best_epoch = new_best_epoch;
        stale = new_stale;
        if is_best {
            let best_bytes = if config.scalar_features.is_empty() {
                model.to_bytes_v3()
            } else {
                model.to_bytes_v4()
            };
            save_artifact(&best_path, &best_bytes, identity)?;
        }
        append_early_stop_metrics_row(
            &metrics_path,
            epoch,
            train_mse,
            train_mae,
            val_mae,
            is_best,
            stale,
            best_epoch,
            best_val_mae,
        )?;

        let checkpoint = run_dir.join(format!("epoch-{epoch:02}.bin"));
        let checkpoint_bytes = if config.scalar_features.is_empty() {
            model.to_bytes_v3()
        } else {
            model.to_bytes_v4()
        };
        save_artifact(&checkpoint, &checkpoint_bytes, identity)?;
        write_early_stop_state(&state_path, epoch, best_epoch, best_val_mae, stale)?;
        if let Some(old) = previous_checkpoint.take() {
            if old != checkpoint {
                fs::remove_file(metadata_path(&old)).ok();
                fs::remove_file(old).ok();
            }
        }
        previous_checkpoint = Some(checkpoint);
        println!(
            "saved config={name} seed={seed} epoch={epoch}/{max_epochs} val_mae={val_mae:.6} best_epoch={best_epoch} stale={stale}/{patience} (early-stop)"
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }

    let best_bytes =
        fs::read(&best_path).map_err(|e| format!("missing early-stop best checkpoint: {e}"))?;
    save_artifact(&final_path, &best_bytes, identity)?;
    if let Some(old) = previous_checkpoint {
        fs::remove_file(metadata_path(&old)).ok();
        fs::remove_file(old).ok();
    }
    finalize_early_stop_result(
        config,
        name,
        seed,
        best_epoch,
        epoch,
        &best_bytes,
        train_samples,
        frozen_samples,
        frozen_games,
        output_dir,
    )
}

/// T159b: 早期打ち切りON時の`--simple-corpus`(Egaroucid)経路本体。
/// `run_config_seed_early_stop`(WTHOR経路、T159実装・本タスクでは変更していない)
/// とは意図的に別関数にしている。差分は2点だけ:
/// (1) `frozen_games`(対局リスト)を持たない(simple-corpusには対局概念が無く、
///     t158系configもガードで使えないため、t158メトリクス出力は発生しない)。
/// (2) T159bレビュー中2対処として、毎エポックの評価を`val_mae`の1回だけに
///     抑える。学習ステップに`Model::train_epoch_with_running_loss`を使い、
///     学習パス中に集計した(更新前予測に基づく)誤差をtrain損失として使う。
///     従来の`model.train_epochs`+`mean_squared_error`+`mean_absolute_error`
///     (学習後に全量を2回再評価する追加フルパス)は行わない。
/// resume(checkpoint/best.bin/state.txt、`recover_early_stop_state`による
/// 脆弱窓からの自動復旧を含む)・identity検証・metrics記録は
/// `run_config_seed_early_stop`と同じ共有ヘルパーをそのまま再利用する。
#[allow(clippy::too_many_arguments)]
fn run_config_seed_early_stop_simple(
    config: TrainingConfig,
    seed: u64,
    identity: &str,
    output_dir: &Path,
    max_epochs: u32,
    patience: u32,
    train_samples: &[Sample],
    val_samples: &[Sample],
    frozen_samples: &[Sample],
) -> Result<(), String> {
    let name = config_name(config);
    let cfg = TrainConfig {
        seed,
        ..TrainConfig::default()
    };
    let run_dir = output_dir.join(format!("{name}-seed-{seed}-earlystop"));
    fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
    let final_path = output_dir.join(format!("{name}-seed-{seed}-earlystop.bin"));
    let best_path = run_dir.join("best.bin");
    let state_path = run_dir.join("state.txt");
    let metrics_path = output_dir.join(format!("{name}-seed-{seed}-earlystop.metrics.tsv"));

    if final_path.exists() {
        verify_identity(&final_path, identity)?;
        let state = read_early_stop_state(&state_path)?;
        println!(
            "skip config={name} seed={seed} epoch={} (early-stop simple-corpus already complete)",
            state.epoch
        );
        let best_bytes = fs::read(&final_path).map_err(|e| e.to_string())?;
        return finalize_early_stop_result(
            config,
            name,
            seed,
            state.best_epoch,
            state.epoch,
            &best_bytes,
            train_samples,
            frozen_samples,
            &[],
            output_dir,
        );
    }

    let (mut model, mut epoch, mut best_epoch, mut best_val_mae, mut stale) =
        if let Some((checkpoint_epoch, path)) = latest_checkpoint(&run_dir) {
            verify_identity(&path, identity)?;
            let state = recover_early_stop_state(
                &state_path,
                &metrics_path,
                checkpoint_epoch,
                &format!("config={name} seed={seed} (early-stop simple-corpus)"),
            )?;
            println!(
                "resume config={name} seed={seed} epoch={checkpoint_epoch} (early-stop simple-corpus)"
            );
            (
                Model::from_bytes(&fs::read(&path).unwrap()).unwrap(),
                state.epoch,
                state.best_epoch,
                state.best_val_mae,
                state.stale,
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
                0,
                f64::INFINITY,
                0,
            )
        };

    ensure_early_stop_metrics_header(&metrics_path)?;
    truncate_early_stop_metrics_after(&metrics_path, epoch)?;

    let mut previous_checkpoint: Option<PathBuf> = if epoch > 0 {
        Some(run_dir.join(format!("epoch-{epoch:02}.bin")))
    } else {
        None
    };

    while epoch < max_epochs && stale < patience {
        println!(
            "start config={name} seed={seed} epoch={}/{} (early-stop simple-corpus)",
            epoch + 1,
            max_epochs
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        // T159bレビュー中2対処: 学習パス中に集計した誤差をtrain損失として使い、
        // 学習後の追加フルパスを行わない(フルパス評価はval_maeの1回のみ)。
        let (train_mse, train_mae) =
            model.train_epoch_with_running_loss(train_samples, &cfg, epoch);
        epoch += 1;

        let val_mae = model.mean_absolute_error(val_samples);
        let (is_best, new_best_val_mae, new_best_epoch, new_stale) =
            apply_early_stop_step(val_mae, epoch, best_val_mae, best_epoch, stale);
        best_val_mae = new_best_val_mae;
        best_epoch = new_best_epoch;
        stale = new_stale;
        if is_best {
            let best_bytes = if config.scalar_features.is_empty() {
                model.to_bytes_v3()
            } else {
                model.to_bytes_v4()
            };
            save_artifact(&best_path, &best_bytes, identity)?;
        }
        append_early_stop_metrics_row(
            &metrics_path,
            epoch,
            train_mse,
            train_mae,
            val_mae,
            is_best,
            stale,
            best_epoch,
            best_val_mae,
        )?;

        let checkpoint = run_dir.join(format!("epoch-{epoch:02}.bin"));
        let checkpoint_bytes = if config.scalar_features.is_empty() {
            model.to_bytes_v3()
        } else {
            model.to_bytes_v4()
        };
        save_artifact(&checkpoint, &checkpoint_bytes, identity)?;
        write_early_stop_state(&state_path, epoch, best_epoch, best_val_mae, stale)?;
        if let Some(old) = previous_checkpoint.take() {
            if old != checkpoint {
                fs::remove_file(metadata_path(&old)).ok();
                fs::remove_file(old).ok();
            }
        }
        previous_checkpoint = Some(checkpoint);
        println!(
            "saved config={name} seed={seed} epoch={epoch}/{max_epochs} val_mae={val_mae:.6} best_epoch={best_epoch} stale={stale}/{patience} (early-stop simple-corpus)"
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }

    let best_bytes =
        fs::read(&best_path).map_err(|e| format!("missing early-stop best checkpoint: {e}"))?;
    save_artifact(&final_path, &best_bytes, identity)?;
    if let Some(old) = previous_checkpoint {
        fs::remove_file(metadata_path(&old)).ok();
        fs::remove_file(old).ok();
    }
    finalize_early_stop_result(
        config,
        name,
        seed,
        best_epoch,
        epoch,
        &best_bytes,
        train_samples,
        frozen_samples,
        &[],
        output_dir,
    )
}

/// T159b: 早期打ち切りON時の`--simple-corpus`本体(CLI引数の受け渡し・
/// データ分割・config×seedループ)。`main`の`--simple-corpus`分岐内で
/// `load_simple_corpus`直後に呼ばれる(既存OFF経路のコード
/// `simple_corpus::split_by_position_hash`以降は一切通らない)。
#[allow(clippy::too_many_arguments)]
fn run_early_stop_simple_corpus(
    pool: Vec<Sample>,
    simple_corpus_path: &str,
    corpus_hash: &str,
    total_lines: usize,
    simple_max_records: Option<usize>,
    reservoir_seed: u64,
    output_dir: &Path,
    configs: &[TrainingConfig],
    seeds: &[u64],
    val_percent: f64,
    patience: u32,
    max_epochs: u32,
) -> ExitCode {
    let pool_size = pool.len();
    let (train_samples, val_samples, frozen_samples) =
        simple_corpus::split_for_early_stop(pool, val_percent);
    if train_samples.is_empty() {
        eprintln!(
            "early-stop validation split left no training samples; lower --early-stop-val-percent"
        );
        return ExitCode::FAILURE;
    }
    if val_samples.is_empty() {
        eprintln!(
            "early-stop validation split produced no validation samples; raise --early-stop-val-percent or add data"
        );
        return ExitCode::FAILURE;
    }
    println!(
        "simple_corpus_dataset path={simple_corpus_path} total_lines={total_lines} pool_size={pool_size} max_records={simple_max_records:?} reservoir_seed={reservoir_seed} corpus_hash={corpus_hash} train_samples={} val_samples={} frozen_samples={} early_stop_val_percent={val_percent} early_stop_patience={patience} max_epochs={max_epochs}",
        train_samples.len(),
        val_samples.len(),
        frozen_samples.len(),
    );

    for &config in configs {
        for &seed in seeds {
            let name = config_name(config);
            let cfg = TrainConfig {
                seed,
                ..TrainConfig::default()
            };
            // T159bレビュー所見(観点5-4): reservoir sampling後のpool分割なので、
            // 決定性はpoolの決定性(corpus_hash+reservoir_seed+max_records)に
            // 載る。これらを全てidentityに含める。
            let identity = format!(
                "schema=6-earlystop-simple\nsimple_corpus_path={simple_corpus_path}\nsimple_corpus_hash={corpus_hash}\nsimple_corpus_total_lines={total_lines}\nsimple_max_records={simple_max_records:?}\nreservoir_seed={reservoir_seed}\nconfig={name}\nseed={seed}\nmax_epochs={max_epochs}\nearly_stop_patience={patience}\nearly_stop_val_percent={val_percent}\nlearning_rate={}\nl2={}\nloss={:?}\ntrain_samples={}\nval_samples={}\nfrozen_samples={}\n",
                cfg.learning_rate,
                cfg.l2,
                cfg.loss,
                train_samples.len(),
                val_samples.len(),
                frozen_samples.len(),
            );
            if let Err(e) = run_config_seed_early_stop_simple(
                config,
                seed,
                &identity,
                output_dir,
                max_epochs,
                patience,
                &train_samples,
                &val_samples,
                &frozen_samples,
            ) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

/// T159: 早期打ち切りON時のWTHOR経路本体。`main`のOFF経路(既存コード、
/// 本タスクでは一切変更していない)とは`games`読み込み直後で分岐する別関数に
/// することで、OFF経路のコードパスにこの関数が一切混ざらないようにしている。
#[allow(clippy::too_many_arguments)]
fn run_early_stop_wthor(
    games: &[Vec<Sample>],
    data_hash: &str,
    output_dir: &Path,
    configs: &[TrainingConfig],
    seeds: &[u64],
    max_games: Option<usize>,
    train_subset_size: Option<usize>,
    subset_seed: u64,
    val_percent: f64,
    patience: u32,
    max_epochs: u32,
) -> ExitCode {
    let holdout_games = (((games.len() as f64) * 0.1).round() as usize)
        .max(1)
        .min(games.len() - 1);
    let split = games.len() - holdout_games;
    let train_games = &games[..split];
    let frozen_games = games[split..].to_vec();
    let frozen_samples: Vec<_> = frozen_games.iter().flatten().cloned().collect();

    let (es_train_games, es_val_games) = split_early_stop_validation(train_games, val_percent);
    if es_train_games.is_empty() {
        eprintln!(
            "early-stop validation split left no training games; lower --early-stop-val-percent"
        );
        return ExitCode::FAILURE;
    }
    if es_val_games.is_empty() {
        eprintln!(
            "early-stop validation split produced no validation games; raise --early-stop-val-percent or add data"
        );
        return ExitCode::FAILURE;
    }

    let full_train_samples: Vec<_> = es_train_games.iter().flatten().cloned().collect();
    let val_samples: Vec<_> = es_val_games.iter().flatten().cloned().collect();

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

    println!(
        "dataset games={} train_games={} frozen_games={} early_stop_train_games={} early_stop_val_games={} train_samples={} val_samples={} frozen_samples={} subset_target={:?} subset_seed={} early_stop_val_percent={val_percent} early_stop_patience={patience} max_epochs={max_epochs}",
        games.len(),
        split,
        holdout_games,
        es_train_games.len(),
        es_val_games.len(),
        train_samples.len(),
        val_samples.len(),
        frozen_samples.len(),
        train_subset_size,
        subset_seed,
    );

    for &config in configs {
        for &seed in seeds {
            let name = config_name(config);
            let cfg = TrainConfig {
                seed,
                ..TrainConfig::default()
            };
            let subset_identity = train_subset_size.map_or_else(
                String::new,
                |target| {
                    format!(
                        "train_subset_size_target={target}\ntrain_subset_size_actual={}\ntrain_subset_seed={subset_seed}\n",
                        train_samples.len()
                    )
                },
            );
            let feature_schema = if config.t158 {
                config
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
                    .join(",")
            } else {
                String::new()
            };
            let identity = format!(
                "schema=5-earlystop\ndata_hash={data_hash}\nconfig={name}\nseed={seed}\nmax_epochs={max_epochs}\nearly_stop_patience={patience}\nearly_stop_val_percent={val_percent}\nmax_games={max_games:?}\nlearning_rate={}\nl2={}\nloss={:?}\ntrain_games={split}\nfrozen_games={holdout_games}\nearly_stop_train_games={}\nearly_stop_val_games={}\ntrain_samples={}\nval_samples={}\nfeature_schema={feature_schema}\n{}",
                cfg.learning_rate,
                cfg.l2,
                cfg.loss,
                es_train_games.len(),
                es_val_games.len(),
                train_samples.len(),
                val_samples.len(),
                subset_identity,
            );
            if let Err(e) = run_config_seed_early_stop(
                config,
                seed,
                &identity,
                output_dir,
                max_epochs,
                patience,
                &train_samples,
                &val_samples,
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

    // T159: `--early-stop`(既定OFF)は本関数の末尾にある通常のWTHOR学習ループを
    // 一切通らず、`run_early_stop_wthor`という完全に別の関数に分岐する。
    // これにより既存のOFF経路(このフラグが立っていない場合の挙動)のコードは
    // 一切変更されず、出力(重みバイナリ・identity・checkpoint)はこの変更の
    // 前後で完全にビット一致する。
    let early_stop = flag_present("--early-stop");
    let early_stop_val_percent: f64 = arg_value("--early-stop-val-percent").map_or(5.0, |v| v.parse().unwrap());
    let early_stop_patience: u32 = arg_value("--early-stop-patience").map_or(3, |v| v.parse().unwrap());
    let early_stop_max_epochs: u32 = arg_value("--max-epochs").map_or(20, |v| v.parse().unwrap());

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
        // T159b: `--simple-corpus`には対局概念が無いため、早期打ち切りの検証splitは
        // 局面(position)単位のハッシュ分割にする(`simple_corpus::split_for_early_stop`、
        // 対局境界を復元できないことをEgaroucid実データで確認済み。詳細は作業ログ)。
        // T159時点の「併用不可」ガードはここで解除する。
    } else if simple_max_records.is_some() {
        eprintln!("--simple-max-records requires --simple-corpus");
        return ExitCode::FAILURE;
    }

    if early_stop {
        if !(early_stop_val_percent > 0.0 && early_stop_val_percent < 100.0) {
            eprintln!("--early-stop-val-percent must be in (0, 100)");
            return ExitCode::FAILURE;
        }
        if early_stop_patience < 1 {
            eprintln!("--early-stop-patience must be >= 1");
            return ExitCode::FAILURE;
        }
        if early_stop_max_epochs < 1 {
            eprintln!("--max-epochs must be >= 1");
            return ExitCode::FAILURE;
        }
        // T159bレビュー軽微8対処: `--epochs`はearly-stop時には使われない
        // (エポック数の上限は`--max-epochs`が担う)。黙って無視すると
        // `--epochs 30 --early-stop`のように打ったユーザーが既定の
        // `--max-epochs 20`で走っていることに気づきにくいため警告する。
        if arg_value("--epochs").is_some() {
            eprintln!(
                "warning: --epochs is ignored when --early-stop is set; the epoch cap is controlled by --max-epochs (default 20)"
            );
        }
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

        if early_stop {
            return run_early_stop_simple_corpus(
                pool,
                &simple_corpus_path,
                &corpus_hash,
                total_lines,
                simple_max_records,
                subset_seed,
                &output_dir,
                &configs,
                &seeds,
                early_stop_val_percent,
                early_stop_patience,
                early_stop_max_epochs,
            );
        }

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

    if early_stop {
        return run_early_stop_wthor(
            &games,
            &data_hash,
            &output_dir,
            &configs,
            &seeds,
            max_games,
            train_subset_size,
            subset_seed,
            early_stop_val_percent,
            early_stop_patience,
            early_stop_max_epochs,
        );
    }

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

    // --- T159: 早期打ち切り(early stopping)のテスト ---

    /// `early_stop_game_hash`が対局内容(手番・盤面・outcome)を反映して変わるよう、
    /// `game_index`ごとにoutcomeを変えた合成対局を作る(盤面の形自体は
    /// `fixture_sample`と同じ単純なものでよい)。
    fn early_stop_fixture_game(game_index: usize, moves: usize) -> Vec<Sample> {
        (0..moves)
            .map(|i| {
                let empties = 4 + ((game_index * 13 + i * 5) % 55);
                let mut sample = fixture_sample(0, empties);
                let seed = (game_index as u64)
                    .wrapping_mul(0x9E3779B97F4A7C15)
                    ^ (i as u64);
                sample.outcome = (seed % 2000) as f32 - 1000.0;
                sample
            })
            .collect()
    }

    /// (a) T159要件6(a): OFF経路(early_stop未指定)が`Model::train`を直接
    /// 呼んだ場合と完全に同じ重みバイナリを出力すること。dispatchロジック
    /// (`main`のearly_stop分岐)の追加が既存の`run_config_seed`呼び出し経路
    /// (本タスクでは1行も変更していない)に影響しないことのコード上の保証。
    /// 実際のCLIバイナリでの前後SHA-256一致は作業ログに別途記録する。
    #[test]
    fn off_path_matches_direct_model_training_bit_for_bit() {
        let config = legacy_config(PatternConfig::V3, "v3");
        let samples: Vec<Sample> = (0..40).map(|i| fixture_sample(i, 4 + i % 40)).collect();
        let cfg = TrainConfig {
            seed: 5,
            ..TrainConfig::default()
        };

        let mut direct = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        direct.train(&samples, &cfg);

        let output_dir =
            std::env::temp_dir().join(format!("t159-off-path-{}", std::process::id()));
        fs::remove_dir_all(&output_dir).ok();
        fs::create_dir_all(&output_dir).unwrap();
        run_config_seed(
            config,
            5,
            cfg.epochs,
            "test-identity\n",
            &output_dir,
            &samples,
            &samples,
            &[],
        )
        .unwrap();
        let produced = fs::read(output_dir.join("v3-seed-5.bin")).unwrap();
        assert_eq!(produced, direct.to_bytes_v3());
        fs::remove_dir_all(&output_dir).ok();
    }

    /// (d) 検証split(`split_early_stop_validation`)は対局内容だけのハッシュで
    /// 決定される。同一入力なら常に同じ分割になる。
    #[test]
    fn early_stop_validation_split_is_deterministic() {
        let games: Vec<Vec<Sample>> = (0..200).map(|g| early_stop_fixture_game(g, 3)).collect();
        let (train1, val1) = split_early_stop_validation(&games, 5.0);
        let (train2, val2) = split_early_stop_validation(&games, 5.0);
        assert_eq!(train1, train2);
        assert_eq!(val1, val2);
        assert_eq!(train1.len() + val1.len(), games.len());
        assert!(
            !val1.is_empty(),
            "expected at least one validation game out of 200 at 5%"
        );
        assert!(!train1.is_empty());
    }

    /// (d) 分割は対局の並び順(や、それを混ぜて生成する乱数シード)に依存せず、
    /// 各対局の内容だけで決まる。
    #[test]
    fn early_stop_validation_split_is_order_independent() {
        let games: Vec<Vec<Sample>> = (0..150).map(|g| early_stop_fixture_game(g, 2)).collect();
        let mut reordered = games.clone();
        reordered.reverse();
        reordered.rotate_left(37);

        let (train_a, val_a) = split_early_stop_validation(&games, 8.0);
        let (train_b, val_b) = split_early_stop_validation(&reordered, 8.0);

        let mut hashes_a: Vec<u64> = val_a.iter().map(|g| early_stop_game_hash(g)).collect();
        let mut hashes_b: Vec<u64> = val_b.iter().map(|g| early_stop_game_hash(g)).collect();
        hashes_a.sort_unstable();
        hashes_b.sort_unstable();
        assert_eq!(hashes_a, hashes_b);
        assert_eq!(train_a.len(), train_b.len());
        assert_eq!(val_a.len(), val_b.len());
    }

    /// (b) 検証MAEが人工的に悪化し続けるケースでのpatience動作
    /// (ベスト更新・stale増加・タイの扱い)を、実際のSGDを介さず純粋関数
    /// `apply_early_stop_step`で検証する。
    #[test]
    fn early_stop_patience_tracks_best_and_stale_counts() {
        // 8.0(改善) → 5.0(改善) → 6.0(悪化) → 6.0(タイ=改善なし) → 7.0(悪化)。
        let sequence = [8.0, 5.0, 6.0, 6.0, 7.0];
        let mut best_val_mae = f64::INFINITY;
        let mut best_epoch = 0u32;
        let mut stale = 0u32;
        let mut is_best_flags = Vec::new();
        for (i, &val_mae) in sequence.iter().enumerate() {
            let epoch = (i + 1) as u32;
            let (is_best, new_best_val_mae, new_best_epoch, new_stale) =
                apply_early_stop_step(val_mae, epoch, best_val_mae, best_epoch, stale);
            best_val_mae = new_best_val_mae;
            best_epoch = new_best_epoch;
            stale = new_stale;
            is_best_flags.push(is_best);
        }
        assert_eq!(is_best_flags, vec![true, true, false, false, false]);
        assert_eq!(best_epoch, 2);
        assert_eq!(best_val_mae, 5.0);
        // タイ(3エポック目→4エポック目)を挟んでも3回連続で改善なしとしてstaleが積み上がる。
        assert_eq!(stale, 3);
    }

    /// (b) ベスト重み復元の統合テスト。trainとvalに同一局面(board/mover)を使い、
    /// 教師値だけ逆方向(train=+10, val=-10)にすることで、「学習が進むほど
    /// 検証MAEが単調に悪化する」という決定的なシナリオを作る(既定の学習率は
    /// 十分小さく、単一サンプル反復学習は発散せず単調に目標へ近づくため)。
    /// これにより1エポック目が常にベストであり続け、patience経過後に
    /// 打ち切って1エポック目の重みを最終成果物として復元することを、実際の
    /// checkpoint/finalize経路(`run_config_seed_early_stop`)を通して確認する。
    #[test]
    fn early_stop_restores_best_checkpoint_and_stops_before_max_epochs() {
        let config = legacy_config(PatternConfig::V3, "v3");
        let board = fixture_sample(0, 30).board;
        let train_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 10.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let val_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: -10.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let seed = 1u64;
        let patience = 2u32;
        let max_epochs = 6u32;
        let identity = "test-earlystop-divergence\n";

        let output_dir =
            std::env::temp_dir().join(format!("t159-earlystop-restore-{}", std::process::id()));
        fs::remove_dir_all(&output_dir).ok();
        fs::create_dir_all(&output_dir).unwrap();

        run_config_seed_early_stop(
            config,
            seed,
            identity,
            &output_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
            &[],
        )
        .unwrap();

        let final_bytes = fs::read(output_dir.join("v3-seed-1-earlystop.bin")).unwrap();
        let state = read_early_stop_state(
            &output_dir.join("v3-seed-1-earlystop").join("state.txt"),
        )
        .unwrap();
        assert_eq!(
            state.best_epoch, 1,
            "epoch1 should remain best since val MAE only worsens afterwards"
        );
        assert_eq!(
            state.epoch,
            1 + patience,
            "training should stop exactly `patience` epochs after the (unbeaten) best epoch"
        );
        assert!(state.epoch < max_epochs, "should stop before max_epochs");

        // 1エポック目の重みを独立に再現し、最終成果物と一致することを確認する
        // (最後に学習したエポックの重みではなく、ベストエポックの重みが
        // 最終成果物として出力されていることの直接的な証拠)。
        let mut expected = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        let cfg = TrainConfig {
            seed,
            ..TrainConfig::default()
        };
        expected.train_epochs(&train_samples, &cfg, 0, 1);
        assert_eq!(final_bytes, expected.to_bytes_v3());

        fs::remove_dir_all(&output_dir).ok();
    }

    /// (c) resume同一性: 「1エポック終了直後にクラッシュした」状態を
    /// checkpoint/state/best.binの直接書き込みで再現し、そこから
    /// `run_config_seed_early_stop`で再開した最終結果が、中断なしに最初から
    /// 実行した場合と完全に一致することを確認する。
    #[test]
    fn early_stop_resume_matches_uninterrupted_run() {
        let config = legacy_config(PatternConfig::V3, "v3");
        let board = fixture_sample(1, 24).board;
        let train_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 6.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let val_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 5.5,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let seed = 3u64;
        let patience = 10u32; // max_epochs以内では発火しないだけの余裕を持たせる
        let max_epochs = 4u32;
        let identity = "test-earlystop-resume\n";

        // --- 中断なしの基準実行 ---
        let baseline_dir = std::env::temp_dir().join(format!(
            "t159-earlystop-resume-baseline-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&baseline_dir).ok();
        fs::create_dir_all(&baseline_dir).unwrap();
        run_config_seed_early_stop(
            config,
            seed,
            identity,
            &baseline_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
            &[],
        )
        .unwrap();
        let baseline_final = fs::read(baseline_dir.join("v3-seed-3-earlystop.bin")).unwrap();
        let baseline_state = read_early_stop_state(
            &baseline_dir.join("v3-seed-3-earlystop").join("state.txt"),
        )
        .unwrap();

        // --- 1エポック終了直後にクラッシュした状態を手動で再現 ---
        let resumed_dir = std::env::temp_dir().join(format!(
            "t159-earlystop-resume-crash-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&resumed_dir).ok();
        fs::create_dir_all(&resumed_dir).unwrap();
        let run_dir = resumed_dir.join("v3-seed-3-earlystop");
        fs::create_dir_all(&run_dir).unwrap();
        let cfg = TrainConfig {
            seed,
            ..TrainConfig::default()
        };
        let mut crashed_model = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        crashed_model.train_epochs(&train_samples, &cfg, 0, 1);
        let val_mae_epoch1 = crashed_model.mean_absolute_error(&val_samples);
        let checkpoint_bytes = crashed_model.to_bytes_v3();
        save_artifact(&run_dir.join("epoch-01.bin"), &checkpoint_bytes, identity).unwrap();
        save_artifact(&run_dir.join("best.bin"), &checkpoint_bytes, identity).unwrap();
        write_early_stop_state(&run_dir.join("state.txt"), 1, 1, val_mae_epoch1, 0).unwrap();
        let metrics_path = resumed_dir.join("v3-seed-3-earlystop.metrics.tsv");
        ensure_early_stop_metrics_header(&metrics_path).unwrap();
        let train_mse1 = crashed_model.mean_squared_error(&train_samples);
        let train_mae1 = crashed_model.mean_absolute_error(&train_samples);
        append_early_stop_metrics_row(
            &metrics_path,
            1,
            train_mse1,
            train_mae1,
            val_mae_epoch1,
            true,
            0,
            1,
            val_mae_epoch1,
        )
        .unwrap();

        run_config_seed_early_stop(
            config,
            seed,
            identity,
            &resumed_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
            &[],
        )
        .unwrap();
        let resumed_final = fs::read(resumed_dir.join("v3-seed-3-earlystop.bin")).unwrap();
        let resumed_state = read_early_stop_state(&run_dir.join("state.txt")).unwrap();

        assert_eq!(resumed_final, baseline_final);
        assert_eq!(resumed_state.epoch, baseline_state.epoch);
        assert_eq!(resumed_state.best_epoch, baseline_state.best_epoch);

        fs::remove_dir_all(&baseline_dir).ok();
        fs::remove_dir_all(&resumed_dir).ok();
    }

    // --- T159b: --simple-corpus経路の早期打ち切りのテスト ---

    /// (a) T159b要件7(a): simple-corpus経路のOFF時不変。simple-corpus用の
    /// 読み込み・分割関数(`load_simple_corpus`/`split_by_position_hash`、
    /// いずれも本タスクで変更していない)を通した学習が、`Model::train`直接
    /// 呼び出しと完全に同じ重みバイナリを出すことを確認する(early_stop分岐
    /// 追加が既存のsimple-corpus OFF経路に影響しないことのコード上の保証)。
    /// 実際のCLIバイナリでの前後SHA-256一致は作業ログに別途記録する。
    #[test]
    fn simple_corpus_off_path_matches_direct_model_training_bit_for_bit() {
        let dir = std::env::temp_dir().join(format!(
            "t159b-simple-off-path-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        let corpus_file = dir.join("corpus.txt");
        let lines: Vec<String> = (0..80)
            .map(|i| {
                let stones = 4 + (i * 3) % 50;
                let board = "X".repeat(stones) + &"-".repeat(64 - stones);
                format!("{board} {}", (i as i64) - 40)
            })
            .collect();
        fs::write(&corpus_file, lines.join("\n") + "\n").unwrap();

        let files = simple_corpus::list_simple_corpus_files(&corpus_file).unwrap();
        let (pool, _hash, _total) = simple_corpus::load_simple_corpus(&files, None, 7).unwrap();
        let (train_samples, frozen_samples) = simple_corpus::split_by_position_hash(pool);

        let config = legacy_config(PatternConfig::V3, "v3");
        let cfg = TrainConfig {
            seed: 9,
            ..TrainConfig::default()
        };
        let mut direct = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        direct.train(&train_samples, &cfg);

        let output_dir = dir.join("out");
        fs::create_dir_all(&output_dir).unwrap();
        run_config_seed(
            config,
            9,
            cfg.epochs,
            "test-identity\n",
            &output_dir,
            &train_samples,
            &frozen_samples,
            &[],
        )
        .unwrap();
        let produced = fs::read(output_dir.join("v3-seed-9.bin")).unwrap();
        assert_eq!(produced, direct.to_bytes_v3());
        fs::remove_dir_all(&dir).ok();
    }

    /// (c) `recover_early_stop_state`単体テスト: checkpoint保存後・state.txt
    /// 書き込み前にクラッシュした窓(T159レビュー中1)から、metrics.tsvの
    /// 該当行を使って自動復旧し、state.txtを自己修復することを確認する。
    #[test]
    fn recover_early_stop_state_heals_checkpoint_ahead_of_state_window() {
        let dir = std::env::temp_dir().join(format!(
            "t159b-recover-state-ahead-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        let state_path = dir.join("state.txt");
        let metrics_path = dir.join("metrics.tsv");
        ensure_early_stop_metrics_header(&metrics_path).unwrap();
        append_early_stop_metrics_row(&metrics_path, 1, 10.0, 8.0, 9.0, true, 0, 1, 9.0).unwrap();
        write_early_stop_state(&state_path, 1, 1, 9.0, 0).unwrap();
        // エポック2はcheckpoint/metricsまで書けたがstate.txt書き込み前にクラッシュ
        // (state.txtはエポック1のまま更新されていない)。
        append_early_stop_metrics_row(&metrics_path, 2, 9.0, 7.5, 9.4, false, 1, 1, 9.0).unwrap();

        let recovered = recover_early_stop_state(&state_path, &metrics_path, 2, "test").unwrap();
        assert_eq!(recovered.epoch, 2);
        assert_eq!(recovered.best_epoch, 1);
        assert_eq!(recovered.best_val_mae, 9.0);
        assert_eq!(recovered.stale, 1);

        let healed = read_early_stop_state(&state_path).unwrap();
        assert_eq!(healed.epoch, 2);
        assert_eq!(healed.best_epoch, 1);
        assert_eq!(healed.stale, 1);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recover_early_stop_state_heals_missing_state_file() {
        let dir = std::env::temp_dir().join(format!(
            "t159b-recover-state-missing-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        let state_path = dir.join("state.txt"); // 一度も作成しない
        let metrics_path = dir.join("metrics.tsv");
        ensure_early_stop_metrics_header(&metrics_path).unwrap();
        append_early_stop_metrics_row(&metrics_path, 1, 5.0, 4.0, 6.0, true, 0, 1, 6.0).unwrap();

        let recovered = recover_early_stop_state(&state_path, &metrics_path, 1, "test").unwrap();
        assert_eq!(recovered.epoch, 1);
        assert_eq!(recovered.best_epoch, 1);
        assert_eq!(recovered.best_val_mae, 6.0);
        assert_eq!(recovered.stale, 0);
        assert!(state_path.exists(), "state.txt should be healed/created");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recover_early_stop_state_rejects_unrecoverable_gap() {
        let dir = std::env::temp_dir().join(format!(
            "t159b-recover-state-gap-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        let state_path = dir.join("state.txt");
        let metrics_path = dir.join("metrics.tsv");
        ensure_early_stop_metrics_header(&metrics_path).unwrap();
        write_early_stop_state(&state_path, 1, 1, 9.0, 0).unwrap();

        let err = recover_early_stop_state(&state_path, &metrics_path, 5, "test").unwrap_err();
        assert!(
            err.contains("cannot be auto-recovered"),
            "unexpected error message: {err}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// (c) 統合テスト: `run_config_seed_early_stop`(WTHOR経路と共有のcheckpoint/
    /// resume機構)が、「checkpoint(epoch2)は保存済みだがstate.txtはepoch1のまま」
    /// という脆弱窓の状態から再開し、中断なし実行と完全に同じ最終結果に到達する
    /// ことを確認する(T159レビュー中1の直接的な回帰ガード)。
    #[test]
    fn early_stop_resume_recovers_from_checkpoint_ahead_of_state_window() {
        let config = legacy_config(PatternConfig::V3, "v3");
        let board = fixture_sample(2, 26).board;
        let train_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 7.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let val_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 6.5,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let seed = 4u64;
        let patience = 10u32; // 発火させず4エポック全部走らせる
        let max_epochs = 4u32;
        let identity = "test-earlystop-resume-window\n";

        // --- 中断なしの基準実行 ---
        let baseline_dir = std::env::temp_dir().join(format!(
            "t159b-earlystop-resume-window-baseline-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&baseline_dir).ok();
        fs::create_dir_all(&baseline_dir).unwrap();
        run_config_seed_early_stop(
            config,
            seed,
            identity,
            &baseline_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
            &[],
        )
        .unwrap();
        let baseline_final = fs::read(baseline_dir.join("v3-seed-4-earlystop.bin")).unwrap();
        let baseline_state = read_early_stop_state(
            &baseline_dir.join("v3-seed-4-earlystop").join("state.txt"),
        )
        .unwrap();

        // --- エポック2完了(checkpoint+metrics行あり)・state.txt書き込み前クラッシュを再現 ---
        let resumed_dir = std::env::temp_dir().join(format!(
            "t159b-earlystop-resume-window-crash-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&resumed_dir).ok();
        fs::create_dir_all(&resumed_dir).unwrap();
        let run_dir = resumed_dir.join("v3-seed-4-earlystop");
        fs::create_dir_all(&run_dir).unwrap();
        let cfg = TrainConfig {
            seed,
            ..TrainConfig::default()
        };
        let mut model = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        let metrics_path = resumed_dir.join("v3-seed-4-earlystop.metrics.tsv");
        ensure_early_stop_metrics_header(&metrics_path).unwrap();

        // エポック1(通常どおり完了・state.txtも書く)
        model.train_epochs(&train_samples, &cfg, 0, 1);
        let val_mae1 = model.mean_absolute_error(&val_samples);
        let train_mse1 = model.mean_squared_error(&train_samples);
        let train_mae1 = model.mean_absolute_error(&train_samples);
        let bytes1 = model.to_bytes_v3();
        save_artifact(&run_dir.join("epoch-01.bin"), &bytes1, identity).unwrap();
        save_artifact(&run_dir.join("best.bin"), &bytes1, identity).unwrap();
        append_early_stop_metrics_row(
            &metrics_path,
            1,
            train_mse1,
            train_mae1,
            val_mae1,
            true,
            0,
            1,
            val_mae1,
        )
        .unwrap();
        write_early_stop_state(&run_dir.join("state.txt"), 1, 1, val_mae1, 0).unwrap();

        // エポック2: checkpoint保存・metrics行追記までは完了させるが、
        // state.txtは書き換えない(=脆弱窓の状態のまま止める)。
        model.train_epochs(&train_samples, &cfg, 1, 1);
        let val_mae2 = model.mean_absolute_error(&val_samples);
        let train_mse2 = model.mean_squared_error(&train_samples);
        let train_mae2 = model.mean_absolute_error(&train_samples);
        let (is_best2, best_val_mae2, best_epoch2, stale2) =
            apply_early_stop_step(val_mae2, 2, val_mae1, 1, 0);
        let bytes2 = model.to_bytes_v3();
        if is_best2 {
            save_artifact(&run_dir.join("best.bin"), &bytes2, identity).unwrap();
        }
        append_early_stop_metrics_row(
            &metrics_path,
            2,
            train_mse2,
            train_mae2,
            val_mae2,
            is_best2,
            stale2,
            best_epoch2,
            best_val_mae2,
        )
        .unwrap();
        save_artifact(&run_dir.join("epoch-02.bin"), &bytes2, identity).unwrap();
        // state.txtは意図的にepoch1のまま(クラッシュ窓の再現)。

        run_config_seed_early_stop(
            config,
            seed,
            identity,
            &resumed_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
            &[],
        )
        .unwrap();
        let resumed_final = fs::read(resumed_dir.join("v3-seed-4-earlystop.bin")).unwrap();
        let resumed_state = read_early_stop_state(&run_dir.join("state.txt")).unwrap();

        assert_eq!(resumed_final, baseline_final);
        assert_eq!(resumed_state.epoch, baseline_state.epoch);
        assert_eq!(resumed_state.best_epoch, baseline_state.best_epoch);

        fs::remove_dir_all(&baseline_dir).ok();
        fs::remove_dir_all(&resumed_dir).ok();
    }

    /// (d) simple-corpus経路でのベスト重み復元・打ち切り統合テスト。
    /// WTHOR経路の`early_stop_restores_best_checkpoint_and_stops_before_max_epochs`
    /// と同じ「train/valを逆方向の教師値にする」トリックで、
    /// `run_config_seed_early_stop_simple`(1エポック1回の学習パス評価=
    /// `train_epoch_with_running_loss`を使う経路)がpatience経過後に
    /// max_epochs前で打ち切り、ベストエポックの重みを最終成果物として
    /// 復元することを確認する。
    #[test]
    fn simple_corpus_early_stop_restores_best_checkpoint_and_stops_before_max_epochs() {
        let config = legacy_config(PatternConfig::V3, "v3");
        let board = fixture_sample(0, 30).board;
        let train_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: 10.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let val_samples = vec![Sample {
            board,
            mover: Side::Black,
            outcome: -10.0,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let seed = 1u64;
        let patience = 2u32;
        let max_epochs = 6u32;
        let identity = "test-earlystop-simple-divergence\n";

        let output_dir = std::env::temp_dir().join(format!(
            "t159b-earlystop-simple-restore-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&output_dir).ok();
        fs::create_dir_all(&output_dir).unwrap();

        run_config_seed_early_stop_simple(
            config,
            seed,
            identity,
            &output_dir,
            max_epochs,
            patience,
            &train_samples,
            &val_samples,
            &train_samples,
        )
        .unwrap();

        let final_bytes = fs::read(output_dir.join("v3-seed-1-earlystop.bin")).unwrap();
        let state = read_early_stop_state(
            &output_dir.join("v3-seed-1-earlystop").join("state.txt"),
        )
        .unwrap();
        assert_eq!(state.best_epoch, 1);
        assert_eq!(state.epoch, 1 + patience);
        assert!(state.epoch < max_epochs);

        let mut expected = Model::new_with_scalar_features(
            patterns::generate_patterns_for(config.pattern_config),
            config.num_stages,
            config.stage_empty_divisor,
            config.scalar_features,
        );
        let cfg = TrainConfig {
            seed,
            ..TrainConfig::default()
        };
        expected.train_epoch_with_running_loss(&train_samples, &cfg, 0);
        assert_eq!(final_bytes, expected.to_bytes_v3());

        fs::remove_dir_all(&output_dir).ok();
    }

    /// simple-corpus経路の早期打ち切り(小規模合成corpus)でも実際にpatienceで
    /// 打ち切ることを、`run_early_stop_simple_corpus`(CLI相当のエントリポイント、
    /// `split_for_early_stop`によるtrain/val/frozen分割を含む)経由で確認する。
    #[test]
    fn simple_corpus_early_stop_end_to_end_splits_and_trains() {
        let output_dir = std::env::temp_dir().join(format!(
            "t159b-earlystop-simple-e2e-{}",
            std::process::id()
        ));
        fs::remove_dir_all(&output_dir).ok();
        fs::create_dir_all(&output_dir).unwrap();

        let pool: Vec<Sample> = (0..400)
            .map(|i| {
                let empties = 4 + (i * 7) % 55;
                fixture_sample(i, empties)
            })
            .collect();
        let configs = vec![legacy_config(PatternConfig::V3, "v3")];
        let seeds = vec![1u64];

        let status = run_early_stop_simple_corpus(
            pool,
            "test-corpus",
            "deadbeefdeadbeef",
            400,
            None,
            7,
            &output_dir,
            &configs,
            &seeds,
            10.0,
            2,
            10,
        );
        assert!(matches!(status, ExitCode::SUCCESS));
        assert!(output_dir.join("v3-seed-1-earlystop.bin").exists());
        let results =
            fs::read_to_string(output_dir.join("results-earlystop.tsv")).unwrap();
        assert!(results.lines().count() >= 2, "expected a header + result row");

        fs::remove_dir_all(&output_dir).ok();
    }
}

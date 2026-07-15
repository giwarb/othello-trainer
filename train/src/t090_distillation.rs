//! T090b Edax-teacher distillation with mixed loss and epoch checkpoints.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::bitboard::{Board, Side};
use engine::pattern_eval::stage_for_empty_count;
use engine::patterns::{self, pattern_state_index};
use serde::Deserialize;

use crate::experiment::{self, CanonicalKey};
use crate::regression::Model;
use crate::{train_data, wthor};

const HUBER_DELTA: f32 = 4.0;
const DEFAULT_LR: f32 = 0.005;
const MIN_LR: f32 = 0.0003125;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonChild {
    #[serde(rename = "move")]
    move_name: String,
    value: f32,
    diff_from_best: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRecord {
    board: String,
    side_to_move: String,
    source: String,
    canonical_key: (u64, u64, u8),
    children: Vec<JsonChild>,
    best_move: String,
    best_value: f32,
}

#[derive(Debug, Clone)]
struct Child {
    move_index: u8,
    board: Board,
    teacher_value: f32,
}

#[derive(Debug, Clone)]
pub struct DistillRecord {
    key: CanonicalKey,
    board: Board,
    mover: Side,
    teacher_value: f32,
    outcome: Option<f32>,
    children: Vec<Child>,
    best: usize,
    pairs: Vec<usize>,
}

#[derive(Debug, Clone, Copy)]
struct Mix {
    name: &'static str,
    teacher: f32,
    ranking: f32,
    outcome: f32,
}

impl Mix {
    fn parse(name: &str) -> Result<Self, String> {
        match name {
            "teacher-only" => Ok(Self {
                name: "teacher-only",
                teacher: 1.0,
                ranking: 0.0,
                outcome: 0.0,
            }),
            "baseline" => Ok(Self {
                name: "baseline",
                teacher: 0.6,
                ranking: 0.3,
                outcome: 0.1,
            }),
            "no-ranking" => Ok(Self {
                name: "no-ranking",
                teacher: 0.7,
                ranking: 0.0,
                outcome: 0.3,
            }),
            _ => Err(format!("unknown mix {name}")),
        }
    }

    fn coefficients(self, has_outcome: bool) -> (f32, f32, f32) {
        if has_outcome || self.outcome == 0.0 {
            (self.teacher, self.ranking, self.outcome)
        } else {
            let sum = self.teacher + self.ranking;
            if sum == 0.0 {
                (0.0, 0.0, 0.0)
            } else {
                (self.teacher / sum, self.ranking / sum, 0.0)
            }
        }
    }
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<_> = env::args().collect();
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn fnv_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn key_hash(key: CanonicalKey) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    hash = fnv_update(hash, &key.0.to_le_bytes());
    hash = fnv_update(hash, &key.1.to_le_bytes());
    fnv_update(hash, &[key.2])
}

fn parse_board(text: &str) -> Result<Board, String> {
    if text.len() != 64 {
        return Err("board must contain 64 ASCII cells".into());
    }
    let mut board = Board { black: 0, white: 0 };
    for (i, byte) in text.bytes().enumerate() {
        match byte {
            b'X' => board.black |= 1u64 << i,
            b'O' => board.white |= 1u64 << i,
            b'-' => {}
            _ => return Err(format!("invalid board cell at {i}")),
        }
    }
    Ok(board)
}

fn parse_move(text: &str) -> Result<u8, String> {
    let b = text.as_bytes();
    if b.len() != 2 || !(b'a'..=b'h').contains(&b[0]) || !(b'1'..=b'8').contains(&b[1]) {
        return Err(format!("invalid move {text}"));
    }
    Ok((b[1] - b'1') * 8 + b[0] - b'a')
}

fn is_x_or_c(cell: u8) -> bool {
    matches!(cell, 1 | 6 | 8 | 9 | 14 | 15 | 48 | 49 | 54 | 55 | 57 | 62)
}

fn load_outcomes() -> Result<(HashMap<CanonicalKey, f32>, Vec<train_data::Sample>, String), String>
{
    let mut training_raw = Vec::new();
    let mut test_raw = Vec::new();
    let mut hash = 0xcbf29ce484222325;
    let mut files: Vec<_> = fs::read_dir("train/data")
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "wtb"))
        .collect();
    files.sort();
    for path in files {
        let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        hash = fnv_update(hash, path.to_string_lossy().as_bytes());
        hash = fnv_update(hash, &bytes);
        let parsed = wthor::parse(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        let year = parsed.header.year_of_games;
        for game in parsed.games {
            if let Ok(samples) = train_data::samples_from_game(&game.moves) {
                if (2015..=2023).contains(&year) {
                    training_raw.extend(samples.iter().copied().map(|sample| (year, sample)));
                }
                if year == 2024 {
                    test_raw.extend(samples.into_iter().map(|sample| (year, sample)));
                }
            }
        }
    }
    let test_map = experiment::aggregate(&test_raw);
    let outcomes = experiment::aggregate(&training_raw)
        .into_iter()
        .filter(|(key, _)| !test_map.contains_key(key))
        .map(|(key, record)| (key, record.sample.outcome))
        .collect();
    let mut test: Vec<_> = test_map.into_values().map(|record| record.sample).collect();
    test.sort_by_key(|sample| experiment::canonicalize(sample).0);
    Ok((outcomes, test, format!("{hash:016x}")))
}

fn load_corpus(
    path: &Path,
    reference: &Model,
    outcomes: &HashMap<CanonicalKey, f32>,
) -> Result<Vec<DistillRecord>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for (line_no, line) in text.lines().enumerate() {
        let raw: JsonRecord = serde_json::from_str(line)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line_no + 1))?;
        let board = parse_board(&raw.board)?;
        let mover = match raw.side_to_move.as_str() {
            "black" => Side::Black,
            "white" => Side::White,
            _ => return Err(format!("line {}: bad side", line_no + 1)),
        };
        let key = CanonicalKey(
            raw.canonical_key.0,
            raw.canonical_key.1,
            raw.canonical_key.2,
        );
        if !seen.insert(key) {
            return Err(format!("line {}: duplicate canonicalKey", line_no + 1));
        }
        let key_sample = train_data::Sample {
            board,
            mover,
            outcome: 0.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        if experiment::canonicalize(&key_sample).0 != key {
            return Err(format!("line {}: canonicalKey mismatch", line_no + 1));
        }
        if raw.children.is_empty() {
            return Err(format!("line {}: no children", line_no + 1));
        }
        let mut children = Vec::new();
        let mut best = None;
        for child in &raw.children {
            let move_index = parse_move(&child.move_name)?;
            if board.legal_moves(mover) & (1u64 << move_index) == 0 {
                return Err(format!(
                    "line {}: illegal child {}",
                    line_no + 1,
                    child.move_name
                ));
            }
            if child.move_name == raw.best_move {
                best = Some(children.len());
            }
            children.push(Child {
                move_index,
                board: board.apply_move(mover, 1u64 << move_index),
                teacher_value: child.value,
            });
        }
        let best = best.ok_or_else(|| format!("line {}: bestMove absent", line_no + 1))?;
        if (children[best].teacher_value - raw.best_value).abs() > 1e-5
            || raw
                .children
                .iter()
                .any(|c| (raw.best_value - c.value - c.diff_from_best).abs() > 1e-4)
        {
            return Err(format!("line {}: teacher value inconsistency", line_no + 1));
        }
        let engine_choice = (0..children.len())
            .max_by(|&a, &b| {
                let a_score = child_score(reference, &children[a].board, mover);
                let b_score = child_score(reference, &children[b].board, mover);
                a_score
                    .total_cmp(&b_score)
                    .then_with(|| children[b].move_index.cmp(&children[a].move_index))
            })
            .unwrap();
        let second = (0..children.len()).filter(|&i| i != best).max_by(|&a, &b| {
            children[a]
                .teacher_value
                .total_cmp(&children[b].teacher_value)
                .then_with(|| children[b].move_index.cmp(&children[a].move_index))
        });
        let xc = raw
            .children
            .iter()
            .enumerate()
            .filter(|(_, child)| is_x_or_c(parse_move(&child.move_name).unwrap()))
            .max_by(|(_, a), (_, b)| {
                a.diff_from_best
                    .total_cmp(&b.diff_from_best)
                    .then_with(|| b.move_name.cmp(&a.move_name))
            })
            .map(|(i, _)| i);
        let mut pairs = Vec::new();
        for candidate in [Some(engine_choice), xc, second].into_iter().flatten() {
            if candidate != best && !pairs.contains(&candidate) {
                pairs.push(candidate);
            }
        }
        records.push(DistillRecord {
            key,
            board,
            mover,
            teacher_value: raw.best_value,
            outcome: if raw.source == "wthor" {
                outcomes.get(&key).copied()
            } else {
                None
            },
            children,
            best,
            pairs,
        });
    }
    Ok(records)
}

type Feature = (usize, usize, usize);

fn features(model: &Model, board: &Board, mover: Side) -> Vec<Feature> {
    let stage = stage_for_empty_count(board.empty_count());
    let info = &model.weights.class_info;
    (0..model.weights.patterns.len())
        .map(|i| {
            let state = pattern_state_index(&info.aligned_cells[i], board, mover) as usize;
            (info.class_of[i], stage, state)
        })
        .collect()
}

fn huber(error: f32) -> (f32, f32) {
    if error.abs() <= HUBER_DELTA {
        (0.5 * error * error, error)
    } else {
        (
            HUBER_DELTA * (error.abs() - 0.5 * HUBER_DELTA),
            error.signum() * HUBER_DELTA,
        )
    }
}

/// Score a move from the parent mover's perspective, following the engine's
/// negamax pass and terminal conventions.
fn child_score(model: &Model, child: &Board, parent_mover: Side) -> f32 {
    let opponent = parent_mover.opposite();
    if child.has_legal_move(opponent) {
        -model.predict(child, opponent)
    } else if child.has_legal_move(parent_mover) {
        model.predict(child, parent_mover)
    } else {
        child.disc_count(parent_mover) as f32 - child.disc_count(opponent) as f32
    }
}

/// Add `scale * d(child_score)/d(weights)`. Terminal scores have no model gradient.
fn add_child_score_gradient(
    map: &mut HashMap<Feature, f32>,
    model: &Model,
    child: &Board,
    parent_mover: Side,
    scale: f32,
) {
    let opponent = parent_mover.opposite();
    if child.has_legal_move(opponent) {
        add_gradient(map, &features(model, child, opponent), -scale);
    } else if child.has_legal_move(parent_mover) {
        add_gradient(map, &features(model, child, parent_mover), scale);
    }
}

fn add_gradient(map: &mut HashMap<Feature, f32>, items: &[Feature], scale: f32) {
    for &key in items {
        *map.entry(key).or_default() += scale;
    }
}

fn train_step(
    model: &mut Model,
    record: &DistillRecord,
    mix: Mix,
    learning_rate: f32,
    l2: f32,
) -> f32 {
    let (teacher_weight, ranking_weight, outcome_weight) =
        mix.coefficients(record.outcome.is_some());
    let parent_features = features(model, &record.board, record.mover);
    let prediction = model.predict(&record.board, record.mover);
    let (teacher_loss, teacher_gradient) = huber(prediction - record.teacher_value);
    let mut gradient = HashMap::new();
    add_gradient(
        &mut gradient,
        &parent_features,
        teacher_weight * teacher_gradient,
    );

    let mut ranking_loss = 0.0;
    if ranking_weight > 0.0 && !record.pairs.is_empty() {
        for &other in &record.pairs {
            let best_score = child_score(model, &record.children[record.best].board, record.mover);
            let other_score = child_score(model, &record.children[other].board, record.mover);
            let target =
                record.children[record.best].teacher_value - record.children[other].teacher_value;
            let (loss, loss_gradient) = huber((best_score - other_score) - target);
            ranking_loss += loss / record.pairs.len() as f32;
            let scale = ranking_weight * loss_gradient / record.pairs.len() as f32;
            add_child_score_gradient(
                &mut gradient,
                model,
                &record.children[record.best].board,
                record.mover,
                scale,
            );
            add_child_score_gradient(
                &mut gradient,
                model,
                &record.children[other].board,
                record.mover,
                -scale,
            );
        }
    }

    let mut outcome_loss = 0.0;
    if let Some(outcome) = record.outcome {
        let (loss, loss_gradient) = huber(prediction - outcome);
        outcome_loss = loss;
        add_gradient(
            &mut gradient,
            &parent_features,
            outcome_weight * loss_gradient,
        );
    }
    for ((class, stage, state), value) in gradient {
        let weight = &mut model.weights.class_tables[class].stage_tables[stage][state];
        *weight -= learning_rate * (value + l2 * *weight);
    }
    teacher_weight * teacher_loss + ranking_weight * ranking_loss + outcome_weight * outcome_loss
}

#[derive(Default)]
struct Metrics {
    mixed: f64,
    teacher_mae: f64,
    ranking_mae: f64,
    agreement: f64,
    regret: f64,
}

fn metrics(model: &Model, records: &[DistillRecord], mix: Mix) -> Metrics {
    if records.is_empty() {
        return Metrics::default();
    }
    let mut out = Metrics::default();
    let mut pair_count = 0usize;
    for record in records {
        let prediction = model.predict(&record.board, record.mover);
        let (teacher_weight, ranking_weight, outcome_weight) =
            mix.coefficients(record.outcome.is_some());
        let (teacher_loss, _) = huber(prediction - record.teacher_value);
        out.teacher_mae += (prediction - record.teacher_value).abs() as f64;
        let scores: Vec<_> = record
            .children
            .iter()
            .map(|child| child_score(model, &child.board, record.mover))
            .collect();
        let selected = (0..scores.len())
            .max_by(|&a, &b| {
                scores[a].total_cmp(&scores[b]).then_with(|| {
                    record.children[b]
                        .move_index
                        .cmp(&record.children[a].move_index)
                })
            })
            .unwrap();
        out.agreement += f64::from(selected == record.best);
        out.regret += (record.teacher_value - record.children[selected].teacher_value) as f64;
        let mut ranking_loss = 0.0;
        for &other in &record.pairs {
            let target =
                record.children[record.best].teacher_value - record.children[other].teacher_value;
            let error = (scores[record.best] - scores[other]) - target;
            ranking_loss += huber(error).0 / record.pairs.len() as f32;
            out.ranking_mae += error.abs() as f64;
            pair_count += 1;
        }
        let outcome_loss = record
            .outcome
            .map_or(0.0, |value| huber(prediction - value).0);
        out.mixed += (teacher_weight * teacher_loss
            + ranking_weight * ranking_loss
            + outcome_weight * outcome_loss) as f64;
    }
    let count = records.len() as f64;
    out.mixed /= count;
    out.teacher_mae /= count;
    out.agreement /= count;
    out.regret /= count;
    if pair_count > 0 {
        out.ranking_mae /= pair_count as f64;
    }
    out
}

fn shuffle(count: usize, seed: u64) -> Vec<usize> {
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

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    replace_file(&temp, path)
}

fn parse_state(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.into(), value.into()))
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
            let saved_state = weights.with_extension("state");
            saved_state
                .exists()
                .then_some((epoch, weights, saved_state))
        })
        .max_by_key(|(epoch, _, _)| *epoch)
}

fn truncate_metrics_after(metrics_path: &Path, completed_epoch: u32) -> Result<(), String> {
    if !metrics_path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(metrics_path).map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    let mut kept = String::new();
    if let Some(header) = lines.next() {
        kept.push_str(header);
        kept.push('\n');
    }
    let mut seen_epochs = HashSet::new();
    for line in lines {
        let Some(field) = line.split('\t').next() else {
            continue;
        };
        let row_epoch: u32 = field
            .parse()
            .map_err(|_| format!("invalid metrics epoch {field}"))?;
        if row_epoch <= completed_epoch && seen_epochs.insert(row_epoch) {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    atomic_write(metrics_path, kept.as_bytes())
}

#[allow(clippy::too_many_arguments)]
fn run_one(
    mix: Mix,
    seed: u64,
    train: &[DistillRecord],
    validation: &[DistillRecord],
    frozen: &[DistillRecord],
    wthor_2024: &[train_data::Sample],
    root: &Path,
    identity_base: &str,
    max_epochs: u32,
    l2: f32,
) -> Result<(), String> {
    let dir = root.join(format!("{}-seed-{seed}", mix.name));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let identity = format!(
        "schema=4\n{identity_base}mix={}\nteacher={}\nranking={}\noutcome={}\nseed={seed}\nmax_epochs={max_epochs}\nl2={l2}\n",
        mix.name, mix.teacher, mix.ranking, mix.outcome);
    let identity_path = dir.join("identity.txt");
    if identity_path.exists()
        && fs::read_to_string(&identity_path).map_err(|e| e.to_string())? != identity
    {
        return Err(format!(
            "run identity mismatch for {}; refusing resume",
            mix.name
        ));
    }
    atomic_write(&identity_path, identity.as_bytes())?;

    let mut model = Model::new(patterns::generate_patterns());
    let mut epoch = 0u32;
    let mut learning_rate = DEFAULT_LR;
    let mut best_loss = f64::INFINITY;
    let mut patience_loss = f64::INFINITY;
    let mut best_epoch = 0u32;
    let mut stale = 0u32;
    let mut since_decay = 0u32;
    let mut previous_checkpoint = None;
    if let Some((checkpoint_epoch, weights_path, state_path)) = latest_checkpoint(&dir) {
        model = Model::from_bytes(&fs::read(&weights_path).map_err(|e| e.to_string())?)?;
        let saved = parse_state(&fs::read_to_string(&state_path).map_err(|e| e.to_string())?);
        epoch = saved["epoch"].parse().map_err(|_| "bad epoch")?;
        if epoch != checkpoint_epoch {
            return Err(format!("checkpoint epoch mismatch for {}", mix.name));
        }
        learning_rate = saved["learning_rate"]
            .parse()
            .map_err(|_| "bad learning rate")?;
        best_loss = saved["best_loss"].parse().map_err(|_| "bad best loss")?;
        patience_loss = saved["patience_loss"]
            .parse()
            .map_err(|_| "bad patience loss")?;
        best_epoch = saved["best_epoch"].parse().map_err(|_| "bad best epoch")?;
        stale = saved["stale"].parse().map_err(|_| "bad stale")?;
        since_decay = saved["since_decay"].parse().map_err(|_| "bad decay")?;
        previous_checkpoint = Some((weights_path, state_path));
        println!("resume mix={} seed={seed} epoch={epoch}", mix.name);
    }
    let metrics_path = dir.join("metrics.tsv");
    truncate_metrics_after(&metrics_path, epoch)?;
    if !metrics_path.exists() {
        atomic_write(&metrics_path,
            b"epoch\tlearning_rate\ttrain_loss\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae\n")?;
    }
    while epoch < max_epochs && stale < 5 {
        println!(
            "start mix={} seed={seed} epoch={}/{}",
            mix.name,
            epoch + 1,
            max_epochs
        );
        let mut train_loss = 0.0;
        for index in shuffle(train.len(), seed ^ epoch as u64) {
            train_loss += train_step(&mut model, &train[index], mix, learning_rate, l2) as f64;
        }
        train_loss /= train.len().max(1) as f64;
        epoch += 1;
        let validation_metrics = metrics(&model, validation, mix);
        let absolute_best = validation_metrics.mixed < best_loss;
        let meaningful = validation_metrics.mixed + 0.02 <= patience_loss;
        if absolute_best {
            best_loss = validation_metrics.mixed;
            best_epoch = epoch;
            atomic_write(&dir.join("best.bin"), &model.to_bytes_v3())?;
        }
        if meaningful {
            patience_loss = validation_metrics.mixed;
            stale = 0;
            since_decay = 0;
        } else {
            stale += 1;
            since_decay += 1;
        }
        if since_decay >= 2 && learning_rate > MIN_LR {
            learning_rate = (learning_rate * 0.5).max(MIN_LR);
            since_decay = 0;
        }
        let mut table = fs::read_to_string(&metrics_path).map_err(|e| e.to_string())?;
        table.push_str(&format!(
            "{epoch}\t{learning_rate:.7}\t{train_loss:.6}\t{:.6}\t{:.6}\t{:.6}\n",
            validation_metrics.mixed,
            validation_metrics.teacher_mae,
            validation_metrics.ranking_mae
        ));
        let saved = format!("epoch={epoch}\nlearning_rate={learning_rate}\nbest_loss={best_loss}\npatience_loss={patience_loss}\nbest_epoch={best_epoch}\nstale={stale}\nsince_decay={since_decay}\n");
        let weights_path = dir.join(format!("epoch-{epoch:02}.bin"));
        let state_path = weights_path.with_extension("state");
        atomic_write(&metrics_path, table.as_bytes())?;
        // Publish the weights last: latest_checkpoint only accepts complete pairs.
        atomic_write(&state_path, saved.as_bytes())?;
        atomic_write(&weights_path, &model.to_bytes_v3())?;
        if let Some((old_weights, old_state)) =
            previous_checkpoint.replace((weights_path, state_path))
        {
            fs::remove_file(old_weights).ok();
            fs::remove_file(old_state).ok();
        }
        println!(
            "saved mix={} seed={seed} epoch={epoch} validation_loss={:.6}",
            mix.name, validation_metrics.mixed
        );
    }
    let best_model =
        Model::from_bytes(&fs::read(dir.join("best.bin")).map_err(|e| e.to_string())?)?;
    let validation_metrics = metrics(&best_model, validation, mix);
    let frozen_metrics = metrics(&best_model, frozen, mix);
    let wthor_2024_mae = best_model.mean_absolute_error(wthor_2024);
    let bytes = best_model.to_bytes_v3();
    atomic_write(&dir.join("final.bin"), &bytes)?;
    atomic_write(&dir.join("complete.txt"), identity.as_bytes())?;
    let result = format!("mix\tseed\tbest_epoch\tepochs\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae\tfrozen_agreement\tfrozen_mean_regret\twthor_2024_mae\tbytes\n{}\t{seed}\t{best_epoch}\t{epoch}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{wthor_2024_mae:.6}\t{}\n",
        mix.name, validation_metrics.mixed, validation_metrics.teacher_mae,
        validation_metrics.ranking_mae, frozen_metrics.agreement,
        frozen_metrics.regret, bytes.len());
    atomic_write(&dir.join("result.tsv"), result.as_bytes())
}

pub fn run() -> ExitCode {
    let corpus = PathBuf::from(
        arg("--corpus").unwrap_or_else(|| "train/data/teacher/corpus_primary.jsonl".into()),
    );
    let reference_path = PathBuf::from(
        arg("--reference-weights").unwrap_or_else(|| "train/weights/pattern_v2.bin".into()),
    );
    let root = match arg("--checkpoint-dir") {
        Some(value) => PathBuf::from(value),
        None => {
            eprintln!("--checkpoint-dir is required");
            return ExitCode::FAILURE;
        }
    };
    let mixes: Result<Vec<_>, _> = arg("--mixes")
        .unwrap_or_else(|| "teacher-only,baseline,no-ranking".into())
        .split(',')
        .map(Mix::parse)
        .collect();
    let mixes = match mixes {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let seeds: Result<Vec<u64>, _> = arg("--seeds")
        .unwrap_or_else(|| "1,2".into())
        .split(',')
        .map(str::parse)
        .collect();
    let seeds = match seeds {
        Ok(value) => value,
        Err(error) => {
            eprintln!("invalid --seeds: {error}");
            return ExitCode::FAILURE;
        }
    };
    let max_epochs = match arg("--max-epochs").map(|value| value.parse()) {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            eprintln!("invalid --max-epochs: {error}");
            return ExitCode::FAILURE;
        }
        None => 60,
    };
    let l2 = match arg("--l2").map(|value| value.parse()) {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            eprintln!("invalid --l2: {error}");
            return ExitCode::FAILURE;
        }
        None => 1e-5,
    };
    let reference_bytes = match fs::read(&reference_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{}: {error}", reference_path.display());
            return ExitCode::FAILURE;
        }
    };
    let reference = match Model::from_bytes(&reference_bytes) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let (outcomes, wthor_2024, wthor_hash) = match load_outcomes() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let records = match load_corpus(&corpus, &reference, &outcomes) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let mut train = Vec::new();
    let mut validation = Vec::new();
    let mut frozen = Vec::new();
    for record in records {
        match key_hash(record.key) % 100 {
            0..=89 => train.push(record),
            90..=94 => validation.push(record),
            _ => frozen.push(record),
        }
    }
    if train.is_empty() || validation.is_empty() || frozen.is_empty() {
        eprintln!("all three deterministic splits must be non-empty");
        return ExitCode::FAILURE;
    }
    let corpus_hash = format!(
        "{:016x}",
        fnv_update(0xcbf29ce484222325, &fs::read(&corpus).unwrap())
    );
    let reference_hash = format!("{:016x}", fnv_update(0xcbf29ce484222325, &reference_bytes));
    fs::create_dir_all(&root).unwrap();
    let manifest = format!("split=fnv1a(canonicalKey)%100:train0-89,validation90-94,frozen95-99\noutcome_policy=canonical averages from WTHOR 2015-2023; keys occurring in 2024 removed with test priority; 2024 reserved for gate c\ntrain={}\nvalidation={}\nfrozen={}\noutcome_matched_train={}\noutcome_matched_validation={}\noutcome_matched_frozen={}\nwthor_2024={}\ncorpus_hash={corpus_hash}\nreference_hash={reference_hash}\nwthor_hash={wthor_hash}\n",
        train.len(), validation.len(), frozen.len(),
        train.iter().filter(|r| r.outcome.is_some()).count(),
        validation.iter().filter(|r| r.outcome.is_some()).count(),
        frozen.iter().filter(|r| r.outcome.is_some()).count(), wthor_2024.len());
    if let Err(error) = atomic_write(&root.join("manifest.txt"), manifest.as_bytes()) {
        eprintln!("{error}");
        return ExitCode::FAILURE;
    }
    let reference_frozen = metrics(&reference, &frozen, Mix::parse("baseline").unwrap());
    let reference_2024_mae = reference.mean_absolute_error(&wthor_2024);
    let reference_row = format!("frozen_agreement\tfrozen_mean_regret\twthor_2024_mae\n{:.6}\t{:.6}\t{reference_2024_mae:.6}\n",
        reference_frozen.agreement, reference_frozen.regret);
    atomic_write(&root.join("reference.tsv"), reference_row.as_bytes()).unwrap();
    print!("{manifest}");
    let identity = format!("corpus_hash={corpus_hash}\nreference_hash={reference_hash}\nwthor_hash={wthor_hash}\ntrain={}\nvalidation={}\nfrozen={}\n",
        train.len(), validation.len(), frozen.len());
    for mix in mixes {
        for &seed in &seeds {
            if let Err(error) = run_one(
                mix,
                seed,
                &train,
                &validation,
                &frozen,
                &wthor_2024,
                &root,
                &identity,
                max_epochs,
                l2,
            ) {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_missing_renormalizes_remaining_terms() {
        let mix = Mix::parse("baseline").unwrap();
        assert_eq!(mix.coefficients(false), (2.0 / 3.0, 1.0 / 3.0, 0.0));
        assert_eq!(
            Mix::parse("teacher-only").unwrap().coefficients(false),
            (1.0, 0.0, 0.0)
        );
    }

    #[test]
    fn pairwise_huber_uses_teacher_difference_and_negamax_sign() {
        let mut model = Model::new(patterns::generate_patterns());
        let board = Board::initial();
        let mover = Side::Black;
        let children: Vec<_> = [19u8, 26u8]
            .into_iter()
            .map(|move_index| Child {
                move_index,
                board: board.apply_move(mover, 1u64 << move_index),
                teacher_value: if move_index == 19 { 6.0 } else { 2.0 },
            })
            .collect();
        let record = DistillRecord {
            key: CanonicalKey(0, 0, 0),
            board,
            mover,
            teacher_value: 6.0,
            outcome: None,
            children,
            best: 0,
            pairs: vec![1],
        };
        let score = |model: &Model| {
            -model.predict(&record.children[0].board, Side::White)
                + model.predict(&record.children[1].board, Side::White)
        };
        let before = score(&model);
        train_step(
            &mut model,
            &record,
            Mix {
                name: "ranking",
                teacher: 0.0,
                ranking: 1.0,
                outcome: 0.0,
            },
            0.001,
            0.0,
        );
        assert!(
            score(&model) > before,
            "ranking update must increase best-minus-other score"
        );
    }

    #[test]
    fn corpus_loader_fixture_validates_schema_key_moves_values_and_pairs() {
        let reference = Model::new(patterns::generate_patterns());
        let board = Board::initial();
        let sample = train_data::Sample {
            board,
            mover: Side::Black,
            outcome: 0.0,
            last_move_kind: train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let key = experiment::canonicalize(&sample).0;
        let board_text: String = (0..64)
            .map(|i| {
                if board.black & (1u64 << i) != 0 {
                    'X'
                } else if board.white & (1u64 << i) != 0 {
                    'O'
                } else {
                    '-'
                }
            })
            .collect();
        let json = format!(
            r#"{{"board":"{board_text}","sideToMove":"black","source":"engineLoss","canonicalKey":[{},{},{}],"children":[{{"move":"d3","value":4.0,"diffFromBest":0.0}},{{"move":"c4","value":3.0,"diffFromBest":1.0}},{{"move":"f5","value":2.0,"diffFromBest":2.0}},{{"move":"e6","value":1.0,"diffFromBest":3.0}}],"bestMove":"d3","bestValue":4.0}}"#,
            key.0, key.1, key.2
        );
        let path =
            env::temp_dir().join(format!("t090-corpus-fixture-{}.jsonl", std::process::id()));
        fs::write(&path, format!("{json}\n")).unwrap();
        let result = load_corpus(&path, &reference, &HashMap::new());
        fs::remove_file(&path).unwrap();
        let records = result.unwrap();
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.key, key);
        assert_eq!(record.children.len(), 4);
        assert_eq!(record.best, 0);
        assert_eq!(record.teacher_value, 4.0);
        assert!(record.pairs.len() <= 3);
        let unique: HashSet<_> = record.pairs.iter().collect();
        assert_eq!(unique.len(), record.pairs.len());
        assert!(!record.pairs.contains(&record.best));
    }

    #[test]
    fn child_score_handles_opponent_pass_without_negating() {
        let child = Board {
            black: 18_373_833_327_367_946_240,
            white: 4_596_557_680_640,
        };
        assert_eq!(child.legal_moves(Side::White), 0);
        assert_ne!(child.legal_moves(Side::Black), 0);
        let mut model = Model::new(patterns::generate_patterns());
        for (class, stage, state) in features(&model, &child, Side::Black) {
            model.weights.class_tables[class].stage_tables[stage][state] = 1.0;
        }
        let prediction = model.predict(&child, Side::Black);
        assert!(prediction > 0.0);
        assert_eq!(child_score(&model, &child, Side::Black), prediction);
    }

    #[test]
    fn child_score_uses_exact_parent_disc_difference_at_terminal() {
        let parent =
            parse_board("OOOOOOOOOOXXXXXOOXOOXXXOOOXOXXXOOOOOOXXOOOOOOOXOOOOXXOXOOOOOOOO-")
                .unwrap();
        let child = parent.apply_move(Side::White, 1u64 << 63);
        assert!(child.is_terminal());
        let model = Model::new(patterns::generate_patterns());
        assert_eq!(child_score(&model, &child, Side::White), 28.0);
    }
    #[test]
    fn pairwise_gradient_handles_opponent_pass_sign() {
        let parent = Board {
            black: 18_228_592_239_385_247_744,
            white: 1_130_496_464_523_264,
        };
        let mover = Side::Black;
        let pass_move = 57u8;
        let other_move = (parent.legal_moves(mover) & !(1u64 << pass_move)).trailing_zeros() as u8;
        assert!(other_move < 64);
        let record = DistillRecord {
            key: CanonicalKey(0, 0, 0),
            board: parent,
            mover,
            teacher_value: 4.0,
            outcome: None,
            children: vec![
                Child {
                    move_index: pass_move,
                    board: parent.apply_move(mover, 1u64 << pass_move),
                    teacher_value: 4.0,
                },
                Child {
                    move_index: other_move,
                    board: parent.apply_move(mover, 1u64 << other_move),
                    teacher_value: 0.0,
                },
            ],
            best: 0,
            pairs: vec![1],
        };
        assert_eq!(record.children[0].board.legal_moves(Side::White), 0);
        assert_ne!(record.children[0].board.legal_moves(Side::Black), 0);
        let mut model = Model::new(patterns::generate_patterns());
        let difference = |model: &Model| {
            child_score(model, &record.children[0].board, mover)
                - child_score(model, &record.children[1].board, mover)
        };
        let before = difference(&model);
        train_step(
            &mut model,
            &record,
            Mix {
                name: "ranking",
                teacher: 0.0,
                ranking: 1.0,
                outcome: 0.0,
            },
            0.001,
            0.0,
        );
        assert!(difference(&model) > before);
    }

    #[test]
    fn resume_truncates_metrics_rows_newer_than_checkpoint() {
        let path = env::temp_dir().join(format!("t090-metrics-fixture-{}.tsv", std::process::id()));
        fs::write(&path, "epoch\tloss\n1\t1.0\n2\t0.9\n2\t0.9\n3\t0.8\n").unwrap();
        truncate_metrics_after(&path, 2).unwrap();
        let result = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(result, "epoch\tloss\n1\t1.0\n2\t0.9\n");
    }

    #[test]
    fn canonical_split_hash_is_deterministic() {
        let key = CanonicalKey(12, 34, 1);
        assert_eq!(key_hash(key), key_hash(key));
        assert!(key_hash(key) % 100 < 100);
    }
}

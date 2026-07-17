//! T090b Edax-teacher distillation with mixed loss and epoch checkpoints.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;

use engine::bitboard::{Board, Side};
#[cfg(test)]
use engine::pattern_eval::stage_for_empty_count;
use engine::pattern_eval::{
    NUM_STAGES, STAGE_EMPTY_DIVISOR, V4_NUM_STAGES, V4_STAGE_EMPTY_DIVISOR,
};
use engine::patterns::{self, pattern_state_index};
use serde::Deserialize;

use crate::experiment::{self, CanonicalKey};
use crate::regression::Model;
use crate::{train_data, wthor};

const HUBER_DELTA: f32 = 4.0;
const DEFAULT_LR: f32 = 0.005;
const MIN_LR: f32 = 0.0003125;
const WTHOR_CACHE_SCHEMA: u32 = 1;
const WTHOR_CACHE_MAGIC: &[u8; 4] = b"T095";
/// `encode_outcome_cache`が1件のoutcomeエントリに書き出す固定バイト数
/// (key.0: 8, key.1: 8, key.2: 1, outcome: 4)。
const OUTCOME_ENTRY_BYTES: usize = 8 + 8 + 1 + 4;
/// `push_sample`が1件書き出す固定バイト数
/// (board.black: 8, board.white: 8, mover: 1, outcome: 4, last_move_kind: 1, vulnerable_xc: 1)。
const TEST_ENTRY_BYTES: usize = 8 + 8 + 1 + 4 + 1 + 1;

/// T109で`train_teacher_mae`列を追加した現行の`metrics.tsv`ヘッダ。
/// T109以前のrun dir(この列が無い旧ヘッダ)をresumeすると、新しい列数の
/// データ行が旧ヘッダの下に追記され列がずれてしまう(T109レビュー指摘M1)。
/// `ensure_metrics_header`でこの定数と既存ヘッダを照合し、不一致なら
/// resumeを拒否する。
const METRICS_HEADER: &str = "epoch\tlearning_rate\ttrain_loss\ttrain_teacher_mae\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae";

/// T110: `train_distillation`が学習するパターン集合。
/// `V2`は既存のv2特徴(22インスタンス/6クラス、`engine::patterns::generate_patterns`)、
/// `V3`はT087で構築したv3特徴(38インスタンス/10クラス、v2 + edge2x + diag567)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatternSet {
    V2,
    V3,
    V4,
}

/// `--pattern-set`の値をパースする。未指定または`"v2"`は`V2`(無指定時の
/// 既存動作を変えないための既定値)、`"v3"`/`"v4"`は対応する集合、それ以外はエラー。
fn parse_pattern_set(value: Option<String>) -> Result<PatternSet, String> {
    match value.as_deref() {
        None | Some("v2") => Ok(PatternSet::V2),
        Some("v3") => Ok(PatternSet::V3),
        Some("v4") => Ok(PatternSet::V4),
        Some(other) => Err(format!("invalid --pattern-set: {other}")),
    }
}

/// 選択されたパターン集合のセル定義を返す。
fn patterns_for(pattern_set: PatternSet) -> Vec<patterns::PatternCells> {
    match pattern_set {
        PatternSet::V2 => patterns::generate_patterns(),
        PatternSet::V3 | PatternSet::V4 => {
            patterns::generate_patterns_for(patterns::PatternConfig::V3)
        }
    }
}

fn stage_definition_for(pattern_set: PatternSet) -> (usize, u32) {
    match pattern_set {
        PatternSet::V2 | PatternSet::V3 => (NUM_STAGES, STAGE_EMPTY_DIVISOR),
        PatternSet::V4 => (V4_NUM_STAGES, V4_STAGE_EMPTY_DIVISOR),
    }
}

fn new_model(pattern_set: PatternSet) -> Model {
    let (num_stages, stage_empty_divisor) = stage_definition_for(pattern_set);
    Model::new_with_stage_definition(patterns_for(pattern_set), num_stages, stage_empty_divisor)
}

/// resume identityに混ぜ込む、pattern-set由来の識別行。
/// 既定値`V2`では空文字列を返し、無指定時のidentity文字列を従来どおり
/// 不変に保つ(T109の`train_subset_size`と同じ「既定値では追加しない」流儀)。
/// `V3`では非空の行を返すことで、pattern-setを取り違えたresume(例:
/// v3で開始したcheckpoint-dirへ`--pattern-set`無指定でresumeしようとする)を
/// 既存のidentity不一致チェックで確実に拒否させる。
fn pattern_set_identity_line(pattern_set: PatternSet) -> String {
    match pattern_set {
        PatternSet::V2 => String::new(),
        PatternSet::V4 => format!("pattern_set=v4{}", char::from(10)),
        PatternSet::V3 => "pattern_set=v3\n".to_string(),
    }
}

/// `metrics.tsv`のヘッダを検証・確保する。ファイルが無ければ現行ヘッダで
/// 新規作成し、既にあれば1行目が現行ヘッダと一致することを確認する
/// (T109レビュー指摘M1: 旧ヘッダのまま新しい列数の行を追記して列がずれる事故を防ぐ)。
fn ensure_metrics_header(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return atomic_write(path, format!("{METRICS_HEADER}\n").as_bytes());
    }
    let existing = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let header = existing.lines().next().unwrap_or("");
    if header != METRICS_HEADER {
        return Err(format!(
            "metrics.tsv header mismatch in {}: expected \"{METRICS_HEADER}\", found \"{header}\" \
             (refusing to resume from an incompatible run directory; T109 review finding M1)",
            path.display()
        ));
    }
    Ok(())
}

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
            "outcome-only" => Ok(Self {
                name: "outcome-only",
                teacher: 0.0,
                ranking: 0.0,
                outcome: 1.0,
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

fn wthor_files() -> Result<(Vec<(PathBuf, Vec<u8>)>, String), String> {
    let mut hash = 0xcbf29ce484222325;
    let mut paths: Vec<_> = fs::read_dir("train/data")
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "wtb"))
        .collect();
    paths.sort();
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        hash = fnv_update(hash, path.to_string_lossy().as_bytes());
        hash = fnv_update(hash, &bytes);
        files.push((path, bytes));
    }
    Ok((files, format!("{hash:016x}")))
}

fn push_sample(bytes: &mut Vec<u8>, sample: &train_data::Sample) {
    bytes.extend_from_slice(&sample.board.black.to_le_bytes());
    bytes.extend_from_slice(&sample.board.white.to_le_bytes());
    bytes.push(match sample.mover {
        Side::Black => 0,
        Side::White => 1,
    });
    bytes.extend_from_slice(&sample.outcome.to_bits().to_le_bytes());
    bytes.push(match sample.last_move_kind {
        train_data::LastMoveKind::Other => 0,
        train_data::LastMoveKind::X => 1,
        train_data::LastMoveKind::C => 2,
    });
    bytes.push(u8::from(sample.vulnerable_xc));
}

fn encode_outcome_cache(
    outcomes: &HashMap<CanonicalKey, f32>,
    test: &[train_data::Sample],
    wthor_hash: &str,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(WTHOR_CACHE_MAGIC);
    bytes.extend_from_slice(&WTHOR_CACHE_SCHEMA.to_le_bytes());
    bytes.extend_from_slice(&(wthor_hash.len() as u32).to_le_bytes());
    bytes.extend_from_slice(wthor_hash.as_bytes());
    bytes.extend_from_slice(&(outcomes.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(test.len() as u64).to_le_bytes());
    let mut entries: Vec<_> = outcomes.iter().collect();
    entries.sort_by_key(|(key, _)| **key);
    for (key, outcome) in entries {
        bytes.extend_from_slice(&key.0.to_le_bytes());
        bytes.extend_from_slice(&key.1.to_le_bytes());
        bytes.push(key.2);
        bytes.extend_from_slice(&outcome.to_bits().to_le_bytes());
    }
    for sample in test {
        push_sample(&mut bytes, sample);
    }
    bytes
}

struct CacheReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> CacheReader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("cache_size_overflow")?;
        let value = self.bytes.get(self.offset..end).ok_or("truncated_cache")?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
}

fn decode_outcome_cache(
    bytes: &[u8],
    expected_hash: &str,
) -> Result<(HashMap<CanonicalKey, f32>, Vec<train_data::Sample>), String> {
    let mut reader = CacheReader { bytes, offset: 0 };
    if reader.take(4)? != WTHOR_CACHE_MAGIC {
        return Err("bad_magic".into());
    }
    if reader.u32()? != WTHOR_CACHE_SCHEMA {
        return Err("bad_schema".into());
    }
    let hash_len = reader.u32()? as usize;
    if reader.take(hash_len)? != expected_hash.as_bytes() {
        return Err("bad_hash".into());
    }
    let outcome_count = reader.u64()? as usize;
    let test_count = reader.u64()? as usize;
    // 件数フィールドが壊れている(改ざん・破損)場合に、内容を読む前の
    // `with_capacity` だけで過大メモリ確保しないよう、残りバイト数と
    // checked arithmeticで整合性を確認してから確保する。
    let outcome_bytes = outcome_count
        .checked_mul(OUTCOME_ENTRY_BYTES)
        .ok_or("cache_size_overflow")?;
    let test_bytes = test_count
        .checked_mul(TEST_ENTRY_BYTES)
        .ok_or("cache_size_overflow")?;
    let required_bytes = outcome_bytes
        .checked_add(test_bytes)
        .ok_or("cache_size_overflow")?;
    if bytes.len().saturating_sub(reader.offset) < required_bytes {
        return Err("truncated_cache".into());
    }
    let mut outcomes = HashMap::with_capacity(outcome_count);
    for _ in 0..outcome_count {
        let key = CanonicalKey(reader.u64()?, reader.u64()?, reader.u8()?);
        let outcome = f32::from_bits(reader.u32()?);
        if outcomes.insert(key, outcome).is_some() {
            return Err("duplicate_key".into());
        }
    }
    let mut test = Vec::with_capacity(test_count);
    for _ in 0..test_count {
        let board = Board {
            black: reader.u64()?,
            white: reader.u64()?,
        };
        let mover = match reader.u8()? {
            0 => Side::Black,
            1 => Side::White,
            _ => return Err("bad_mover".into()),
        };
        let outcome = f32::from_bits(reader.u32()?);
        let last_move_kind = match reader.u8()? {
            0 => train_data::LastMoveKind::Other,
            1 => train_data::LastMoveKind::X,
            2 => train_data::LastMoveKind::C,
            _ => return Err("bad_last_move".into()),
        };
        let vulnerable_xc = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err("bad_vulnerable".into()),
        };
        test.push(train_data::Sample {
            board,
            mover,
            outcome,
            last_move_kind,
            vulnerable_xc,
        });
    }
    if reader.offset != bytes.len() {
        return Err("trailing_bytes".into());
    }
    Ok((outcomes, test))
}

fn load_outcomes() -> Result<(HashMap<CanonicalKey, f32>, Vec<train_data::Sample>, String), String>
{
    let (files, wthor_hash) = wthor_files()?;
    let cache_path = PathBuf::from(format!(
        "train/data/t090-wthor-outcomes-v{WTHOR_CACHE_SCHEMA}-{wthor_hash}.bin"
    ));
    if let Ok(bytes) = fs::read(&cache_path) {
        if let Ok((outcomes, test)) = decode_outcome_cache(&bytes, &wthor_hash) {
            println!("wthor_cache_hit={}", cache_path.display());
            return Ok((outcomes, test, wthor_hash));
        }
        eprintln!("invalid_wthor_cache={}", cache_path.display());
    }
    let mut training_raw = Vec::new();
    let mut test_raw = Vec::new();
    for (path, bytes) in files {
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
    let cache_bytes = encode_outcome_cache(&outcomes, &test, &wthor_hash);
    save_cache_best_effort(&cache_path, &cache_bytes);
    Ok((outcomes, test, wthor_hash))
}

/// キャッシュはあくまで高速化用途なので、書き込みに失敗しても学習全体を
/// 失敗させない(メモリ上に構築済みのoutcomes/testで続行できる)。書き込み不可の
/// 環境(読み取り専用の`train/data`等)でも、従来どおり学習を起動できるようにする。
fn save_cache_best_effort(path: &Path, bytes: &[u8]) {
    match atomic_write(path, bytes) {
        Ok(()) => println!("wthor_cache_built={}", path.display()),
        Err(error) => eprintln!("wthor_cache_write_failed={}: {error}", path.display()),
    }
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
    let stage = model.weights.stage_for_empty_count(board.empty_count());
    let info = &model.weights.class_info;
    (0..model.weights.patterns.len())
        .map(|i| {
            let state = pattern_state_index(&info.aligned_cells[i], board, mover) as usize;
            (info.class_of[i], stage, state)
        })
        .collect()
}

fn prediction_from_features(model: &Model, items: &[Feature]) -> f32 {
    let mut prediction = 0.0;
    for &(class, stage, state) in items {
        prediction += model.weights.class_tables[class].stage_tables[stage][state];
    }
    prediction
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

fn child_score_features(
    model: &Model,
    child: &Board,
    parent_mover: Side,
) -> (f32, Vec<Feature>, f32) {
    let opponent = parent_mover.opposite();
    if child.has_legal_move(opponent) {
        let items = features(model, child, opponent);
        (-prediction_from_features(model, &items), items, -1.0)
    } else if child.has_legal_move(parent_mover) {
        let items = features(model, child, parent_mover);
        (prediction_from_features(model, &items), items, 1.0)
    } else {
        let score = child.disc_count(parent_mover) as f32 - child.disc_count(opponent) as f32;
        (score, Vec::new(), 0.0)
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
    let prediction = prediction_from_features(model, &parent_features);
    let (teacher_loss, teacher_gradient) = huber(prediction - record.teacher_value);
    let mut gradient = HashMap::new();
    // T112: teacher_weightがちょうど0(outcome-onlyの主経路)のとき、
    // add_gradientを無条件に呼ぶとgradientマップにvalue=0.0のエントリが
    // 作られ、末尾のL2減衰(weight -= lr*(value + l2*weight))がこの局面が
    // 触れた特徴だけに余計にかかってしまう。outcomeが無い局面(outcome-only
    // では学習に使えずスキップされるべき)でこれが唯一のadd_gradient経路に
    // なるため、teacher_weight==0のときは呼ばない(完全スキップを保証する)。
    if teacher_weight != 0.0 {
        add_gradient(
            &mut gradient,
            &parent_features,
            teacher_weight * teacher_gradient,
        );
    }

    let mut ranking_loss = 0.0;
    if ranking_weight > 0.0 && !record.pairs.is_empty() {
        let (best_score, best_features, best_sign) =
            child_score_features(model, &record.children[record.best].board, record.mover);
        for &other in &record.pairs {
            let other_score = child_score(model, &record.children[other].board, record.mover);
            let target =
                record.children[record.best].teacher_value - record.children[other].teacher_value;
            let (loss, loss_gradient) = huber((best_score - other_score) - target);
            ranking_loss += loss / record.pairs.len() as f32;
            let scale = ranking_weight * loss_gradient / record.pairs.len() as f32;
            add_gradient(&mut gradient, &best_features, best_sign * scale);
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

/// `seed`と`phase`から、フェーズごとに独立したシャッフルseedを決定論的に導く。
fn subset_seed_for_phase(seed: u64, phase: usize) -> u64 {
    let hash = fnv_update(0xcbf29ce484222325, &seed.to_le_bytes());
    fnv_update(hash, &[phase as u8])
}

/// T109: 既存コーパスのtrain splitから、空きマス帯(phase)で層化した
/// 入れ子(nested)部分集合を決定論的に抽出する。
///
/// 「入れ子」とは、同一`seed`について `target` を大きくしていくと、小さい方の
/// 抽出結果が常に大きい方の抽出結果の部分集合になることを指す。これはフェーズ内の
/// シャッフル順序を`target`に依存させず、各フェーズの採用件数
/// `floor(target * phase_count / total)`だけをtargetの関数として単調非減少に
/// することで保証している(同じ並び替え済み配列の接頭辞を伸ばすだけなので、
/// 小さいtargetの選択は必ず大きいtargetの選択に含まれる)。
///
/// `target >= records.len()`の場合は全量をそのまま返す(無引数時の既存動作を
/// 変えないため、この関数自体を呼ばない経路もrun()側に用意している)。
/// 各フェーズの採用件数はfloor演算のため、合計は`target`よりわずかに
/// (最大でも選択したpattern-setのステージ数未満)少なくなり得る。
fn select_train_subset(
    records: Vec<DistillRecord>,
    target: usize,
    seed: u64,
    pattern_set: PatternSet,
) -> Vec<DistillRecord> {
    let total = records.len();
    if target >= total {
        return records;
    }
    let (num_stages, stage_empty_divisor) = stage_definition_for(pattern_set);
    let mut by_phase: Vec<Vec<usize>> = vec![Vec::new(); num_stages];
    for (index, record) in records.iter().enumerate() {
        let phase =
            ((record.board.empty_count() / stage_empty_divisor) as usize).min(num_stages - 1);
        by_phase[phase].push(index);
    }
    let mut selected = Vec::with_capacity(target);
    for (phase, mut group) in by_phase.into_iter().enumerate() {
        if group.is_empty() {
            continue;
        }
        // ファイル/ハッシュ由来の元順序に依存しない安定した基準順を先に作ってから
        // シャッフルする(同じ集合なら常に同じ基準順になる)。
        group.sort_by_key(|&index| records[index].key);
        let phase_seed = subset_seed_for_phase(seed, phase);
        let order = shuffle(group.len(), phase_seed);
        let cutpoint = ((target as u128 * group.len() as u128) / total as u128) as usize;
        for &local in &order[..cutpoint] {
            selected.push(group[local]);
        }
    }
    selected.sort_unstable();
    let mut slots: Vec<Option<DistillRecord>> = records.into_iter().map(Some).collect();
    selected
        .into_iter()
        .map(|index| slots[index].take().expect("subset index selected twice"))
        .collect()
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
    pattern_set: PatternSet,
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

    let mut model = new_model(pattern_set);
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
    // T109: train側のteacher MAEも毎epoch記録する(train_lossは混合損失であり、
    // 過学習ギャップの直接観測にはvalidation側との比較が別途必要なため)。
    // T110(M1)/T112(M1'): ヘッダが無ければ現行ヘッダで作成し、あれば現行ヘッダと
    // 一致することを確認する(不一致なら列ずれを防ぐため明確なエラーで停止する)。
    // ヘッダ検証は`truncate_metrics_after`より先に行う: 旧順序では不一致ヘッダの
    // ファイルでも`truncate_metrics_after`がatomic_writeで一度書き戻してしまい、
    // 直後にこのチェックが拒否しても副作用(ファイル変更)が既に発生していた
    // (T110レビュー指摘M1'、resumeを拒否する経路が完全には副作用フリーでない)。
    ensure_metrics_header(&metrics_path)?;
    truncate_metrics_after(&metrics_path, epoch)?;
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
        // train側のteacher MAEは重み更新後のモデルで、trainサブセット(または全量)
        // 全件に対するforward-onlyの再評価。数値結果(重み・train_loss)には影響しない。
        let train_metrics = metrics(&model, train, mix);
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
            "{epoch}\t{learning_rate:.7}\t{train_loss:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\n",
            train_metrics.teacher_mae,
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
    let train_metrics = metrics(&best_model, train, mix);
    let validation_metrics = metrics(&best_model, validation, mix);
    let frozen_metrics = metrics(&best_model, frozen, mix);
    let wthor_2024_mae = best_model.mean_absolute_error(wthor_2024);
    let bytes = best_model.to_bytes_v3();
    atomic_write(&dir.join("final.bin"), &bytes)?;
    atomic_write(&dir.join("complete.txt"), identity.as_bytes())?;
    let result = format!("mix\tseed\tbest_epoch\tepochs\ttrain_size\ttrain_teacher_mae\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae\tfrozen_agreement\tfrozen_mean_regret\twthor_2024_mae\tbytes\n{}\t{seed}\t{best_epoch}\t{epoch}\t{}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{wthor_2024_mae:.6}\t{}\n",
        mix.name, train.len(), train_metrics.teacher_mae, validation_metrics.mixed, validation_metrics.teacher_mae,
        validation_metrics.ranking_mae, frozen_metrics.agreement,
        frozen_metrics.regret, bytes.len());
    atomic_write(&dir.join("result.tsv"), result.as_bytes())
}

#[allow(clippy::too_many_arguments)]
fn run_all(
    runs: &[(Mix, u64)],
    jobs: usize,
    train: &[DistillRecord],
    validation: &[DistillRecord],
    frozen: &[DistillRecord],
    wthor_2024: &[train_data::Sample],
    root: &Path,
    identity: &str,
    max_epochs: u32,
    l2: f32,
    pattern_set: PatternSet,
) -> Result<(), String> {
    for batch in runs.chunks(jobs) {
        thread::scope(|scope| -> Result<(), String> {
            let handles: Vec<_> = batch
                .iter()
                .map(|&(mix, seed)| {
                    scope.spawn(move || {
                        run_one(
                            mix, seed, train, validation, frozen, wthor_2024, root, identity,
                            max_epochs, l2, pattern_set,
                        )
                    })
                })
                .collect();
            for handle in handles {
                match handle.join() {
                    Ok(result) => result?,
                    Err(_) => return Err("distillation_worker_panicked".into()),
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// `--mixes`内の重複したmix名を検出する。重複したmix/seedの組はrun_all内の
/// 直積で同一checkpoint dirへの競合書き込みを引き起こすため、runより前に拒否する。
fn find_duplicate_mix(mixes: &[Mix]) -> Option<&'static str> {
    let mut seen = HashSet::new();
    mixes
        .iter()
        .find(|mix| !seen.insert(mix.name))
        .map(|mix| mix.name)
}

/// `--seeds`内の重複したseed値を検出する(用途は`find_duplicate_mix`と同じ)。
fn find_duplicate_seed(seeds: &[u64]) -> Option<u64> {
    let mut seen = HashSet::new();
    seeds.iter().find(|&&seed| !seen.insert(seed)).copied()
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
    if let Some(name) = find_duplicate_mix(&mixes) {
        eprintln!("duplicate --mixes entry: {name}");
        return ExitCode::FAILURE;
    }
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
    if let Some(seed) = find_duplicate_seed(&seeds) {
        eprintln!("duplicate --seeds entry: {seed}");
        return ExitCode::FAILURE;
    }
    let run_count = mixes.len().saturating_mul(seeds.len());
    let default_jobs = thread::available_parallelism()
        .map_or(1, usize::from)
        .min(run_count.max(1));
    let jobs = match arg("--jobs").map(|value| value.parse::<usize>()) {
        Some(Ok(0)) => {
            eprintln!("--jobs_must_be_positive");
            return ExitCode::FAILURE;
        }
        Some(Ok(value)) => value.min(run_count.max(1)),
        Some(Err(error)) => {
            eprintln!("invalid_--jobs:{error}");
            return ExitCode::FAILURE;
        }
        None => default_jobs,
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
    // T109: train splitのみを対象にした入れ子(nested)層化サブサンプリング。
    // 未指定なら従来どおり全量(挙動不変)。
    let train_subset_size = match arg("--train-subset-size").map(|value| value.parse::<usize>()) {
        Some(Ok(value)) => Some(value),
        Some(Err(error)) => {
            eprintln!("invalid --train-subset-size: {error}");
            return ExitCode::FAILURE;
        }
        None => None,
    };
    let subset_seed = match arg("--subset-seed").map(|value| value.parse::<u64>()) {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            eprintln!("invalid --subset-seed: {error}");
            return ExitCode::FAILURE;
        }
        None => 42,
    };
    // T110: 学習するパターン集合(v2/v3)。未指定はv2(既存動作を変えない既定値)。
    let pattern_set = match parse_pattern_set(arg("--pattern-set")) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
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
    let full_train_len = train.len();
    if let Some(target) = train_subset_size {
        if target == 0 {
            eprintln!("--train-subset-size must be positive");
            return ExitCode::FAILURE;
        }
        train = select_train_subset(train, target, subset_seed, pattern_set);
        if train.is_empty() {
            eprintln!("--train-subset-size produced an empty train split");
            return ExitCode::FAILURE;
        }
    }
    let corpus_hash = format!(
        "{:016x}",
        fnv_update(0xcbf29ce484222325, &fs::read(&corpus).unwrap())
    );
    let reference_hash = format!("{:016x}", fnv_update(0xcbf29ce484222325, &reference_bytes));
    fs::create_dir_all(&root).unwrap();
    let subset_manifest_line = match train_subset_size {
        Some(target) => format!(
            "train_subset_size_target={target}\ntrain_subset_seed={subset_seed}\ntrain_full_size={full_train_len}\n"
        ),
        None => format!("train_subset_size_target=full\ntrain_full_size={full_train_len}\n"),
    };
    // T110: 学習に使ったパターン集合を記録する(参照モデル`reference`は
    // pattern_setに関わらず常にpattern_v2.bin/PWV2のまま。engineChoiceの構築と
    // reference.tsvの比較基準値の算出だけに使い、学習対象モデルの初期化は
    // pattern_setに関わらず常にゼロ初期化なので、参照重みの役割はv2/v3で変わらない)。
    let pattern_set_manifest_line = format!(
        "pattern_set={}\n",
        match pattern_set {
            PatternSet::V2 => "v2",
            PatternSet::V3 => "v3",
            PatternSet::V4 => "v4",
        }
    );
    let manifest = format!("split=fnv1a(canonicalKey)%100:train0-89,validation90-94,frozen95-99\noutcome_policy=canonical averages from WTHOR 2015-2023; keys occurring in 2024 removed with test priority; 2024 reserved for gate c\ntrain={}\nvalidation={}\nfrozen={}\noutcome_matched_train={}\noutcome_matched_validation={}\noutcome_matched_frozen={}\nwthor_2024={}\ncorpus_hash={corpus_hash}\nreference_hash={reference_hash}\nwthor_hash={wthor_hash}\n{subset_manifest_line}{pattern_set_manifest_line}",
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
    // 引数無し(全量・v2)の場合はidentity文字列を従来どおり不変に保つ(既存動作の
    // 無引数不変要件)。サブセット指定時・pattern-set=v3/v4指定時のみ、誤って別配置と
    // 取り違えて resume しないよう識別情報を追加する。
    let subset_identity = match train_subset_size {
        Some(target) => {
            format!("train_subset_size_target={target}\ntrain_subset_seed={subset_seed}\n")
        }
        None => String::new(),
    };
    let identity = format!("corpus_hash={corpus_hash}\nreference_hash={reference_hash}\nwthor_hash={wthor_hash}\ntrain={}\nvalidation={}\nfrozen={}\n{subset_identity}{}",
        train.len(), validation.len(), frozen.len(), pattern_set_identity_line(pattern_set));
    let runs: Vec<_> = mixes
        .into_iter()
        .flat_map(|mix| seeds.iter().map(move |&seed| (mix, seed)))
        .collect();
    println!("distillation_jobs={jobs}");
    if let Err(error) = run_all(
        &runs,
        jobs,
        &train,
        &validation,
        &frozen,
        &wthor_2024,
        &root,
        &identity,
        max_epochs,
        l2,
        pattern_set,
    ) {
        eprintln!("{error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_train_step(
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
                let best_score =
                    child_score(model, &record.children[record.best].board, record.mover);
                let other_score = child_score(model, &record.children[other].board, record.mover);
                let target = record.children[record.best].teacher_value
                    - record.children[other].teacher_value;
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
        teacher_weight * teacher_loss
            + ranking_weight * ranking_loss
            + outcome_weight * outcome_loss
    }

    #[test]
    fn outcome_cache_round_trips_and_rejects_wrong_key() {
        let mut outcomes = HashMap::new();
        outcomes.insert(CanonicalKey(11, 22, 1), f32::from_bits(0x40a00001));
        outcomes.insert(CanonicalKey(3, 4, 0), -7.25);
        let test = vec![train_data::Sample {
            board: Board {
                black: 5,
                white: 10,
            },
            mover: Side::White,
            outcome: f32::from_bits(0xc0e80001),
            last_move_kind: train_data::LastMoveKind::C,
            vulnerable_xc: true,
        }];
        let bytes = encode_outcome_cache(&outcomes, &test, "abc123");
        let (decoded_outcomes, decoded_test) = decode_outcome_cache(&bytes, "abc123").unwrap();
        assert_eq!(decoded_outcomes, outcomes);
        assert_eq!(decoded_test, test);
        assert_eq!(
            encode_outcome_cache(&decoded_outcomes, &decoded_test, "abc123"),
            bytes
        );
        assert!(decode_outcome_cache(&bytes, "different").is_err());
        assert!(decode_outcome_cache(&bytes[..bytes.len() - 1], "abc123").is_err());
    }

    #[test]
    fn optimized_train_step_is_bit_identical_to_legacy_calculation() {
        let board = Board::initial();
        let mover = Side::Black;
        let children: Vec<_> = [19u8, 26, 37, 44]
            .into_iter()
            .enumerate()
            .map(|(index, move_index)| Child {
                move_index,
                board: board.apply_move(mover, 1u64 << move_index),
                teacher_value: 8.0 - index as f32 * 2.0,
            })
            .collect();
        let record = DistillRecord {
            key: CanonicalKey(0, 0, 0),
            board,
            mover,
            teacher_value: 8.0,
            outcome: Some(3.5),
            children,
            best: 0,
            pairs: vec![1, 2, 3],
        };
        let mix = Mix::parse("baseline").unwrap();
        let mut legacy = Model::new(patterns::generate_patterns());
        let mut optimized = legacy.clone();
        for _ in 0..10 {
            let old_loss = legacy_train_step(&mut legacy, &record, mix, 0.005, 1e-5);
            let new_loss = train_step(&mut optimized, &record, mix, 0.005, 1e-5);
            assert_eq!(new_loss.to_bits(), old_loss.to_bits());
            assert_eq!(optimized.to_bytes_v3(), legacy.to_bytes_v3());
        }
    }

    #[test]
    fn outcome_missing_renormalizes_remaining_terms() {
        let mix = Mix::parse("baseline").unwrap();
        assert_eq!(mix.coefficients(false), (2.0 / 3.0, 1.0 / 3.0, 0.0));
        assert_eq!(
            Mix::parse("teacher-only").unwrap().coefficients(false),
            (1.0, 0.0, 0.0)
        );
    }

    /// T112: outcome-only(teacher 0 / ranking 0 / outcome 1.0)は既存の
    /// 再正規化規約(`coefficients`)と整合し、outcomeがあれば(0,0,1.0)、
    /// 無ければ再正規化する分母(teacher+ranking)が0なので(0,0,0)になる
    /// (=学習に一切寄与しない完全スキップ)。
    #[test]
    fn outcome_only_mix_has_pure_outcome_coefficients_and_is_fully_skipped_without_outcome() {
        let mix = Mix::parse("outcome-only").unwrap();
        assert_eq!(mix.teacher, 0.0);
        assert_eq!(mix.ranking, 0.0);
        assert_eq!(mix.outcome, 1.0);
        assert_eq!(mix.coefficients(true), (0.0, 0.0, 1.0));
        assert_eq!(mix.coefficients(false), (0.0, 0.0, 0.0));
    }

    /// T112: outcome-onlyでoutcomeが無いレコードは`train_step`が完全な
    /// no-op(loss=0・重み一切不変)であることを確認する。teacher項の
    /// `add_gradient`をteacher_weight==0でも無条件に呼ぶと、value=0.0の
    /// エントリがgradientマップに作られてしまい、末尾のL2減衰
    /// (`weight -= lr*(value + l2*weight)`)がこの局面の触れた特徴だけに
    /// 余計にかかる(スキップのはずが微小な重み減衰が発生する)退行を防ぐ。
    #[test]
    fn train_step_is_a_full_no_op_for_outcome_only_mix_without_outcome() {
        let mix = Mix::parse("outcome-only").unwrap();
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
            teacher_value: 8.0,
            outcome: None,
            children,
            best: 0,
            pairs: vec![1],
        };
        let mut model = Model::new(patterns::generate_patterns());
        let before = model.to_bytes_v3();
        let loss = train_step(&mut model, &record, mix, 0.005, 1e-5);
        assert_eq!(loss, 0.0);
        assert_eq!(model.to_bytes_v3(), before);
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

    /// テスト用の最小`DistillRecord`。`select_train_subset`は`board`(の空きマス数から
    /// 求まるphase)と`key`しか見ないため、他フィールドはダミー値でよい。
    fn fixture_record(index: u64, phase: usize) -> DistillRecord {
        let filled = 64usize.saturating_sub(phase * 5);
        let black = if filled >= 64 {
            u64::MAX
        } else {
            (1u64 << filled) - 1
        };
        DistillRecord {
            key: CanonicalKey(index, 0, 0),
            board: Board { black, white: 0 },
            mover: Side::Black,
            teacher_value: 0.0,
            outcome: None,
            children: Vec::new(),
            best: 0,
            pairs: Vec::new(),
        }
    }

    #[test]
    fn select_train_subset_target_at_or_above_total_returns_all_records_unchanged() {
        let records: Vec<_> = (0..10).map(|i| fixture_record(i, (i % 4) as usize)).collect();
        let total = records.len();
        let subset = select_train_subset(records.clone(), total, 1, PatternSet::V2);
        assert_eq!(subset.len(), total);
        let subset_over = select_train_subset(records, total + 5, 1, PatternSet::V2);
        assert_eq!(subset_over.len(), total);
    }

    #[test]
    fn select_train_subset_is_deterministic_for_same_seed() {
        let records: Vec<_> = (0..500)
            .map(|i| fixture_record(i, (i % 13) as usize))
            .collect();
        let a = select_train_subset(records.clone(), 120, 7, PatternSet::V2);
        let b = select_train_subset(records, 120, 7, PatternSet::V2);
        assert_eq!(
            a.iter().map(|r| r.key).collect::<Vec<_>>(),
            b.iter().map(|r| r.key).collect::<Vec<_>>()
        );
    }

    #[test]
    fn select_train_subset_nests_across_increasing_sizes() {
        let records: Vec<_> = (0..900)
            .map(|i| fixture_record(i, (i % 13) as usize))
            .collect();
        let seed = 99;
        let small = select_train_subset(records.clone(), 90, seed, PatternSet::V2);
        let medium = select_train_subset(records.clone(), 300, seed, PatternSet::V2);
        let large = select_train_subset(records, 700, seed, PatternSet::V2);
        let small_keys: HashSet<_> = small.iter().map(|r| r.key).collect();
        let medium_keys: HashSet<_> = medium.iter().map(|r| r.key).collect();
        let large_keys: HashSet<_> = large.iter().map(|r| r.key).collect();
        assert!(
            small_keys.is_subset(&medium_keys),
            "small subset must be nested inside the medium subset"
        );
        assert!(
            medium_keys.is_subset(&large_keys),
            "medium subset must be nested inside the large subset"
        );
        // floor除算のため合計は要求サイズよりわずかに少なくなり得る(最大でもNUM_STAGES件未満)。
        assert!(small.len() <= 90 && small.len() + NUM_STAGES > 90);
    }

    #[test]
    fn select_train_subset_preserves_phase_proportions_by_floor() {
        let mut records = Vec::new();
        for i in 0..400u64 {
            records.push(fixture_record(i, 0));
        }
        for i in 400..500u64 {
            records.push(fixture_record(i, 1));
        }
        let subset = select_train_subset(records, 100, 5, PatternSet::V2);
        let phase0 = subset
            .iter()
            .filter(|r| stage_for_empty_count(r.board.empty_count()) == 0)
            .count();
        let phase1 = subset
            .iter()
            .filter(|r| stage_for_empty_count(r.board.empty_count()) == 1)
            .count();
        assert_eq!(phase0, 80, "floor(100 * 400 / 500) = 80");
        assert_eq!(phase1, 20, "floor(100 * 100 / 500) = 20");
    }

    #[test]
    fn decode_outcome_cache_rejects_overflowing_count_without_large_allocation() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(WTHOR_CACHE_MAGIC);
        bytes.extend_from_slice(&WTHOR_CACHE_SCHEMA.to_le_bytes());
        let hash = "abc123";
        bytes.extend_from_slice(&(hash.len() as u32).to_le_bytes());
        bytes.extend_from_slice(hash.as_bytes());
        // outcome_countを桁あふれさせる壊れた値。checked_mulでオーバーフローを検出し、
        // `HashMap::with_capacity`へ到達する前にErrで打ち切ることを確認する。
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        assert_eq!(
            decode_outcome_cache(&bytes, hash).unwrap_err(),
            "cache_size_overflow"
        );
    }

    #[test]
    fn decode_outcome_cache_rejects_oversized_count_claiming_more_than_file_contains() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(WTHOR_CACHE_MAGIC);
        bytes.extend_from_slice(&WTHOR_CACHE_SCHEMA.to_le_bytes());
        let hash = "abc123";
        bytes.extend_from_slice(&(hash.len() as u32).to_le_bytes());
        bytes.extend_from_slice(hash.as_bytes());
        // 巨大だがオーバーフローはしない件数。ファイルにはその分のバイトが無いため、
        // 実際に確保する前にtruncated_cacheとして拒否されるはず。
        bytes.extend_from_slice(&1_000_000_000u64.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        assert_eq!(
            decode_outcome_cache(&bytes, hash).unwrap_err(),
            "truncated_cache"
        );
    }

    #[test]
    fn save_cache_best_effort_does_not_panic_when_directory_is_missing() {
        let missing_dir = env::temp_dir().join(format!(
            "t090-cache-fixture-missing-dir-{}",
            std::process::id()
        ));
        assert!(!missing_dir.exists());
        let path = missing_dir.join("cache.bin");
        save_cache_best_effort(&path, b"payload");
        assert!(!path.exists());
    }

    #[test]
    fn find_duplicate_mix_detects_repeated_names_only() {
        let baseline = Mix::parse("baseline").unwrap();
        let teacher_only = Mix::parse("teacher-only").unwrap();
        assert_eq!(find_duplicate_mix(&[baseline, teacher_only]), None);
        assert_eq!(
            find_duplicate_mix(&[baseline, baseline]),
            Some("baseline")
        );
    }

    #[test]
    fn find_duplicate_seed_detects_repeated_values_only() {
        assert_eq!(find_duplicate_seed(&[1, 2, 3]), None);
        assert_eq!(find_duplicate_seed(&[1, 2, 1]), Some(1));
    }

    #[test]
    fn parse_pattern_set_defaults_to_v2_and_rejects_unknown_values() {
        assert_eq!(parse_pattern_set(None), Ok(PatternSet::V2));
        assert_eq!(parse_pattern_set(Some("v2".into())), Ok(PatternSet::V2));
        assert_eq!(parse_pattern_set(Some("v3".into())), Ok(PatternSet::V3));
        assert_eq!(parse_pattern_set(Some("v4".into())), Ok(PatternSet::V4));
        assert!(parse_pattern_set(Some("v5".into())).is_err());
    }

    #[test]
    fn patterns_for_v3_has_more_instances_and_classes_than_v2() {
        let v2 = patterns_for(PatternSet::V2);
        let v3 = patterns_for(PatternSet::V3);
        let v4 = patterns_for(PatternSet::V4);
        // T087で確定したv2/v3のインスタンス数(22/38)・クラス数(6/10)。
        assert_eq!(v2.len(), 22);
        assert_eq!(v3.len(), 38);
        assert_eq!(v4, v3);
        let v2_classes = patterns::compute_pattern_classes(&v2)
            .representative_of_class
            .len();
        let v3_classes = patterns::compute_pattern_classes(&v3)
            .representative_of_class
            .len();
        assert_eq!(v2_classes, 6);
        assert_eq!(v3_classes, 10);
        assert_eq!(
            stage_definition_for(PatternSet::V4),
            (V4_NUM_STAGES, V4_STAGE_EMPTY_DIVISOR)
        );
    }

    #[test]
    fn pattern_set_identity_default_v2_is_empty_but_v3_is_distinct() {
        // v2(既定値)ではidentity文字列に何も追加しない(無指定時のidentity不変要件)。
        // v3では非空の行を返し、既存のidentity不一致チェックがpattern-setの
        // 取り違えresume(例: v3で作ったcheckpoint-dirへ--pattern-set無指定で
        // resumeしようとする)を確実に拒否できるようにする。
        assert_eq!(pattern_set_identity_line(PatternSet::V2), "");
        assert_eq!(
            pattern_set_identity_line(PatternSet::V3),
            "pattern_set=v3\n"
        );
        assert_ne!(
            pattern_set_identity_line(PatternSet::V2),
            pattern_set_identity_line(PatternSet::V3)
        );
        assert_ne!(
            pattern_set_identity_line(PatternSet::V3),
            pattern_set_identity_line(PatternSet::V4)
        );
    }

    #[test]
    fn ensure_metrics_header_creates_current_header_when_file_is_absent() {
        let dir = env::temp_dir().join(format!("t110-metrics-header-absent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("metrics.tsv");
        ensure_metrics_header(&path).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{METRICS_HEADER}\n")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_metrics_header_accepts_matching_header_without_modifying_file() {
        let dir = env::temp_dir().join(format!("t110-metrics-header-match-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("metrics.tsv");
        let body = format!("{METRICS_HEADER}\n1\t0.005\t1.0\t2.0\t3.0\t4.0\t5.0\n");
        fs::write(&path, &body).unwrap();
        ensure_metrics_header(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        fs::remove_dir_all(&dir).ok();
    }

    /// T109レビュー指摘M1: T109より前のrun dir(`train_teacher_mae`列が無い旧ヘッダ)を
    /// resumeしようとすると、明確なエラーで停止し、列がずれた行を黙って追記しない。
    #[test]
    fn ensure_metrics_header_rejects_pre_t109_header_without_train_teacher_mae_column() {
        let dir = env::temp_dir().join(format!("t110-metrics-header-stale-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("metrics.tsv");
        let stale_header =
            "epoch\tlearning_rate\ttrain_loss\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae";
        fs::write(
            &path,
            format!("{stale_header}\n1\t0.005\t1.0\t2.0\t3.0\t4.0\n"),
        )
        .unwrap();
        let error = ensure_metrics_header(&path).unwrap_err();
        assert!(
            error.contains("header mismatch"),
            "unexpected error message: {error}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// T110レビュー指摘M1'の回帰テスト: `run_one`が`ensure_metrics_header`より先に
    /// `truncate_metrics_after`を呼ぶと、ヘッダ不一致で最終的にrunを拒否する場合でも
    /// truncateが一度ファイルを書き戻してしまい(副作用フリーでない拒否経路)。修正後は
    /// ヘッダ検証を先に行うため、拒否時にmetrics.tsvが一切変更されないことを確認する。
    #[test]
    fn run_one_rejects_stale_header_before_truncate_mutates_the_file() {
        let root = env::temp_dir().join(format!("t112-m1-prime-order-{}", std::process::id()));
        fs::remove_dir_all(&root).ok();
        let mix = Mix::parse("teacher-only").unwrap();
        let run_dir = root.join(format!("{}-seed-{}", mix.name, 9u64));
        fs::create_dir_all(&run_dir).unwrap();
        let metrics_path = run_dir.join("metrics.tsv");
        let stale_header =
            "epoch\tlearning_rate\ttrain_loss\tvalidation_loss\tvalidation_teacher_mae\tvalidation_ranking_mae";
        let original =
            format!("{stale_header}\n1\t0.005\t1.0\t2.0\t3.0\t4.0\n2\t0.005\t0.9\t1.9\t2.9\t3.9\n");
        fs::write(&metrics_path, &original).unwrap();
        let before = fs::read(&metrics_path).unwrap();

        let empty_samples: &[train_data::Sample] = &[];
        let result = run_one(
            mix,
            9,
            &[],
            &[],
            &[],
            empty_samples,
            &root,
            "",
            1,
            1e-5,
            PatternSet::V2,
        );
        let error = result.unwrap_err();
        assert!(
            error.contains("header mismatch"),
            "unexpected error message: {error}"
        );

        let after = fs::read(&metrics_path).unwrap();
        assert_eq!(
            before, after,
            "T112 M1': header mismatch must be rejected before truncate_metrics_after mutates the file"
        );
        fs::remove_dir_all(&root).ok();
    }
}

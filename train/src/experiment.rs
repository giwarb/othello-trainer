//! T088の年代分割、D4 canonicalization、stage/X-C sampling。

use std::collections::HashMap;

use engine::bitboard::{Board, Side};
use engine::pattern_eval::{stage_for_empty_count, NUM_STAGES};
use engine::patterns::{apply_symmetry, NUM_SYMMETRIES};

use crate::train_data::{LastMoveKind, Sample};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CanonicalKey(pub u64, pub u64, pub u8);

#[derive(Debug, Clone)]
pub struct CanonicalRecord {
    pub sample: Sample,
    pub variance: f32,
    pub occurrences: u32,
    pub year: u16,
    pub phase: usize,
    pub last_move_other: u32,
    pub last_move_x: u32,
    pub last_move_c: u32,
    pub vulnerable_xc_occurrences: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LeakCounts {
    pub train_keys_removed_by_validation: usize,
    pub train_keys_removed_by_test: usize,
    pub validation_keys_removed_by_test: usize,
}

fn transform_bits(bits: u64, symmetry: usize) -> u64 {
    let mut transformed = 0u64;
    for cell in 0u8..64 {
        if bits & (1u64 << cell) != 0 {
            transformed |= 1u64 << apply_symmetry(symmetry, cell);
        }
    }
    transformed
}

pub fn canonicalize(sample: &Sample) -> (CanonicalKey, Board) {
    let mover = match sample.mover {
        Side::Black => 0,
        Side::White => 1,
    };
    (0..NUM_SYMMETRIES)
        .map(|symmetry| {
            let black = transform_bits(sample.board.black, symmetry);
            let white = transform_bits(sample.board.white, symmetry);
            (CanonicalKey(black, white, mover), Board { black, white })
        })
        .min_by_key(|(key, _)| *key)
        .unwrap()
}

#[derive(Debug)]
struct Accumulator {
    board: Board,
    mover: Side,
    sum: f64,
    sum_sq: f64,
    count: u32,
    year: u16,
    other: u32,
    x: u32,
    c: u32,
    vulnerable: u32,
}

pub fn aggregate(samples: &[(u16, Sample)]) -> HashMap<CanonicalKey, CanonicalRecord> {
    let mut map: HashMap<CanonicalKey, Accumulator> = HashMap::new();
    for &(year, sample) in samples {
        let (key, board) = canonicalize(&sample);
        let entry = map.entry(key).or_insert(Accumulator {
            board,
            mover: sample.mover,
            sum: 0.0,
            sum_sq: 0.0,
            count: 0,
            year,
            other: 0,
            x: 0,
            c: 0,
            vulnerable: 0,
        });
        let outcome = sample.outcome as f64;
        entry.sum += outcome;
        entry.sum_sq += outcome * outcome;
        entry.count += 1;
        entry.year = entry.year.max(year);
        match sample.last_move_kind {
            LastMoveKind::Other => entry.other += 1,
            LastMoveKind::X => entry.x += 1,
            LastMoveKind::C => entry.c += 1,
        }
        entry.vulnerable += u32::from(sample.vulnerable_xc);
    }
    map.into_iter()
        .map(|(key, value)| {
            let mean = value.sum / value.count as f64;
            let variance = (value.sum_sq / value.count as f64 - mean * mean).max(0.0) as f32;
            let last_move_kind = if value.x >= value.c && value.x >= value.other {
                LastMoveKind::X
            } else if value.c >= value.other {
                LastMoveKind::C
            } else {
                LastMoveKind::Other
            };
            let sample = Sample {
                board: value.board,
                mover: value.mover,
                outcome: mean as f32,
                last_move_kind,
                vulnerable_xc: value.vulnerable > 0,
            };
            (
                key,
                CanonicalRecord {
                    phase: stage_for_empty_count(value.board.empty_count()),
                    sample,
                    variance,
                    occurrences: value.count,
                    year: value.year,
                    last_move_other: value.other,
                    last_move_x: value.x,
                    last_move_c: value.c,
                    vulnerable_xc_occurrences: value.vulnerable,
                },
            )
        })
        .collect()
}

pub fn remove_cross_split_leaks(
    train: &mut HashMap<CanonicalKey, CanonicalRecord>,
    validation: &mut HashMap<CanonicalKey, CanonicalRecord>,
    test: &HashMap<CanonicalKey, CanonicalRecord>,
) -> LeakCounts {
    let train_before_test = train.len();
    train.retain(|key, _| !test.contains_key(key));
    let train_keys_removed_by_test = train_before_test - train.len();
    let validation_before = validation.len();
    validation.retain(|key, _| !test.contains_key(key));
    let validation_keys_removed_by_test = validation_before - validation.len();
    let train_before_validation = train.len();
    train.retain(|key, _| !validation.contains_key(key));
    LeakCounts {
        train_keys_removed_by_validation: train_before_validation - train.len(),
        train_keys_removed_by_test,
        validation_keys_removed_by_test,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SamplingConfig {
    pub stage_sampling: bool,
    pub xc_multiplier: f64,
    pub xc_cap: f64,
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
    fn unit(&mut self) -> f64 {
        (self.next() as f64) / (u64::MAX as f64 + 1.0)
    }
}

/// 元サンプル数と同数を重み付きで復元抽出する。X/C件数は指定cap以下。
pub fn sampling_order(samples: &[Sample], config: SamplingConfig, seed: u64) -> Vec<usize> {
    if samples.is_empty() {
        return Vec::new();
    }
    if !config.stage_sampling && config.xc_multiplier <= 1.0 {
        let mut order: Vec<usize> = (0..samples.len()).collect();
        let mut rng = Rng::new(seed);
        for i in (1..order.len()).rev() {
            let j = (rng.next() % (i as u64 + 1)) as usize;
            order.swap(i, j);
        }
        return order;
    }
    let mut counts = [0usize; NUM_STAGES];
    for sample in samples {
        counts[stage_for_empty_count(sample.board.empty_count())] += 1;
    }
    let max_count = *counts.iter().max().unwrap() as f64;
    let mut weights = Vec::with_capacity(samples.len());
    for sample in samples {
        let stage = stage_for_empty_count(sample.board.empty_count());
        let stage_weight = if config.stage_sampling {
            (max_count / counts[stage] as f64).sqrt().min(4.0)
        } else {
            1.0
        };
        let xc_weight = if sample.vulnerable_xc {
            config.xc_multiplier
        } else {
            1.0
        };
        weights.push(stage_weight * xc_weight);
    }
    let mut regular = Vec::new();
    let mut vulnerable = Vec::new();
    let mut regular_total = 0.0;
    let mut vulnerable_total = 0.0;
    for (index, &weight) in weights.iter().enumerate() {
        if samples[index].vulnerable_xc {
            vulnerable_total += weight;
            vulnerable.push((vulnerable_total, index));
        } else {
            regular_total += weight;
            regular.push((regular_total, index));
        }
    }
    let max_xc = ((samples.len() as f64) * config.xc_cap).floor() as usize;
    let mut rng = Rng::new(seed);
    let mut order = Vec::with_capacity(samples.len());
    let mut xc_count = 0usize;
    for _ in 0..samples.len() {
        let choose_xc = xc_count < max_xc
            && !vulnerable.is_empty()
            && (regular.is_empty()
                || rng.unit() * (regular_total + vulnerable_total) >= regular_total);
        let (cumulative, total) = if choose_xc {
            (&vulnerable, vulnerable_total)
        } else {
            (&regular, regular_total)
        };
        let ticket = rng.unit() * total;
        let position = cumulative.partition_point(|(sum, _)| *sum <= ticket);
        let selected = cumulative[position.min(cumulative.len() - 1)].1;
        xc_count += usize::from(samples[selected].vulnerable_xc);
        order.push(selected);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(board: Board, outcome: f32) -> Sample {
        Sample {
            board,
            mover: Side::Black,
            outcome,
            last_move_kind: LastMoveKind::Other,
            vulnerable_xc: false,
        }
    }

    #[test]
    fn d4_positions_share_one_key_and_average_target() {
        let a = sample(
            Board {
                black: 1 << 1,
                white: 1 << 10,
            },
            4.0,
        );
        let b = sample(
            Board {
                black: 1 << 15,
                white: 1 << 22,
            },
            8.0,
        );
        assert_eq!(canonicalize(&a).0, canonicalize(&b).0);
        let map = aggregate(&[(2022, a), (2022, b)]);
        let record = map.values().next().unwrap();
        assert_eq!(record.sample.outcome, 6.0);
        assert_eq!(record.variance, 4.0);
        assert_eq!(record.occurrences, 2);
    }

    #[test]
    fn later_split_wins_without_leakage() {
        let s = sample(Board::initial(), 0.0);
        let mut train = aggregate(&[(2022, s)]);
        let mut validation = aggregate(&[(2023, s)]);
        let test = aggregate(&[(2024, s)]);
        let counts = remove_cross_split_leaks(&mut train, &mut validation, &test);
        assert!(train.is_empty() && validation.is_empty());
        assert_eq!(counts.train_keys_removed_by_test, 1);
        assert_eq!(counts.validation_keys_removed_by_test, 1);
    }

    #[test]
    fn sampling_is_deterministic_and_respects_xc_cap() {
        let mut samples = vec![sample(Board::initial(), 0.0); 100];
        for item in samples.iter_mut().take(50) {
            item.vulnerable_xc = true;
        }
        let config = SamplingConfig {
            stage_sampling: true,
            xc_multiplier: 4.0,
            xc_cap: 0.25,
        };
        let a = sampling_order(&samples, config, 7);
        assert_eq!(a, sampling_order(&samples, config, 7));
        assert_eq!(a.len(), samples.len());
        assert!(a.iter().filter(|&&i| samples[i].vulnerable_xc).count() <= 25);
    }
}

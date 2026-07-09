//! パターン特徴量に対するオンライン確率的勾配降下法(SGD)による線形回帰学習。
//!
//! 特徴は「アクティブな(パターンID, ステージ, 状態インデックス)の組」の集合
//! (1局面につき[`crate::patterns::generate_patterns`]の要素数=22個)。予測値は
//! アクティブな重みの単純合計。目的関数は (予測値 − 実際の最終石差)^2 + L2正則化。
//!
//! # ステージ分割
//!
//! 石差の意味合いは序盤・終盤で大きく異なるため、空きマス数によって
//! [`NUM_STAGES`]個のステージに分割し、ステージごとに独立した重みテーブルを持つ
//! ([`stage_for_empty_count`])。

use crate::patterns::{self, PatternCells};
use crate::train_data::Sample;
use engine::bitboard::Board;

/// ステージ数。`stage = empty_count / STAGE_EMPTY_DIVISOR`で、空きマス数0..60を
/// 0..12の13段階に分ける(60/5=12が最大インデックス)。
pub const NUM_STAGES: usize = 13;
/// ステージ分割の除数(空きマス5個ごとに1ステージ)。
pub const STAGE_EMPTY_DIVISOR: u32 = 5;

/// 空きマス数からステージ番号(`0 .. NUM_STAGES`)を求める。
pub fn stage_for_empty_count(empty_count: u32) -> usize {
    ((empty_count / STAGE_EMPTY_DIVISOR) as usize).min(NUM_STAGES - 1)
}

/// 1パターン分の重みテーブル(ステージごとに状態数分のf32配列を持つ)。
#[derive(Debug, Clone)]
pub struct PatternWeights {
    /// このパターンの状態数(3^パターン長)。
    pub num_states: u32,
    /// `stage_tables[stage][state_index]`が重み。
    pub stage_tables: Vec<Vec<f32>>,
}

/// 学習対象のパターン評価モデル。パターン形状の定義(`patterns`)と、
/// それに対応する重み(`weights`、`weights[i]`が`patterns[i]`の重み)を持つ。
#[derive(Debug, Clone)]
pub struct Model {
    pub patterns: Vec<PatternCells>,
    pub weights: Vec<PatternWeights>,
}

/// SGD学習のハイパーパラメータ。
#[derive(Debug, Clone, Copy)]
pub struct TrainConfig {
    /// 学習率。
    pub learning_rate: f32,
    /// L2正則化係数。
    pub l2: f32,
    /// エポック数(学習データ全体を何周するか)。
    pub epochs: u32,
    /// シャッフル順序を決める乱数シード(再現性のため固定値を渡す想定)。
    pub seed: u64,
}

impl Default for TrainConfig {
    fn default() -> Self {
        TrainConfig {
            learning_rate: 0.005,
            l2: 1e-5,
            epochs: 20,
            seed: 0x9E3779B97F4A7C15,
        }
    }
}

impl Model {
    /// パターン定義から、全重みを0初期化したモデルを作る。
    pub fn new(patterns: Vec<PatternCells>) -> Self {
        let weights = patterns
            .iter()
            .map(|cells| {
                let num_states = patterns::num_states(cells.len());
                PatternWeights {
                    num_states,
                    stage_tables: vec![vec![0f32; num_states as usize]; NUM_STAGES],
                }
            })
            .collect();
        Model { patterns, weights }
    }

    /// 局面(`board`・`mover`)の予測値(mover視点の最終石差の予測)を返す。
    pub fn predict(&self, board: &Board, mover: engine::bitboard::Side) -> f32 {
        let stage = stage_for_empty_count(board.empty_count());
        let mut sum = 0f32;
        for (pattern_id, cells) in self.patterns.iter().enumerate() {
            let state = patterns::pattern_state_index(cells, board, mover);
            sum += self.weights[pattern_id].stage_tables[stage][state as usize];
        }
        sum
    }

    /// 1サンプルについてSGD1ステップの更新を行う。
    fn sgd_step(&mut self, sample: &Sample, cfg: &TrainConfig) {
        let stage = stage_for_empty_count(sample.board.empty_count());

        let states: Vec<u32> = self
            .patterns
            .iter()
            .map(|cells| patterns::pattern_state_index(cells, &sample.board, sample.mover))
            .collect();
        let prediction: f32 = states
            .iter()
            .enumerate()
            .map(|(pattern_id, &state)| self.weights[pattern_id].stage_tables[stage][state as usize])
            .sum();

        let error = prediction - sample.outcome as f32;
        for (pattern_id, &state) in states.iter().enumerate() {
            let w = &mut self.weights[pattern_id].stage_tables[stage][state as usize];
            let grad = error + cfg.l2 * *w;
            *w -= cfg.learning_rate * grad;
        }
    }

    /// 与えられたサンプル集合で`cfg.epochs`エポック分SGD学習を行う。
    /// エポックごとに(再現可能な)シャッフル順序でサンプルを1回ずつ処理する。
    pub fn train(&mut self, samples: &[Sample], cfg: &TrainConfig) {
        if samples.is_empty() {
            return;
        }
        for epoch in 0..cfg.epochs {
            let order = shuffle_indices(samples.len(), cfg.seed ^ (epoch as u64));
            for &i in &order {
                self.sgd_step(&samples[i], cfg);
            }
        }
    }

    /// サンプル集合に対する平均二乗誤差(MSE)を返す。
    pub fn mean_squared_error(&self, samples: &[Sample]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples
            .iter()
            .map(|s| {
                let pred = self.predict(&s.board, s.mover) as f64;
                let err = pred - s.outcome as f64;
                err * err
            })
            .sum();
        sum / samples.len() as f64
    }

    /// サンプル集合に対する平均絶対誤差(MAE)を返す。
    pub fn mean_absolute_error(&self, samples: &[Sample]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples
            .iter()
            .map(|s| {
                let pred = self.predict(&s.board, s.mover) as f64;
                (pred - s.outcome as f64).abs()
            })
            .sum();
        sum / samples.len() as f64
    }

    /// 重みファイルのバイナリ形式にシリアライズする。
    ///
    /// フォーマット(すべてリトルエンディアン、詳細は`train/weights/README.md`参照):
    /// - magic: 4バイト `b"PWV1"`
    /// - version: u32 (=1)
    /// - num_patterns: u32
    /// - num_stages: u32
    /// - パターンごと(`patterns`生成順): cell_count: u32, 続けて
    ///   `num_stages * 3^cell_count`個のf32(ステージ0の状態0..N, ステージ1の状態0..N, ...)
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"PWV1");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&(self.patterns.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(NUM_STAGES as u32).to_le_bytes());

        for (pattern_id, cells) in self.patterns.iter().enumerate() {
            buf.extend_from_slice(&(cells.len() as u32).to_le_bytes());
            let pw = &self.weights[pattern_id];
            for stage_table in &pw.stage_tables {
                for &w in stage_table {
                    buf.extend_from_slice(&w.to_le_bytes());
                }
            }
        }

        buf
    }

    /// [`to_bytes`]の逆変換。パターン形状定義は保存せず、読み込み時に
    /// [`patterns::generate_patterns`]を再生成して突き合わせる(セル数の一致を検証する)。
    pub fn from_bytes(bytes: &[u8]) -> Result<Model, String> {
        let mut pos = 0usize;
        let read_bytes = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
            if *pos + n > bytes.len() {
                return Err("重みファイルが途中で終わっています".to_string());
            }
            let slice = &bytes[*pos..*pos + n];
            *pos += n;
            Ok(slice)
        };

        let magic = read_bytes(&mut pos, 4)?;
        if magic != b"PWV1" {
            return Err(format!("不正なマジックバイト: {magic:?}"));
        }
        let version = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        if version != 1 {
            return Err(format!("未対応のバージョン: {version}"));
        }
        let num_patterns = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        let num_stages = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        if num_stages as usize != NUM_STAGES {
            return Err(format!(
                "ステージ数が一致しません(ファイル={num_stages}, 期待={NUM_STAGES})"
            ));
        }

        let pattern_defs = patterns::generate_patterns();
        if pattern_defs.len() != num_patterns as usize {
            return Err(format!(
                "パターン数が一致しません(ファイル={num_patterns}, 現在の定義={})",
                pattern_defs.len()
            ));
        }

        let mut weights = Vec::with_capacity(pattern_defs.len());
        for cells in &pattern_defs {
            let cell_count = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
            if cell_count as usize != cells.len() {
                return Err(format!(
                    "パターンのセル数が一致しません(ファイル={cell_count}, 現在の定義={})",
                    cells.len()
                ));
            }
            let num_states = patterns::num_states(cell_count as usize);
            let mut stage_tables = Vec::with_capacity(NUM_STAGES);
            for _ in 0..NUM_STAGES {
                let mut table = Vec::with_capacity(num_states as usize);
                for _ in 0..num_states {
                    let w = f32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
                    table.push(w);
                }
                stage_tables.push(table);
            }
            weights.push(PatternWeights {
                num_states,
                stage_tables,
            });
        }

        Ok(Model {
            patterns: pattern_defs,
            weights,
        })
    }
}

/// 外部crateなしの決定的な疑似乱数生成器(xorshift64)。学習データのエポックごとの
/// シャッフル順序を再現可能にするために使う(乱数の質より再現性を優先する)。
struct Xorshift64 {
    state: u64,
}

impl Xorshift64 {
    fn new(seed: u64) -> Self {
        Xorshift64 {
            state: seed.max(1),
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    fn next_usize(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}

/// Fisher-Yatesシャッフルで`0..n`の並び替え順序を決定的に生成する。
fn shuffle_indices(n: usize, seed: u64) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..n).collect();
    if n < 2 {
        return idx;
    }
    let mut rng = Xorshift64::new(seed);
    for i in (1..n).rev() {
        let j = rng.next_usize(i + 1);
        idx.swap(i, j);
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::bitboard::Side;

    #[test]
    fn stage_for_empty_count_buckets_correctly() {
        assert_eq!(stage_for_empty_count(0), 0);
        assert_eq!(stage_for_empty_count(4), 0);
        assert_eq!(stage_for_empty_count(5), 1);
        assert_eq!(stage_for_empty_count(60), 12);
    }

    #[test]
    fn new_model_predicts_zero_everywhere() {
        let patterns = patterns::generate_patterns();
        let model = Model::new(patterns);
        let board = Board::initial();
        assert_eq!(model.predict(&board, Side::Black), 0.0);
    }

    #[test]
    fn sgd_step_reduces_error_on_repeated_single_sample() {
        let patterns = patterns::generate_patterns();
        let mut model = Model::new(patterns);
        let sample = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 10,
        };
        // 学習率は「1サンプルあたりのアクティブ特徴数(22パターン)」との積が
        // 安定領域(おおむね2未満)に収まる値にする(22 * 0.03 = 0.66)。
        // 大きすぎる学習率は単一サンプルの1ステップ更新で誤差を発散させてしまう
        // (22個の重みが同じ勾配符号で同時に動くため)。
        let cfg = TrainConfig {
            learning_rate: 0.03,
            l2: 0.0,
            epochs: 1,
            seed: 1,
        };

        let error_before = (model.predict(&sample.board, sample.mover) - sample.outcome as f32)
            .abs();
        model.train(&[sample], &cfg);
        let error_after = (model.predict(&sample.board, sample.mover) - sample.outcome as f32)
            .abs();
        assert!(
            error_after < error_before,
            "error should shrink after training on a single sample: before={error_before}, after={error_after}"
        );
    }

    #[test]
    fn training_converges_close_to_target_on_single_repeated_sample() {
        let patterns = patterns::generate_patterns();
        let mut model = Model::new(patterns);
        let sample = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 8,
        };
        let cfg = TrainConfig {
            learning_rate: 0.05,
            l2: 0.0,
            epochs: 200,
            seed: 42,
        };
        model.train(&[sample], &cfg);
        let pred = model.predict(&sample.board, sample.mover);
        assert!(
            (pred - 8.0).abs() < 0.5,
            "expected prediction close to 8.0, got {pred}"
        );
    }

    #[test]
    fn to_bytes_and_from_bytes_roundtrip_preserves_weights() {
        let patterns = patterns::generate_patterns();
        let mut model = Model::new(patterns);
        let sample = Sample {
            board: Board::initial(),
            mover: Side::Black,
            outcome: 4,
        };
        let cfg = TrainConfig {
            learning_rate: 0.05,
            l2: 1e-4,
            epochs: 5,
            seed: 7,
        };
        model.train(&[sample], &cfg);

        let bytes = model.to_bytes();
        let restored = Model::from_bytes(&bytes).expect("should parse");

        let pred_original = model.predict(&sample.board, sample.mover);
        let pred_restored = restored.predict(&sample.board, sample.mover);
        assert!((pred_original - pred_restored).abs() < 1e-6);
    }

    #[test]
    fn from_bytes_rejects_bad_magic() {
        let bytes = vec![0u8; 20];
        assert!(Model::from_bytes(&bytes).is_err());
    }

    #[test]
    fn shuffle_indices_is_a_permutation() {
        let order = shuffle_indices(100, 123);
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..100).collect::<Vec<_>>());
    }

    #[test]
    fn shuffle_indices_is_deterministic_for_same_seed() {
        let a = shuffle_indices(50, 999);
        let b = shuffle_indices(50, 999);
        assert_eq!(a, b);
    }
}

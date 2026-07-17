//! パターン特徴量に対するオンライン確率的勾配降下法(SGD)による線形回帰学習。
//!
//! 特徴は「アクティブな(パターンID, ステージ, 状態インデックス)の組」の集合
//! (1局面につき[`engine::patterns::generate_patterns`]の要素数=22個)。予測値は
//! アクティブな重みの単純合計。目的関数は (予測値 − 実際の最終石差)^2 + L2正則化。
//!
//! # T043: `engine::pattern_eval::PatternWeights`への委譲
//!
//! パターン形状の定義・重みのバイナリフォーマット入出力・スコアリング
//! (`predict`相当)は、T043で`engine::pattern_eval::PatternWeights`に一本化した
//! ([`Model`]はこれをラップし、学習専用ロジック(SGD勾配更新)だけをここに持つ)。
//! バイナリフォーマットの読み書きロジックを2箇所に複製しないため、
//! [`Model::to_bytes`]/[`Model::from_bytes`]は`PatternWeights`へそのまま委譲する。
//!
//! # T044: 対称重み共有(v2)に合わせたSGD更新
//!
//! T044で`PatternWeights`の重みテーブルが「インスタンスごと」(22テーブル)から
//! 「クラスごと」(6テーブル、対称オービットで共有)に変更された。1局面には
//! 依然として22個のアクティブな特徴(各パターンインスタンス)があるが、
//! 複数のインスタンスが同じクラスの同じ重みセルを参照しうる(例えば
//! 局面がたまたま対称な場合)。`sgd_step`はこれを特別扱いせず、22個の
//! (クラスID, 状態インデックス)を単純に順番に処理する(同じセルが複数回
//! 現れれば、その回数分だけ逐次的に勾配更新が適用される。これは重み共有の
//! 自然な帰結であり、既存の学習ループ構造は変えていない)。
//!
//! # ステージ分割
//!
//! 石差の意味合いは序盤・終盤で大きく異なるため、空きマス数によって
//! ステージに分割し、ステージごとに独立した重みテーブルを持つ
//! (`engine::pattern_eval::stage_for_empty_count`)。

use engine::bitboard::Board;
use engine::pattern_eval::PatternWeights;
use engine::patterns::{pattern_state_index, PatternCells};

use crate::train_data::Sample;

/// 学習対象のパターン評価モデル。パターン形状の定義・重みは
/// [`engine::pattern_eval::PatternWeights`]が持ち、本構造体は学習専用の
/// ロジック(SGD勾配更新)だけを追加する薄いラッパー。
#[derive(Debug, Clone)]
pub struct Model {
    pub weights: PatternWeights,
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
    /// MSEまたはHuberの勾配。
    pub loss: Loss,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Loss {
    Mse,
    Huber { delta: f32 },
}

impl Default for TrainConfig {
    fn default() -> Self {
        TrainConfig {
            learning_rate: 0.005,
            l2: 1e-5,
            epochs: 20,
            seed: 0x9E3779B97F4A7C15,
            loss: Loss::Mse,
        }
    }
}

impl Model {
    /// パターン定義から、全重みを0初期化したモデルを作る。
    pub fn new(patterns: Vec<PatternCells>) -> Self {
        Model {
            weights: PatternWeights::zeroed(patterns),
        }
    }

    /// ステージ定義を明示して、全重みを0初期化したモデルを作る。
    pub fn new_with_stage_definition(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
    ) -> Self {
        Model {
            weights: PatternWeights::zeroed_with_stage_definition(
                patterns,
                num_stages,
                stage_empty_divisor,
            ),
        }
    }

    /// 局面(`board`・`mover`)の予測値(mover視点の最終石差の予測)を返す。
    pub fn predict(&self, board: &Board, mover: engine::bitboard::Side) -> f32 {
        self.weights.score(board, mover)
    }

    /// 1サンプルについてSGD1ステップの更新を行う。
    ///
    /// T044: 22パターンインスタンスそれぞれについて、(そのインスタンスが
    /// 属するクラスID, 代表インスタンスのセル順序に揃えたセル列で計算した
    /// 状態インデックス)の組を求め、対応するクラスの重みテーブルを
    /// 読み書きする(`PatternWeights::score`と同じ`aligned_cells`を使う)。
    fn sgd_step(&mut self, sample: &Sample, cfg: &TrainConfig) {
        let stage = self
            .weights
            .stage_for_empty_count(sample.board.empty_count());

        let class_of = &self.weights.class_info.class_of;
        let aligned_cells = &self.weights.class_info.aligned_cells;
        let mut prediction = 0.0;
        for i in 0..self.weights.patterns.len() {
            let state = pattern_state_index(&aligned_cells[i], &sample.board, sample.mover);
            prediction +=
                self.weights.class_tables[class_of[i]].stage_tables[stage][state as usize];
        }

        let error = prediction - sample.outcome;
        let loss_gradient = match cfg.loss {
            Loss::Mse => error,
            Loss::Huber { delta } => error.clamp(-delta, delta),
        };
        for i in 0..self.weights.patterns.len() {
            let class_id = class_of[i];
            let state = pattern_state_index(&aligned_cells[i], &sample.board, sample.mover);
            let w = &mut self.weights.class_tables[class_id].stage_tables[stage][state as usize];
            let grad = loss_gradient + cfg.l2 * *w;
            *w -= cfg.learning_rate * grad;
        }
    }

    /// 与えられたサンプル集合で`cfg.epochs`エポック分SGD学習を行う。
    /// エポックごとに(再現可能な)シャッフル順序でサンプルを1回ずつ処理する。
    pub fn train(&mut self, samples: &[Sample], cfg: &TrainConfig) {
        self.train_epochs(samples, cfg, 0, cfg.epochs);
    }

    /// resume時にも同じシャッフル列を再現できるよう、開始epochを明示して学習する。
    pub fn train_epochs(
        &mut self,
        samples: &[Sample],
        cfg: &TrainConfig,
        start_epoch: u32,
        epochs: u32,
    ) {
        if samples.is_empty() {
            return;
        }
        for epoch in start_epoch..start_epoch + epochs {
            let order = shuffle_indices(samples.len(), cfg.seed ^ (epoch as u64));
            for &i in &order {
                self.sgd_step(&samples[i], cfg);
            }
        }
    }

    /// 呼び出し側で生成したsampling順を1 epochだけ学習する。
    pub fn train_order(&mut self, samples: &[Sample], cfg: &TrainConfig, order: &[usize]) {
        for &i in order {
            self.sgd_step(&samples[i], cfg);
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

    /// 重みファイルのバイナリ形式にシリアライズする(`PatternWeights::to_bytes`
    /// への委譲、詳細は`train/weights/README.md`参照)。
    pub fn to_bytes(&self) -> Vec<u8> {
        self.weights.to_bytes()
    }

    pub fn to_bytes_v3(&self) -> Vec<u8> {
        self.weights.to_bytes_v3()
    }

    /// [`to_bytes`](Self::to_bytes)の逆変換(`PatternWeights::from_bytes`への委譲)。
    pub fn from_bytes(bytes: &[u8]) -> Result<Model, String> {
        Ok(Model {
            weights: PatternWeights::from_bytes(bytes)?,
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
        Xorshift64 { state: seed.max(1) }
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
    use engine::patterns;

    /// T044: `Board::initial()`は8対称変換すべてに関して(トリット単位でも)
    /// ほぼ対称な局面であり、対称オービットで重みを共有するv2では、同じクラスの
    /// 複数インスタンスが偶然「全く同じ状態」に揃ってしまう(1サンプル内で
    /// 同一の重みセルが複数回アクティブになる)。これ自体は重み共有の正しい
    /// 帰結だが、下記の単発SGDテストが想定する「1サンプルあたり22個の
    /// 独立した重みが1回ずつ動く」という前提を崩し、学習率の安定域の見積もりが
    /// 変わってしまう。テストの意図(SGDが誤差を減らす/収束する)を保ったまま
    /// この偶然の衝突を避けるため、ランダムだが非対称な局面を使う。
    fn asymmetric_test_board() -> Board {
        let mut rng = Xorshift64::new(0xABCDEF12345);
        let mut black = 0u64;
        let mut white = 0u64;
        for c in 0u8..64 {
            match rng.next_u64() % 3 {
                0 => {}
                1 => black |= 1u64 << c,
                _ => white |= 1u64 << c,
            }
        }
        Board { black, white }
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
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 10.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
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
            loss: Loss::Mse,
        };

        let error_before =
            (model.predict(&sample.board, sample.mover) - sample.outcome as f32).abs();
        model.train(&[sample], &cfg);
        let error_after =
            (model.predict(&sample.board, sample.mover) - sample.outcome as f32).abs();
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
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 8.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let cfg = TrainConfig {
            learning_rate: 0.05,
            l2: 0.0,
            epochs: 200,
            seed: 42,
            loss: Loss::Mse,
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
            outcome: 4.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let cfg = TrainConfig {
            learning_rate: 0.05,
            l2: 1e-4,
            epochs: 5,
            seed: 7,
            loss: Loss::Mse,
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

    #[test]
    fn huber_clamps_outlier_gradient() {
        let sample = Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 40.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let mut mse = Model::new(patterns::generate_patterns());
        let mut huber = mse.clone();
        let base = TrainConfig {
            learning_rate: 0.001,
            l2: 0.0,
            epochs: 1,
            seed: 1,
            loss: Loss::Mse,
        };
        mse.train(&[sample], &base);
        huber.train(
            &[sample],
            &TrainConfig {
                loss: Loss::Huber { delta: 8.0 },
                ..base
            },
        );
        assert!(
            mse.predict(&sample.board, sample.mover)
                > huber.predict(&sample.board, sample.mover) * 4.9
        );
    }
}

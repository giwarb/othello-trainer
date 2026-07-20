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
use engine::pattern_eval::{scalar_features, PatternWeights, ScalarFeatureKind};
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

    /// T163: D4 canonical化スキームを有効にした状態で、全重みを0初期化した
    /// モデルを作る。`sgd_step`は`weights.table_index`を介して勾配更新を
    /// canonicalエントリに集約するため、通常の[`Model::train`]/[`Model::train_epochs`]
    /// をそのまま使って学習してよい(SGD側の特別扱いは不要)。
    pub fn new_canonical(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
    ) -> Self {
        Model {
            weights: PatternWeights::zeroed_canonical(patterns, num_stages, stage_empty_divisor),
        }
    }

    /// ステージ定義と学習対象のscalar特徴を明示して、全重みを0初期化する。
    /// 空sliceは従来の特徴なしモデルと同じPWV3モデルになる。
    pub fn new_with_scalar_features(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
        features: &[ScalarFeatureKind],
    ) -> Self {
        let mut weights =
            PatternWeights::zeroed_with_stage_definition(patterns, num_stages, stage_empty_divisor);
        if !features.is_empty() {
            weights = weights.with_zeroed_scalar_features();
            weights
                .scalar_feature_weights
                .retain(|feature| features.contains(&feature.kind));
        }
        Model { weights }
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

        // 推論式はengine側へ一本化する。scalar特徴の抽出・scale・加算順を
        // trainer側で複製しないことで、学習時予測と実運用時予測を一致させる。
        let prediction = self.predict(&sample.board, sample.mover);

        let class_of = &self.weights.class_info.class_of;
        let aligned_cells = &self.weights.class_info.aligned_cells;

        let error = prediction - sample.outcome;
        let loss_gradient = match cfg.loss {
            Loss::Mse => error,
            Loss::Huber { delta } => error.clamp(-delta, delta),
        };
        for i in 0..self.weights.patterns.len() {
            let class_id = class_of[i];
            let state = pattern_state_index(&aligned_cells[i], &sample.board, sample.mover);
            // T163: D4 canonical化スキーム(`weights.is_canonical()`)では、
            // `state`をそのままテーブル添字にせず`table_index`でcanonical index
            // へ変換してから読み書きする(`PatternWeights::score`と同じ変換を
            // 通すことで、勾配がcanonicalエントリに集約され、学習後の重みが
            // D4対称のどのインスタンスからも同じ値を返すようになる)。
            // レガシースキームでは`table_index`は`state`をそのまま返すため、
            // 挙動は変わらない。
            let index = self.weights.table_index(class_id, state);
            let w = &mut self.weights.class_tables[class_id].stage_tables[stage][index];
            let grad = loss_gradient + cfg.l2 * *w;
            *w -= cfg.learning_rate * grad;
        }
        if !self.weights.scalar_feature_weights.is_empty() {
            let values = scalar_features(&sample.board, sample.mover);
            for feature in &mut self.weights.scalar_feature_weights {
                let raw = match feature.kind {
                    ScalarFeatureKind::ExactMobilityAdvantage => values.exact_mobility_advantage,
                    ScalarFeatureKind::EmptyAdjacencyExposureAdvantage => {
                        values.empty_adjacency_exposure_advantage
                    }
                };
                let value = raw as f32 / (1u32 << feature.scale_shift) as f32;
                let w = &mut feature.weights[stage];
                // 線形項の勾配。loss_gradientだけではなく特徴値を必ず掛ける。
                let grad = loss_gradient * value + cfg.l2 * *w;
                *w -= cfg.learning_rate * grad;
            }
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

    /// T159b: `train_epochs`と全く同じシャッフル順序・更新ロジックで1エポック分
    /// SGD学習を行い、追加で(平均二乗誤差, 平均絶対誤差)を返す。既存の
    /// `train`/`train_epochs`/`sgd_step`の挙動・シグネチャは一切変更していない
    /// (このメソッドは追加のみで、既存呼び出し元の出力に影響しない)。
    ///
    /// 返す誤差は「そのサンプルを処理する直前(=このエポック内でそれまでに
    /// 処理済みのサンプルによる更新は反映済み、未処理サンプルによる更新は
    /// 未反映)の予測」に基づく集計であり、エポック完了後に全サンプルを
    /// 再評価する`mean_squared_error`/`mean_absolute_error`とは厳密には異なる
    /// (オンラインSGDの一般的な「学習中損失」の定義)。25.5M件規模のデータで
    /// 「学習後に別途もう一度全量を評価し直す」という追加フルパスを避けるために
    /// 使う(T159bレビュー中2指摘への対処)。
    pub fn train_epoch_with_running_loss(
        &mut self,
        samples: &[Sample],
        cfg: &TrainConfig,
        epoch: u32,
    ) -> (f64, f64) {
        if samples.is_empty() {
            return (0.0, 0.0);
        }
        let order = shuffle_indices(samples.len(), cfg.seed ^ (epoch as u64));
        let mut sum_squared = 0.0f64;
        let mut sum_absolute = 0.0f64;
        for &i in &order {
            let sample = &samples[i];
            let prediction = self.predict(&sample.board, sample.mover) as f64;
            let error = prediction - sample.outcome as f64;
            sum_squared += error * error;
            sum_absolute += error.abs();
            self.sgd_step(sample, cfg);
        }
        let count = samples.len() as f64;
        (sum_squared / count, sum_absolute / count)
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

    pub fn to_bytes_v4(&self) -> Vec<u8> {
        self.weights.to_bytes_v4()
    }

    /// T163: D4 canonical化スキーム版の自己記述形式(PWV5)にシリアライズする
    /// (`weights.to_bytes_v5`への委譲。`new_canonical`由来のモデルでのみ使える)。
    pub fn to_bytes_v5(&self) -> Vec<u8> {
        self.weights.to_bytes_v5()
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

    #[test]
    fn train_epoch_with_running_loss_updates_weights_identically_to_train_epochs() {
        // T159b: `train_epoch_with_running_loss`の重み更新は`train_epochs`と
        // ビット同一でなければならない(追加するのは誤差集計だけで、更新ロジックは
        // 一切変えていないため)。
        let samples = [
            Sample {
                board: asymmetric_test_board(),
                mover: Side::Black,
                outcome: 10.0,
                last_move_kind: crate::train_data::LastMoveKind::Other,
                vulnerable_xc: false,
            },
            Sample {
                board: Board::initial(),
                mover: Side::White,
                outcome: -3.0,
                last_move_kind: crate::train_data::LastMoveKind::Other,
                vulnerable_xc: false,
            },
        ];
        let cfg = TrainConfig {
            learning_rate: 0.01,
            l2: 1e-5,
            epochs: 3,
            seed: 11,
            loss: Loss::Mse,
        };
        let patterns = patterns::generate_patterns();
        let mut via_train_epochs = Model::new(patterns.clone());
        via_train_epochs.train_epochs(&samples, &cfg, 0, 3);

        let mut via_running_loss = Model::new(patterns);
        for epoch in 0..3 {
            via_running_loss.train_epoch_with_running_loss(&samples, &cfg, epoch);
        }
        assert_eq!(via_train_epochs.to_bytes(), via_running_loss.to_bytes());
    }

    #[test]
    fn train_epoch_with_running_loss_reports_decreasing_error_as_training_progresses() {
        // 集計する誤差は「更新前」の予測に基づくオンライン損失なので、
        // 学習が進むにつれてエポックごとの集計誤差もおおむね縮小していくはず
        // (収束が確認されている既存の`training_converges_close_to_target_...`と
        // 同じ設定を使う)。
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
            epochs: 1,
            seed: 42,
            loss: Loss::Mse,
        };
        let (_, first_mae) = model.train_epoch_with_running_loss(&[sample], &cfg, 0);
        let (_, last_mae) = model.train_epoch_with_running_loss(&[sample], &cfg, 30);
        assert!(
            last_mae < first_mae,
            "expected running-loss MAE to shrink as training progresses: first={first_mae} last={last_mae}"
        );
    }

    fn scalar_test_model(features: &[ScalarFeatureKind]) -> Model {
        Model::new_with_scalar_features(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            engine::pattern_eval::V4_NUM_STAGES,
            engine::pattern_eval::V4_STAGE_EMPTY_DIVISOR,
            features,
        )
    }

    #[test]
    fn scalar_gradient_multiplies_loss_gradient_by_feature_value() {
        let sample = Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 10.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let features = scalar_features(&sample.board, sample.mover);
        assert_ne!(features.exact_mobility_advantage, 0);
        let normalized = features.exact_mobility_advantage as f32 / 8.0;
        let mut model = scalar_test_model(&[ScalarFeatureKind::ExactMobilityAdvantage]);
        let cfg = TrainConfig {
            learning_rate: 0.001,
            l2: 0.0,
            epochs: 1,
            seed: 1,
            loss: Loss::Mse,
        };
        let stage = model
            .weights
            .stage_for_empty_count(sample.board.empty_count());
        model.train(&[sample], &cfg);
        let actual = model.weights.scalar_feature_weights[0].weights[stage];
        let expected = cfg.learning_rate * sample.outcome * normalized;
        assert!(
            (actual - expected).abs() < 1e-7,
            "actual={actual} expected={expected}"
        );
    }

    #[test]
    fn scalar_single_sample_converges_and_pwv4_roundtrips() {
        let sample = Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 8.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let mut model = scalar_test_model(&[
            ScalarFeatureKind::ExactMobilityAdvantage,
            ScalarFeatureKind::EmptyAdjacencyExposureAdvantage,
        ]);
        let cfg = TrainConfig {
            learning_rate: 0.02,
            l2: 0.0,
            epochs: 200,
            seed: 42,
            loss: Loss::Mse,
        };
        model.train(&[sample], &cfg);
        assert!((model.predict(&sample.board, sample.mover) - sample.outcome).abs() < 0.5);
        let bytes = model.to_bytes_v4();
        assert_eq!(&bytes[..4], b"PWV4");
        let restored = Model::from_bytes(&bytes).expect("PWV4 should parse");
        assert_eq!(restored.to_bytes_v4(), bytes);
    }

    #[test]
    fn scalar_resume_matches_uninterrupted_training() {
        let samples = [Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 6.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let cfg = TrainConfig {
            learning_rate: 0.01,
            l2: 1e-5,
            epochs: 2,
            seed: 7,
            loss: Loss::Mse,
        };
        let mut uninterrupted = scalar_test_model(&[ScalarFeatureKind::ExactMobilityAdvantage]);
        uninterrupted.train_epochs(&samples, &cfg, 0, 2);

        let mut first_epoch = scalar_test_model(&[ScalarFeatureKind::ExactMobilityAdvantage]);
        first_epoch.train_epochs(&samples, &cfg, 0, 1);
        let mut resumed = Model::from_bytes(&first_epoch.to_bytes_v4()).unwrap();
        resumed.train_epochs(&samples, &cfg, 1, 1);
        assert_eq!(resumed.to_bytes_v4(), uninterrupted.to_bytes_v4());
    }

    #[test]
    fn featureless_constructor_and_training_are_pwv3_identical() {
        let patterns = patterns::generate_patterns_for(patterns::PatternConfig::V3);
        let mut legacy = Model::new_with_stage_definition(
            patterns.clone(),
            engine::pattern_eval::V4_NUM_STAGES,
            engine::pattern_eval::V4_STAGE_EMPTY_DIVISOR,
        );
        let mut featureless = Model::new_with_scalar_features(
            patterns,
            engine::pattern_eval::V4_NUM_STAGES,
            engine::pattern_eval::V4_STAGE_EMPTY_DIVISOR,
            &[],
        );
        let samples = [Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 3.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        }];
        let cfg = TrainConfig {
            epochs: 3,
            seed: 99,
            ..TrainConfig::default()
        };
        legacy.train(&samples, &cfg);
        featureless.train(&samples, &cfg);
        assert_eq!(legacy.to_bytes_v3(), featureless.to_bytes_v3());
    }

    // -----------------------------------------------------------------
    // T163: D4 canonical化スキーム(PWV5)のSGD学習への追従
    // -----------------------------------------------------------------

    #[test]
    fn canonical_sgd_step_reduces_error_on_repeated_single_sample() {
        // T163要件4: SGDが新スキーム(`Model::new_canonical`)でも正しく動くこと
        // (`sgd_step`が`table_index`経由でcanonicalエントリを読み書きしても、
        // 通常のSGDと同じく誤差が縮小していく)。既存の
        // `sgd_step_reduces_error_on_repeated_single_sample`のcanonical版。
        let patterns = patterns::generate_patterns();
        let mut model = Model::new_canonical(
            patterns,
            engine::pattern_eval::NUM_STAGES,
            engine::pattern_eval::STAGE_EMPTY_DIVISOR,
        );
        let sample = Sample {
            board: asymmetric_test_board(),
            mover: Side::Black,
            outcome: 10.0,
            last_move_kind: crate::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
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
            "error should shrink after training on a single sample (canonical): before={error_before}, after={error_after}"
        );
    }

    #[test]
    fn canonical_training_converges_close_to_target_on_single_repeated_sample() {
        let patterns = patterns::generate_patterns();
        let mut model = Model::new_canonical(
            patterns,
            engine::pattern_eval::NUM_STAGES,
            engine::pattern_eval::STAGE_EMPTY_DIVISOR,
        );
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
            "expected prediction close to 8.0 (canonical), got {pred}"
        );
    }

    #[test]
    fn canonical_model_predictions_stay_d4_invariant_after_training_on_asymmetric_samples() {
        // T163要件4の核心: SGDで訓練した後の重みも(訓練前のゼロ重みだけでなく)
        // D4不変性を保つこと。複数の非対称局面で数エポック学習した後、
        // 各局面の8対称変換すべてで予測値が一致することを確認する。
        let patterns = patterns::generate_patterns();
        let mut model = Model::new_canonical(
            patterns,
            engine::pattern_eval::NUM_STAGES,
            engine::pattern_eval::STAGE_EMPTY_DIVISOR,
        );
        let mut rng = Xorshift64::new(0xC0DE_1234_5678_9ABC);
        let mut samples = Vec::new();
        for i in 0..30 {
            let mut black = 0u64;
            let mut white = 0u64;
            for c in 0u8..64 {
                match rng.next_u64() % 3 {
                    0 => {}
                    1 => black |= 1u64 << c,
                    _ => white |= 1u64 << c,
                }
            }
            samples.push(Sample {
                board: Board { black, white },
                mover: if i % 2 == 0 { Side::Black } else { Side::White },
                outcome: ((rng.next_u64() % 41) as f32) - 20.0,
                last_move_kind: crate::train_data::LastMoveKind::Other,
                vulnerable_xc: false,
            });
        }
        let cfg = TrainConfig {
            learning_rate: 0.01,
            l2: 1e-5,
            epochs: 20,
            seed: 7,
            loss: Loss::Mse,
        };
        model.train(&samples, &cfg);

        fn transform_board(board: &Board, sym: usize) -> Board {
            let mut black = 0u64;
            let mut white = 0u64;
            for c in 0u8..64 {
                let bit = 1u64 << c;
                let dest = patterns::apply_symmetry(sym, c);
                if board.black & bit != 0 {
                    black |= 1u64 << dest;
                }
                if board.white & bit != 0 {
                    white |= 1u64 << dest;
                }
            }
            Board { black, white }
        }

        for sample in &samples {
            let base = model.predict(&sample.board, sample.mover);
            for sym in 0..patterns::NUM_SYMMETRIES {
                let transformed = transform_board(&sample.board, sym);
                let predicted = model.predict(&transformed, sample.mover);
                assert!(
                    (predicted - base).abs() < 1e-2,
                    "sym={sym}: trained canonical model should stay D4-invariant, got {predicted} vs {base}"
                );
            }
        }
    }

    #[test]
    fn canonical_pwv5_roundtrip_preserves_weights_after_training() {
        let patterns = patterns::generate_patterns();
        let mut model = Model::new_canonical(
            patterns,
            engine::pattern_eval::NUM_STAGES,
            engine::pattern_eval::STAGE_EMPTY_DIVISOR,
        );
        let sample = Sample {
            board: asymmetric_test_board(),
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

        let bytes = model.to_bytes_v5();
        assert_eq!(&bytes[..4], b"PWV5");
        let restored = Model::from_bytes(&bytes).expect("PWV5 should parse");
        assert!(restored.weights.is_canonical());

        let pred_original = model.predict(&sample.board, sample.mover);
        let pred_restored = restored.predict(&sample.board, sample.mover);
        assert!((pred_original - pred_restored).abs() < 1e-6);
    }

    #[test]
    fn t163_canonical_score_is_invariant_over_real_wthor_positions() {
        // T163要件1(b): 実際のWTHOR公式棋譜(`train/data/WTH_2000.wtb`)から
        // 着手列を再生して得た本物の対局局面(中盤〜終盤の幅広いステージを含む)
        // で、canonical化スキームのD4不変性を検証する
        // (`engine`クレートの性質テストは合成したランダム盤面が中心だったため、
        // ここでは実データでも同じ性質が成り立つことを別途裏付ける)。
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/data/WTH_2000.wtb");
        let bytes = std::fs::read(path).expect("WTH_2000.wtb should be present in train/data");
        let file = crate::wthor::parse(&bytes).expect("WTH_2000.wtb should parse");

        let mut weights = PatternWeights::zeroed_canonical(
            patterns::generate_patterns(),
            engine::pattern_eval::NUM_STAGES,
            engine::pattern_eval::STAGE_EMPTY_DIVISOR,
        );
        for (class_id, table) in weights.class_tables.iter_mut().enumerate() {
            for (stage, stage_table) in table.stage_tables.iter_mut().enumerate() {
                for (state, w) in stage_table.iter_mut().enumerate() {
                    *w = (class_id * 100_000 + stage * 1_000 + state) as f32 * 0.0001;
                }
            }
        }

        fn transform_board(board: &Board, sym: usize) -> Board {
            let mut black = 0u64;
            let mut white = 0u64;
            for c in 0u8..64 {
                let bit = 1u64 << c;
                let dest = patterns::apply_symmetry(sym, c);
                if board.black & bit != 0 {
                    black |= 1u64 << dest;
                }
                if board.white & bit != 0 {
                    white |= 1u64 << dest;
                }
            }
            Board { black, white }
        }

        let mut checked = 0usize;
        'games: for game in file.games.iter().take(40) {
            let mut board = Board::initial();
            let mut side = Side::Black;
            for (step, &mv_index) in game.moves.iter().enumerate() {
                if !board.has_legal_move(side) {
                    side = side.opposite();
                }
                if !board.has_legal_move(side) {
                    continue 'games;
                }
                let mv_bit = 1u64 << mv_index;
                if board.legal_moves(side) & mv_bit == 0 {
                    continue 'games; // 想定外の着手(このテストの目的には無関係、スキップ)
                }
                board = board.apply_move(side, mv_bit);
                side = side.opposite();

                if step % 5 == 0 {
                    for &mover in &[Side::Black, Side::White] {
                        let base = weights.score(&board, mover);
                        for sym in 0..patterns::NUM_SYMMETRIES {
                            let transformed = transform_board(&board, sym);
                            let score = weights.score(&transformed, mover);
                            assert!(
                                (score - base).abs() < 1e-2,
                                "real WTHOR position (game moves[..{step}]) sym={sym} \
                                 mover={mover:?}: canonical score should be D4-invariant, \
                                 got {score} vs base {base}"
                            );
                        }
                    }
                    checked += 1;
                }
            }
        }
        assert!(
            checked > 100,
            "expected to check a substantial number of real WTHOR positions, got {checked}"
        );
    }
}

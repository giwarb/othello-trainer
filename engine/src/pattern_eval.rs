//! WTHOR学習済みパターン評価の重み(`train/weights/pattern_v1.bin` /
//! `train/weights/pattern_v2.bin`)を読み込み、局面をスコアリングするための
//! 読み取り専用構造体。
//!
//! # T043: 設計の経緯
//!
//! T041で`train`クレートに実装した学習パイプライン(`train::regression::Model`)は、
//! 学習(SGD勾配更新)とバイナリフォーマットの読み書きの両方を1つの構造体に
//! 持たせていた。T043で`engine`クレート側の探索(`search.rs`)からも同じ重みを
//! 読み込んでスコアリングする必要が生じたため、「学習には不要だが推論には必要な
//! ロジック(バイナリフォーマットの読み書き・スコアリング)」を本モジュールに
//! 一本化した。`train::regression::Model`は本モジュールの[`PatternWeights`]を
//! ラップし、学習専用のロジック(勾配更新)だけを追加で持つ形にリファクタリング
//! 済み(バイナリフォーマットの読み書きロジックを2箇所に複製しない)。
//!
//! パターン形状の定義(行・列・対角線・隅3x3ブロック)自体は[`crate::patterns`]
//! を参照。
//!
//! # T044: 対称重み共有(v2)とv1との互換性
//!
//! v1は22パターンインスタンスそれぞれが独立した重みテーブルを持っていたが、
//! T043の自己対戦検証で汎化性能不足(負け越し)が判明したため、T044で
//! `crate::patterns::compute_pattern_classes`による対称オービット(6クラス)
//! ごとの重み共有(v2)を導入した。内部表現は常に「クラスごとの重みテーブル」
//! ([`PatternWeights::class_tables`])で統一し、[`PatternWeights::score`]は
//! 各インスタンスについて[`patterns::PatternClassInfo::aligned_cells`]
//! (代表インスタンスのセル順序に揃えた実際のセル列)で状態インデックスを
//! 計算してから、そのインスタンスが属するクラスの重みテーブルを引く。
//!
//! `pattern_v1.bin`(22クラス=各インスタンスが単独のクラス、重み共有なし)は
//! 比較用に残しており、[`PatternWeights::from_bytes`]は旧フォーマット
//! (`"PWV1"`)・新フォーマット(`"PWV2"`)の両方を読み込める。新規に書き出す
//! ([`PatternWeights::to_bytes`])のは常に新フォーマット(v2)。
//!
//! # T163: D4 canonical化スキーム(PWV5)
//!
//! T044のクラス分類(`crate::patterns::compute_pattern_classes`)は、各インスタンスの
//! `aligned_cells`(状態計算に使うセル順序)の選択が全域のD4対称変換と一貫せず、
//! 回転・鏡映で互いに写り合う局面同士で`score`の値がズレる不具合があった
//! (詳細は`crate::patterns`モジュール冒頭のT163節、および
//! `tasks/T163-d4-canonicalization.md`参照)。本タスクでは、既存の重みファイル
//! (PWV1〜PWV4)の評価値をビット単位で不変に保ったまま、新しい重み形式
//! (マジック`"PWV5"`)を追加する。新形式では、パターン形状から構築時に一度だけ
//! 計算した「canonical indexテーブル」(`crate::patterns::build_canonical_index_table`)
//! を介して状態インデックスを正規化し([`PatternWeights::table_index`])、
//! 全8対称変換で評価値が完全一致するようにする。`canonical_tables`が`Some`か
//! `None`かで新旧スキームを切り替える([`PatternWeights::zeroed_canonical`]で
//! 新スキームを有効化、`zeroed`/`zeroed_with_stage_definition`はレガシーのまま)。
//!
//! # スケールについて
//!
//! [`PatternWeights::score`]は「mover視点の最終石差の予測値」(素の石差、
//! 1石=1単位)を返す。`engine/src/eval.rs`のcenti-disc規約(1石=100)に揃える
//! 変換は呼び出し側([`crate::search`])の責務とする(本モジュールは学習時の
//! ラベル単位である素の石差をそのまま返す方が`train`クレートとの対応が明確に
//! なるため)。

use crate::bitboard::{empty_adjacency_incidence, legal_moves_relative, Board, Side};
use crate::patterns::{self, PatternCells, PatternClassInfo};

/// ステージ数。`stage = empty_count / STAGE_EMPTY_DIVISOR`で、空きマス数0..60を
/// 0..12の13段階に分ける(60/5=12が最大インデックス)。
pub const NUM_STAGES: usize = 13;
/// ステージ分割の除数(空きマス5個ごとに1ステージ)。
pub const STAGE_EMPTY_DIVISOR: u32 = 5;

/// v4のステージ数。空きマス数0..60を1石刻みの61段階に分ける。
pub const V4_NUM_STAGES: usize = 61;
/// v4のステージ分割の除数(空きマス1個ごとに1ステージ)。
pub const V4_STAGE_EMPTY_DIVISOR: u32 = 1;

/// 空きマス数からステージ番号(`0 .. NUM_STAGES`)を求める。
pub fn stage_for_empty_count(empty_count: u32) -> usize {
    ((empty_count / STAGE_EMPTY_DIVISOR) as usize).min(NUM_STAGES - 1)
}

fn is_supported_stage_definition(num_stages: usize, stage_empty_divisor: u32) -> bool {
    (num_stages == NUM_STAGES && stage_empty_divisor == STAGE_EMPTY_DIVISOR)
        || (num_stages == V4_NUM_STAGES && stage_empty_divisor == V4_STAGE_EMPTY_DIVISOR)
}

/// 1パターン分の重みテーブル(ステージごとに状態数分のf32配列を持つ)。
#[derive(Debug, Clone)]
pub struct PatternWeightTable {
    /// このパターンの状態数(3^パターン長)。
    pub num_states: u32,
    /// `stage_tables[stage][state_index]`が重み。
    pub stage_tables: Vec<Vec<f32>>,
}

/// PWV4 scalar feature identifiers. The numeric values are part of the file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ScalarFeatureKind {
    ExactMobilityAdvantage = 1,
    EmptyAdjacencyExposureAdvantage = 2,
}

impl ScalarFeatureKind {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::ExactMobilityAdvantage),
            2 => Some(Self::EmptyAdjacencyExposureAdvantage),
            _ => None,
        }
    }

    pub fn scale_shift(self) -> u8 {
        match self {
            Self::ExactMobilityAdvantage => 3,
            Self::EmptyAdjacencyExposureAdvantage => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScalarFeatureWeights {
    pub kind: ScalarFeatureKind,
    pub scale_shift: u8,
    pub weights: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScalarFeatures {
    pub exact_mobility_advantage: i32,
    pub empty_adjacency_exposure_advantage: i32,
}

/// Compute both PWV4 scalar features using mover-relative integer bitboards.
pub fn scalar_features(board: &Board, mover: Side) -> ScalarFeatures {
    let (own, opp) = match mover {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };
    let empty = !(own | opp);
    ScalarFeatures {
        exact_mobility_advantage: legal_moves_relative(own, opp, empty).count_ones() as i32
            - legal_moves_relative(opp, own, empty).count_ones() as i32,
        empty_adjacency_exposure_advantage: empty_adjacency_incidence(opp, empty) as i32
            - empty_adjacency_incidence(own, empty) as i32,
    }
}

/// パターン形状の定義(`patterns`)・対称オービットのクラス分類(`class_info`)と、
/// それに対応する重み一式(`class_tables`、`class_tables[class_id]`が
/// そのクラスに属す全インスタンス共有の重み)を持つ、読み取り専用の
/// パターン評価モデル。学習(勾配更新)ロジックは持たない
/// (`train::regression::Model`が本構造体をラップして学習専用ロジックを追加する)。
///
/// T044で「インスタンスごと」(v1、22テーブル、重み共有なし)から
/// 「クラスごと」(v2、6テーブル、対称オービットで重み共有)に変更した。
/// v1形式の読み込み時は、各インスタンスが単独のクラスを構成する
/// (`class_info.representative_of_class.len() == patterns.len()`)ものとして
/// 扱う(重み共有なしのv1と同じ挙動になる)ため、`score`のロジックは
/// v1/v2で共通化されている。
#[derive(Debug, Clone)]
pub struct PatternWeights {
    pub patterns: Vec<PatternCells>,
    pub class_info: PatternClassInfo,
    pub class_tables: Vec<PatternWeightTable>,
    pub num_stages: usize,
    pub stage_empty_divisor: u32,
    /// Empty for PWV1-PWV3. PWV4 stores at most one entry of each known kind.
    pub scalar_feature_weights: Vec<ScalarFeatureWeights>,
    scalar_features_enabled: bool,
    /// T163: D4 canonical化スキームが有効な場合のみ`Some`。
    /// `canonical_tables[class_id][raw_state]`がそのクラスのcanonical index
    /// (`patterns::build_canonical_index_table`、構築時に一度だけ計算)。
    /// レガシースキーム(PWV1〜PWV4)は常に`None`で、[`Self::table_index`]は
    /// 状態インデックスをそのまま返す(評価値のビット不変性を保証するため)。
    canonical_tables: Option<Vec<Vec<u32>>>,
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64) * 8;
    let padded_len = (input.len() + 9 + 63) & !63;
    let mut padded = vec![0u8; padded_len];
    padded[..input.len()].copy_from_slice(input);
    padded[input.len()] = 0x80;
    padded[padded_len - 8..].copy_from_slice(&bit_len.to_be_bytes());
    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (state, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *state = state.wrapping_add(value);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn schema_hash(
    patterns: &[PatternCells],
    class_of: &[usize],
    num_stages: usize,
    stage_empty_divisor: u32,
) -> [u8; 32] {
    let mut schema = Vec::new();
    schema.extend_from_slice(&(num_stages as u32).to_le_bytes());
    schema.extend_from_slice(&stage_empty_divisor.to_le_bytes());
    for (cells, &class_id) in patterns.iter().zip(class_of) {
        schema.extend_from_slice(&(class_id as u16).to_le_bytes());
        schema.push(cells.len() as u8);
        schema.extend_from_slice(cells);
    }
    sha256(&schema)
}

fn schema_hash_v4(
    patterns: &[PatternCells],
    class_of: &[usize],
    num_stages: usize,
    stage_empty_divisor: u32,
    scalar_features: &[ScalarFeatureWeights],
) -> [u8; 32] {
    let mut schema = Vec::new();
    schema.extend_from_slice(&(num_stages as u32).to_le_bytes());
    schema.extend_from_slice(&stage_empty_divisor.to_le_bytes());
    for (cells, &class_id) in patterns.iter().zip(class_of) {
        schema.extend_from_slice(&(class_id as u16).to_le_bytes());
        schema.push(cells.len() as u8);
        schema.extend_from_slice(cells);
    }
    schema.extend_from_slice(&(scalar_features.len() as u32).to_le_bytes());
    for feature in scalar_features {
        schema.push(feature.kind as u8);
        schema.push(feature.scale_shift);
    }
    sha256(&schema)
}

impl PatternWeights {
    /// パターン定義から、対称オービットのクラス分類([`patterns::compute_pattern_classes`])
    /// を行い、全クラスの重みを0初期化したモデルを作る
    /// (`train::regression::Model::new`が学習開始時に使う)。
    pub fn zeroed(patterns: Vec<PatternCells>) -> Self {
        Self::zeroed_with_stage_definition(patterns, NUM_STAGES, STAGE_EMPTY_DIVISOR)
    }

    /// 対応するステージ定義を明示して、全重みを0初期化したモデルを作る。
    pub fn zeroed_with_stage_definition(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
    ) -> Self {
        assert!(is_supported_stage_definition(
            num_stages,
            stage_empty_divisor
        ));
        let class_info = patterns::compute_pattern_classes(&patterns);
        let class_tables = class_info
            .representative_of_class
            .iter()
            .map(|&rep_idx| {
                let num_states = patterns::num_states(patterns[rep_idx].len());
                PatternWeightTable {
                    num_states,
                    stage_tables: vec![vec![0f32; num_states as usize]; num_stages],
                }
            })
            .collect();
        PatternWeights {
            patterns,
            class_info,
            class_tables,
            num_stages,
            stage_empty_divisor,
            scalar_feature_weights: Vec::new(),
            scalar_features_enabled: true,
            canonical_tables: None,
        }
    }

    /// T163: D4 canonical化スキームを有効にした状態で、全重みを0初期化したモデルを
    /// 作る(`train::regression::Model::new_canonical`が学習開始時に使う)。
    /// レガシー([`Self::zeroed`]/[`Self::zeroed_with_stage_definition`])とは
    /// `canonical_tables`が`Some`である点だけが異なる。`score`・SGD更新
    /// (`train`クレート)は、ここで構築したcanonical indexテーブルを介して
    /// 状態インデックスを正規化するため、全8対称変換で評価値が完全一致する。
    pub fn zeroed_canonical(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
    ) -> Self {
        let mut model =
            Self::zeroed_with_stage_definition(patterns, num_stages, stage_empty_divisor);
        model.canonical_tables = Some(model.build_canonical_tables());
        model
    }

    /// 現在の`patterns`/`class_info`から、各クラスのcanonical indexテーブル
    /// (`patterns::build_canonical_index_table`)を構築する。クラスの代表
    /// インスタンスの自然順セル(`aligned_cells[rep_idx]`、恒等変換なので
    /// `patterns[rep_idx]`と同じ)のみから決まる(盤面に依存しない)。
    fn build_canonical_tables(&self) -> Vec<Vec<u32>> {
        self.class_info
            .representative_of_class
            .iter()
            .map(|&rep_idx| patterns::build_canonical_index_table(&self.patterns[rep_idx]))
            .collect()
    }

    /// この重みがD4 canonical化スキーム(PWV5)を使っているかどうか。
    pub fn is_canonical(&self) -> bool {
        self.canonical_tables.is_some()
    }

    /// `score`・SGD更新(`train::regression::Model::sgd_step`)で実際に使う
    /// テーブルインデックスを返す。新スキーム(canonical_tablesが`Some`)では
    /// `raw_state`をcanonical indexへ変換し、レガシー(`None`)では`raw_state`を
    /// そのまま返す(既存重みファイルの評価値をビット単位で変えないため)。
    pub fn table_index(&self, class_id: usize, raw_state: u32) -> usize {
        match &self.canonical_tables {
            Some(tables) => tables[class_id][raw_state as usize] as usize,
            None => raw_state as usize,
        }
    }

    /// Add the two T158 scalar features with zero coefficients.
    pub fn with_zeroed_scalar_features(mut self) -> Self {
        assert_eq!(self.num_stages, V4_NUM_STAGES);
        assert_eq!(self.stage_empty_divisor, V4_STAGE_EMPTY_DIVISOR);
        self.scalar_feature_weights = [
            ScalarFeatureKind::ExactMobilityAdvantage,
            ScalarFeatureKind::EmptyAdjacencyExposureAdvantage,
        ]
        .into_iter()
        .map(|kind| ScalarFeatureWeights {
            kind,
            scale_shift: kind.scale_shift(),
            weights: vec![0.0; self.num_stages],
        })
        .collect();
        self
    }

    pub fn has_scalar_features(&self) -> bool {
        !self.scalar_feature_weights.is_empty()
    }

    pub fn scalar_features_enabled(&self) -> bool {
        self.has_scalar_features() && self.scalar_features_enabled
    }

    pub fn set_scalar_features_enabled(&mut self, enabled: bool) {
        self.scalar_features_enabled = enabled;
    }

    /// この重みが持つステージ定義で空きマス数をステージ番号へ変換する。
    pub fn stage_for_empty_count(&self, empty_count: u32) -> usize {
        ((empty_count / self.stage_empty_divisor) as usize).min(self.num_stages - 1)
    }

    /// 局面(`board`・`mover`)の予測値(mover視点の最終石差の予測、素の石差
    /// 単位)を返す。各インスタンスについて、代表インスタンスのセル順序に
    /// 揃えた実セル列(`class_info.aligned_cells`)で状態インデックスを計算し、
    /// そのインスタンスが属するクラスの重みテーブルを引いて合計する。
    pub fn score(&self, board: &Board, mover: Side) -> f32 {
        let stage = self.stage_for_empty_count(board.empty_count());
        let mut sum = 0f32;
        for i in 0..self.patterns.len() {
            let class_id = self.class_info.class_of[i];
            let cells = &self.class_info.aligned_cells[i];
            let state = patterns::pattern_state_index(cells, board, mover);
            let index = self.table_index(class_id, state);
            sum += self.class_tables[class_id].stage_tables[stage][index];
        }
        if self.scalar_features_enabled() {
            let values = scalar_features(board, mover);
            for kind in [
                ScalarFeatureKind::ExactMobilityAdvantage,
                ScalarFeatureKind::EmptyAdjacencyExposureAdvantage,
            ] {
                if let Some(feature) = self
                    .scalar_feature_weights
                    .iter()
                    .find(|feature| feature.kind == kind)
                {
                    let raw = match kind {
                        ScalarFeatureKind::ExactMobilityAdvantage => {
                            values.exact_mobility_advantage
                        }
                        ScalarFeatureKind::EmptyAdjacencyExposureAdvantage => {
                            values.empty_adjacency_exposure_advantage
                        }
                    };
                    sum += feature.weights[stage]
                        * (raw as f32 / (1u32 << feature.scale_shift) as f32);
                }
            }
        }
        sum
    }

    /// 重みファイルのバイナリ形式(v2)にシリアライズする。
    ///
    /// フォーマット(すべてリトルエンディアン、詳細は`train/weights/README.md`参照):
    /// - magic: 4バイト `b"PWV2"`
    /// - version: u32 (=2)
    /// - num_patterns: u32(22、`patterns.len()`。読み込み時の整合性検証用)
    /// - num_classes: u32(対称オービットのクラス数、6)
    /// - num_stages: u32
    /// - クラスごと(`representative_of_class`順): cell_count: u32
    ///   (代表インスタンスのセル数)、続けて`num_stages * 3^cell_count`個の
    ///   f32(ステージ0の状態0..N, ステージ1の状態0..N, ...)
    ///
    /// (v1形式`"PWV1"`の書き出しはもう行わない。`pattern_v1.bin`は比較用に
    /// ファイルとして残っているが、以後の学習出力は常にこのv2形式。)
    pub fn to_bytes(&self) -> Vec<u8> {
        // T164前段修正(a、T163レビュー中1指摘): PWV2はスキーム識別を持たない
        // 形式なので、canonicalモデルを黙って書き出すとcanonical_tablesの
        // 情報が静かに失われ、読み直すとレガシースキームとして扱われてしまう
        // (D4不変性が壊れたことに誰も気付けない)。明示的に拒否する。
        assert!(
            self.canonical_tables.is_none(),
            "to_bytes(PWV2)はレガシー専用です。canonicalモデルはto_bytes_v5/to_bytes_v6を使ってください"
        );
        let mut buf = Vec::new();
        buf.extend_from_slice(b"PWV2");
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&(self.patterns.len() as u32).to_le_bytes());
        buf.extend_from_slice(
            &(self.class_info.representative_of_class.len() as u32).to_le_bytes(),
        );
        assert_eq!(self.num_stages, NUM_STAGES);
        assert_eq!(self.stage_empty_divisor, STAGE_EMPTY_DIVISOR);
        buf.extend_from_slice(&(self.num_stages as u32).to_le_bytes());

        for (class_id, &rep_idx) in self.class_info.representative_of_class.iter().enumerate() {
            let cell_count = self.patterns[rep_idx].len();
            buf.extend_from_slice(&(cell_count as u32).to_le_bytes());
            let table = &self.class_tables[class_id];
            for stage_table in &table.stage_tables {
                for &w in stage_table {
                    buf.extend_from_slice(&w.to_le_bytes());
                }
            }
        }

        buf
    }

    /// T087の自己記述形式(PWV3)にシリアライズする。旧trainerがPWV2を
    /// 出力し続けられるよう、既存の[`to_bytes`](Self::to_bytes)とは分離する。
    pub fn to_bytes_v3(&self) -> Vec<u8> {
        // T164前段修正(a、T163レビュー中1指摘): PWV3もPWV2と同じ理由で、
        // canonicalモデルを黙って受け付けない(canonicalモデルは
        // to_bytes_v5を使う)。
        assert!(
            self.canonical_tables.is_none(),
            "to_bytes_v3はレガシー専用です。canonicalモデルはto_bytes_v5を使ってください"
        );
        self.to_bytes_self_describing(b"PWV3", 3)
    }

    /// T163: D4 canonical化スキーム版の自己記述形式(PWV5)にシリアライズする。
    /// バイト列のレイアウトは[`to_bytes_v3`](Self::to_bytes_v3)(PWV3)と全く同じ
    /// (マジック・バージョン番号のみ異なる)。canonical indexテーブル自体は
    /// ファイルに保存せず、読み込み時にパターン形状から再計算する
    /// ([`from_bytes_v5`](Self::from_bytes)、`class_info`をファイルへ保存せず
    /// 読み込み時に再計算する既存方針と同じ)。
    pub fn to_bytes_v5(&self) -> Vec<u8> {
        assert!(
            self.canonical_tables.is_some(),
            "to_bytes_v5はD4 canonical化スキーム(zeroed_canonical由来)でのみ使えます"
        );
        self.to_bytes_self_describing(b"PWV5", 5)
    }

    /// [`to_bytes_v3`](Self::to_bytes_v3)/[`to_bytes_v5`](Self::to_bytes_v5)共通の
    /// シリアライズ本体(マジック・バージョン番号のみ引数で変える)。
    fn to_bytes_self_describing(&self, magic: &[u8; 4], version: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(magic);
        buf.extend_from_slice(&version.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&(self.num_stages as u32).to_le_bytes());
        buf.extend_from_slice(&self.stage_empty_divisor.to_le_bytes());
        buf.extend_from_slice(&(self.patterns.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.class_tables.len() as u32).to_le_bytes());
        buf.extend_from_slice(&schema_hash(
            &self.class_info.aligned_cells,
            &self.class_info.class_of,
            self.num_stages,
            self.stage_empty_divisor,
        ));

        for (i, cells) in self.class_info.aligned_cells.iter().enumerate() {
            buf.push(cells.len() as u8);
            buf.extend_from_slice(&(self.class_info.class_of[i] as u16).to_le_bytes());
            buf.extend_from_slice(cells);
        }
        for (class_id, &rep_idx) in self.class_info.representative_of_class.iter().enumerate() {
            let cells = &self.class_info.aligned_cells[rep_idx];
            let table = &self.class_tables[class_id];
            buf.push(cells.len() as u8);
            buf.extend_from_slice(&table.num_states.to_le_bytes());
            for stage_table in &table.stage_tables {
                for &weight in stage_table {
                    buf.extend_from_slice(&weight.to_le_bytes());
                }
            }
        }
        buf
    }

    /// Serialize the self-describing PWV4 format (レガシースキーム+scalar特徴)。
    pub fn to_bytes_v4(&self) -> Vec<u8> {
        // T164前段修正(a)と同じ理由に加え、T164要件2で新設したPWV6(canonical+
        // scalar)との取り違え防止: PWV4はレガシー専用。
        assert!(
            self.canonical_tables.is_none(),
            "to_bytes_v4はレガシー専用です。canonicalモデル(scalar特徴込み)はto_bytes_v6を使ってください"
        );
        self.to_bytes_scalar_extended(b"PWV4", 4)
    }

    /// T164要件2: D4 canonical化スキーム(T163)+scalar特徴(T158)を組み合わせた
    /// 自己記述形式(PWV6)にシリアライズする。PWV4がPWV3(パターンのみの
    /// 自己記述形式)にscalarブロックを追加拡張したのと同型に、PWV6はPWV5
    /// (canonical化版のパターンのみ形式)にscalarブロックを追加拡張する
    /// (バイト列レイアウトはPWV4と全く同じで、マジック・バージョンのみ異なる。
    /// 相違点はパターン部分をレガシーの`aligned_cells`のまま解釈するか
    /// 〈PWV4〉、canonical indexテーブルを介して解釈するか〈PWV6〉だけであり、
    /// それは読み込み時の後処理〈`from_bytes_v6`〉で切り替える)。
    pub fn to_bytes_v6(&self) -> Vec<u8> {
        assert!(
            self.canonical_tables.is_some(),
            "to_bytes_v6はD4 canonical化スキーム(zeroed_canonical由来)でのみ使えます"
        );
        self.to_bytes_scalar_extended(b"PWV6", 6)
    }

    /// [`to_bytes_v4`](Self::to_bytes_v4)/[`to_bytes_v6`](Self::to_bytes_v6)共通の
    /// シリアライズ本体(マジック・バージョン番号のみ引数で変える。scalar特徴
    /// ブロックの有無・レイアウトはcanonicalかどうかに依存しないため、
    /// このヘルパー自体はcanonical_tablesを一切参照しない)。
    fn to_bytes_scalar_extended(&self, magic: &[u8; 4], version: u32) -> Vec<u8> {
        assert!(!self.scalar_feature_weights.is_empty());
        assert_eq!(self.num_stages, V4_NUM_STAGES);
        assert_eq!(self.stage_empty_divisor, V4_STAGE_EMPTY_DIVISOR);
        let mut buf = Vec::new();
        buf.extend_from_slice(magic);
        buf.extend_from_slice(&version.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&(self.num_stages as u32).to_le_bytes());
        buf.extend_from_slice(&self.stage_empty_divisor.to_le_bytes());
        buf.extend_from_slice(&(self.patterns.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.class_tables.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.scalar_feature_weights.len() as u32).to_le_bytes());
        buf.extend_from_slice(&schema_hash_v4(
            &self.class_info.aligned_cells,
            &self.class_info.class_of,
            self.num_stages,
            self.stage_empty_divisor,
            &self.scalar_feature_weights,
        ));
        for (i, cells) in self.class_info.aligned_cells.iter().enumerate() {
            buf.push(cells.len() as u8);
            buf.extend_from_slice(&(self.class_info.class_of[i] as u16).to_le_bytes());
            buf.extend_from_slice(cells);
        }
        for (class_id, &rep_idx) in self.class_info.representative_of_class.iter().enumerate() {
            let cells = &self.class_info.aligned_cells[rep_idx];
            let table = &self.class_tables[class_id];
            buf.push(cells.len() as u8);
            buf.extend_from_slice(&table.num_states.to_le_bytes());
            for stage_table in &table.stage_tables {
                for &weight in stage_table {
                    buf.extend_from_slice(&weight.to_le_bytes());
                }
            }
        }
        for feature in &self.scalar_feature_weights {
            assert_eq!(feature.scale_shift, feature.kind.scale_shift());
            assert_eq!(feature.weights.len(), self.num_stages);
            buf.push(feature.kind as u8);
            buf.push(feature.scale_shift);
            buf.extend_from_slice(&0u16.to_le_bytes());
            for &weight in &feature.weights {
                buf.extend_from_slice(&weight.to_le_bytes());
            }
        }
        buf
    }

    /// [`to_bytes`](Self::to_bytes)の逆変換。マジックバイトで新旧フォーマットを
    /// 判別する:
    /// - `"PWV2"`(本タスクT044で導入): クラスごとの重みテーブルを読み込み、
    ///   [`crate::patterns::compute_pattern_classes`]で再計算したクラス分類と
    ///   突き合わせる(クラス数・各クラスの代表セル数の一致を検証する)。
    /// - `"PWV1"`(T041、比較用に`pattern_v1.bin`として残存): 22インスタンス
    ///   それぞれが単独のクラスを構成するもの(重み共有なし)として読み込む
    ///   (`score`のロジックはv1/v2で共通化されているため、そのまま利用できる)。
    ///
    /// いずれの形式でも、パターン形状定義自体は保存せず読み込み時に
    /// [`crate::patterns::generate_patterns`]を再生成して突き合わせる。
    pub fn from_bytes(bytes: &[u8]) -> Result<PatternWeights, String> {
        if bytes.len() < 4 {
            return Err("重みファイルが短すぎます".to_string());
        }
        match &bytes[0..4] {
            b"PWV6" => Self::from_bytes_v6(bytes),
            b"PWV5" => Self::from_bytes_v5(bytes),
            b"PWV4" => Self::from_bytes_v4(bytes),
            b"PWV3" => Self::from_bytes_v3(bytes),
            b"PWV2" => Self::from_bytes_v2(bytes),
            b"PWV1" => Self::from_bytes_v1(bytes),
            magic => Err(format!("不正なマジックバイト: {magic:?}")),
        }
    }

    fn from_bytes_v4(bytes: &[u8]) -> Result<PatternWeights, String> {
        Self::from_bytes_scalar_extended(bytes, 4, "PWV4", false)
    }

    /// T164要件2: PWV6(D4 canonical化+scalar特徴)を読み込む。バイト列の
    /// パース本体は[`from_bytes_v4`](Self::from_bytes_v4)と全く同じ
    /// ([`from_bytes_scalar_extended`](Self::from_bytes_scalar_extended)を共有)。
    /// パターン部分の検証・`class_info`再構築を、PWV3(レガシー)ではなく
    /// PWV5(D4 canonical)の経路に通す点だけが異なり、その結果
    /// `canonical_tables`が`Some`になったモデルにscalar特徴を追加する。
    fn from_bytes_v6(bytes: &[u8]) -> Result<PatternWeights, String> {
        Self::from_bytes_scalar_extended(bytes, 6, "PWV6", true)
    }

    /// [`from_bytes_v4`](Self::from_bytes_v4)/[`from_bytes_v6`](Self::from_bytes_v6)
    /// 共通のパース本体(期待バージョン番号・エラーメッセージの形式名・
    /// パターン部分をcanonical経由で解釈するかどうかだけを引数で変える)。
    fn from_bytes_scalar_extended(
        bytes: &[u8],
        expected_version: u32,
        format_label: &str,
        canonical: bool,
    ) -> Result<PatternWeights, String> {
        let mut pos = 0usize;
        let read_bytes = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
            let end = pos
                .checked_add(n)
                .ok_or_else(|| format!("{format_label}の長さがオーバーフローしました"))?;
            if end > bytes.len() {
                return Err(format!("{format_label}が途中で終わっています"));
            }
            let slice = &bytes[*pos..end];
            *pos = end;
            Ok(slice)
        };
        let read_u32 = |pos: &mut usize| -> Result<u32, String> {
            Ok(u32::from_le_bytes(read_bytes(pos, 4)?.try_into().unwrap()))
        };

        read_bytes(&mut pos, 4)?;
        if read_u32(&mut pos)? != expected_version {
            return Err(format!("未対応の{format_label}バージョンです"));
        }
        if read_u32(&mut pos)? != 0 {
            return Err(format!("{format_label}のflagsが不正です"));
        }
        let num_stages = read_u32(&mut pos)? as usize;
        let stage_divisor = read_u32(&mut pos)?;
        if num_stages != V4_NUM_STAGES || stage_divisor != V4_STAGE_EMPTY_DIVISOR {
            return Err(format!("{format_label}のステージ定義が一致しません"));
        }
        let num_instances = read_u32(&mut pos)? as usize;
        let num_classes = read_u32(&mut pos)? as usize;
        let num_scalar_features = read_u32(&mut pos)? as usize;
        if num_instances == 0
            || num_instances > 256
            || num_classes == 0
            || num_classes > num_instances
            || num_classes > 64
        {
            return Err(format!("{format_label}のinstance/class数が不正です"));
        }
        if !(1..=2).contains(&num_scalar_features) {
            return Err(format!("{format_label}のscalar feature数が不正です"));
        }
        let stored_hash: [u8; 32] = read_bytes(&mut pos, 32)?.try_into().unwrap();

        let mut pattern_defs = Vec::with_capacity(num_instances);
        let mut class_of = Vec::with_capacity(num_instances);
        for _ in 0..num_instances {
            let cell_count = read_bytes(&mut pos, 1)?[0] as usize;
            if cell_count == 0 || cell_count > 10 {
                return Err(format!("{format_label}のcell_countが不正です"));
            }
            let class_id =
                u16::from_le_bytes(read_bytes(&mut pos, 2)?.try_into().unwrap()) as usize;
            if class_id >= num_classes {
                return Err(format!("{format_label}のclass_idが範囲外です"));
            }
            let raw_cells = read_bytes(&mut pos, cell_count)?;
            let mut cells = PatternCells::new();
            for &cell in raw_cells {
                cells.push(cell);
            }
            pattern_defs.push(cells);
            class_of.push(class_id);
        }

        for _ in 0..num_classes {
            read_bytes(&mut pos, 1)?;
            let num_states = read_u32(&mut pos)? as usize;
            let weight_bytes = num_stages
                .checked_mul(num_states)
                .and_then(|n| n.checked_mul(4))
                .ok_or_else(|| format!("{format_label}の重み数がオーバーフローしました"))?;
            read_bytes(&mut pos, weight_bytes)?;
        }
        let scalar_start = pos;
        let mut scalar_feature_weights = Vec::with_capacity(num_scalar_features);
        let mut seen = [false; 3];
        for _ in 0..num_scalar_features {
            let kind_value = read_bytes(&mut pos, 1)?[0];
            let kind = ScalarFeatureKind::from_u8(kind_value)
                .ok_or_else(|| format!("{format_label}の未知scalar feature kind: {kind_value}"))?;
            if seen[kind_value as usize] {
                return Err(format!(
                    "{format_label}に重複scalar feature kindがあります: {kind_value}"
                ));
            }
            seen[kind_value as usize] = true;
            let scale_shift = read_bytes(&mut pos, 1)?[0];
            if scale_shift != kind.scale_shift() {
                return Err(format!(
                    "{format_label}のscale_shiftがkindと一致しません: {kind_value}"
                ));
            }
            let reserved = u16::from_le_bytes(read_bytes(&mut pos, 2)?.try_into().unwrap());
            if reserved != 0 {
                return Err(format!("{format_label}のreservedが0ではありません"));
            }
            let mut weights = Vec::with_capacity(num_stages);
            for _ in 0..num_stages {
                let weight = f32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
                if !weight.is_finite() {
                    return Err(format!("{format_label}にfiniteでないscalar重みがあります"));
                }
                weights.push(weight);
            }
            scalar_feature_weights.push(ScalarFeatureWeights {
                kind,
                scale_shift,
                weights,
            });
        }
        if pos != bytes.len() {
            return Err(format!("{format_label}に余剰bytesがあります"));
        }
        if schema_hash_v4(
            &pattern_defs,
            &class_of,
            num_stages,
            stage_divisor,
            &scalar_feature_weights,
        ) != stored_hash
        {
            return Err(format!("{format_label}のschema hashが一致しません"));
        }

        // Reuse the unchanged PWV3/PWV5 parser for the pattern portion and its D4
        // validation (`canonical`が`true`ならPWV5経由、`false`ならPWV3経由)。
        let (base_magic, base_version): (&[u8; 4], u32) = if canonical {
            (b"PWV5", 5)
        } else {
            (b"PWV3", 3)
        };
        let mut base_bytes = Vec::with_capacity(scalar_start);
        base_bytes.extend_from_slice(base_magic);
        base_bytes.extend_from_slice(&base_version.to_le_bytes());
        base_bytes.extend_from_slice(&0u32.to_le_bytes());
        base_bytes.extend_from_slice(&(num_stages as u32).to_le_bytes());
        base_bytes.extend_from_slice(&stage_divisor.to_le_bytes());
        base_bytes.extend_from_slice(&(num_instances as u32).to_le_bytes());
        base_bytes.extend_from_slice(&(num_classes as u32).to_le_bytes());
        base_bytes.extend_from_slice(&schema_hash(
            &pattern_defs,
            &class_of,
            num_stages,
            stage_divisor,
        ));
        base_bytes.extend_from_slice(&bytes[64..scalar_start]);
        let mut model = if canonical {
            Self::from_bytes_v5(&base_bytes)?
        } else {
            Self::from_bytes_v3(&base_bytes)?
        };
        model.scalar_feature_weights = scalar_feature_weights;
        model.scalar_features_enabled = true;
        Ok(model)
    }

    fn from_bytes_v3(bytes: &[u8]) -> Result<PatternWeights, String> {
        Self::from_bytes_self_describing(bytes, 3, "PWV3")
    }

    /// T163: D4 canonical化スキーム版の自己記述形式(PWV5)を読み込む。
    /// バイト列のレイアウトは[`from_bytes_v3`](Self::from_bytes_v3)(PWV3)と全く
    /// 同じで、パースロジック自体は共有する
    /// ([`from_bytes_self_describing`](Self::from_bytes_self_describing))。
    /// 読み込んだ後に`canonical_tables`を`Some`にする点だけが異なる
    /// (canonical indexテーブルはファイルに保存せず、パターン形状から
    /// 再計算する。既存の`class_info`の扱いと同じ方針)。
    fn from_bytes_v5(bytes: &[u8]) -> Result<PatternWeights, String> {
        let mut model = Self::from_bytes_self_describing(bytes, 5, "PWV5")?;
        model.canonical_tables = Some(model.build_canonical_tables());
        Ok(model)
    }

    /// [`from_bytes_v3`](Self::from_bytes_v3)/[`from_bytes_v5`](Self::from_bytes_v5)
    /// 共通のパース本体(期待バージョン番号とエラーメッセージに使う形式名だけを
    /// 引数で変える)。`canonical_tables`は常に`None`で返す(呼び出し元の
    /// [`from_bytes_v5`](Self::from_bytes_v5)がその後で埋める)。
    fn from_bytes_self_describing(
        bytes: &[u8],
        expected_version: u32,
        format_label: &str,
    ) -> Result<PatternWeights, String> {
        let mut pos = 0usize;
        let read_bytes = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
            let end = pos
                .checked_add(n)
                .ok_or_else(|| "重みファイルの長さがオーバーフローしました".to_string())?;
            if end > bytes.len() {
                return Err("重みファイルが途中で終わっています".to_string());
            }
            let slice = &bytes[*pos..end];
            *pos = end;
            Ok(slice)
        };
        let read_u32 = |pos: &mut usize| -> Result<u32, String> {
            Ok(u32::from_le_bytes(read_bytes(pos, 4)?.try_into().unwrap()))
        };

        let _magic = read_bytes(&mut pos, 4)?;
        let version = read_u32(&mut pos)?;
        if version != expected_version {
            return Err(format!(
                "未対応の{format_label}バージョンです(期待={expected_version}, ファイル={version})"
            ));
        }
        let _flags = read_u32(&mut pos)?;
        let num_stages = read_u32(&mut pos)?;
        let stage_divisor = read_u32(&mut pos)?;
        if !is_supported_stage_definition(num_stages as usize, stage_divisor) {
            return Err(format!("{format_label}のステージ定義が一致しません"));
        }
        let num_instances = read_u32(&mut pos)? as usize;
        let num_classes = read_u32(&mut pos)? as usize;
        const MAX_INSTANCES: usize = 256;
        const MAX_CLASSES: usize = 64;
        if num_instances == 0
            || num_classes == 0
            || num_classes > num_instances
            || num_instances > MAX_INSTANCES
            || num_classes > MAX_CLASSES
        {
            return Err(format!("{format_label}のinstance/class数が不正です"));
        }
        let stored_hash: [u8; 32] = read_bytes(&mut pos, 32)?.try_into().unwrap();
        let minimum_remaining = num_instances
            .checked_mul(4)
            .and_then(|n| num_classes.checked_mul(161).and_then(|c| n.checked_add(c)))
            .ok_or_else(|| format!("{format_label}の個数から必要byte数がオーバーフローしました"))?;
        if bytes.len() - pos < minimum_remaining {
            return Err(format!(
                "{format_label}のinstance/class数と残りbyte数が整合しません"
            ));
        }

        let mut pattern_defs = Vec::with_capacity(num_instances);
        let mut stored_class_of = Vec::with_capacity(num_instances);
        for _ in 0..num_instances {
            let cell_count = read_bytes(&mut pos, 1)?[0] as usize;
            if cell_count == 0 || cell_count > 10 {
                return Err(format!("{format_label}のcell_countが不正です: {cell_count}"));
            }
            let class_id =
                u16::from_le_bytes(read_bytes(&mut pos, 2)?.try_into().unwrap()) as usize;
            if class_id >= num_classes {
                return Err(format!("{format_label}のclass_idが範囲外です: {class_id}"));
            }
            let raw_cells = read_bytes(&mut pos, cell_count)?;
            let mut seen = [false; 64];
            let mut cells = PatternCells::new();
            for &cell in raw_cells {
                if cell >= 64 {
                    return Err(format!("{format_label}のcellが範囲外です: {cell}"));
                }
                if seen[cell as usize] {
                    return Err(format!(
                        "{format_label}のinstance内に重複cellがあります: {cell}"
                    ));
                }
                seen[cell as usize] = true;
                cells.push(cell);
            }
            pattern_defs.push(cells);
            stored_class_of.push(class_id);
        }

        if schema_hash(
            &pattern_defs,
            &stored_class_of,
            num_stages as usize,
            stage_divisor,
        ) != stored_hash
        {
            return Err(format!("{format_label}のschema hashが一致しません"));
        }
        let class_info = patterns::compute_pattern_classes(&pattern_defs);
        if class_info.representative_of_class.len() != num_classes
            || class_info.class_of != stored_class_of
        {
            return Err(format!(
                "{format_label}のD4クラス分類とclass_idが一致しません"
            ));
        }

        let mut class_tables = Vec::with_capacity(num_classes);
        for class_id in 0..num_classes {
            let cell_count = read_bytes(&mut pos, 1)?[0] as usize;
            let expected_len = pattern_defs[class_info.representative_of_class[class_id]].len();
            if cell_count != expected_len
                || stored_class_of
                    .iter()
                    .enumerate()
                    .any(|(i, &id)| id == class_id && pattern_defs[i].len() != cell_count)
            {
                return Err(format!(
                    "{format_label}の同一class内cell_countが一致しません: class={class_id}"
                ));
            }
            let num_states = read_u32(&mut pos)?;
            if num_states != patterns::num_states(cell_count) {
                return Err(format!(
                    "{format_label}のnum_statesが3^cell_countと一致しません: class={class_id}"
                ));
            }
            let mut stage_tables = Vec::with_capacity(num_stages as usize);
            for _ in 0..num_stages {
                let mut table = Vec::with_capacity(num_states as usize);
                for _ in 0..num_states {
                    let weight = f32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
                    if !weight.is_finite() {
                        return Err(format!("{format_label}にfiniteでない重みがあります"));
                    }
                    table.push(weight);
                }
                stage_tables.push(table);
            }
            class_tables.push(PatternWeightTable {
                num_states,
                stage_tables,
            });
        }
        if pos != bytes.len() {
            return Err(format!("{format_label}に余剰bytesがあります"));
        }

        Ok(PatternWeights {
            patterns: pattern_defs,
            class_info,
            class_tables,
            num_stages: num_stages as usize,
            stage_empty_divisor: stage_divisor,
            scalar_feature_weights: Vec::new(),
            scalar_features_enabled: true,
            canonical_tables: None,
        })
    }

    fn from_bytes_v2(bytes: &[u8]) -> Result<PatternWeights, String> {
        let mut pos = 0usize;
        let read_bytes = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
            if *pos + n > bytes.len() {
                return Err("重みファイルが途中で終わっています".to_string());
            }
            let slice = &bytes[*pos..*pos + n];
            *pos += n;
            Ok(slice)
        };

        let _magic = read_bytes(&mut pos, 4)?; // 呼び出し元で"PWV2"確認済み
        let version = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        if version != 2 {
            return Err(format!("未対応のv2バージョン: {version}"));
        }
        let num_patterns = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        let num_classes = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
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
        let class_info = patterns::compute_pattern_classes(&pattern_defs);
        if class_info.representative_of_class.len() != num_classes as usize {
            return Err(format!(
                "クラス数が一致しません(ファイル={num_classes}, 現在の定義={})",
                class_info.representative_of_class.len()
            ));
        }

        let mut class_tables = Vec::with_capacity(class_info.representative_of_class.len());
        for &rep_idx in &class_info.representative_of_class {
            let cell_count = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
            if cell_count as usize != pattern_defs[rep_idx].len() {
                return Err(format!(
                    "クラス代表のセル数が一致しません(ファイル={cell_count}, 現在の定義={})",
                    pattern_defs[rep_idx].len()
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
            class_tables.push(PatternWeightTable {
                num_states,
                stage_tables,
            });
        }

        Ok(PatternWeights {
            patterns: pattern_defs,
            class_info,
            class_tables,
            num_stages: NUM_STAGES,
            stage_empty_divisor: STAGE_EMPTY_DIVISOR,
            scalar_feature_weights: Vec::new(),
            scalar_features_enabled: true,
            canonical_tables: None,
        })
    }

    /// v1形式(T041、22インスタンス独立の重みテーブル)を読み込む。
    /// 22インスタンスそれぞれが単独のクラスを構成する(重み共有なし)ものとして
    /// `PatternClassInfo`を組み立てる。
    fn from_bytes_v1(bytes: &[u8]) -> Result<PatternWeights, String> {
        let mut pos = 0usize;
        let read_bytes = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
            if *pos + n > bytes.len() {
                return Err("重みファイルが途中で終わっています".to_string());
            }
            let slice = &bytes[*pos..*pos + n];
            *pos += n;
            Ok(slice)
        };

        let _magic = read_bytes(&mut pos, 4)?; // 呼び出し元で"PWV1"確認済み
        let version = u32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
        if version != 1 {
            return Err(format!("未対応のv1バージョン: {version}"));
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

        let n = pattern_defs.len();
        let mut class_tables = Vec::with_capacity(n);
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
            class_tables.push(PatternWeightTable {
                num_states,
                stage_tables,
            });
        }

        // v1は重み共有なし: 各インスタンスが単独のクラス(class_id == instance index)。
        let class_info = PatternClassInfo {
            class_of: (0..n).collect(),
            representative_of_class: (0..n).collect(),
            symmetry_of: vec![0; n],
            aligned_cells: pattern_defs.clone(),
        };

        Ok(PatternWeights {
            patterns: pattern_defs,
            class_info,
            class_tables,
            num_stages: NUM_STAGES,
            stage_empty_divisor: STAGE_EMPTY_DIVISOR,
            scalar_feature_weights: Vec::new(),
            scalar_features_enabled: true,
            canonical_tables: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_standard_test_vector() {
        assert_eq!(
            sha256(b"abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }

    fn pwv3_bytes() -> Vec<u8> {
        PatternWeights::zeroed(patterns::generate_patterns()).to_bytes_v3()
    }

    fn pwv3_class_block_offset(bytes: &[u8]) -> usize {
        let instances = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
        let mut pos = 60;
        for _ in 0..instances {
            let count = bytes[pos] as usize;
            pos += 3 + count;
        }
        pos
    }

    fn pwv4_model() -> PatternWeights {
        PatternWeights::zeroed_with_stage_definition(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            V4_NUM_STAGES,
            V4_STAGE_EMPTY_DIVISOR,
        )
        .with_zeroed_scalar_features()
    }

    fn pwv4_scalar_block_offset(bytes: &[u8]) -> usize {
        let instances = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
        let classes = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
        let stages = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let mut pos = 64;
        for _ in 0..instances {
            let count = bytes[pos] as usize;
            pos += 3 + count;
        }
        for _ in 0..classes {
            let states = u32::from_le_bytes(bytes[pos + 1..pos + 5].try_into().unwrap()) as usize;
            pos += 5 + stages * states * 4;
        }
        pos
    }

    #[test]
    fn pwv4_roundtrip_preserves_scalar_schema_and_weights() {
        let mut model = pwv4_model();
        model.scalar_feature_weights[0].weights[17] = 1.25;
        model.scalar_feature_weights[1].weights[60] = -2.5;
        let bytes = model.to_bytes_v4();
        assert_eq!(&bytes[..4], b"PWV4");
        let restored = PatternWeights::from_bytes(&bytes).unwrap();
        assert!(restored.scalar_features_enabled());
        assert_eq!(
            restored.scalar_feature_weights,
            model.scalar_feature_weights
        );
        assert_eq!(restored.to_bytes_v4(), bytes);
    }

    #[test]
    fn pwv4_rejects_corrupt_scalar_blocks_and_header() {
        let bytes = pwv4_model().to_bytes_v4();
        let scalar = pwv4_scalar_block_offset(&bytes);

        let mut wrong_stage_count = bytes.clone();
        wrong_stage_count[12..16].copy_from_slice(&13u32.to_le_bytes());
        assert!(PatternWeights::from_bytes(&wrong_stage_count).is_err());

        let mut unknown_kind = bytes.clone();
        unknown_kind[scalar] = 99;
        assert!(PatternWeights::from_bytes(&unknown_kind).is_err());

        let second = scalar + 4 + V4_NUM_STAGES * 4;
        let mut duplicate_kind = bytes.clone();
        duplicate_kind[second] = duplicate_kind[scalar];
        assert!(PatternWeights::from_bytes(&duplicate_kind).is_err());

        let mut wrong_scale = bytes.clone();
        wrong_scale[scalar + 1] ^= 1;
        assert!(PatternWeights::from_bytes(&wrong_scale).is_err());

        let mut nonzero_reserved = bytes.clone();
        nonzero_reserved[scalar + 2] = 1;
        assert!(PatternWeights::from_bytes(&nonzero_reserved).is_err());

        let mut nonfinite = bytes.clone();
        nonfinite[scalar + 4..scalar + 8].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(PatternWeights::from_bytes(&nonfinite).is_err());

        let mut trailing = bytes;
        trailing.push(0);
        assert!(PatternWeights::from_bytes(&trailing).is_err());
    }

    #[test]
    fn zero_scalar_coefficients_are_bit_exact_with_pwv3_scores() {
        let baseline_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v4.bin"
        );
        let baseline_bytes = std::fs::read(baseline_path).unwrap();
        let baseline = PatternWeights::from_bytes(&baseline_bytes).unwrap();
        let candidate_bytes = {
            let mut candidate = baseline.clone().with_zeroed_scalar_features();
            candidate.scalar_features_enabled = true;
            candidate.to_bytes_v4()
        };
        let candidate = PatternWeights::from_bytes(&candidate_bytes).unwrap();

        let mut board = Board::initial();
        let mut side = Side::Black;
        for _ in 0..40 {
            assert_eq!(
                baseline.score(&board, side).to_bits(),
                candidate.score(&board, side).to_bits()
            );
            let legal = board.legal_moves(side);
            if legal == 0 {
                side = side.opposite();
                if board.legal_moves(side) == 0 {
                    break;
                }
                continue;
            }
            board = board.apply_move(side, legal & legal.wrapping_neg());
            side = side.opposite();
        }
    }

    #[test]
    fn production_pwv3_scores_match_parent_commit_golden_bits() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v4.bin"
        );
        let weights = PatternWeights::from_bytes(&std::fs::read(path).unwrap()).unwrap();
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../bench/edax-compare/t158a_engine_cost_positions.json"
        )))
        .unwrap();
        let actual = fixtures
            .as_array()
            .unwrap()
            .iter()
            .map(|fixture| {
                let parse = |key: &str| {
                    u64::from_str_radix(
                        fixture[key].as_str().unwrap().strip_prefix("0x").unwrap(),
                        16,
                    )
                    .unwrap()
                };
                let board = Board {
                    black: parse("black"),
                    white: parse("white"),
                };
                let side = if fixture["turn"] == "black" {
                    Side::Black
                } else {
                    Side::White
                };
                weights.score(&board, side).to_bits()
            })
            .collect::<Vec<_>>();
        // Captured from the parent commit before PWV4/scalar-feature integration.
        let golden = [
            1_096_847_631,
            1_050_921_104,
            1_087_962_051,
            3_258_694_572,
            3_245_183_306,
            3_240_604_642,
            3_252_197_972,
            3_225_423_250,
        ];
        assert_eq!(actual, golden);
    }

    #[test]
    fn disabling_scalar_features_restores_the_pattern_only_score() {
        let mut model = pwv4_model();
        model.scalar_feature_weights[1].weights.fill(32.0);
        let board = Board {
            black: 1u64 << 0,
            white: 1u64 << 1,
        };
        assert_ne!(model.score(&board, Side::Black), 0.0);
        model.set_scalar_features_enabled(false);
        assert_eq!(model.score(&board, Side::Black).to_bits(), 0.0f32.to_bits());
    }

    #[test]
    fn pwv3_roundtrip_is_self_describing() {
        let patterns = patterns::generate_patterns_for(patterns::PatternConfig::V3);
        let weights = PatternWeights::zeroed(patterns);
        let bytes = weights.to_bytes_v3();
        assert_eq!(&bytes[..4], b"PWV3");
        let restored = PatternWeights::from_bytes(&bytes).unwrap();
        assert_eq!(restored.patterns, weights.class_info.aligned_cells);
        assert_eq!(restored.class_tables.len(), 10);
    }

    #[test]
    fn pwv3_rejects_out_of_range_cell() {
        let mut bytes = pwv3_bytes();
        bytes[63] = 64;
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_duplicate_cell_in_instance() {
        let mut bytes = pwv3_bytes();
        bytes[64] = bytes[63];
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_wrong_num_states() {
        let mut bytes = pwv3_bytes();
        let pos = pwv3_class_block_offset(&bytes) + 1;
        bytes[pos..pos + 4].copy_from_slice(&1u32.to_le_bytes());
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_out_of_range_class_id() {
        let mut bytes = pwv3_bytes();
        let classes = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as u16;
        bytes[61..63].copy_from_slice(&classes.to_le_bytes());
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_class_cell_count_mismatch() {
        let mut bytes = pwv3_bytes();
        let pos = pwv3_class_block_offset(&bytes);
        bytes[pos] -= 1;
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_saved_class_ids_that_disagree_with_d4() {
        let mut weights = PatternWeights::zeroed(patterns::generate_patterns());
        weights.class_info.class_of[0] = 1;
        assert!(PatternWeights::from_bytes(&weights.to_bytes_v3()).is_err());
    }

    #[test]
    fn pwv3_rejects_non_finite_weight() {
        let mut bytes = pwv3_bytes();
        let pos = pwv3_class_block_offset(&bytes) + 5;
        bytes[pos..pos + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_trailing_bytes() {
        let mut bytes = pwv3_bytes();
        bytes.push(0);
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_schema_hash_mismatch() {
        let mut bytes = pwv3_bytes();
        bytes[28] ^= 1;
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_excessive_instance_count_before_allocation() {
        let mut bytes = pwv3_bytes();
        bytes[20..24].copy_from_slice(&257u32.to_le_bytes());
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn pwv3_rejects_counts_inconsistent_with_remaining_bytes() {
        let mut bytes = pwv3_bytes();
        bytes[20..24].copy_from_slice(&200u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&64u32.to_le_bytes());
        bytes.truncate(60);
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn stage_for_empty_count_buckets_correctly() {
        assert_eq!(stage_for_empty_count(0), 0);
        assert_eq!(stage_for_empty_count(4), 0);
        assert_eq!(stage_for_empty_count(5), 1);
        assert_eq!(stage_for_empty_count(60), 12);
    }

    #[test]
    fn v4_stage_boundaries_and_pwv3_roundtrip_are_correct() {
        let patterns = patterns::generate_patterns_for(patterns::PatternConfig::V3);
        let mut weights = PatternWeights::zeroed_with_stage_definition(
            patterns,
            V4_NUM_STAGES,
            V4_STAGE_EMPTY_DIVISOR,
        );
        assert_eq!(weights.stage_for_empty_count(0), 0);
        assert_eq!(weights.stage_for_empty_count(1), 1);
        assert_eq!(weights.stage_for_empty_count(59), 59);
        assert_eq!(weights.stage_for_empty_count(60), 60);

        for table in &mut weights.class_tables {
            table.stage_tables[60].fill(1.0);
        }
        let initial = Board::initial();
        assert_eq!(weights.score(&initial, Side::Black), 38.0);
        let after_move = initial.apply_move(Side::Black, 1u64 << 19);
        assert_eq!(weights.score(&after_move, Side::White), 0.0);

        let restored = PatternWeights::from_bytes(&weights.to_bytes_v3()).unwrap();
        assert_eq!(restored.num_stages, V4_NUM_STAGES);
        assert_eq!(restored.stage_empty_divisor, V4_STAGE_EMPTY_DIVISOR);
        assert_eq!(restored.score(&initial, Side::Black), 38.0);
    }

    #[test]
    fn zeroed_model_scores_zero_everywhere() {
        let patterns = patterns::generate_patterns();
        let weights = PatternWeights::zeroed(patterns);
        let board = Board::initial();
        assert_eq!(weights.score(&board, Side::Black), 0.0);
    }

    #[test]
    fn zeroed_model_has_6_symmetry_orbit_classes() {
        let patterns = patterns::generate_patterns();
        let weights = PatternWeights::zeroed(patterns);
        assert_eq!(weights.class_tables.len(), 6);
        assert_eq!(weights.class_info.representative_of_class.len(), 6);
    }

    /// `board`の全セルの石を、対称変換`sym`(`patterns::apply_symmetry`)で
    /// 写した先のセルへ移した新しい盤面を返す(`patterns.rs`の`transform_board`
    /// と同じロジック。あちらは`#[cfg(test)]`かつ非公開でこのモジュールから
    /// 直接使えないため、`patterns::apply_symmetry`だけを使って本モジュールの
    /// テスト内で組み立て直す)。
    fn transform_board_for_test(board: &Board, sym: usize) -> Board {
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

    fn adjacency_incidence_reference(side_bits: u64, empty: u64) -> u32 {
        let mut count = 0;
        for side_square in 0..64u32 {
            if side_bits & (1u64 << side_square) == 0 {
                continue;
            }
            let sx = (side_square % 8) as i32;
            let sy = (side_square / 8) as i32;
            for empty_square in 0..64u32 {
                if empty & (1u64 << empty_square) == 0 {
                    continue;
                }
                let ex = (empty_square % 8) as i32;
                let ey = (empty_square / 8) as i32;
                if (sx - ex).abs() <= 1 && (sy - ey).abs() <= 1 {
                    count += 1;
                }
            }
        }
        count
    }

    #[test]
    fn scalar_features_match_reference_and_obey_color_and_d4_symmetry() {
        let board = Board {
            black: 0x0000_081c_3420_0000,
            white: 0x0000_1020_081c_0000,
        };
        let empty = !(board.black | board.white);
        assert_eq!(
            empty_adjacency_incidence(board.black, empty),
            adjacency_incidence_reference(board.black, empty)
        );
        assert_eq!(
            empty_adjacency_incidence(board.white, empty),
            adjacency_incidence_reference(board.white, empty)
        );

        let black = scalar_features(&board, Side::Black);
        let swapped = Board {
            black: board.white,
            white: board.black,
        };
        let swapped_black = scalar_features(&swapped, Side::Black);
        assert_eq!(
            swapped_black.exact_mobility_advantage,
            -black.exact_mobility_advantage
        );
        assert_eq!(
            swapped_black.empty_adjacency_exposure_advantage,
            -black.empty_adjacency_exposure_advantage
        );

        for sym in 0..patterns::NUM_SYMMETRIES {
            let transformed = transform_board_for_test(&board, sym);
            assert_eq!(
                scalar_features(&transformed, Side::Black),
                black,
                "sym={sym}"
            );
        }
    }

    #[test]
    fn score_is_invariant_under_all_eight_d4_symmetries_of_the_initial_position() {
        // T139: `PatternWeights::score`のD4不変性を直接検証する回帰テスト
        // (explorer調査で欠落を確認済み)。
        //
        // `search_all_moves_with_eval`が対称局面(初手d3/c4/f5/e6等)で
        // 評価値がズレる問題の主因はTT共有・MPC近似枝刈りの順序依存
        // (T138調査、T139本体の修正で対応済み)。ここでは、そもそも
        // 静的評価自体が対称初手のシナリオでD4不変であることを直接確認する。
        //
        // # 調査で判明した既知の制約(本テストの対象範囲を限定した理由)
        // 任意の(非対称な)盤面に対しては、現在の`PatternWeights::score`は
        // 厳密なD4不変性を保証しない。`patterns::compute_pattern_classes`が
        // 各インスタンスの`aligned_cells`(状態インデックス計算に使うセル順序)
        // を「対称変換で先に一致したセル集合」だけで決めており、D4軌道サイズが
        // 8未満のクラス(対角線: 軌道2、行・列・隅3x3: 軌道4)では、盤面全体を
        // 回転・反転した際に必要になる「もう一方のセル順序」(スタビライザーの
        // 非自明要素による並べ替え)が記録されないことがある。位置重み付けの
        // 3進数エンコード(`pattern_state_index`)はセルの並び順に依存するため、
        // 対称な盤面(内容自体がD4対称、またはパターンが触れるセルが全て空)
        // では並び順の違いが結果に影響しないが、非対称な盤面では実際に
        // スコアが変わりうる(調査で最大でクラス単位・数点相当のズレを確認)。
        //
        // これはT044(対称重み共有の導入)由来の設計上の制約であり、本タスク
        // (T139、analyzeAllのTT共有・MPC順序依存の解消)のスコープ外と判断した
        // (完全に直すには対称オービットの整列方法自体の見直し=検討した選択肢3の
        // 「D4 canonical化」相当の実装大な変更が必要になる)。
        //
        // 訂正(T145、レビュー指摘M1): 当初この付近のコメントには
        // 「`PatternWeights`は対局・解析のどちらの経路でも実運用では未使用」
        // という記述があったが、これは事実誤認だった。本番はT147以降
        // v4×PatternWeights が配線済みで、`app/src/engine/worker.ts` が
        // `pattern_v4.bin` をロードして `Engine::load_pattern_weights` に渡し、
        // 対局・解析(analyzeAll含む)の全経路で`PatternWeights::score`を実際に
        // 使っている。つまりここで説明した`compute_pattern_classes`のD4不変性の
        // 破れは、机上の懸念ではなく**現在の本番評価に実際に効いている**:
        // 非対称な合同局面ペア(D4変換で互いに写り合うが盤面自体は非対称)では、
        // 静的評価が並び順の違いにより数点相当ズレうる。それでも根本修正
        // (D4 canonical化)を本タスク・T139のスコープに含めなかったのは、
        // 実装コストが大きい一方で影響がクラス単位・数点相当の静的評価ズレに
        // 留まり(探索全体を壊すものではない)、優先度としては見送り可能と
        // 判断したため(工数対効果の判断であり、影響がゼロという意味ではない)。
        // 根本修正はバックログ行きの別タスク(D4 canonical化相当)とする。
        // そのため本テストは、実際にT139が解決すべき実用シナリオ(初期局面は
        // 本質的にD4対称)に対応する範囲で不変性を検証する。任意局面での
        // 不変性の根本対応はオーケストレーターの判断でバックログ化する
        // (作業ログ・完了レポート参照)。
        let patterns = patterns::generate_patterns();
        let mut weights = PatternWeights::zeroed(patterns);
        // 各クラス・各ステージ・各状態に異なる値を入れ、たまたま値が
        // 揃って不変性の破れを見逃す事故を避ける。
        for (class_id, table) in weights.class_tables.iter_mut().enumerate() {
            for (stage, stage_table) in table.stage_tables.iter_mut().enumerate() {
                for (state, w) in stage_table.iter_mut().enumerate() {
                    *w = (class_id * 10_000 + stage * 100 + state) as f32 * 0.001;
                }
            }
        }

        let board = Board::initial();

        for &mover in &[Side::Black, Side::White] {
            let base_score = weights.score(&board, mover);
            for sym in 0..patterns::NUM_SYMMETRIES {
                let transformed = transform_board_for_test(&board, sym);
                let score = weights.score(&transformed, mover);
                assert!(
                    (score - base_score).abs() < 1e-3,
                    "sym={sym} mover={mover:?}: score should be invariant under D4 symmetry for \
                     the (inherently D4-symmetric) initial position, got {score} vs base \
                     {base_score}"
                );
            }
        }
    }

    // -----------------------------------------------------------------
    // T163: D4 canonical化スキーム(PWV5)
    // -----------------------------------------------------------------

    /// テスト専用の決定的な疑似乱数生成器(xorshift64、`patterns.rs`のテスト用
    /// RNGと同じ設計。乱数の質より再現性を優先する)。
    struct T163Xorshift64 {
        state: u64,
    }

    impl T163Xorshift64 {
        fn new(seed: u64) -> Self {
            T163Xorshift64 { state: seed.max(1) }
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.state;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.state = x;
            x
        }
    }

    /// 各セルを独立に空/黒石/白石のいずれかにランダムに割り当てた盤面を生成する
    /// (合法性は問わない。D4不変性は盤面の合法性によらず成り立つはずの性質
    /// なので、合法性を問わない方がむしろ検証範囲を広げる)。
    fn t163_random_board(rng: &mut T163Xorshift64) -> Board {
        let mut black = 0u64;
        let mut white = 0u64;
        for c in 0u8..64 {
            let bit = 1u64 << c;
            match rng.next_u64() % 3 {
                0 => {}
                1 => black |= bit,
                _ => white |= bit,
            }
        }
        Board { black, white }
    }

    /// canonical化スキームで、各クラス・各ステージ・各状態に異なる値を入れた
    /// モデルを作る(たまたま値が揃って不変性の破れを見逃す事故を避けるため、
    /// 直上のレガシー版テストと同じ手法)。
    fn t163_distinguishing_canonical_model(
        patterns: Vec<PatternCells>,
        num_stages: usize,
        stage_empty_divisor: u32,
    ) -> PatternWeights {
        let mut weights =
            PatternWeights::zeroed_canonical(patterns, num_stages, stage_empty_divisor);
        for (class_id, table) in weights.class_tables.iter_mut().enumerate() {
            for (stage, stage_table) in table.stage_tables.iter_mut().enumerate() {
                for (state, w) in stage_table.iter_mut().enumerate() {
                    *w = (class_id * 100_000 + stage * 1_000 + state) as f32 * 0.0001;
                }
            }
        }
        weights
    }

    fn t163_assert_all_symmetries_agree(weights: &PatternWeights, board: &Board, label: &str) {
        for &mover in &[Side::Black, Side::White] {
            let base_score = weights.score(board, mover);
            for sym in 0..patterns::NUM_SYMMETRIES {
                let transformed = transform_board_for_test(board, sym);
                let score = weights.score(&transformed, mover);
                assert!(
                    (score - base_score).abs() < 1e-2,
                    "{label}: sym={sym} mover={mover:?}: canonical score should be exactly \
                     D4-invariant, got {score} vs base {base_score} (board black={:#x} \
                     white={:#x})",
                    board.black,
                    board.white
                );
            }
        }
    }

    #[test]
    fn t163_canonical_score_is_invariant_under_all_eight_d4_symmetries_of_random_boards() {
        // T163(重大バグ修正の性質テスト、最重要): レガシースキーム(直上の
        // `score_is_invariant_under_all_eight_d4_symmetries_of_the_initial_position`)は
        // 初期局面(本質的にD4対称)でしか不変性を確認できなかったが、canonical化
        // スキーム(`zeroed_canonical`)は**任意の**局面(非対称含む)で全8対称変換に
        // ついてscoreが完全一致するはず、というのが本タスクの核心的性質。
        // 決定的seedで数百局面(疎な盤面・稠密な盤面を広くカバーするランダム
        // 盤面)×全8対称で検証する。
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let mut rng = T163Xorshift64::new(0x7163_D4C0_1234_5678);
        const NUM_RANDOM_BOARDS: usize = 300;
        for i in 0..NUM_RANDOM_BOARDS {
            let board = t163_random_board(&mut rng);
            t163_assert_all_symmetries_agree(&weights, &board, &format!("random board #{i}"));
        }
    }

    #[test]
    fn t163_canonical_score_is_invariant_across_self_play_games_including_near_endgame() {
        // T163要件1(a): 「パスや終局近くを含む多様な局面」を、実際に合法手だけを
        // 指す自己対戦(決定的疑似乱数で着手選択)で生成し、対局中の全局面
        // (パスの発生・終局直前の空きマス数が少ない局面を含む)で検証する。
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let mut rng = T163Xorshift64::new(0x5EED_C0FF_EE00_0001);
        const NUM_GAMES: usize = 12;
        let mut checked = 0usize;
        for game in 0..NUM_GAMES {
            let mut board = Board::initial();
            let mut side = Side::Black;
            loop {
                t163_assert_all_symmetries_agree(&weights, &board, &format!("game #{game}"));
                checked += 1;
                let legal = board.legal_moves(side);
                if legal == 0 {
                    side = side.opposite();
                    if board.legal_moves(side) == 0 {
                        break; // 終局(両者とも着手不可)
                    }
                    continue;
                }
                let moves: Vec<u64> = (0..64).filter(|&i| legal & (1u64 << i) != 0).collect();
                let choice = moves[(rng.next_u64() as usize) % moves.len()];
                board = board.apply_move(side, 1u64 << choice);
                side = side.opposite();
            }
        }
        assert!(
            checked > 200,
            "expected to check a substantial number of self-play positions, got {checked}"
        );
    }

    #[test]
    fn t163_canonical_score_is_invariant_for_v3_pattern_shapes_including_non_square_orbits() {
        // T163: V2以外のパターン形状(edge2x/対角オフセット5-6-7。
        // `PatternConfig::V3`はcorner5x2を**含まない**——隅5x2は
        // `PatternConfig::V2Corner5x2`専用の形状であり、V3ではedge2xと
        // 対角オフセット5-6-7だけが追加される。この点はT164レビューで
        // 本コメントの誤記として指摘され訂正した(隅5x2のカバレッジは直後の
        // `t164_canonical_score_is_invariant_for_corner5x2_pattern_shape`が担う)。
        // 軌道サイズ4または8で非自明な安定化群を持つ形状でもcanonical化が
        // 正しく機能することを確認する(パターン形状に依存しない一般的な実装で
        // あることの裏付け)。
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let mut rng = T163Xorshift64::new(0xA11D_45CA_9E5D_0001);
        const NUM_RANDOM_BOARDS: usize = 80;
        for i in 0..NUM_RANDOM_BOARDS {
            let board = t163_random_board(&mut rng);
            t163_assert_all_symmetries_agree(&weights, &board, &format!("v3 random board #{i}"));
        }
    }

    #[test]
    fn t164_canonical_score_is_invariant_for_corner5x2_pattern_shape() {
        // T164前段修正(b): T163の`t163_canonical_score_is_invariant_for_v3_pattern_shapes_...`は
        // コメントで「隅5x2をカバー」と誤って書いていたが、`PatternConfig::V3`は
        // corner5x2を含まない(`PatternConfig::V2Corner5x2`専用)。本テストは
        // 実際に隅5x2形状(10セル、軌道サイズ8)を使ってcanonical化の
        // D4不変性を検証し、記述と実態を一致させる(安定化群が自明
        // 〈恒等のみ〉なため理論上は自明に成立するはずだが、実装のカバレッジ
        // として明示的に確認する)。
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns_for(patterns::PatternConfig::V2Corner5x2),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let mut rng = T163Xorshift64::new(0xC0521_5C2_5EED_0001);
        const NUM_RANDOM_BOARDS: usize = 80;
        for i in 0..NUM_RANDOM_BOARDS {
            let board = t163_random_board(&mut rng);
            t163_assert_all_symmetries_agree(
                &weights,
                &board,
                &format!("corner5x2 random board #{i}"),
            );
        }
    }

    #[test]
    fn t163_zeroed_canonical_model_is_canonical_and_legacy_zeroed_is_not() {
        assert!(!PatternWeights::zeroed(patterns::generate_patterns()).is_canonical());
        assert!(PatternWeights::zeroed_canonical(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        )
        .is_canonical());
    }

    #[test]
    #[should_panic(expected = "to_bytes_v5")]
    fn t163_to_bytes_v5_panics_for_legacy_non_canonical_weights() {
        let weights = PatternWeights::zeroed(patterns::generate_patterns());
        let _ = weights.to_bytes_v5();
    }

    #[test]
    fn t163_pwv5_roundtrip_preserves_canonical_scheme_and_scores() {
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let bytes = weights.to_bytes_v5();
        assert_eq!(&bytes[..4], b"PWV5");
        let restored = PatternWeights::from_bytes(&bytes).unwrap();
        assert!(restored.is_canonical());
        for &mover in &[Side::Black, Side::White] {
            assert_eq!(
                weights.score(&Board::initial(), mover).to_bits(),
                restored.score(&Board::initial(), mover).to_bits()
            );
        }
        assert_eq!(restored.to_bytes_v5(), bytes);
    }

    #[test]
    fn t163_pwv3_bytes_are_read_as_legacy_even_through_the_shared_parser() {
        // 要件4: PWV3(レガシー)のバイト列はcanonical化スキームとして誤読
        // されない(マジックバイトで新旧を明示的に振り分ける、
        // `from_bytes_self_describing`のパース本体を共有していても
        // `canonical_tables`を後付けするのは`from_bytes_v5`だけであることの確認)。
        let legacy_bytes = PatternWeights::zeroed(patterns::generate_patterns()).to_bytes_v3();
        let restored = PatternWeights::from_bytes(&legacy_bytes).unwrap();
        assert!(!restored.is_canonical());
    }

    #[test]
    fn t163_pwv5_rejects_schema_hash_mismatch() {
        let weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let mut bytes = weights.to_bytes_v5();
        bytes[28] ^= 1; // schema_hashの先頭1byteを破壊する(PWV3と同じオフセット)
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    // -----------------------------------------------------------------
    // T164前段修正(a、T163レビュー中1指摘): レガシー書き出しのスキームガード
    // -----------------------------------------------------------------

    #[test]
    #[should_panic(expected = "to_bytes(PWV2)")]
    fn t164_to_bytes_panics_for_canonical_weights() {
        let weights = PatternWeights::zeroed_canonical(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let _ = weights.to_bytes();
    }

    #[test]
    #[should_panic(expected = "to_bytes_v3")]
    fn t164_to_bytes_v3_panics_for_canonical_weights() {
        let weights = PatternWeights::zeroed_canonical(
            patterns::generate_patterns(),
            NUM_STAGES,
            STAGE_EMPTY_DIVISOR,
        );
        let _ = weights.to_bytes_v3();
    }

    #[test]
    #[should_panic(expected = "to_bytes_v4")]
    fn t164_to_bytes_v4_panics_for_canonical_weights() {
        let weights = t164_distinguishing_canonical_scalar_model();
        let _ = weights.to_bytes_v4();
    }

    #[test]
    #[should_panic(expected = "to_bytes_v6")]
    fn t164_to_bytes_v6_panics_for_legacy_non_canonical_weights() {
        let weights = PatternWeights::zeroed_with_stage_definition(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            V4_NUM_STAGES,
            V4_STAGE_EMPTY_DIVISOR,
        )
        .with_zeroed_scalar_features();
        let _ = weights.to_bytes_v6();
    }

    // -----------------------------------------------------------------
    // T164要件2/3: PWV6(D4 canonical化+scalar特徴、B3構成相当)
    // -----------------------------------------------------------------

    /// canonicalスキーム+scalar特徴(B3相当: モビリティ・囲い度の両方)の
    /// パターン重み・scalar係数がどちらも異なる値を持つモデルを作る
    /// (T163の`t163_distinguishing_canonical_model`と同じ考え方: たまたま値が
    /// 揃って不変性の破れを見逃す事故を避ける)。
    fn t164_distinguishing_canonical_scalar_model() -> PatternWeights {
        let mut weights = t163_distinguishing_canonical_model(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            V4_NUM_STAGES,
            V4_STAGE_EMPTY_DIVISOR,
        )
        .with_zeroed_scalar_features();
        for (i, feature) in weights.scalar_feature_weights.iter_mut().enumerate() {
            for (stage, w) in feature.weights.iter_mut().enumerate() {
                *w = (i * 1_000 + stage) as f32 * 0.01;
            }
        }
        weights
    }

    #[test]
    fn t164_pwv6_roundtrip_preserves_canonical_scheme_scalar_features_and_scores() {
        let weights = t164_distinguishing_canonical_scalar_model();
        let bytes = weights.to_bytes_v6();
        assert_eq!(&bytes[..4], b"PWV6");
        let restored = PatternWeights::from_bytes(&bytes).unwrap();
        assert!(restored.is_canonical());
        assert!(restored.scalar_features_enabled());
        assert_eq!(
            restored.scalar_feature_weights,
            weights.scalar_feature_weights
        );
        let board = Board::initial();
        for &mover in &[Side::Black, Side::White] {
            assert_eq!(
                weights.score(&board, mover).to_bits(),
                restored.score(&board, mover).to_bits()
            );
        }
        assert_eq!(restored.to_bytes_v6(), bytes);
    }

    #[test]
    fn t164_pwv4_bytes_are_read_as_legacy_even_through_the_shared_scalar_parser() {
        // PWV4(レガシー+scalar)のバイト列がPWV6経路(canonical)に誤って
        // 迷い込まないことの確認(`from_bytes_scalar_extended`の共有パース本体が
        // マジックバイトで正しく振り分けられていることの裏付け)。
        let legacy = PatternWeights::zeroed_with_stage_definition(
            patterns::generate_patterns_for(patterns::PatternConfig::V3),
            V4_NUM_STAGES,
            V4_STAGE_EMPTY_DIVISOR,
        )
        .with_zeroed_scalar_features();
        let bytes = legacy.to_bytes_v4();
        let restored = PatternWeights::from_bytes(&bytes).unwrap();
        assert!(!restored.is_canonical());
    }

    #[test]
    fn t164_pwv6_rejects_schema_hash_mismatch() {
        let weights = t164_distinguishing_canonical_scalar_model();
        let mut bytes = weights.to_bytes_v6();
        bytes[32] ^= 1; // schema_hash_v4の先頭1byte(PWV4と同じオフセット)を破壊
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn t164_canonical_scalar_score_is_invariant_under_all_eight_d4_symmetries() {
        // T164要件2/3(最重要): canonical化+scalar特徴を組み合わせても、
        // 全8対称変換でscoreが完全一致すること。scalar特徴自体は既に
        // (`scalar_features_match_reference_and_obey_color_and_d4_symmetry`で)
        // 対称不変量であることが確認済みだが、B3構成としての配線
        // (PWV6のシリアライズ・スコア加算経路)に不変性を壊す取り違えが
        // 無いことを直接確認する。
        let weights = t164_distinguishing_canonical_scalar_model();
        let mut rng = T163Xorshift64::new(0xB3CA_1E5C_A100_01u64);
        const NUM_RANDOM_BOARDS: usize = 150;
        for i in 0..NUM_RANDOM_BOARDS {
            let board = t163_random_board(&mut rng);
            t163_assert_all_symmetries_agree(&weights, &board, &format!("b3-canonical board #{i}"));
        }
    }

    #[test]
    fn to_bytes_and_from_bytes_roundtrip_preserves_weights() {
        let patterns = patterns::generate_patterns();
        let mut weights = PatternWeights::zeroed(patterns);
        // 非ゼロの重みを手動でいくつか設定し、往復で保持されることを確認する
        // (class_tablesは6クラス分しかないため、有効な範囲のインデックスを使う)。
        weights.class_tables[0].stage_tables[0][0] = 1.5;
        let last_class = weights.class_tables.len() - 1;
        weights.class_tables[last_class].stage_tables[12][100] = -2.25;

        let bytes = weights.to_bytes();
        let restored = PatternWeights::from_bytes(&bytes).expect("should parse");

        assert_eq!(restored.class_tables[0].stage_tables[0][0], 1.5);
        assert_eq!(
            restored.class_tables[last_class].stage_tables[12][100],
            -2.25
        );

        let board = Board::initial();
        assert_eq!(
            weights.score(&board, Side::Black),
            restored.score(&board, Side::Black)
        );
    }

    #[test]
    fn to_bytes_writes_pwv2_magic() {
        let patterns = patterns::generate_patterns();
        let weights = PatternWeights::zeroed(patterns);
        let bytes = weights.to_bytes();
        assert_eq!(&bytes[0..4], b"PWV2");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
    }

    #[test]
    fn from_bytes_rejects_bad_magic() {
        let bytes = vec![0u8; 20];
        assert!(PatternWeights::from_bytes(&bytes).is_err());
    }

    #[test]
    fn from_bytes_rejects_truncated_data() {
        let patterns = patterns::generate_patterns();
        let weights = PatternWeights::zeroed(patterns);
        let bytes = weights.to_bytes();
        let truncated = &bytes[..bytes.len() - 10];
        assert!(PatternWeights::from_bytes(truncated).is_err());
    }

    /// v1形式(T041、22インスタンスがそれぞれ独立した重みテーブルを持つ、
    /// 重み共有なし)のバイト列を手動で組み立てるヘルパー。
    fn build_legacy_v1_bytes(nonzero: &[(usize, usize, usize, f32)]) -> Vec<u8> {
        let pattern_defs = patterns::generate_patterns();
        let mut buf = Vec::new();
        buf.extend_from_slice(b"PWV1");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&(pattern_defs.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(NUM_STAGES as u32).to_le_bytes());

        for (pattern_id, cells) in pattern_defs.iter().enumerate() {
            buf.extend_from_slice(&(cells.len() as u32).to_le_bytes());
            let num_states = patterns::num_states(cells.len());
            for stage in 0..NUM_STAGES {
                for state in 0..num_states {
                    let w = nonzero
                        .iter()
                        .find(|&&(p, s, st, _)| {
                            p == pattern_id && s == stage && st == state as usize
                        })
                        .map(|&(_, _, _, w)| w)
                        .unwrap_or(0.0);
                    buf.extend_from_slice(&w.to_le_bytes());
                }
            }
        }
        buf
    }

    #[test]
    fn from_bytes_v1_loads_legacy_format_without_weight_sharing() {
        // T044より前のv1形式(pattern_v1.bin)は、重み共有なしで22インスタンス
        // それぞれが独立した重みテーブルを持つ。後方互換性のため、
        // from_bytes(v1)がこれを正しく読み込めることを確認する。
        let bytes = build_legacy_v1_bytes(&[(0, 0, 0, 1.5), (21, 12, 100, -2.25)]);
        let weights = PatternWeights::from_bytes(&bytes).expect("should parse legacy v1");

        // v1は重み共有なし: クラス数はインスタンス数(22)と一致するはず。
        assert_eq!(weights.class_tables.len(), 22);
        assert_eq!(weights.class_info.representative_of_class.len(), 22);
        assert_eq!(weights.class_tables[0].stage_tables[0][0], 1.5);
        assert_eq!(weights.class_tables[21].stage_tables[12][100], -2.25);

        let board = Board::initial();
        // 初期局面(空きマス60、ステージ12)は非対称ではあるが、重みが
        // ほぼ0のためscoreはほぼ0になるはず(手動設定した重みは初期局面では
        // 発火しないセルへの設定なので影響しない)。少なくともpanicせず
        // 有限の値が返ることを確認する。
        assert!(weights.score(&board, Side::Black).is_finite());
    }
}

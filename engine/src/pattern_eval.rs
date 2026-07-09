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
//! # スケールについて
//!
//! [`PatternWeights::score`]は「mover視点の最終石差の予測値」(素の石差、
//! 1石=1単位)を返す。`engine/src/eval.rs`のcenti-disc規約(1石=100)に揃える
//! 変換は呼び出し側([`crate::search`])の責務とする(本モジュールは学習時の
//! ラベル単位である素の石差をそのまま返す方が`train`クレートとの対応が明確に
//! なるため)。

use crate::bitboard::{Board, Side};
use crate::patterns::{self, PatternCells, PatternClassInfo};

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
pub struct PatternWeightTable {
    /// このパターンの状態数(3^パターン長)。
    pub num_states: u32,
    /// `stage_tables[stage][state_index]`が重み。
    pub stage_tables: Vec<Vec<f32>>,
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
}

impl PatternWeights {
    /// パターン定義から、対称オービットのクラス分類([`patterns::compute_pattern_classes`])
    /// を行い、全クラスの重みを0初期化したモデルを作る
    /// (`train::regression::Model::new`が学習開始時に使う)。
    pub fn zeroed(patterns: Vec<PatternCells>) -> Self {
        let class_info = patterns::compute_pattern_classes(&patterns);
        let class_tables = class_info
            .representative_of_class
            .iter()
            .map(|&rep_idx| {
                let num_states = patterns::num_states(patterns[rep_idx].len());
                PatternWeightTable {
                    num_states,
                    stage_tables: vec![vec![0f32; num_states as usize]; NUM_STAGES],
                }
            })
            .collect();
        PatternWeights {
            patterns,
            class_info,
            class_tables,
        }
    }

    /// 局面(`board`・`mover`)の予測値(mover視点の最終石差の予測、素の石差
    /// 単位)を返す。各インスタンスについて、代表インスタンスのセル順序に
    /// 揃えた実セル列(`class_info.aligned_cells`)で状態インデックスを計算し、
    /// そのインスタンスが属するクラスの重みテーブルを引いて合計する。
    pub fn score(&self, board: &Board, mover: Side) -> f32 {
        let stage = stage_for_empty_count(board.empty_count());
        let mut sum = 0f32;
        for i in 0..self.patterns.len() {
            let class_id = self.class_info.class_of[i];
            let cells = &self.class_info.aligned_cells[i];
            let state = patterns::pattern_state_index(cells, board, mover);
            sum += self.class_tables[class_id].stage_tables[stage][state as usize];
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
        let mut buf = Vec::new();
        buf.extend_from_slice(b"PWV2");
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&(self.patterns.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.class_info.representative_of_class.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(NUM_STAGES as u32).to_le_bytes());

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
            b"PWV2" => Self::from_bytes_v2(bytes),
            b"PWV1" => Self::from_bytes_v1(bytes),
            magic => Err(format!("不正なマジックバイト: {magic:?}")),
        }
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_for_empty_count_buckets_correctly() {
        assert_eq!(stage_for_empty_count(0), 0);
        assert_eq!(stage_for_empty_count(4), 0);
        assert_eq!(stage_for_empty_count(5), 1);
        assert_eq!(stage_for_empty_count(60), 12);
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
        assert_eq!(restored.class_tables[last_class].stage_tables[12][100], -2.25);

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
                        .find(|&&(p, s, st, _)| p == pattern_id && s == stage && st == state as usize)
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

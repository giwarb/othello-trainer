//! WTHOR学習済みパターン評価の重み(`train/weights/pattern_v1.bin`)を読み込み、
//! 局面をスコアリングするための読み取り専用構造体。
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
//! # スケールについて
//!
//! [`PatternWeights::score`]は「mover視点の最終石差の予測値」(素の石差、
//! 1石=1単位)を返す。`engine/src/eval.rs`のcenti-disc規約(1石=100)に揃える
//! 変換は呼び出し側([`crate::search`])の責務とする(本モジュールは学習時の
//! ラベル単位である素の石差をそのまま返す方が`train`クレートとの対応が明確に
//! なるため)。

use crate::bitboard::{Board, Side};
use crate::patterns::{self, PatternCells};

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

/// パターン形状の定義(`patterns`)と、それに対応する重み一式
/// (`tables`、`tables[i]`が`patterns[i]`の重み)を持つ、読み取り専用の
/// パターン評価モデル。学習(勾配更新)ロジックは持たない
/// (`train::regression::Model`が本構造体をラップして学習専用ロジックを追加する)。
#[derive(Debug, Clone)]
pub struct PatternWeights {
    pub patterns: Vec<PatternCells>,
    pub tables: Vec<PatternWeightTable>,
}

impl PatternWeights {
    /// パターン定義から、全重みを0初期化したモデルを作る
    /// (`train::regression::Model::new`が学習開始時に使う)。
    pub fn zeroed(patterns: Vec<PatternCells>) -> Self {
        let tables = patterns
            .iter()
            .map(|cells| {
                let num_states = patterns::num_states(cells.len());
                PatternWeightTable {
                    num_states,
                    stage_tables: vec![vec![0f32; num_states as usize]; NUM_STAGES],
                }
            })
            .collect();
        PatternWeights { patterns, tables }
    }

    /// 局面(`board`・`mover`)の予測値(mover視点の最終石差の予測、素の石差
    /// 単位)を返す。
    pub fn score(&self, board: &Board, mover: Side) -> f32 {
        let stage = stage_for_empty_count(board.empty_count());
        let mut sum = 0f32;
        for (pattern_id, cells) in self.patterns.iter().enumerate() {
            let state = patterns::pattern_state_index(cells, board, mover);
            sum += self.tables[pattern_id].stage_tables[stage][state as usize];
        }
        sum
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
            let table = &self.tables[pattern_id];
            for stage_table in &table.stage_tables {
                for &w in stage_table {
                    buf.extend_from_slice(&w.to_le_bytes());
                }
            }
        }

        buf
    }

    /// [`to_bytes`](Self::to_bytes)の逆変換。パターン形状定義は保存せず、
    /// 読み込み時に[`crate::patterns::generate_patterns`]を再生成して
    /// 突き合わせる(セル数の一致を検証する)。
    pub fn from_bytes(bytes: &[u8]) -> Result<PatternWeights, String> {
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

        let mut tables = Vec::with_capacity(pattern_defs.len());
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
            tables.push(PatternWeightTable {
                num_states,
                stage_tables,
            });
        }

        Ok(PatternWeights {
            patterns: pattern_defs,
            tables,
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
    fn to_bytes_and_from_bytes_roundtrip_preserves_weights() {
        let patterns = patterns::generate_patterns();
        let mut weights = PatternWeights::zeroed(patterns);
        // 非ゼロの重みを手動でいくつか設定し、往復で保持されることを確認する。
        weights.tables[0].stage_tables[0][0] = 1.5;
        weights.tables[21].stage_tables[12][100] = -2.25;

        let bytes = weights.to_bytes();
        let restored = PatternWeights::from_bytes(&bytes).expect("should parse");

        assert_eq!(restored.tables[0].stage_tables[0][0], 1.5);
        assert_eq!(restored.tables[21].stage_tables[12][100], -2.25);

        let board = Board::initial();
        assert_eq!(
            weights.score(&board, Side::Black),
            restored.score(&board, Side::Black)
        );
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
}

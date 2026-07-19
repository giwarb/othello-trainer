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
        }
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
        let mut buf = Vec::new();
        buf.extend_from_slice(b"PWV3");
        buf.extend_from_slice(&3u32.to_le_bytes());
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
            b"PWV3" => Self::from_bytes_v3(bytes),
            b"PWV2" => Self::from_bytes_v2(bytes),
            b"PWV1" => Self::from_bytes_v1(bytes),
            magic => Err(format!("不正なマジックバイト: {magic:?}")),
        }
    }

    fn from_bytes_v3(bytes: &[u8]) -> Result<PatternWeights, String> {
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
        if version != 3 {
            return Err(format!("未対応のv3バージョン: {version}"));
        }
        let _flags = read_u32(&mut pos)?;
        let num_stages = read_u32(&mut pos)?;
        let stage_divisor = read_u32(&mut pos)?;
        if !is_supported_stage_definition(num_stages as usize, stage_divisor) {
            return Err("PWV3のステージ定義が一致しません".to_string());
        }
        let num_instances = read_u32(&mut pos)? as usize;
        let num_classes = read_u32(&mut pos)? as usize;
        const MAX_PWV3_INSTANCES: usize = 256;
        const MAX_PWV3_CLASSES: usize = 64;
        if num_instances == 0
            || num_classes == 0
            || num_classes > num_instances
            || num_instances > MAX_PWV3_INSTANCES
            || num_classes > MAX_PWV3_CLASSES
        {
            return Err("PWV3のinstance/class数が不正です".to_string());
        }
        let stored_hash: [u8; 32] = read_bytes(&mut pos, 32)?.try_into().unwrap();
        let minimum_remaining = num_instances
            .checked_mul(4)
            .and_then(|n| num_classes.checked_mul(161).and_then(|c| n.checked_add(c)))
            .ok_or_else(|| "PWV3の個数から必要byte数がオーバーフローしました".to_string())?;
        if bytes.len() - pos < minimum_remaining {
            return Err("PWV3のinstance/class数と残りbyte数が整合しません".to_string());
        }

        let mut pattern_defs = Vec::with_capacity(num_instances);
        let mut stored_class_of = Vec::with_capacity(num_instances);
        for _ in 0..num_instances {
            let cell_count = read_bytes(&mut pos, 1)?[0] as usize;
            if cell_count == 0 || cell_count > 10 {
                return Err(format!("PWV3のcell_countが不正です: {cell_count}"));
            }
            let class_id =
                u16::from_le_bytes(read_bytes(&mut pos, 2)?.try_into().unwrap()) as usize;
            if class_id >= num_classes {
                return Err(format!("PWV3のclass_idが範囲外です: {class_id}"));
            }
            let raw_cells = read_bytes(&mut pos, cell_count)?;
            let mut seen = [false; 64];
            let mut cells = PatternCells::new();
            for &cell in raw_cells {
                if cell >= 64 {
                    return Err(format!("PWV3のcellが範囲外です: {cell}"));
                }
                if seen[cell as usize] {
                    return Err(format!("PWV3のinstance内に重複cellがあります: {cell}"));
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
            return Err("PWV3のschema hashが一致しません".to_string());
        }
        let class_info = patterns::compute_pattern_classes(&pattern_defs);
        if class_info.representative_of_class.len() != num_classes
            || class_info.class_of != stored_class_of
        {
            return Err("PWV3のD4クラス分類とclass_idが一致しません".to_string());
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
                    "PWV3の同一class内cell_countが一致しません: class={class_id}"
                ));
            }
            let num_states = read_u32(&mut pos)?;
            if num_states != patterns::num_states(cell_count) {
                return Err(format!(
                    "PWV3のnum_statesが3^cell_countと一致しません: class={class_id}"
                ));
            }
            let mut stage_tables = Vec::with_capacity(num_stages as usize);
            for _ in 0..num_stages {
                let mut table = Vec::with_capacity(num_states as usize);
                for _ in 0..num_states {
                    let weight = f32::from_le_bytes(read_bytes(&mut pos, 4)?.try_into().unwrap());
                    if !weight.is_finite() {
                        return Err("PWV3にfiniteでない重みがあります".to_string());
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
            return Err("PWV3に余剰bytesがあります".to_string());
        }

        Ok(PatternWeights {
            patterns: pattern_defs,
            class_info,
            class_tables,
            num_stages: num_stages as usize,
            stage_empty_divisor: stage_divisor,
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
        // 「D4 canonical化」相当の実装大な変更が必要になる。加えて現状
        // `PatternWeights`は対局・解析のどちらの経路でも実運用では未使用
        // (軽量ヒューリスティック評価のまま、CLAUDE.md参照)であり、直ちに
        // ユーザーへの実害はない)。そのため本テストは、実際にT139が解決すべき
        // 実用シナリオ(初期局面は本質的にD4対称)に対応する範囲で不変性を
        // 検証する。任意局面での不変性はオーケストレーターの判断でフォロー
        // アップタスク化する(作業ログ・完了レポート参照)。
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

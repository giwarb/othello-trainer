//! 盤面パターン特徴量の定義と、局面からの状態インデックス抽出。
//!
//! # パターン形状(v1、22パターン)
//!
//! - 行パターン8個(各8セル): `rank0`を0..8で固定し、`file0`を0..8で動かす。
//! - 列パターン8個(各8セル): `file0`を0..8で固定し、`rank0`を0..8で動かす。
//! - 主対角線1個(8セル、a1-h8方向): `file0 == rank0`。
//! - 反対角線1個(8セル、a8-h1方向): `file0 + rank0 == 7`。
//! - 隅3x3ブロック4個(各9セル): 4隅それぞれを含む3x3領域。
//!
//! 過去のタスク(定石データ収集T016)で「記憶に頼った手作業転記がデータ誤りを生んだ」
//! 事故があったため、これらのセル座標は個別のセル番号を手で列挙するのではなく、
//! すべて`rank0`/`file0`のループ演算で機械的に導出する
//! ([`generate_patterns`]を参照。手書きのセル番号リストは含まない)。
//!
//! # 状態エンコーディング
//!
//! 各パターンの状態は、パターンに含まれる各セルを「着目手番(mover)」視点で
//! 0=空・1=自石・2=相手石の3値に写し、パターン内での並び順を3進数の桁として
//! エンコードした整数(`0 .. 3^パターン長`)で表す
//! (8セルパターンなら3^8=6561状態、9セルパターンなら3^9=19683状態)。
//!
//! # T044: 対称変換による重み共有(v2)
//!
//! v1(本ファイル上部の[`generate_patterns`])では22インスタンスそれぞれが独立した
//! 重みテーブルを持っていたが、学習データに現れなかった局面パターンで重みが
//! ゼロのまま残る(汎化性能不足)ことがT043の自己対戦検証で判明した。
//! オセロ盤は8種類の対称変換(恒等・90/180/270度回転・上下反転・左右反転・
//! 転置・反転転置、二面体群D4)で自分自身に写るため、この対称変換で互いに
//! 移り合うパターンインスタンス同士は同じ重みテーブルを共有できる。
//! 本モジュールはこの8対称変換([`apply_symmetry`])と、22インスタンスを
//! 対称のオービットでグループ化した「クラス」情報([`compute_pattern_classes`])
//! を提供する(クラス分類は手作業の決め打ちではなく、8対称変換を総当たりして
//! セル集合が一致するかどうかで機械的に導出する)。実際の重み共有・スコア計算は
//! `engine::pattern_eval::PatternWeights`が行う。
//!
//! # T043: `train`クレートからの移動
//!
//! 本モジュールは元々`train/src/patterns.rs`にあったが(T041)、T043で
//! `engine`クレートに評価用の重み読み込み(`engine::pattern_eval`)を実装する際、
//! パターン形状定義・特徴抽出ロジックが`train`/`engine`の2箇所に複製される
//! ドリフトリスクを避けるため、`engine`側に一本化した(T041のreviewer指摘に
//! よる設計変更)。`train`クレートは`engine::patterns`をそのまま`use`する。

use crate::bitboard::{Board, Side};
use std::ops::Deref;

/// 1パターンが参照する盤面セルのインデックス列(各要素は0..64、
/// `index = rank0*8 + file0`)。並び順がそのまま状態インデックスの桁順に対応する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternCells {
    cells: [u8; 10],
    len: u8,
}

impl PatternCells {
    pub fn new() -> Self {
        Self {
            cells: [0; 10],
            len: 0,
        }
    }
    pub fn with_capacity(capacity: usize) -> Self {
        assert!(capacity <= 10);
        Self::new()
    }
    pub fn push(&mut self, cell: u8) {
        assert!((self.len as usize) < self.cells.len());
        self.cells[self.len as usize] = cell;
        self.len += 1;
    }
}

impl Default for PatternCells {
    fn default() -> Self {
        Self::new()
    }
}
impl Deref for PatternCells {
    type Target = [u8];
    fn deref(&self) -> &Self::Target {
        &self.cells[..self.len as usize]
    }
}
impl FromIterator<u8> for PatternCells {
    fn from_iter<T: IntoIterator<Item = u8>>(iter: T) -> Self {
        let mut result = Self::new();
        for cell in iter {
            result.push(cell);
        }
        result
    }
}
impl<'a> IntoIterator for &'a PatternCells {
    type Item = &'a u8;
    type IntoIter = std::slice::Iter<'a, u8>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

/// T087で比較するパターン集合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternConfig {
    V2,
    V2Diag567,
    V2Edge2x,
    V3,
    V2Corner5x2,
    /// T168(Edax寄せ1/2、実験構成D1): V3(edge2x+対角5-6-7) + 隅2x5ブロック
    /// (`corner5x2_patterns`、T087で実装済みだが不採用のまま残っていたもの)。
    /// 計46インスタンス(38 + 8)。
    V3Corner5x2,
    /// T168(実験構成D2): `V3Corner5x2`に短対角4(`diag4_patterns`)を追加。
    /// 計50インスタンス(46 + 4)。定数項scalar特徴
    /// (`pattern_eval::ScalarFeatureKind::Constant`)と組み合わせて使う想定
    /// (定数項自体はパターン形状ではないため、このenumには含めない)。
    V3Corner5x2Diag4,
}

const POW3: [u32; 11] = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683, 59049];

/// v1で使う全22パターンのセルインデックスを機械的に生成して返す。
///
/// 生成順序(この順序が[`pattern_state_index`]等が返すパターンIDの並びであり、
/// 学習済み重みファイルのレイアウトにもそのまま対応する):
/// 行8個 → 列8個 → 主対角線1個 → 反対角線1個 → 隅3x3ブロック4個。
pub fn generate_patterns() -> Vec<PatternCells> {
    let mut patterns: Vec<PatternCells> = Vec::with_capacity(22);

    // 行パターン(8個): rank0を固定し、file0を0..8で動かす。
    for rank0 in 0u8..8 {
        let cells: PatternCells = (0u8..8).map(|file0| rank0 * 8 + file0).collect();
        patterns.push(cells);
    }

    // 列パターン(8個): file0を固定し、rank0を0..8で動かす。
    for file0 in 0u8..8 {
        let cells: PatternCells = (0u8..8).map(|rank0| rank0 * 8 + file0).collect();
        patterns.push(cells);
    }

    // 主対角線(1個、a1-h8方向): file0 == rank0 となる8セル。
    let main_diagonal: PatternCells = (0u8..8).map(|i| i * 8 + i).collect();
    patterns.push(main_diagonal);

    // 反対角線(1個、a8-h1方向): file0 + rank0 == 7 となる8セル。
    let anti_diagonal: PatternCells = (0u8..8).map(|i| i * 8 + (7 - i)).collect();
    patterns.push(anti_diagonal);

    // 隅3x3ブロック(4個): 4隅それぞれについて、rank0/file0の範囲を2重ループで
    // 走査して9セルを生成する。範囲そのもの(0..3 または 5..8)のみが隅ごとに
    // 異なり、セル番号を個別に書き出す処理は行わない。
    let corner_ranges: [(std::ops::Range<u8>, std::ops::Range<u8>); 4] = [
        (0..3, 0..3), // a1側
        (0..3, 5..8), // h1側
        (5..8, 0..3), // a8側
        (5..8, 5..8), // h8側
    ];
    for (rank_range, file_range) in corner_ranges {
        let mut cells = PatternCells::with_capacity(9);
        for rank0 in rank_range.clone() {
            for file0 in file_range.clone() {
                cells.push(rank0 * 8 + file0);
            }
        }
        patterns.push(cells);
    }

    patterns
}

/// パターン長(セル数)に対応する状態数(3^パターン長)を返す。
pub fn num_states(pattern_len: usize) -> u32 {
    POW3[pattern_len]
}

fn symmetry_orbit(base: &PatternCells) -> Vec<PatternCells> {
    use std::collections::HashSet;
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut orbit = Vec::new();
    for sym in 0..NUM_SYMMETRIES {
        let mapped: PatternCells = base.iter().map(|&cell| apply_symmetry(sym, cell)).collect();
        let mut key = mapped.to_vec();
        key.sort_unstable();
        if seen.insert(key) {
            orbit.push(mapped);
        }
    }
    orbit
}

fn edge2x_patterns() -> Vec<PatternCells> {
    let mut base: PatternCells = (0u8..8).collect();
    base.push(1 * 8 + 1);
    base.push(1 * 8 + 6);
    let orbit = symmetry_orbit(&base);
    assert_eq!(orbit.len(), 4);
    assert!(orbit.iter().all(|cells| cells.len() == 10));
    orbit
}

fn diagonal_offset_patterns() -> Vec<PatternCells> {
    let mut result = Vec::with_capacity(12);
    for len in [5u8, 6, 7] {
        let offset = 8 - len;
        let base: PatternCells = (0..len).map(|i| i * 8 + i + offset).collect();
        let orbit = symmetry_orbit(&base);
        assert_eq!(orbit.len(), 4);
        assert!(orbit.iter().all(|cells| cells.len() == len as usize));
        result.extend(orbit);
    }
    assert_eq!(result.len(), 12);
    result
}

fn corner5x2_patterns() -> Vec<PatternCells> {
    let base: PatternCells = (0u8..2)
        .flat_map(|rank| (0u8..5).map(move |file| rank * 8 + file))
        .collect();
    let orbit = symmetry_orbit(&base);
    assert_eq!(orbit.len(), 8);
    assert!(orbit.iter().all(|cells| cells.len() == 10));
    orbit
}

/// T168(実験構成D2向け): 短対角4(長さ4の対角線)を`diagonal_offset_patterns`と
/// 同じ方法(symmetry_orbitベース、手書きセル列を使わない)で生成する。
/// `diagonal_offset_patterns`が長さ5-6-7を扱うのに対し、こちらは長さ4のみを
/// 単独で扱う(Edaxの47feature構成との差分埋め、explorer調査2026-07-21で
/// 未実装と特定された形状)。
fn diag4_patterns() -> Vec<PatternCells> {
    let len = 4u8;
    let offset = 8 - len;
    let base: PatternCells = (0..len).map(|i| i * 8 + i + offset).collect();
    let orbit = symmetry_orbit(&base);
    assert_eq!(orbit.len(), 4);
    assert!(orbit.iter().all(|cells| cells.len() == len as usize));
    orbit
}

/// v2を基礎に、T087のablation構成・T168のEdax寄せ実験構成を機械生成する。
pub fn generate_patterns_for(config: PatternConfig) -> Vec<PatternCells> {
    let mut result = generate_patterns();
    if matches!(
        config,
        PatternConfig::V2Edge2x | PatternConfig::V3 | PatternConfig::V3Corner5x2 | PatternConfig::V3Corner5x2Diag4
    ) {
        result.extend(edge2x_patterns());
    }
    if matches!(
        config,
        PatternConfig::V2Diag567 | PatternConfig::V3 | PatternConfig::V3Corner5x2 | PatternConfig::V3Corner5x2Diag4
    ) {
        result.extend(diagonal_offset_patterns());
    }
    if matches!(
        config,
        PatternConfig::V2Corner5x2 | PatternConfig::V3Corner5x2 | PatternConfig::V3Corner5x2Diag4
    ) {
        result.extend(corner5x2_patterns());
    }
    if config == PatternConfig::V3Corner5x2Diag4 {
        result.extend(diag4_patterns());
    }
    result
}

/// 盤面の1マス(`index`)の状態を、(自分の石, 相手の石)のビットボードから見た
/// 3値(0=空, 1=自石, 2=相手石)で返す。`own`/`opp`は呼び出し元が`mover`から
/// 一度だけ導出して渡す(T176: 元は`(board, mover)`を受け取りここで毎回
/// `match mover`していたが、[`pattern_state_index`]がセルごとに呼び出す
/// ホットパスであるため、`mover`に応じた`(own, opp)`の選択を呼び出し元で
/// 1回だけ行うよう分離した。出力はビット単位で不変
/// 〔`bench/edax-compare/t176_score_optimization_smoke.md`参照〕)。
fn cell_trit(own: u64, opp: u64, index: u8) -> u32 {
    let bit = 1u64 << index;
    if own & bit != 0 {
        1
    } else if opp & bit != 0 {
        2
    } else {
        0
    }
}

/// 指定したパターン(`cells`)について、`board`・`mover`から見た状態インデックス
/// (3進数エンコード、`0 .. num_states(cells.len())`)を計算する。
///
/// T176: `(own, opp)`を`mover`から一度だけ導出し、セルごとのループでは
/// 使い回す(以前はセルごとに`match mover`し直していた。D1〔46インスタンス〕
/// では1回の`score()`呼び出しあたり平均セル数×46回の`match`が
/// 46回の`match`に減る。出力はビット単位で不変)。
pub fn pattern_state_index(cells: &[u8], board: &Board, mover: Side) -> u32 {
    let (own, opp) = match mover {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };
    let mut index = 0u32;
    for (position, &cell) in cells.iter().enumerate() {
        let trit = cell_trit(own, opp, cell);
        index += trit * POW3[position];
    }
    index
}

/// 局面(`board`・`mover`)から、全パターンのアクティブな
/// (パターンID, 状態インデックス)の組を抽出する。パターンIDは
/// `patterns`(通常は[`generate_patterns`]の戻り値)内でのインデックスと一致する。
pub fn extract_features(
    patterns: &[PatternCells],
    board: &Board,
    mover: Side,
) -> Vec<(usize, u32)> {
    patterns
        .iter()
        .enumerate()
        .map(|(pattern_id, cells)| (pattern_id, pattern_state_index(cells, board, mover)))
        .collect()
}

// ---------------------------------------------------------------------------
// T044: 対称変換(二面体群D4)による重み共有
// ---------------------------------------------------------------------------

/// 盤面を自分自身に写す対称変換の総数(二面体群D4の位数)。
pub const NUM_SYMMETRIES: usize = 8;

/// セルインデックス(0..64)を(rank0, file0)に分解する。
fn rank_file(cell: u8) -> (u8, u8) {
    (cell / 8, cell % 8)
}

/// (rank0, file0)からセルインデックス(0..64)を組み立てる。
fn cell_of(rank: u8, file: u8) -> u8 {
    rank * 8 + file
}

/// 対称変換`sym`(0..[`NUM_SYMMETRIES`])を(rank0, file0)座標に適用する。
///
/// 8要素は二面体群D4(正方形の対称群)そのもの: 恒等・90/180/270度回転・
/// 上下反転・左右反転・転置(主対角線に関する反転)・反転転置(反対角線に
/// 関する反転)。これらは合成について閉じており(D4は群)、恒等変換を含む。
fn symmetry_coords(sym: usize, rank: u8, file: u8) -> (u8, u8) {
    match sym {
        0 => (rank, file),         // 恒等
        1 => (file, 7 - rank),     // 90度回転
        2 => (7 - rank, 7 - file), // 180度回転
        3 => (7 - file, rank),     // 270度回転
        4 => (rank, 7 - file),     // 左右反転(列を反転)
        5 => (7 - rank, file),     // 上下反転(行を反転)
        6 => (file, rank),         // 転置(主対角線 a1-h8 に関する反転)
        7 => (7 - file, 7 - rank), // 反転転置(反対角線 a8-h1 に関する反転)
        _ => unreachable!("symmetry index out of range: {sym}"),
    }
}

/// 対称変換`sym`を1セル(0..64)に適用し、写った先のセル(0..64)を返す。
pub fn apply_symmetry(sym: usize, cell: u8) -> u8 {
    let (rank, file) = rank_file(cell);
    let (rank2, file2) = symmetry_coords(sym, rank, file);
    cell_of(rank2, file2)
}

/// 対称変換`sym`の逆変換のインデックスを返す(`apply_symmetry(inverse, apply_symmetry(sym, c)) == c`
/// が全セルで成り立つもの)。D4は8要素の小さな群なので総当たりで十分。
pub fn inverse_symmetry(sym: usize) -> usize {
    for candidate in 0..NUM_SYMMETRIES {
        if (0u8..64).all(|c| apply_symmetry(candidate, apply_symmetry(sym, c)) == c) {
            return candidate;
        }
    }
    unreachable!("D4 should be closed under inverses (sym={sym})")
}

/// `board`の全セルの石を、対称変換`sym`で写した先のセルへ移した新しい盤面を返す。
/// (`transformed[apply_symmetry(sym, c)] = board[c]` が全セル`c`で成り立つ。)
///
/// T044の要件2(クロスチェックテスト)で、「盤面全体を対称変換してから代表
/// インスタンスのセルをそのまま抽出する」方法の実装に使う(テスト専用)。
#[cfg(test)]
fn transform_board(board: &Board, sym: usize) -> Board {
    let mut black = 0u64;
    let mut white = 0u64;
    for c in 0u8..64 {
        let bit = 1u64 << c;
        let dest = apply_symmetry(sym, c);
        if board.black & bit != 0 {
            black |= 1u64 << dest;
        }
        if board.white & bit != 0 {
            white |= 1u64 << dest;
        }
    }
    Board { black, white }
}

/// パターンインスタンスを対称のオービット(クラス)でグループ化した結果。
///
/// 各`Vec`は`generate_patterns()`が返すパターン列と同じ並び順・長さ(22個)を持つ
/// (`class_of`のみクラス数、`representative_of_class`はクラスの数だけの長さ)。
#[derive(Debug, Clone)]
pub struct PatternClassInfo {
    /// `class_of[i]`: パターンインスタンス`i`が属するクラスID(0..クラス数)。
    pub class_of: Vec<usize>,
    /// `representative_of_class[class_id]`: そのクラスの代表インスタンスの
    /// インデックス(`generate_patterns()`内でのインデックス)。
    pub representative_of_class: Vec<usize>,
    /// `symmetry_of[i]`: 代表インスタンスの自然順セルにこの対称変換
    /// ([`apply_symmetry`]のインデックス)を適用すると、インスタンス`i`の
    /// セル集合に一致するという対応関係。代表インスタンス自身は恒等変換(0)。
    pub symmetry_of: Vec<usize>,
    /// `aligned_cells[i]`: インスタンス`i`について、状態インデックス計算に
    /// 実際に使うセル列。代表インスタンスの自然順セルに`symmetry_of[i]`を
    /// 適用したもの(代表インスタンス自身は`generate_patterns()`の自然順
    /// セルと同じ)。これを使うことで、クラス内の全インスタンスが
    /// 「代表インスタンスと同じセル順序」で状態を符号化でき、同じ重み
    /// テーブルを正しく共有できる。
    pub aligned_cells: Vec<PatternCells>,
}

/// `patterns`(通常は[`generate_patterns`]の戻り値)を、8対称変換で互いに
/// 移り合うインスタンス同士でグループ化する。
///
/// アルゴリズム: 各インスタンス`i`について、まだどのクラスにも属していなければ
/// `i`を新しいクラスの代表とする。他の未割当インスタンス`j`について、8対称変換
/// それぞれを代表`i`の自然順セルに適用し、写った先のセル集合が`j`のセル集合と
/// 一致するものを探す(手作業のクラス分類・パーミュテーション決め打ちを避け、
/// 幾何学的な対称変換から機械的に導出するため)。一致する変換が見つかれば
/// `j`を同じクラスに割り当てる。
pub fn compute_pattern_classes(patterns: &[PatternCells]) -> PatternClassInfo {
    use std::collections::HashSet;

    let n = patterns.len();
    let mut class_of = vec![usize::MAX; n];
    let mut representative_of_class: Vec<usize> = Vec::new();
    let mut symmetry_of = vec![0usize; n];
    let mut aligned_cells: Vec<PatternCells> = vec![PatternCells::new(); n];

    let cell_set = |cells: &PatternCells| -> HashSet<u8> { cells.iter().copied().collect() };

    for i in 0..n {
        if class_of[i] != usize::MAX {
            continue;
        }
        let class_id = representative_of_class.len();
        representative_of_class.push(i);
        class_of[i] = class_id;
        symmetry_of[i] = 0; // 恒等変換
        aligned_cells[i] = patterns[i].clone();

        let rep_cells = &patterns[i];

        for j in (i + 1)..n {
            if class_of[j] != usize::MAX || patterns[j].len() != rep_cells.len() {
                continue;
            }
            let target_set = cell_set(&patterns[j]);
            for sym in 0..NUM_SYMMETRIES {
                let mapped: PatternCells =
                    rep_cells.iter().map(|&c| apply_symmetry(sym, c)).collect();
                let mapped_set: HashSet<u8> = mapped.iter().copied().collect();
                if mapped_set == target_set {
                    class_of[j] = class_id;
                    symmetry_of[j] = sym;
                    aligned_cells[j] = mapped;
                    break;
                }
            }
        }
    }

    PatternClassInfo {
        class_of,
        representative_of_class,
        symmetry_of,
        aligned_cells,
    }
}

// ---------------------------------------------------------------------------
// T163: D4 canonical化(状態インデックスの正準化)
// ---------------------------------------------------------------------------
//
// [`compute_pattern_classes`]は各パターンインスタンスの状態計算に使うセル順序
// (`aligned_cells`)を「8対称変換を0..7の順で走査し、セル**集合**が最初に一致した
// もの」で決めるが、現行の全パターン形状(行・列・対角線・隅3x3等)は自明でない
// 安定化群を持つ(そのパターン自身のセル集合を保つ変換が恒等以外にも存在する)ため、
// この「先着順」の選択は全域のD4対称変換と一貫しない。結果として、回転・鏡映で
// 互いに写り合う局面同士で`PatternWeights::score`の値がズレる
// (T044由来、T145実測、`tasks/T163-d4-canonicalization.md`参照)。
//
// 本節の関数群は、`aligned_cells`の選択自体は変えずに済ませる形でこれを解消する:
// 各クラスの代表パターンの安定化群(そのセル集合を保つ変換の集合)が状態
// インデックスの桁に誘導する置換を求め([`stabilizer_position_permutations`])、
// 状態インデックスをその軌道の最小値に正規化する
// ([`build_canonical_index_table`]、canonical index)。この正規化を状態計算の
// 「後」に挟むことで、`aligned_cells`の選択が(安定化群の要素の分だけ)恣意的で
// あっても、正規化後の値は常に一意に定まる(この事実の証明はタスクファイル
// `tasks/T163-d4-canonicalization.md`の根本原因節・完了レポート参照)。
//
// レガシースキーム(PWV1〜PWV4)はこの正規化を適用しない
// (`engine::pattern_eval::PatternWeights::table_index`参照)ため、評価値は
// ビット単位で不変のまま(D4バグは残る)。新スキーム(PWV5)でのみ有効にする。

/// `cells`(パターンの自然順セル列、通常は代表インスタンスの`generate_patterns()`
/// 順セル)の安定化群(そのセル**集合**を保つD4変換の集合)が、状態インデックスの
/// 桁(位置)に誘導する置換の一覧を返す。恒等置換(何もしない置換、`sym=0`由来)を
/// 必ず1つ含む。
pub fn stabilizer_position_permutations(cells: &[u8]) -> Vec<Vec<u8>> {
    use std::collections::HashSet;
    let target_set: HashSet<u8> = cells.iter().copied().collect();
    let mut perms = Vec::new();
    for sym in 0..NUM_SYMMETRIES {
        let mapped: Vec<u8> = cells.iter().map(|&c| apply_symmetry(sym, c)).collect();
        let mapped_set: HashSet<u8> = mapped.iter().copied().collect();
        if mapped_set != target_set {
            continue;
        }
        // 位置置換sigma: 位置pの桁を位置sigma[p]へ移す
        // (`apply_symmetry(sym, cells[p]) == cells[sigma[p]]`となる`sigma[p]`)。
        let sigma: Vec<u8> = mapped
            .iter()
            .map(|&mapped_cell| {
                cells
                    .iter()
                    .position(|&c| c == mapped_cell)
                    .expect("mapped_set == target_set implies mapped_cell is in cells") as u8
            })
            .collect();
        perms.push(sigma);
    }
    perms
}

/// 状態インデックス`state`(`cells.len()`桁の3進数エンコード、[`pattern_state_index`]
/// と同じ桁割当: 位置pの重みは3^p)に、位置置換`sigma`
/// ([`stabilizer_position_permutations`]が返すもの、`sigma[p]`は「位置pの桁の
/// 移動先」)を適用した状態を返す。
fn permute_state_digits(state: u32, sigma: &[u8]) -> u32 {
    let mut result = 0u32;
    for (position, &dest) in sigma.iter().enumerate() {
        let digit = (state / POW3[position]) % 3;
        result += digit * POW3[dest as usize];
    }
    result
}

/// `cells`が定義するパターン(セル数`cells.len()`)の全状態(`0 .. num_states(cells.len())`)
/// について、安定化群の軌道の最小値(canonical index)を求めたテーブルを返す。
///
/// `table[state]`が`state`のcanonical indexであり、同じ軌道に属す状態はすべて
/// 同じcanonical indexに写る(証明・不変性の帰結は本節冒頭のコメント参照)。
/// パターン形状のみから決まる(盤面に依存しない)ため、構築時に一度だけ計算して
/// おけば、評価時は表引き1回で済む(T163設計方針3、実行時コスト最小化)。
pub fn build_canonical_index_table(cells: &[u8]) -> Vec<u32> {
    let perms = stabilizer_position_permutations(cells);
    let total_states = num_states(cells.len());
    (0..total_states)
        .map(|state| {
            perms
                .iter()
                .map(|sigma| permute_state_digits(state, sigma))
                .min()
                .unwrap_or(state)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t087_ablation_pattern_counts_and_classes_are_exact() {
        let cases = [
            (PatternConfig::V2, 22, 6),
            (PatternConfig::V2Diag567, 34, 9),
            (PatternConfig::V2Edge2x, 26, 7),
            (PatternConfig::V3, 38, 10),
            (PatternConfig::V2Corner5x2, 30, 7),
            // T168実験構成D1/D2(パターン形状のみ、定数項scalarはpattern_eval側)。
            (PatternConfig::V3Corner5x2, 46, 11),
            (PatternConfig::V3Corner5x2Diag4, 50, 12),
        ];
        for (config, instances, classes) in cases {
            let generated = generate_patterns_for(config);
            assert_eq!(generated.len(), instances, "{config:?}");
            assert_eq!(
                compute_pattern_classes(&generated)
                    .representative_of_class
                    .len(),
                classes,
                "{config:?}"
            );
        }
    }

    #[test]
    fn t087_generated_additions_have_required_shapes() {
        let edge = generate_patterns_for(PatternConfig::V2Edge2x);
        assert_eq!(edge[22..].len(), 4);
        assert!(edge[22..].iter().all(|cells| cells.len() == 10));

        let diag = generate_patterns_for(PatternConfig::V2Diag567);
        assert_eq!(
            diag[22..]
                .iter()
                .map(|cells| cells.len())
                .collect::<Vec<_>>(),
            vec![5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7]
        );

        let corner = generate_patterns_for(PatternConfig::V2Corner5x2);
        assert_eq!(corner[22..].len(), 8);
        assert!(corner[22..].iter().all(|cells| cells.len() == 10));
    }

    #[test]
    fn t168_d1_appends_corner5x2_after_v3() {
        // D1(V3Corner5x2) = V3(38インスタンス) + corner5x2(8インスタンス)。
        let d1 = generate_patterns_for(PatternConfig::V3Corner5x2);
        assert_eq!(d1.len(), 46);
        assert_eq!(&d1[..38], &generate_patterns_for(PatternConfig::V3)[..]);
        assert!(d1[38..].iter().all(|cells| cells.len() == 10));
    }

    #[test]
    fn t168_d2_appends_diag4_after_d1() {
        // D2(V3Corner5x2Diag4) = D1(46インスタンス) + diag4(4インスタンス、
        // 長さ4の短対角。symmetry_orbitベースで導出、手書きセル列は使わない)。
        let d1 = generate_patterns_for(PatternConfig::V3Corner5x2);
        let d2 = generate_patterns_for(PatternConfig::V3Corner5x2Diag4);
        assert_eq!(d2.len(), 50);
        assert_eq!(&d2[..46], &d1[..]);
        assert_eq!(d2[46..].len(), 4);
        assert!(d2[46..].iter().all(|cells| cells.len() == 4));
    }

    #[test]
    fn generates_exactly_22_patterns() {
        let patterns = generate_patterns();
        assert_eq!(patterns.len(), 22);
    }

    #[test]
    fn every_pattern_has_8_or_9_cells() {
        let patterns = generate_patterns();
        for (i, cells) in patterns.iter().enumerate() {
            assert!(
                cells.len() == 8 || cells.len() == 9,
                "pattern #{i} has unexpected length {}",
                cells.len()
            );
        }
    }

    #[test]
    fn row_and_column_and_diagonal_patterns_have_8_cells() {
        let patterns = generate_patterns();
        // 生成順序: 行8個(0..8) → 列8個(8..16) → 主対角線(16) → 反対角線(17) → 隅4個(18..22)。
        for i in 0..18 {
            assert_eq!(patterns[i].len(), 8, "pattern #{i} should have 8 cells");
        }
    }

    #[test]
    fn corner_patterns_have_9_cells() {
        let patterns = generate_patterns();
        for i in 18..22 {
            assert_eq!(patterns[i].len(), 9, "pattern #{i} should have 9 cells");
        }
    }

    #[test]
    fn no_pattern_contains_duplicate_cells() {
        let patterns = generate_patterns();
        for (i, cells) in patterns.iter().enumerate() {
            let mut sorted = cells.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(
                sorted.len(),
                cells.len(),
                "pattern #{i} contains duplicate cells: {:?}",
                cells
            );
        }
    }

    #[test]
    fn all_cell_indices_are_within_board_range() {
        let patterns = generate_patterns();
        for cells in &patterns {
            for &c in cells {
                assert!(c < 64, "cell index out of range: {c}");
            }
        }
    }

    #[test]
    fn corner_3x3_patterns_each_contain_their_own_corner_square() {
        let patterns = generate_patterns();
        // 隅パターンは生成順序で18..22番目。a1=0, h1=7, a8=56, h8=63。
        let corner_squares = [0u8, 7, 56, 63];
        for (offset, &corner) in corner_squares.iter().enumerate() {
            let cells = &patterns[18 + offset];
            assert!(
                cells.contains(&corner),
                "corner pattern #{} should contain corner square {corner}, got {:?}",
                18 + offset,
                cells
            );
        }
    }

    #[test]
    fn main_diagonal_is_a1_to_h8() {
        let patterns = generate_patterns();
        let main_diag = &patterns[16];
        assert_eq!(&main_diag[..], &[0u8, 9, 18, 27, 36, 45, 54, 63]);
    }

    #[test]
    fn anti_diagonal_is_a8_to_h1() {
        let patterns = generate_patterns();
        let anti_diag = &patterns[17];
        assert_eq!(&anti_diag[..], &[7u8, 14, 21, 28, 35, 42, 49, 56]);
    }

    #[test]
    fn num_states_matches_powers_of_three() {
        assert_eq!(num_states(8), 6561);
        assert_eq!(num_states(9), 19683);
    }

    #[test]
    fn pattern_state_index_of_empty_board_is_zero() {
        let board = Board { black: 0, white: 0 };
        let cells: PatternCells = (0u8..8).collect();
        assert_eq!(pattern_state_index(&cells, &board, Side::Black), 0);
    }

    #[test]
    fn pattern_state_index_encodes_own_and_opponent_stones_correctly() {
        // 3セルパターン: セル0=自石(黒), セル1=相手石(白), セル2=空。
        // mover=Black視点で 1*3^0 + 2*3^1 + 0*3^2 = 1 + 6 + 0 = 7。
        let board = Board {
            black: 1u64,      // セル0
            white: 1u64 << 1, // セル1
        };
        let cells: PatternCells = [0, 1, 2].into_iter().collect();
        assert_eq!(pattern_state_index(&cells, &board, Side::Black), 7);
        // mover=White視点なら 自石/相手石が入れ替わる:
        // 2*3^0 + 1*3^1 + 0*3^2 = 2 + 3 = 5。
        assert_eq!(pattern_state_index(&cells, &board, Side::White), 5);
    }

    #[test]
    fn extract_features_returns_one_entry_per_pattern() {
        let patterns = generate_patterns();
        let board = Board::initial();
        let features = extract_features(&patterns, &board, Side::Black);
        assert_eq!(features.len(), 22);
        for (i, (pattern_id, _state)) in features.iter().enumerate() {
            assert_eq!(*pattern_id, i);
        }
    }

    // -----------------------------------------------------------------
    // T044: 対称変換(D4)の基礎性質
    // -----------------------------------------------------------------

    #[test]
    fn every_symmetry_is_a_bijection_over_64_cells() {
        for sym in 0..NUM_SYMMETRIES {
            let mut mapped: Vec<u8> = (0u8..64).map(|c| apply_symmetry(sym, c)).collect();
            mapped.sort_unstable();
            let expected: Vec<u8> = (0u8..64).collect();
            assert_eq!(mapped, expected, "symmetry {sym} is not a bijection");
        }
    }

    #[test]
    fn symmetries_are_closed_under_composition_forming_a_group() {
        // 二面体群D4は合成について閉じている: どの2要素を合成しても、
        // 必ず8要素のどれかと(全セルで)一致するはず。
        for a in 0..NUM_SYMMETRIES {
            for b in 0..NUM_SYMMETRIES {
                let composed: Vec<u8> = (0u8..64)
                    .map(|c| apply_symmetry(a, apply_symmetry(b, c)))
                    .collect();
                let found = (0..NUM_SYMMETRIES)
                    .any(|x| (0u8..64).all(|c| apply_symmetry(x, c) == composed[c as usize]));
                assert!(found, "composition of symmetry {a} and {b} is not itself a symmetry (group not closed)");
            }
        }
    }

    #[test]
    fn applying_any_symmetry_eight_times_returns_to_identity() {
        // D4の各要素の位数は1・2・4のいずれかであり、いずれも8を割り切るため、
        // どの要素も8回合成すれば恒等変換に戻る。
        for sym in 0..NUM_SYMMETRIES {
            for c in 0u8..64 {
                let mut x = c;
                for _ in 0..8 {
                    x = apply_symmetry(sym, x);
                }
                assert_eq!(
                    x, c,
                    "symmetry {sym} applied 8 times should return to identity"
                );
            }
        }
    }

    #[test]
    fn inverse_symmetry_undoes_the_original_transform() {
        for sym in 0..NUM_SYMMETRIES {
            let inv = inverse_symmetry(sym);
            for c in 0u8..64 {
                assert_eq!(apply_symmetry(inv, apply_symmetry(sym, c)), c);
                assert_eq!(apply_symmetry(sym, apply_symmetry(inv, c)), c);
            }
        }
    }

    // -----------------------------------------------------------------
    // T044: パターンインスタンスのクラス分類
    // -----------------------------------------------------------------

    #[test]
    fn compute_pattern_classes_groups_22_instances_into_6_orbit_classes() {
        let patterns = generate_patterns();
        let info = compute_pattern_classes(&patterns);
        assert_eq!(info.class_of.len(), 22);
        assert_eq!(
            info.representative_of_class.len(),
            6,
            "expected 6 symmetry-orbit classes (row/col x4 distances + diagonals + corners)"
        );

        // タスク仕様(T044)に記載の6クラスと一致することを確認する
        // (行8個・列8個・主対角線1個・反対角線1個・隅3x3ブロック4個、
        // 生成順序は`generate_patterns()`のドキュメント参照)。
        use std::collections::HashSet;
        let mut actual_classes: Vec<HashSet<usize>> = (0..info.representative_of_class.len())
            .map(|class_id| {
                (0..info.class_of.len())
                    .filter(|&i| info.class_of[i] == class_id)
                    .collect::<HashSet<usize>>()
            })
            .collect();
        actual_classes.sort_by_key(|s| *s.iter().min().unwrap());

        let expected_classes: Vec<HashSet<usize>> = vec![
            [0usize, 7, 8, 15].into_iter().collect(), // 距離0: row0,row7,col0,col7
            [1usize, 6, 9, 14].into_iter().collect(), // 距離1: row1,row6,col1,col6
            [2usize, 5, 10, 13].into_iter().collect(), // 距離2: row2,row5,col2,col5
            [3usize, 4, 11, 12].into_iter().collect(), // 距離3: row3,row4,col3,col4
            [16usize, 17].into_iter().collect(),      // 対角線: 主対角線・反対角線
            [18usize, 19, 20, 21].into_iter().collect(), // 隅3x3ブロック4個
        ];

        assert_eq!(actual_classes, expected_classes);
    }

    #[test]
    fn representative_instance_uses_identity_symmetry_and_its_own_natural_cells() {
        let patterns = generate_patterns();
        let info = compute_pattern_classes(&patterns);
        for &rep_idx in &info.representative_of_class {
            assert_eq!(info.symmetry_of[rep_idx], 0);
            assert_eq!(info.aligned_cells[rep_idx], patterns[rep_idx]);
        }
    }

    #[test]
    fn aligned_cells_are_a_reordering_of_the_instances_own_cell_set() {
        // aligned_cellsは実際の盤面セル(0..64)の集合としてはそのインスタンス
        // 自身のセルと一致しなければならない(順序だけが代表に揃えられる)。
        use std::collections::HashSet;
        let patterns = generate_patterns();
        let info = compute_pattern_classes(&patterns);
        for i in 0..patterns.len() {
            let own: HashSet<u8> = patterns[i].iter().copied().collect();
            let aligned: HashSet<u8> = info.aligned_cells[i].iter().copied().collect();
            assert_eq!(
                own, aligned,
                "instance {i}: aligned_cells must cover the same board cells"
            );
        }
    }

    // -----------------------------------------------------------------
    // T044要件2: 2通りの独立した計算方法のクロスチェック
    // -----------------------------------------------------------------

    /// テスト専用の決定的な疑似乱数生成器(xorshift64)。乱数の質より
    /// 再現性を優先する(`train/src/regression.rs`のテスト用RNGと同じ設計)。
    struct TestXorshift64 {
        state: u64,
    }

    impl TestXorshift64 {
        fn new(seed: u64) -> Self {
            TestXorshift64 { state: seed.max(1) }
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
    /// (合法性は問わない。状態インデックス計算はセルの3値だけを見るため十分)。
    fn random_board(rng: &mut TestXorshift64) -> Board {
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

    #[test]
    fn cross_check_instance_extraction_matches_whole_board_transform_method() {
        // T044要件2: 「(a) インスタンス固有のセル順序で直接抽出した状態を、
        // そのインスタンスのパーミュテーション(aligned_cells)で並べ替えて
        // 状態インデックスを計算する方法」と「(b) 盤面全体をそのインスタンス→
        // 代表インスタンスへの対称変換で変換してから、代表インスタンスの
        // セルをそのまま抽出して状態インデックスを計算する方法」が、
        // 全22インスタンス×多数のランダム局面で一致することを確認する
        // (このクロスチェックがパーミュテーションの正しさを担保する)。
        let patterns = generate_patterns();
        let info = compute_pattern_classes(&patterns);
        let mut rng = TestXorshift64::new(0xC0FFEE_1234_5678);

        const NUM_RANDOM_BOARDS: usize = 200;
        for _ in 0..NUM_RANDOM_BOARDS {
            let board = random_board(&mut rng);
            for mover in [Side::Black, Side::White] {
                for i in 0..patterns.len() {
                    let class_id = info.class_of[i];
                    let rep_idx = info.representative_of_class[class_id];
                    let sym = info.symmetry_of[i];

                    // 方法(a): インスタンス固有抽出+パーミュテーション
                    // (代表インスタンスの順序に揃えたaligned_cellsで直接抽出)。
                    let state_a = pattern_state_index(&info.aligned_cells[i], &board, mover);

                    // 方法(b): 盤面全体を「インスタンス→代表インスタンス」の
                    // 対称変換(sym の逆変換)で変換してから、代表インスタンスの
                    // 自然順セルをそのまま抽出する。
                    let inv = inverse_symmetry(sym);
                    let transformed = transform_board(&board, inv);
                    let state_b = pattern_state_index(&patterns[rep_idx], &transformed, mover);

                    assert_eq!(
                        state_a, state_b,
                        "instance {i} (class {class_id}, symmetry {sym}) mismatch for mover={mover:?}"
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // T163: D4 canonical化
    // -----------------------------------------------------------------

    #[test]
    fn stabilizer_position_permutations_always_includes_identity() {
        for cells in generate_patterns_for(PatternConfig::V3) {
            let perms = stabilizer_position_permutations(&cells);
            let identity: Vec<u8> = (0u8..cells.len() as u8).collect();
            assert!(
                perms.contains(&identity),
                "stabilizer permutations of {cells:?} should include the identity"
            );
        }
    }

    #[test]
    fn row_pattern_stabilizer_is_exactly_identity_and_reversal() {
        // 行パターン(自然順セルは連続する8マス、file0=0..8)の安定化群は
        // {恒等, 左右反転}の2要素のみ(row0=a1..h1が自身のセル集合へ写るのは
        // sym=0の恒等とsym=4の左右反転だけで、90/180/270度回転・上下反転・
        // 転置・反転転置はいずれも別の行/列/対角へ写す)。
        let patterns = generate_patterns();
        let row0 = &patterns[0];
        let mut actual = stabilizer_position_permutations(row0);
        let mut expected = vec![
            (0u8..8).collect::<Vec<u8>>(),
            (0u8..8).rev().collect::<Vec<u8>>(),
        ];
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn main_diagonal_stabilizer_has_four_elements() {
        // 主対角線(a1-h8)は恒等・180度回転・転置・反転転置の4変換で
        // 自身のセル集合に写る(軌道サイズ2=8/4、対角線クラスが
        // 主対角線・反対角線の2インスタンスだけであることと整合する)。
        let patterns = generate_patterns();
        let main_diagonal = &patterns[16];
        assert_eq!(stabilizer_position_permutations(main_diagonal).len(), 4);
    }

    #[test]
    fn corner_block_stabilizer_has_two_elements() {
        // 隅3x3ブロックは恒等とその隅自身の対角線に関する反転(転置)の
        // 2変換のみで自身のセル集合に写る(軌道サイズ4=8/2)。
        let patterns = generate_patterns();
        for i in 18..22 {
            assert_eq!(
                stabilizer_position_permutations(&patterns[i]).len(),
                2,
                "corner pattern #{i}"
            );
        }
    }

    #[test]
    fn canonical_index_of_row_state_matches_min_with_digit_reversal() {
        fn reverse_digits(mut x: u32, len: usize) -> u32 {
            let mut digits = [0u32; 10];
            for d in digits.iter_mut().take(len) {
                *d = x % 3;
                x /= 3;
            }
            let mut result = 0u32;
            for (i, &digit) in digits.iter().take(len).enumerate() {
                result += digit * POW3[len - 1 - i];
            }
            result
        }
        let patterns = generate_patterns();
        let row0 = &patterns[0];
        let table = build_canonical_index_table(row0);
        for state in [0u32, 1, 8, 42, 1000, 6560] {
            let expected = state.min(reverse_digits(state, 8));
            assert_eq!(table[state as usize], expected, "state={state}");
        }
    }

    #[test]
    fn canonical_index_table_is_deterministic_never_exceeds_raw_and_is_a_fixed_point() {
        for cells in generate_patterns_for(PatternConfig::V3) {
            let table_a = build_canonical_index_table(&cells);
            let table_b = build_canonical_index_table(&cells);
            assert_eq!(table_a, table_b, "canonical index table must be deterministic");
            for (state, &canon) in table_a.iter().enumerate() {
                assert!(
                    canon as usize <= state,
                    "canonical index ({canon}) should never exceed the raw state ({state})"
                );
                assert_eq!(
                    table_a[canon as usize], canon,
                    "canonical index must be a fixed point of canonicalization (state={state})"
                );
            }
        }
    }
}

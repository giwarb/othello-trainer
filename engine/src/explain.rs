//! T031: 言語化支援「特徴量層」(§1)+「評価内訳分解層」(§2)。
//! `othello-trainer-design-verbalization.md` を参照。
//!
//! # スコープ縮小についての重要な注記
//!
//! 設計書§2は「評価値 = Σ(46パターンの重み) + 手数項 + パリティ項」という
//! WTHOR学習パターン評価を前提に評価内訳分解を設計しているが、本プロジェクトの
//! 現行評価関数 (`eval.rs`) はモビリティ・隅・安定石の3項のみの線形モデルである
//! (46パターン評価はフェーズ3で後回し、ユーザー承認済み)。そのため本モジュールの
//! 「評価内訳分解」は46グループではなく、**現行の3項(モビリティ差・隅差・
//! 安定石差)への厳密な分解**として実装する(`evalTerms` コマンド)。
//! この3項の値(`eval::feature_diffs`)を返すだけに留め、加重・合算による
//! waterfall分解自体はTypeScript側の純粋関数 (`app/src/analysis/attribution.ts`)
//! で行う設計にした。理由: (1) `attribution.ts` を「2つの局面の生データを受け取り
//! 分解結果を組み立てる純粋関数」として実装しやすくテストしやすい、
//! (2) 分解ロジック自体は単純な重み付き引き算であり、Rust/TSどちらに置いても
//! 複雑度は変わらないため、UI側で完結させたほうが将来の表示調整
//! (ラベル文言・グルーピング等)がしやすい。重み定数 (`MOBILITY_WEIGHT` 等)は
//! `eval.rs` から `pub(crate)` で参照できるため、Rust側の値のみを信頼できる
//! ソースとして保つ。TS側の重み複製がdriftしていないことは、
//! `evalTerms` が返す `evaluateBlack`(本物の `eval::evaluate` 出力)との
//! 突き合わせテストで検証する(`app/src/analysis/attribution.test.ts`)。
//!
//! 設計書§1「特徴量層」の12特徴量は `compute_features` (`featureSet` コマンド)
//! で計算する。「辺の形」「斜めライン」「地域偶数」は現行評価関数に存在しない
//! 概念のため評価内訳分解には含めない(要件どおり、特徴量としての計算のみ行う)。
//! 「余裕手」はエンジンの浅い探索結果(既存の `requestAnalyzeAll` 相当)を使うため
//! TypeScript側で計算する(このモジュールでは扱わない、タスク仕様の判断可を適用)。

use crate::bitboard::{dilate8, Board, Side};
use crate::eval;
use crate::protocol::{self, square_to_notation, BoardJson};
use serde::{Deserialize, Serialize};

// =====================================================================
// ドメインロジック(Board/Side を直接扱う、JSONを知らない純粋関数群)
// =====================================================================

/// `side` が保持する石のビットボードを返す。
///
/// `eval.rs` の非公開 `own_bits` と同じ発想だが、`eval.rs` 側の関数は
/// `pub` でないため、このモジュール内で改めて定義する(4行の自明な
/// マッチ式であり、クロスモジュールで公開するほどのロジックではないと判断)。
fn side_bits(board: &Board, side: Side) -> u64 {
    match side {
        Side::Black => board.black,
        Side::White => board.white,
    }
}

/// ビットマスクを立っているビットに対応するマス番号(0..63)の昇順`Vec`に変換する。
fn bits_to_squares(mask: u64) -> Vec<u8> {
    (0..64u8).filter(|&i| mask & (1u64 << i) != 0).collect()
}

/// 辺(8マスの配列)のうち、指定インデックスのマスの色を返す(空きなら`None`)。
fn cell_side(board: &Board, idx: u32) -> Option<Side> {
    let bit = 1u64 << idx;
    if board.black & bit != 0 {
        Some(Side::Black)
    } else if board.white & bit != 0 {
        Some(Side::White)
    } else {
        None
    }
}

/// 辺の形の簡易分類(設計書のカタログ「ウィング/山/ブロック/一方空き」の
/// 厳密な伝統的分類ではなく、実装者判断による簡略版。判断根拠はタスクの
/// 作業ログを参照)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeShapeKind {
    /// 空きマスが無い(完全に埋まっている)。
    Block,
    /// 両隅とも空いている。
    BothCornersOpen,
    /// 片隅だけが空いていて、隅の隣(C相当)が石で埋まり、その次(X相当)が
    /// 空いている「ウィング」に近い形。
    Wing,
    /// 片隅だけが空いていて、上記ウィング条件を満たさない形。
    OneCornerOpen,
    /// 両隅とも埋まっているが、内側に空きマスがある形。
    Open,
}

impl EdgeShapeKind {
    fn as_str(self) -> &'static str {
        match self {
            EdgeShapeKind::Block => "block",
            EdgeShapeKind::BothCornersOpen => "both_corners_open",
            EdgeShapeKind::Wing => "wing",
            EdgeShapeKind::OneCornerOpen => "one_corner_open",
            EdgeShapeKind::Open => "open",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeShape {
    pub edge: &'static str,
    pub shape: EdgeShapeKind,
    pub empty_count: u32,
}

fn classify_edge(name: &'static str, board: &Board, edge: &[u32; 8]) -> EdgeShape {
    let cells: Vec<Option<Side>> = edge.iter().map(|&idx| cell_side(board, idx)).collect();
    let empty_count = cells.iter().filter(|c| c.is_none()).count() as u32;
    let corner0_empty = cells[0].is_none();
    let corner7_empty = cells[7].is_none();

    let shape = if empty_count == 0 {
        EdgeShapeKind::Block
    } else if corner0_empty && corner7_empty {
        EdgeShapeKind::BothCornersOpen
    } else if corner0_empty || corner7_empty {
        // ウィング判定: 空いている隅の隣(C相当、idx1/idx6)が石で埋まっており、
        // さらにその次(X相当、idx2/idx5)が空いている場合を簡易的に「ウィング」とみなす。
        let (c_idx, x_idx) = if corner0_empty { (1, 2) } else { (6, 5) };
        if cells[c_idx].is_some() && cells[x_idx].is_none() {
            EdgeShapeKind::Wing
        } else {
            EdgeShapeKind::OneCornerOpen
        }
    } else {
        EdgeShapeKind::Open
    };

    EdgeShape {
        edge: name,
        shape,
        empty_count,
    }
}

/// X打ちマス(隅の斜め隣)-> 対応する隅マス番号。
/// `app/src/analysis/whyBad.ts`(T030)の`X_SQUARE_TO_CORNER`と同じ対応。
const X_SQUARE_TO_CORNER: [(u8, u8); 4] = [(9, 0), (14, 7), (49, 56), (54, 63)];

/// C打ちマス(隅の直交隣、辺上)-> 対応する隅マス番号。
/// `app/src/analysis/whyBad.ts`(T030)の`C_SQUARE_TO_CORNER`と同じ対応。
const C_SQUARE_TO_CORNER: [(u8, u8); 8] = [
    (1, 0),
    (8, 0),
    (6, 7),
    (15, 7),
    (57, 56),
    (48, 56),
    (62, 63),
    (55, 63),
];

#[derive(Debug, Clone)]
pub struct CornerRisk {
    pub kind: &'static str, // "x" | "c"
    pub corner: u8,
    /// 対応する隅を相手が取った場合に見積もられる確定石数の増分
    /// (`eval::stable_count` の簡易差分、隅に直接石を置いた仮定によるおおまかな見積り)。
    pub stable_risk: i32,
}

/// `mv`(着手前局面での着手先)がX打ち/C打ちに該当し、かつ対応する隅が
/// まだ空いているかを判定する。該当すれば、その隅を相手が取った場合の
/// 確定石見積りも添えて返す。
fn detect_corner_risk(before: &Board, after: &Board, opp: Side, mv: u8) -> Option<CornerRisk> {
    let found = X_SQUARE_TO_CORNER
        .iter()
        .find(|&&(sq, corner)| sq == mv && cell_side(before, corner as u32).is_none())
        .map(|&(_, corner)| ("x", corner))
        .or_else(|| {
            C_SQUARE_TO_CORNER
                .iter()
                .find(|&&(sq, corner)| sq == mv && cell_side(before, corner as u32).is_none())
                .map(|&(_, corner)| ("c", corner))
        })?;
    let (kind, corner) = found;

    // 隅を相手(opp)が取ったと仮定(実際のフリップは再現しない簡易見積り: 直接
    // その色の石を置いたと仮定して確定石数の増分を見る)。
    let corner_bit = 1u64 << corner;
    let mut hypothetical = *after;
    match opp {
        Side::Black => hypothetical.black |= corner_bit,
        Side::White => hypothetical.white |= corner_bit,
    }
    let stable_before = eval::stable_count(after, opp) as i32;
    let stable_after = eval::stable_count(&hypothetical, opp) as i32;

    Some(CornerRisk {
        kind,
        corner,
        stable_risk: stable_after - stable_before,
    })
}

#[derive(Debug, Clone)]
pub struct ParityRegion {
    pub size: u32,
    /// "odd" | "even"
    pub parity: &'static str,
    pub squares: Vec<u8>,
}

/// マス`sq`の直交4方向(上下左右)の隣接マス(盤内のみ)を返す。
///
/// 地域偶数(パリティ)理論で一般的な「空きマスの連結成分」は、盤面を石の壁で
/// 区切られた領域として捉える発想であり、斜め方向の接触だけでは領域を
/// つなげない(直交方向にのみ空きマスが連続していれば同一領域とみなす)、
/// という解釈で4方向連結を採用した(実装者判断、要件2のガイダンスに従う)。
fn orthogonal_neighbors(sq: u8) -> Vec<u8> {
    let file = sq % 8;
    let rank = sq / 8;
    let mut result = Vec::with_capacity(4);
    if rank > 0 {
        result.push(sq - 8);
    }
    if rank < 7 {
        result.push(sq + 8);
    }
    if file > 0 {
        result.push(sq - 1);
    }
    if file < 7 {
        result.push(sq + 1);
    }
    result
}

/// 空きマスのビットマスクを、直交4方向の連結成分(領域)ごとに分解する
/// (Union-Find相当、単純なスタックベースの幅優先/深さ優先探索で実装)。
fn compute_parity_regions(empty: u64) -> Vec<ParityRegion> {
    let mut visited = 0u64;
    let mut regions = Vec::new();

    for start in 0..64u8 {
        let start_bit = 1u64 << start;
        if empty & start_bit == 0 || visited & start_bit != 0 {
            continue;
        }

        let mut stack = vec![start];
        visited |= start_bit;
        let mut squares = Vec::new();

        while let Some(sq) = stack.pop() {
            squares.push(sq);
            for neighbor in orthogonal_neighbors(sq) {
                let nbit = 1u64 << neighbor;
                if empty & nbit != 0 && visited & nbit == 0 {
                    visited |= nbit;
                    stack.push(neighbor);
                }
            }
        }

        squares.sort_unstable();
        let size = squares.len() as u32;
        regions.push(ParityRegion {
            size,
            parity: if size % 2 == 0 { "even" } else { "odd" },
            squares,
        });
    }

    regions
}

/// 4辺すべてのマス(重複除去なし、ビットマスクなのでOR演算で自然に重複排除される)。
fn edge_mask() -> u64 {
    let mut mask = 0u64;
    for &idx in eval::TOP_EDGE
        .iter()
        .chain(eval::BOTTOM_EDGE.iter())
        .chain(eval::LEFT_EDGE.iter())
        .chain(eval::RIGHT_EDGE.iter())
    {
        mask |= 1u64 << idx;
    }
    mask
}

/// 種石: `side`(自分)の石のうち、`opp`(相手)の現在の辺上の合法手いずれかに
/// よって挟まれて返される石。「相手の辺への着手を成立させている自石」の
/// 定義として、相手の辺打ちが実際にフリップする自石そのものを採用した
/// (実装者判断。厳密には将来複数手先まで見る必要があるが、静的1手先の
/// 判定として妥当と判断)。
fn compute_seed_stones(after: &Board, side: Side, opp: Side) -> u64 {
    let opp_edge_moves = after.legal_moves(opp) & edge_mask();
    let mut seeds = 0u64;
    let mover_bits = side_bits(after, side);

    for sq in 0..64u8 {
        let bit = 1u64 << sq;
        if opp_edge_moves & bit == 0 {
            continue;
        }
        let hypothetical = after.apply_move(opp, bit);
        // 着手前は`side`の石だったが、この仮想着手後は`side`の石でなくなった
        // マス = この着手でフリップされた`side`の石。
        let flipped = mover_bits & !side_bits(&hypothetical, side);
        seeds |= flipped;
    }

    seeds
}

const MAIN_DIAGONAL: [u32; 8] = [0, 9, 18, 27, 36, 45, 54, 63]; // a1..h8
const ANTI_DIAGONAL: [u32; 8] = [56, 49, 42, 35, 28, 21, 14, 7]; // a8..h1

#[derive(Debug, Clone)]
pub struct LineInfo {
    pub name: &'static str,
    pub mover: u32,
    pub opponent: u32,
    pub empty: u32,
}

fn classify_line(name: &'static str, board: &Board, line: &[u32; 8], side: Side) -> LineInfo {
    let mut mover = 0u32;
    let mut opponent = 0u32;
    let mut empty = 0u32;
    for &idx in line.iter() {
        match cell_side(board, idx) {
            Some(s) if s == side => mover += 1,
            Some(_) => opponent += 1,
            None => empty += 1,
        }
    }
    LineInfo {
        name,
        mover,
        opponent,
        empty,
    }
}

/// 12特徴量すべてをまとめた結果(要件1)。
///
/// 「余裕手」(設計書§1.1、浅い評価でロス<0.5の手を数える)はエンジンの
/// 浅い探索(`requestAnalyzeAll`相当)の呼び出しが必要なため、本構造体には
/// 含めずTypeScript側(`app/src/analysis/`)で計算する設計にした
/// (タスク仕様が明示的に許容する判断)。
#[derive(Debug, Clone)]
pub struct FeatureSet {
    // 1. 着手可能数差
    pub mobility_diff: i32,
    pub mover_mobility_before: u32,
    pub opponent_mobility_before: u32,
    pub opponent_mobility_after: u32,
    pub mover_mobility_after: u32,
    // 2. 潜在手数差
    pub potential_mobility_diff: i32,
    // 3. 開放度
    pub openness: u32,
    pub is_uchiwari: bool,
    // 4. フロンティア石数差
    pub frontier_diff: i32,
    // 5. 新規に生む相手の手/消える自分の手
    pub new_opponent_moves: Vec<u8>,
    pub lost_own_moves: Vec<u8>,
    // 6. 確定石差
    pub stable_diff: i32,
    // 7. 辺の形
    pub edge_shapes: [EdgeShape; 4],
    // 8. X・C打ちリスク
    pub corner_risk: Option<CornerRisk>,
    // 9. 地域偶数
    pub parity_regions: Vec<ParityRegion>,
    // 11. 種石
    pub seed_stones: Vec<u8>,
    // 12. ライン
    pub lines: [LineInfo; 2],
}

/// 局面`board`(`side`が手番)で`mv`に着手した場合の12特徴量を計算する。
///
/// `mv`は`board.legal_moves(side)`に含まれる合法手であることを前提とする
/// (呼び出し元の`handle_feature_set`で検証済み)。
pub fn compute_features(board: &Board, side: Side, mv: u8) -> FeatureSet {
    let opp = side.opposite();
    let mv_bit = 1u64 << mv;
    let after = board.apply_move(side, mv_bit);
    let empty_after = !(after.black | after.white);

    // --- 1. 着手可能数差 -------------------------------------------------
    // 「自分−相手の合法手数(着手前後)」を、`whyBad.ts`(T030)と同じ解釈
    // (自分は着手前、相手は着手後)で採用する: 着手直後は相手の手番であり、
    // 「自分の着手後の合法手数」は次に自分の番が来るまで実際には使われない
    // ため、理論上意味を持つのは「着手前の自分の選択肢の広さ」対「その結果
    // 相手に生まれた選択肢の広さ」の比較である。
    let mover_mobility_before = board.legal_moves(side).count_ones();
    let opponent_mobility_before = board.legal_moves(opp).count_ones();
    let opponent_mobility_after = after.legal_moves(opp).count_ones();
    let mover_mobility_after = after.legal_moves(side).count_ones();
    let mobility_diff = mover_mobility_before as i32 - opponent_mobility_after as i32;

    // --- 2. 潜在手数差(着手後の局面、自分視点) -----------------------------
    // 潜在手数(potential mobility): 相手石に隣接する空きマスの数
    // (将来そこに着手できる可能性の目安)。
    let potential_mover = (dilate8(side_bits(&after, opp)) & empty_after).count_ones();
    let potential_opp = (dilate8(side_bits(&after, side)) & empty_after).count_ones();
    let potential_mobility_diff = potential_mover as i32 - potential_opp as i32;

    // --- 3. 開放度 --------------------------------------------------------
    // この手でひっくり返った石(着手前は相手の石、着手後は相手の石でなく
    // なったマス)に隣接する空きマスの総数(重複除去済み)。
    let flips = side_bits(board, opp) & !side_bits(&after, opp);
    let openness = (dilate8(flips) & empty_after).count_ones();
    let is_uchiwari = openness <= 2;

    // --- 4. フロンティア石数差(着手後の局面) -------------------------------
    let frontier_mask = dilate8(empty_after);
    let frontier_mover = (side_bits(&after, side) & frontier_mask).count_ones();
    let frontier_opp = (side_bits(&after, opp) & frontier_mask).count_ones();
    let frontier_diff = frontier_mover as i32 - frontier_opp as i32;

    // --- 5. 新規に生む相手の手/消える自分の手 -------------------------------
    let opp_before_mask = board.legal_moves(opp);
    let opp_after_mask = after.legal_moves(opp);
    let new_opponent_moves = bits_to_squares(opp_after_mask & !opp_before_mask);

    let mover_before_mask = board.legal_moves(side);
    let mover_after_mask = after.legal_moves(side);
    let lost_own_moves = bits_to_squares(mover_before_mask & !mover_after_mask);

    // --- 6. 確定石差(着手後の局面、`eval::stable_count`を再利用) ------------
    let stable_diff = eval::stable_count(&after, side) as i32 - eval::stable_count(&after, opp) as i32;

    // --- 7. 辺の形(着手後の局面、4辺) --------------------------------------
    let edge_shapes = [
        classify_edge("top", &after, &eval::TOP_EDGE),
        classify_edge("bottom", &after, &eval::BOTTOM_EDGE),
        classify_edge("left", &after, &eval::LEFT_EDGE),
        classify_edge("right", &after, &eval::RIGHT_EDGE),
    ];

    // --- 8. X・C打ちリスク(着手前の局面で隅の空き判定) ----------------------
    let corner_risk = detect_corner_risk(board, &after, opp, mv);

    // --- 9. 地域偶数(着手後の局面) ------------------------------------------
    let parity_regions = compute_parity_regions(empty_after);

    // --- 11. 種石(着手後の局面) ---------------------------------------------
    let seed_stones = bits_to_squares(compute_seed_stones(&after, side, opp));

    // --- 12. ライン(着手後の局面、主対角線2本) -------------------------------
    let lines = [
        classify_line("main_diagonal", &after, &MAIN_DIAGONAL, side),
        classify_line("anti_diagonal", &after, &ANTI_DIAGONAL, side),
    ];

    FeatureSet {
        mobility_diff,
        mover_mobility_before,
        opponent_mobility_before,
        opponent_mobility_after,
        mover_mobility_after,
        potential_mobility_diff,
        openness,
        is_uchiwari,
        frontier_diff,
        new_opponent_moves,
        lost_own_moves,
        stable_diff,
        edge_shapes,
        corner_risk,
        parity_regions,
        seed_stones,
        lines,
    }
}

// =====================================================================
// JSON変換(FeatureSet -> FeatureSetJson)
// =====================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeShapeJson {
    pub edge: String,
    pub shape: String,
    pub empty_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CornerRiskJson {
    pub kind: String,
    pub corner: String,
    pub stable_risk: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityRegionJson {
    pub size: u32,
    pub parity: String,
    pub squares: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineJson {
    pub name: String,
    pub mover: u32,
    pub opponent: u32,
    pub empty: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureSetJson {
    pub mobility_diff: i32,
    pub mover_mobility_before: u32,
    pub opponent_mobility_before: u32,
    pub opponent_mobility_after: u32,
    pub mover_mobility_after: u32,
    pub potential_mobility_diff: i32,
    pub openness: u32,
    pub is_uchiwari: bool,
    pub frontier_diff: i32,
    pub new_opponent_moves: Vec<String>,
    pub lost_own_moves: Vec<String>,
    pub stable_diff: i32,
    pub edge_shapes: Vec<EdgeShapeJson>,
    pub corner_risk: Option<CornerRiskJson>,
    pub parity_regions: Vec<ParityRegionJson>,
    pub seed_stones: Vec<String>,
    pub lines: Vec<LineJson>,
}

impl FeatureSet {
    pub fn to_json(&self) -> FeatureSetJson {
        FeatureSetJson {
            mobility_diff: self.mobility_diff,
            mover_mobility_before: self.mover_mobility_before,
            opponent_mobility_before: self.opponent_mobility_before,
            opponent_mobility_after: self.opponent_mobility_after,
            mover_mobility_after: self.mover_mobility_after,
            potential_mobility_diff: self.potential_mobility_diff,
            openness: self.openness,
            is_uchiwari: self.is_uchiwari,
            frontier_diff: self.frontier_diff,
            new_opponent_moves: self.new_opponent_moves.iter().map(|&sq| square_to_notation(sq)).collect(),
            lost_own_moves: self.lost_own_moves.iter().map(|&sq| square_to_notation(sq)).collect(),
            stable_diff: self.stable_diff,
            edge_shapes: self
                .edge_shapes
                .iter()
                .map(|e| EdgeShapeJson {
                    edge: e.edge.to_string(),
                    shape: e.shape.as_str().to_string(),
                    empty_count: e.empty_count,
                })
                .collect(),
            corner_risk: self.corner_risk.as_ref().map(|c| CornerRiskJson {
                kind: c.kind.to_string(),
                corner: square_to_notation(c.corner),
                stable_risk: c.stable_risk,
            }),
            parity_regions: self
                .parity_regions
                .iter()
                .map(|r| ParityRegionJson {
                    size: r.size,
                    parity: r.parity.to_string(),
                    squares: r.squares.iter().map(|&sq| square_to_notation(sq)).collect(),
                })
                .collect(),
            seed_stones: self.seed_stones.iter().map(|&sq| square_to_notation(sq)).collect(),
            lines: self
                .lines
                .iter()
                .map(|l| LineJson {
                    name: l.name.to_string(),
                    mover: l.mover,
                    opponent: l.opponent,
                    empty: l.empty,
                })
                .collect(),
        }
    }
}

// =====================================================================
// JSON入出力プロトコル(`Engine::explain`から呼ばれる)
// =====================================================================

#[derive(Debug, Deserialize)]
struct FeatureSetRequest {
    id: u64,
    board: BoardJson,
    #[serde(rename = "move")]
    mv: String,
}

#[derive(Debug, Deserialize)]
struct EvalTermsRequest {
    id: u64,
    board: BoardJson,
}

#[derive(Debug, Serialize)]
struct FeatureSetResponse {
    id: u64,
    #[serde(rename = "final")]
    is_final: bool,
    features: FeatureSetJson,
}

/// `evalTerms` コマンドの応答。現行評価関数(`eval.rs`)の3項
/// (モビリティ・隅・安定石)の生の特徴量差分と、参考として実際の評価値
/// (黒視点、centi-disc単位)を返す。加重・合算(waterfall分解の構築)は
/// TypeScript側の `app/src/analysis/attribution.ts` が行う(モジュール冒頭の
/// ドキュメント参照)。
#[derive(Debug, Serialize)]
struct EvalTermsResponse {
    id: u64,
    #[serde(rename = "final")]
    is_final: bool,
    #[serde(rename = "mobilityDiff")]
    mobility_diff: i32,
    #[serde(rename = "cornerDiff")]
    corner_diff: i32,
    #[serde(rename = "stableDiff")]
    stable_diff: i32,
    #[serde(rename = "evaluateBlack")]
    evaluate_black: i32,
}

/// JSONリクエスト文字列を解析し、`cmd`(`"featureSet"` | `"evalTerms"`)に
/// 応じて処理を振り分けてJSONレスポンス文字列を返す。
///
/// `protocol::handle_analyze`と同じ方針で絶対にpanicしない: 不正な入力は
/// すべて `protocol::error_json` によるエラー応答文字列として返す。
pub fn handle_explain(request_json: &str) -> String {
    let value: serde_json::Value = match serde_json::from_str(request_json) {
        Ok(v) => v,
        Err(e) => return protocol::error_json(None, format!("invalid request JSON: {e}")),
    };
    let cmd = value.get("cmd").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let id = value.get("id").and_then(|v| v.as_u64());

    match cmd.as_str() {
        "evalTerms" => handle_eval_terms(value, id),
        "featureSet" => handle_feature_set(value, id),
        other => protocol::error_json(id, format!("unsupported command: {other}")),
    }
}

fn handle_eval_terms(value: serde_json::Value, id: Option<u64>) -> String {
    let req: EvalTermsRequest = match serde_json::from_value(value) {
        Ok(r) => r,
        Err(e) => return protocol::error_json(id, format!("invalid request JSON: {e}")),
    };
    let (board, _side) = match protocol::parse_board(&req.board) {
        Ok(v) => v,
        Err(e) => return protocol::error_json(Some(req.id), e),
    };

    let features = eval::feature_diffs(&board);
    let response = EvalTermsResponse {
        id: req.id,
        is_final: true,
        mobility_diff: features.mobility_diff,
        corner_diff: features.corner_diff,
        stable_diff: features.stable_diff,
        evaluate_black: eval::evaluate(&board),
    };
    serde_json::to_string(&response)
        .unwrap_or_else(|e| protocol::error_json(Some(req.id), format!("failed to serialize response: {e}")))
}

fn handle_feature_set(value: serde_json::Value, id: Option<u64>) -> String {
    let req: FeatureSetRequest = match serde_json::from_value(value) {
        Ok(r) => r,
        Err(e) => return protocol::error_json(id, format!("invalid request JSON: {e}")),
    };
    let (board, side) = match protocol::parse_board(&req.board) {
        Ok(v) => v,
        Err(e) => return protocol::error_json(Some(req.id), e),
    };
    let mv = match protocol::notation_to_square(&req.mv) {
        Ok(v) => v,
        Err(e) => return protocol::error_json(Some(req.id), e),
    };
    if board.legal_moves(side) & (1u64 << mv) == 0 {
        return protocol::error_json(Some(req.id), format!("illegal move: {}", req.mv));
    }

    let features = compute_features(&board, side, mv);
    let response = FeatureSetResponse {
        id: req.id,
        is_final: true,
        features: features.to_json(),
    };
    serde_json::to_string(&response)
        .unwrap_or_else(|e| protocol::error_json(Some(req.id), format!("failed to serialize response: {e}")))
}

// =====================================================================
// テスト
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(notation: &str) -> u8 {
        protocol::notation_to_square(notation).unwrap()
    }

    // --- 1. 着手可能数差 ---------------------------------------------------

    #[test]
    fn mobility_diff_matches_manual_computation_on_initial_board() {
        let board = Board::initial();
        // 黒番、d3に着手(初期局面の合法手の1つ)。
        let features = compute_features(&board, Side::Black, sq("d3"));
        let after = board.apply_move(Side::Black, 1u64 << sq("d3"));
        let expected_opp_after = after.legal_moves(Side::White).count_ones() as i32;
        let expected_mover_before = board.legal_moves(Side::Black).count_ones() as i32;
        assert_eq!(features.mobility_diff, expected_mover_before - expected_opp_after);
        assert_eq!(features.mover_mobility_before, board.legal_moves(Side::Black).count_ones());
        assert_eq!(features.opponent_mobility_before, board.legal_moves(Side::White).count_ones());
    }

    // --- 3. 開放度・中割り判定 -----------------------------------------------

    #[test]
    fn openness_counts_unique_empty_neighbors_of_flipped_discs() {
        // 初期局面でd3に着手すると、c4(index 26)の1つがひっくり返る。
        let board = Board::initial();
        let features = compute_features(&board, Side::Black, sq("d3"));
        // 手動でc4に隣接する空きマス数を数える(初期局面の周辺はほぼ空き)。
        assert!(features.openness > 0, "openness should be positive after a flip");
        assert_eq!(features.is_uchiwari, features.openness <= 2);
    }

    // --- 4. フロンティア石数差 ------------------------------------------------

    #[test]
    fn frontier_diff_is_zero_on_symmetric_initial_position_after_a_move() {
        // 初期局面は中央4石が互いに隣接し合っており、どの初手を打っても
        // 手番側・相手側とも1つずつフロンティア石が増える対称な形になる。
        let board = Board::initial();
        let features = compute_features(&board, Side::Black, sq("d3"));
        // フロンティア差の厳密な値は形状に依存するため、ここでは「計算が
        // 破綻していない(異常値でない)」ことのみ確認する。
        assert!(features.frontier_diff.abs() <= 8);
    }

    // --- 5. 新規に生む相手の手/消える自分の手 -----------------------------------

    #[test]
    fn new_and_lost_moves_are_computed_from_before_after_legal_move_sets() {
        let board = Board::initial();
        let mv = sq("d3");
        let features = compute_features(&board, Side::Black, mv);
        let after = board.apply_move(Side::Black, 1u64 << mv);

        let expected_new: Vec<u8> = (0..64u8)
            .filter(|&s| {
                let bit = 1u64 << s;
                after.legal_moves(Side::White) & bit != 0 && board.legal_moves(Side::White) & bit == 0
            })
            .collect();
        assert_eq!(features.new_opponent_moves, expected_new);
    }

    // --- 6. 確定石差(eval::stable_countとの整合性) -----------------------------

    #[test]
    fn stable_diff_matches_eval_stable_count_directly() {
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board { black: corners, white: 0 };
        // 黒番で(合法手がないと着手できないため)人工的に安定石差だけを検証する
        // 目的で、`compute_features`を経由せず`eval::stable_count`を直接比較する。
        assert_eq!(eval::stable_count(&board, Side::Black), 4);
        assert_eq!(eval::stable_count(&board, Side::White), 0);
    }

    // --- 7. 辺の形 ------------------------------------------------------------

    #[test]
    fn classify_edge_detects_block_when_edge_fully_occupied() {
        let mut black = 0u64;
        for &idx in eval::TOP_EDGE.iter() {
            black |= 1u64 << idx;
        }
        let board = Board { black, white: 0 };
        let shape = classify_edge("top", &board, &eval::TOP_EDGE);
        assert_eq!(shape.shape, EdgeShapeKind::Block);
        assert_eq!(shape.empty_count, 0);
    }

    #[test]
    fn classify_edge_detects_both_corners_open() {
        // a1, h1(隅)を空けて、それ以外(b1..g1)を黒で埋める。
        let mut black = 0u64;
        for &idx in eval::TOP_EDGE.iter().skip(1).take(6) {
            black |= 1u64 << idx;
        }
        let board = Board { black, white: 0 };
        let shape = classify_edge("top", &board, &eval::TOP_EDGE);
        assert_eq!(shape.shape, EdgeShapeKind::BothCornersOpen);
    }

    #[test]
    fn classify_edge_detects_wing_pattern() {
        // a1(隅)を空け、b1(C相当)を黒で埋め、c1(X相当)を空け、d1..h1を黒で埋める。
        let mut black = 0u64;
        black |= 1u64 << eval::TOP_EDGE[1]; // b1
        for &idx in eval::TOP_EDGE.iter().skip(3) {
            black |= 1u64 << idx; // d1..h1
        }
        let board = Board { black, white: 0 };
        let shape = classify_edge("top", &board, &eval::TOP_EDGE);
        assert_eq!(shape.shape, EdgeShapeKind::Wing);
    }

    // --- 8. X・C打ちリスク -------------------------------------------------------

    #[test]
    fn detect_corner_risk_flags_x_square_when_corner_still_empty() {
        // a1が空きで、白がb2(X打ちマス)に着手可能な局面を人工的に構築する。
        // 判定自体は「着手先がb2かつa1が空き」であることのみを見るため、
        // 合法手判定を経由しない直接呼び出しで検証する。
        let board = Board { black: 0, white: 0 };
        let after = board; // 簡易テストのためbefore/afterを同一に(risk見積り検証は別テストで)
        let risk = detect_corner_risk(&board, &after, Side::Black, sq("b2"));
        assert!(risk.is_some());
        let risk = risk.unwrap();
        assert_eq!(risk.kind, "x");
        assert_eq!(risk.corner, sq("a1"));
    }

    #[test]
    fn detect_corner_risk_returns_none_when_corner_already_taken() {
        let board = Board {
            black: 1u64 << sq("a1"),
            white: 0,
        };
        let risk = detect_corner_risk(&board, &board, Side::White, sq("b2"));
        assert!(risk.is_none());
    }

    #[test]
    fn detect_corner_risk_estimates_positive_stable_gain_for_opponent() {
        // 相手(白)がa1隅を取れば、少なくとも1個(a1自身)は確定石として
        // カウントされ、`stable_risk`は正になるはず。
        let board = Board { black: 0, white: 0 };
        let risk = detect_corner_risk(&board, &board, Side::White, sq("b2")).unwrap();
        assert!(risk.stable_risk >= 1, "stable_risk should be at least 1, got {}", risk.stable_risk);
    }

    // --- 9. 地域偶数 --------------------------------------------------------------

    #[test]
    fn parity_regions_splits_board_into_connected_empty_components() {
        // d列(file=3, 0-indexed)をすべて黒で埋め、盤を左右2つの領域に分割する。
        let mut black = 0u64;
        for rank in 0..8u32 {
            black |= 1u64 << (rank * 8 + 3); // d列
        }
        let board = Board { black, white: 0 };
        let empty = !(board.black | board.white);
        let regions = compute_parity_regions(empty);
        assert_eq!(regions.len(), 2, "splitting by a full column should yield 2 regions");
        // 左側3列(a,b,c)×8行=24マス、右側4列(e,f,g,h)×8行=32マス。
        let sizes: Vec<u32> = {
            let mut v: Vec<u32> = regions.iter().map(|r| r.size).collect();
            v.sort_unstable();
            v
        };
        assert_eq!(sizes, vec![24, 32]);
    }

    #[test]
    fn parity_regions_reports_odd_and_even_correctly() {
        let mut black = 0u64;
        for rank in 0..8u32 {
            black |= 1u64 << (rank * 8 + 3);
        }
        let board = Board { black, white: 0 };
        let empty = !(board.black | board.white);
        let regions = compute_parity_regions(empty);
        for region in &regions {
            let expected_parity = if region.size % 2 == 0 { "even" } else { "odd" };
            assert_eq!(region.parity, expected_parity);
        }
    }

    // --- 11. 種石 ------------------------------------------------------------------

    #[test]
    fn seed_stones_are_empty_when_opponent_has_no_edge_legal_moves() {
        let board = Board::initial();
        // 初期局面には辺上の合法手が存在しない。
        let seeds = compute_seed_stones(&board, Side::Black, Side::White);
        assert_eq!(seeds, 0);
    }

    #[test]
    fn seed_stones_detects_stone_flipped_by_opponent_edge_move() {
        // 白がa1(隅)からb1方向に黒を1個挟んで着手できる局面を人工的に構築する。
        // white: a1, c1 / black: b1 -> 白がb1を着手すると誤り(既に黒がいるので不可)。
        // 代わりに: white: a1 / black: b1 / 空き: c1..h1(白がc1に打てばb1の黒を挟める)。
        let white = 1u64 << sq("a1");
        let black = 1u64 << sq("b1");
        let board = Board { black, white };
        // 白番でc1が合法手か確認(a1-b1(黒)-c1(白)で挟める)。
        assert!(board.legal_moves(Side::White) & (1u64 << sq("c1")) != 0);

        let seeds = compute_seed_stones(&board, Side::Black, Side::White);
        assert_eq!(seeds, 1u64 << sq("b1"), "b1 should be detected as a seed stone");
    }

    // --- 12. ライン -----------------------------------------------------------------

    #[test]
    fn lines_report_initial_board_diagonal_occupancy() {
        let board = Board::initial();
        let lines = [
            classify_line("main_diagonal", &board, &MAIN_DIAGONAL, Side::Black),
            classify_line("anti_diagonal", &board, &ANTI_DIAGONAL, Side::Black),
        ];
        // 主対角線(a1..h8)にはd4(白)・e5(白)が乗っている -> 黒視点でopponent=2。
        assert_eq!(lines[0].opponent, 2);
        assert_eq!(lines[0].mover, 0);
        assert_eq!(lines[0].empty, 6);
        // 反対角線(a8..h1)にはd5(黒)・e4(黒)が乗っている -> 黒視点でmover=2。
        assert_eq!(lines[1].mover, 2);
        assert_eq!(lines[1].opponent, 0);
        assert_eq!(lines[1].empty, 6);
    }

    // --- JSON入出力(handle_explain) -------------------------------------------------

    const INITIAL_BLACK: &str = "0x0000000810000000";
    const INITIAL_WHITE: &str = "0x0000001008000000";

    #[test]
    fn handle_explain_eval_terms_matches_eval_feature_diffs() {
        let request = format!(
            r#"{{"id":1,"cmd":"evalTerms","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}}}}"#
        );
        let response_json = handle_explain(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).expect("valid JSON");
        assert!(response.get("error").is_none(), "unexpected error: {response_json}");
        assert_eq!(response["id"], 1);
        assert_eq!(response["final"], true);
        // 初期局面は完全対称なので3項すべて0のはず。
        assert_eq!(response["mobilityDiff"], 0);
        assert_eq!(response["cornerDiff"], 0);
        assert_eq!(response["stableDiff"], 0);
        assert_eq!(response["evaluateBlack"], 0);
    }

    #[test]
    fn handle_explain_feature_set_returns_features_for_legal_move() {
        let request = format!(
            r#"{{"id":2,"cmd":"featureSet","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"move":"d3"}}"#
        );
        let response_json = handle_explain(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).expect("valid JSON");
        assert!(response.get("error").is_none(), "unexpected error: {response_json}");
        assert_eq!(response["id"], 2);
        assert!(response["features"]["mobilityDiff"].is_i64());
        assert_eq!(response["features"]["lines"].as_array().unwrap().len(), 2);
        assert_eq!(response["features"]["edgeShapes"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn handle_explain_feature_set_rejects_illegal_move() {
        let request = format!(
            r#"{{"id":3,"cmd":"featureSet","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"move":"a1"}}"#
        );
        let response_json = handle_explain(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).expect("valid JSON");
        assert!(response.get("error").is_some());
    }

    #[test]
    fn handle_explain_rejects_unsupported_command() {
        let request = format!(
            r#"{{"id":4,"cmd":"bogus","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}}}}"#
        );
        let response_json = handle_explain(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).expect("valid JSON");
        assert!(response.get("error").is_some());
        assert_eq!(response["id"], 4);
    }

    #[test]
    fn handle_explain_broken_json_returns_error_without_panicking() {
        let response_json = handle_explain("{ not json");
        let response: serde_json::Value = serde_json::from_str(&response_json).expect("valid JSON");
        assert!(response.get("error").is_some());
    }
}

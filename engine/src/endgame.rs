//! 終盤完全読みソルバー: 空きマスが少ない局面で、評価関数を一切使わず
//! 終局までの全ての着手系列を読み切り、両者が最善を尽くした場合の
//! 「真の最終石差」を計算する。
//!
//! # スケールについて (重要)
//!
//! [`solve_exact`] が返す値は `eval.rs` (T004) の centi-disc スケール
//! (1石 = 100) **ではなく**、単純な整数の石差 (1石 = 1) である
//! (例: 黒が3石多く勝てば `3`、負ければ `-3`)。
//! 中盤探索 (T005) からこの値を呼び出し、centi-disc スケールの評価値と
//! 混ぜて扱う場合は、呼び出し側で **`solve_exact(...) * 100`** のように
//! 100倍してから使うこと (これが `eval.rs` のスケールに合わせる変換ルール)。
//!
//! # 手番視点
//!
//! 返り値は `side_to_move` から見た最終石差。正なら `side_to_move` の勝ち、
//! 負なら負け、0なら引き分け。
//!
//! # パス・終局の扱い
//!
//! - 手番側に合法手がなければパスして相手番に手番が移る。
//! - 両者ともに合法手がなければ終局とみなす。終局時、盤面に空きマスが
//!   残っていても、標準的なオセロの完全読みソルバーの慣習に従い
//!   「その時点で石数が多い方が残り空きマスを総取りする」ものとして
//!   最終石差を計算する (設計書に明記はないが一般的な慣習)。
//! - 空きマスが0(盤面が完全に埋まっている)の場合は、この総取りルールの
//!   影響がないため、単純に `black_count - white_count` を手番視点に
//!   変換した値がそのまま最終石差になる。
//!
//! # 探索アルゴリズム
//!
//! negamax + fail-soft alpha-beta + NWS中心のPVS構造(T103)。
//! [`crate::tt::TranspositionTable`] を使い、局面 (盤面+手番) の
//! [`crate::zobrist::zobrist_hash`] をキーにして探索結果をキャッシュする。
//! 着手順序は「TT move → 隅 → 着手後の相手の合法手数が少ない順 →
//! static square class (通常/X・C) → 固定4象限パリティ(奇数優先) → マス番号」
//! という決定的なヒューリスティックで並べ替える(空きマス数によらず全体に
//! 適用する)。
//! 安定石による静的カットや、空き4/3/2/1のハードコード専用関数は
//! 本実装では行わない(T006のスコープ外、T102は不採用。あれば高速化に
//! 寄与するのみ)。
//!
//! # NWS中心のPVS構造 (T103)
//!
//! `negamax` の子局面探索は次のように分岐する。
//!
//! - 呼び出し窓が既に狭い(`beta - alpha <= 1`)場合は、全ての兄弟手を
//!   その窓のまま探索する(これ自体が null window search = NWS であり、
//!   別途分岐する必要がない)。
//! - 呼び出し窓が広い(full window)場合、最初の候補だけは通常の
//!   `(-beta, -alpha)` 窓で探索する(Principal Variation)。2手目以降は
//!   まず null window `(-(alpha+1), -alpha)` で「この手が現在のalphaを
//!   上回れないこと」の反証を試み、`alpha < score < beta` の場合
//!   (=反証に失敗し、実際にPVを超える可能性がある場合)だけ通常窓で
//!   再探索する。null windowがfail-low/fail-highした場合はその
//!   fail-soft値をそのまま使う(再探索しない)。
//! - 子の探索(null window探索・再探索のいずれも)が時間/ノード予算切れで
//!   打ち切られた場合、その呼び出しの戻り値は一切使わず(alpha/betaとの
//!   比較にも用いず)、直ちに`0`を返して自身の置換表格納もスキップする
//!   (T034からの既存契約をPVSの各分岐に維持する。設計レポート§7
//!   「abortされた第一探索の値の再利用バグ」対策)。
//! - 2刻み窓最適化(最終石差の偶奇を利用したnull window幅の調整)は
//!   行わない(centi-disc丸めとの相互作用を避けるため。設計レポート§3.2)。
//!
//! ## `alpha_orig` / `beta_orig`(TT格納bound判定用の呼び出し時窓)
//!
//! `negamax`はTT probeで得た既存のLower/Upper boundを使い、ローカルな
//! `alpha`/`beta`を(呼び出し時の値よりも)狭めてから子の探索に使うことが
//! ある。これは健全な最適化だが(TTが保証する既知の下限/上限を起点に
//! するだけで、真の最適値の探索範囲は変わらない)、探索結果をTTへ
//! 格納する際のbound種別(Exact/Lower/Upper)は、この**内部的に狭めた後の
//! 窓ではなく、関数が呼び出された時点の元々の窓**(`alpha_orig`/
//! `beta_orig`、TT probeより前に確定させる)を基準に判定しなければならない
//! (設計レポート§3.2・§7)。内部的に狭めた窓を基準に判定すると、実際には
//! (呼び出し元が要求した広い窓に対して)Exactなはずの値をUpperとして
//! 過小に報告してしまう。
//!
//! # 固定4象限パリティベース着手順序付け (T100)
//!
//! 盤面を a1-d4/e1-h4/a5-d8/e5-h8 の4象限に固定分割し、各象限の空きマス
//! 数が奇数かを`u8`の4bitで保持する。ルートで一度だけ算出し、着手ごとに
//! [`QUADRANT_ID`]の該当bitをXORして子へ渡すため、再帰中のflood fillは行わない。
//! T052の実測を踏まえ、パリティは相手mobilityとsquare classより下位に置く。
//! **着手順序を変えるだけで、探索結果(最終的な評価値)には一切影響しない**
//! (通常のアルファベータ探索において、より良い手を先に読むほど枝刈りが
//! 効くという性質を利用した高速化)。

#![allow(dead_code)]

use crate::bitboard::{apply_move_with_flips, flips_for_move, legal_moves_relative, Board, Side};
use crate::tt::{Bound, TTDomain, TTEntry, TranspositionTable};
use crate::zobrist::{incremental_move_hash, toggle_side_to_move, zobrist_hash};
// search.rsと同じ理由(wasm32-unknown-unknownでの`std::time::Instant`の
// 実行時panicを避けるため)で`web_time`のドロップイン実装を使う(T034)。
use web_time::Instant;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
/// ビットとマスの対応は `bitboard.rs` 冒頭のドキュメントを参照
/// (index = rank0*8 + file なので a1=0, h1=7, a8=56, h8=63)。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
const X_SQUARE_MASK: u64 = (1u64 << 9) | (1u64 << 14) | (1u64 << 49) | (1u64 << 54);
const C_SQUARE_MASK: u64 = (1u64 << 1)
    | (1u64 << 8)
    | (1u64 << 6)
    | (1u64 << 15)
    | (1u64 << 57)
    | (1u64 << 48)
    | (1u64 << 62)
    | (1u64 << 55);

/// ETCを有効にする最小空き数。浅い終盤では全子のhash/probeコストが
/// 相対的に大きいため、複数合法手かつこの空き数以上に限定する。
const ETC_MIN_EMPTIES: u32 = 15;

#[cfg(test)]
std::thread_local! {
    static TEST_ETC_MIN_EMPTIES: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
    static TEST_ETC_CUTOFFS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    // T103: PVSのfull-window再探索(null windowの反証に失敗し、通常窓で
    // 取り直した回数)を数える。「再探索経路が実際に通った」ことをテストで
    // 確認するためのテスト専用テレメトリで、本番探索の挙動には一切影響しない。
    static TEST_RESEARCH_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    // T104: `solve_shallow`が実際に空き0〜4のどのケースへ何回ディスパッチ
    // したかを数える(index = 空きマス数)。「専用層が実際に呼ばれたこと」
    // (発火0件のままpassしない、という指示)をテストで確認するための
    // テスト専用テレメトリで、本番探索の挙動には一切影響しない。
    static TEST_SHALLOW_DISPATCH_COUNTS: std::cell::Cell<[u64; 5]> =
        const { std::cell::Cell::new([0; 5]) };
    // T105: `negamax`が増分計算した子/パスhashと、盤面全体を舐める
    // `zobrist_hash`のフル再計算を照合した(`debug_assert_eq!`を通過した)
    // 回数を数える。「発火0件のままpassしない」ことをテストで確認するための
    // テスト専用テレメトリで、本番探索の挙動には一切影響しない。
    static TEST_INCREMENTAL_HASH_CHECKS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn etc_min_empties() -> u32 {
    #[cfg(test)]
    if let Some(override_value) = TEST_ETC_MIN_EMPTIES.with(std::cell::Cell::get) {
        return override_value;
    }
    ETC_MIN_EMPTIES
}

#[cfg(test)]
fn record_etc_cutoff() {
    TEST_ETC_CUTOFFS.set(TEST_ETC_CUTOFFS.get() + 1);
}

#[cfg(test)]
fn record_pvs_research() {
    TEST_RESEARCH_COUNT.set(TEST_RESEARCH_COUNT.get() + 1);
}

#[cfg(test)]
fn record_shallow_dispatch(empties_count: usize) {
    TEST_SHALLOW_DISPATCH_COUNTS.with(|cell| {
        let mut counts = cell.get();
        counts[empties_count] += 1;
        cell.set(counts);
    });
}

#[cfg(test)]
fn reset_shallow_dispatch_counts() {
    TEST_SHALLOW_DISPATCH_COUNTS.set([0; 5]);
}

#[cfg(test)]
fn shallow_dispatch_counts() -> [u64; 5] {
    TEST_SHALLOW_DISPATCH_COUNTS.get()
}

#[cfg(test)]
fn record_incremental_hash_check() {
    TEST_INCREMENTAL_HASH_CHECKS.set(TEST_INCREMENTAL_HASH_CHECKS.get() + 1);
}

#[cfg(test)]
fn reset_incremental_hash_checks() {
    TEST_INCREMENTAL_HASH_CHECKS.set(0);
}

#[cfg(test)]
fn incremental_hash_checks() -> u64 {
    TEST_INCREMENTAL_HASH_CHECKS.get()
}

/// 通常入口はETC on。テストは`negamax::<false, _>`を直接選び、公開APIや
/// 実行時設定を増やさずに同一実装のA/B比較を行う。
const DEFAULT_ETC_ENABLED: bool = true;

/// 通常入口はshallow層(空き4以下の専用ソルバー、T104)on。ETCと同じ理由で
/// テストは`negamax::<_, false>`を直接選び、公開APIや実行時設定を増やさずに
/// 「専用層あり/なし」のA/B比較(node計上・正しさの検証)を行う。
const DEFAULT_SHALLOW_ENABLED: bool = true;

const fn make_quadrant_ids() -> [u8; 64] {
    let mut ids = [0u8; 64];
    let mut square = 0usize;
    while square < 64 {
        let file_half = if square % 8 >= 4 { 1 } else { 0 };
        let rank_half = if square / 8 >= 4 { 2 } else { 0 };
        ids[square] = 1u8 << (file_half + rank_half);
        square += 1;
    }
    ids
}

/// 各マスが属する固定象限を示すone-hot bit。
const QUADRANT_ID: [u8; 64] = make_quadrant_ids();

fn initial_quadrant_parity(board: &Board) -> u8 {
    let mut parity = 0u8;
    let mut empties = !(board.black | board.white);
    while empties != 0 {
        let square = empties.trailing_zeros() as usize;
        parity ^= QUADRANT_ID[square];
        empties &= empties - 1;
    }
    parity
}

/// ルート局面の空きマスビットマスクを求める(T105 stage3)。以後
/// `negamax`/`negamax_child`/`solve_shallow`はこの値を`board`から
/// 再導出せず、着手ごとに`empty_squares & !mv`で増分更新して渡し合う。
fn initial_empty_squares(board: &Board) -> u64 {
    !(board.black | board.white)
}

fn square_class(mv: u64) -> u8 {
    if mv & (X_SQUARE_MASK | C_SQUARE_MASK) != 0 {
        1
    } else {
        0
    }
}

/// Precomputed child position and ordering data for one legal endgame move.
/// The move list uses a fixed-size stack buffer because a board has only 64 squares.
#[derive(Clone, Copy)]
struct MoveInfo {
    mv: u64,
    square: u8,
    flips: u64,
    next_board: Board,
    child_hash: u64,
    opp_mobility: u32,
    is_corner: bool,
    square_class: u8,
    is_odd_quadrant: bool,
    is_tt_move: bool,
}

impl MoveInfo {
    const EMPTY: Self = Self {
        mv: 0,
        square: 0,
        flips: 0,
        next_board: Board { black: 0, white: 0 },
        child_hash: 0,
        opp_mobility: 0,
        is_corner: false,
        square_class: 0,
        is_odd_quadrant: false,
        is_tt_move: false,
    };

    fn sort_key(self) -> (u8, u8, u32, u8, u8, u8) {
        (
            if self.is_tt_move { 0 } else { 1 },
            if self.is_corner { 0 } else { 1 },
            self.opp_mobility,
            self.square_class,
            if self.is_odd_quadrant { 0 } else { 1 },
            self.square,
        )
    }
}

/// 子手番視点のTT boundから、親のfail-highを安全に証明できる値を返す。
/// Upper/Exactだけが「子の真値 <= score」を保証する。Lowerは逆向きなので
/// このcutoffには決して使用しない。
fn etc_cutoff_score(entry: TTEntry, child_empties: u32, beta: i32) -> Option<i32> {
    if entry.depth as u32 >= child_empties
        && matches!(entry.bound, Bound::Exact | Bound::Upper)
        && entry.score <= -beta
    {
        Some(-entry.score)
    } else {
        None
    }
}

/// 終局時の最終石差 (`side` から見た値) を計算する。
///
/// `board` が真に終局(両者合法手なし、または空きマス0)であることを
/// 前提とする。空きマスが残っている場合は「石数が多い方が総取り」する
/// 慣習を適用する。
///
/// `search.rs` の `terminal_score_centi` から再利用されるため `pub(crate)`
/// にしている(終局ロジックの重複実装を避けるため。T007)。
pub(crate) fn final_score(board: &Board, side: Side) -> i32 {
    let black = board.black.count_ones() as i32;
    let white = board.white.count_ones() as i32;
    let empties = 64 - black - white;

    let (black, white) = match black.cmp(&white) {
        std::cmp::Ordering::Greater => (black + empties, white),
        std::cmp::Ordering::Less => (black, white + empties),
        std::cmp::Ordering::Equal => (black, white),
    };

    let diff = black - white;
    match side {
        Side::Black => diff,
        Side::White => -diff,
    }
}

// =========================================================================
// T104: 空き1〜4専用ソルバーとshallow層
//
// 探索木の末端(空き1〜4)は全ノードの大半を占める一方、汎用の`negamax`は
// TT probe/store・Zobrist hash再計算・`MoveInfo`生成とソートといった
// 1ノードあたりのオーバーヘッドを常に払っている。以下の`solve_1`〜
// `solve_4`は、`Board`/`Side`の汎用APIを経由せず手番相対のビットボード
// (`player`=手番側の石, `opponent`=相手側の石)と空きマスのビット位置
// リストを直接扱うことで、このオーバーヘッドを避ける
// (設計レポート§3.1・§3.6)。
//
// ## ノード計上(設計レポート§3.6・§7「node budgetの意味変更」対策)
//
// `negamax`は呼び出されるたびに(パスの再帰・空き0の早期returnも含めて)
// 無条件に`*nodes += 1`する、という「1回の関数呼び出し = 1論理局面の
// 訪問」という定義を持つ。専用化によってこの定義を変えてしまうと、
// (例えば専用層に入った途端ノードがほぼ無料になるなどすると)
// `node_limit`によるexact quotaの意味が施策前後で変わってしまう
// (過少計上によるquotaの実質的な緩和は設計レポート§7で明示的にリスクと
// されている)。そのため`solve_1`〜`solve_4`・`solve_shallow`は、
// 実際に子局面を再帰的に構築する代わりに直接計算で済ませる箇所でも、
// 「`negamax`ならその計算のために何回自分自身を呼び出したはずか」を
// 数えた分だけ`nodes`を増やす(各関数のドキュメント参照)。
// =========================================================================

/// shallow層(`solve_1`〜`solve_4`)を適用する空きマス数の上限(T104)。
///
/// 設計レポート§3.1・本タスク当初要件の「空き4以下」に合わせ`4`とした。
/// TT probe/store・Zobrist hash・移動排序を持たない専用層はTTによる
/// transposition再利用ができないため、FFO合計ノードがbaseline
/// (コミット`bdb4389`)比+28.63%増加し(`CornerThenParity`静的順序付け
/// 込みの実測、2026-07-16 redo#1)、C2 512kベンチの完走数も6→5に回帰する
/// (実測・詳細比較表は本タスクの作業ログ参照)。
///
/// 2026-07-16 redo#2でこの回帰を解消するため`SHALLOW_MAX_EMPTIES`自体を
/// ablationし(2にすればFFOノード増+6.0%・C2 512k完走数6/180で両方
/// クリアすることを確認済み)、一時的に`2`を採用していたが、
/// 同日中にユーザー裁定により**`4`へ戻し、C2 512k完走数非減・FFOノード
/// +10%以内のゲートは本タスクではwaiveする**(「ノード予算の話をすると
/// 厄介すぎる、T105に進みたい」という方針判断。ノード予算(160k)との
/// 整合はT107のexactポリシー再校正で扱う、STATUS.md申し送り参照)。
/// 主判定であるNPS 1.3倍以上は`4`でも十分に達成している
/// (作業ログの公式NPS計測結果を参照)。
const SHALLOW_MAX_EMPTIES: u32 = 4;

/// 手番相対のビットボード(`player`=手番側の石、`opponent`=相手側の石)から、
/// `Board`/`Side`を経由せず直接最終石差を計算する。[`final_score`]と同じ
/// 「総取り規約」を適用する、shallow層(T104)専用の下位関数。
fn final_score_relative(player: u64, opponent: u64) -> i32 {
    let player_count = player.count_ones() as i32;
    let opp_count = opponent.count_ones() as i32;
    let empties = 64 - player_count - opp_count;

    match player_count.cmp(&opp_count) {
        std::cmp::Ordering::Greater => (player_count + empties) - opp_count,
        std::cmp::Ordering::Less => player_count - (opp_count + empties),
        std::cmp::Ordering::Equal => 0,
    }
}

/// `solve_1`〜`solve_4`・[`solve_shallow`]の入口で共通に使う、`negamax`と
/// 同じnode/time予算チェック(T104)。`negamax`本体が行う
/// 「`*nodes += 1` → `timed_out`確認 → `node_limit`確認 → 一定間隔での
/// `budget`確認」という一連の判定を、専用ソルバー内でも同じ地点・同じ定義で
/// 行うための共通ヘルパー。中断が既に発生していたか、この呼び出しで新たに
/// 中断が確定した場合は`Some(0)`(`negamax`がtimed_out時に返す、値に意味の
/// ないプレースホルダと同じ)を返す。継続してよい場合は`None`を返す。
#[inline]
fn shallow_budget_guard(
    nodes: &mut u64,
    node_limit: Option<u64>,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> Option<i32> {
    *nodes += 1;
    if *timed_out {
        return Some(0);
    }
    if node_limit.is_some_and(|limit| *nodes >= limit) {
        *timed_out = true;
        return Some(0);
    }
    if let Some(budget) = budget {
        if *nodes % TIME_CHECK_NODE_INTERVAL == 0 && budget.expired() {
            *timed_out = true;
            return Some(0);
        }
    }
    None
}

/// 長さ2の空きマスリストから、`used`以外のもう1マスを返す。
fn other_of_2(squares: [u8; 2], used: u8) -> u8 {
    if squares[0] == used {
        squares[1]
    } else {
        squares[0]
    }
}

/// 長さ3の空きマスリストから、`used`を取り除いた残り2マスを返す
/// (順序は元のリストの順序を保つ)。
fn others_of_3(squares: [u8; 3], used: u8) -> [u8; 2] {
    let mut out = [0u8; 2];
    let mut i = 0usize;
    for &sq in squares.iter() {
        if sq != used {
            out[i] = sq;
            i += 1;
        }
    }
    out
}

/// 長さ4の空きマスリストから、`used`を取り除いた残り3マスを返す
/// (順序は元のリストの順序を保つ)。
fn others_of_4(squares: [u8; 4], used: u8) -> [u8; 3] {
    let mut out = [0u8; 3];
    let mut i = 0usize;
    for &sq in squares.iter() {
        if sq != used {
            out[i] = sq;
            i += 1;
        }
    }
    out
}

/// 空き1の局面を`Board`を経由せず解く(count_last_flip相当、T104)。
///
/// `player`/`opponent`は手番側から見たビットボード、`empty_sq`は唯一残った
/// 空きマスのビット位置(0..63)。`nodes`・`node_limit`・`budget`・
/// `timed_out`の意味は`negamax`と同じ。
///
/// # ノード計上について
///
/// 素朴な`negamax`は空き1の局面に対して次のいずれかの回数だけ自分自身を
/// (直接・間接に)呼び出す。
///
/// - 手番側がその1マスに置ける場合: このノード自身(1) + 着手後の空き0局面
///   (1) = 2回。
/// - 手番側は置けないが相手は置ける場合: このノード自身(1) + パス後の
///   (同じ局面・手番だけ入れ替えた)ノード(1) + 相手の着手後の空き0局面
///   (1) = 3回。
/// - どちらも置けない(総取り規約の終局): このノード自身(1)のみ。
///
/// この関数は、実際に子局面を再帰的に訪問する代わりに`count_last_flip`的な
/// 直接計算で済ませているが、上記いずれの分岐でも`negamax`と同じ回数だけ
/// `nodes`をカウントする(モジュール冒頭の「T104: 空き1〜4専用ソルバーと
/// shallow層」ドキュメント参照)。
fn solve_1(
    player: u64,
    opponent: u64,
    empty_sq: u8,
    nodes: &mut u64,
    node_limit: Option<u64>,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> i32 {
    if let Some(score) = shallow_budget_guard(nodes, node_limit, budget, timed_out) {
        return score;
    }

    let mv = 1u64 << empty_sq;
    let flips = flips_for_move(player, opponent, mv);
    if flips != 0 {
        // 手番側がここに置ける: 置けば盤面が埋まる。着手後の空き0局面を
        // negamaxが1回余分に訪問するのと同じ意味で+1してから、
        // 盤面を作らずflip数だけから最終石差を直接計算する
        // (count_last_flip相当)。
        *nodes += 1;
        return final_score_relative(player | mv | flips, opponent & !flips);
    }

    let opp_flips = flips_for_move(opponent, player, mv);
    if opp_flips != 0 {
        // 手番側は置けないが、パス後の相手はここに置ける:
        // パス継続の呼び出し1回 + 相手の着手後の空き0局面1回、
        // 合計2回分をnegamaxと同じ定義でカウントする。
        *nodes += 2;
        return -final_score_relative(opponent | mv | opp_flips, player & !opp_flips);
    }

    // 両者ともこの最後のマスに置けない: 総取り規約を適用した終局
    // (このノード自身の1回のみで、追加のノードは発生しない)。
    final_score_relative(player, opponent)
}

/// 空き2の局面を専用に解く(T104)。`squares`は残り2マスのビット位置
/// (順不同)。パス(片方または両方の合法手なし)・早期終局・総取り規約を
/// `negamax`と同じ規約で扱い、子局面は[`solve_1`]に委譲する。
/// TT probe/store・Zobrist hash更新・一般用途のムーブオーダリング
/// (`MoveInfo`生成・ソート)は一切行わない。
#[allow(clippy::too_many_arguments)]
fn solve_2(
    player: u64,
    opponent: u64,
    squares: [u8; 2],
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    node_limit: Option<u64>,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> i32 {
    if let Some(score) = shallow_budget_guard(nodes, node_limit, budget, timed_out) {
        return score;
    }

    let mut legal = [(0u8, 0u64); 2];
    let mut legal_count = 0usize;
    for &sq in squares.iter() {
        let flips = flips_for_move(player, opponent, 1u64 << sq);
        if flips != 0 {
            legal[legal_count] = (sq, flips);
            legal_count += 1;
        }
    }

    if legal_count == 0 {
        let opponent_can_move = squares
            .iter()
            .any(|&sq| flips_for_move(opponent, player, 1u64 << sq) != 0);
        if !opponent_can_move {
            return final_score_relative(player, opponent);
        }
        return -solve_2(
            opponent, player, squares, -beta, -alpha, nodes, node_limit, budget, timed_out,
        );
    }

    let mut best = i32::MIN;
    let mut alpha = alpha;
    for &(sq, flips) in &legal[..legal_count] {
        let mv = 1u64 << sq;
        let child_player = opponent & !flips;
        let child_opponent = player | mv | flips;
        let remaining = other_of_2(squares, sq);
        let score = -solve_1(
            child_player,
            child_opponent,
            remaining,
            nodes,
            node_limit,
            budget,
            timed_out,
        );
        if *timed_out {
            return 0;
        }
        if score > best {
            best = score;
        }
        if best > alpha {
            alpha = best;
        }
        if alpha >= beta {
            break;
        }
    }
    best
}

/// 空き3の局面を専用に解く(T104)。[`solve_2`]と同じ構造で、子局面を
/// [`solve_2`]に委譲する。
#[allow(clippy::too_many_arguments)]
fn solve_3(
    player: u64,
    opponent: u64,
    squares: [u8; 3],
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    node_limit: Option<u64>,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> i32 {
    if let Some(score) = shallow_budget_guard(nodes, node_limit, budget, timed_out) {
        return score;
    }

    let mut legal = [(0u8, 0u64); 3];
    let mut legal_count = 0usize;
    for &sq in squares.iter() {
        let flips = flips_for_move(player, opponent, 1u64 << sq);
        if flips != 0 {
            legal[legal_count] = (sq, flips);
            legal_count += 1;
        }
    }

    if legal_count == 0 {
        let opponent_can_move = squares
            .iter()
            .any(|&sq| flips_for_move(opponent, player, 1u64 << sq) != 0);
        if !opponent_can_move {
            return final_score_relative(player, opponent);
        }
        return -solve_3(
            opponent, player, squares, -beta, -alpha, nodes, node_limit, budget, timed_out,
        );
    }

    let mut best = i32::MIN;
    let mut alpha = alpha;
    for &(sq, flips) in &legal[..legal_count] {
        let mv = 1u64 << sq;
        let child_player = opponent & !flips;
        let child_opponent = player | mv | flips;
        let remaining = others_of_3(squares, sq);
        let score = -solve_2(
            child_player,
            child_opponent,
            remaining,
            -beta,
            -alpha,
            nodes,
            node_limit,
            budget,
            timed_out,
        );
        if *timed_out {
            return 0;
        }
        if score > best {
            best = score;
        }
        if best > alpha {
            alpha = best;
        }
        if alpha >= beta {
            break;
        }
    }
    best
}

/// 空き4の局面を専用に解く(T104)。[`solve_2`]/[`solve_3`]と同じ構造で、
/// 子局面を[`solve_3`]に委譲する。
#[allow(clippy::too_many_arguments)]
fn solve_4(
    player: u64,
    opponent: u64,
    squares: [u8; 4],
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    node_limit: Option<u64>,
    budget: Option<TimeBudget>,
    timed_out: &mut bool,
) -> i32 {
    if let Some(score) = shallow_budget_guard(nodes, node_limit, budget, timed_out) {
        return score;
    }

    let mut legal = [(0u8, 0u64); 4];
    let mut legal_count = 0usize;
    for &sq in squares.iter() {
        let flips = flips_for_move(player, opponent, 1u64 << sq);
        if flips != 0 {
            legal[legal_count] = (sq, flips);
            legal_count += 1;
        }
    }

    if legal_count == 0 {
        let opponent_can_move = squares
            .iter()
            .any(|&sq| flips_for_move(opponent, player, 1u64 << sq) != 0);
        if !opponent_can_move {
            return final_score_relative(player, opponent);
        }
        return -solve_4(
            opponent, player, squares, -beta, -alpha, nodes, node_limit, budget, timed_out,
        );
    }

    let mut best = i32::MIN;
    let mut alpha = alpha;
    for &(sq, flips) in &legal[..legal_count] {
        let mv = 1u64 << sq;
        let child_player = opponent & !flips;
        let child_opponent = player | mv | flips;
        let remaining = others_of_4(squares, sq);
        let score = -solve_3(
            child_player,
            child_opponent,
            remaining,
            -beta,
            -alpha,
            nodes,
            node_limit,
            budget,
            timed_out,
        );
        if *timed_out {
            return 0;
        }
        if score > best {
            best = score;
        }
        if best > alpha {
            alpha = best;
        }
        if alpha >= beta {
            break;
        }
    }
    best
}

/// T104 redo#1: shallow層(`solve_2`〜`solve_4`)が空きマスを走査する順序。
///
/// 初回実装(コミット`4bbca88`)は空きマスを自然なビット順(マス番号昇順)
/// のまま走査しており、`negamax`(shallow層無効時)が使うT103のNWS/PVS
/// 構造や隅優先・相手mobility昇順の排序と比べて枝刈り効率が下がり、
/// FFO合計ノードが+30.3%増加してC2 512k完走数が6→5に回帰した
/// (2026-07-16 redo#1フィードバック参照)。この回帰への対応として、
/// **動的なムーブオーダリング(評価値・mobilityによるソート)ではなく**、
/// `solve_shallow`の入口で一度だけ行う安価な静的並べ替えを導入する
/// (4要素以下の挿入ソート1回のみ、以降の再帰的な子呼び出しは
/// [`other_of_2`]/[`others_of_3`]/[`others_of_4`]が元の順序を保つため、
/// 再帰のたびに並べ替え直す必要はない)。
///
/// - `Parity`: 奇数パリティ象限(空きマス数が奇数の象限)の空きマスを
///   優先する(T100の固定象限パリティと同じ原理: 終盤の奇数理論)。
/// - `AvoidXc`: X/C打ち(隅に隣接する危険マス)を後回しにする静的位置優先。
/// - `ParityThenAvoidXc`: 上記2つを組み合わせ、パリティを主キー・
///   X/C回避を副キーにする。
/// - `None`: 順序付けなし(初回実装との比較用)。
///
/// 採用する変種は`SHALLOW_MOVE_ORDER`定数で固定する(実行時分岐や
/// ユーザー設定は増やさない)。各変種のFFO/C2実測比較は本タスクの
/// 作業ログを参照。
#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum ShallowMoveOrder {
    None,
    Parity,
    AvoidXc,
    ParityThenAvoidXc,
    /// (redo#1追加調査) 隅を最優先する静的位置優先。
    CornerFirst,
    /// (redo#1追加調査) 隅優先を主キー・パリティを副キーにする。
    CornerThenParity,
}

/// 現在採用している変種(計測結果に基づき固定)。
const SHALLOW_MOVE_ORDER: ShallowMoveOrder = ShallowMoveOrder::CornerThenParity;

/// `squares`(shallow層が走査する空きマス配列)を`SHALLOW_MOVE_ORDER`に
/// 従って並べ替える。4要素以下なので単純な挿入ソートで十分
/// (要素数の割にクロージャ呼び出しが増えても影響は無視できる規模)。
/// 最終キーに必ずマス番号を入れ、同点時の順序を決定的にする。
fn order_empties_for_shallow(squares: &mut [u8], quadrant_parity: u8) {
    if SHALLOW_MOVE_ORDER == ShallowMoveOrder::None {
        return;
    }
    let key = |sq: u8| -> (u8, u8, u8) {
        let odd_quadrant_rank = match SHALLOW_MOVE_ORDER {
            ShallowMoveOrder::Parity
            | ShallowMoveOrder::ParityThenAvoidXc
            | ShallowMoveOrder::CornerThenParity => {
                if quadrant_parity & QUADRANT_ID[sq as usize] != 0 {
                    0
                } else {
                    1
                }
            }
            ShallowMoveOrder::None | ShallowMoveOrder::AvoidXc | ShallowMoveOrder::CornerFirst => {
                0
            }
        };
        let avoid_xc_rank = match SHALLOW_MOVE_ORDER {
            ShallowMoveOrder::AvoidXc | ShallowMoveOrder::ParityThenAvoidXc => {
                if (1u64 << sq) & (X_SQUARE_MASK | C_SQUARE_MASK) != 0 {
                    1
                } else {
                    0
                }
            }
            ShallowMoveOrder::None
            | ShallowMoveOrder::Parity
            | ShallowMoveOrder::CornerFirst
            | ShallowMoveOrder::CornerThenParity => 0,
        };
        let corner_rank = match SHALLOW_MOVE_ORDER {
            ShallowMoveOrder::CornerFirst | ShallowMoveOrder::CornerThenParity => {
                if (1u64 << sq) & CORNER_MASK != 0 {
                    0
                } else {
                    1
                }
            }
            ShallowMoveOrder::None
            | ShallowMoveOrder::Parity
            | ShallowMoveOrder::AvoidXc
            | ShallowMoveOrder::ParityThenAvoidXc => 0,
        };
        // CornerFirst/CornerThenParityでは隅優先を最優先キーに置くため、
        // odd_quadrant_rankの位置にcorner_rankを合成する
        // (既存の3要素タプルのまま変種を追加するための実装上の都合)。
        let primary = match SHALLOW_MOVE_ORDER {
            ShallowMoveOrder::CornerFirst | ShallowMoveOrder::CornerThenParity => corner_rank,
            _ => odd_quadrant_rank,
        };
        let secondary = match SHALLOW_MOVE_ORDER {
            ShallowMoveOrder::CornerThenParity => odd_quadrant_rank,
            _ => avoid_xc_rank,
        };
        (primary, secondary, sq)
    };
    // 挿入ソート(要素数<=4)。
    for i in 1..squares.len() {
        let mut j = i;
        while j > 0 && key(squares[j - 1]) > key(squares[j]) {
            squares.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// 空き`SHALLOW_MAX_EMPTIES`以下の局面を、TT probe/store・Zobrist
/// hash更新・一般用途のムーブオーダリング(評価値・mobilityによる動的
/// ソート)を一切行わずに解く(T104)。`negamax`から空きマス数がこの
/// 閾値以下になった時点で委譲される。空きマスの走査順序だけは
/// `order_empties_for_shallow`による安価な静的並べ替えを適用する
/// (T104 redo#1)。
#[allow(clippy::too_many_arguments)]
fn solve_shallow(
    board: &Board,
    side: Side,
    quadrant_parity: u8,
    empty_squares_mask: u64,
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    budget: Option<TimeBudget>,
    node_limit: Option<u64>,
    timed_out: &mut bool,
) -> i32 {
    let (player, opponent) = match side {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };

    // T105 stage3: 呼び出し元(`negamax`)が既に増分管理している空きマス
    // ビットマスクをそのまま使い、`!(board.black | board.white)`による
    // 再導出を行わない。
    let mut empty_squares = [0u8; 4];
    let mut count = 0usize;
    let mut remaining_empties = empty_squares_mask;
    while remaining_empties != 0 {
        let sq = remaining_empties.trailing_zeros() as u8;
        remaining_empties &= remaining_empties - 1;
        empty_squares[count] = sq;
        count += 1;
    }

    order_empties_for_shallow(&mut empty_squares[..count], quadrant_parity);

    #[cfg(test)]
    record_shallow_dispatch(count);

    match count {
        0 => {
            // 盤面が完全に埋まっている: negamaxの`empties == 0`早期return
            // と同じく、このノード自身の1回だけをカウントする。
            *nodes += 1;
            final_score_relative(player, opponent)
        }
        1 => solve_1(
            player,
            opponent,
            empty_squares[0],
            nodes,
            node_limit,
            budget,
            timed_out,
        ),
        2 => solve_2(
            player,
            opponent,
            [empty_squares[0], empty_squares[1]],
            alpha,
            beta,
            nodes,
            node_limit,
            budget,
            timed_out,
        ),
        3 => solve_3(
            player,
            opponent,
            [empty_squares[0], empty_squares[1], empty_squares[2]],
            alpha,
            beta,
            nodes,
            node_limit,
            budget,
            timed_out,
        ),
        4 => solve_4(
            player,
            opponent,
            [
                empty_squares[0],
                empty_squares[1],
                empty_squares[2],
                empty_squares[3],
            ],
            alpha,
            beta,
            nodes,
            node_limit,
            budget,
            timed_out,
        ),
        _ => unreachable!(
            "solve_shallow must only be called with empty_count() <= SHALLOW_MAX_EMPTIES"
        ),
    }
}

/// 空きマスが少ない局面を完全読みし、`side_to_move` から見た最終石差を返す。
///
/// 返り値は centi-disc スケールではなく素の石差 (1石=1) であることに注意
/// (モジュール冒頭のドキュメント参照)。
///
/// 時間予算を一切持たない(無条件に終局まで読み切る)。FFOベンチ(T009)・
/// 詰めオセロ/対局/定石練習モードなど、「完全な正解値が必要で、かつ
/// 呼び出し元がそもそも`time_ms`を指定しない」用途で使う。時間予算を
/// 課したい場合は[`solve_exact_bounded`](T034)を使うこと。
pub fn solve_exact(board: &Board, side_to_move: Side, tt: &mut TranspositionTable) -> i32 {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    negamax::<DEFAULT_ETC_ENABLED, DEFAULT_SHALLOW_ENABLED>(
        board,
        side_to_move,
        initial_quadrant_parity(board),
        initial_empty_squares(board),
        None,
        true, // is_root: ルートではshallow層へ委譲しない(T104 redo#2、B1対策)
        -64,
        64,
        tt,
        &mut nodes,
        None,
        None,
        &mut timed_out,
    )
}

/// [`solve_exact`] と同じ完全読みを行い、結果に加えて探索した(`negamax`
/// を呼び出した)ノード数も返す。
///
/// `solve_exact` の既存シグネチャ・挙動は変更せず、ベンチマーク
/// (`engine/tests/ffo_bench.rs`, T009)がNPSを計測するために追加した
/// テスト・計測専用のエントリポイント。
pub fn solve_exact_with_nodes(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
) -> (i32, u64) {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax::<DEFAULT_ETC_ENABLED, DEFAULT_SHALLOW_ENABLED>(
        board,
        side_to_move,
        initial_quadrant_parity(board),
        initial_empty_squares(board),
        None,
        true, // is_root: ルートではshallow層へ委譲しない(T104 redo#2、B1対策)
        -64,
        64,
        tt,
        &mut nodes,
        None,
        None,
        &mut timed_out,
    );
    (score, nodes)
}

/// [`solve_exact`]に時間予算を持たせたバージョン(T034)。
///
/// # 背景(T034)
/// 本ソルバーはT006のスコープの都合上、安定石による静的カット等の
/// 高度な枝刈りを持たない素朴なalpha-beta+TTである(モジュール冒頭の
/// ドキュメント参照)。空き22前後の局面では通常は高速に完了するが、
/// 特定の「重い」局面(FFO#49のような既知の難問と同種)では、この
/// 素朴な実装だと1回の呼び出しだけで数十秒〜数分かかることが実測で
/// 確認されている。`search.rs`の中盤探索(`negascout`/`search_all_moves`)
/// が`limit.time_ms`(反復深化の時間予算)付きでこの関数を(探索木の
/// 途中で空きマス数がしきい値以下になるたびに)呼び出すケースでは、
/// この1回の呼び出しが時間予算を大幅に超過してしまう(T034調査ログ
/// 参照)。この関数は`start`からの経過時間が`time_ms`を超えたら
/// 探索を打ち切り`None`を返す(結果が不完全なため`Some`の場合と違い
/// 使ってはならない)。打ち切った場合、置換表には格納しない
/// (不完全な探索結果でTTを汚染しないため)。
///
/// `TIME_CHECK_NODE_INTERVAL`ノードごとに`Instant::now()`
/// (WASM上は`Performance.now()`)を呼ぶため、毎ノードチェックするより
/// 十分に軽い。
pub fn solve_exact_bounded(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
    budget: TimeBudget,
) -> Option<i32> {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax::<DEFAULT_ETC_ENABLED, DEFAULT_SHALLOW_ENABLED>(
        board,
        side_to_move,
        initial_quadrant_parity(board),
        initial_empty_squares(board),
        None,
        true, // is_root: ルートではshallow層へ委譲しない(T104 redo#2、B1対策)
        -64,
        64,
        tt,
        &mut nodes,
        Some(budget),
        None,
        &mut timed_out,
    );
    if timed_out {
        None
    } else {
        Some(score)
    }
}

/// [`solve_exact_bounded`]と同じ完全読みを行い、結果に加えて探索した
/// (`negamax`を呼び出した)ノード数も返す(T084)。
///
/// `solve_exact_with_nodes`(T009、無条件版)と対になる、時間予算付き版。
/// 既存の [`solve_exact_bounded`] のシグネチャ・挙動は一切変更していない
/// (本関数はそれとは独立の新規関数であり、`negamax`を同じ引数で呼ぶだけの
/// 薄いラッパー)。`search.rs`の single-root ベストムーブ探索(`search`/
/// `search_with_eval`)が、ルート局面が直接完全読みに委譲された場合の
/// 正確なノード数をテレメトリとして報告するために追加した。
/// タイムアウトした場合(戻り値の `Option<i32>` が `None`)でも、それまでに
/// 訪問したノード数は `u64` 側に返す(呼び出し元が使うかどうかは任意)。
pub fn solve_exact_bounded_with_nodes(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
    budget: TimeBudget,
) -> (Option<i32>, u64) {
    let mut nodes: u64 = 0;
    let mut timed_out = false;
    let score = negamax::<DEFAULT_ETC_ENABLED, DEFAULT_SHALLOW_ENABLED>(
        board,
        side_to_move,
        initial_quadrant_parity(board),
        initial_empty_squares(board),
        None,
        true, // is_root: ルートではshallow層へ委譲しない(T104 redo#2、B1対策)
        -64,
        64,
        tt,
        &mut nodes,
        Some(budget),
        None,
        &mut timed_out,
    );
    if timed_out {
        (None, nodes)
    } else {
        (Some(score), nodes)
    }
}

/// 時間予算・ノード数予算のいずれかで完全読みを打ち切れる版。
/// `node_limit`はこの呼び出し内で訪問できる最大ノード数で、`None`なら
/// 無制限。第3要素は打ち切り理由がノード数予算だった場合に`true`。
pub fn solve_exact_limited_with_nodes(
    board: &Board,
    side_to_move: Side,
    tt: &mut TranspositionTable,
    time_budget: Option<TimeBudget>,
    node_limit: Option<u64>,
) -> (Option<i32>, u64, bool) {
    let outcome = solve_exact_window_limited_with_nodes(
        board,
        side_to_move,
        -64,
        64,
        tt,
        time_budget,
        node_limit,
    );
    (
        outcome.score,
        outcome.nodes,
        outcome.abort_reason == Some(AbortReason::ExactQuota),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbortReason {
    ExactQuota,
    GlobalNodeLimit,
    WallClock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExactSearchOutcome {
    pub score: Option<i32>,
    pub nodes: u64,
    pub abort_reason: Option<AbortReason>,
}

/// fail-soft窓付き完全読み。ノード制限は局所exact quotaとして扱う。
pub fn solve_exact_window_limited_with_nodes(
    board: &Board,
    side_to_move: Side,
    alpha: i32,
    beta: i32,
    tt: &mut TranspositionTable,
    time_budget: Option<TimeBudget>,
    node_limit: Option<u64>,
) -> ExactSearchOutcome {
    let mut nodes = 0;
    let mut aborted = false;
    let score = negamax::<DEFAULT_ETC_ENABLED, DEFAULT_SHALLOW_ENABLED>(
        board,
        side_to_move,
        initial_quadrant_parity(board),
        initial_empty_squares(board),
        None,
        true, // is_root: ルートではshallow層へ委譲しない(T104 redo#2、B1対策)
        alpha.clamp(-64, 64),
        beta.clamp(-64, 64),
        tt,
        &mut nodes,
        time_budget,
        node_limit,
        &mut aborted,
    );
    if aborted {
        ExactSearchOutcome {
            score: None,
            nodes,
            abort_reason: Some(if node_limit.is_some_and(|limit| nodes >= limit) {
                AbortReason::ExactQuota
            } else {
                AbortReason::WallClock
            }),
        }
    } else {
        ExactSearchOutcome {
            score: Some(score),
            nodes,
            abort_reason: None,
        }
    }
}

/// [`solve_exact_bounded`]に渡す時間予算(T034)。`search.rs`の
/// `SearchLimit::time_ms`と同じ意味論(反復深化開始からの累計経過時間)を
/// 完全読みソルバーにも適用できるようにするための小さな値型。
#[derive(Debug, Clone, Copy)]
pub struct TimeBudget {
    pub start: Instant,
    pub time_ms: u64,
}

impl TimeBudget {
    fn expired(&self) -> bool {
        self.start.elapsed().as_millis() as u64 >= self.time_ms
    }
}

/// `negamax`の再帰中に時間予算をチェックする頻度(ノード数に1回)。
/// `search.rs`の`TIME_CHECK_NODE_INTERVAL`と同じ考え方
/// (WASM上での`Instant::now()`のJS境界越えコストを無視できる水準に
/// 抑えつつ、数msのオーダーで超過を検出する)。
const TIME_CHECK_NODE_INTERVAL: u64 = 1024;

/// `negamax`の子局面を1つ探索する薄いラッパー(T103)。
///
/// `MoveInfo`から子盤面・子象限パリティ・子hashを組み立て、手番を反転して
/// `negamax`を呼び、符号反転した子手番視点の値を返す。full-window探索と、
/// PVSのnull window探索・条件付き再探索のいずれからも同じ組み立てロジックを
/// 再利用するために切り出した(重複した引数構築を避けるだけで、探索
/// アルゴリズム自体はここでは何も変えない)。
///
/// T105: `move_info.child_hash`は(ETC対象かどうかによらず)常に親の
/// `hash`から増分計算済みの値であるため、`etc_eligible`による分岐なしに
/// 常に`Some(move_info.child_hash)`を渡せる(以前はETC非対象の子では
/// `None`を渡し、子側で盤面全体を再走査してhashを再計算していた)。
///
/// `parent_empty_squares`(親局面の空きマスビットマスク)から
/// `& !move_info.mv`で子の空きマスマスクを増分更新して渡す(T105 stage3、
/// `board`から`!(black|white)`を再導出しない)。
#[allow(clippy::too_many_arguments)]
fn negamax_child<const ETC_ENABLED: bool, const SHALLOW_ENABLED: bool>(
    move_info: &MoveInfo,
    side: Side,
    quadrant_parity: u8,
    parent_empty_squares: u64,
    child_alpha: i32,
    child_beta: i32,
    tt: &mut TranspositionTable,
    nodes: &mut u64,
    budget: Option<TimeBudget>,
    node_limit: Option<u64>,
    timed_out: &mut bool,
) -> i32 {
    -negamax::<ETC_ENABLED, SHALLOW_ENABLED>(
        &move_info.next_board,
        side.opposite(),
        quadrant_parity ^ QUADRANT_ID[move_info.square as usize],
        parent_empty_squares & !move_info.mv,
        Some(move_info.child_hash),
        false, // is_root: 子局面は常に非ルート(T104 redo#2)
        child_alpha,
        child_beta,
        tt,
        nodes,
        budget,
        node_limit,
        timed_out,
    )
}

/// negamax + fail-soft alpha-beta + TT による完全読み本体。
///
/// `alpha` / `beta` は `side` から見た石差の窓。
/// `nodes` はこの関数が呼び出された回数(訪問局面数)を数える
/// カウンタで、呼び出し元(`solve_exact` / `solve_exact_with_nodes` /
/// `solve_exact_bounded`)が用意したものをそのまま渡す。
///
/// `budget`が`Some`の場合、`timed_out`がまだ立っていなければ
/// `TIME_CHECK_NODE_INTERVAL`ノードごとに`budget.expired()`をチェックする
/// (T034)。超過していれば`timed_out`を立てて即座に`0`を返す(戻り値
/// 自体に意味はない。呼び出し元は`timed_out`を見て結果を丸ごと破棄する)。
/// 一度`timed_out`が立った後の全呼び出しも同様に即座に`0`を返し、
/// 置換表への格納も行わない。`budget`が`None`なら従来どおり無条件に
/// 終局まで読み切る。`ETC_ENABLED`は通常ビルドでは既定onで、テストと
/// 比較計測では同じ探索をcompile-timeにoffへ切り替えられる。
///
/// `SHALLOW_ENABLED`が`true`(通常ビルドの既定)の場合、空きマス数が
/// [`SHALLOW_MAX_EMPTIES`]以下になった時点でTT probe/store・Zobrist
/// hash計算・`MoveInfo`生成/ソートを一切行わない専用層
/// ([`solve_shallow`]、T104)へ委譲する。この分岐は`*nodes`を
/// インクリメントする**前**に行い、node計上の責務を丸ごと`solve_shallow`
/// 側(以降は`solve_1`〜`solve_4`)に渡す(二重カウントを避けるため。
/// モジュール冒頭の「T104: 空き1〜4専用ソルバーとshallow層」ドキュメント
/// 参照)。テストは`negamax::<_, false>`を選ぶことで、この専用層を経由
/// しない従来どおりの汎用パスと比較できる。
///
/// `is_root`が`true`の場合、空きマス数に関わらずこの委譲を行わない
/// (T104 redo#2、レビュー指摘B1対策)。shallow層はTT probe/storeを
/// 一切行わないため、**呼び出し元が最初に問い合わせた局面自体**
/// (`solve_exact`系公開関数からの最外周呼び出し)が空き
/// `SHALLOW_MAX_EMPTIES`以下だと、その局面のTTエントリ(best_move込み)が
/// 一切格納されず、`search.rs`のルートexactパスが`best_move: None`/
/// `pv: []`を返してしまう回帰があった(baseline`bdb4389`は`move`を
/// 正しく返していた)。公開5関数(`solve_exact`/`solve_exact_with_nodes`/
/// `solve_exact_bounded`/`solve_exact_bounded_with_nodes`/
/// `solve_exact_window_limited_with_nodes`)の最外周呼び出しのみ
/// `is_root: true`を渡し、`negamax_child`経由の子呼び出しと自身の
/// パス再帰呼び出しは常に`is_root: false`を渡す(=ルート以外は従来どおり
/// shallow層を経由する、ホットパス・NPSは不変)。
fn negamax<const ETC_ENABLED: bool, const SHALLOW_ENABLED: bool>(
    board: &Board,
    side: Side,
    quadrant_parity: u8,
    empty_squares: u64,
    known_hash: Option<u64>,
    is_root: bool,
    alpha: i32,
    beta: i32,
    tt: &mut TranspositionTable,
    nodes: &mut u64,
    budget: Option<TimeBudget>,
    node_limit: Option<u64>,
    timed_out: &mut bool,
) -> i32 {
    // T105 stage3: 空きマス数は呼び出し元(ルートまたは`negamax_child`)が
    // 増分更新した`empty_squares`から1回だけpopcountする
    // (以前は`board.empty_count()`を本関数内で2回、`board.black|board.white`
    // からの都度導出込みで呼んでいた)。
    let empties = empty_squares.count_ones();

    if SHALLOW_ENABLED && !is_root && empties <= SHALLOW_MAX_EMPTIES {
        return solve_shallow(
            board,
            side,
            quadrant_parity,
            empty_squares,
            alpha,
            beta,
            nodes,
            budget,
            node_limit,
            timed_out,
        );
    }

    *nodes += 1;

    if *timed_out {
        return 0;
    }
    if node_limit.is_some_and(|limit| *nodes >= limit) {
        *timed_out = true;
        return 0;
    }
    if let Some(budget) = budget {
        if *nodes % TIME_CHECK_NODE_INTERVAL == 0 && budget.expired() {
            *timed_out = true;
            return 0;
        }
    }

    if empties == 0 {
        return final_score(board, side);
    }

    let hash = known_hash.unwrap_or_else(|| zobrist_hash(board, side));
    // T103: TT probeでローカルな探索窓を狭める**前**の、呼び出し時点の窓を
    // 保存する。TT格納時のbound判定は必ずこちらを使う(モジュール冒頭の
    // 「alpha_orig / beta_orig」ドキュメント参照)。
    let alpha_orig = alpha;
    let beta_orig = beta;
    let mut alpha = alpha;
    let mut beta = beta;

    let mut tt_move = None;
    if let Some(entry) = tt.probe(hash, TTDomain::Exact) {
        tt_move = entry.best_move;
        // depth には格納時点の空きマス数を入れている。本ソルバーは常に
        // 終局まで完全に読み切るので、格納時の空きマス数が今回以上であれば
        // (=同じ局面なら通常は等しい) そのまま信頼できる。
        if entry.depth as u32 >= empties {
            match entry.bound {
                Bound::Exact => return entry.score,
                Bound::Lower => alpha = alpha.max(entry.score),
                Bound::Upper => beta = beta.min(entry.score),
            }
            if alpha >= beta {
                return entry.score;
            }
        }
    }

    // T105 stage4: own/oppをここで1回だけ取り出し、以後の合法手判定
    // ([`legal_moves_relative`])・子生成(stage1)・opp_mobility計算に
    // 使い回す(`Board::legal_moves`のBlack/White match+
    // `!(board.black|board.white)`の再導出を、増分管理済みの
    // `empty_squares`で置き換える。設計レポート§3.7・§7「黒白絶対表現と
    // relative表現の混同」対策として、`Board`はTT格納・`final_score`・
    // 再帰呼び出しの引数としてのみ扱い、ホットパスの合法手判定・移動生成は
    // own/opp+`empty_squares`のrelative表現に統一する)。
    let (own, opp) = match side {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };
    let legal = legal_moves_relative(own, opp, empty_squares);

    if legal == 0 {
        // 自分に合法手がない: パス。
        if legal_moves_relative(opp, own, empty_squares) == 0 {
            // 相手にも合法手がない: 終局。
            return final_score(board, side);
        }
        // T105 stage2: パスは盤面が変わらず手番だけ入れ替わるため、
        // `toggle_side_to_move`だけで子hashを増分計算できる(盤面全体の
        // 再走査が不要。設計レポート§7「パス時のside key」対策)。
        let pass_hash = toggle_side_to_move(hash);
        debug_assert_eq!(
            pass_hash,
            zobrist_hash(board, side.opposite()),
            "T105 incremental hash mismatch after pass"
        );
        #[cfg(test)]
        record_incremental_hash_check();
        return -negamax::<ETC_ENABLED, SHALLOW_ENABLED>(
            board,
            side.opposite(),
            quadrant_parity,
            empty_squares, // パスは着手なしのため空きマスは不変(T105 stage3)。
            Some(pass_hash),
            false, // is_root: パス再帰は常に非ルート(T104 redo#2)。
            // ルート自身が合法手なし(パス必須)の場合、baseline(bdb4389)
            // でもこの分岐はTT格納前に早期returnするためルート自身のTT
            // エントリは元々格納されない(=この扱いはB1修正の対象外で、
            // 挙動はbaselineと同じまま)。
            -beta,
            -alpha,
            tt,
            nodes,
            budget,
            node_limit,
            timed_out,
        );
    }

    // 合法手を列挙し、TT手 → 隅 → 相手の着手後合法手数が少ない順 →
    // static square class → 固定象限の奇数パリティ → マス番号に並べ替える。
    // パリティはT052の実測に従い、モビリティより下位に維持する。

    let tt_move_bit = tt_move
        .filter(|&square| square < 64)
        .map(|square| 1u64 << square)
        .filter(|&mv| legal & mv != 0);

    let mut moves = [MoveInfo::EMPTY; 64];
    let mut move_count = 0usize;
    let etc_eligible = ETC_ENABLED && empties >= etc_min_empties() && legal.count_ones() > 1;
    // T105 stage1: `own`/`opp`(パス判定の直前で導出済み、stage4)を再利用し、
    // flip maskも`flips_for_move`で1回だけ計算して`apply_move_with_flips`で
    // 子盤面を組み立てる(以前は`board.apply_move`が内部でflipを計算した後、
    // `next_board`との差分から同じflipを逆算しており二重計算だった。
    // T099で保存だけされて未使用だった`MoveInfo.flips`をここで実際に使う)。
    let mut remaining = legal;
    while remaining != 0 {
        let mv = remaining & remaining.wrapping_neg();
        remaining &= remaining - 1;
        let square = mv.trailing_zeros() as u8;
        let flips = flips_for_move(own, opp, mv);
        let (new_own, new_opp) = apply_move_with_flips(own, opp, mv, flips);
        let next_board = match side {
            Side::Black => Board {
                black: new_own,
                white: new_opp,
            },
            Side::White => Board {
                black: new_opp,
                white: new_own,
            },
        };
        // T105 stage4: 相手の着手後合法手数も、`next_board.legal_moves`
        // (Black/White match + `!(black|white)`の再導出)を経由せず、
        // 既に手元にある`new_own`/`new_opp`と増分更新した空きマスマスク
        // (`empty_squares & !mv`、flipは空きマスの状態を変えないため
        // `mv`だけ除けばよい)から直接求める。
        let child_empty_squares = empty_squares & !mv;
        let opp_mobility = legal_moves_relative(new_opp, new_own, child_empty_squares).count_ones();
        // T105 stage2: 子hashは常に親の`hash`からの増分計算(盤面全体の
        // 再走査なし)。以前は`etc_eligible`のときだけこの計算(当時は
        // `zobrist_hash`によるフルスキャン)を行い、それ以外は`0`
        // (未使用のプレースホルダ)にしていたが、増分計算はフルスキャンより
        // 大幅に軽いため常に計算してよく、`negamax_child`が`etc_eligible`
        // によらず常にこの値を子へ渡せるようになる(全ノードでの
        // hash再計算を回避)。
        let child_hash = incremental_move_hash(hash, square, side, flips);
        debug_assert_eq!(
            child_hash,
            zobrist_hash(&next_board, side.opposite()),
            "T105 incremental hash mismatch at square {square}"
        );
        #[cfg(test)]
        record_incremental_hash_check();
        moves[move_count] = MoveInfo {
            mv,
            square,
            flips,
            next_board,
            child_hash,
            opp_mobility,
            is_corner: mv & CORNER_MASK != 0,
            square_class: square_class(mv),
            is_odd_quadrant: quadrant_parity & QUADRANT_ID[square as usize] != 0,
            is_tt_move: tt_move_bit == Some(mv),
        };
        move_count += 1;
    }
    moves[..move_count].sort_unstable_by_key(|info| info.sort_key());

    if etc_eligible {
        let child_empties = empties - 1;
        for move_info in &moves[..move_count] {
            let cutoff = tt
                .probe(move_info.child_hash, TTDomain::Exact)
                .and_then(|entry| etc_cutoff_score(entry, child_empties, beta));
            if let Some(score) = cutoff {
                #[cfg(test)]
                record_etc_cutoff();
                tt.store(TTEntry {
                    hash,
                    domain: TTDomain::Exact,
                    depth: empties as i8,
                    score,
                    bound: Bound::Lower,
                    best_move: Some(move_info.square),
                });
                return score;
            }
        }
    }

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;
    // 呼び出し窓が既に狭い場合、以下のPVS分岐(1手目full window→2手目以降
    // null window→条件付き再探索)は数学的に単一窓ループと同じ結果になる
    // (null windowの反証条件`alpha < score < beta`が常に偽になるため)。
    // 無駄な分岐を避け、そのまま単一窓で探索する(モジュール冒頭の
    // 「NWS中心のPVS構造」ドキュメント参照)。
    let narrow_window = beta - alpha <= 1;

    for (index, move_info) in moves[..move_count].iter().enumerate() {
        let score = if narrow_window || index == 0 {
            negamax_child::<ETC_ENABLED, SHALLOW_ENABLED>(
                move_info,
                side,
                quadrant_parity,
                empty_squares,
                -beta,
                -alpha,
                tt,
                nodes,
                budget,
                node_limit,
                timed_out,
            )
        } else {
            // まずnull window `(-(alpha+1), -alpha)` でこの手が現在のalphaを
            // 上回れないことの反証を試みる。
            let null_score = negamax_child::<ETC_ENABLED, SHALLOW_ENABLED>(
                move_info,
                side,
                quadrant_parity,
                empty_squares,
                -(alpha + 1),
                -alpha,
                tt,
                nodes,
                budget,
                node_limit,
                timed_out,
            );
            if *timed_out {
                // 打ち切られた探索の戻り値は一切使わない(T034/T103契約)。
                return 0;
            }
            if null_score > alpha && null_score < beta {
                // 反証に失敗した(=alphaを上回りうる): 通常窓で再探索する。
                #[cfg(test)]
                record_pvs_research();
                negamax_child::<ETC_ENABLED, SHALLOW_ENABLED>(
                    move_info,
                    side,
                    quadrant_parity,
                    empty_squares,
                    -beta,
                    -alpha,
                    tt,
                    nodes,
                    budget,
                    node_limit,
                    timed_out,
                )
            } else {
                null_score
            }
        };

        if *timed_out {
            // 子の探索が時間切れで打ち切られた: このノードの計算は不完全
            // なため、置換表に格納せず即座に展開する(T034)。
            return 0;
        }

        if score > best_score {
            best_score = score;
            best_move = Some(move_info.square);
        }
        if best_score > alpha {
            alpha = best_score;
        }
        if alpha >= beta {
            break;
        }
    }

    // T103: 呼び出し時点の窓(alpha_orig/beta_orig)を基準にbound判定する
    // (TT probeでローカルに狭めた後のalpha/betaを使わない。モジュール冒頭の
    // ドキュメント参照)。
    let bound = if best_score <= alpha_orig {
        Bound::Upper
    } else if best_score >= beta_orig {
        Bound::Lower
    } else {
        Bound::Exact
    };

    tt.store(TTEntry {
        hash,
        domain: TTDomain::Exact,
        depth: empties as i8,
        score: best_score,
        bound,
        best_move,
    });

    best_score
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EtcTestScope {
        previous_min_empties: Option<u32>,
    }

    impl EtcTestScope {
        fn new(min_empties: u32) -> Self {
            let previous_min_empties = TEST_ETC_MIN_EMPTIES.replace(Some(min_empties));
            TEST_ETC_CUTOFFS.set(0);
            Self {
                previous_min_empties,
            }
        }
    }

    impl Drop for EtcTestScope {
        fn drop(&mut self) {
            TEST_ETC_MIN_EMPTIES.set(self.previous_min_empties);
            TEST_ETC_CUTOFFS.set(0);
        }
    }

    fn solve_with_etc<const ETC_ENABLED: bool, const SHALLOW_ENABLED: bool>(
        board: &Board,
        side: Side,
        min_empties: u32,
    ) -> (i32, u64, u64) {
        let _scope = EtcTestScope::new(min_empties);
        let mut tt = TranspositionTable::new(4);
        let mut nodes = 0;
        let mut aborted = false;
        let score = negamax::<ETC_ENABLED, SHALLOW_ENABLED>(
            board,
            side,
            initial_quadrant_parity(board),
            initial_empty_squares(board),
            None,
            // is_root: false固定。この関数は`negamax`自体(shallow委譲の
            // on/off込み)を直接A/Bテストするためのヘルパーであり、
            // `is_root: true`にすると空き<=4の局面でshallow分岐自体が
            // 常に無効化されてしまいテストの意味がなくなる(T104 redo#2)。
            false,
            -64,
            64,
            &mut tt,
            &mut nodes,
            None,
            None,
            &mut aborted,
        );
        assert!(!aborted);
        (score, nodes, TEST_ETC_CUTOFFS.get())
    }

    fn solve_with_seeded_child_etc<const ETC_ENABLED: bool, const SHALLOW_ENABLED: bool>(
        board: &Board,
        side: Side,
        min_empties: u32,
    ) -> (i32, u64, u64) {
        let legal = board.legal_moves(side);
        assert!(legal.count_ones() > 1);

        let mut best_score = i32::MIN;
        let mut best_child = None;
        let mut remaining = legal;
        while remaining != 0 {
            let mv = remaining & remaining.wrapping_neg();
            remaining &= remaining - 1;
            let child = board.apply_move(side, mv);
            let child_score =
                solve_with_etc::<false, SHALLOW_ENABLED>(&child, side.opposite(), min_empties).0;
            let score = -child_score;
            if score > best_score {
                best_score = score;
                best_child = Some((child, child_score));
            }
        }

        let (best_child, child_score) = best_child.unwrap();
        let _scope = EtcTestScope::new(min_empties);
        let mut tt = TranspositionTable::new(4);
        tt.store(TTEntry {
            hash: zobrist_hash(&best_child, side.opposite()),
            domain: TTDomain::Exact,
            depth: (board.empty_count() - 1) as i8,
            score: child_score,
            bound: Bound::Exact,
            best_move: None,
        });
        let mut nodes = 0;
        let mut aborted = false;
        let score = negamax::<ETC_ENABLED, SHALLOW_ENABLED>(
            board,
            side,
            initial_quadrant_parity(board),
            initial_empty_squares(board),
            None,
            false, // is_root: 上のsolve_with_etcと同じ理由でfalse固定。
            best_score - 1,
            best_score,
            &mut tt,
            &mut nodes,
            None,
            None,
            &mut aborted,
        );
        assert!(!aborted);
        (score, nodes, TEST_ETC_CUTOFFS.get())
    }

    fn exact_entry(depth: i8, score: i32, bound: Bound) -> TTEntry {
        TTEntry {
            hash: 0,
            domain: TTDomain::Exact,
            depth,
            score,
            bound,
            best_move: None,
        }
    }

    #[test]
    fn move_info_sort_key_prioritizes_tt_move_and_breaks_ties_by_square() {
        let mut tt_move = MoveInfo::EMPTY;
        tt_move.square = 63;
        tt_move.is_tt_move = true;

        let mut corner = MoveInfo::EMPTY;
        corner.square = 0;
        corner.is_corner = true;

        assert!(tt_move.sort_key() < corner.sort_key());

        let mut lower_square = MoveInfo::EMPTY;
        lower_square.square = 12;
        let mut higher_square = lower_square;
        higher_square.square = 13;
        assert!(lower_square.sort_key() < higher_square.sort_key());
    }

    #[test]
    fn move_info_sort_key_keeps_corner_mobility_square_class_parity_order() {
        let mut corner = MoveInfo::EMPTY;
        corner.is_corner = true;
        corner.opp_mobility = 63;
        corner.square_class = 1;

        let mut non_corner = MoveInfo::EMPTY;
        non_corner.opp_mobility = 0;
        assert!(corner.sort_key() < non_corner.sort_key());

        let mut lower_mobility = MoveInfo::EMPTY;
        lower_mobility.opp_mobility = 1;
        lower_mobility.square_class = 1;
        let mut better_square_class = MoveInfo::EMPTY;
        better_square_class.opp_mobility = 2;
        better_square_class.square_class = 0;
        assert!(lower_mobility.sort_key() < better_square_class.sort_key());

        let mut normal_square = MoveInfo::EMPTY;
        normal_square.opp_mobility = 1;
        normal_square.square_class = 0;
        let mut odd_bad_square = MoveInfo::EMPTY;
        odd_bad_square.opp_mobility = 1;
        odd_bad_square.square_class = 1;
        odd_bad_square.is_odd_quadrant = true;
        assert!(normal_square.sort_key() < odd_bad_square.sort_key());

        let mut odd = MoveInfo::EMPTY;
        odd.is_odd_quadrant = true;
        odd.square = 63;
        let mut even = MoveInfo::EMPTY;
        even.square = 0;
        assert!(odd.sort_key() < even.sort_key());
    }

    #[test]
    fn etc_accepts_only_deep_enough_exact_or_upper_child_bounds() {
        assert_eq!(
            etc_cutoff_score(exact_entry(9, -12, Bound::Exact), 9, 10),
            Some(12)
        );
        assert_eq!(
            etc_cutoff_score(exact_entry(9, -10, Bound::Upper), 9, 10),
            Some(10)
        );
        assert_eq!(
            etc_cutoff_score(exact_entry(9, -12, Bound::Lower), 9, 10),
            None
        );
        assert_eq!(
            etc_cutoff_score(exact_entry(8, -12, Bound::Upper), 9, 10),
            None
        );
        assert_eq!(
            etc_cutoff_score(exact_entry(9, -9, Bound::Upper), 9, 10),
            None
        );
    }

    #[test]
    fn quadrant_ids_match_four_fixed_board_quadrants() {
        assert_eq!(QUADRANT_ID[0], 0b0001); // a1
        assert_eq!(QUADRANT_ID[27], 0b0001); // d4
        assert_eq!(QUADRANT_ID[4], 0b0010); // e1
        assert_eq!(QUADRANT_ID[31], 0b0010); // h4
        assert_eq!(QUADRANT_ID[32], 0b0100); // a5
        assert_eq!(QUADRANT_ID[59], 0b0100); // d8
        assert_eq!(QUADRANT_ID[36], 0b1000); // e5
        assert_eq!(QUADRANT_ID[63], 0b1000); // h8
    }

    #[test]
    fn quadrant_parity_initialization_and_move_xor_match_recomputation() {
        let board = Board {
            black: !(1u64 << 0 | 1u64 << 1 | 1u64 << 4 | 1u64 << 32),
            white: 0,
        };
        let parity = initial_quadrant_parity(&board);
        assert_eq!(parity, 0b0110);

        let moved = Board {
            black: board.black | 1u64 << 4,
            white: 0,
        };
        assert_eq!(parity ^ QUADRANT_ID[4], initial_quadrant_parity(&moved));
    }
    // =====================================================================
    // 独立した参照実装 (naive reference implementation)
    //
    // solve_exact (alpha-beta + TT) とは別に、枝刈りもTTも一切使わない
    // 素朴なフルウィンドウnegamaxを用意し、両者の結果が一致することを検証する。
    // (Board::legal_moves / apply_move 自体は bitboard.rs で既に検証済みの
    // ものをそのまま利用してよい。ここで独立性を担保したいのは
    // 「探索アルゴリズム(alpha-beta+TTによる枝刈り)が正しいか」である)
    // =====================================================================

    fn naive_final_score(board: &Board, side: Side) -> i32 {
        let black = board.black.count_ones() as i32;
        let white = board.white.count_ones() as i32;
        let empties = 64 - black - white;

        let (black, white) = if black > white {
            (black + empties, white)
        } else if white > black {
            (black, white + empties)
        } else {
            (black, white)
        };

        let diff = black - white;
        match side {
            Side::Black => diff,
            Side::White => -diff,
        }
    }

    fn naive_solve(board: &Board, side: Side) -> i32 {
        if board.empty_count() == 0 {
            return naive_final_score(board, side);
        }

        let legal = board.legal_moves(side);
        if legal == 0 {
            if board.legal_moves(side.opposite()) == 0 {
                return naive_final_score(board, side);
            }
            return -naive_solve(board, side.opposite());
        }

        let mut best = i32::MIN;
        let mut remaining = legal;
        while remaining != 0 {
            let lsb = remaining & remaining.wrapping_neg();
            remaining &= remaining - 1;
            let next_board = board.apply_move(side, lsb);
            let score = -naive_solve(&next_board, side.opposite());
            if score > best {
                best = score;
            }
        }
        best
    }

    // --- テスト用ユーティリティ: 初期局面から決定的に手を進めて空きマスを減らす ---

    /// 初期局面から決定的な戦略で手を進め、空きマスの数が `target_empties` 以下に
    /// なった時点の (Board, 手番) を返す。終局してしまった場合はその時点で返す。
    fn play_until_empties(target_empties: u32, choose: impl Fn(&[u64]) -> u64) -> (Board, Side) {
        let mut board = Board::initial();
        let mut side = Side::Black;

        loop {
            if board.empty_count() <= target_empties || board.is_terminal() {
                return (board, side);
            }

            let legal = board.legal_moves(side);
            if legal == 0 {
                side = side.opposite();
                continue;
            }

            let mut moves: Vec<u64> = Vec::new();
            let mut remaining = legal;
            while remaining != 0 {
                let lsb = remaining & remaining.wrapping_neg();
                moves.push(lsb);
                remaining &= remaining - 1;
            }

            let mv = choose(&moves);
            board = board.apply_move(side, mv);
            side = side.opposite();
        }
    }

    fn first_move_strategy(moves: &[u64]) -> u64 {
        moves[0]
    }

    fn last_move_strategy(moves: &[u64]) -> u64 {
        moves[moves.len() - 1]
    }

    fn middle_move_strategy(moves: &[u64]) -> u64 {
        moves[moves.len() / 2]
    }

    fn random_small_positions(mut state: u64) -> Vec<(Board, Side)> {
        let mut board = Board::initial();
        let mut side = Side::Black;
        let mut positions = Vec::new();

        loop {
            if board.empty_count() <= 10 {
                positions.push((board, side));
            }
            let legal = board.legal_moves(side);
            if legal == 0 {
                if board.legal_moves(side.opposite()) == 0 {
                    break;
                }
                side = side.opposite();
                continue;
            }

            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let selected = (state % legal.count_ones() as u64) as u32;
            let mut remaining = legal;
            for _ in 0..selected {
                remaining &= remaining - 1;
            }
            let mv = remaining & remaining.wrapping_neg();
            board = board.apply_move(side, mv);
            side = side.opposite();
        }
        positions
    }

    #[test]
    fn etc_on_off_scores_match_on_broad_random_small_positions_including_passes() {
        let mut checked = 0usize;
        let mut pass_positions = 0usize;
        let mut seeded_positions = 0usize;
        let mut etc_cutoffs = 0u64;
        for seed in 1..=16 {
            for (board, side) in random_small_positions(seed) {
                let on = solve_with_etc::<true, true>(&board, side, 8);
                let off = solve_with_etc::<false, true>(&board, side, 8);
                assert_eq!(on.0, off.0);
                if board.empty_count() >= 8 && board.legal_moves(side).count_ones() > 1 {
                    let seeded_on = solve_with_seeded_child_etc::<true, true>(&board, side, 8);
                    let seeded_off = solve_with_seeded_child_etc::<false, true>(&board, side, 8);
                    assert_eq!(seeded_on.0, seeded_off.0);
                    seeded_positions += 1;
                    etc_cutoffs += seeded_on.2;
                }
                checked += 1;
                if board.legal_moves(side) == 0 && board.legal_moves(side.opposite()) != 0 {
                    pass_positions += 1;
                }
            }
        }
        assert!(checked >= 160);
        assert!(pass_positions > 0);
        assert!(seeded_positions >= 16);
        assert!(etc_cutoffs > 0);
    }

    /// T105: `negamax`が増分計算した子/パスhashを、`debug_assert_eq!`で
    /// 盤面全体の`zobrist_hash`フル再計算と照合する経路(モジュール本体側の
    /// `record_incremental_hash_check`呼び出し)が、複数seedのランダム
    /// 自己対戦(パスを含む多数の局面)で実際に十分な回数発火していることを
    /// 確認する。`debug_assert_eq!`自体は不一致なら即座にpanicするため、
    /// このテストが完走すること自体が「1件でもズレなかった」ことの証明で
    /// あり、発火件数の下限を課すことで「そもそも一度も通っていないのに
    /// 素通りでpassする」事故を防ぐ(要件5「発火件数の下限つき」)。
    #[test]
    fn incremental_hash_check_fires_across_random_positions_including_passes() {
        reset_incremental_hash_checks();
        let mut checked = 0usize;
        let mut pass_positions = 0usize;
        for seed in 1..=16 {
            for (board, side) in random_small_positions(seed) {
                // min_empties=8: SHALLOW_MAX_EMPTIES(=4)より深いnegamaxの
                // 通常経路(子hash・パスhashの増分計算箇所)を、shallow層に
                // 落ちる前に複数ノード分通過させる。
                let _ = solve_with_etc::<true, true>(&board, side, 8);
                checked += 1;
                if board.legal_moves(side) == 0 && board.legal_moves(side.opposite()) != 0 {
                    pass_positions += 1;
                }
            }
        }
        assert!(checked >= 160);
        assert!(pass_positions > 0);
        assert!(
            incremental_hash_checks() >= 200,
            "expected the incremental-hash debug check to fire at least 200 times, got {}",
            incremental_hash_checks()
        );
    }

    #[test]
    fn fresh_tt_runs_are_deterministic_with_etc() {
        let position = random_small_positions(0x5eed)
            .into_iter()
            .find(|(board, side)| {
                board.empty_count() >= 8 && board.legal_moves(*side).count_ones() > 1
            })
            .unwrap();
        let first = solve_with_seeded_child_etc::<true, true>(&position.0, position.1, 8);
        let second = solve_with_seeded_child_etc::<true, true>(&position.0, position.1, 8);
        assert!(first.2 > 0);
        assert!(second.2 > 0);
        assert_eq!(first, second);
    }

    #[test]
    fn solve_exact_matches_naive_reference_on_small_positions() {
        let strategies: Vec<(&str, fn(&[u64]) -> u64)> = vec![
            ("first", first_move_strategy),
            ("last", last_move_strategy),
            ("middle", middle_move_strategy),
        ];

        for target_empties in [1u32, 2, 3, 4, 5, 6] {
            for (name, strategy) in strategies.iter() {
                let (board, side) = play_until_empties(target_empties, strategy);

                let naive = naive_solve(&board, side);

                let mut tt = TranspositionTable::new(1);
                let solved = solve_exact(&board, side, &mut tt);

                assert_eq!(
                    solved, naive,
                    "[{}] mismatch at target_empties={} (actual empties={}): solve_exact={}, naive={}",
                    name,
                    target_empties,
                    board.empty_count(),
                    solved,
                    naive
                );
            }
        }
    }

    // ------------------------------------------------------------------
    // T103: NWS中心のPVS構造の回帰テスト。
    // ------------------------------------------------------------------
    //
    // `negamax`の子局面探索は「1手目は通常窓、2手目以降はnull windowで
    // 反証を試み、失敗時のみ通常窓で再探索する」というPVS構造になった
    // (モジュール冒頭「NWS中心のPVS構造 (T103)」ドキュメント参照)。
    // 以下のテストは、(1) full window・fail-high狭窓・fail-low狭窓の
    // いずれでも独立実装のnaive_solveと一致すること、(2) TTへ格納される
    // bound種別が呼び出し窓(alpha_orig/beta_orig)を基準に正しく
    // 判定されること、(3) PVSの全窓再探索経路が実際に発火すること
    // (発火0件のままpassしない)を検証する。

    #[test]
    fn pvs_full_and_narrow_windows_match_naive_reference_with_research_firing() {
        TEST_RESEARCH_COUNT.set(0);

        let mut checked_full_against_naive = 0usize;
        let mut checked_narrow_against_naive = 0usize;
        let mut pass_positions = 0usize;
        let mut deep_full_window_checks = 0usize;

        for seed in 1..=40u64 {
            for (board, side) in random_small_positions(seed) {
                if board.legal_moves(side) == 0 && board.legal_moves(side.opposite()) != 0 {
                    pass_positions += 1;
                }

                let hash = zobrist_hash(&board, side);

                if board.empty_count() <= 6 {
                    // naive_solveは枝刈りなしの全探索のため、コストを抑える
                    // ため空き6以下に限定する(既存
                    // `solve_exact_matches_naive_reference_on_small_positions`
                    // と同じ制約)。
                    let truth = naive_solve(&board, side);

                    let mut tt_full = TranspositionTable::new(4);
                    let full = solve_exact_window_limited_with_nodes(
                        &board, side, -64, 64, &mut tt_full, None, None,
                    );
                    assert_eq!(full.score, Some(truth), "full window mismatch");
                    // 空き0(既に終局)・パス局面(手番側に合法手がない)は
                    // `negamax`がTT probe/storeの手前で早期returnするため、
                    // TTへは何も格納されない(モジュール冒頭ドキュメント・
                    // T034の既存契約どおり)。空き`SHALLOW_MAX_EMPTIES`以下は
                    // T104のshallow層(`solve_1`〜`solve_4`)へ委譲され、
                    // そちらもTT probe/storeを一切行わない設計のため
                    // (要件3「TT probe/store...を省略する」)、同様にTT
                    // エントリの存在をアサートしない。
                    if board.empty_count() > SHALLOW_MAX_EMPTIES && board.legal_moves(side) != 0 {
                        let full_entry = tt_full
                            .probe(hash, TTDomain::Exact)
                            .expect("full-window solve should store a TT entry for the root");
                        assert_eq!(full_entry.bound, Bound::Exact);
                        assert_eq!(full_entry.score, truth);
                    }
                    checked_full_against_naive += 1;

                    if board.legal_moves(side).count_ones() > 1 {
                        let mut tt_fh = TranspositionTable::new(4);
                        let fail_high = solve_exact_window_limited_with_nodes(
                            &board,
                            side,
                            truth - 1,
                            truth,
                            &mut tt_fh,
                            None,
                            None,
                        );
                        assert_eq!(fail_high.score, Some(truth), "fail-high window mismatch");
                        if board.empty_count() > SHALLOW_MAX_EMPTIES {
                            let fh_entry = tt_fh
                                .probe(hash, TTDomain::Exact)
                                .expect("fail-high solve should store a TT entry for the root");
                            assert_eq!(fh_entry.bound, Bound::Lower);
                            assert_eq!(fh_entry.score, truth);
                        }

                        let mut tt_fl = TranspositionTable::new(4);
                        let fail_low = solve_exact_window_limited_with_nodes(
                            &board,
                            side,
                            truth,
                            truth + 1,
                            &mut tt_fl,
                            None,
                            None,
                        );
                        assert_eq!(fail_low.score, Some(truth), "fail-low window mismatch");
                        if board.empty_count() > SHALLOW_MAX_EMPTIES {
                            let fl_entry = tt_fl
                                .probe(hash, TTDomain::Exact)
                                .expect("fail-low solve should store a TT entry for the root");
                            assert_eq!(fl_entry.bound, Bound::Upper);
                            assert_eq!(fl_entry.score, truth);
                        }

                        checked_narrow_against_naive += 1;
                    }
                } else {
                    // 空き7〜10: naive比較は計算量的に行わないが、full windowで
                    // 解くことでPVS(null window→条件付き再探索)が実際に動く
                    // より大きな木を増やす。
                    let mut tt = TranspositionTable::new(8);
                    let outcome = solve_exact_window_limited_with_nodes(
                        &board, side, -64, 64, &mut tt, None, None,
                    );
                    assert!(outcome.score.is_some());
                    deep_full_window_checks += 1;
                }
            }
        }

        // 空き12前後のより深い局面も追加し、再探索が発火する木を増やす
        // (naive比較は計算量的に行わない。既存の
        // `solve_exact_completes_within_a_few_seconds_for_around_twelve_empties`
        // と同じ規模)。
        for strategy in [first_move_strategy, last_move_strategy, middle_move_strategy] {
            let (board, side) = play_until_empties(12, strategy);
            let mut tt = TranspositionTable::new(16);
            let outcome =
                solve_exact_window_limited_with_nodes(&board, side, -64, 64, &mut tt, None, None);
            assert!(outcome.score.is_some());
            deep_full_window_checks += 1;
        }

        assert!(
            checked_full_against_naive >= 100,
            "expected at least 100 full-window naive-checked positions, got {checked_full_against_naive}"
        );
        assert!(
            checked_narrow_against_naive >= 40,
            "expected at least 40 narrow-window naive-checked positions, got {checked_narrow_against_naive}"
        );
        assert!(deep_full_window_checks > 0);
        assert!(
            pass_positions > 0,
            "expected at least one pass position among the sampled boards"
        );

        let research_count = TEST_RESEARCH_COUNT.get();
        assert!(
            research_count > 0,
            "expected the PVS full-window re-search path to fire at least once, got 0"
        );
    }

    #[test]
    fn quota_abort_does_not_store_root_hash_in_exact_tt_through_pvs_path() {
        // T103: abortされた探索(null window探索・全窓再探索のいずれで
        // 打ち切られた場合も含む)の戻り値は使わず、置換表にも格納しない
        // という契約(T034)がPVS化後も守られていることを、複数合法手を
        // 持つ(=full windowでPVS分岐が実際に選択される)局面で確認する。
        let mut checked = 0usize;

        for seed in 1..=16u64 {
            for (board, side) in random_small_positions(seed) {
                if board.empty_count() < 6 || board.legal_moves(side).count_ones() < 2 {
                    continue;
                }

                let hash = zobrist_hash(&board, side);

                let mut tt_probe = TranspositionTable::new(4);
                let (_, total_nodes) = solve_exact_with_nodes(&board, side, &mut tt_probe);
                if total_nodes < 4 {
                    continue;
                }
                let node_limit = (total_nodes / 2).max(1);

                let mut tt = TranspositionTable::new(4);
                let outcome = solve_exact_window_limited_with_nodes(
                    &board,
                    side,
                    -64,
                    64,
                    &mut tt,
                    None,
                    Some(node_limit),
                );
                assert_eq!(
                    outcome.score, None,
                    "expected a node budget of half the full node count to abort the search"
                );
                assert_eq!(outcome.abort_reason, Some(AbortReason::ExactQuota));
                assert!(
                    tt.probe(hash, TTDomain::Exact).is_none(),
                    "an aborted root search must not store a (partial) entry for its own hash"
                );

                // 同じttを使い回して打ち切りなしで解いても、フレッシュなttで
                // 解いた場合と完全に同じ答えになる(打ち切られた探索が
                // 何らかの不完全なエントリを残していないことの間接確認)。
                let resumed = solve_exact(&board, side, &mut tt);
                let mut tt_fresh = TranspositionTable::new(4);
                let fresh = solve_exact(&board, side, &mut tt_fresh);
                assert_eq!(resumed, fresh);

                checked += 1;
            }
        }

        assert!(
            checked >= 8,
            "expected several multi-move positions to exercise the quota-abort path through PVS, got {checked}"
        );
    }

    /// `solve_exact(board, Black) == -solve_exact(board, White)` という等式は、
    /// **同じ盤面で両者ともに合法手を持つ場合には一般には成立しない**
    /// (手番が変わればどちらが着手を選ぶかという全く別のゲーム木になるため)。
    /// これは実装のバグではなく、独立実装の `naive_solve` でも同じ非対称な
    /// 結果が再現されることを確認済み(例: ある局面で
    /// `naive_solve(board, Black) = 22`, `naive_solve(board, White) = -16` となり
    /// 合計が0にならない)。
    ///
    /// 一方、**片方の手番に合法手が無い(パス、または終局)局面**に限れば、
    /// この等式は `negamax`/`final_score` の定義から常に成立する
    /// (パス側の値は、実装上そのまま「もう一方の手番での探索結果の符号反転」
    /// として計算されるため)。本テストではこの、常に真である範囲に限定して
    /// 等式を検証する。
    #[test]
    fn solve_exact_result_is_zero_sum_when_at_least_one_side_must_pass() {
        let strategies: Vec<fn(&[u64]) -> u64> = vec![
            first_move_strategy,
            last_move_strategy,
            middle_move_strategy,
        ];

        let mut checked_cases = 0;

        for target_empties in [1u32, 2, 3, 4, 5, 6, 7, 8] {
            for strategy in strategies.iter() {
                let (board, _side) = play_until_empties(target_empties, strategy);

                let black_can_move = board.has_legal_move(Side::Black);
                let white_can_move = board.has_legal_move(Side::White);

                // 両者とも合法手を持つ局面では、上記の理由によりこの等式を
                // 一般には要求できないためスキップする。
                if black_can_move && white_can_move {
                    continue;
                }

                let mut tt_black = TranspositionTable::new(1);
                let score_black = solve_exact(&board, Side::Black, &mut tt_black);

                let mut tt_white = TranspositionTable::new(1);
                let score_white = solve_exact(&board, Side::White, &mut tt_white);

                assert_eq!(
                    score_black, -score_white,
                    "score for Black ({}) should be the negation of score for White ({}) \
                     when at least one side has no legal move",
                    score_black, score_white
                );
                checked_cases += 1;
            }
        }

        assert!(
            checked_cases > 0,
            "expected at least one naturally-occurring pass/terminal position to verify \
             the zero-sum identity against, but none were found among the sampled positions"
        );
    }

    #[test]
    fn solve_exact_on_fully_filled_board_returns_raw_disc_difference() {
        // 空きマス0の盤面を人工的に構築する (黒40, 白24 相当の適当な配置)。
        // 正確な配置内容よりも「空き0のときは総取りルールを介さず
        // 単純な石差がそのまま返る」ことの確認が目的。
        let black = 0xFFFF_FFFF_FF00_0000u64; // 上位40ビット相当
        let white = !black; // 残り24マスすべて白
        let board = Board { black, white };
        assert_eq!(board.empty_count(), 0);

        let mut tt = TranspositionTable::new(1);
        let score_black = solve_exact(&board, Side::Black, &mut tt);
        let expected = black.count_ones() as i32 - white.count_ones() as i32;
        assert_eq!(score_black, expected);

        let mut tt2 = TranspositionTable::new(1);
        let score_white = solve_exact(&board, Side::White, &mut tt2);
        assert_eq!(score_white, -expected);
    }

    #[test]
    fn solve_exact_applies_majority_takes_remaining_empties_rule_on_early_termination() {
        // 両者パスで終局し、かつ空きマスが残っているケースを人工的に構築する。
        // 黒がe7,f7,g7,h7とその上の行以外を全て占め、白は最小限のみ、
        // どちらの色からも隣接する空きマスへの合法手が成立しないよう
        // 空きマスを盤の隅(相手に囲まれない位置)に配置する。
        //
        // ここでは単純化のため、盤面のほぼ全体を黒で埋め、白は黒に隣接しない
        // 1マスの飛び地を作れないため、代わりに「空きマスが黒白どちらにも
        // 囲まれておらず両者とも合法手がない」状況を作る:
        // 全マスを黒で埋め、1マスだけ空けておくと、その空きマスに隣接する
        // マスは全て黒なので白の合法手はなく、黒はその空きマスに置いても
        // 挟める相手石がないため黒も合法手なし = 即終局。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.empty_count(), 1);
        assert!(!board.has_legal_move(Side::Black));
        assert!(!board.has_legal_move(Side::White));
        assert!(board.is_terminal());

        let mut tt = TranspositionTable::new(1);
        let score_black = solve_exact(&board, Side::Black, &mut tt);
        // 黒63石 + 空き1マスを総取り = 64、白0石 => 差は64。
        assert_eq!(score_black, 64);

        let mut tt2 = TranspositionTable::new(1);
        let score_white = solve_exact(&board, Side::White, &mut tt2);
        assert_eq!(score_white, -64);
    }

    #[test]
    fn solve_exact_completes_within_a_few_seconds_for_around_twelve_empties() {
        // 空きマス12前後まで進めた局面を完全読みし、タイムアウトしないことを確認する
        // (正式な速度計測は release ビルドでの実行に譲る。ここでは疎通確認のみ)。
        let (board, side) = play_until_empties(12, first_move_strategy);
        println!(
            "solving position with {} empties (side_to_move={:?})",
            board.empty_count(),
            side
        );

        let start = std::time::Instant::now();
        let mut tt = TranspositionTable::new(64);
        let score = solve_exact(&board, side, &mut tt);
        let elapsed = start.elapsed();

        println!(
            "solve_exact finished in {:?}, empties={}, score={}",
            elapsed,
            board.empty_count(),
            score
        );

        assert!(score.abs() <= 64);
    }

    // ------------------------------------------------------------------
    // T034: `solve_exact_bounded` の時間予算遵守の回帰テスト。
    // ------------------------------------------------------------------
    //
    // 背景: 本ソルバー(`negamax`)は安定石カット等の高度な枝刈りを持たない
    // 素朴なalpha-beta+TTであり、空き20前後でもノード数が数千万〜数億に
    // 達することがある(`engine/tests/ffo_bench.rs`のドキュメント参照。
    // 例: 空き22のFFO#41で約1.9億ノード・75.8秒)。`search.rs`の中盤探索
    // (`negascout`/`search_all_moves`)がこの関数を`limit.time_ms`付きで
    // 呼び出すケースでは、時間予算(例: 1500ms)を数十〜数百倍超過する
    // ハングが実際に本番環境で発生した(棋譜解析モードで最初の1手の解析が
    // 6分以上応答しない、というT033検証での報告)。この回帰テストは、
    // 「時間予算を1msという極端に短い値にしても、探索木がそれなりの
    // 規模を持つ局面(空き18)に対して`solve_exact_bounded`が数秒以内に
    // 確実に打ち切られる(`None`を返す)」ことを検証する。修正前の実装
    // (`solve_exact`を無条件に呼ぶだけ)であれば、この局面の完全読みは
    // 数秒〜数十秒かかるため、本テストは(タイムアウトはしないにせよ)
    // 「時間予算を無視して長時間かかる」という不具合を検出できる。
    #[test]
    fn solve_exact_bounded_returns_none_promptly_when_time_budget_is_tiny_even_for_a_nontrivial_position(
    ) {
        let (board, side) = play_until_empties(18, first_move_strategy);
        assert_eq!(
            board.empty_count(),
            18,
            "test setup should reach exactly 18 empties"
        );

        let mut tt = TranspositionTable::new(64);
        let wall_start = std::time::Instant::now();
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let result = solve_exact_bounded(&board, side, &mut tt, budget);
        let elapsed = wall_start.elapsed();

        println!("solve_exact_bounded(time_ms=1) on 18-empties position finished in {elapsed:?}");

        assert!(
            result.is_none(),
            "a 1ms budget should not be enough to fully solve an 18-empties position, \
             so solve_exact_bounded should report a timeout (None) rather than a (partial/invalid) score"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "solve_exact_bounded should honor the time budget and return within a few seconds \
             (periodic in-recursion check), not block until the full exact solve completes; took {elapsed:?}"
        );
    }

    #[test]
    fn solve_exact_bounded_does_not_poison_the_tt_when_it_times_out() {
        // T034: 時間切れで打ち切られた探索は置換表に格納してはならない
        // (不完全な探索結果が後続の探索・完全読みを汚染しないことの確認)。
        // 同じ`tt`を使い回し、`solve_exact_bounded`がタイムアウトした後、
        // 通常の(無制限の)`solve_exact`で同じ局面を解いても、TTを新規に
        // 使った場合と同じ正しい答えが得られることを確認する。
        let (board, side) = play_until_empties(14, first_move_strategy);

        let mut tt_after_timeout = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let timed_out_result = solve_exact_bounded(&board, side, &mut tt_after_timeout, budget);
        assert!(
            timed_out_result.is_none(),
            "1ms budget should trigger a timeout on this position"
        );

        let score_after_timeout = solve_exact(&board, side, &mut tt_after_timeout);

        let mut tt_fresh = TranspositionTable::new(64);
        let score_fresh = solve_exact(&board, side, &mut tt_fresh);

        assert_eq!(
            score_after_timeout, score_fresh,
            "solve_exact should return the same correct score whether or not the tt was previously \
             used by a solve_exact_bounded call that timed out (i.e. the timed-out call must not have \
             stored any incomplete/incorrect entries into the tt)"
        );
    }

    // ------------------------------------------------------------------
    // T084: `solve_exact_bounded_with_nodes` の回帰テスト。
    // ------------------------------------------------------------------

    #[test]
    fn solve_exact_bounded_with_nodes_matches_solve_exact_when_the_budget_is_generous() {
        // 十分な時間予算があれば、スコアは無条件版と完全に一致し、
        // タイムアウトもしない(`Some`が返る)ことを確認する。
        let (board, side) = play_until_empties(10, first_move_strategy);

        let mut tt_bounded = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 60_000,
        };
        let (score, nodes) = solve_exact_bounded_with_nodes(&board, side, &mut tt_bounded, budget);

        let mut tt_direct = TranspositionTable::new(64);
        let expected = solve_exact(&board, side, &mut tt_direct);

        assert_eq!(
            score,
            Some(expected),
            "with a generous time budget solve_exact_bounded_with_nodes should match solve_exact exactly"
        );
        assert!(
            nodes > 0,
            "solve_exact_bounded_with_nodes should report a positive node count for a non-trivial position"
        );
    }

    #[test]
    fn solve_exact_bounded_with_nodes_times_out_the_same_way_as_solve_exact_bounded() {
        // 極端に短い時間予算では、無条件版と同じくNoneでタイムアウトを
        // 報告することを確認する(ノード数の計測を追加しても、既存の
        // `solve_exact_bounded`のタイムアウト挙動は変わらない)。
        let (board, side) = play_until_empties(18, first_move_strategy);
        assert_eq!(board.empty_count(), 18);

        let mut tt = TranspositionTable::new(64);
        let budget = TimeBudget {
            start: Instant::now(),
            time_ms: 1,
        };
        let (score, nodes) = solve_exact_bounded_with_nodes(&board, side, &mut tt, budget);

        assert!(
            score.is_none(),
            "a 1ms budget should not be enough to fully solve an 18-empties position"
        );
        assert!(
            nodes > 0,
            "even a timed-out call should have visited at least some nodes before giving up"
        );
    }

    // ------------------------------------------------------------------
    // T104: 空き1〜4専用ソルバーとshallow層の回帰テスト。
    // ------------------------------------------------------------------
    //
    // 以下のテストは、(1) 通常手・片側パス・両者パス(早期終局・総取り規約)
    // を含む空き1〜4の局面群で、shallow層(`solve_1`〜`solve_4`)を有効に
    // した`negamax`が独立実装`naive_solve`および専用層を無効化した
    // `negamax::<_, false>`と完全に一致すること、(2) 専用層が実際に
    // (空き0〜4の全パターンで)発火したこと(発火0件のままpassしない)、
    // (3) node_limitによるquota abortが専用層の内部でも正しく機能し、
    // ノード計上が過少にならないこと、を検証する。

    /// 黒だけで盤面のほぼ全体を埋め、`holes`で指定したマスだけを空けた
    /// 局面を作る。白石が1つも存在しないため、どちらの色からも
    /// (相手石を挟めないので)一切合法手がなく、必ず「両者パス→総取り規約」
    /// の早期終局になる(既存の
    /// `solve_exact_applies_majority_takes_remaining_empties_rule_on_early_termination`
    /// と同じ構成を、空き2〜4マスへ一般化したもの)。
    fn all_black_board_with_holes(holes: &[u32]) -> Board {
        let mut black = u64::MAX;
        for &sq in holes {
            black &= !(1u64 << sq);
        }
        Board { black, white: 0 }
    }

    #[test]
    fn solve_shallow_matches_naive_and_generic_negamax_including_all_case_kinds() {
        reset_shallow_dispatch_counts();

        let mut checked_by_empties = [0usize; 5]; // index = empties (1..=4使用)
        let mut one_side_pass_checked = 0usize;
        let mut both_pass_majority_checked = 0usize;

        // 通常手・片側パスは幅広いランダム自己対戦の中から自然に出現する。
        for seed in 1..=80u64 {
            for (board, side) in random_small_positions(seed) {
                let empties = board.empty_count();
                if empties == 0 || empties > 4 {
                    continue;
                }

                let truth = naive_solve(&board, side);
                let (shallow_score, _shallow_nodes, _) =
                    solve_with_etc::<false, true>(&board, side, 8);
                let (generic_score, _generic_nodes, _) =
                    solve_with_etc::<false, false>(&board, side, 8);

                assert_eq!(
                    shallow_score, truth,
                    "shallow-on score should match naive_solve at empties={empties}"
                );
                assert_eq!(
                    generic_score, truth,
                    "shallow-off score should match naive_solve at empties={empties}"
                );
                assert_eq!(
                    shallow_score, generic_score,
                    "shallow-on/off score mismatch at empties={empties}"
                );

                if board.legal_moves(side) == 0 && board.legal_moves(side.opposite()) != 0 {
                    one_side_pass_checked += 1;
                }
                checked_by_empties[empties as usize] += 1;
            }
        }

        // 両者パス(総取り規約)は自然な自己対戦ではまず出現しないため、
        // 空き2・3・4それぞれについて明示的に構築して確実にカバーする
        // (空き1は既存の
        // `solve_exact_applies_majority_takes_remaining_empties_rule_on_early_termination`
        // で確認済み)。
        for holes in [
            vec![9u32, 54], // 空き2 (X-square同士、隣接なし)
            vec![9u32, 54, 27],
            vec![9u32, 54, 27, 36],
        ] {
            let board = all_black_board_with_holes(&holes);
            assert_eq!(board.empty_count() as usize, holes.len());
            assert!(!board.has_legal_move(Side::Black));
            assert!(!board.has_legal_move(Side::White));
            assert!(board.is_terminal());

            for &side in &[Side::Black, Side::White] {
                let truth = naive_solve(&board, side);
                let (shallow_score, _, _) = solve_with_etc::<false, true>(&board, side, 8);
                let (generic_score, _, _) = solve_with_etc::<false, false>(&board, side, 8);
                assert_eq!(shallow_score, truth);
                assert_eq!(generic_score, truth);
                assert_eq!(shallow_score, generic_score);
            }
            both_pass_majority_checked += 1;
        }

        assert!(
            checked_by_empties[1] > 0
                && checked_by_empties[2] > 0
                && checked_by_empties[3] > 0
                && checked_by_empties[4] > 0,
            "expected naturally-occurring positions at every empties count 1..=4, got {:?}",
            checked_by_empties
        );
        assert!(
            one_side_pass_checked > 0,
            "expected at least one naturally-occurring one-side-pass position among empties<=4"
        );
        assert_eq!(both_pass_majority_checked, 3);

        // 専用層(solve_1〜solve_4)が実際に発火したことを、発火0件のまま
        // passしないよう明示的に確認する(空き0はsolve_shallowの
        // 早期return分岐だが、本テストでは意図的に踏んでいないため0でよい)。
        // `negamax`が実際に`solve_shallow`へ委譲するのは空き
        // `SHALLOW_MAX_EMPTIES`以下のみ(モジュール冒頭の定数ドキュメント
        // 参照。2026-07-16時点は`4`)なので、発火確認もこの閾値までに
        // 限定する(定数参照にして閾値変更に追従させる。閾値を下げた場合に
        // 備え、solve_3/solve_4自体の正しさは閾値を経由せず直接呼び出す
        // `solve_3_and_solve_4_remain_correct_even_when_unreachable_from_negamax`
        // でも独立に検証している)。
        let dispatch_counts = shallow_dispatch_counts();
        for empties in 1..=SHALLOW_MAX_EMPTIES as usize {
            assert!(
                dispatch_counts[empties] > 0,
                "expected solve_shallow to dispatch at empties={empties} at least once, got {:?}",
                dispatch_counts
            );
        }
    }

    #[test]
    fn solve_3_and_solve_4_remain_correct_even_when_unreachable_from_negamax() {
        // `SHALLOW_MAX_EMPTIES`(モジュール冒頭の定数ドキュメント参照。
        // 2026-07-16時点は`4`のため現在は`negamax`からも到達する)を
        // 一時的に2へ下げていた期間(redo#2)に、`solve_3`/`solve_4`が
        // `negamax`の閾値経由では到達不能になっても無検証にならないよう
        // 追加したテスト。`SHALLOW_MAX_EMPTIES`を再び下げる判断が将来
        // 入ってもこの回帰保護を失わないよう、`negamax`の閾値を経由せず
        // 直接呼び出して独立実装`naive_solve`との一致を確認し続ける。
        let mut checked3 = 0usize;
        let mut checked4 = 0usize;

        for seed in 1..=80u64 {
            for (board, side) in random_small_positions(seed) {
                let empties = board.empty_count();
                if empties != 3 && empties != 4 {
                    continue;
                }

                let (player, opponent) = match side {
                    Side::Black => (board.black, board.white),
                    Side::White => (board.white, board.black),
                };
                let mut squares = [0u8; 4];
                let mut count = 0usize;
                let mut remaining = !(board.black | board.white);
                while remaining != 0 {
                    let sq = remaining.trailing_zeros() as u8;
                    remaining &= remaining - 1;
                    squares[count] = sq;
                    count += 1;
                }
                assert_eq!(count, empties as usize);

                let truth = naive_solve(&board, side);
                let mut nodes = 0u64;
                let mut timed_out = false;
                let direct_score = if empties == 3 {
                    checked3 += 1;
                    solve_3(
                        player,
                        opponent,
                        [squares[0], squares[1], squares[2]],
                        -64,
                        64,
                        &mut nodes,
                        None,
                        None,
                        &mut timed_out,
                    )
                } else {
                    checked4 += 1;
                    solve_4(
                        player,
                        opponent,
                        [squares[0], squares[1], squares[2], squares[3]],
                        -64,
                        64,
                        &mut nodes,
                        None,
                        None,
                        &mut timed_out,
                    )
                };
                assert!(!timed_out);
                assert_eq!(
                    direct_score, truth,
                    "solve_{}(direct call) should match naive_solve at empties={empties}",
                    empties
                );
            }
        }

        assert!(checked3 >= 10, "expected several empties=3 positions, got {checked3}");
        assert!(checked4 >= 10, "expected several empties=4 positions, got {checked4}");
    }

    // 注記: `negamax`(shallow層無効時)は空き1〜4でもT103のNWS/PVS構造
    // (兄弟手をnull windowで先に反証し、失敗時のみ通常窓で再探索する)を
    // そのまま使う一方、`solve_1`〜`solve_4`は(要件どおりTT/hash/ソートを
    // 省く軽量実装として)単純なfail-soft alpha-betaのみを使い、PVS構造を
    // 持たない。この2つは探索アルゴリズムそのものが異なる(スコアは
    // 一致するが、木の中間ノードで踏む経路が異なる)ため、
    // 「shallow層のノード数と汎用negamaxのノード数」を直接比較しても
    // 一致しない(実測: ランダム局面群で最大4割程度が不一致、差の符号も
    // 両方向に出る)。これは正しさの問題ではなくアルゴリズムの違いに
    // 起因するため、比較テストとしては採用しない。代わりに、`solve_1`の
    // ノード計上契約(モジュール冒頭・関数ドキュメントに明記した
    // 「negamaxならこの局面で何回自分自身を呼び出すはずか」という定義)を
    // 手計算した期待値と直接照合する(以下の
    // `solve_1_node_accounting_matches_documented_negamax_call_counts`)。

    #[test]
    fn solve_1_node_accounting_matches_documented_negamax_call_counts() {
        // ケースA: 手番側がその1マスに置ける -> 2ノード
        // (a1を除き黒で埋め、白は最小限だけ置いて、黒がa1に置けば
        // 盤面が埋まるように構成する)。
        {
            // a1(bit0)だけ空け、残りは黒で埋める。黒がa1に置くには、
            // a1から見たいずれかの方向に白の連続→黒、が必要。
            // b1(bit1)を白にし、c1(bit2)を黒にすれば、a1→b1(白)→c1(黒)
            // で東方向にひっくり返せる。
            let a1 = 0u8;
            let mut black = u64::MAX & !(1u64 << 0) & !(1u64 << 1);
            let white = 1u64 << 1;
            black |= 0; // 明示のためのno-op(可読性用)
            let mut nodes = 0u64;
            let mut timed_out = false;
            let score = solve_1(black, white, a1, &mut nodes, None, None, &mut timed_out);
            assert_eq!(nodes, 2, "case A (mover can play) should count exactly 2 nodes");
            // 黒(手番側=player)がa1に置いてb1を裏返すと、盤面は全て黒になる
            // (64-0=64)。
            assert_eq!(score, 64);
            assert!(!timed_out);
        }

        // ケースB: 手番側は置けないが相手は置ける -> 3ノード。
        // 白だけで埋め尽くし黒石が1つも無い盤面にすると、手番(黒)は
        // どの方向にも黒石で終端できないため常に合法手なしになる一方、
        // 相手(白)はcase Aと対称な配置にしてa1に置けるようにする。
        {
            let a1 = 0u8;
            // player=黒(石なし相当ではなくボード上に0個)、opponent=白が
            // ほぼ全域+a1に置けば黒(1個だけ配置)を挟める構成。
            let mut opponent_white = u64::MAX & !(1u64 << 0) & !(1u64 << 1);
            let player_black = 1u64 << 1; // b1だけ黒(白から見て挟める相手石)
            opponent_white |= 0;
            let mut nodes = 0u64;
            let mut timed_out = false;
            let score = solve_1(
                player_black,
                opponent_white,
                a1,
                &mut nodes,
                None,
                None,
                &mut timed_out,
            );
            assert_eq!(
                nodes, 3,
                "case B (mover passes, opponent can play) should count exactly 3 nodes"
            );
            // 白がa1に置いてb1(黒)を裏返すと盤面は全て白になり、
            // 手番(黒)から見た最終石差は -64。
            assert_eq!(score, -64);
            assert!(!timed_out);
        }

        // ケースC: 両者ともその1マスに置けない(総取り規約) -> 1ノード。
        {
            let a1 = 0u8;
            // 白石が1つも無いため、黒番・白番のいずれも合法手が作れない
            // (既存の`solve_exact_applies_majority_takes_remaining_empties_rule_on_early_termination`
            // と同じ構成)。
            let black = u64::MAX & !(1u64 << 0);
            let white = 0u64;
            let mut nodes = 0u64;
            let mut timed_out = false;
            let score = solve_1(black, white, a1, &mut nodes, None, None, &mut timed_out);
            assert_eq!(
                nodes, 1,
                "case C (both stuck, majority rule) should count exactly 1 node"
            );
            // 黒63石 + 空き1マスの総取り = 64、白0石 => 差は64。
            assert_eq!(score, 64);
            assert!(!timed_out);
        }
    }

    #[test]
    fn solve_1_node_limit_aborts_exactly_at_the_documented_call_counts() {
        // ケースAは2ノード消費するはずなので、node_limit=1で最初の
        // ガード自身が中断を確定させ(1ノード目の時点でlimit到達)、
        // node_limit=2なら2ノード目(仮想子局面分)の時点で中断する
        // ことを確認する。
        let a1 = 0u8;
        let black = u64::MAX & !(1u64 << 0) & !(1u64 << 1);
        let white = 1u64 << 1;

        let mut nodes = 0u64;
        let mut timed_out = false;
        let score = solve_1(black, white, a1, &mut nodes, Some(1), None, &mut timed_out);
        assert!(timed_out, "node_limit=1 should abort case A before it completes");
        assert_eq!(score, 0);
        assert_eq!(nodes, 1);

        let mut nodes2 = 0u64;
        let mut timed_out2 = false;
        let score2 = solve_1(black, white, a1, &mut nodes2, Some(2), None, &mut timed_out2);
        // shallow_budget_guardはエントリ時点(nodes==1)ではlimit未到達
        // (1 < 2)なのでまだ中断しない。その後の「仮想子局面」+1で
        // nodes==2に達するが、この+1自体はnode_limitを再チェックしない
        // 設計(モジュール冒頭ドキュメント参照: これらの仮想増分は
        // O(1)の算術のみで、それ以上の再帰的な仕事が存在しないため)。
        // そのため最終的にはnodes==2まで到達し、タイムアウトはしないまま
        // 正しい値を返す。
        assert!(!timed_out2);
        assert_eq!(nodes2, 2);
        assert_eq!(score2, 64);
    }

    #[test]
    fn solve_shallow_honors_node_limit_and_aborts_without_undercounting() {
        // 空き1〜4のみの局面(ルート自体がshallow層へ委譲される)に対しても、
        // node_limitによるquota abortが専用層の内部で正しく機能すること、
        // かつabortまでに消費したノード数がnode_limit以上(過少計上でない)
        // かつ無制限solveの総ノード数以下であることを確認する
        // (`quota_abort_does_not_store_root_hash_in_exact_tt_through_pvs_path`
        // と同じ発想を、shallow層自体がルートになるケースへ適用したもの)。
        let mut checked = 0usize;

        for seed in 1..=80u64 {
            for (board, side) in random_small_positions(seed) {
                let empties = board.empty_count();
                if empties == 0 || empties > 4 || board.legal_moves(side).count_ones() < 2 {
                    continue;
                }

                let mut tt_full = TranspositionTable::new(1);
                let full = solve_exact_window_limited_with_nodes(
                    &board, side, -64, 64, &mut tt_full, None, None,
                );
                let total_nodes = full.nodes;
                if total_nodes < 4 {
                    continue;
                }
                let node_limit = (total_nodes / 2).max(1);

                let mut tt_limited = TranspositionTable::new(1);
                let limited = solve_exact_window_limited_with_nodes(
                    &board,
                    side,
                    -64,
                    64,
                    &mut tt_limited,
                    None,
                    Some(node_limit),
                );
                assert_eq!(
                    limited.score, None,
                    "expected the shallow layer to abort under half the node budget"
                );
                assert_eq!(limited.abort_reason, Some(AbortReason::ExactQuota));
                assert!(
                    limited.nodes >= node_limit,
                    "aborted shallow search must not undercount nodes below node_limit \
                     (nodes={}, node_limit={})",
                    limited.nodes,
                    node_limit
                );
                assert!(
                    limited.nodes <= total_nodes,
                    "aborted shallow search must not exceed the unlimited total node count \
                     (nodes={}, total_nodes={})",
                    limited.nodes,
                    total_nodes
                );

                checked += 1;
            }
        }

        assert!(
            checked >= 8,
            "expected several empties<=4 positions exercising the shallow node-limit abort path, \
             got {checked}"
        );
    }
}

//! 中盤探索エンジン: 反復深化 + PVS(NegaScout) + 置換表(T003) + 終盤完全読み(T006)。
//!
//! # 概要
//! [`search`] / [`search_all_moves`] が既存呼び出し元向けの公開エントリポイント
//! である(常に3項ヒューリスティック評価を使う)。空きマス数が
//! [`SearchLimit::exact_from_empties`] 以下になった局面(探索木の途中で到達した
//! 局面も含む)では、評価関数を一切使わず T006 (`endgame::solve_exact`) による
//! 完全読みに切り替える。それ以外の局面は静的評価([`static_eval`])をリーフ評価
//! に使った NegaScout (PVS) で反復深化探索する。
//!
//! T043で、静的評価をT041のパターン評価(`pattern_eval::PatternWeights`)に
//! 差し替えられる [`search_with_eval`] / [`search_all_moves_with_eval`] を追加した
//! (`weights: Option<&PatternWeights>` が `Some` ならパターン評価、`None` なら
//! 従来の3項ヒューリスティック評価。`search`/`search_all_moves` はこれらの
//! `weights: None` 版の薄いラッパーであり、挙動・シグネチャとも変更していない)。
//! 終盤完全読み(`endgame::solve_exact`系)は静的評価を一切呼ばないため、
//! パターン評価の有無によらず常に同じ結果を返す。
//!
//! # スケールの規約
//! `SearchResult::score` は centi-disc 単位(1石 = 100)・手番視点。
//! `endgame::solve_exact` は素の石差(1石=1)を返すため、本モジュールから
//! 呼び出す際は必ず `* 100` して centi-disc スケールに揃える
//! (`endgame.rs` モジュール冒頭のドキュメントに明記されている変換ルール)。
//!
//! # 置換表の共有について
//! 探索(本モジュール)と終盤ソルバー(T006)は同じ `TranspositionTable` を
//! 共有する。両者は `TTEntry::depth` の意味が異なる
//! (本モジュールでは「残り探索プライ数」、終盤ソルバーでは「残り空きマス数」)
//! が、ある局面がどちらの意味で `depth` を解釈されるかは、その局面自体の
//! 空きマス数だけで一意に決まる(空きマス数 <= `exact_from_empties` の局面は
//! 常に終盤ソルバー経由でのみ探索・格納され、それ以外の局面は常に本モジュールの
//! NegaScoutでのみ探索・格納される)ため、混同は起きない。
//!
//! ただしこれは「同じ `tt` に対しては常に同じ `exact_from_empties` で
//! `search()` を呼ぶ」ことが前提になる。もし将来、同一の `tt` を使い回した
//! まま異なる `exact_from_empties` で `search()` を呼び直すと、過去に
//! 書き込まれたエントリのスケール/depth解釈が食い違い、
//! `entry.depth as u32 >= depth as u32` の判定を通過して誤ったスコアを
//! 黙って返すおそれがある。これを防ぐため、[`search`] は冒頭で
//! `tt` に記録されている前回の `exact_from_empties`
//! (`TranspositionTable::last_exact_from_empties`)と今回の値を比較し、
//! 不一致であれば探索前に `tt.clear()` を行ってからその値を更新する
//! (T007)。この安全策はデバッグ限定ではなく、リリースビルドでも常に
//! 有効な通常ロジックとして実装している。
//!
//! # パスの扱い
//! 手番側に合法手がない場合はパスして相手番で同じ深さ予算のまま再帰する
//! (パスは深さを消費しない)。両者パス(終局)の場合は、終盤ソルバーと同じ
//! 「石数が多い方が残り空きマスを総取りする」慣習で最終石差を計算し、
//! centi-discスケールに変換して返す。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};
use crate::endgame::{
    final_score, solve_exact, solve_exact_bounded, solve_exact_bounded_with_nodes,
    solve_exact_limited_with_nodes, solve_exact_window_limited_with_nodes, solve_exact_with_nodes,
    AbortReason, TimeBudget,
};
use crate::eval::evaluate_for;
use crate::mpc;
use crate::pattern_eval::PatternWeights;
use crate::tt::{Bound, TTDomain, TTEntry, TranspositionTable};
use crate::zobrist::{incremental_move_hash, toggle_side_to_move, zobrist_hash};
// `std::time::Instant::now()` は `wasm32-unknown-unknown` ターゲットでは
// 未実装のため実行時に panic する(コンパイルは通ってしまうため、
// ネイティブの `cargo test` だけでは検出できない)。`web-time` はAPI互換の
// ドロップイン実装で、wasm上では `Performance.now()` を、それ以外の
// ターゲットでは `std::time::Instant` をそのまま使う。
use web_time::Instant;

/// 探索を打ち切るための十分に大きな評価値。centi-discスケールでの理論上の
/// 最大絶対値(64石差 = 6400)より大きく、かつ `i32` の演算(符号反転・-1)で
/// オーバーフローしない程度に余裕を持たせた値を選ぶ。
const INF: i32 = 1_000_000;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

/// 静的評価(葉ノード評価)を計算する。`weights`が`Some`ならT043のパターン評価
/// (`PatternWeights::score`、素の石差単位)をcenti-discスケール(×100、
/// 四捨五入)に変換して使い、`None`なら従来の3項ヒューリスティック評価
/// (`eval::evaluate_for`)を使う(グレースフルフォールバック)。
///
/// 終盤完全読み(`endgame::solve_exact`系)はこの関数を一切呼び出さない
/// (完全読みは石差の全数探索でありヒューリスティック評価を使わないため)。
/// パターン評価は本関数経由でのみ中盤ヒューリスティック探索(`negascout`の
/// 葉ノード評価・反復深化が一度も完了しなかった場合のフォールバック)に
/// 使われる。
///
/// # クランプ(T059)
/// [`PatternWeights::score`]は学習済みパターン重みの線形和であり、出力範囲に
/// 上限・下限の制約が無い。学習データが薄い局面(WTHOR実戦棋譜にあまり
/// 出現しない終盤寄りの局面等)では、線形和が石差の理論上限(オセロは
/// 64マスなので、どちらの手番視点でも最終石差は必ず`[-64, 64]`)を大きく
/// 超える値(centi-disc換算で±6400を大きく超える値、実例として±10500程度)を
/// 返しうることが実戦棋譜解析で確認された(ユーザー報告、`analyzeGame.ts`で
/// 石差105等の物理的にあり得ない値が表示される不具合)。
///
/// 参考実装のEdax(`src/const.h`の`SCORE_MIN=-64`/`SCORE_MAX=64`、
/// `src/midgame.c`の`search_eval_0`)も、パターン重み和で計算した葉の
/// ヒューリスティック評価を必ずこの理論上限の範囲にクランプしてから返して
/// おり(Edaxはさらに探索木内で「証明済みの±64」と区別するため`(-64, 64)`の
/// 開区間に丸めているが、本実装は`is_exact`フラグで確定/近似を別途区別して
/// いるためその区別は不要であり、単純に閉区間`[-64, 64]`でクランプする)、
/// 本関数もそれに倣う。`static_eval`は中盤ヒューリスティック探索の葉評価・
/// 終盤完全読み(`solve_exact_bounded`)がタイムアウトした際のフォールバックの
/// 両方から呼ばれる唯一の経路であり(呼び出し元は本モジュール内のみ)、
/// ここでクランプすることで両方の経路に自動的に適用される。NegaScout自体は
/// 子ノードの評価値の min/max(の符号反転)を積み上げるだけなので、葉が
/// `[-6400, 6400]`に収まっていれば親ノードの評価値もこの範囲を超えない
/// (探索が範囲を広げることはない)。
///
/// 一方、終盤完全読み(`endgame::solve_exact`/`solve_exact_bounded`が実際に
/// 完走した場合の戻り値)は本関数を経由しないため、このクランプの影響を
/// 一切受けない(全数探索の結果は理論上ここでの上限に収まっているはずだが、
/// 念のためクランプ対象を静的評価のみに限定する設計とした)。
fn static_eval(board: &Board, side: Side, weights: Option<&PatternWeights>) -> i32 {
    let raw = match weights {
        Some(w) => (w.score(board, side) * 100.0).round() as i32,
        None => evaluate_for(board, side),
    };
    raw.clamp(-DISC_DIFF_BOUND_CENTIDISC, DISC_DIFF_BOUND_CENTIDISC)
}

/// 石差の理論上限(絶対値64石、centi-disc単位=×100)。[`static_eval`]の
/// クランプに使う(T059)。
const DISC_DIFF_BOUND_CENTIDISC: i32 = 64 * 100;

#[cfg(test)]
std::thread_local! {
    // T182: `negascout`が増分計算した子/パスhashと、盤面全体を舐める
    // `zobrist_hash`のフル再計算を照合した(`debug_assert_eq!`を通過した)
    // 回数を数える(`endgame.rs`のT105と同じ目的・同じパターン)。
    // 「発火0件のままpassしない」ことをテストで確認するためのテスト専用
    // テレメトリで、本番探索の挙動には一切影響しない。
    static TEST_INCREMENTAL_HASH_CHECKS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
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

/// 探索の制御パラメータ。
///
/// Workerプロトコル(設計書 §2.4)の `limit` パラメータ
/// (`depth`, `timeMs`, `exactFromEmpties`)に対応する。
#[derive(Debug, Clone)]
pub struct SearchLimit {
    /// 反復深化で到達する最大深さ(プライ数)。
    pub max_depth: u8,
    /// 探索の時間制限(ミリ秒)。`None` なら時間制限なし。
    /// 反復深化の各深さが完了するごとにチェックするだけでなく、
    /// `negascout`/`endgame::negamax`の再帰の途中でも`TIME_CHECK_NODE_INTERVAL`
    /// (1024)ノードごとに経過時間をチェックし、超過していれば探索を
    /// (完了を待たずに)打ち切る(T034)。以前は「1つの深さの探索が
    /// 完了するごと」にしかチェックしておらず、探索木の内部で無条件に
    /// 呼ばれる完全読み(`endgame::solve_exact`)が「重い」局面に当たった
    /// 際に時間予算を数十〜数百倍超過してしまう不具合があったため、
    /// より細かい粒度でのチェックに変更した。
    pub time_ms: Option<u64>,
    /// この数値以下の空きマス数になったら終盤完全読み(T006)に切り替える。
    /// 設計書の既定値は24。
    pub exact_from_empties: u8,
}

/// 同一バイナリ内で探索施策を経路別に切り替えるポリシー。
///
/// 既定値は全てOFF。既存公開経路は従来のhistory/aspiration設定を明示して
/// MPCだけをOFFに保つ。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchPolicy {
    pub enable_history: bool,
    pub enable_aspiration: bool,
    pub enable_mpc: bool,
}

/// MPCの比較・Gate検証用テレメトリ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MpcStats {
    pub eligible_nodes: u64,
    pub probe_attempts_high: u64,
    pub probe_attempts_low: u64,
    pub probe_nodes: u64,
    pub cuts_high: u64,
    pub cuts_low: u64,
    pub skipped_pv_window: u64,
    pub skipped_exact_boundary: u64,
    pub skipped_uncalibrated: u64,
    pub cut_depth_histogram: [u64; 65],
    pub probe_depth_histogram: [u64; 65],
}

impl Default for MpcStats {
    fn default() -> Self {
        Self {
            eligible_nodes: 0,
            probe_attempts_high: 0,
            probe_attempts_low: 0,
            probe_nodes: 0,
            cuts_high: 0,
            cuts_low: 0,
            skipped_pv_window: 0,
            skipped_exact_boundary: 0,
            skipped_uncalibrated: 0,
            cut_depth_histogram: [0; 65],
            probe_depth_histogram: [0; 65],
        }
    }
}

/// 探索結果。
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// 最善手のマス番号(0..63)。合法手がない(パスすべき)局面の場合は `None`。
    pub best_move: Option<u8>,
    /// 評価値。centi-disc単位(1石=100)、手番視点(正なら手番側有利)。
    pub score: i32,
    /// 到達した探索深さ。終盤完全読みに切り替わった場合は空きマス数そのもの。
    pub depth: u8,
    /// 読み筋(マス番号列)。置換表から再構成した簡易的なものであり、
    /// 途中で置換表にエントリが無くなった時点で打ち切られる。
    pub pv: Vec<u8>,
    /// 探索したノード数。
    pub nodes: u64,
    /// この結果が実際にどちらの方式で得られたか。
    /// `true` なら終盤完全読み(`endgame::solve_exact`/`solve_exact_bounded`
    /// を打ち切りなく完走できた場合)、`false` なら中盤探索(NegaScout、
    /// または`solve_exact_bounded`がタイムアウトした後の静的評価
    /// フォールバック)による評価値であることを示す。
    ///
    /// [`MoveEval::is_exact`] と同じ理由(レビュー指摘、T018)により、
    /// 呼び出し側(`protocol.rs`)が `score.type`(`"exact"`/`"midgame"`)を
    /// 報告する際は、**着手前の局面の空きマス数と`exact_from_empties`の
    /// 比較だけで事前計算した値ではなく**、必ずこのフィールド(=実際に
    /// 使われた評価方式)を根拠にすること。T034で`search()`のルート分岐に
    /// 時間予算付き完全読み(`solve_exact_bounded`)を導入したことで、
    /// 「空きマス数的にはexact_from_empties以下だが、タイムアウトにより
    /// 実際には完全読みを完走できず、通常の反復深化(またはその反復すら
    /// 一度も完了せず単発の静的評価)にフォールバックした」という
    /// ケースが生まれたため、事前計算した空きマス数ベースの判定では
    /// 「exact」と誤表示されてしまう(レビュー指摘、T034フィードバック)。
    pub is_exact: bool,
    /// T084: この`search`/`search_with_eval`呼び出し全体の経過時間
    /// (ミリ秒、`Instant::now()`起点からの壁時計時間)。
    ///
    /// single-rootベストムーブ探索(`eval_cli best`)のテレメトリ
    /// (NPS計算・タイムアウト率の可視化)のために追加した。探索アルゴリズム
    /// 自体には一切影響しない計測専用のフィールド(この値を探索の分岐条件に
    /// 使っている箇所はない)。
    pub elapsed_ms: u64,
    /// T084: `limit.time_ms`(時間予算)が、この呼び出しが返した結果を
    /// 制限した(=より深く/正確に探索できたはずが時間切れで打ち切られた)
    /// 場合に`true`。
    ///
    /// 具体的には次のいずれかが起きた場合に`true`になる:
    /// - ルート局面が完全読み対象(`empties <= exact_from_empties`)だったが、
    ///   `solve_exact_bounded`/`solve_exact_bounded_with_nodes`が時間切れで
    ///   完走できなかった(その後、反復深化にフォールバックした)。
    /// - 反復深化のあるイテレーションが再帰の途中で時間切れになり、
    ///   その反復の結果を破棄した(直前に完了したイテレーションの結果を
    ///   返した)。
    /// - 反復深化のあるイテレーションは完了したが、その直後に経過時間が
    ///   `time_ms`以上になっていたため、それ以上深い反復を行わずに
    ///   打ち切った(=もっと深く読めたかどうかは不明)。
    ///
    /// `limit.time_ms`が`None`(時間無制限)の場合は常に`false`
    /// (壁時計を一切参照しないため、結果は完全に決定的になる。T084の
    /// 決定性モード要件はこの不変条件に依拠している)。
    pub timed_out: bool,
    /// `max_nodes`に達したため探索を打ち切った場合に`true`。
    pub node_limit_hit: bool,
    pub requested_max_nodes: Option<u64>,
    pub consumed_nodes: u64,
    pub baseline_depth: u8,
    pub baseline_nodes: u64,
    pub last_completed_depth: u8,
    pub static_only: bool,
    pub exact_root_attempts: u32,
    pub exact_leaf_attempts: u32,
    /// ルート局面を終盤完全読みで最後まで解いた場合のみ`true`。
    pub exact_root_completed: bool,
    /// 探索木内の狭窓exact呼び出しがboundを証明して完走した回数。
    pub exact_bound_proof_completed: u32,
    /// 探索木内のexact呼び出しが完走した回数(full windowを含む)。
    pub exact_leaf_completed: u32,
    /// 互換フィールド。root/leafのいずれかのexactが1回でも完走した場合に
    /// `true`であり、root exact完走だけを意味しない。
    pub exact_completed: bool,
    pub exact_aborted_by_quota: u32,
    pub exact_nodes: u64,
    pub midgame_nodes: u64,
    pub wall_limit_hit: bool,
    pub fallback_reason: Option<AbortReason>,
    pub exact_policy_version: &'static str,
    /// T089a(要件10): aspiration windowがfail-lowした(反復深化の各
    /// イテレーションで負けた側の窓を必ず再探索した)回数の累計。
    /// aspiration自体が無効な経路(`search`/`search_with_eval`等、
    /// ノード予算探索でない経路)では常に`0`。
    pub aspiration_fail_low: u32,
    /// T089a(要件10): aspiration windowがfail-highした回数の累計。
    /// `aspiration_fail_low`と同じ理由で、aspiration無効経路では常に`0`。
    pub aspiration_fail_high: u32,
    pub mpc_stats: MpcStats,
}

const EXACT_POLICY_VERSION: &str = "t107-v3";
// T107(新終盤ソルバー: T099〜T105採用施策確定後の再校正): T096の60局面
// 頑健oracleのうちempties18〜23の44局面(24〜26の16局面はoracle自体が
// 数分〜数時間かかる無制限完全読みのため未計測、選定はこの44局面で確定)で
// quota{25,40,50,60,75}% x exact_from_empties{16,18,20,22,24} x
// max_nodes{160000,240000,320000,480000}(depth=12・time-ms=1500、本番と同条件)
// の100通りを総当たりし、設計レポート§5の辞書式優先順位
// (static-onlyゼロ→決定性100%→wall保険5%以下→oracle regret最小→…)で
// 比較した。exact_from_emptiesは全候補で結果が完全に同一だった(空き15以上の
// P75推定ノード数が本予算域を大きく上回り、rootでもleafでも
// `estimated_min_exact_nodes`のゲートを通らないため。詳細はこの下の
// `estimated_min_exact_nodes`のコメント参照)。budgetは現行160000のまま
// (240000以上は今回のサンプルでは悪化: ノイズの可能性ありだが選定基準どおり
// 実測に従う)。quota=60%が44局面平均oracle regret最小(1.2727石、現行40%の
// 1.3636石を下回り、目標1.25石に近い)。決定性はT096 60局面全件で100%一致
// (mismatches=0)を別途確認済み。wall保険発動率はこのgrid実測でも0%だったが、
// T114生成と並行実行下の測定のため、専有ウィンドウでの最終確認を別途行う。
// 生データ: bench/edax-compare/endgame-results/t107-policy-calibration.json
// (oracle)・t107-policy-calibration-grid.json(grid・determinism)・
// t107-report.md(集計表)
const EXACT_QUOTA_PERCENT: u8 = 60;

#[derive(Default)]
struct ExactStats {
    root_attempts: u32,
    leaf_attempts: u32,
    root_completed: bool,
    bound_proof_completed: u32,
    leaf_completed: u32,
    completed: bool,
    aborted_by_quota: u32,
    nodes: u64,
}

fn estimated_min_exact_nodes(empties: u32) -> u64 {
    // T107で新ソルバー(T099〜T105採用後)向けに再測定した表。
    // `bench/edax-compare/estimate_min_exact_nodes.py`(各空き数4局面、
    // seed=85100+empties)で`eval_cli best --depth 1 --exact-from-empties 30`
    // により無制限完全読みし、nearest-rank p75を採取している(手法自体は
    // T085を踏襲)。0..14は元の表と同じく設計方針どおり「原則試行」を維持し
    // P75=1で常にゲートを通す(この範囲は測定はしたが、意図的にゲートしない
    // 設計。実測値は 10=7,919 / 11=20,244 / 12=40,451 / 13=78,471 /
    // 14=118,952 だったが、いずれもこの範囲は常に試みるべきという元の
    // 設計判断を覆すほどの根拠にはならないと判断し、置き換えなかった。
    // 実際、置き換えるとT085aの`leaf_exact_quota_abort_continues_
    // midgame_iteration_without_tt_domain_leak`テストが前提とする
    // 「空き14の子で一部がquota-abortする」シナリオ自体が発生しなくなる
    // ことを確認した)。15..24は実測値で更新: 15=238,263 / 16=2,310,760 /
    // 17=5,148,109 / 18=6,996,232 / 19=31,313,088 / 20=18,547,224 /
    // 21=129,764,316 / 22=532,374,714 / 23=1,871,985,825 / 24=3,300,401,823。
    // 空き15以上は本番のノード予算(160,000)・quota(60%、上のコメント参照)の
    // どちらの組み合わせでもこのP75を満たせないため、実質的にexactは空き14
    // 以下でのみ試行される(T107校正時にexact_from_empties{16,18,20,22,24}の
    // 違いが結果に一切現れなかった理由もこれ)。値そのものは正確に保つ
    // (将来ノード予算を大きく引き上げた場合に正しく機能させるため)。
    // 生データ: bench/edax-compare/endgame-results/t107-estimated-min-exact-nodes.json
    const P75: [u64; 25] = [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        238_263,
        2_310_760,
        5_148_109,
        6_996_232,
        31_313_088,
        18_547_224,
        129_764_316,
        532_374_714,
        1_871_985_825,
        3_300_401_823,
    ];
    P75.get(empties as usize).copied().unwrap_or(u64::MAX)
}

fn floor_div_100(value: i32) -> i32 {
    value.div_euclid(100)
}

fn ceil_div_100(value: i32) -> i32 {
    -(-value).div_euclid(100)
}

/// [`search_all_moves`] が返す、1つの合法手についての評価値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveEval {
    /// 着手先のマス番号(0..63)。
    pub mv: u8,
    /// 評価値。centi-disc単位(1石=100)、`search_all_moves` に渡した
    /// `side_to_move`(着手前の手番)から見た値。
    pub score: i32,
    /// この評価値が実際にどちらの方式で計算されたか。
    /// `true` なら終盤完全読み(`endgame::solve_exact_with_nodes`)、
    /// `false` なら中盤探索(NegaScout)による評価値であることを示す。
    ///
    /// 呼び出し側(`protocol.rs`)が `score.type`(`"exact"`/`"midgame"`)を
    /// 報告する際、**着手前の局面の空きマス数**ではなく、この
    /// フィールド(=各手について実際に使われた評価方式)を根拠にすること。
    /// 着手により空きマス数は必ず1減るため、着手前の空きマス数だけで
    /// 判定すると `exact_from_empties + 1` の境界で実態と食い違う
    /// (レビュー指摘によりT018で追加)。
    pub is_exact: bool,
}

/// 現在の局面を探索し、最善手と評価値を返す。
///
/// - 空きマス数が `limit.exact_from_empties` 以下であれば、直ちに
///   `endgame::solve_exact` による完全読みの結果を返す。
/// - それ以外は depth=1 から `limit.max_depth` まで反復深化しながら
///   NegaScout(PVS)探索を行う。各反復は `tt` を使い回す。
///
/// 静的評価には常に従来の3項ヒューリスティック評価(`eval::evaluate_for`)を
/// 使う。パターン評価(T043)を使いたい場合は [`search_with_eval`] を使うこと
/// (既存の呼び出し元・シグネチャへの影響を避けるため、本関数はそのまま
/// 変更していない)。
pub fn search(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
) -> SearchResult {
    search_with_eval(board, side_to_move, limit, tt, None)
}

/// [`search`]と同じだが、`weights`が`Some`ならT043のパターン評価を中盤探索の
/// 静的評価に使う(`None`なら[`search`]と全く同じ挙動)。
pub fn search_with_eval(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
) -> SearchResult {
    // T089a: history heuristic/aspiration windowは、ノード予算探索
    // (`max_nodes.is_some()`)の経路のみで有効にする(`enable_heuristics:
    // false`)。既存のfixed-depth回帰テストがこの経路(`search`/
    // `search_with_eval`)のノード数・タイブレーク順を固定しているため、
    // これらを変えないことを最優先する([`HistoryTable`]・
    // [`search_with_eval_inner`]のドキュメント参照)。
    search_with_eval_inner(
        board,
        side_to_move,
        limit,
        tt,
        weights,
        true,
        None,
        EXACT_QUOTA_PERCENT,
        SearchPolicy::default(),
        None,
    )
}

/// [`search_with_eval`]に探索全体のノード数予算を追加したCLI/ベンチ用入口。
pub fn search_with_eval_with_node_limit(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
    max_nodes: u64,
) -> SearchResult {
    search_with_eval_with_node_limit_and_exact_quota(
        board,
        side_to_move,
        limit,
        tt,
        weights,
        max_nodes,
        EXACT_QUOTA_PERCENT,
    )
}

/// T085aのquota候補比較用入口。通常経路は
/// [`search_with_eval_with_node_limit`] が選定済みの既定値を渡す。
/// 探索アルゴリズムを候補ごとに書き換えず、同一バイナリ・同一条件で
/// 25/40/60/75%を再現比較するためにeval_cliからのみ利用する。
pub fn search_with_eval_with_node_limit_and_exact_quota(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
    max_nodes: u64,
    exact_quota_percent: u8,
) -> SearchResult {
    assert!(exact_quota_percent <= 100);
    // T089a: ノード予算探索の経路なので history heuristic/aspiration
    // windowを有効化する(上の`search_with_eval`のコメント参照)。
    search_with_eval_inner(
        board,
        side_to_move,
        limit,
        tt,
        weights,
        true,
        Some(max_nodes),
        exact_quota_percent,
        SearchPolicy {
            enable_history: true,
            enable_aspiration: true,
            enable_mpc: false,
        },
        None,
    )
}

/// 比較・校正用に探索施策を明示する入口。MPCは `mpc_enabled` featureを
/// 含むビルド（またはテストビルド）で、かつ `policy.enable_mpc` の場合
/// だけ動作する。既存APIの既定は引き続きOFF。
pub fn search_with_eval_with_policy(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
    max_nodes: Option<u64>,
    exact_quota_percent: u8,
    policy: SearchPolicy,
) -> SearchResult {
    search_with_eval_with_policy_and_margin_t(
        board,
        side_to_move,
        limit,
        tt,
        weights,
        max_nodes,
        exact_quota_percent,
        policy,
        None,
    )
}

/// T176: [`search_with_eval_with_policy`]にMPCマージン係数tの上書きを
/// 追加した入口。`mpc_margin_t`が`None`なら[`search_with_eval_with_policy`]
/// と完全に同じ(既存呼び出し元は本関数経由で挙動不変)。`Some(t)`のときだけ、
/// `mpc_try_cutoff`が使う`Calibration`の`margin_high`/`margin_low`を
/// `ceil(t*sigma_centidisc)`で再計算する(`engine/src/mpc.rs`の
/// `calibration_with_margin_t`参照)。MPCマージン積極化の試行専用
/// (T176、本番経路・既存テストからは呼ばれない)。
pub fn search_with_eval_with_policy_and_margin_t(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
    max_nodes: Option<u64>,
    exact_quota_percent: u8,
    policy: SearchPolicy,
    mpc_margin_t: Option<f32>,
) -> SearchResult {
    assert!(exact_quota_percent <= 100);
    search_with_eval_inner(
        board,
        side_to_move,
        limit,
        tt,
        weights,
        true,
        max_nodes,
        exact_quota_percent,
        policy,
        mpc_margin_t,
    )
}

/// [`search_with_eval`]の実体。`enable_etc`でETC(T051、[`etc_try_cutoff`]
/// 参照)の有効/無効を切り替えられるが、これは「ETC有効時と無効時とで
/// 探索結果(最善手・評価値)が完全に一致すること」を検証するテスト専用の
/// 引数であり、公開API(`search`/`search_with_eval`)は常に`true`を渡す
/// (ETCは正しく実装されていれば探索結果を一切変えない安全な枝刈りであり、
/// MPCと異なり本番で無効化する理由がない)。
///
/// `policy`はhistory、aspiration、MPCを独立に切り替える。既存fixed-depth
/// 経路は全OFF、既存ノード予算経路はhistory/aspirationのみONでMPCはOFF。
fn search_with_eval_inner(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
    enable_etc: bool,
    max_nodes: Option<u64>,
    exact_quota_percent: u8,
    policy: SearchPolicy,
    mpc_margin_t: Option<f32>,
) -> SearchResult {
    // TTスケール混同防止(T007): 同じ `tt` に対して過去に異なる
    // `exact_from_empties` で探索していた場合、その古いエントリは
    // 今回とはスケール/depthの意味が食い違っている可能性があるため、
    // 安全のためTTを丸ごとクリアしてから今回の値を記録し直す。
    // (初回呼び出し `None` や、前回と同じ値の場合はクリア不要)
    if let Some(prev) = tt.last_exact_from_empties() {
        if prev != limit.exact_from_empties {
            tt.clear();
        }
    }
    tt.set_last_exact_from_empties(limit.exact_from_empties);

    let empties = board.empty_count();
    let start = Instant::now();

    // T084: 時間予算(`limit.time_ms`)がこの呼び出しの結果を制限したかどうかを
    // 追跡する(`SearchResult::timed_out`)。`limit.time_ms`が`None`の間は
    // 一切書き換わらず`false`のままになる(壁時計を参照しないため決定的)。
    let mut time_budget_hit = false;
    let mut node_limit_hit = false;
    let mut total_nodes: u64 = 0;
    let mut baseline_nodes = 0;
    let mut exact_quota_remaining = 0;
    let mut exact_stats = ExactStats::default();
    let mut mpc_stats = MpcStats::default();
    let mut fallback_reason = None;

    if max_nodes.is_none() && empties <= limit.exact_from_empties as u32 {
        // T034: `time_ms`が指定されていれば、`search_all_moves`/`negascout`
        // と同じ理由(完全読み自体が特定局面で時間予算を大幅に超過しうる)
        // により`solve_exact_bounded`系を使う。打ち切られた(`None`)場合は
        // ここでは`return`せず、下の通常の反復深化ループにフォールバック
        // する(そちらも同じ`start`を共有しているため、既に予算を
        // 使い切っていれば`negascout`の葉判定内で即座に打ち切られ、
        // 関数末尾の静的評価フォールバックに帰着する。ハングはしない)。
        //
        // T084: ノード数テレメトリのため、`solve_exact`/`solve_exact_bounded`
        // ではなく`_with_nodes`版(既存のノード数計測専用エントリポイント。
        // `solve_exact_with_nodes`はT009で、`solve_exact_bounded_with_nodes`は
        // 本タスクで追加)を使う。探索アルゴリズム自体(alpha-beta+TTの挙動)は
        // 元の`solve_exact`/`solve_exact_bounded`と完全に同じであり、
        // スコア・タイムアウト判定には一切影響しない(ノード数を追加で
        // カウントして返すだけ)。
        let (exact, exact_nodes, exact_node_limit_hit) = if max_nodes.is_some() {
            solve_exact_limited_with_nodes(
                board,
                side_to_move,
                tt,
                limit.time_ms.map(|time_ms| TimeBudget { start, time_ms }),
                max_nodes,
            )
        } else {
            match limit.time_ms {
                Some(time_ms) => {
                    let (result, nodes) = solve_exact_bounded_with_nodes(
                        board,
                        side_to_move,
                        tt,
                        TimeBudget { start, time_ms },
                    );
                    (result, nodes, false)
                }
                None => {
                    let (raw, nodes) = solve_exact_with_nodes(board, side_to_move, tt);
                    (Some(raw), nodes, false)
                }
            }
        };
        total_nodes = exact_nodes;
        exact_stats.root_attempts = 1;
        exact_stats.nodes = exact_nodes;

        if let Some(raw) = exact {
            let score = raw * 100;
            let hash = zobrist_hash(board, side_to_move);
            let best_move = tt
                .probe(hash, TTDomain::Exact)
                .and_then(|entry| entry.best_move);
            let pv = best_move.map(|mv| vec![mv]).unwrap_or_default();

            return SearchResult {
                best_move,
                score,
                depth: empties as u8,
                pv,
                // 完全読みは1回の呼び出しで完結するため、実際に訪問した
                // ノード数(`exact_nodes`)をそのまま報告する
                // (以前はここが`1`固定のプレースホルダーだった。T084)。
                nodes: exact_nodes.max(1),
                is_exact: true,
                elapsed_ms: start.elapsed().as_millis() as u64,
                timed_out: false,
                node_limit_hit: false,
                requested_max_nodes: max_nodes,
                consumed_nodes: exact_nodes.max(1),
                baseline_depth: 0,
                baseline_nodes: 0,
                last_completed_depth: empties as u8,
                static_only: false,
                exact_root_attempts: 1,
                exact_leaf_attempts: 0,
                exact_root_completed: true,
                exact_bound_proof_completed: 0,
                exact_leaf_completed: 0,
                exact_completed: true,
                exact_aborted_by_quota: 0,
                exact_nodes: exact_nodes,
                midgame_nodes: 0,
                wall_limit_hit: false,
                fallback_reason: None,
                exact_policy_version: EXACT_POLICY_VERSION,
                // ルート局面が直ちに完全読みで解けた場合、反復深化・
                // aspiration windowは一切実行されていない。
                aspiration_fail_low: 0,
                aspiration_fail_high: 0,
                mpc_stats,
            };
        }
        // T034: `exact`が`None`(タイムアウト)だった場合はここで`return`せず
        // 下の反復深化ループへフォールバックする。以降で構築される
        // `SearchResult`はすべて`is_exact: false`(完全読みを完走できて
        // いないため)。T084: このフォールバックが起きたこと自体を
        // `time_budget_hit`に記録する(最終的な`SearchResult::timed_out`に
        // 反映される)。
        node_limit_hit = exact_node_limit_hit;
        time_budget_hit = !exact_node_limit_hit;
        fallback_reason = Some(if exact_node_limit_hit {
            AbortReason::GlobalNodeLimit
        } else {
            AbortReason::WallClock
        });
    }

    let mut last_result: Option<SearchResult> = None;
    // T089a: history heuristic表とaspiration windowの中心値(前
    // イテレーションのscore)。各施策は`policy`で独立に有効化される
    // ([`HistoryTable`]・[`search_with_eval_inner`]のドキュメント参照)。
    let mut history: Option<HistoryTable> = policy.enable_history.then(HistoryTable::new);
    let mut prev_score: Option<i32> = None;
    let mut aspiration_fail_low: u32 = 0;
    let mut aspiration_fail_high: u32 = 0;

    for depth in 1..=limit.max_depth {
        if max_nodes.is_some_and(|max_nodes| total_nodes >= max_nodes) {
            node_limit_hit = true;
            fallback_reason = Some(AbortReason::GlobalNodeLimit);
            break;
        }
        // T089a(要件3): root探索(このイテレーション)の開始ごとにhistory表の
        // 全値を半減する(飽和防止・古い情報の減衰)。
        if let Some(history) = history.as_mut() {
            history.halve_all();
        }
        let mut nodes: u64 = 0;
        let mut timed_out = false;
        let score = {
            let mut ctx = SearchCtx {
                limit,
                tt: &mut *tt,
                nodes: &mut nodes,
                nodes_before: total_nodes,
                max_nodes,
                start,
                timed_out: &mut timed_out,
                weights,
                suppress_mpc: false,
                enable_mpc: policy.enable_mpc && (cfg!(feature = "mpc_enabled") || cfg!(test)),
                mpc_margin_t,
                mpc_stats: &mut mpc_stats,
                enable_etc,
                exact_enabled: max_nodes.is_none() || depth > 1,
                exact_quota_remaining: &mut exact_quota_remaining,
                exact_stats: &mut exact_stats,
                history: history.as_mut(),
            };
            // T089a(要件7-9): depth>=2かつ有効な場合のみ、前イテレーションの
            // scoreを中心にaspiration windowで探索する(fail-low/highしたら
            // 必ず窓を広げて再探索し、最終的にfull windowへ到達する。
            // 要件8によりfull-window探索と完全一致する)。depth==1・前
            // イテレーション未完走(`prev_score`が`None`)・機能無効時は
            // 常にfull window(`-INF..INF`)で探索する(従来と同じ)。
            match (policy.enable_aspiration && depth >= 2, prev_score) {
                (true, Some(center)) => aspiration_search(
                    board,
                    side_to_move,
                    depth,
                    center,
                    &mut ctx,
                    &mut aspiration_fail_low,
                    &mut aspiration_fail_high,
                ),
                _ => negascout(board, side_to_move, depth, -INF, INF, &mut ctx, None),
            }
        };

        if timed_out {
            // このイテレーション(depth)は再帰の途中で時間切れになり
            // 未完走(T034)。結果は不正確なため使わず、直前に完了した
            // イテレーションの結果(`last_result`、無ければ関数末尾の
            // フォールバック)をそのまま返す。
            if max_nodes.is_some_and(|max_nodes| total_nodes + nodes >= max_nodes) {
                node_limit_hit = true;
                fallback_reason = Some(AbortReason::GlobalNodeLimit);
            } else {
                time_budget_hit = true;
                fallback_reason = Some(AbortReason::WallClock);
            }
            total_nodes += nodes;
            break;
        }

        total_nodes += nodes;
        // T089a(要件7): 次のイテレーション(depth+1)のaspiration windowは
        // このイテレーションのscoreを中心にする。
        prev_score = Some(score);

        let hash = zobrist_hash(board, side_to_move);
        let best_move = tt
            .probe(hash, TTDomain::Midgame)
            .and_then(|entry| entry.best_move);
        let pv = extract_pv(board, side_to_move, tt, depth as usize);

        last_result = Some(SearchResult {
            best_move,
            score,
            depth,
            pv,
            nodes: total_nodes,
            // T034: このループはNegaScout(中盤探索)経由の結果であり、
            // ルート局面自体を完全読みし切ったわけではないため常にfalse
            // (葉の一部が`solve_exact_bounded`で完全読みされていたとしても、
            // ルートから見た最終結果としては「完全読み」を名乗れない)。
            is_exact: false,
            // 下で`time_budget_hit`の最終値に基づき上書きするプレースホルダー
            // (このイテレーション時点ではまだループが続くかどうか未確定)。
            elapsed_ms: 0,
            timed_out: false,
            node_limit_hit: false,
            requested_max_nodes: max_nodes,
            consumed_nodes: total_nodes,
            baseline_depth: 1,
            baseline_nodes,
            last_completed_depth: depth,
            static_only: false,
            exact_root_attempts: exact_stats.root_attempts,
            exact_leaf_attempts: exact_stats.leaf_attempts,
            exact_root_completed: exact_stats.root_completed,
            exact_bound_proof_completed: exact_stats.bound_proof_completed,
            exact_leaf_completed: exact_stats.leaf_completed,
            exact_completed: exact_stats.completed,
            exact_aborted_by_quota: exact_stats.aborted_by_quota,
            exact_nodes: exact_stats.nodes,
            midgame_nodes: total_nodes.saturating_sub(exact_stats.nodes),
            wall_limit_hit: false,
            fallback_reason,
            exact_policy_version: EXACT_POLICY_VERSION,
            aspiration_fail_low,
            aspiration_fail_high,
            mpc_stats: mpc_stats.clone(),
        });

        if max_nodes.is_some() && depth == 1 {
            baseline_nodes = total_nodes;
            let remaining = max_nodes.unwrap().saturating_sub(total_nodes);
            exact_quota_remaining = remaining.saturating_mul(exact_quota_percent as u64) / 100;
            if empties <= limit.exact_from_empties as u32
                && exact_quota_remaining >= estimated_min_exact_nodes(empties)
            {
                exact_stats.root_attempts += 1;
                let outcome = solve_exact_window_limited_with_nodes(
                    board,
                    side_to_move,
                    -64,
                    64,
                    tt,
                    limit.time_ms.map(|time_ms| TimeBudget { start, time_ms }),
                    Some(exact_quota_remaining),
                );
                total_nodes += outcome.nodes;
                exact_stats.nodes += outcome.nodes;
                exact_quota_remaining = exact_quota_remaining.saturating_sub(outcome.nodes);
                if let Some(raw) = outcome.score {
                    exact_stats.root_completed = true;
                    exact_stats.completed = true;
                    let hash = zobrist_hash(board, side_to_move);
                    let best_move = tt
                        .probe(hash, TTDomain::Exact)
                        .and_then(|entry| entry.best_move);
                    return SearchResult {
                        best_move,
                        score: raw * 100,
                        depth: empties as u8,
                        pv: best_move.into_iter().collect(),
                        nodes: total_nodes,
                        is_exact: true,
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        timed_out: false,
                        node_limit_hit: false,
                        requested_max_nodes: max_nodes,
                        consumed_nodes: total_nodes,
                        baseline_depth: 1,
                        baseline_nodes,
                        last_completed_depth: 1,
                        static_only: false,
                        exact_root_attempts: exact_stats.root_attempts,
                        exact_leaf_attempts: 0,
                        exact_root_completed: true,
                        exact_bound_proof_completed: exact_stats.bound_proof_completed,
                        exact_leaf_completed: exact_stats.leaf_completed,
                        exact_completed: true,
                        exact_aborted_by_quota: exact_stats.aborted_by_quota,
                        exact_nodes: exact_stats.nodes,
                        midgame_nodes: baseline_nodes,
                        wall_limit_hit: false,
                        fallback_reason: None,
                        exact_policy_version: EXACT_POLICY_VERSION,
                        // depth==1のbaseline中に木内部exactへ抜けており、
                        // aspiration(depth>=2のみ)は一切実行されていない。
                        aspiration_fail_low: 0,
                        aspiration_fail_high: 0,
                        mpc_stats: mpc_stats.clone(),
                    };
                }
                match outcome.abort_reason {
                    Some(AbortReason::ExactQuota) => {
                        exact_stats.aborted_by_quota += 1;
                        fallback_reason = Some(AbortReason::ExactQuota);
                    }
                    Some(AbortReason::WallClock) => {
                        time_budget_hit = true;
                        fallback_reason = Some(AbortReason::WallClock);
                        break;
                    }
                    _ => {}
                }
            }
        }

        if max_nodes.is_some_and(|max_nodes| total_nodes >= max_nodes) {
            node_limit_hit = true;
            fallback_reason = Some(AbortReason::GlobalNodeLimit);
            break;
        }

        if let Some(time_ms) = limit.time_ms {
            if start.elapsed().as_millis() as u64 >= time_ms {
                // T084: イテレーション自体は完了したが、時間予算を使い切った
                // ためこれ以上深い反復を行わずに打ち切った。もっと深く読めた
                // 可能性があるという意味で「時間予算に制限された」とみなす。
                time_budget_hit = true;
                fallback_reason = Some(AbortReason::WallClock);
                break;
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match last_result {
        Some(mut result) => {
            // `nodes`は採用した最終イテレーションだけでなく、その後に破棄した
            // イテレーションを含む呼び出し全体の実消費量を報告する。
            result.nodes = total_nodes;
            result.elapsed_ms = elapsed_ms;
            result.timed_out = time_budget_hit;
            result.node_limit_hit = node_limit_hit;
            result.consumed_nodes = total_nodes;
            result.baseline_nodes = baseline_nodes;
            result.last_completed_depth = result.depth;
            result.exact_root_attempts = exact_stats.root_attempts;
            result.exact_leaf_attempts = exact_stats.leaf_attempts;
            result.exact_root_completed = exact_stats.root_completed;
            result.exact_bound_proof_completed = exact_stats.bound_proof_completed;
            result.exact_leaf_completed = exact_stats.leaf_completed;
            result.exact_completed = exact_stats.completed;
            result.exact_aborted_by_quota = exact_stats.aborted_by_quota;
            result.exact_nodes = exact_stats.nodes;
            result.midgame_nodes = total_nodes.saturating_sub(exact_stats.nodes);
            result.wall_limit_hit = time_budget_hit;
            // GlobalNodeLimit/WallClockは探索全体を止めた最終理由なので優先する。
            // それらが無く、木内部exactだけがquota切れから中盤探索へ復帰した
            // 場合も、実イベントと矛盾しないようExactQuotaを報告する。
            result.fallback_reason = fallback_reason
                .or_else(|| (exact_stats.aborted_by_quota > 0).then_some(AbortReason::ExactQuota));
            // T089a: 破棄したイテレーション分も含む呼び出し全体の累計に
            // 揃える(`exact_stats`系フィールドと同じ理由)。
            result.aspiration_fail_low = aspiration_fail_low;
            result.aspiration_fail_high = aspiration_fail_high;
            result.mpc_stats = mpc_stats;
            result
        }
        None => SearchResult {
            // max_depth == 0 のような呼び出しへのフォールバック、または
            // (T034)ルート分岐の完全読みがタイムアウトし、かつ反復深化の
            // depth=1すら一度も完走できなかった場合。反復が一度も行われな
            // かった場合、静的評価をそのまま返す。
            best_move: {
                let legal = board.legal_moves(side_to_move);
                (legal != 0).then(|| legal.trailing_zeros() as u8)
            },
            score: static_eval(board, side_to_move, weights),
            depth: 0,
            pv: Vec::new(),
            nodes: total_nodes,
            is_exact: false,
            elapsed_ms,
            timed_out: time_budget_hit,
            node_limit_hit,
            requested_max_nodes: max_nodes,
            consumed_nodes: total_nodes,
            baseline_depth: 0,
            baseline_nodes: 0,
            last_completed_depth: 0,
            static_only: true,
            exact_root_attempts: exact_stats.root_attempts,
            exact_leaf_attempts: exact_stats.leaf_attempts,
            exact_root_completed: exact_stats.root_completed,
            exact_bound_proof_completed: exact_stats.bound_proof_completed,
            exact_leaf_completed: exact_stats.leaf_completed,
            exact_completed: false,
            exact_aborted_by_quota: exact_stats.aborted_by_quota,
            exact_nodes: exact_stats.nodes,
            midgame_nodes: total_nodes.saturating_sub(exact_stats.nodes),
            wall_limit_hit: time_budget_hit,
            fallback_reason,
            exact_policy_version: EXACT_POLICY_VERSION,
            aspiration_fail_low,
            aspiration_fail_high,
            mpc_stats,
        },
    }
}

/// T089a(要件7-9): aspiration windowで`depth`を探索し、fail-low/highの
/// たびに[`ASPIRATION_WINDOWS_CENTIDISC`]の順に窓を広げて再探索する。
/// 広げ切ったら無条件でfull window(`-INF..INF`)を試すため、最終的に
/// 返る値は必ずfull window探索(`negascout(board, side, depth, -INF, INF,
/// ctx)`)と完全一致する(要件8)。
///
/// # TT汚染についての注記(要件8)
/// fail-low/highした窓の探索結果は、通常の`negascout`と同じ経路で
/// 置換表にも格納される(`Bound::Upper`/`Bound::Lower`、深さは`depth`の
/// まま)。次の(より広い)窓での再探索がこの局面を再度探索する際、
/// `negascout`冒頭のTT参照ロジックが同じ`entry.depth as u32 >= depth as
/// u32`の判定でこのエントリを使うが、これは「証明済みの厳密な上下界」を
/// 使った通常のTT枝刈りと全く同じ扱いであり(ETC・T086と同じ理由で)結果を
/// 歪めない。full windowまで広げ切った最後の試行では`alpha == -INF`が
/// 必ず成り立つため、`alpha >= beta`によるTT即時カットオフ自体が発生し得ず
/// (`beta`が中間状態のUpper boundで多少狭められることはあっても、
/// `alpha == -INF`より小さいbetaにはなり得ない)、full window探索は必ず
/// 完全な値を返す。
///
/// `fail_low`/`fail_high`には、この1回のイテレーションで実際に
/// fail-low/highした回数を加算する
/// (`SearchResult::aspiration_fail_low`/`aspiration_fail_high`の元データ)。
fn aspiration_search(
    board: &Board,
    side: Side,
    depth: u8,
    center: i32,
    ctx: &mut SearchCtx,
    fail_low: &mut u32,
    fail_high: &mut u32,
) -> i32 {
    let mut window_idx = 0usize;
    let (mut alpha, mut beta) = aspiration_bounds(center, window_idx);

    loop {
        let score = negascout(board, side, depth, alpha, beta, ctx, None);
        if *ctx.timed_out {
            // 呼び出し元(`search_with_eval_inner`)は`ctx.timed_out`を見て
            // このイテレーション全体を破棄するため、戻り値自体には意味が
            // ない(`negascout`本体の同様の慣習に合わせる)。
            return score;
        }

        let is_full_window = alpha <= -INF && beta >= INF;
        if is_full_window {
            return score;
        }

        if score <= alpha {
            *fail_low += 1;
        } else if score >= beta {
            *fail_high += 1;
        } else {
            return score;
        }

        window_idx += 1;
        let (next_alpha, next_beta) = aspiration_bounds(center, window_idx);
        alpha = next_alpha;
        beta = next_beta;
    }
}

/// `window_idx`番目のaspiration window(`(alpha, beta)`、centi-disc単位)を
/// `center`を中心に計算する。`window_idx`が[`ASPIRATION_WINDOWS_CENTIDISC`]
/// の範囲を超えたらfull window(`-INF..INF`)を返す。
fn aspiration_bounds(center: i32, window_idx: usize) -> (i32, i32) {
    match ASPIRATION_WINDOWS_CENTIDISC.get(window_idx) {
        Some(&half_width) => (
            center.saturating_sub(half_width).max(-INF),
            center.saturating_add(half_width).min(INF),
        ),
        None => (-INF, INF),
    }
}

/// 現在の局面の**全合法手**それぞれについて評価値を返す(T018)。
///
/// 悪手判定(「打った手が最善手からどれだけ悪いか」)・定石外判定など、
/// 全モード共通で必要になる基盤API。[`search`] は最善手1つしか返さないため、
/// こちらは合法手すべてを列挙し、各手について:
///
/// - 着手後の局面の空きマス数が `limit.exact_from_empties` 以下であれば
///   [`solve_exact_with_nodes`] による完全読みの結果(石差)を centi-disc
///   スケールに変換して使う。
/// - それ以外は、着手後の局面に対して `limit.max_depth` までの
///   NegaScout(PVS)探索を行う。
///
/// いずれの経路でも、返す `score` は **`side_to_move`(この関数を呼んだ時点の
/// 手番)から見た** centi-disc スケールの評価値になるよう符号を揃える
/// (着手後は相手番になるため、内部で得られる値は必ず反転してから格納する)。
/// どちらの経路で評価したかは `MoveEval::is_exact` にそのまま記録する
/// (呼び出し側が `score.type` を報告する際の根拠にする。レビュー指摘対応)。
///
/// `tt` は全合法手の評価を通じて使い回される(探索の重複を減らすため)。
/// [`search`] 同様、T007のTTスケール混同防止ロジック
/// (`exact_from_empties` が前回と異なる場合に `tt` をクリアする)が働く。
///
/// `limit.time_ms` が指定されている場合、[`search`] と同様、反復深化の
/// 各深さが完了するごとに経過時間をチェックし、超過していればその時点で
/// 打ち切る。合計の時間予算(`limit.time_ms`)自体は全合法手を通じた
/// 累計として消費されるが、**各合法手にはその時点で残っている予算を
/// 「まだ評価していない合法手の数」で均等に割った、公平な持ち分**が
/// 割り当てられる(T076)。以前は合計予算をどの合法手が消費してもよい
/// 早い者勝ち方式だったため、たまたま先頭(マス番号が若い)に来ただけの
/// 1手が予算のほぼ全部を使い切ってしまい、残り全ての合法手が
/// depth=1(ほぼ静的評価1回分のノイズが乗った浅い値)にしかならず、
/// 実際には悪い手が浅い評価のノイズにより最善手と誤判定される、という
/// 実害のあるバグが実測で確認された(ユーザー報告、作業ログ参照)。
/// ある合法手が自分の持ち分より早く完走すれば、その分は自動的に
/// 後続の合法手の取り分に回る。全合法手の持ち分の合計は常に元の
/// `limit.time_ms` 以下に収まるため、T034が防いだ「全体のハング」の
/// リスクは変わらない。それでも予算を使い切った合法手は、それぞれ
/// 1回だけ静的評価(`eval::evaluate_for`)相当の浅い値になりうる。
/// 全合法手の評価を打ち切りなく完走した場合と比べて精度は落ちるが、
/// 「0.5〜2秒程度で返る」という性能目標(タスク背景参照)を守ることを
/// 優先する。
///
/// 合法手が0件(パスすべき局面・終局局面)の場合は空の `Vec` を返す
/// (エラーにしない)。返す順序はスコア降順。
///
/// 静的評価には常に従来の3項ヒューリスティック評価を使う。パターン評価
/// (T043)を使いたい場合は [`search_all_moves_with_eval`] を使うこと。
pub fn search_all_moves(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
) -> Vec<MoveEval> {
    search_all_moves_with_eval(board, side_to_move, limit, None)
}

/// [`search_all_moves_with_eval`] が、まだ評価していない1つの合法手に
/// 割り当てる「公平な持ち分」(ミリ秒)を計算する(T076)。
///
/// `total_time_ms`: `SearchLimit::time_ms` で指定された全体の時間予算。
/// `elapsed_ms`: 全合法手を通じた共有の起点(`start`)からこれまでに
/// 経過した時間。`moves_left`: これから評価する合法手の数
/// (現在評価しようとしている手自身を含む。0は渡さないことを想定するが、
/// 万一0でも`max(1)`で1として扱いパニックしない)。
///
/// 戻り値は「残っている時間予算」を「残っている合法手の数」で均等に
/// 割った値。ある合法手が自分の持ち分を使い切らずに完走すれば、
/// 次の呼び出し時点の `elapsed_ms` が小さくなる分、後続の合法手の
/// 持ち分は自動的に増える(=先に完走した手の余りが後続に回る)。
/// 全合法手の持ち分の合計は、常に `total_time_ms` 以下に収まる
/// (各ステップで「残り予算 / 残り手数」以下しか割り当てないため)。
fn fair_share_time_ms(total_time_ms: u64, elapsed_ms: u64, moves_left: usize) -> u64 {
    let remaining_ms = total_time_ms.saturating_sub(elapsed_ms);
    let moves_left = moves_left.max(1) as u64;
    remaining_ms / moves_left
}

/// [`search_all_moves_with_eval`]が各合法手の探索に使う、この関数呼び出し
/// 専用のローカル置換表のサイズ(MB)。`eval_cli`が単発の`search_all_moves_with_eval`
/// 呼び出し用に使ってきた既存の慣例値(`eval_cli.rs`の`cmd_moves`参照)に揃える。
const ANALYZE_ALL_LOCAL_TT_MB: usize = 16;

/// [`search_all_moves`]と同じだが、`weights`が`Some`ならT043のパターン評価を
/// 静的評価に使う(`None`なら[`search_all_moves`]と全く同じ挙動)。
///
/// # T139: 置換表は呼び出し元と共有しない(手ごとに独立)
/// 以前は呼び出し元(`Engine::analyze`が保持する共有TT)をそのまま
/// 全合法手・全反復深化ステップを通じて使い回していた。この設計には
/// 2つの問題があった(T138調査、T139):
///
/// 1. 先に評価した合法手が置換表に残したエントリが、後で評価する合法手の
///    MPC近似枝刈り判断に混入し、対称局面(初手d3/c4/f5/e6等)で評価値が
///    最大1石ズレる(=どの順番で4手を評価するかに結果が依存してしまう)。
/// 2. 表示専用のこの関数の探索が、対局用の共有TT(`Engine::analyze`の
///    もう一方の分岐、CPU着手の探索が使う)を汚してしまう。
///
/// 対応として、この関数は**呼び出し元のTTを一切読み書きしない**。
/// 各合法手ごとに、この関数内だけで完結するローカルTTを新規に用意して
/// 使う(`local_tt.clear()`で完全にリセットしてから探索するため、前の
/// 合法手が残したエントリは一切引き継がない)。ただし同一の合法手の
/// 反復深化(depth 1..=max_depth)の間はこのローカルTTを使い回す
/// (iterative deepeningの高速化のため。手をまたいでは共有しない)。
/// この結果、呼び出し元のTTの状態(空かどうか・何が入っているか)に
/// 一切依存せず、常に同じ入力に対して同じ結果を返すようになる
/// (受け入れ基準: 事前にTTを汚す先行探索を挟んでも結果が変わらない)。
pub fn search_all_moves_with_eval(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    weights: Option<&PatternWeights>,
) -> Vec<MoveEval> {
    search_all_moves_with_eval_core(board, side_to_move, limit, weights, ANALYZE_ALL_LOCAL_TT_MB)
        .into_iter()
        .map(|(eval, _nodes)| eval)
        .collect()
}

/// [`search_all_moves_with_eval`]の実装本体。ローカルTTのサイズ
/// (`tt_size_mb`)と各合法手の総ノード数(反復深化の全深さを合計したもの、
/// 完全読みに委譲した場合は`solve_exact_with_nodes`/
/// `solve_exact_bounded_with_nodes`が返す値)を追加で返す。
///
/// この2点は本番の`search_all_moves_with_eval`(常に`ANALYZE_ALL_LOCAL_TT_MB`・
/// ノード数は呼び出し元に見せない)からは呼べない・見えない情報だが、
/// T170で追加した回帰テスト(`local_tt.clear()`の削除検知)が、TTを
/// 意図的に小さくして衝突を誘発し、ノード数の変化で「手をまたいだ
/// キャッシュ汚染」を検出するために必要とする。本関数を切り出したこと
/// 自体で本番`search_all_moves_with_eval`の計算内容・返り値は一切変わらない
/// (`ANALYZE_ALL_LOCAL_TT_MB`を渡して呼ぶだけの薄いラッパーになった)。
fn search_all_moves_with_eval_core(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    weights: Option<&PatternWeights>,
    tt_size_mb: usize,
) -> Vec<(MoveEval, u64)> {
    search_all_moves_with_eval_core_restricted(board, side_to_move, limit, weights, tt_size_mb, None)
}

/// [`search_all_moves_with_eval_core`]の実装本体。`restrict_to`が`Some`の
/// 場合、通常なら評価するはずの合法手のうち`restrict_to`に含まれるものだけ
/// (元の手番順を保った部分列)を評価する。本番経路
/// ([`search_all_moves_with_eval_core`]経由、常に`restrict_to=None`)の
/// 挙動には影響しない、テスト専用の追加パラメータ(T170: `local_tt.clear()`
/// 回帰テストが、同一局面上で「他の合法手が何手評価された後か」だけを
/// 変えて特定の1手のノード数を比較するために使う。局面を変えて比較する
/// 方式は、対象手の着手結果(次局面)まで変わってしまい比較にならない
/// ことが判明したため不採用とした。作業ログ参照)。
fn search_all_moves_with_eval_core_restricted(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    weights: Option<&PatternWeights>,
    tt_size_mb: usize,
    restrict_to: Option<&[u8]>,
) -> Vec<(MoveEval, u64)> {
    let legal = board.legal_moves(side_to_move);
    let mut moves: Vec<u8> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb.trailing_zeros() as u8);
        remaining &= remaining - 1;
    }
    if let Some(allowed) = restrict_to {
        moves.retain(|mv| allowed.contains(mv));
    }

    let opponent = side_to_move.opposite();
    let total_moves = moves.len();
    let mut evals: Vec<(MoveEval, u64)> = Vec::with_capacity(total_moves);

    // 全合法手を通じた経過時間の起点(`limit.time_ms` があれば参照する)。
    // T076: 以前はこの `start` を全合法手が単純に共有し、「まだ経過時間が
    // 予算内に収まっている限り、今評価中の1手がどれだけ時間を使っても
    // 構わない」という早い者勝ちの配分になっていた。この設計では、
    // 反復深化(未満の深さで探索が重くなる)手がたまたま先頭(マス番号が
    // 若い)にあるだけで、その1手だけが予算のほぼ全部を消費してしまい、
    // 残り全ての合法手が depth=1(実質ノイズに近い浅い評価)しか得られない
    // ことが実測で確認された(ユーザー報告の誤判定バグ、作業ログ参照)。
    // これは「候補手が多いと1手あたりの実効深さが浅くなる」という
    // 想定内のトレードオフを大きく超え、「最初の1手だけ深く読み、残りは
    // ほぼ読まない」という実用上の誤判定を招く設計不良だった。
    //
    // 修正: 各合法手を評価する直前に、その時点で残っている時間予算
    // (`time_ms` から起点`start`以降の経過時間を差し引いたもの)を
    // 「まだ評価していない合法手の数」で均等に割り、その手専用の
    // 予算(`per_move_limit`)として与える。ある手が自分の持ち分より
    // 早く完走すれば、その分は後続の手に自動的に回る(`remaining_ms`を
    // 評価のたびに再計算するため)。逆にある手が予算を使い切っても、
    // 自分の持ち分を超えては進めない(=後続の手の取り分を奪わない)。
    // 合計の時間予算(`time_ms`)自体は変更していないため、
    // T034が防いだ「全体のハング」のリスクは増えない
    // (全合法手の持ち分の合計は常に元の `time_ms` 以下に収まる)。
    let start = Instant::now();

    // T139: 呼び出し元のTTとは独立な、この関数専用のローカルTT。各合法手の
    // 評価直前に`clear()`して完全にリセットするため、手をまたいだ
    // エントリの持ち越しは起きない(関数doc参照)。
    let mut local_tt = TranspositionTable::new(tt_size_mb);

    for (i, mv) in moves.into_iter().enumerate() {
        local_tt.clear();
        local_tt.set_last_exact_from_empties(limit.exact_from_empties);

        let next_board = board.apply_move(side_to_move, 1u64 << mv);
        let next_empties = next_board.empty_count();

        // この手の「公平な持ち分」を反映した `SearchLimit` を用意する。
        // `time_ms` が指定されていなければ(時間無制限)従来どおり `limit`
        // をそのまま使う(このコピーは安価: `SearchLimit` は4つのプリミ
        // ティブフィールドのみ)。
        let per_move_limit: SearchLimit = match limit.time_ms {
            Some(total_time_ms) => {
                let elapsed_ms = start.elapsed().as_millis() as u64;
                let moves_left = total_moves - i;
                SearchLimit {
                    max_depth: limit.max_depth,
                    time_ms: Some(fair_share_time_ms(total_time_ms, elapsed_ms, moves_left)),
                    exact_from_empties: limit.exact_from_empties,
                }
            }
            None => limit.clone(),
        };
        // この手専用の経過時間の起点。`per_move_limit.time_ms`
        // (この手の持ち分)はこの起点からの経過時間として消費される
        // (全合法手共有の `start` とは別物)。
        let move_start = Instant::now();

        // T170: この合法手1つを評価するのに探索したノード総数(反復深化なら
        // 全深さの合計、完全読みに委譲した場合はその1回分)。回帰テスト
        // (`local_tt.clear()`削除検知)がTT汚染の有無を判定するために使う
        // (本番`search_all_moves_with_eval`は`_nodes`として捨てる)。
        let mut move_nodes: u64 = 0;

        let (score, is_exact) = if next_empties <= limit.exact_from_empties as u32 {
            // T034: `search()`/`negascout`と同じ理由により、`time_ms`が
            // 指定されていれば`solve_exact_bounded`を使う。特定の局面
            // (安定石カット等の高度な枝刈りを持たない完全読みソルバーが
            // 苦手とする「重い」局面)では、この直接呼び出し1回だけでも
            // 時間予算を大幅に超過しうることが実測で確認されている。
            // 打ち切られた場合は、この手についてだけ静的評価に
            // フォールバックし`is_exact=false`として報告する(本当は
            // 完全読みしたかったが時間予算を優先して打ち切った、という
            // 実態を反映する)。
            match per_move_limit.time_ms {
                Some(time_ms) => {
                    let budget = TimeBudget {
                        start: move_start,
                        time_ms,
                    };
                    let (result, nodes) =
                        solve_exact_bounded_with_nodes(&next_board, opponent, &mut local_tt, budget);
                    move_nodes += nodes;
                    match result {
                        Some(raw_diff) => (-(raw_diff * 100), true),
                        None => (-static_eval(&next_board, opponent, weights), false),
                    }
                }
                None => {
                    let (raw_diff, nodes) =
                        solve_exact_with_nodes(&next_board, opponent, &mut local_tt);
                    move_nodes += nodes;
                    (-(raw_diff * 100), true)
                }
            }
        } else {
            // 反復深化: search()のルート呼び出しと同じ深さの意味を保つため、
            // ここで消費した1手分(mvの着手)を差し引いた `depth - 1` を
            // 子局面(next_board, opponent視点)に渡す。こうすることで、
            // 同じ `limit.max_depth` を指定したときに `search()` が返す
            // 評価値と、`search_all_moves()` が返す評価値の最大値が
            // 一致する(整合性は本モジュールのテストで検証する)。
            let mut best_for_move = -static_eval(&next_board, opponent, weights);
            for depth in 1..=per_move_limit.max_depth {
                let mut nodes: u64 = 0;
                let mut timed_out = false;
                let mut exact_quota = u64::MAX;
                let mut exact_stats = ExactStats::default();
                let mut mpc_stats = MpcStats::default();
                let candidate = {
                    let mut ctx = SearchCtx {
                        limit: &per_move_limit,
                        tt: &mut local_tt,
                        nodes: &mut nodes,
                        nodes_before: 0,
                        max_nodes: None,
                        start: move_start,
                        timed_out: &mut timed_out,
                        weights,
                        suppress_mpc: false,
                        enable_mpc: false,
                        mpc_margin_t: None,
                        mpc_stats: &mut mpc_stats,
                        enable_etc: true,
                        exact_enabled: true,
                        exact_quota_remaining: &mut exact_quota,
                        exact_stats: &mut exact_stats,
                        // T089a: `search_all_moves_with_eval`はノード予算
                        // 探索ではないため常に`None`(history heuristicを
                        // 使わない)。既存のfixed-depth回帰テストが固定する
                        // このAPIの挙動を変えないため。
                        history: None,
                    };
                    -negascout(&next_board, opponent, depth - 1, -INF, INF, &mut ctx, None)
                };
                // T170: タイムアウトで未完走に終わった深さの分も、実際に
                // 探索した(探索木を辿った)ノード数としてカウントする
                // (打ち切りは`candidate`の値を捨てるだけで、その深さの
                // 探索が「無かったこと」にはならないため)。
                move_nodes += nodes;

                if timed_out {
                    // このイテレーション(depth)は再帰の途中で時間切れになり
                    // 未完走(T034)。`candidate`は不正確なため使わず、
                    // 直前に完了した深さの評価値(`best_for_move`)を採用して
                    // この手の反復深化を打ち切る。
                    break;
                }
                best_for_move = candidate;

                if let Some(time_ms) = per_move_limit.time_ms {
                    if move_start.elapsed().as_millis() as u64 >= time_ms {
                        break;
                    }
                }
            }
            (best_for_move, false)
        };

        evals.push((
            MoveEval {
                mv,
                score,
                is_exact,
            },
            move_nodes,
        ));
    }

    evals.sort_by_key(|(e, _)| std::cmp::Reverse(e.score));
    evals
}

/// history heuristic(T089a)用の `(side, move)` カウンタ表。
///
/// beta cutoffが起きるたびに `depth * depth` を加算し、[`ordered_moves`] の
/// タイブレークに使う。**ノード予算探索(`max_nodes.is_some()`、
/// [`search_with_eval_with_node_limit`]系)の反復深化ループでのみ**
/// 生成・使用する([`search_with_eval_inner`]の`enable_heuristics`引数を
/// 参照)。時間/深さ制限のみの従来経路([`search`]/[`search_with_eval`]/
/// [`search_all_moves`]/[`search_all_moves_with_eval`])は常に
/// `history: None` のまま`ordered_moves`を呼ぶため、これらの経路の
/// 挙動(既存のfixed-depth回帰テストが固定しているノード数・タイブレーク
/// 順を含む)には一切影響しない。
///
/// # 決定性(要件11)
/// 呼び出しごとに[`search_with_eval_inner`]内で新規に生成する
/// (`HistoryTable::new()`、全マス0初期化)ため、常駐Engine(Worker)で
/// 同じインスタンスを複数回の探索にまたがって使い回すことはない
/// (=前回探索の学習状態を持ち越さない)。反復深化の各root
/// イテレーション開始時に[`HistoryTable::halve_all`]で全値を半減する。
struct HistoryTable {
    /// `[side][マス番号]`。`side`のインデックスは[`HistoryTable::side_index`]。
    scores: [[u32; 64]; 2],
}

impl HistoryTable {
    fn new() -> Self {
        HistoryTable {
            scores: [[0u32; 64]; 2],
        }
    }

    fn side_index(side: Side) -> usize {
        match side {
            Side::Black => 0,
            Side::White => 1,
        }
    }

    /// `ordered_moves`のタイブレークに使う現在値。
    fn get(&self, side: Side, mv: u8) -> u32 {
        self.scores[Self::side_index(side)][mv as usize]
    }

    /// beta cutoffが起きた候補手に `depth * depth` を加算する
    /// (要件2)。`u32`の飽和加算で、極端に深い探索が繰り返し同じ手で
    /// カットオフしてもオーバーフローしない。
    fn record_cutoff(&mut self, side: Side, mv: u8, depth: u8) {
        let bonus = (depth as u32) * (depth as u32);
        let slot = &mut self.scores[Self::side_index(side)][mv as usize];
        *slot = slot.saturating_add(bonus);
    }

    /// root探索(反復深化の各イテレーション開始)ごとに全値を半減する
    /// (要件3: 飽和防止と古い情報の減衰)。
    fn halve_all(&mut self) {
        for side_scores in &mut self.scores {
            for v in side_scores.iter_mut() {
                *v >>= 1;
            }
        }
    }
}

/// ムーブオーダリングでのhistoryタイブレークの位置(要件4のablation)。
///
/// `true`: corner優先 → history降順 → mobility昇順(構成B、mobilityより
/// 前にhistoryを使う)。
/// `false`: corner優先 → mobility昇順 → history降順(構成A、既存の
/// mobility順の後のタイブレークとしてhistoryを使う、既定)。
///
/// `bench/edax-compare/t085_exact_positions.json`(48局面)を
/// `eval_cli budget-regression --max-nodes 240000 --time-ms 1500
/// --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin`
/// で比較した実測(作業ログ参照)に基づき選定した値。
const HISTORY_BEFORE_MOBILITY: bool = false;

/// aspiration window(T089a、要件7-10)の初期窓幅と再探索時の拡大列
/// (centi-disc単位、片側の幅)。`[200, 400, 800, 1600]`をすべて
/// fail-low/high した場合は、最後に無条件でfull window(`-INF..INF`)を
/// 試す(必ず`true score`を含む窓になるため、それ以上広げる必要はない)。
const ASPIRATION_WINDOWS_CENTIDISC: [i32; 4] = [200, 400, 800, 1600];

/// NegaScout探索1回分の実行に必要な文脈をまとめた構造体。
/// (引数を減らしてclippyの`too_many_arguments`を避けるための束ね役でもある)
struct SearchCtx<'a> {
    limit: &'a SearchLimit,
    tt: &'a mut TranspositionTable,
    nodes: &'a mut u64,
    /// この反復より前(ルートexact試行・完了済み反復)に消費したノード数。
    nodes_before: u64,
    /// この単一ルート探索に課された総ノード数予算。
    max_nodes: Option<u64>,
    /// この反復深化の1イテレーション(1つの`depth`の探索、または
    /// `search_all_moves`の1つの合法手についての1イテレーション)の
    /// 経過時間計測の起点。`negascout`の再帰の**途中**で`limit.time_ms`の
    /// 超過をチェックするために使う(T034で追加)。
    ///
    /// 背景: 従来は反復深化の「1つの深さの探索が完了するごと」にしか
    /// 経過時間を確認していなかった(このファイル冒頭の
    /// `search`/`search_all_moves`のループ参照)。ほとんどの局面では
    /// 深さが1増えるごとの所要時間の増加はおおむね緩やかなためこれで
    /// 十分だったが、局面によっては特定の深さで(ムーブオーダリングが
    /// 効かない分岐に当たる等の理由で)組合せ的に所要時間が跳ね上がる
    /// ことがあり、そのようなケースでは「1回のイテレーションの完了を
    /// 待つ」だけで時間予算を数百倍超過してしまうことが実測で確認された
    /// (T034調査ログ参照)。再帰の途中でも定期的にチェックすることで、
    /// この種の突発的な超過を打ち切れるようにする。
    start: Instant,
    /// 探索が時間切れで打ち切られたことを示すフラグ。一度立てると、
    /// それ以降の全ての再帰呼び出しは(探索を進めず)即座に展開し、
    /// 呼び出し元まで巻き戻る。このフラグが立った状態で計算される
    /// `best_score`/`best_move`は不完全な探索に基づく不正確な値なので、
    /// 置換表には格納しない(`negascout`本体・呼び出し元の両方で保証する)。
    /// `search`/`search_all_moves`はこのフラグを見て、そのイテレーション
    /// の結果を丸ごと破棄し、直前に完了したイテレーションの結果を使う。
    timed_out: &'a mut bool,
    /// T043: `negascout`の葉ノード評価(`depth == 0`)に使う静的評価。
    /// `Some`ならパターン評価、`None`なら従来の3項ヒューリスティック評価
    /// (`static_eval`参照)。
    weights: Option<&'a PatternWeights>,
    /// T048: `true`の間、`negascout`はMPC(`mpc_try_cutoff`)を一切試みない。
    ///
    /// `mpc_try_cutoff`自身が呼ぶ浅い探索(プローブ)の**サブツリー全体**で
    /// このフラグを立てる(プローブ呼び出し前に`true`にし、戻ってきたら
    /// `false`に戻す)。プローブの中でさらにMPCを再帰適用する(=何重にも
    /// 浅い探索で近似する)と、近似誤差が積み重なり、自己対戦検証で
    /// 無視できない棋力低下を引き起こすことが実測で確認された
    /// (T048作業ログ参照: 深さ8以上でMPCの再帰適用を許可すると、60局面中
    /// 20局面以上でトップの手が変わってしまい、tを1.5→4.0に上げても
    /// ほとんど改善しなかった。深さ6以下(再帰が起きない条件)では
    /// 24局の自己対戦で全く差が出なかったことから、原因は「プローブの中の
    /// 再帰的MPC」による誤差の積み重ねだと特定した)。このフラグにより
    /// MPCを「1段だけ」に制限する(プローブ自体は通常のNegaScoutと同じ
    /// 精度で探索する)。
    suppress_mpc: bool,
    /// 探索ポリシーでMPCを有効にし、コード包含featureも満たした場合だけtrue。
    enable_mpc: bool,
    /// T176: MPCマージン係数tの上書き(既定`None`)。`None`のときは
    /// `mpc::calibration_for`が返す`Calibration`(t=1.5で校正済み、
    /// `engine/src/mpc.rs`のCALIBRATIONS)をそのまま使い、本番経路・
    /// 既存テストの挙動を一切変えない。`Some(t)`のときだけ、適用直前に
    /// `mpc::calibration_with_margin_t`で`margin_high`/`margin_low`を
    /// `ceil(t*sigma_centidisc)`に再計算したコピーを使う(スロープ・切片・
    /// プローブ深さは不変)。マージン積極化の試行専用
    /// (`search_with_eval_with_policy_and_margin_t`経由でのみ`Some`になる)。
    mpc_margin_t: Option<f32>,
    mpc_stats: &'a mut MpcStats,
    /// T051: `true`の間、`negascout`は候補手を1つずつ実際に再帰探索する
    /// 前に、ETC(Enhanced Transposition Cutoff、[`etc_try_cutoff`]参照)を
    /// 試みる。
    ///
    /// MPCの`suppress_mpc`と異なり、これは「探索の途中で動的に立てたり
    /// 戻したりするフラグ」ではなく、1回の`search_with_eval`/
    /// `search_all_moves_with_eval`呼び出しを通じて固定の値を使う。
    /// ETCは(正しく実装されていれば)置換表に既に記録されている厳密な
    /// 情報だけを使う安全な枝刈りであり、MPCのような統計的近似ではないため
    /// 本番コードは常に`true`を渡す。`false`は「ETC有効/無効で探索結果が
    /// 完全に一致する」ことを検証するテスト専用の切り替え口として存在する
    /// (`search_with_eval_inner`のテスト経由でのみ`false`が渡される)。
    enable_etc: bool,
    /// baseline depth 1ではfalseにして完全読みへの接続を禁止する。
    exact_enabled: bool,
    /// ノード予算付き経路でexactに割り当てた残quota。
    exact_quota_remaining: &'a mut u64,
    exact_stats: &'a mut ExactStats,
    /// T089a: history heuristic表。`Some`のときのみ`ordered_moves`の
    /// タイブレークとbeta cutoff時の加算に使う。`None`(従来の
    /// `search`/`search_with_eval`/`search_all_moves*`経路)では
    /// 一切参照されず、[`ordered_moves`]は本タスク着手前と完全に同じ
    /// 2キーソート(corner優先→mobility昇順)のみを行う
    /// ([`HistoryTable`]のドキュメント参照)。
    history: Option<&'a mut HistoryTable>,
}

/// `negascout`の再帰中に時間予算をチェックする頻度(ノード数に1回)。
/// 毎ノードチェックすると、特にWASM上では`web_time::Instant::now()`が
/// `Performance.now()`へのJS境界越え呼び出しになりオーバーヘッドが
/// 無視できないため、探索自体を遅くしてしまう。1024ノードに1回の
/// チェックであれば、オーバーヘッドを無視できる水準に抑えつつ、
/// 時間予算の超過を数msのオーダーで検出できる(T034)。
const TIME_CHECK_NODE_INTERVAL: u64 = 1024;

/// NegaScout(PVS) + 置換表による中盤探索本体。
///
/// `alpha` / `beta` は `side` から見たcenti-discスケールの評価値の窓。
/// 空きマス数が `ctx.limit.exact_from_empties` 以下になった時点で
/// 終盤完全読みに切り替える(この判定はルート呼び出しだけでなく、
/// 探索木の途中の任意の局面でも行う)。
///
/// `ctx.limit.time_ms`が指定されている場合、`ctx.timed_out`がまだ
/// 立っていなければ`TIME_CHECK_NODE_INTERVAL`ノードごとに経過時間を
/// チェックする(T034)。超過していれば`ctx.timed_out`を立てて即座に
/// `0`を返す(呼び出し元は戻り値を使わず`ctx.timed_out`を見て
/// イテレーション全体を破棄するため、`0`という値自体に意味はない)。
/// 一度`ctx.timed_out`が立った後の全呼び出しも同様に即座に`0`を返し、
/// 置換表への格納も行わない(不完全な探索結果でTTを汚染しないため)。
/// `known_hash`: 呼び出し元が既にこの`(board, side)`局面のZobristハッシュを
/// (親の増分計算経由で)知っている場合は`Some`で渡す。`None`の場合は本関数が
/// 必要になった時点で`zobrist_hash`によるフルスキャンで求める(ルート呼び出し
/// 等、親からの増分ハッシュが存在しない経路向けのフォールバック)。
/// `Some`が渡された場合でも、実際に使う際は`zobrist_hash`によるフル再計算と
/// `debug_assert_eq!`で照合する(T182、T105の`endgame::negamax`と同じ方針)。
fn negascout(
    board: &Board,
    side: Side,
    depth: u8,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
    known_hash: Option<u64>,
) -> i32 {
    *ctx.nodes += 1;

    if *ctx.timed_out {
        return 0;
    }
    if ctx
        .max_nodes
        .is_some_and(|max_nodes| ctx.nodes_before + *ctx.nodes >= max_nodes)
    {
        *ctx.timed_out = true;
        return 0;
    }
    if let Some(time_ms) = ctx.limit.time_ms {
        if *ctx.nodes % TIME_CHECK_NODE_INTERVAL == 0
            && ctx.start.elapsed().as_millis() as u64 >= time_ms
        {
            *ctx.timed_out = true;
            return 0;
        }
    }

    let mut alpha = alpha;
    let mut beta = beta;

    let empties = board.empty_count();
    if ctx.exact_enabled
        && empties <= ctx.limit.exact_from_empties as u32
        && (ctx.max_nodes.is_none()
            || *ctx.exact_quota_remaining >= estimated_min_exact_nodes(empties))
    {
        // T034: 空きマス数がしきい値以下になった時点で終盤完全読みに
        // 切り替えるが、この完全読み自体(`endgame::negamax`)は素朴な
        // alpha-beta+TTであり、特定の「重い」局面では1回の呼び出しだけで
        // 時間予算を大幅に超過しうることが実測で確認されている
        // (T034調査ログ参照)。`time_ms`が指定されている場合は
        // `solve_exact_bounded`(同じ`ctx.start`を共有する時間予算付き
        // バージョン)を使い、打ち切られた場合は`ctx.timed_out`を立てて
        // 呼び出し元にイテレーション全体を破棄させる。
        if ctx.max_nodes.is_some() {
            ctx.exact_stats.leaf_attempts += 1;
            let alpha_disc = floor_div_100(alpha).clamp(-64, 64);
            let beta_disc = ceil_div_100(beta).clamp(-64, 64);
            let global_remaining = ctx
                .max_nodes
                .unwrap()
                .saturating_sub(ctx.nodes_before + *ctx.nodes);
            let exact_limit = (*ctx.exact_quota_remaining).min(global_remaining);
            let outcome = solve_exact_window_limited_with_nodes(
                board,
                side,
                alpha_disc,
                beta_disc,
                ctx.tt,
                ctx.limit.time_ms.map(|time_ms| TimeBudget {
                    start: ctx.start,
                    time_ms,
                }),
                Some(exact_limit),
            );
            *ctx.nodes += outcome.nodes;
            *ctx.exact_quota_remaining = ctx.exact_quota_remaining.saturating_sub(outcome.nodes);
            ctx.exact_stats.nodes += outcome.nodes;
            match outcome.score {
                Some(score) => {
                    ctx.exact_stats.leaf_completed += 1;
                    if alpha_disc > -64 || beta_disc < 64 {
                        ctx.exact_stats.bound_proof_completed += 1;
                    }
                    ctx.exact_stats.completed = true;
                    return score * 100;
                }
                None => {
                    match outcome.abort_reason {
                        Some(AbortReason::ExactQuota) => {
                            if exact_limit == global_remaining {
                                // exact試行中に全体予算へ到達した。現在の反復を破棄する。
                                *ctx.timed_out = true;
                                return 0;
                            }
                            ctx.exact_stats.aborted_by_quota += 1;
                            // 局所quota切れはこのノードを通常の中盤探索として続ける。
                        }
                        _ => {
                            *ctx.timed_out = true;
                            return 0;
                        }
                    }
                }
            }
        } else {
            return match ctx.limit.time_ms {
                Some(time_ms) => match solve_exact_bounded(
                    board,
                    side,
                    ctx.tt,
                    TimeBudget {
                        start: ctx.start,
                        time_ms,
                    },
                ) {
                    Some(score) => score * 100,
                    None => {
                        *ctx.timed_out = true;
                        0
                    }
                },
                None => solve_exact(board, side, ctx.tt) * 100,
            };
        }
    }

    let legal = board.legal_moves(side);
    if legal == 0 {
        if board.legal_moves(side.opposite()) == 0 {
            // 両者パス: 終局。
            return terminal_score_centi(board, side);
        }
        // 自分だけ合法手がない: パス(深さを消費せず相手番で再帰)。
        // T182: `known_hash`があれば`toggle_side_to_move`の増分更新1回
        // (O(1))で次呼び出しのhashを渡す。フルスキャンとの一致を
        // debug_assertで照合する(本番挙動には影響しない)。
        let pass_hash = known_hash.map(|known| {
            let computed = toggle_side_to_move(known);
            debug_assert_eq!(
                computed,
                zobrist_hash(board, side.opposite()),
                "T182 incremental hash mismatch after pass"
            );
            #[cfg(test)]
            record_incremental_hash_check();
            computed
        });
        return -negascout(board, side.opposite(), depth, -beta, -alpha, ctx, pass_hash);
    }

    if depth == 0 {
        return static_eval(board, side, ctx.weights);
    }

    let hash = known_hash.unwrap_or_else(|| zobrist_hash(board, side));
    let alpha_orig = alpha;
    let mut tt_move: Option<u8> = None;

    if let Some(entry) = ctx.tt.probe(hash, TTDomain::Midgame) {
        tt_move = entry.best_move;
        if entry.depth as u32 >= depth as u32 {
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

    // T048: MPC(Multi-ProbCut)。TT探索で確定しなかった場合のみ試す
    // (置換表で既に済んでいるノードに追加の浅い探索を行うのは無駄なため)。
    // 空き帯×目的深さに対応するT156b校正エントリがある場合だけ発動する。
    // `ctx.suppress_mpc`が立っている(=現在プローブ探索のサブツリー内に
    // いる)間は、MPCの再帰適用による誤差の積み重ねを避けるため試みない
    // (`mpc_try_cutoff`のドキュメント・`SearchCtx::suppress_mpc`参照)。
    if ctx.enable_mpc && !ctx.suppress_mpc {
        if let Some(cut) = mpc_try_cutoff(board, side, depth, alpha, beta, ctx, hash) {
            return cut;
        }
    }

    let moves = ordered_moves(board, side, tt_move, ctx.history.as_deref());

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;
    let mut first = true;

    for mv in moves {
        let mv_bit = 1u64 << mv;
        let next_board = board.apply_move(side, mv_bit);

        // T182: `negascout_or_etc`はこの`(next_board, child_side, depth-1)`を
        // 最大3回(初手のフルウィンドウ・NWSの狭い窓・窓外れ時のフルウィンドウ
        // 再探索)呼び出すが、いずれも同じ子局面なのでhashは1手につき1回だけ
        // 増分計算すれば十分。`own_before`/`own_after`の差分から`flips`を
        // 求める(`Board::apply_move`は`new_own = own | mv_bit | flips`を
        // `own`/`mv_bit`/`flips`が互いに排他的なビット集合として計算するため、
        // `new_own XOR own = mv_bit | flips`となり、`mv_bit`を除けば`flips`が
        // 残る。`flips_for_move`を呼び直す二重計算を避けるための導出)。
        let own_before = match side {
            Side::Black => board.black,
            Side::White => board.white,
        };
        let own_after = match side {
            Side::Black => next_board.black,
            Side::White => next_board.white,
        };
        let flips = (own_after ^ own_before) & !mv_bit;
        let child_hash = incremental_move_hash(hash, mv, side, flips);
        debug_assert_eq!(
            child_hash,
            zobrist_hash(&next_board, side.opposite()),
            "T182 incremental hash mismatch at square {mv}"
        );
        #[cfg(test)]
        record_incremental_hash_check();

        let score = if first {
            -negascout_or_etc(
                &next_board,
                side.opposite(),
                depth - 1,
                -beta,
                -alpha,
                ctx,
                child_hash,
            )
        } else {
            // Null Window Search: まず [alpha, alpha+1) の狭い窓で探索する。
            let scout_score = -negascout_or_etc(
                &next_board,
                side.opposite(),
                depth - 1,
                -alpha - 1,
                -alpha,
                ctx,
                child_hash,
            );
            if scout_score > alpha && scout_score < beta {
                // 窓を外れた(=このスコアが実は最善手かもしれない)ので
                // フルウィンドウで再探索する。
                -negascout_or_etc(
                    &next_board,
                    side.opposite(),
                    depth - 1,
                    -beta,
                    -alpha,
                    ctx,
                    child_hash,
                )
            } else {
                scout_score
            }
        };

        if *ctx.timed_out {
            // 子の探索(のどこか)が時間切れで打ち切られた: このノードの
            // `score`は不完全な探索に基づく不正確な値なので使わず、
            // 置換表への格納も行わずに即座に展開する(T034)。
            return 0;
        }

        if score > best_score {
            best_score = score;
            best_move = Some(mv);
        }
        if best_score > alpha {
            alpha = best_score;
        }
        if alpha >= beta {
            // T089a(要件2): beta cutoffを引き起こした候補手に`depth*depth`を
            // 加算する。`ctx.history`が`None`(従来の`search`/
            // `search_with_eval`等の経路)の間はここも何もしない。
            if let Some(history) = ctx.history.as_deref_mut() {
                history.record_cutoff(side, mv, depth);
            }
            break;
        }
        first = false;
    }

    let bound = if best_score <= alpha_orig {
        Bound::Upper
    } else if best_score >= beta {
        Bound::Lower
    } else {
        Bound::Exact
    };

    ctx.tt.store(TTEntry {
        hash,
        domain: TTDomain::Midgame,
        depth: depth as i8,
        score: best_score,
        bound,
        best_move,
    });

    best_score
}

/// ETC(Enhanced Transposition Cutoff、T051)を試みたうえで、必要なら
/// `negascout`を再帰呼び出しする薄いラッパー。
///
/// `negascout`の候補手ループの3箇所(初手のフルウィンドウ探索、NWSの
/// 狭い窓での探索、窓を外れた場合のフルウィンドウ再探索)は、いずれも
/// 「これから`next_board`(手番`child_side`)を深さ`child_depth`・窓
/// `[alpha, beta)`で探索する」という同じ形をしているため、この関数1つに
/// まとめている。`ctx.enable_etc`が`false`(ETC有効/無効の比較テスト専用)
/// の場合は常に`negascout`をそのまま呼ぶ(MPCと違い、本番コードが
/// `false`を渡すことはない)。
fn negascout_or_etc(
    next_board: &Board,
    child_side: Side,
    child_depth: u8,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
    next_hash: u64,
) -> i32 {
    if ctx.enable_etc {
        if let Some(score) = etc_try_cutoff(
            ctx,
            next_board,
            child_side,
            child_depth,
            alpha,
            beta,
            next_hash,
        ) {
            return score;
        }
    }
    negascout(
        next_board,
        child_side,
        child_depth,
        alpha,
        beta,
        ctx,
        Some(next_hash),
    )
}

/// ETC(Enhanced Transposition Cutoff、T051)本体。
///
/// `negascout`が候補手`mv`を実際に再帰探索する**前**に、着手後の局面
/// (`child_board`, `child_side`)のZobristハッシュで置換表(TT)を覗く。
/// もしそこに、これから行われるはずの再帰呼び出し
/// (`negascout(child_board, child_side, child_depth, alpha, beta, ctx)`)の
/// **冒頭のTT参照ロジック**(このファイル内、`negascout`本体の
/// `if let Some(entry) = ctx.tt.probe(hash) { ... }`ブロック)が即座に
/// リターンすると確定できるだけの情報が既にあれば、実際にその再帰呼び出し
/// を行わずに同じ値を返す。
///
/// # なぜ「探索結果を一切変えない」と言えるか
/// この関数は、`negascout`本体のTT参照ブロックと**全く同じ判定条件**
/// (`entry.depth as u32 >= depth as u32`という深さの十分性チェック、
/// Exact/Lower/Upperの扱い、`alpha >= beta`でのカットオフ確定)を、
/// 再帰呼び出しに入る前に前倒しでシミュレートしているだけである。
/// つまりこの関数が`Some`を返す場合、それは「実際に`negascout`を
/// 再帰呼び出ししたら(その関数の最初のステップとして)必ず同じ値が
/// 即座に返ってくる」ことが保証されているケースに限られるため、
/// 探索結果(最終的な最善手・評価値)は一切変わらない。TTの中身は
/// 過去の探索で確定した厳密な情報であり、MPC(T048)のような統計的な
/// 見込み予測ではないため、この前倒し評価は近似ではなく完全な再現になる。
///
/// # 2つの必須ガード(これを外すと結果が変わってしまう)
/// - `child_depth == 0`: `negascout`本体は、手番側の合法手が0件で
///   パスが必要な場合を除き、`depth == 0`のノードでは**TTを一切参照せず**
///   直接`static_eval`を返す(`negascout`本体で`if depth == 0 { return
///   static_eval(...); }`がハッシュ計算・TT参照より前に位置している)。
///   反復深化で同じ`tt`を使い回すため、過去のより深い探索の結果が
///   このノードのハッシュにたまたま(衝突ではなく本当に同じ局面として)
///   格納されていることは普通に起こりうるが、`depth == 0`の文脈では
///   TTの中身は無関係であり、使ってしまうと実際の再帰呼び出し
///   (`static_eval`を返す)と異なる値を返しうる。そのため`child_depth == 0`
///   では常に`None`を返す。
/// - `child_board`の空きマス数が`ctx.limit.exact_from_empties`以下:
///   `negascout`本体は、TT参照ブロックに到達する**手前**で空きマス数を
///   チェックし、しきい値以下なら終盤完全読み(`solve_exact`/
///   `solve_exact_bounded`)に処理を委譲して`return`する(この分岐は
///   ハッシュ計算・パス判定・depth==0判定のいずれよりも先に実行される)。
///   つまりこの条件を満たす子局面は、実際の再帰呼び出しでは中盤探索用の
///   TT参照ロジックに一度も到達しない。そのため、この条件を満たす場合も
///   常に`None`を返し、呼び出し元(`negascout_or_etc`)に実際の再帰呼び出し
///   (=正しく終盤ソルバーへ委譲される経路)を行わせる。
fn etc_try_cutoff(
    ctx: &SearchCtx,
    child_board: &Board,
    // T182: `child_hash`の計算(呼び出し元の`negascout`候補手ループ)に
    // 既に手番情報が織り込まれているため、この関数自体はもう`child_side`を
    // 使わない(以前は`zobrist_hash(child_board, child_side)`のために
    // 必要だった)。呼び出し元(`negascout_or_etc`)のシグネチャ・呼び出し
    // 引数は変えずに保つため、未使用引数として残す。
    _child_side: Side,
    child_depth: u8,
    alpha: i32,
    beta: i32,
    child_hash: u64,
) -> Option<i32> {
    if child_depth == 0 {
        return None;
    }
    if child_board.empty_count() <= ctx.limit.exact_from_empties as u32 {
        return None;
    }

    // T182: 呼び出し元(`negascout`の候補手ループ)が既に増分計算した
    // `child_hash`をそのまま使う(以前はここで`zobrist_hash`によるフル
    // スキャンを再度行っており、直後に`negascout_or_etc`が実際に
    // `negascout`を呼んだ場合はそちらでも同じハッシュを計算し直す
    // 二重計算だった)。同一性はループ側で既にdebug_assert照合済み。
    let entry = ctx.tt.probe(child_hash, TTDomain::Midgame)?;
    if entry.depth as u32 >= child_depth as u32 {
        let mut alpha = alpha;
        let mut beta = beta;
        match entry.bound {
            Bound::Exact => return Some(entry.score),
            Bound::Lower => alpha = alpha.max(entry.score),
            Bound::Upper => beta = beta.min(entry.score),
        }
        if alpha >= beta {
            return Some(entry.score);
        }
    }
    None
}

/// MPC(Multi-ProbCut、T048)によるカットオフ判定。
///
/// `(empty_bucket, target_depth, probe_depth)` のT156b校正エントリがあり、
/// PV番兵窓外かつ `empties > exact_from_empties + target_depth` の場合だけ
/// 試みる。それ以外は `None` を返して通常探索へ進む。
///
/// affine係数と方向別marginからQ16整数演算で外向きshallow閾値を作り、
/// その閾値を幅1のnull-windowでプローブする。プローブ中はrecursive MPCと
/// exactを無効化し、終了・中断のどちらでもcontextを復元する。
///
/// 浅い探索自体は通常の `negascout` をそのまま再帰呼び出しするため、
/// ノード数カウント・置換表・T034の時間予算チェック
/// (`TIME_CHECK_NODE_INTERVAL`ノードごと)はすべて通常の探索と全く同じ
/// 経路を通る(このMPC専用の分岐が独自の時間チェックを持つことはない)。
/// 浅い探索の途中で時間切れ(`ctx.timed_out`)になった場合は、その結果を
/// カットオフ判定に使わず `None` を返す(呼び出し元の `negascout` は
/// そのまま自身の `if *ctx.timed_out` チェックに落ちて即座に展開される
/// ため、ハングや不正な結果を返す余地はない)。
///
/// この関数がカットオフを返した場合、置換表への格納は行わない(浅い探索
/// に基づく近似的な結果であり、通常探索で得られる「深さ`depth`まで
/// 読み切った」という保証付きのスコアではないため、TTを汚染しないよう
/// 意図的に格納しない)。
///
/// # 再帰的MPCを禁止する理由(T048作業ログ参照)
/// probe深さ自体が別の校正対象になった場合でも、何もしなければこの
/// 関数が呼ぶ浅い探索(プローブ)の**内部**でもさらにMPCが再帰的に
/// 適用され、近似誤差が何重にも積み重なる。実測の自己対戦検証で、この
/// 再帰的MPCを許可すると(`depth>=7`が絡む条件、すなわち`probe_depth>=5`
/// になる条件)、tを1.5→4.0まで引き上げても60局面中20局面以上でトップの
/// 手が変わってしまうほど深刻な棋力低下が確認された一方、再帰が起きない
/// `depth<=6`の条件では24局の自己対戦で全く差が出なかった。そのため
/// `ctx.suppress_mpc`を使い、プローブのサブツリー全体でMPCを無効化する
/// (=MPCは常に「1段だけ」に制限し、プローブ自体は通常のNegaScoutと
/// 同じ精度で探索する)。
fn mpc_try_cutoff(
    board: &Board,
    side: Side,
    depth: u8,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
    hash: u64,
) -> Option<i32> {
    // T048フィードバック(自己対戦検証で発覚した重大な不具合の修正):
    // `alpha`/`beta`のどちらかがまだ番兵値(`-INF`/`INF`)のままの場合、
    // このノードは「ルートからの最左(=最初の候補手)の連鎖」上にある
    // PV探索中のノードである(NegaScoutの設計上、あるノードの最初の子は
    // 親の窓をそのまま反転して受け継ぐため、経路のどこかで実際の値が
    // 1つも返ってきていない限り、`alpha`(または`beta`)は番兵値のまま
    // 伝播し続ける)。このようなノードでは、まだこの局面についてどの
    // 手も一切探索しておらず、フォールバックとなる「実際に確認できた
    // 値」が存在しないため、浅い探索による見込み予測だけで打ち切ると
    // 誤判定時の被害を吸収する手段が無い。
    //
    // 実際に自己対戦検証(depth=8)でこの状態を検出したところ、同じ
    // (`alpha == -INF`, 有限のbeta)の条件で10手連続してベータカットが
    // 連鎖し、実際にはどの手も1つも探索しないまま遠い祖先のbeta値を
    // そのまま返す、という壊滅的な不具合を引き起こしていた
    // (作業ログ参照。`t`をEdaxの目安である1.5から4.0まで引き上げても
    // 全く改善しなかったのは、この不具合が「誤判定率」の問題ではなく
    // 「そもそも適用すべきでないノードに適用していた」という構造的な
    // 問題だったため)。
    //
    // 標準的なアルファベータ探索の設計(null-move pruning等の前方刈り込み
    // 技術全般に共通する定石)にならい、`alpha`/`beta`の両方が既に
    // 実際の値に基づいて確定している(番兵値でない)ノードでのみMPCを
    // 試みるようにする。
    if alpha <= -INF || beta >= INF {
        ctx.mpc_stats.skipped_pv_window += 1;
        return None;
    }

    let empties = board.empty_count();
    let Some(base_calibration) = mpc::calibration_for(empties, depth) else {
        ctx.mpc_stats.skipped_uncalibrated += 1;
        return None;
    };
    if empties <= ctx.limit.exact_from_empties as u32 + depth as u32 {
        ctx.mpc_stats.skipped_exact_boundary += 1;
        return None;
    }
    ctx.mpc_stats.eligible_nodes += 1;

    // T176: `ctx.mpc_margin_t`が`None`(既定・本番経路)のときは`base_calibration`
    // (t=1.5固定表)をそのまま使う。`Some(t)`のときだけ、margin_high/margin_low を
    // `ceil(t*sigma)`で再計算したコピーを使う(スロープ・切片・プローブ深さは不変)。
    let overridden_calibration;
    let calibration = match ctx.mpc_margin_t {
        Some(t) => {
            overridden_calibration = mpc::calibration_with_margin_t(base_calibration, t);
            &overridden_calibration
        }
        None => base_calibration,
    };

    // プローブの全return経路で再帰MPCとexactを元の状態へ復元する。
    let old_suppress_mpc = ctx.suppress_mpc;
    let old_exact_enabled = ctx.exact_enabled;
    ctx.suppress_mpc = true;
    ctx.exact_enabled = false;
    let cut = mpc_try_cutoff_inner(board, side, calibration, alpha, beta, ctx, hash);
    ctx.exact_enabled = old_exact_enabled;
    ctx.suppress_mpc = old_suppress_mpc;
    cut
}

/// [`mpc_try_cutoff`] の本体(`ctx.suppress_mpc`の設定・復元と分離するため
/// 分けている)。
fn mpc_try_cutoff_inner(
    board: &Board,
    side: Side,
    calibration: &mpc::Calibration,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
    hash: u64,
) -> Option<i32> {
    let probe_depth = calibration.probe_depth;
    let histogram_index = probe_depth.min(64) as usize;

    // 外向きfail-high: a*shallow+b-margin_high >= beta。
    let high_bound = mpc::high_probe_bound(calibration, beta);
    if high_bound > -INF && high_bound < INF {
        ctx.mpc_stats.probe_attempts_high += 1;
        ctx.mpc_stats.probe_depth_histogram[histogram_index] += 1;
        let nodes_before = *ctx.nodes;
        // T182: プローブは呼び出し元(`negascout`)と同じ`(board, side)`を
        // 見るので、呼び出し元が既に持っている`hash`をそのまま渡せる
        // (フルスキャンの再計算は不要)。
        let probe = negascout(
            board,
            side,
            probe_depth,
            high_bound - 1,
            high_bound,
            ctx,
            Some(hash),
        );
        ctx.mpc_stats.probe_nodes += ctx.nodes.saturating_sub(nodes_before);
        if *ctx.timed_out {
            return None;
        }
        if probe >= high_bound {
            ctx.mpc_stats.cuts_high += 1;
            ctx.mpc_stats.cut_depth_histogram[calibration.target_depth.min(64) as usize] += 1;
            return Some(beta);
        }
    }

    // 外向きfail-low: a*shallow+b+margin_low <= alpha。
    let low_bound = mpc::low_probe_bound(calibration, alpha);
    if low_bound > -INF && low_bound < INF {
        ctx.mpc_stats.probe_attempts_low += 1;
        ctx.mpc_stats.probe_depth_histogram[histogram_index] += 1;
        let nodes_before = *ctx.nodes;
        let probe = negascout(
            board,
            side,
            probe_depth,
            low_bound,
            low_bound + 1,
            ctx,
            Some(hash),
        );
        ctx.mpc_stats.probe_nodes += ctx.nodes.saturating_sub(nodes_before);
        if *ctx.timed_out {
            return None;
        }
        if probe <= low_bound {
            ctx.mpc_stats.cuts_low += 1;
            ctx.mpc_stats.cut_depth_histogram[calibration.target_depth.min(64) as usize] += 1;
            return Some(alpha);
        }
    }

    None
}

/// 終局時の最終石差(`side`から見たcenti-disc値)を計算する。
///
/// `endgame::final_score`(素の石差、1石=1)を呼び出して centi-disc
/// スケール(×100)に変換するだけの薄いラッパー。「石数が多い方が
/// 残り空きマスを総取りする」という終局ロジック自体は `endgame.rs` に
/// 一本化されており、ここでは重複実装しない(T007)。
fn terminal_score_centi(board: &Board, side: Side) -> i32 {
    final_score(board, side) * 100
}

/// 合法手を簡易的なムーブオーダリングで並べ替えて返す。
///
/// 優先順位: TT手(あれば最優先) → 隅 → 相手の着手後合法手数(モビリティ)が
/// 少ない順。
///
/// T089a: `history`が`Some`のとき(ノード予算探索の経路のみ、
/// [`SearchCtx::history`]参照)は、[`HISTORY_BEFORE_MOBILITY`]の設定に
/// 従い、corner優先の後にhistory heuristicの値を降順でタイブレークとして
/// 追加する(mobilityより前か後かは同定数で切り替える。要件4のablation)。
/// `history`が`None`のとき(従来の`search`/`search_with_eval`/
/// `search_all_moves*`経路)は、本タスク(T089a)着手前と完全に同じ
/// 2キーソート(corner優先→mobility昇順のみ)を行う(既存のfixed-depth
/// 回帰テストが固定しているタイブレーク順・ノード数を変えないため)。
fn ordered_moves(
    board: &Board,
    side: Side,
    tt_move: Option<u8>,
    history: Option<&HistoryTable>,
) -> Vec<u8> {
    let legal = board.legal_moves(side);
    let mut moves: Vec<u8> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb.trailing_zeros() as u8);
        remaining &= remaining - 1;
    }

    match history {
        None => {
            moves.sort_by_key(|&mv| {
                let bit = 1u64 << mv;
                let is_corner = bit & CORNER_MASK != 0;
                let next_board = board.apply_move(side, bit);
                let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
                (if is_corner { 0u32 } else { 1u32 }, opp_mobility)
            });
        }
        Some(history) if HISTORY_BEFORE_MOBILITY => {
            // 構成B: corner優先 → history降順 → mobility昇順。
            moves.sort_by_key(|&mv| {
                let bit = 1u64 << mv;
                let is_corner = bit & CORNER_MASK != 0;
                let next_board = board.apply_move(side, bit);
                let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
                let hist = history.get(side, mv);
                (
                    if is_corner { 0u32 } else { 1u32 },
                    std::cmp::Reverse(hist),
                    opp_mobility,
                )
            });
        }
        Some(history) => {
            // 構成A(既定): corner優先 → mobility昇順 → history降順。
            moves.sort_by_key(|&mv| {
                let bit = 1u64 << mv;
                let is_corner = bit & CORNER_MASK != 0;
                let next_board = board.apply_move(side, bit);
                let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
                let hist = history.get(side, mv);
                (
                    if is_corner { 0u32 } else { 1u32 },
                    opp_mobility,
                    std::cmp::Reverse(hist),
                )
            });
        }
    }

    if let Some(tm) = tt_move {
        if let Some(pos) = moves.iter().position(|&m| m == tm) {
            moves.remove(pos);
            moves.insert(0, tm);
        }
    }

    moves
}

/// 置換表から読み筋(PV)を再構成する。
///
/// ルート局面から`best_move`を辿っていき、置換表にエントリが無くなるか
/// `max_len`手に達したら打ち切る。途中でパスが必要な局面に当たった場合は
/// 手番だけ入れ替えて続行する(パスは読み筋には現れない)。
fn extract_pv(board: &Board, side: Side, tt: &TranspositionTable, max_len: usize) -> Vec<u8> {
    let mut pv = Vec::new();
    let mut current = *board;
    let mut current_side = side;

    for _ in 0..max_len {
        // 手番側に合法手がなければパス(相手番に切り替えて続行)。
        // 両者とも合法手がなければ読み筋はここまで。
        if current.legal_moves(current_side) == 0 {
            if current.legal_moves(current_side.opposite()) == 0 {
                break;
            }
            current_side = current_side.opposite();
        }

        let hash = zobrist_hash(&current, current_side);
        let Some(entry) = tt.probe(hash, TTDomain::Midgame) else {
            break;
        };
        let Some(mv) = entry.best_move else {
            break;
        };

        let bit = 1u64 << mv;
        if current.legal_moves(current_side) & bit == 0 {
            // 想定外(ハッシュ衝突等): 安全側に倒して打ち切る。
            break;
        }

        pv.push(mv);
        current = current.apply_move(current_side, bit);
        current_side = current_side.opposite();
    }

    pv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_limit(max_depth: u8, exact_from_empties: u8) -> SearchLimit {
        SearchLimit {
            max_depth,
            time_ms: None,
            exact_from_empties,
        }
    }

    // --- テスト用ユーティリティ: 初期局面から決定的に手を進めて空きマスを減らす ---
    // (endgame.rsのテストと同様の考え方。モジュールをまたいだ共有はしていない)

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

    fn board_from_obf(obf: &str) -> Board {
        assert_eq!(obf.len(), 64);
        let mut black = 0u64;
        let mut white = 0u64;
        for (i, cell) in obf.bytes().enumerate() {
            match cell {
                b'X' => black |= 1u64 << i,
                b'O' => white |= 1u64 << i,
                b'-' => {}
                _ => panic!("invalid OBF cell"),
            }
        }
        Board { black, white }
    }

    #[test]
    fn search_from_initial_position_returns_a_legal_move() {
        let board = Board::initial();
        let limit = default_limit(6, 24);
        let mut tt = TranspositionTable::new(4);

        let result = search(&board, Side::Black, &limit, &mut tt);

        let best_move = result
            .best_move
            .expect("initial position must have a best move");
        let legal = board.legal_moves(Side::Black);
        assert!(
            legal & (1u64 << best_move) != 0,
            "best_move {} is not among the legal moves {:?}",
            best_move,
            legal
        );
        assert_eq!(result.depth, 6);
    }

    #[test]
    fn search_delegates_to_exact_solver_and_matches_its_score() {
        // 空きマス数が閾値以下になるよう手を進めた局面を用意する。
        let (board, side) = play_until_empties(10, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;

        let limit = default_limit(20, exact_threshold);
        let mut tt_search = TranspositionTable::new(4);
        let result = search(&board, side, &limit, &mut tt_search);

        let mut tt_direct = TranspositionTable::new(4);
        let direct_score = solve_exact(&board, side, &mut tt_direct) * 100;

        assert_eq!(
            result.score, direct_score,
            "search() should delegate to solve_exact and report the same centi-disc score"
        );
        assert_eq!(result.depth, board.empty_count() as u8);
    }

    #[test]
    fn search_favors_black_when_black_dominates_the_board() {
        // T004(eval.rs)のテストと同じ発想: 黒が4隅を追加で保持する局面。
        // 初期局面をベースに4隅すべてを黒石にすることで、中盤探索の
        // ムーブオーダリング・葉評価が正しく統合されていれば黒有利な
        // スコアになるはず。
        let initial = Board::initial();
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board {
            black: initial.black | corners,
            white: initial.white,
        };

        let limit = default_limit(4, 10);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        assert!(
            result.score > 0,
            "black should be clearly favored, got score={}",
            result.score
        );
    }

    #[test]
    fn iterative_deepening_completes_without_error_and_depth_increases() {
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        for max_depth in [1u8, 2, 3] {
            let limit = default_limit(max_depth, 10);
            let result = search(&board, Side::Black, &limit, &mut tt);
            assert_eq!(result.depth, max_depth);
            assert!(result.best_move.is_some());
        }
    }

    #[test]
    fn search_completes_quickly_from_initial_position_up_to_depth_around_ten() {
        // 明らかな無限ループ・指数的爆発がないことの疎通確認。
        // (NPSの厳密な計測はT008のFFOベンチで行う)
        let board = Board::initial();
        let limit = default_limit(9, 12);
        let mut tt = TranspositionTable::new(64);

        let start = std::time::Instant::now();
        let result = search(&board, Side::Black, &limit, &mut tt);
        let elapsed = start.elapsed();

        println!(
            "search up to depth={} finished in {:?}, nodes={}, score={}",
            result.depth, elapsed, result.nodes, result.score
        );

        assert!(result.best_move.is_some());
    }

    #[test]
    fn reusing_tt_across_calls_with_different_exact_from_empties_does_not_crash_and_updates_marker()
    {
        // T007: TTスケール混同防止の回帰テスト。
        // 同じ `TranspositionTable` を使い回したまま `exact_from_empties` を
        // 変えて2回 `search()` を呼んでもクラッシュせず、かつ2回目の呼び出し
        // 後には `tt.last_exact_from_empties()` が今回の値に更新されている
        // ことを確認する(自動クリア処理が有効であることの間接的な確認)。
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        let limit_x = default_limit(4, 10);
        let _ = search(&board, Side::Black, &limit_x, &mut tt);
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(10),
            "after the first search(), tt should remember exact_from_empties=10"
        );

        // exact_from_empties を変えて同じTTを使い回す。
        let limit_y = default_limit(4, 12);
        let result = search(&board, Side::Black, &limit_y, &mut tt);

        assert!(
            result.best_move.is_some(),
            "search() should still return a valid result after reusing the tt \
             with a different exact_from_empties"
        );
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(12),
            "after the second search(), tt should remember the new exact_from_empties=12"
        );
    }

    #[test]
    fn search_terminal_score_matches_endgame_final_score_directly() {
        // T007: 終局ロジック重複解消の回帰テスト。
        // `search()` が返す終局スコア(両者パスの局面)が、
        // `endgame::final_score` を直接呼んだ結果(×100)と一致することを
        // 確認する。これは `terminal_score_centi` が独自実装ではなく
        // `endgame::final_score` を呼び出す薄いラッパーになったことの確認。
        //
        // 全マスを黒で埋め、1マスだけ空けておくと、その空きマスに隣接する
        // マスは全て黒なので両者とも合法手がなく即終局する
        // (endgame.rsの同種のテストと同じ構成)。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.empty_count(), 1);
        assert_eq!(board.legal_moves(Side::Black), 0);
        assert_eq!(board.legal_moves(Side::White), 0);

        // exact_from_empties=0 にすることで、空き1マスのこの局面は
        // (1 <= 0 が偽なので)終盤ソルバーには渡らず、必ずNegaScout側の
        // `negascout` 関数内で両者パス判定 → `terminal_score_centi` の
        // 経路を通る。
        let limit = default_limit(4, 0);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        let expected = final_score(&board, Side::Black) * 100;
        assert_eq!(
            result.score, expected,
            "search()'s terminal score should match endgame::final_score(...) * 100 exactly"
        );
    }

    // ------------------------------------------------------------------
    // T018: search_all_moves のテスト
    // ------------------------------------------------------------------

    #[test]
    fn search_all_moves_from_initial_position_returns_all_four_opening_moves() {
        let board = Board::initial();
        let limit = default_limit(4, 10);

        let evals = search_all_moves(&board, Side::Black, &limit);

        assert_eq!(
            evals.len(),
            4,
            "initial position should have exactly 4 legal moves (d3, c4, f5, e6)"
        );

        let notations: Vec<String> = evals
            .iter()
            .map(|e| crate::protocol::square_to_notation(e.mv))
            .collect();
        for expected in ["d3", "c4", "f5", "e6"] {
            assert!(
                notations.contains(&expected.to_string()),
                "expected opening move {expected} to be present in {notations:?}"
            );
        }
    }

    #[test]
    fn search_all_moves_from_initial_position_gives_the_four_d4_symmetric_opening_moves_identical_scores(
    ) {
        // T139回帰テスト: 初期局面の4つの合法手(d3/c4/f5/e6)は互いにD4対称
        // (盤面全体を90度回転すると initial position はそのまま自分自身に
        // 写り、4つの初手は互いに写り合う)。以前は
        // `search_all_moves_with_eval`が全合法手・全反復深化を通じて
        // 単一の共有TTを使い回していたため、先に評価した手が残した
        // エントリがMPC近似枝刈りの判断に混入し、最大1石のズレが生じ得た
        // (T138調査)。T139対応(手ごとに独立したローカルTT)により、
        // 4つの対称な初手はすべて完全に同じ評価値になるはず。
        let board = Board::initial();
        let limit = default_limit(10, 12);

        let evals = search_all_moves(&board, Side::Black, &limit);
        assert_eq!(evals.len(), 4);

        let scores: std::collections::HashMap<String, i32> = evals
            .iter()
            .map(|e| (crate::protocol::square_to_notation(e.mv), e.score))
            .collect();
        let d3 = scores["d3"];
        for mv in ["c4", "f5", "e6"] {
            assert_eq!(
                scores[mv], d3,
                "opening move {mv} (score={}) should exactly match d3's score ({d3}); \
                 all four opening moves are D4-symmetric to each other",
                scores[mv]
            );
        }
    }

    #[test]
    fn search_all_moves_is_deterministic_across_repeated_calls_even_with_a_prewarmed_local_state()
    {
        // T139回帰テスト: `search_all_moves`はもう呼び出し元のTTを共有しない
        // ため、同一局面に対して呼ぶたびに完全に同じ結果が返るはず
        // (TT状態に依存しない)。この関数はもはやTTを引数に取らないため、
        // 「事前にTTを汚す先行探索を挟む」ことを、時間予算なし・
        // 十分な深さの先行`search_all_moves`呼び出し(=TTを大量に使う
        // 重い探索)を先に走らせることで再現する。
        let board = Board::initial();
        let limit = default_limit(10, 12);

        // 事前に(無関係の局面も含め)重い探索を走らせ、もし何らかの
        // グローバル/共有状態が残っていれば結果が乱れるはずの状況を作る。
        let (warmup_board, warmup_side) = play_until_empties(6, first_move_strategy);
        let _ = search_all_moves(&warmup_board, warmup_side, &default_limit(10, 12));
        let _ = search_all_moves(&board, Side::Black, &limit);

        let first = search_all_moves(&board, Side::Black, &limit);
        let second = search_all_moves(&board, Side::Black, &limit);

        assert_eq!(
            first.len(),
            second.len(),
            "both calls should return the same number of legal moves"
        );
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a.mv, b.mv, "move order should be identical across repeated calls");
            assert_eq!(
                a.score, b.score,
                "move {} score should be identical across repeated calls regardless of prior \
                 (unrelated) search activity",
                a.mv
            );
            assert_eq!(a.is_exact, b.is_exact);
        }
    }

    #[test]
    fn search_all_moves_with_eval_local_tt_clear_prevents_cross_move_node_count_pollution() {
        // T170(T145申し送り): `local_tt.clear()`をうっかり削除しても既存の
        // 回帰テスト群が検知できないことがT145で判明していた
        // (`tasks/T145-analyze-symmetry-followup.md`作業ログ参照)。
        //
        // 検知できなかった理由: `search_all_moves_with_eval`の各手の探索は
        // MPC無効(`enable_mpc: false`)・ノード予算なし(`max_nodes: None`)で
        // 行われるため、`time_ms: None`(時間無制限、反復深化を`max_depth`まで
        // 必ず完走する)の下では、alpha-beta+TTの数学的な性質により
        // **返すスコア自体はTTの初期状態に依存しない**(手の評価順序を
        // 変えても最終的なmin-max値は変わらない、というalpha-betaの基本的な
        // 正しさの帰結)。clear()の有無で変わるのは「探索したノード数」
        // (TTヒットで再計算を省ける分だけ減る)であり、`MoveEval`はノード数を
        // 外部に公開していないため、これまでのテストは事実上この差を
        // 観測できていなかった。
        //
        // 検討したが不採用にした方式: 「mv_keepを唯一の合法手にした孤立盤面」
        // を作り、他の合法手を評価してからmv_keepを評価する多合法手盤面と
        // ノード数を比較する案(2つの異なる盤面を比較)を最初に試した。
        // しかし、他の合法手の着手先マスを石で埋めて非合法化しようとすると、
        // どの色で埋めてもかなりの高確率(実測数千パターン中大半)で別方向に
        // 新しい合法手が偶然生まれてしまい、「他の合法手が0個」を満たす盤面を
        // 安定して構築できなかった。さらに、mv_keepのレイ(反転が起きうる
        // 8方向)の外側だけに石を追加して他の合法手の集合を変える案でも、
        // 追加した石がmv_keep着手後の局面にそのまま残ってしまい、比較対象の
        // 「mv_keep着手後の局面」自体が2盤面間で一致しなくなる(ノード数の差が
        // TT汚染由来なのか局面の違い由来なのか切り分けられなくなる)ことが
        // 判明した。2つの盤面を用意する限り、「他の合法手の集合を変える」ことと
        // 「mv_keep着手後の局面を完全一致させる」ことは両立しない
        // (前者を満たすには盤面のどこかを変える必要があり、その変更は
        // mv_keepのレイ外であっても着手後の局面にそのまま残ってしまうため)。
        //
        // 採用した方式: 盤面は1つだけ使い、`search_all_moves_with_eval_core`が
        // 内部的に評価する合法手の集合をテスト専用パラメータ
        // (`search_all_moves_with_eval_core_restricted`の`restrict_to`)で
        // 絞り込むことで、「他の合法手を先に評価してからmv_keepを評価する
        // 呼び出し」と「mv_keepだけを評価する呼び出し」を作る。同一盤面から
        // 導出するため、mv_keep着手後の局面は自明に完全一致する
        // (`board.apply_move`は`restrict_to`を経由せず盤面のみで決まる)。
        //
        // `local_tt.clear()`が正しく働いていれば、mv_keepの探索はどちらの
        // 呼び出しでも空のlocal_ttから始まるため、探索するノード数は
        // **完全に一致する**はず。TTを意図的に小さくして(衝突・追い出しが
        // 起きやすい状態にして)、他の合法手が残した先行エントリが
        // mv_keep自身の反復深化(自分の浅い深さの探索結果を深い深さの
        // 探索が再利用する仕組み)を阻害しうる状態を作っている。
        let (board, side) = random_position(0x7170_5EED, 40);
        let legal = board.legal_moves(side);
        let mut moves: Vec<u8> = Vec::new();
        let mut remaining = legal;
        while remaining != 0 {
            let lsb = remaining & remaining.wrapping_neg();
            moves.push(lsb.trailing_zeros() as u8);
            remaining &= remaining - 1;
        }
        assert!(
            moves.len() >= 4,
            "need several legal moves for meaningful prior-move TT pollution, got {} (adjust the \
             seed/target_empties if this position's move count drifts)",
            moves.len()
        );

        // mv_keep = 合法手のうち最後に評価される手(LSB優先順で末尾、
        // すなわち他の全ての合法手の探索が終わった後に評価される)。
        let mv_keep = *moves.last().unwrap();

        // TTを小さくして衝突・追い出しを起きやすくする(本番は16MB)。
        const TINY_TT_MB: usize = 1;
        let limit = SearchLimit {
            max_depth: 8,
            time_ms: None,
            exact_from_empties: 0,
        };

        // full: 通常どおり全合法手を評価する(mv_keepは最後)。
        let full = search_all_moves_with_eval_core_restricted(
            &board, side, &limit, None, TINY_TT_MB, None,
        );
        let (full_eval, full_nodes) = *full
            .iter()
            .find(|(e, _)| e.mv == mv_keep)
            .expect("mv_keep should be among the full-move results");

        // solo: mv_keepだけを評価する(他の合法手を評価しないため、
        // local_tt.clear()の有無に関わらずローカルTTは事実上フレッシュな
        // 状態からmv_keepの探索に入る = 「clear()が働いた場合」の基準値)。
        let solo = search_all_moves_with_eval_core_restricted(
            &board,
            side,
            &limit,
            None,
            TINY_TT_MB,
            Some(&[mv_keep]),
        );
        assert_eq!(solo.len(), 1);
        let (solo_eval, solo_nodes) = solo[0];

        assert_eq!(
            full_eval.score, solo_eval.score,
            "mv_keep's score should match regardless of prior moves' search activity \
             (alpha-beta without MPC/node-budget is TT-state-invariant for the final value)"
        );
        assert_eq!(
            full_nodes, solo_nodes,
            "mv_keep's node count should be identical whether it is evaluated after several \
             other moves in the same search_all_moves_with_eval call, or alone as the only \
             move under consideration; a difference here means local_tt.clear() is not fully \
             resetting the table between moves (cross-move TT pollution regression)"
        );
    }

    #[test]
    fn search_all_moves_max_score_matches_search_best_score() {
        // 整合性チェック: search_all_moves() が返す評価値の最大値は、
        // 同じ局面・同じ limit で search() (単一最善手API) が返す評価値と
        // 一致するはず(どちらも同じ深さでの厳密なmax-of-children)。
        let board = Board::initial();
        let limit = default_limit(4, 10);

        let evals = search_all_moves(&board, Side::Black, &limit);
        let max_score = evals
            .iter()
            .map(|e| e.score)
            .max()
            .expect("initial position should have at least one legal move");

        let mut tt_single = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt_single);

        assert_eq!(
            max_score, result.score,
            "the best score among search_all_moves() results should match search()'s score"
        );
    }

    #[test]
    fn search_all_moves_uses_exact_solver_when_next_position_is_within_threshold() {
        // 各手について、着手後の空きマス数がちょうど exact_from_empties に
        // 一致するように limit を組み立てる。この条件下では、全ての手の
        // 評価値が完全読み(solve_exact, 石差×100, 手番反転)に基づいている
        // はず。
        let (board, side) = play_until_empties(7, first_move_strategy);
        let empties_before = board.empty_count();
        // 着手すると必ず空きマスがちょうど1つ減るので、これで
        // 「着手後の空きマス数 <= exact_from_empties」を全ての手について
        // 満たせる。
        let exact_threshold = (empties_before - 1) as u8;
        let limit = default_limit(20, exact_threshold);

        let evals = search_all_moves(&board, side, &limit);
        assert!(!evals.is_empty());

        for eval in &evals {
            let next_board = board.apply_move(side, 1u64 << eval.mv);
            assert_eq!(
                next_board.empty_count(),
                exact_threshold as u32,
                "test setup should guarantee next_empties == exact_threshold for every move"
            );

            let mut tt_direct = TranspositionTable::new(4);
            let expected = -(solve_exact(&next_board, side.opposite(), &mut tt_direct) * 100);
            assert_eq!(
                eval.score, expected,
                "move {} should be scored via the exact solver",
                eval.mv
            );
            assert!(
                eval.is_exact,
                "move {} was scored via the exact solver, so is_exact should be true",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_is_exact_flag_matches_the_evaluation_method_actually_used_at_the_boundary()
    {
        // レビュー指摘(T018フィードバック1件目)の回帰テスト:
        // 「着手前の局面の空きマス数」と「exact_from_empties」の比較だけで
        // score.type を決めると、exact_from_empties + 1 という境界で実態と
        // 食い違う(着手後は必ず空きマスが1減るため、着手前の空きマス数が
        // ちょうど exact_from_empties + 1 のとき、全ての手は実際には完全
        // 読みで評価されるが、着手前ベースの判定では「探索(midgame)」だと
        // 誤判定してしまう)。
        //
        // `MoveEval::is_exact` が「着手前の空きマス数」ではなく「各手が
        // 実際にどちらの方式で評価されたか」を正しく反映していることを、
        // この境界条件で確認する。
        let (board, side) = play_until_empties(7, first_move_strategy);
        let empties_before = board.empty_count();
        let exact_threshold = (empties_before - 1) as u8; // 境界: empties_before == exact_threshold + 1

        assert_eq!(
            empties_before,
            exact_threshold as u32 + 1,
            "test setup should place empties_before exactly one above exact_threshold"
        );

        let limit = default_limit(20, exact_threshold);
        let evals = search_all_moves(&board, side, &limit);

        assert!(!evals.is_empty());
        for eval in &evals {
            assert!(
                eval.is_exact,
                "move {} should be flagged as exact-solved at the exact_from_empties+1 boundary \
                 (this is exactly the case the pre-move-empties-based score.type judgement got wrong)",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_is_exact_is_false_when_above_the_exact_threshold() {
        // 対照テスト: 十分に空きマスが多い(exact_from_empties を大きく
        // 上回る)局面では、全ての手が探索(NegaScout)経由、つまり
        // `is_exact == false` になることを確認する。
        let board = Board::initial();
        let limit = default_limit(4, 10);

        let evals = search_all_moves(&board, Side::Black, &limit);
        assert!(!evals.is_empty());
        for eval in &evals {
            assert!(
                !eval.is_exact,
                "move {} should not be flagged as exact-solved when far from the endgame",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_respects_time_ms_budget_and_returns_promptly() {
        // レビュー指摘(T018フィードバック2件目)の回帰テスト:
        // time_ms を指定すれば、たとえ max_depth が大きくても
        // (合法手数 × 高深度を律儀に反復深化し続けることなく)
        // 妥当な時間で打ち切られることを確認する。
        //
        // 初期局面から depth=20 まで4手すべてを time_ms 制限なしで
        // 反復深化すると非常に長い時間がかかる(本テストでは実行しない)。
        // ここでは time_ms=50 を指定し、その予算内に近い時間で
        // 関数が返ってくること(かつ全4手が欠落なく返ること)を確認する。
        let board = Board::initial();
        let limit = SearchLimit {
            max_depth: 20,
            time_ms: Some(50),
            exact_from_empties: 10,
        };
        let start = std::time::Instant::now();
        let evals = search_all_moves(&board, Side::Black, &limit);
        let elapsed = start.elapsed();

        println!("search_all_moves with time_ms=50 finished in {elapsed:?}");

        assert_eq!(evals.len(), 4, "all 4 legal moves should still be present");
        assert!(
            elapsed < std::time::Duration::from_millis(2000),
            "search_all_moves should honor time_ms and return well within 2s, took {elapsed:?}"
        );
    }

    #[test]
    fn fair_share_time_ms_divides_the_remaining_budget_evenly_across_the_remaining_moves() {
        // T076回帰テスト(決定的・ビルド速度に依存しない): `fair_share_time_ms`
        // が「残り時間予算 / 残り合法手数」を計算していることを直接検証する。
        // 経過時間(壁時計)には依存しない純粋関数なので、debug/releaseどちらの
        // ビルドでも、どんなマシン速度でも常に同じ結果になる。
        assert_eq!(
            fair_share_time_ms(300, 0, 12),
            25,
            "12手で300msを均等に割ると1手25ms"
        );
        assert_eq!(
            fair_share_time_ms(300, 100, 4),
            50,
            "経過後の残り200msを、残り4手で均等に割ると1手50ms"
        );
        assert_eq!(
            fair_share_time_ms(300, 25, 11),
            25,
            "1手目が持ち分ちょうど(25ms)を使い切った直後、残り11手はまだ25msずつ持てる"
        );
    }

    #[test]
    fn fair_share_time_ms_lets_a_move_that_finishes_early_pass_its_leftover_budget_to_the_rest() {
        // T076: ある合法手が自分の持ち分より早く完走すれば、その分は
        // 後続の合法手の持ち分の計算(`elapsed_ms`が小さいまま)に自動的に
        // 反映される(=先に完走した手の余りが後続に回る)ことを確認する。
        // 1手目の持ち分は 300/12=25ms だが、実際には 5ms しか経過しなかった
        // (早く完走した)とすると、残り11手は (300-5)/11 ≒ 26ms 前後に増える。
        let share_if_move1_used_full_budget = fair_share_time_ms(300, 25, 11);
        let share_if_move1_finished_early = fair_share_time_ms(300, 5, 11);
        assert!(
            share_if_move1_finished_early > share_if_move1_used_full_budget,
            "1手目が早く完走したときの方が、後続の手の持ち分が大きくなるはず \
             (early={share_if_move1_finished_early}, full={share_if_move1_used_full_budget})"
        );
    }

    #[test]
    fn fair_share_time_ms_never_exceeds_the_total_budget_even_after_overshoot() {
        // T034のノード間隔チェック(1024ノードごと)の粒度により、ある手が
        // 自分の持ち分を(わずかに)超えて経過時間を消費してしまうことは
        // ありうる。その場合でも `fair_share_time_ms` は負の残り予算を
        // 0未満にせず(`saturating_sub`)、後続の手には単に 0ms
        // (=depth=1のみ)を割り当てる、というグレースフルな劣化に
        // とどまることを確認する(パニックしない・アンダーフローしない)。
        assert_eq!(
            fair_share_time_ms(300, 400, 5),
            0,
            "経過時間が総予算を超えていても0を返し、アンダーフローでパニックしない"
        );
    }

    #[test]
    fn fair_share_time_ms_treats_zero_moves_left_the_same_as_one_to_avoid_division_by_zero() {
        assert_eq!(
            fair_share_time_ms(300, 0, 0),
            300,
            "moves_left=0はmax(1)で1として扱われ、ゼロ除算にならない"
        );
    }

    #[test]
    #[ignore] // T076: 実測に基づく回帰テスト(下記詳細参照)。壁時計の経過時間で
              // 実際の探索深さが決まるため、debugビルド(cargo testの既定)では
              // 1ノードあたりの評価が大幅に遅く、`time_ms=1000`という現実的な
              // (=本番のMIDGAME_ANALYZE_LIMIT相当の)予算内では十分な深さに
              // 到達できず不安定になることを確認済み(作業ログ参照)。
              // `cargo test -p engine --lib --release -- --ignored --nocapture`
              // で実行すること(FFOの重いテストと同じ理由でデフォルト実行から
              // 除外している)。
    fn search_all_moves_with_eval_gives_a_fair_time_share_to_each_move_instead_of_letting_the_first_move_starve_the_rest(
    ) {
        // T076回帰テスト: ユーザー報告(2026-07-12、中盤練習モードで実際に
        // 打った手 b4 が「失敗」、悪手であるはずの b2 が「正解手」と誤判定
        // された)を再現する具体的な局面(合法手12箇所)。
        //
        // 局面は本タスクの調査で `eval_cli gen`(自己対戦ランダム局面生成)
        // から抽出した、黒番・石19個(黒8・白11)・合法手12箇所・b2/b4が
        // ともに合法手、という報告と一致する条件を満たす局面(作業ログ参照。
        // 過去の調査ログから元のバグ報告局面の正確なビットボード値は
        // 得られなかったため、同じ条件・同じ根本原因のバグを独立に
        // 再現できる局面を新たに特定した)。
        //
        // Edax(level10)による検証(作業ログ参照): この局面ではb4(黒視点
        // +14石)がb2(黒視点-1石)より明確に優る。深さ10/11の時間無制限の
        // 本エンジン探索でも同じ方向(b4がb2より優る)が確認できる一方、
        // 修正前の実装(合計時間予算を早い者勝ちで共有)では、`MIDGAME_
        // ANALYZE_LIMIT`相当の設定(depth16, exactFromEmpties24,
        // timeMs=300)でb2がb4より大きく優る(=b2が「正解手」)と誤判定
        // していた(先頭の合法手 g1 が予算のほぼ全部を消費し、b2 を含む
        // 残り全ての合法手が depth=1 しか探索されなかったため)。
        //
        // 本テストは、修正後の実装(公平な時間配分)+ 本タスクで
        // `MIDGAME_ANALYZE_LIMIT.timeMs` を引き上げた後の値(1000ms)で、
        // b4 が b2 より優る(=b2 がb4より上位にランクされない)ことを
        // release ビルドで確認する。
        let board = Board {
            black: 0x0000_1010_5000_1038,
            white: 0x0000_000c_0c7c_6000,
        };
        assert_eq!(
            board.empty_count(),
            45,
            "sanity check: 19 discs on the board"
        );

        let limit = SearchLimit {
            max_depth: 16,
            time_ms: Some(1000),
            exact_from_empties: 24,
        };
        let start = std::time::Instant::now();
        let evals = search_all_moves(&board, Side::Black, &limit);
        let elapsed = start.elapsed();
        println!("T076 repro finished in {elapsed:?}");

        assert_eq!(evals.len(), 12, "all 12 legal moves should be present");
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "search_all_moves should still return promptly, took {elapsed:?}"
        );

        // b2 = square index 9, b4 = square index 25 (rank*8+file, a1..h8 order).
        let b2 = evals
            .iter()
            .find(|e| e.mv == 9)
            .expect("b2 should be a legal move");
        let b4 = evals
            .iter()
            .find(|e| e.mv == 25)
            .expect("b4 should be a legal move");

        assert!(
            b4.score >= b2.score,
            "b4 (score={}) should be evaluated as at least as good as b2 (score={}), and in \
             practice clearly better; if this fails, the fair time-share fix regressed and the \
             first-evaluated move is starving the others' search depth again",
            b4.score,
            b2.score
        );
    }

    #[test]
    fn search_all_moves_returns_empty_vec_when_no_legal_moves() {
        // 手番側に合法手が無い局面(パス・終局)では、空の Vec を返す
        // (エラーにしない)。search.rs の他のテストと同様、全マスを黒で
        // 埋め1マスだけ空けた盤面を使う(白は合法手を持たない)。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.legal_moves(Side::White), 0);

        let limit = default_limit(4, 0);
        let evals = search_all_moves(&board, Side::White, &limit);

        assert!(evals.is_empty());
    }

    // ------------------------------------------------------------------
    // T051: ETC(Enhanced Transposition Cutoff)
    // ------------------------------------------------------------------

    /// 依存クレートを増やさないための、テスト専用の最小限xorshift64*実装
    /// (`engine/src/bin/eval_cli.rs`の同種の実装と同じ発想。この
    /// テストファイルからは`eval_cli`の非公開実装を再利用できないため、
    /// 同じアルゴリズムをここに複製している)。ランダムに手を進めた
    /// 多様な局面を、`seed`から再現可能に生成するためだけに使う
    /// (暗号論的な強度は不要)。
    struct EtcTestRng(u64);

    impl EtcTestRng {
        fn new(seed: u64) -> Self {
            // SplitMix64の既知の終段混合関数でシードを初期化することで、
            // 隣接する`seed`同士でも初期状態を十分に分散させる
            // (`eval_cli.rs::Rng::new`と同じ理由)。
            let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            EtcTestRng(z.max(1))
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x.wrapping_mul(2_685_821_657_736_338_717)
        }
    }

    /// 初期局面から`seed`に基づき再現可能にランダムな手を選びながら進め、
    /// 空きマス数が`target_empties`以下になるか終局したらその局面を返す。
    fn random_position(seed: u64, target_empties: u32) -> (Board, Side) {
        let mut rng = EtcTestRng::new(seed);
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

            let idx = (rng.next_u64() % moves.len() as u64) as usize;
            board = board.apply_move(side, moves[idx]);
            side = side.opposite();
        }
    }

    #[test]
    fn etc_enabled_and_disabled_produce_identical_search_results() {
        // T051(要件1、最重要): ETCは「置換表に既に確定している厳密な
        // 情報だけを使う安全な枝刈り」であり、正しく実装されていれば
        // 探索結果(最善手・評価値・到達深さ)を一切変えないはずである。
        // MPC(T048)と異なり、ここでの一致は「多少のズレは許容範囲」では
        // なく**完全一致が必須**(タスク仕様参照)。
        //
        // 初期局面 + 序盤・中盤・終盤寄りのランダム局面(複数seed)の
        // 組み合わせで、`search_with_eval_inner`をETC有効/無効の両方で
        // 実行し、返り値が全て一致することを確認する。あわせてノード数の
        // 合計を集計し、ETC有効時に(要件2どおり)削減されていることも
        // 確認する。
        let mut positions: Vec<(Board, Side)> = vec![(Board::initial(), Side::Black)];
        for seed in 0..6u64 {
            for target_empties in [32u32, 18] {
                positions.push(random_position(seed, target_empties));
            }
        }

        let mut mismatches: Vec<String> = Vec::new();
        let mut total_nodes_with_etc: u64 = 0;
        let mut total_nodes_without_etc: u64 = 0;
        let mut combos_checked = 0usize;

        for (i, (board, side)) in positions.iter().enumerate() {
            for max_depth in [3u8, 5] {
                let limit = default_limit(max_depth, 10);

                let mut tt_on = TranspositionTable::new(4);
                let result_on = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_on,
                    None,
                    true,
                    None,
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy::default(),
                    None,
                );

                let mut tt_off = TranspositionTable::new(4);
                let result_off = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_off,
                    None,
                    false,
                    None,
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy::default(),
                    None,
                );

                total_nodes_with_etc += result_on.nodes;
                total_nodes_without_etc += result_off.nodes;
                combos_checked += 1;

                if result_on.best_move != result_off.best_move
                    || result_on.score != result_off.score
                    || result_on.depth != result_off.depth
                {
                    mismatches.push(format!(
                        "position #{i} (empties={}) max_depth={max_depth}: \
                         etc-on=(best_move={:?}, score={}, depth={}) \
                         etc-off=(best_move={:?}, score={}, depth={})",
                        board.empty_count(),
                        result_on.best_move,
                        result_on.score,
                        result_on.depth,
                        result_off.best_move,
                        result_off.score,
                        result_off.depth,
                    ));
                }
            }
        }

        assert!(
            mismatches.is_empty(),
            "ETC changed search results for {} of {combos_checked} position/depth \
             combination(s), which means the ETC implementation has a correctness bug \
             (it must never change search results): {:#?}",
            mismatches.len(),
            mismatches
        );

        let reduction_pct = if total_nodes_without_etc > 0 {
            100.0 * (1.0 - total_nodes_with_etc as f64 / total_nodes_without_etc as f64)
        } else {
            0.0
        };
        println!(
            "T051 ETC node-count comparison across {combos_checked} position/depth \
             combinations: with_etc={total_nodes_with_etc} nodes, \
             without_etc={total_nodes_without_etc} nodes, reduction={reduction_pct:.2}%"
        );

        // T051(要件2): 正しく実装されていれば必ず何らかのノード数削減が
        // 見られるはず(MPCと違い「削減が実証できなければ既定オフ」という
        // 妥協ラインはない)。削減が見られない場合は実装を見直すこと。
        assert!(
            total_nodes_with_etc < total_nodes_without_etc,
            "ETC should reduce the total node count across these combinations \
             (with_etc={total_nodes_with_etc}, without_etc={total_nodes_without_etc}); \
             if it does not, the ETC implementation likely never actually triggers a cutoff"
        );
    }

    #[test]
    #[ignore = "T051: heavier node-count comparison at deeper search depths than the fast \
                default test above (etc_enabled_and_disabled_produce_identical_search_results). \
                Only a handful of positions but depth up to 9, which takes noticeably longer in \
                a debug build; kept out of the default `cargo test` run for the same reason the \
                FFO 'heavy' tests are ignored by default (see ffo_bench.rs). Run explicitly with \
                `cargo test -p engine --lib search::tests::etc_node_reduction_at_deeper_depths \
                --release -- --ignored --nocapture` to get a more representative node-count \
                reduction percentage for the work log."]
    fn etc_node_reduction_at_deeper_depths() {
        // T051(要件2): デフォルトの高速テストは`cargo test`が毎回妥当な時間で
        // 終わるよう浅め・少なめの局面/深さに絞っているため、より現実的な
        // (実際の対局で使われる程度の)深さでの削減率を別途計測する。
        let mut positions: Vec<(Board, Side)> = vec![(Board::initial(), Side::Black)];
        for seed in 0..4u64 {
            for target_empties in [40u32, 26] {
                positions.push(random_position(seed, target_empties));
            }
        }

        let mut mismatches: Vec<String> = Vec::new();
        let mut total_nodes_with_etc: u64 = 0;
        let mut total_nodes_without_etc: u64 = 0;
        let mut combos_checked = 0usize;

        for (i, (board, side)) in positions.iter().enumerate() {
            for max_depth in [8u8, 9] {
                let limit = default_limit(max_depth, 10);

                let mut tt_on = TranspositionTable::new(16);
                let result_on = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_on,
                    None,
                    true,
                    None,
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy::default(),
                    None,
                );

                let mut tt_off = TranspositionTable::new(16);
                let result_off = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_off,
                    None,
                    false,
                    None,
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy::default(),
                    None,
                );

                total_nodes_with_etc += result_on.nodes;
                total_nodes_without_etc += result_off.nodes;
                combos_checked += 1;

                if result_on.best_move != result_off.best_move
                    || result_on.score != result_off.score
                    || result_on.depth != result_off.depth
                {
                    mismatches.push(format!(
                        "position #{i} (empties={}) max_depth={max_depth}: \
                         etc-on=(best_move={:?}, score={}, depth={}) \
                         etc-off=(best_move={:?}, score={}, depth={})",
                        board.empty_count(),
                        result_on.best_move,
                        result_on.score,
                        result_on.depth,
                        result_off.best_move,
                        result_off.score,
                        result_off.depth,
                    ));
                }
            }
        }

        assert!(
            mismatches.is_empty(),
            "ETC changed search results for {} of {combos_checked} position/depth \
             combination(s) at deeper depths: {:#?}",
            mismatches.len(),
            mismatches
        );

        let reduction_pct = if total_nodes_without_etc > 0 {
            100.0 * (1.0 - total_nodes_with_etc as f64 / total_nodes_without_etc as f64)
        } else {
            0.0
        };
        println!(
            "T051 ETC node-count comparison (deeper depths) across {combos_checked} \
             position/depth combinations: with_etc={total_nodes_with_etc} nodes, \
             without_etc={total_nodes_without_etc} nodes, reduction={reduction_pct:.2}%"
        );

        assert!(
            total_nodes_with_etc < total_nodes_without_etc,
            "ETC should reduce the total node count at deeper depths too \
             (with_etc={total_nodes_with_etc}, without_etc={total_nodes_without_etc})"
        );
    }

    // ------------------------------------------------------------------
    // T089a: history heuristic + aspiration window
    // ------------------------------------------------------------------

    #[test]
    fn aspiration_and_history_enabled_matches_full_window_disabled() {
        // T089aの絶対条件(最重要、一致テストを実装より先に書く): history
        // heuristic + aspiration windowを有効にしても、最終的なbest_move/
        // scoreはfull window(両機能無効)探索と完全一致しなければならない
        // (要件8)。同一の`max_nodes`(この深さ・局面群では予算に達しない
        // 十分大きな値)を両方に与え、`enable_heuristics`だけを切り替えて
        // 比較する(`search_with_eval_inner`のドキュメント参照)。
        //
        // `exact_from_empties: 0`に固定し、中盤NegaScout自体の一致だけを
        // 検証する。木内部exact試行はhistoryによるムーブオーダリングの
        // 変化で試行対象の子・完走可否そのものが変わりうる
        // (`leaf_exact_quota_abort_continues_midgame_iteration_without_
        // tt_domain_leak`の作業ログ参照)ため、それ自体はT089aの絶対条件
        // (=同一limit設定でのaspiration+history有効/無効の一致)の対象外
        // であり、ここでは意図的に混ぜない。
        let mut positions: Vec<(Board, Side)> = vec![(Board::initial(), Side::Black)];
        for seed in 0..10u64 {
            for target_empties in [44u32, 36, 28, 20] {
                positions.push(random_position(seed, target_empties));
            }
        }
        assert!(
            positions.len() >= 40,
            "T089a requires at least 40 positions in this consistency corpus, got {}",
            positions.len()
        );

        // この深さ・局面群では絶対に到達しない(=budget打ち切りが比較を
        // 汚さない)十分大きな値。
        let generous_max_nodes = 5_000_000u64;

        let mut mismatches: Vec<String> = Vec::new();
        let mut total_nodes_on: u64 = 0;
        let mut total_nodes_off: u64 = 0;
        let mut combos_checked = 0usize;
        let mut total_fail_low = 0u32;
        let mut total_fail_high = 0u32;

        for (i, (board, side)) in positions.iter().enumerate() {
            for max_depth in [4u8, 6] {
                let limit = default_limit(max_depth, 0);

                let mut tt_on = TranspositionTable::new(4);
                let result_on = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_on,
                    None,
                    true,
                    Some(generous_max_nodes),
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy {
                        enable_history: true,
                        enable_aspiration: true,
                        enable_mpc: false,
                    },
                    None,
                );

                let mut tt_off = TranspositionTable::new(4);
                let result_off = search_with_eval_inner(
                    board,
                    *side,
                    &limit,
                    &mut tt_off,
                    None,
                    true,
                    Some(generous_max_nodes),
                    EXACT_QUOTA_PERCENT,
                    SearchPolicy::default(),
                    None,
                );

                assert!(
                    !result_on.node_limit_hit && !result_off.node_limit_hit,
                    "position #{i} max_depth={max_depth}: node budget was hit, which would \
                     confound the comparison (increase generous_max_nodes)"
                );

                total_nodes_on += result_on.nodes;
                total_nodes_off += result_off.nodes;
                total_fail_low += result_on.aspiration_fail_low;
                total_fail_high += result_on.aspiration_fail_high;
                combos_checked += 1;

                // scoreとdepthは無条件で完全一致が必須(要件8そのもの)。
                if result_on.score != result_off.score || result_on.depth != result_off.depth {
                    mismatches.push(format!(
                        "position #{i} (empties={}) max_depth={max_depth}: score/depth differ \
                         (heuristics-on=(best_move={:?}, score={}, depth={}) \
                         heuristics-off=(best_move={:?}, score={}, depth={}))",
                        board.empty_count(),
                        result_on.best_move,
                        result_on.score,
                        result_on.depth,
                        result_off.best_move,
                        result_off.score,
                        result_off.depth,
                    ));
                } else if result_on.best_move != result_off.best_move {
                    // best_moveだけが異なる場合、ムーブオーダリング(TT手
                    // 優先度・historyタイブレーク)が変わったことで「真に
                    // 同点(同じ深さで全く同じ最善スコアを達成する複数の
                    // 合法手が存在する)」局面のタイブレーク先が変わった
                    // 可能性がある。これは探索アルゴリズムのバグではなく、
                    // ムーブオーダリングを変える技法(history heuristic)に
                    // 一般的に伴う既知の性質であり、両方の手が同じ深さで
                    // 独立に評価しても本当に同じスコアになることを
                    // `search_all_moves`(historyもaspirationも使わない
                    // 経路)で直接検証できれば「探索結果が変わった」とは
                    // 見なさない。検証できなければ本物の不一致として扱う。
                    match (result_on.best_move, result_off.best_move) {
                        (Some(mv_on), Some(mv_off)) => {
                            let evals = search_all_moves(board, *side, &limit);
                            let score_of =
                                |mv: u8| evals.iter().find(|e| e.mv == mv).map(|e| e.score);
                            let (score_on, score_off) = (score_of(mv_on), score_of(mv_off));
                            let genuine_tie = score_on == Some(result_on.score)
                                && score_off == Some(result_on.score);
                            if !genuine_tie {
                                mismatches.push(format!(
                                    "position #{i} (empties={}) max_depth={max_depth}: \
                                     best_move differs and is NOT a verified tie \
                                     (heuristics-on move={mv_on} ground-truth score={score_on:?}, \
                                     heuristics-off move={mv_off} ground-truth score={score_off:?}, \
                                     reported search score={})",
                                    board.empty_count(),
                                    result_on.score,
                                ));
                            }
                        }
                        _ => {
                            mismatches.push(format!(
                                "position #{i} (empties={}) max_depth={max_depth}: one side \
                                 returned no move (heuristics-on={:?}, heuristics-off={:?})",
                                board.empty_count(),
                                result_on.best_move,
                                result_off.best_move,
                            ));
                        }
                    }
                }
            }
        }

        assert!(
            mismatches.is_empty(),
            "T089a: history heuristic + aspiration window changed search results for {} of \
             {combos_checked} position/depth combination(s), which means the implementation \
             has a correctness bug (it must never change search results): {:#?}",
            mismatches.len(),
            mismatches
        );

        println!(
            "T089a aspiration+history consistency check across {combos_checked} \
             position/depth combinations ({} positions): heuristics_on={total_nodes_on} nodes, \
             heuristics_off={total_nodes_off} nodes, aspiration_fail_low={total_fail_low}, \
             aspiration_fail_high={total_fail_high}",
            positions.len()
        );
    }

    // --- T059: static_eval のクランプ回帰テスト ---
    // (ユーザー報告: 棋譜解析で評価値が石差の理論上限±64を大きく超える異常値
    // (例: 105)になる不具合。根本原因はPatternWeights::scoreの出力に上限が
    // 無かったこと。static_evalの唯一の出口でクランプすることで、中盤探索の
    // 葉評価・終盤タイムアウト時フォールバックの両方に自動的に適用される。)

    /// 全状態の重みを異常に大きい値に設定した`PatternWeights`を作る
    /// (学習データが薄い局面で線形和が発散するケースを模擬する)。
    fn make_pattern_weights_with_extreme_values(value: f32) -> PatternWeights {
        let patterns = crate::patterns::generate_patterns();
        let mut weights = PatternWeights::zeroed(patterns);
        for class_table in &mut weights.class_tables {
            for stage_table in &mut class_table.stage_tables {
                for w in stage_table.iter_mut() {
                    *w = value;
                }
            }
        }
        weights
    }

    #[test]
    fn static_eval_clamps_pattern_weight_output_to_the_theoretical_disc_diff_bound() {
        // 各パターンインスタンスが+1000.0(石差換算で桁違いに大きい)を返すよう
        // 重みを設定すると、クランプが無ければ合計(22インスタンス分)が
        // 22000相当のcenti-discになり、理論上限(±6400)を大きく超える。
        let weights = make_pattern_weights_with_extreme_values(1000.0);
        let board = Board::initial();

        let score = static_eval(&board, Side::Black, Some(&weights));

        assert!(
            score <= DISC_DIFF_BOUND_CENTIDISC && score >= -DISC_DIFF_BOUND_CENTIDISC,
            "static_eval should clamp to the theoretical disc-diff bound \
             [-{DISC_DIFF_BOUND_CENTIDISC}, {DISC_DIFF_BOUND_CENTIDISC}], got {score}"
        );
        assert_eq!(
            score, DISC_DIFF_BOUND_CENTIDISC,
            "with all-positive extreme weights the clamped score should hit the upper bound exactly"
        );
    }

    #[test]
    fn static_eval_clamps_extreme_negative_pattern_weight_output_too() {
        let weights = make_pattern_weights_with_extreme_values(-1000.0);
        let board = Board::initial();

        let score = static_eval(&board, Side::Black, Some(&weights));

        assert_eq!(
            score, -DISC_DIFF_BOUND_CENTIDISC,
            "with all-negative extreme weights the clamped score should hit the lower bound exactly"
        );
    }

    #[test]
    fn static_eval_does_not_alter_normal_range_scores() {
        // クランプが通常範囲の値(理論上限を超えない値)に影響を与えないことを
        // 確認する回帰テスト。ゼロ重みモデルは常に0を返すはず。
        let patterns = crate::patterns::generate_patterns();
        let weights = PatternWeights::zeroed(patterns);
        let board = Board::initial();

        assert_eq!(static_eval(&board, Side::Black, Some(&weights)), 0);
    }

    #[test]
    fn search_all_moves_with_eval_move_scores_stay_within_the_theoretical_disc_diff_bound() {
        // 統合的な回帰テスト: 異常な重みを持つモデルで
        // `search_all_moves_with_eval`(棋譜解析が使う経路)を呼んでも、
        // 返る各手の評価値(centi-disc)が理論上限を超えないことを確認する。
        let weights = make_pattern_weights_with_extreme_values(1000.0);
        let board = Board::initial();
        let limit = default_limit(2, 24);

        let evals = search_all_moves_with_eval(&board, Side::Black, &limit, Some(&weights));

        assert!(!evals.is_empty());
        for eval in &evals {
            assert!(
                eval.score.abs() <= DISC_DIFF_BOUND_CENTIDISC,
                "move {} score {} exceeds the theoretical disc-diff bound of {DISC_DIFF_BOUND_CENTIDISC}",
                eval.mv,
                eval.score
            );
        }
    }

    // ------------------------------------------------------------------
    // T084: テレメトリ追加(elapsed_ms/timed_out フィールドの追加、
    // 完全読みショートカットのノード数を`1`固定から実カウントへ変更)が
    // 探索アルゴリズム自体の挙動(最善手・評価値・到達深さ)を
    // 一切変えていないことのロック用回帰テスト。
    //
    // 期待値はT084着手前(このタスクでコードを変更する前)のビルドで
    // `search()`を直接呼んで採取した実測値(作業ログ参照。
    // `cargo test -p engine --lib --release -- --ignored --nocapture` で
    // 一時テストを実行して採取した)。
    // ------------------------------------------------------------------

    #[test]
    fn fixed_depth_midgame_search_result_is_unchanged_from_the_pre_t084_baseline() {
        // 初期局面からdepth=8・exact_from_empties=0(常にNegaScout経由、
        // 完全読みには入らない)で探索した場合の結果は、T084着手前と
        // ビット単位で一致するはず(ノード数はNegaScout側の集計であり、
        // T084では一切変更していないため、この経路ではnodesも含めて完全一致
        // することを確認する)。
        let board = Board::initial();
        let limit = default_limit(8, 0);
        let mut tt = TranspositionTable::new(16);
        let result = search(&board, Side::Black, &limit, &mut tt);

        assert_eq!(
            result.best_move,
            Some(19),
            "best_move regressed from the pre-T084 baseline"
        );
        assert_eq!(
            result.score, 0,
            "score regressed from the pre-T084 baseline"
        );
        assert_eq!(
            result.depth, 8,
            "depth regressed from the pre-T084 baseline"
        );
        assert_eq!(
            result.nodes, 3493,
            "nodes regressed from the pre-T084 baseline (NegaScout path is untouched by T084)"
        );
        assert!(!result.is_exact);
        assert!(
            !result.timed_out,
            "time_ms was not set, so timed_out must always be false"
        );
    }

    #[test]
    fn fixed_depth_exact_search_result_is_unchanged_from_the_pre_t084_baseline() {
        // 空きマス10の局面(必ず完全読みショートカットに入る)で探索した
        // 場合、best_move/score/depth/is_exactはT084着手前と完全に一致する
        // はず。nodesだけは意図的な改善対象(以前は`1`固定のプレースホルダー
        // だった。詳しくは`SearchResult::nodes`のドキュメントとT084の
        // 作業ログを参照)なので、ここでは「1より大きい実カウントになった」
        // ことだけを確認し、厳密な値は別テストで検証する。
        let (board, side) = play_until_empties(10, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;
        let limit = default_limit(20, exact_threshold);
        let mut tt = TranspositionTable::new(16);
        let result = search(&board, side, &limit, &mut tt);

        assert_eq!(
            result.best_move,
            Some(52),
            "best_move regressed from the pre-T084 baseline"
        );
        assert_eq!(
            result.score, -2200,
            "score regressed from the pre-T084 baseline"
        );
        assert_eq!(
            result.depth, 10,
            "depth regressed from the pre-T084 baseline"
        );
        assert!(result.is_exact);
        assert!(
            !result.timed_out,
            "time_ms was not set, so timed_out must always be false"
        );
        assert!(
            result.nodes > 1,
            "T084: the exact-shortcut path should now report the real node count from \
             solve_exact_with_nodes instead of the old hardcoded placeholder of 1, got {}",
            result.nodes
        );
    }

    #[test]
    fn fixed_depth_exact_search_nodes_match_solve_exact_with_nodes_directly() {
        // T084要件1: `search()`が完全読みショートカットで報告するノード数が、
        // 同じ局面を直接`solve_exact_with_nodes`で解いた場合のノード数と
        // 完全に一致することを確認する(テレメトリが実際の探索を正しく
        // 反映していることの直接的な検証)。
        let (board, side) = play_until_empties(10, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;
        let limit = default_limit(20, exact_threshold);

        let mut tt = TranspositionTable::new(16);
        let result = search(&board, side, &limit, &mut tt);

        let mut tt_direct = TranspositionTable::new(16);
        let (direct_score, direct_nodes) = solve_exact_with_nodes(&board, side, &mut tt_direct);

        assert_eq!(result.score, direct_score * 100);
        assert_eq!(result.nodes, direct_nodes);
    }

    #[test]
    fn fixed_depth_search_is_deterministic_across_repeated_calls() {
        // T084要件2(決定性モード): `--depth N`のみ(時間予算なし)で
        // 実行した場合、同一局面・同一重みなら着手・スコア・到達深さ・
        // ノード数が完全に再現されることを確認する(壁時計を一切参照しない
        // ため、実行タイミングに左右されないはず)。
        let board = Board::initial();
        let limit = default_limit(7, 12);

        let mut tt_a = TranspositionTable::new(16);
        let result_a = search(&board, Side::Black, &limit, &mut tt_a);

        let mut tt_b = TranspositionTable::new(16);
        let result_b = search(&board, Side::Black, &limit, &mut tt_b);

        assert_eq!(result_a.best_move, result_b.best_move);
        assert_eq!(result_a.score, result_b.score);
        assert_eq!(result_a.depth, result_b.depth);
        assert_eq!(result_a.nodes, result_b.nodes);
        assert_eq!(result_a.is_exact, result_b.is_exact);
        assert!(!result_a.timed_out && !result_b.timed_out);
    }

    #[test]
    fn fixed_depth_exact_shortcut_search_is_deterministic_across_repeated_calls() {
        // 上と同じ決定性の確認を、完全読みショートカット経路(exact-from-empties
        // が根から直ちに適用される局面)でも行う。
        let (board, side) = play_until_empties(9, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;
        let limit = default_limit(20, exact_threshold);

        let mut tt_a = TranspositionTable::new(16);
        let result_a = search(&board, side, &limit, &mut tt_a);

        let mut tt_b = TranspositionTable::new(16);
        let result_b = search(&board, side, &limit, &mut tt_b);

        assert_eq!(result_a.best_move, result_b.best_move);
        assert_eq!(result_a.score, result_b.score);
        assert_eq!(result_a.nodes, result_b.nodes);
        assert!(result_a.is_exact && result_b.is_exact);
        assert!(!result_a.timed_out && !result_b.timed_out);
    }

    #[test]
    fn node_budget_fallback_always_returns_a_legal_move() {
        let (board, side) = play_until_empties(18, first_move_strategy);
        let legal = board.legal_moves(side);
        assert_ne!(legal, 0, "test position must have a legal move");
        let limit = SearchLimit {
            max_depth: 10,
            time_ms: None,
            exact_from_empties: 18,
        };
        let mut tt = TranspositionTable::new(16);
        let result = search_with_eval_with_node_limit(&board, side, &limit, &mut tt, None, 1);

        let mv = result
            .best_move
            .expect("a legal position must never return move=None");
        assert_ne!(legal & (1u64 << mv), 0, "fallback move must be legal");
        assert_eq!(result.nodes, 1);
        assert!(result.node_limit_hit);
        assert!(!result.timed_out);
    }

    #[test]
    fn node_budget_search_is_deterministic() {
        let board = Board::initial();
        let limit = SearchLimit {
            max_depth: 20,
            time_ms: None,
            exact_from_empties: 10,
        };
        let mut tt_a = TranspositionTable::new(16);
        let a =
            search_with_eval_with_node_limit(&board, Side::Black, &limit, &mut tt_a, None, 2048);
        let mut tt_b = TranspositionTable::new(16);
        let b =
            search_with_eval_with_node_limit(&board, Side::Black, &limit, &mut tt_b, None, 2048);

        assert_eq!(a.best_move, b.best_move);
        assert_eq!(a.score, b.score);
        assert_eq!(a.depth, b.depth);
        assert_eq!(a.nodes, b.nodes);
        assert!(a.node_limit_hit && b.node_limit_hit);
    }

    #[test]
    fn centidisc_windows_round_outward_for_negative_values() {
        assert_eq!(floor_div_100(-101), -2);
        assert_eq!(floor_div_100(-100), -1);
        assert_eq!(floor_div_100(-1), -1);
        assert_eq!(ceil_div_100(-101), -1);
        assert_eq!(ceil_div_100(-100), -1);
        assert_eq!(ceil_div_100(-1), 0);
        assert_eq!(floor_div_100(101), 1);
        assert_eq!(ceil_div_100(101), 2);
    }

    #[test]
    fn wall_clock_exact_timeout_still_returns_a_legal_move() {
        // T084レビュー申し送り: ルートexactと続くdepth 1が壁時計で
        // 打ち切られても、合法手ありの局面でNoneを返してはならない。
        let (board, side) = play_until_empties(18, first_move_strategy);
        let legal = board.legal_moves(side);
        assert_ne!(legal, 0);
        let limit = SearchLimit {
            max_depth: 10,
            time_ms: Some(0),
            exact_from_empties: 18,
        };
        let mut tt = TranspositionTable::new(16);
        let result = search(&board, side, &limit, &mut tt);
        let mv = result
            .best_move
            .expect("wall-clock fallback must return a move");
        assert_ne!(legal & (1u64 << mv), 0);
        assert!(result.timed_out);
        assert!(!result.is_exact);
    }

    #[test]
    fn normal_node_budget_completes_baseline_before_deeper_work() {
        let board = Board::initial();
        let limit = SearchLimit {
            max_depth: 10,
            time_ms: None,
            exact_from_empties: 18,
        };
        let mut tt = TranspositionTable::new(16);
        let result =
            search_with_eval_with_node_limit(&board, Side::Black, &limit, &mut tt, None, 20_000);
        assert_eq!(result.baseline_depth, 1);
        assert!(result.baseline_nodes > 0);
        assert!(result.last_completed_depth >= 1);
        assert!(!result.static_only);
        assert!(result.best_move.is_some());
    }

    #[test]
    fn leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak() {
        // 固定コーパス exact-15-2。depth=2では各ルート子が空き14となり、
        // 複数の子で木内部exactを開始する。
        //
        // T089a注記(このテストの前提が変わった経緯): T089a着手前は、この
        // 局面のdepth=2は常に「1子だけexact試行してquota切れで中断し、
        // 残り全ての子は中断せず中盤探索のまま完走する」という単一の
        // full-window探索だった(`exact_leaf_attempts==1`,
        // `exact_completed==false`, best_move/scoreとも
        // `exact_from_empties: 0`の純中盤探索と完全一致)。
        //
        // T089aのhistory heuristicによるムーブオーダリングの変化(root
        // イテレーションを跨いで蓄積・半減するhistory表がタイブレークに
        // 加わる)と、depth>=2で有効になるaspiration window(この局面では
        // 初期窓±200が1回fail-highし、±400へ広げて再探索している。
        // `result.aspiration_fail_high == 1`)により、木内部exactを試みる
        // 子の訪問順とその時点の残quotaが変わった。その結果、
        // `exact_quota_remaining`(探索呼び出し全体で共有される既存の
        // 設計、T085a)が以前より多く残った状態で後続の子のexact試行に
        // 入れるようになり、そのうち1子は実際に完全読みが**完走**する
        // ようになった。さらにT100の終盤排序変更後は同じ1子の完走と1子の
        // quota-abortを2回の試行で再現していた(`exact_leaf_attempts==2`,
        // `exact_leaf_completed==1`, `exact_aborted_by_quota==1`)。
        // T103(NWS中心のPVS構造への移行)で終盤ソルバー1回あたりの
        // ノード消費がさらに減った結果、同じ共有quotaの中でより多くの子が
        // exactを試みられるようになり、4回の試行のうち3子が完走・1子が
        // quota-abortしていた(`exact_leaf_attempts==4`,
        // `exact_leaf_completed==3`, `exact_aborted_by_quota==1`)。
        //
        // T104(空き1〜4専用ソルバー+shallow層の導入)で、この専用層は
        // TT probe/store・Zobrist hash更新・一般用途のムーブオーダリングを
        // 行わない(要件どおり)ため、空き1〜4での実際の探索木の形
        // (pruningの効き方)が変わり、同じ局面のexact試行が消費する
        // ノード総量も変わりうる(ノード計上の「呼び出しごとに+1」という
        // *定義*自体はnegamaxと同一に保っており、過少計上はしていない。
        // 定義が同じでも、専用層は排序が異なるため訪問するノード集合自体が
        // 変わる)。その結果、この局面では共有quotaの消費ペースが変わり、
        // 試行回数が4→2(完走1・quota-abort1)に変化した
        // (`SHALLOW_MAX_EMPTIES=4`+`CornerThenParity`静的順序付け採用時の
        // 実測。redo#1で静的順序付けなしの初回実装と全く同じ値になった
        // ことも確認済み)。この途中、redo#2でFFO/C2の副次ゲート回収を
        // 狙って`SHALLOW_MAX_EMPTIES`を一時的に2へ下げた際は
        // `exact_leaf_attempts==3`(完走2)相当になったが、2026-07-16の
        // ユーザー裁定で「C2 512k完走数非減・FFOノード+10%以内はwaive、
        // 主判定はNPS 1.3倍以上のみ」となり`4`へ戻したため、本テストの
        // 期待値も4相当(2・1・1)に戻している(詳細な経緯は
        // `engine/src/endgame.rs`の`SHALLOW_MAX_EMPTIES`定数ドキュメントと
        // `tasks/T104-endgame-shallow-solver.md`の作業ログを参照)。
        // ノード数・NPS・正しさの主判定はT104のFFOベンチ比較(タスクの
        // 受け入れ基準)で別途検証しており、本テストはTTドメイン分離という
        // 元々の目的に沿って実測値へ期待値を更新する。
        //
        // T107(exactポリシー再校正)注記: `EXACT_QUOTA_PERCENT`を40%から
        // 60%へ、`estimated_min_exact_nodes`の空き15以上のP75推定値を新
        // ソルバー実測へ更新した(空き0〜14は元の設計どおり「原則試行」を
        // 維持、変更していない)。共有quotaの絶対量が増えたことで、この
        // 局面(空き14の子)では4回の試行のうち3子が完走・1子がquota-abort
        // する状態に変化した(`exact_leaf_attempts==4`,
        // `exact_leaf_completed==3`, `exact_aborted_by_quota==1`)。
        // 試行回数・完走数自体はT103時点の値(4・3・1)と偶然一致しているが、
        // 実際に消費されるノード配分・完走する子の集合はP75テーブル更新の
        // 影響で異なりうる(このテストが検証するのはTTドメイン分離の安全性
        // であり、具体的な子の集合の一致ではない)。
        // これも探索が改善した結果であり
        // (完走した子については、静的評価による近似ではなく証明済みの
        // 石差を得ている)、T089aの絶対条件である「探索結果(best move/
        // score)を変えないこと」は、あくまで**同一の`SearchLimit`/
        // `max_nodes`設定に対してaspiration+historyを有効/無効で切り替え
        // たときの一致」を指す(新テスト
        // `aspiration_and_history_enabled_matches_full_window_disabled`
        // 参照)。このテスト自体は`exact_from_empties: 18`固定であり、
        // `exact_from_empties: 0`(exactを一切使わない別設定)との比較は
        // そもそもT089aが保証すべき不変条件ではなかった
        // (このテストは元々T085aのTTドメイン分離・quota-abort継続の
        // 安全性を検証する目的で作られたものであり、その検証手段として
        // 「(この局面ではたまたま)常に中断していたので純中盤探索と一致する
        // はず」という副次的な性質を借用していただけだった)。
        //
        // そのため、本テストの目的(quota-abort/完走のいずれでもTT
        // ドメインが正しく分離され、探索が正常に完走すること)を保ったまま、
        // 以下のように検証内容を更新する。
        let board =
            board_from_obf("-XXXXO--XOOOO---XOOO-XO-XOOOOOX-XOOXXXXXOX-XOOXXOOXXX-X--O-X-OXO");
        let side = Side::White;
        let limit = SearchLimit {
            max_depth: 2,
            time_ms: None,
            exact_from_empties: 18,
        };
        let mut tt = TranspositionTable::new(16);
        let result = search_with_eval_with_node_limit(&board, side, &limit, &mut tt, None, 240_000);

        assert_eq!(result.exact_leaf_attempts, 4);
        assert_eq!(result.exact_aborted_by_quota, 1);
        assert_eq!(result.exact_leaf_completed, 3);
        assert!(
            result.exact_completed,
            "at least one of the four leaf-exact attempts should complete"
        );
        assert_eq!(result.last_completed_depth, 2);
        assert_eq!(result.fallback_reason, Some(AbortReason::ExactQuota));
        assert!(!result.node_limit_hit);
        assert!(!result.static_only);
        assert!(result.best_move.is_some());

        // 決定性(要件11): 同じ入力(局面・limit・max_nodes)、フレッシュな
        // TTなら、quota-abort/完走が入り混じった複雑な経路でも常に同じ
        // best_move/score/nodesに再現される。
        let mut tt_repeat = TranspositionTable::new(16);
        let repeat =
            search_with_eval_with_node_limit(&board, side, &limit, &mut tt_repeat, None, 240_000);
        assert_eq!(result.best_move, repeat.best_move);
        assert_eq!(result.score, repeat.score);
        assert_eq!(result.nodes, repeat.nodes);
        assert_eq!(result.exact_leaf_attempts, repeat.exact_leaf_attempts);
        assert_eq!(result.exact_aborted_by_quota, repeat.exact_aborted_by_quota);
        assert_eq!(result.exact_leaf_completed, repeat.exact_leaf_completed);

        let root_hash = zobrist_hash(&board, side);
        let midgame = tt
            .probe(root_hash, TTDomain::Midgame)
            .expect("completed depth=2 result must be stored as Midgame");
        assert!(midgame.depth >= 2);
        assert!(tt.probe(root_hash, TTDomain::Exact).is_none());

        // TTドメイン分離(T085a)の安全性: quota-abortした/そもそも
        // exactを試みなかった局面はExactドメインへ格納されず(中断した
        // 不完全な結果でExactを汚染しない)。T104(`SHALLOW_MAX_EMPTIES=4`)
        // 時点の`exact_leaf_attempts=2`(完走1・quota-abort1)のうち、
        // root直下の子のTT(depth=2固定探索の子=ply1)に実測でExactドメイン
        // として格納されているのは1つ(`exact_leaf_completed`の総数と1対1に
        // 対応するとは限らない点は変わらない)。いずれにせよ
        // aborted/unattemptedな局面がExactドメインへ漏れていないことが
        // 本アサーションの主眼。
        let mut legal = board.legal_moves(side);
        let mut midgame_children = 0;
        let mut exact_children = 0;
        while legal != 0 {
            let bit = legal & legal.wrapping_neg();
            legal &= legal - 1;
            let child = board.apply_move(side, bit);
            let child_hash = zobrist_hash(&child, side.opposite());
            if tt.probe(child_hash, TTDomain::Exact).is_some() {
                exact_children += 1;
            }
            if tt.probe(child_hash, TTDomain::Midgame).is_some() {
                midgame_children += 1;
            }
        }
        assert!(midgame_children > 0);
        // T107: quota引き上げ後は`exact_leaf_completed==3`だが、そのうち
        // ルート直下の子(ply1、このループが数える範囲)としてExactドメインに
        // 格納されているのは実測で2つ(残り1つはより深いply、あるいは
        // ルート直下の子として再訪されずTTに残らなかった)。
        // `exact_leaf_completed`の総数と1対1に対応するとは限らない点は
        // 元のコメントどおり変わっていない。本アサーションの主眼は
        // 「aborted/unattemptedな局面がExactドメインへ漏れていないこと」
        // であり、これは`exact_children < exact_leaf_completed`かつ
        // `exact_children`が0でないことで確認できる。
        assert_eq!(
            exact_children, 2,
            "only children with a genuinely completed leaf-exact solve should be stored under \
             TTDomain::Exact; aborted/unattempted children must not leak into the Exact domain"
        );
    }

    // ------------------------------------------------------------------
    // T104 redo#2: レビュー指摘B1の回帰テスト。
    // ------------------------------------------------------------------
    //
    // T104(空き1〜4専用ソルバー+shallow層)は、shallow層がTT probe/store
    // を一切行わない設計のため、**ルート局面自体**の空きマス数が
    // `SHALLOW_MAX_EMPTIES`(=4)以下だと、そのルート局面のTTエントリ
    // (best_move込み)が一切格納されなくなり、以下の2箇所のルートexact
    // パスが`best_move: None`・`pv: []`を返してしまっていた
    // (baseline`bdb4389`は正しく手を返していた。実対局では
    // `app/src/game/gameLoop.ts`がpv[0]をundefinedとして着手せずCPUが
    // 終盤で手を返せなくなる、T084同種のブロッカーだった):
    //
    // - `max_nodes`なし経路(`search_with_eval_inner`のルート直接exact、
    //   `max_nodes.is_none() && empties <= exact_from_empties`分岐)
    // - `max_nodes`あり経路(depth=1完了後のin-tree root exact、
    //   `max_nodes.is_some() && depth == 1`分岐)
    //
    // 修正(`endgame::negamax`に`is_root`引数を追加し、`solve_exact`系
    // 公開関数の最外周呼び出しのみ`is_root: true`でshallow委譲を抑止)後、
    // 両経路とも空き1〜4のルートで`best_move`がSome・合法手・`pv`が非空で
    // あり、スコアが独立な`endgame::solve_exact`と一致することを確認する。
    #[test]
    fn root_exact_at_shallow_empties_returns_a_legal_best_move_via_both_entry_points() {
        for target_empties in [1u32, 2, 3, 4] {
            let (board, side) = play_until_empties(target_empties, first_move_strategy);
            assert_eq!(
                board.empty_count(),
                target_empties,
                "test setup should reach exactly {target_empties} empties"
            );
            assert!(
                board.legal_moves(side) != 0,
                "test setup should reach a position where the side to move has a legal move \
                 (empties={target_empties})"
            );

            let mut tt_direct = TranspositionTable::new(1);
            let expected_score = solve_exact(&board, side, &mut tt_direct) * 100;

            // exact_from_emptiesを十分大きく(24)取り、空き1〜4のいずれでも
            // 「ルート自体を即exact解決してよい」条件を満たすようにする。
            let limit = default_limit(4, 24);

            // (a) max_nodesなし経路(`search_with_eval`、B1のうち1つ目の
            // ルートexactパス)。
            let mut tt_no_limit = TranspositionTable::new(1);
            let result_no_limit = search_with_eval(&board, side, &limit, &mut tt_no_limit, None);
            assert_eq!(
                result_no_limit.score, expected_score,
                "empties={target_empties}: no-max-nodes root exact path score mismatch"
            );
            let best_move_a = result_no_limit.best_move.unwrap_or_else(|| {
                panic!(
                    "empties={target_empties}: best_move should be Some via the no-max-nodes \
                     root exact path (B1 regression: shallow layer must not swallow the root's \
                     own TT entry)"
                )
            });
            assert!(
                board.legal_moves(side) & (1u64 << best_move_a) != 0,
                "empties={target_empties}: best_move {best_move_a} (no-max-nodes path) should \
                 be a legal move"
            );
            assert!(
                !result_no_limit.pv.is_empty(),
                "empties={target_empties}: pv should be non-empty (no-max-nodes path)"
            );
            assert_eq!(result_no_limit.pv[0], best_move_a);

            // (b) max_nodesあり経路(`search_with_eval_with_node_limit`、
            // depth=1完了後のin-tree root exact、B1のうち2つ目のパス)。
            let mut tt_with_limit = TranspositionTable::new(1);
            let result_with_limit = search_with_eval_with_node_limit(
                &board,
                side,
                &limit,
                &mut tt_with_limit,
                None,
                200_000,
            );
            assert_eq!(
                result_with_limit.score, expected_score,
                "empties={target_empties}: max-nodes root exact path score mismatch"
            );
            let best_move_b = result_with_limit.best_move.unwrap_or_else(|| {
                panic!(
                    "empties={target_empties}: best_move should be Some via the max-nodes root \
                     exact path (B1 regression)"
                )
            });
            assert!(
                board.legal_moves(side) & (1u64 << best_move_b) != 0,
                "empties={target_empties}: best_move {best_move_b} (max-nodes path) should be a \
                 legal move"
            );
            assert!(
                !result_with_limit.pv.is_empty(),
                "empties={target_empties}: pv should be non-empty (max-nodes path)"
            );
            assert_eq!(result_with_limit.pv[0], best_move_b);
        }
    }

    #[test]
    fn mpc_pv_and_exact_boundary_guards_are_telemetried() {
        let (board, side) = play_until_empties(28, first_move_strategy);
        let limit = default_limit(6, 22);
        let mut tt = TranspositionTable::new(1);
        let mut nodes = 0;
        let mut timed_out = false;
        let mut quota = 1234;
        let mut exact_stats = ExactStats::default();
        let mut mpc_stats = MpcStats::default();
        let mut ctx = SearchCtx {
            limit: &limit,
            tt: &mut tt,
            nodes: &mut nodes,
            nodes_before: 0,
            max_nodes: None,
            start: Instant::now(),
            timed_out: &mut timed_out,
            weights: None,
            suppress_mpc: false,
            enable_mpc: true,
            mpc_margin_t: None,
            mpc_stats: &mut mpc_stats,
            enable_etc: true,
            exact_enabled: true,
            exact_quota_remaining: &mut quota,
            exact_stats: &mut exact_stats,
            history: None,
        };
        let hash = zobrist_hash(&board, side);
        assert_eq!(mpc_try_cutoff(&board, side, 6, -INF, 0, &mut ctx, hash), None);
        assert_eq!(ctx.mpc_stats.skipped_pv_window, 1);
        assert_eq!(mpc_try_cutoff(&board, side, 6, -1, 0, &mut ctx, hash), None);
        assert_eq!(ctx.mpc_stats.skipped_exact_boundary, 1);
        assert_eq!(*ctx.exact_quota_remaining, 1234);
    }

    #[test]
    fn mpc_probe_abort_restores_context_flags_and_exact_quota() {
        let (board, side) = play_until_empties(45, first_move_strategy);
        let limit = default_limit(6, 0);
        let mut tt = TranspositionTable::new(1);
        let mut nodes = 0;
        let mut timed_out = false;
        let mut quota = 4321;
        let mut exact_stats = ExactStats::default();
        let mut mpc_stats = MpcStats::default();
        let mut ctx = SearchCtx {
            limit: &limit,
            tt: &mut tt,
            nodes: &mut nodes,
            nodes_before: 0,
            max_nodes: Some(1),
            start: Instant::now(),
            timed_out: &mut timed_out,
            weights: None,
            suppress_mpc: false,
            enable_mpc: true,
            mpc_margin_t: None,
            mpc_stats: &mut mpc_stats,
            enable_etc: true,
            exact_enabled: true,
            exact_quota_remaining: &mut quota,
            exact_stats: &mut exact_stats,
            history: None,
        };
        let hash = zobrist_hash(&board, side);
        assert_eq!(mpc_try_cutoff(&board, side, 6, -1, 0, &mut ctx, hash), None);
        assert!(*ctx.timed_out);
        assert!(!ctx.suppress_mpc);
        assert!(ctx.exact_enabled);
        assert_eq!(*ctx.exact_quota_remaining, 4321);
        assert_eq!(ctx.exact_stats.leaf_attempts, 0);
    }

    #[test]
    fn mpc_cut_does_not_store_a_target_depth_tt_entry() {
        let (board, side) = play_until_empties(45, first_move_strategy);
        let limit = default_limit(6, 0);
        let mut tt = TranspositionTable::new(1);
        let mut nodes = 0;
        let mut timed_out = false;
        let mut quota = u64::MAX;
        let mut exact_stats = ExactStats::default();
        let mut mpc_stats = MpcStats::default();
        let mut ctx = SearchCtx {
            limit: &limit,
            tt: &mut tt,
            nodes: &mut nodes,
            nodes_before: 0,
            max_nodes: None,
            start: Instant::now(),
            timed_out: &mut timed_out,
            weights: None,
            suppress_mpc: false,
            enable_mpc: true,
            mpc_margin_t: None,
            mpc_stats: &mut mpc_stats,
            enable_etc: true,
            exact_enabled: true,
            exact_quota_remaining: &mut quota,
            exact_stats: &mut exact_stats,
            history: None,
        };
        let hash = zobrist_hash(&board, side);
        assert_eq!(
            mpc_try_cutoff(&board, side, 6, -5001, -5000, &mut ctx, hash),
            Some(-5000)
        );
        assert_eq!(
            ctx.mpc_stats.eligible_nodes, 1,
            "recursive MPC must remain suppressed"
        );
        assert_eq!(*ctx.exact_quota_remaining, u64::MAX);
        let entry = ctx.tt.probe(hash, TTDomain::Midgame).unwrap();
        assert!(
            entry.depth < 6,
            "MPC may store the shallow probe, never target depth D"
        );
    }

    #[test]
    fn mpc_runtime_policy_is_deterministic_and_default_is_off() {
        let (board, side) = play_until_empties(45, first_move_strategy);
        let limit = default_limit(8, 0);
        let policy = SearchPolicy {
            enable_history: false,
            enable_aspiration: false,
            enable_mpc: true,
        };
        let run = || {
            let mut tt = TranspositionTable::new(4);
            search_with_eval_with_policy(
                &board,
                side,
                &limit,
                &mut tt,
                None,
                None,
                EXACT_QUOTA_PERCENT,
                policy,
            )
        };
        let first = run();
        let second = run();
        assert_eq!(first.best_move, second.best_move);
        assert_eq!(first.score, second.score);
        assert_eq!(first.depth, second.depth);
        assert_eq!(first.nodes, second.nodes);
        assert_eq!(first.mpc_stats, second.mpc_stats);
        assert!(first.mpc_stats.eligible_nodes > 0);

        let mut tt = TranspositionTable::new(4);
        let off = search(&board, side, &limit, &mut tt);
        assert_eq!(off.mpc_stats, MpcStats::default());
    }

    #[test]
    fn margin_t_override_at_1_5_is_bit_identical_to_the_default_none_path() {
        // T176: `search_with_eval_with_policy_and_margin_t`に`Some(1.5)`を
        // 渡した経路が、既定(`None`、本番のCALIBRATIONS表をそのまま使う)と
        // 完全に同じ結果(score/nodes/depth/best_move/mpc_stats全て)を返す
        // ことを確認する。これは「t=1.5がCALIBRATIONS表の値そのものを
        // 再現する」(mpc.rsの単体テスト)に加え、`search.rs`側の配線
        // (`ctx.mpc_margin_t`経由の上書き適用)自体が既定経路を一切
        // 変えないことの実証(受け入れ基準4「既定挙動の不変実証」)。
        let (board, side) = play_until_empties(45, first_move_strategy);
        let limit = default_limit(8, 0);
        let policy = SearchPolicy {
            enable_history: false,
            enable_aspiration: false,
            enable_mpc: true,
        };
        let run_with = |margin_t: Option<f32>| {
            let mut tt = TranspositionTable::new(4);
            search_with_eval_with_policy_and_margin_t(
                &board,
                side,
                &limit,
                &mut tt,
                None,
                None,
                EXACT_QUOTA_PERCENT,
                policy,
                margin_t,
            )
        };
        let default_none = run_with(None);
        let explicit_1_5 = run_with(Some(1.5));
        assert_eq!(default_none.best_move, explicit_1_5.best_move);
        assert_eq!(default_none.score, explicit_1_5.score);
        assert_eq!(default_none.depth, explicit_1_5.depth);
        assert_eq!(default_none.nodes, explicit_1_5.nodes);
        assert_eq!(default_none.mpc_stats, explicit_1_5.mpc_stats);
        assert!(default_none.mpc_stats.eligible_nodes > 0);

        // より積極的なtはノード数を変え得る(=経路が実際に効いていること自体の確認、
        // 常に減るとは限らないため厳密な大小は問わずeligible_nodesが同じ土台で
        // 比較できることだけ確認する)。
        let aggressive = run_with(Some(1.0));
        assert_eq!(aggressive.mpc_stats.eligible_nodes, default_none.mpc_stats.eligible_nodes);
    }

    /// T182: `negascout`本体・`negascout_or_etc`・`etc_try_cutoff`・
    /// `mpc_try_cutoff`/`mpc_try_cutoff_inner`が増分計算(`incremental_move_hash`/
    /// `toggle_side_to_move`)を実際に使ったこと(発火0件のままpassしない)を
    /// 確認するテレメトリテスト(`endgame.rs`のT105
    /// `incremental_hash_check_fires_across_random_positions_including_passes`
    /// と同じ考え方)。反復深化+MPC+ETC+aspiration+historyのすべてが有効な
    /// 経路を複数の局面(初期局面からの決定的な進行違い)で回し、負荷の大きい
    /// ノード群を通過させる。
    #[test]
    fn incremental_hash_check_fires_across_diverse_midgame_searches() {
        reset_incremental_hash_checks();
        let policy = SearchPolicy {
            enable_history: true,
            enable_aspiration: true,
            enable_mpc: true,
        };
        for n in 0..8usize {
            let (board, side) = play_until_empties(24, move |moves: &[u64]| moves[n % moves.len()]);
            let limit = default_limit(8, 0);
            let mut tt = TranspositionTable::new(4);
            let _ = search_with_eval_with_policy(
                &board,
                side,
                &limit,
                &mut tt,
                None,
                None,
                EXACT_QUOTA_PERCENT,
                policy,
            );
        }
        assert!(
            incremental_hash_checks() >= 200,
            "expected the T182 incremental-hash debug check to fire at least 200 times, got {}",
            incremental_hash_checks()
        );
    }

    /// T182: 増分Zobristハッシュ配線の絶対条件(「探索結果が配線前後で完全
    /// 一致すること」)を実証する回帰テスト。ここで固定している
    /// score/best_move/depth/nodesは、この配線変更を`git stash`で一時的に
    /// 取り除いた状態(T182着手前のコード)で同じ入力に対して実際に計測した
    /// 値と手作業で照合し、一致を確認した後に固定した(手順・結果は
    /// `tasks/T182-incremental-hash-wiring.md`の作業ログ参照)。局面は
    /// T180のEdax比較用20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`
    /// 由来)の先頭2局面を流用している。
    #[test]
    fn t182_negascout_results_are_unchanged_by_the_incremental_hash_wiring() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v6.bin"
        );
        let weights = PatternWeights::from_bytes(&std::fs::read(path).unwrap()).unwrap();

        // MPC OFF: 純粋なNegaScout + ETCの経路(`negascout`/`negascout_or_etc`/
        // `etc_try_cutoff`)。
        {
            let board =
                board_from_obf("------------------OOO----OOOX--X-OOOXXX--OOXOXOO--XXXO---OOOOOO-");
            let side = Side::White;
            let limit = default_limit(8, 0);
            let mut tt = TranspositionTable::new(16);
            let result = search_with_eval(&board, side, &limit, &mut tt, Some(&weights));
            assert_eq!(result.best_move, Some(21));
            assert_eq!(result.score, -2066);
            assert_eq!(result.depth, 8);
            assert_eq!(result.nodes, 22545);
        }

        // MPC ON: 上記に加えて`mpc_try_cutoff`/`mpc_try_cutoff_inner`の
        // プローブ経路(=`negascout`への再帰呼び出しがhash引数を伴う経路)も
        // 通す。
        {
            let board =
                board_from_obf("------------------OO-OX---OOOXO--XOOOOOOXXXOXXOO--XXOO----XXOX--");
            let side = Side::Black;
            let limit = default_limit(8, 0);
            let mut tt = TranspositionTable::new(16);
            let policy = SearchPolicy {
                enable_history: true,
                enable_aspiration: true,
                enable_mpc: true,
            };
            let result = search_with_eval_with_policy(
                &board,
                side,
                &limit,
                &mut tt,
                Some(&weights),
                None,
                EXACT_QUOTA_PERCENT,
                policy,
            );
            assert_eq!(result.best_move, Some(17));
            assert_eq!(result.score, -690);
            assert_eq!(result.depth, 8);
            assert_eq!(result.nodes, 73122);
        }
    }
}

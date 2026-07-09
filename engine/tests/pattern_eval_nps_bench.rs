//! T045: パターン評価v2導入による中盤探索NPS(ノード/秒)への影響を計測する
//! 回帰テスト。
//!
//! # 背景(T034の教訓、必読)
//! T034で、反復深化/NegaScoutの時間予算チェックが粗い粒度(当時は「1つの
//! 深さの探索が完了するごと」のみ)だと、探索木の内部で無条件に呼ばれる
//! 完全読みが「重い」局面に当たった際に時間予算を数十〜数百倍超過して
//! しまう不具合(WASM環境での無応答)が実際に発生した。修正として、
//! `TIME_CHECK_NODE_INTERVAL`(1024)ノードごとに経過時間をチェックする
//! ように変更している(`search.rs`参照)。
//!
//! T045で導入するパターン評価(22パターンのテーブル引き、`pattern_eval.rs`)
//! は、旧来の3項ヒューリスティック評価(`eval::evaluate_for`、主にpopcount)
//! より1ノードあたりの評価コストが高い可能性がある。1ノードのコストが
//! 上がるほど、1024ノードごとという固定間隔のチェックは実時間で見て
//! 「粗く」なる(=1024ノード分の実時間が伸びる)。本テストは、この実時間
//! 換算の粗さが致命的な水準になっていないか(NPSが著しく低下していないか)
//! を、実際に3項評価とパターン評価v2の両方で同じ中盤局面・同じ深さまで
//! 探索し、ノード数と経過時間からNPSを算出して比較することで確認する。
//!
//! 実測値は `cargo test -p engine --test pattern_eval_nps_bench --release --
//! --nocapture` の標準エラー出力に出る(`tasks/T045-pattern-eval-wasm-wiring.md`
//! の作業ログにも実測値を転記している)。
//!
//! デバッグビルドは(`ffo_bench.rs`と同じ理由で)最適化なしだと大きく遅くなり
//! NPSの絶対値が意味を持たなくなるため、`--release`必須とし、デバッグ
//! ビルドでは自動的に`ignored`にする。

use engine::bitboard::{Board, Side};
use engine::pattern_eval::PatternWeights;
use engine::search::{search_with_eval, SearchLimit};
use engine::tt::TranspositionTable;
use std::time::{Duration, Instant};

/// 初期局面から最下位ビット優先(決定的)に16手進めた、まだ50マス弱の
/// 空きが残っている代表的な中盤局面を作る。`exact_from_empties: 0`と
/// 組み合わせることで、探索が完全読み(`endgame::solve_exact`系)に
/// 一切切り替わらず、静的評価(3項評価/パターン評価)のコストの違いだけが
/// NPSの差として現れるようにする。
fn representative_midgame_position() -> (Board, Side) {
    let mut board = Board::initial();
    let mut side = Side::Black;
    for _ in 0..16 {
        if board.is_terminal() {
            break;
        }
        if !board.has_legal_move(side) {
            side = side.opposite();
            continue;
        }
        let legal = board.legal_moves(side);
        let mv = legal & legal.wrapping_neg();
        board = board.apply_move(side, mv);
        side = side.opposite();
    }
    (board, side)
}

/// `ffo_bench.rs`と同じ定義: ノード数と経過時間からNPS(1秒あたりノード数)を
/// 求める。経過時間が極端に短い場合のゼロ除算を避けるため、最低1msとして
/// 扱う。
fn nodes_per_second(nodes: u64, elapsed: Duration) -> u64 {
    let ms = elapsed.as_millis().max(1) as u64;
    nodes.saturating_mul(1000) / ms
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn pattern_eval_v2_midgame_nps_does_not_severely_regress_vs_heuristic_eval() {
    let (board, side) = representative_midgame_position();
    // 完全読みには一切切り替わらない設定(exact_from_empties: 0)で、
    // 十分なノード数(数十万〜数百万ノード規模)が計測できる深さまで探索する。
    let limit = SearchLimit {
        max_depth: 10,
        time_ms: None,
        exact_from_empties: 0,
    };

    let mut tt_heuristic = TranspositionTable::new(16);
    let start_heuristic = Instant::now();
    let result_heuristic = search_with_eval(&board, side, &limit, &mut tt_heuristic, None);
    let elapsed_heuristic = start_heuristic.elapsed();
    let nps_heuristic = nodes_per_second(result_heuristic.nodes, elapsed_heuristic);

    let weights_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../train/weights/pattern_v2.bin");
    let bytes = std::fs::read(weights_path)
        .unwrap_or_else(|e| panic!("failed to read {weights_path}: {e} (T044で生成済みのはず)"));
    let weights = PatternWeights::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("failed to parse {weights_path}: {e}"));

    let mut tt_pattern = TranspositionTable::new(16);
    let start_pattern = Instant::now();
    let result_pattern = search_with_eval(&board, side, &limit, &mut tt_pattern, Some(&weights));
    let elapsed_pattern = start_pattern.elapsed();
    let nps_pattern = nodes_per_second(result_pattern.nodes, elapsed_pattern);

    eprintln!(
        "[pattern_eval_nps_bench] heuristic(3-term): nodes={} elapsed={:?} nps={} | \
         pattern_v2: nodes={} elapsed={:?} nps={} | ratio(pattern/heuristic)={:.3}",
        result_heuristic.nodes,
        elapsed_heuristic,
        nps_heuristic,
        result_pattern.nodes,
        elapsed_pattern,
        nps_pattern,
        nps_pattern as f64 / nps_heuristic.max(1) as f64,
    );

    // T034の教訓を踏まえた安全マージン: パターン評価導入でNPSが1/20未満に
    // まで落ち込むような桁違いの性能劣化があれば、1024ノードごとの時間予算
    // チェック間隔が実時間で見て粗くなりすぎている可能性があるため、
    // ここで検知する(閾値は「明確な性能劣化がない」ことの確認であり、
    // 通常のテーブル引きコスト増程度なら十分に余裕を持って通る想定)。
    assert!(
        nps_pattern.saturating_mul(20) >= nps_heuristic,
        "pattern eval v2 の中盤探索NPSが3項評価に比べて著しく低下している: \
         heuristic_nps={nps_heuristic} pattern_nps={nps_pattern}"
    );
}

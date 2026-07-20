//! T158a Gate 0/Gate 1 native benchmark. Run with release and `--nocapture`.

use engine::bitboard::{Board, Side};
use engine::pattern_eval::PatternWeights;
use engine::search::{
    search_with_eval, search_with_eval_with_node_limit_and_exact_quota, SearchLimit, SearchResult,
};
use engine::tt::TranspositionTable;
use std::hint::black_box;
use std::time::{Duration, Instant};

const REPETITIONS: usize = 7;

fn models() -> (PatternWeights, PatternWeights) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../train/weights/pattern_v4.bin"
    );
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    let baseline = PatternWeights::from_bytes(&bytes).unwrap();
    assert!(!baseline.has_scalar_features());
    let candidate =
        PatternWeights::from_bytes(&baseline.clone().with_zeroed_scalar_features().to_bytes_v4())
            .unwrap();
    (baseline, candidate)
}

fn fixtures() -> Vec<(Board, Side)> {
    let mut result = Vec::new();
    let mut board = Board::initial();
    let mut side = Side::Black;
    for ply in 0..40 {
        if ply % 4 == 0 {
            result.push((board, side));
        }
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
    result
}

fn assert_same_result(a: &SearchResult, b: &SearchResult) {
    assert_eq!(a.best_move, b.best_move);
    assert_eq!(a.score, b.score);
    assert_eq!(a.depth, b.depth);
    assert_eq!(a.nodes, b.nodes);
    assert_eq!(a.pv, b.pv);
    assert_eq!(a.node_limit_hit, b.node_limit_hit);
    assert_eq!(a.timed_out, b.timed_out);
}

fn median(values: &[u128]) -> u128 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

fn range(values: &[u128]) -> (u128, u128) {
    (*values.iter().min().unwrap(), *values.iter().max().unwrap())
}

fn micro_once(weights: &PatternWeights, positions: &[(Board, Side)]) -> (Duration, u32) {
    let start = Instant::now();
    let mut checksum = 0f32;
    for _ in 0..20_000 {
        for (board, side) in positions {
            checksum += black_box(weights.score(black_box(board), black_box(*side)));
        }
    }
    (start.elapsed(), checksum.to_bits())
}

fn fixed_depth_once(
    weights: &PatternWeights,
    board: &Board,
    side: Side,
) -> (Duration, SearchResult) {
    let limit = SearchLimit {
        max_depth: 9,
        time_ms: None,
        exact_from_empties: 0,
    };
    let mut tt = TranspositionTable::new(64);
    let start = Instant::now();
    let result = search_with_eval(board, side, &limit, &mut tt, Some(weights));
    (start.elapsed(), result)
}

fn production_once(
    weights: &PatternWeights,
    board: &Board,
    side: Side,
) -> (Duration, SearchResult) {
    let limit = SearchLimit {
        max_depth: 12,
        time_ms: Some(1_500),
        exact_from_empties: 16,
    };
    let mut tt = TranspositionTable::new(64);
    let start = Instant::now();
    let result = search_with_eval_with_node_limit_and_exact_quota(
        board,
        side,
        &limit,
        &mut tt,
        Some(weights),
        160_000,
        60,
    );
    (start.elapsed(), result)
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn zero_feature_model_is_identical_and_native_cost_is_reported() {
    let (baseline, candidate) = models();
    let positions = fixtures();
    for (board, side) in &positions {
        assert_eq!(
            baseline.score(board, *side).to_bits(),
            candidate.score(board, *side).to_bits()
        );
    }

    // Warm-up both paths before alternating measurements.
    black_box(micro_once(&baseline, &positions));
    black_box(micro_once(&candidate, &positions));

    let mut micro_base = Vec::new();
    let mut micro_candidate = Vec::new();
    let mut fixed_base = Vec::new();
    let mut fixed_candidate = Vec::new();
    let mut prod_base = Vec::new();
    let mut prod_candidate = Vec::new();
    // Same fixture as the WASM benchmark script (native/WASM result cross-check).
    let search_position = (
        Board {
            black: 0x1030_1000_0408_0000,
            white: 0x0000_241c_1810_0000,
        },
        Side::Black,
    );

    for repetition in 0..REPETITIONS {
        let mut run_pair = |baseline_first: bool| {
            let (mb, cb, mf, cf, mp, cp) = if baseline_first {
                let mb = micro_once(&baseline, &positions);
                let cb = micro_once(&candidate, &positions);
                let mf = fixed_depth_once(&baseline, &search_position.0, search_position.1);
                let cf = fixed_depth_once(&candidate, &search_position.0, search_position.1);
                let mp = production_once(&baseline, &search_position.0, search_position.1);
                let cp = production_once(&candidate, &search_position.0, search_position.1);
                (mb, cb, mf, cf, mp, cp)
            } else {
                let cb = micro_once(&candidate, &positions);
                let mb = micro_once(&baseline, &positions);
                let cf = fixed_depth_once(&candidate, &search_position.0, search_position.1);
                let mf = fixed_depth_once(&baseline, &search_position.0, search_position.1);
                let cp = production_once(&candidate, &search_position.0, search_position.1);
                let mp = production_once(&baseline, &search_position.0, search_position.1);
                (mb, cb, mf, cf, mp, cp)
            };
            assert_eq!(mb.1, cb.1);
            assert_same_result(&mf.1, &cf.1);
            assert_same_result(&mp.1, &cp.1);
            micro_base.push(mb.0.as_nanos());
            micro_candidate.push(cb.0.as_nanos());
            fixed_base.push(mf.0.as_nanos());
            fixed_candidate.push(cf.0.as_nanos());
            prod_base.push(mp.0.as_nanos());
            prod_candidate.push(cp.0.as_nanos());
            eprintln!("[t158a native] repetition={} complete", repetition + 1);
        };
        run_pair(repetition % 2 == 0);
    }

    let evals = 20_000u128 * positions.len() as u128;
    let fixed_fixture = fixed_depth_once(&baseline, &search_position.0, search_position.1).1;
    assert_eq!(fixed_fixture.best_move, Some(43));
    assert_eq!(fixed_fixture.score, 1109);
    assert_eq!(fixed_fixture.depth, 9);
    assert_eq!(fixed_fixture.nodes, 183_318);
    let fixed_nodes = fixed_fixture.nodes as u128;
    let production = production_once(&baseline, &search_position.0, search_position.1).1;
    let (micro_base_min, micro_base_max) = range(&micro_base);
    let (micro_candidate_min, micro_candidate_max) = range(&micro_candidate);
    let (fixed_base_min, fixed_base_max) = range(&fixed_base);
    let (fixed_candidate_min, fixed_candidate_max) = range(&fixed_candidate);
    let (prod_base_min, prod_base_max) = range(&prod_base);
    let (prod_candidate_min, prod_candidate_max) = range(&prod_candidate);
    eprintln!(
        "[t158a native result] micro evals={} base_ns_median={} range={}..{} candidate_ns_median={} range={}..{} throughput_ratio={:.6}",
        evals, median(&micro_base), micro_base_min, micro_base_max,
        median(&micro_candidate), micro_candidate_min, micro_candidate_max,
        median(&micro_base) as f64 / median(&micro_candidate) as f64,
    );
    eprintln!(
        "[t158a native result] fixed move={:?} score={} depth={} nodes={} base_ns_median={} range={}..{} candidate_ns_median={} range={}..{} nps_ratio={:.6}",
        fixed_fixture.best_move,
        fixed_fixture.score,
        fixed_fixture.depth,
        fixed_nodes, median(&fixed_base), fixed_base_min, fixed_base_max,
        median(&fixed_candidate), fixed_candidate_min, fixed_candidate_max,
        median(&fixed_base) as f64 / median(&fixed_candidate) as f64,
    );
    eprintln!(
        "[t158a native result] production nodes={} depth={} node_limit_hit={} timed_out={} base_ns_median={} range={}..{} candidate_ns_median={} range={}..{} elapsed_ratio={:.6}",
        production.nodes, production.depth, production.node_limit_hit, production.timed_out,
        median(&prod_base), prod_base_min, prod_base_max,
        median(&prod_candidate), prod_candidate_min, prod_candidate_max,
        median(&prod_base) as f64 / median(&prod_candidate) as f64,
    );
}

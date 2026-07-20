//! T163: D4 canonical化スキーム(PWV5)導入による`PatternWeights::score`の
//! 呼び出しコスト(canonical indexの表引き1回追加分)への影響を計測する
//! 参考ベンチマーク。
//!
//! 要件3(`tasks/T163-d4-canonicalization.md`)は「ゼロ係数重みでよい・参考記録
//! でよい(ゲートはT165の実対局で判定)」としているため、本テストは
//! フルサーチではなく`score`単体呼び出しのマイクロベンチマークで、
//! canonical化テーブル引き1回追加分のコストだけを切り出して計測する
//! (T158aの層化8局面ベンチ`bench/edax-compare/t158a_engine_cost_positions.json`
//! を流用)。
//!
//! `cargo test -p engine --test t163_canonical_nps_bench --release -- \
//! --ignored --nocapture` で実行し、標準エラー出力の実測値を
//! `tasks/T163-d4-canonicalization.md`の作業ログに転記する。デバッグビルドは
//! (他のNPSベンチと同じ理由で)絶対値が意味を持たないため自動的にignoreする。

use engine::bitboard::{Board, Side};
use engine::pattern_eval::{PatternWeights, NUM_STAGES, STAGE_EMPTY_DIVISOR};
use engine::patterns;
use serde::Deserialize;
use std::hint::black_box;
use std::time::{Duration, Instant};

const REPETITIONS: usize = 7;
const EVALS_PER_POSITION: usize = 20_000;

#[derive(Clone, Deserialize)]
struct CostPositionJson {
    black: String,
    white: String,
    turn: String,
}

fn stratified_positions() -> Vec<(Board, Side)> {
    let fixtures: Vec<CostPositionJson> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../bench/edax-compare/t158a_engine_cost_positions.json"
    )))
    .unwrap();
    fixtures
        .into_iter()
        .map(|f| {
            let parse = |v: &str| u64::from_str_radix(v.strip_prefix("0x").unwrap(), 16).unwrap();
            let board = Board {
                black: parse(&f.black),
                white: parse(&f.white),
            };
            let side = if f.turn == "black" {
                Side::Black
            } else {
                Side::White
            };
            (board, side)
        })
        .collect()
}

fn micro_once(weights: &PatternWeights, positions: &[(Board, Side)]) -> (Duration, u32) {
    let start = Instant::now();
    let mut checksum = 0f32;
    for _ in 0..EVALS_PER_POSITION {
        for (board, side) in positions {
            checksum += black_box(weights.score(black_box(board), black_box(*side)));
        }
    }
    (start.elapsed(), checksum.to_bits())
}

fn median(values: &[u128]) -> u128 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

/// レガシー・canonical双方に同じ分布の非ゼロ重みを入れる(全評価がゼロを
/// 足すだけの縮退経路にならないようにする)。目的はcanonical側の
/// `table_index`表引きコスト自体を測ることなので、重みの値自体はどちらも
/// 同一分布であれば十分(実際の学習済み係数である必要はない、要件3参照)。
fn distinguishing_weights(canonical: bool) -> PatternWeights {
    let patterns = patterns::generate_patterns();
    let mut weights = if canonical {
        PatternWeights::zeroed_canonical(patterns, NUM_STAGES, STAGE_EMPTY_DIVISOR)
    } else {
        PatternWeights::zeroed_with_stage_definition(patterns, NUM_STAGES, STAGE_EMPTY_DIVISOR)
    };
    for (class_id, table) in weights.class_tables.iter_mut().enumerate() {
        for (stage, stage_table) in table.stage_tables.iter_mut().enumerate() {
            for (state, w) in stage_table.iter_mut().enumerate() {
                *w = (class_id * 100_000 + stage * 1_000 + state) as f32 * 0.0001;
            }
        }
    }
    weights
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn canonical_scheme_micro_score_nps_does_not_severely_regress_vs_legacy() {
    let legacy = distinguishing_weights(false);
    let canonical = distinguishing_weights(true);
    let positions = stratified_positions();
    assert_eq!(positions.len(), 8);

    // ウォームアップ(初回呼び出しのページフォルト・分岐予測ミス等を測定から除く)。
    black_box(micro_once(&legacy, &positions));
    black_box(micro_once(&canonical, &positions));

    let mut legacy_ns = Vec::new();
    let mut canonical_ns = Vec::new();
    for repetition in 0..REPETITIONS {
        let (l, c) = if repetition % 2 == 0 {
            (
                micro_once(&legacy, &positions),
                micro_once(&canonical, &positions),
            )
        } else {
            let c = micro_once(&canonical, &positions);
            let l = micro_once(&legacy, &positions);
            (l, c)
        };
        legacy_ns.push(l.0.as_nanos());
        canonical_ns.push(c.0.as_nanos());
    }

    let evals = (EVALS_PER_POSITION * positions.len()) as u128;
    let legacy_median = median(&legacy_ns);
    let canonical_median = median(&canonical_ns);
    let legacy_nps = evals * 1_000_000_000 / legacy_median.max(1);
    let canonical_nps = evals * 1_000_000_000 / canonical_median.max(1);
    let ratio = canonical_nps as f64 / legacy_nps as f64;
    eprintln!(
        "[t163 canonical nps bench] evals={evals} legacy_ns_median={legacy_median} \
         legacy_nps={legacy_nps} canonical_ns_median={canonical_median} \
         canonical_nps={canonical_nps} ratio(canonical/legacy)={ratio:.4}"
    );

    // 要件3: canonical indexの表引き1回追加分のコストなので大きな劣化は
    // 想定しない。目安95%以上(タスク仕様)だが、ここでは参考記録としての
    // 緩い下限(著しい劣化=1/2未満になっていないこと)だけを機械的な安全網
    // として確認する。実対局でのゲート判定はT165が担う。
    assert!(
        ratio > 0.5,
        "canonical scheme's per-call score() cost regressed too much vs legacy: ratio={ratio:.4}"
    );
}

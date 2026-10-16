use engine::bitboard::{Board, Side};
use engine::pattern_eval::*;
use engine::patterns;
use std::io::Read;
fn score_at(w: &PatternWeights, b: &Board, m: Side, stage: usize, sf: &ScalarFeatures) -> f32 {
    let mut sum = 0f32;
    for i in 0..w.patterns.len() {
        let c = w.class_info.class_of[i];
        let cells = &w.class_info.aligned_cells[i];
        let st = patterns::pattern_state_index(cells, b, m);
        let idx = w.table_index(c, st);
        sum += w.class_tables[c].stage_tables[stage][idx];
    }
    for f in &w.scalar_feature_weights {
        let raw = match f.kind {
            ScalarFeatureKind::ExactMobilityAdvantage => sf.exact_mobility_advantage,
            ScalarFeatureKind::EmptyAdjacencyExposureAdvantage => sf.empty_adjacency_exposure_advantage,
            ScalarFeatureKind::Constant => 1,
        };
        sum += f.weights[stage] * (raw as f32 / (1u32 << f.scale_shift) as f32);
    }
    sum
}
fn main() {
    let w = PatternWeights::from_bytes(&std::fs::read("C:/Users/yoshi/work/othello-trainer/app/public/pattern_v6.bin").unwrap()).unwrap();
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    println!("id,empties,stage,score_k-3,score_k-2,score_k-1,score_k0,score_k1,score_k2,score_k3,official");
    for p in v.as_array().unwrap() {
        let bs = p["board"].as_str().unwrap();
        let (mut black, mut white) = (0u64, 0u64);
        for (i, c) in bs.chars().enumerate().take(64) {
            match c { 'X' => black |= 1 << i, 'O' => white |= 1 << i, _ => {} }
        }
        let b = Board { black, white };
        let m = if p["side"].as_str().unwrap() == "black" { Side::Black } else { Side::White };
        let e = b.empty_count();
        let st = w.stage_for_empty_count(e);
        let sf = scalar_features(&b, m);
        let mut out = vec![];
        for k in -3i32..=3 {
            let s2 = (st as i32 + k).clamp(0, 60) as usize;
            out.push(format!("{:.4}", score_at(&w, &b, m, s2, &sf)));
        }
        println!("{},{},{},{},{:.4}", p["id"].as_str().unwrap(), e, st, out.join(","), w.score(&b, m));
    }
}

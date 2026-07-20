//! T156c: v4評価関数向けMulti-ProbCutの固定小数点校正表。
//!
//! 実探索の制御とプローブは `search.rs` が担当する。このモジュールは
//! T156b pilotの `(empty_bucket, target_depth, probe_depth)` と
//! `deep = a * shallow + b + residual` のQ16係数から、外向きのshallow
//! 閾値を整数演算だけで構築する。

const Q16_ONE: i64 = 1 << 16;

/// 旧 `calibrate_mpc calibrate --reduction` の省略時引数だけに使う互換値。
/// 実探索はこの固定削減量を参照せず、下のペア表の `probe_depth` を使う。
pub const REDUCTION: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Calibration {
    pub min_empties: u8,
    pub max_empties: u8,
    pub target_depth: u8,
    pub probe_depth: u8,
    pub slope_q16: i32,
    pub intercept_q16: i32,
    pub margin_high: i32,
    pub margin_low: i32,
}

/// T156b calibration splitのaffine fitと `t=1.5` residual sigma。
/// marginは安全側へceilし、方向別フィールドとして保持する。T156eでは
/// この表だけを差し替えればよい。
const CALIBRATIONS: &[Calibration] = &[
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 66511,
        intercept_q16: -40415035,
        margin_high: 753,
        margin_low: 753,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 57727,
        intercept_q16: -43588220,
        margin_high: 973,
        margin_low: 973,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 42319,
        intercept_q16: -60349704,
        margin_high: 942,
        margin_low: 942,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 27309,
        intercept_q16: -49266924,
        margin_high: 1292,
        margin_low: 1292,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 65395,
        intercept_q16: 9011893,
        margin_high: 766,
        margin_low: 766,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 57863,
        intercept_q16: 7453730,
        margin_high: 1005,
        margin_low: 1005,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 42907,
        intercept_q16: -7838860,
        margin_high: 851,
        margin_low: 851,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 23826,
        intercept_q16: -13935032,
        margin_high: 1094,
        margin_low: 1094,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 58121,
        intercept_q16: -1484462,
        margin_high: 939,
        margin_low: 939,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 52320,
        intercept_q16: 1501247,
        margin_high: 1018,
        margin_low: 1018,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 44346,
        intercept_q16: -7996216,
        margin_high: 1002,
        margin_low: 1002,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 20039,
        intercept_q16: -20215011,
        margin_high: 1157,
        margin_low: 1157,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 63945,
        intercept_q16: 12049690,
        margin_high: 788,
        margin_low: 788,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 57704,
        intercept_q16: 14822464,
        margin_high: 876,
        margin_low: 876,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 44123,
        intercept_q16: -8252060,
        margin_high: 838,
        margin_low: 838,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 24478,
        intercept_q16: -27686278,
        margin_high: 830,
        margin_low: 830,
    },
];

pub fn calibration_for(empties: u32, target_depth: u8) -> Option<&'static Calibration> {
    CALIBRATIONS.iter().find(|entry| {
        entry.target_depth == target_depth
            && empties >= entry.min_empties as u32
            && empties <= entry.max_empties as u32
    })
}

fn div_ceil(numerator: i64, denominator: i64) -> i64 {
    let floor = numerator.div_euclid(denominator);
    floor + i64::from(numerator.rem_euclid(denominator) != 0)
}

/// `a*shallow+b-margin_high >= beta` を満たす最小整数（明示的ceil）。
pub fn high_probe_bound(calibration: &Calibration, beta: i32) -> i32 {
    debug_assert!(calibration.slope_q16 > 0);
    let numerator =
        (beta as i64 + calibration.margin_high as i64) * Q16_ONE - calibration.intercept_q16 as i64;
    div_ceil(numerator, calibration.slope_q16 as i64).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// `a*shallow+b+margin_low <= alpha` を満たす最大整数（明示的floor）。
pub fn low_probe_bound(calibration: &Calibration, alpha: i32) -> i32 {
    debug_assert!(calibration.slope_q16 > 0);
    let numerator =
        (alpha as i64 - calibration.margin_low as i64) * Q16_ONE - calibration.intercept_q16 as i64;
    numerator
        .div_euclid(calibration.slope_q16 as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(high: i32, low: i32) -> Calibration {
        Calibration {
            min_empties: 21,
            max_empties: 28,
            target_depth: 6,
            probe_depth: 3,
            slope_q16: Q16_ONE as i32,
            intercept_q16: 0,
            margin_high: high,
            margin_low: low,
        }
    }

    #[test]
    fn outward_margin_uses_beta_plus_and_alpha_minus() {
        let c = identity(150, 225);
        let high = high_probe_bound(&c, 400);
        let low = low_probe_bound(&c, -300);
        assert_eq!(high, 550);
        assert!(high - 1 - c.margin_high < 400);
        assert!(high - c.margin_high >= 400);
        assert_eq!(low, -525);
        assert!(low + 1 + c.margin_low > -300);
        assert!(low + c.margin_low <= -300);
    }

    #[test]
    fn directional_rounding_is_ceil_for_high_and_floor_for_low() {
        let c = Calibration {
            slope_q16: 2 * Q16_ONE as i32,
            ..identity(1, 1)
        };
        assert_eq!(high_probe_bound(&c, 0), 1);
        assert_eq!(low_probe_bound(&c, 0), -1);
    }

    #[test]
    fn bounds_are_outside_a_width_one_nws_window() {
        let c = identity(100, 100);
        let (alpha, beta) = (20, 21);
        assert_eq!(high_probe_bound(&c, beta), 121);
        assert_eq!(low_probe_bound(&c, alpha), -80);
        assert!(high_probe_bound(&c, beta) > beta);
        assert!(low_probe_bound(&c, alpha) < alpha);
    }

    #[test]
    fn table_contains_four_pairs_in_each_bucket() {
        for empties in [21, 29, 37, 45] {
            for (target, probe) in [(6, 3), (8, 4), (10, 2), (12, 4)] {
                assert_eq!(calibration_for(empties, target).unwrap().probe_depth, probe);
            }
        }
        assert!(calibration_for(20, 10).is_none());
        assert!(calibration_for(53, 10).is_none());
        assert!(calibration_for(30, 9).is_none());
    }
}

//! T172: v6評価関数向けMulti-ProbCutの固定小数点校正表(T156cのv4版から
//! 再校正)。
//!
//! 実探索の制御とプローブは `search.rs` が担当する。このモジュールは
//! T156b pilotの `(empty_bucket, target_depth, probe_depth)` と
//! `deep = a * shallow + b + residual` のQ16係数から、外向きのshallow
//! 閾値を整数演算だけで構築する。
//!
//! T172での再校正: 本番評価関数がv4→v6(D1候補、Egaroucid探索値ラベル学習+
//! D4 canonical)に切り替わったこと(T171)を受け、同じ320局面pilot corpus
//! (`bench/edax-compare/t156_mpc_positions.json`の`pilot`部分集合)・同じ
//! (empty_bucket, target_depth=D, probe_depth=d)候補4ペア
//! ((3,6),(4,8),(2,10),(4,12)、T156b Gate 1で選定)を対象に、v6重みで
//! shallow/deepの再測定(`calibrate_mpc measure`)→affine回帰+t=1.5残差
//! sigma(`t156_mpc_stats.py`、無変更)を再計算した。16行(4帯×4ペア)
//! すべてで残差sigmaがv4比で縮小(平均比0.51、ほぼ半減)し、
//! 「v6は探索値ラベル学習のため深さ間相関が強い」という仮説を支持する
//! 結果を得た(詳細は`bench/edax-compare/t172_sigma_compare_report.md`)。
//! 下表の値は、T156cが確立したのと同一の埋め込み式
//! (`slope_q16=round(slope*65536)`・`intercept_q16=round(intercept*65536)`・
//! `margin_high=margin_low=ceil(1.5*residualSigma)`、calibration splitで
//! fit)をv6測定値にそのまま適用したもの(旧v4の値は
//! `bench/edax-compare/t172_sigma_compare_report.md`のσ比較表・git履歴の
//! 旧版で確認できる)。

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

/// T172(v6再校正)calibration splitのaffine fitと `t=1.5` residual sigma。
/// marginは安全側へceilし、方向別フィールドとして保持する。将来さらに
/// 評価関数を差し替える場合は、この表だけを同じ手順で差し替えればよい。
const CALIBRATIONS: &[Calibration] = &[
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 62870,
        intercept_q16: -16136717,
        margin_high: 425,
        margin_low: 425,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 67164,
        intercept_q16: -15208260,
        margin_high: 501,
        margin_low: 501,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 62588,
        intercept_q16: -14293455,
        margin_high: 399,
        margin_low: 399,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 6,
        probe_depth: 3,
        slope_q16: 36480,
        intercept_q16: 4613181,
        margin_high: 443,
        margin_low: 443,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 65810,
        intercept_q16: 2243136,
        margin_high: 573,
        margin_low: 573,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 69824,
        intercept_q16: 876165,
        margin_high: 439,
        margin_low: 439,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 65810,
        intercept_q16: -1817562,
        margin_high: 316,
        margin_low: 316,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 8,
        probe_depth: 4,
        slope_q16: 52538,
        intercept_q16: -5336639,
        margin_high: 400,
        margin_low: 400,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 61542,
        intercept_q16: 1507330,
        margin_high: 730,
        margin_low: 730,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 67208,
        intercept_q16: 1008232,
        margin_high: 524,
        margin_low: 524,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 65567,
        intercept_q16: -3023871,
        margin_high: 513,
        margin_low: 513,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 10,
        probe_depth: 2,
        slope_q16: 52849,
        intercept_q16: -4908638,
        margin_high: 403,
        margin_low: 403,
    },
    Calibration {
        min_empties: 21,
        max_empties: 28,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 65264,
        intercept_q16: 6101841,
        margin_high: 558,
        margin_low: 558,
    },
    Calibration {
        min_empties: 29,
        max_empties: 36,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 68091,
        intercept_q16: 393468,
        margin_high: 521,
        margin_low: 521,
    },
    Calibration {
        min_empties: 37,
        max_empties: 44,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 66700,
        intercept_q16: 935097,
        margin_high: 429,
        margin_low: 429,
    },
    Calibration {
        min_empties: 45,
        max_empties: 52,
        target_depth: 12,
        probe_depth: 4,
        slope_q16: 50735,
        intercept_q16: -10062443,
        margin_high: 374,
        margin_low: 374,
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

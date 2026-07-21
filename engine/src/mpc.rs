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

#[derive(Debug, Clone, Copy)]
pub struct Calibration {
    pub min_empties: u8,
    pub max_empties: u8,
    pub target_depth: u8,
    pub probe_depth: u8,
    pub slope_q16: i32,
    pub intercept_q16: i32,
    pub margin_high: i32,
    pub margin_low: i32,
    /// T176: `t172_v6_pilot_stats.json`のcalibration split残差sigma
    /// (centi-disc単位、`margin_high`/`margin_low`を`ceil(1.5*sigma)`で
    /// 計算した元の値そのもの)。本番の`margin_high`/`margin_low`読み出しは
    /// この値を一切参照しない(t=1.5固定表を直接使う、既存経路は完全不変)。
    /// [`calibration_with_margin_t`]が「t=1.5以外を試したい」ときにだけ
    /// 使う(MPC積極化の試行専用フィールド、T176)。
    pub sigma_centidisc: f32,
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
        sigma_centidisc: 283.084255,
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
        sigma_centidisc: 333.96432,
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
        sigma_centidisc: 265.710537,
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
        sigma_centidisc: 295.300814,
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
        sigma_centidisc: 381.713624,
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
        sigma_centidisc: 292.529761,
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
        sigma_centidisc: 210.619416,
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
        sigma_centidisc: 266.633012,
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
        sigma_centidisc: 486.545933,
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
        sigma_centidisc: 348.720572,
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
        sigma_centidisc: 341.413906,
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
        sigma_centidisc: 268.050646,
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
        sigma_centidisc: 371.756266,
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
        sigma_centidisc: 347.211633,
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
        sigma_centidisc: 285.556663,
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
        sigma_centidisc: 249.268091,
    },
];

pub fn calibration_for(empties: u32, target_depth: u8) -> Option<&'static Calibration> {
    CALIBRATIONS.iter().find(|entry| {
        entry.target_depth == target_depth
            && empties >= entry.min_empties as u32
            && empties <= entry.max_empties as u32
    })
}

/// T176: MPC積極化の試行専用。`base`(t=1.5の本番Calibration)から
/// `slope_q16`/`intercept_q16`/`probe_depth`等はそのまま、
/// `margin_high`/`margin_low`だけを`ceil(t*sigma_centidisc)`で
/// 再計算したコピーを返す。`t=1.5`を渡せば`base`と完全に同じ
/// (`margin_high`/`margin_low`が同じ整数値になる、`calibration_for`の
/// t=1.5固定値を再導出するだけ)。本番探索経路(`search.rs`の
/// `mpc_try_cutoff`)はこの関数を呼ばない限り一切呼び出されない
/// (`SearchCtx::mpc_margin_t`が`None`のときは`base`をそのまま使う)。
pub fn calibration_with_margin_t(base: &Calibration, t: f32) -> Calibration {
    let margin = (t * base.sigma_centidisc).ceil() as i32;
    Calibration {
        margin_high: margin,
        margin_low: margin,
        ..*base
    }
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
            sigma_centidisc: 0.0,
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

    #[test]
    fn calibration_with_margin_t_at_1_5_reproduces_the_stored_table_margin() {
        // T176: 本番表(t=1.5で校正済み)のmargin_high/margin_lowは
        // `ceil(1.5*sigma_centidisc)`で埋め込まれている(T172作業ログ参照)。
        // `calibration_with_margin_t(base, 1.5)`が同じ整数へ再現できることを
        // 全16エントリで確認する(t=1.5のときは`None`経由の本番経路と
        // 完全に同じ挙動になるべき、という不変条件の根拠)。
        for &base in CALIBRATIONS {
            let recomputed = calibration_with_margin_t(&base, 1.5);
            assert_eq!(
                recomputed.margin_high, base.margin_high,
                "bucket {}-{} D={} d={}",
                base.min_empties, base.max_empties, base.target_depth, base.probe_depth
            );
            assert_eq!(recomputed.margin_low, base.margin_low);
            // margin以外のフィールドは一切変わらない。
            assert_eq!(recomputed.slope_q16, base.slope_q16);
            assert_eq!(recomputed.intercept_q16, base.intercept_q16);
            assert_eq!(recomputed.probe_depth, base.probe_depth);
            assert_eq!(recomputed.target_depth, base.target_depth);
        }
    }

    #[test]
    fn calibration_with_margin_t_shrinks_margin_for_smaller_t() {
        // t=1.5→1.2のように小さくすると、margin=ceil(t*sigma)も
        // 単調に(またはtie上限まで)縮む(=より積極的にプローブがcutできる
        // 方向へ動く)ことを確認する。
        let base = CALIBRATIONS[0]; // 21-28, D=6, d=3, sigma≈283.08
        let m15 = calibration_with_margin_t(&base, 1.5).margin_high;
        let m12 = calibration_with_margin_t(&base, 1.2).margin_high;
        let m10 = calibration_with_margin_t(&base, 1.0).margin_high;
        assert!(m12 < m15, "t=1.2 margin ({m12}) should be smaller than t=1.5 ({m15})");
        assert!(m10 < m12, "t=1.0 margin ({m10}) should be smaller than t=1.2 ({m12})");
        // ceilの直接検算(sigma_centidisc=283.084255の場合)。
        assert_eq!(m10, (1.0 * base.sigma_centidisc).ceil() as i32);
    }
}

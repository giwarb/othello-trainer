//! T048: MPC (Multi-ProbCut) 用のσ(標準偏差)テーブルと、それに基づく
//! カットオフ判定に必要な定数・純粋関数群。
//!
//! # このモジュールがやらないこと
//! `negascout` の再帰呼び出し自体(浅い探索を実際に実行する部分)はここでは
//! 行わない(`search.rs` 側の `mpc_try_cutoff` が `negascout` を直接呼ぶ)。
//! このモジュールは「その浅い探索の結果をどう解釈してカットオフを判断するか」
//! に必要な定数(σテーブル・t値・削減量・最小適用深さ)と、それらから
//! マージン(centi-disc単位)を導出する純粋関数だけを持つ。
//!
//! # 適用範囲について(重要)
//! MPCは中盤ヒューリスティック探索(`search::negascout`が静的評価
//! `static_eval`をリーフ評価に使う経路)専用であり、終盤完全読み
//! (`endgame::solve_exact`系)には一切適用しない。`negascout`は
//! 空きマス数が`exact_from_empties`以下になった時点で終盤完全読みに
//! 切り替えて`return`するが、その分岐は本モジュールの関数を呼び出す
//! **手前**にあるため、終盤完全読みの経路が本モジュールの関数を呼び出す
//! ことはない(呼び出し元 `search.rs::negascout` のコメント・構造を参照)。
//!
//! # σの実測方法
//! `engine/src/bin/calibrate_mpc.rs`(`calibrate`サブコマンド)で、
//! `eval_cli gen --min-empties 22 --max-empties 50 --count 150 --seed 4048`
//! で生成した代表的な中盤局面(ランダム自己対戦から抽出、空きマス数
//! 22〜50)に対し、パターン評価v2(`train/weights/pattern_v2.bin`、
//! 本番の`Engine`が実際に使う評価関数と同じもの)を使った
//! `search::search_with_eval`で、深さ`d`とその`REDUCTION`(=2)だけ浅い
//! 深さ`d - REDUCTION`の両方の評価値(centi-disc単位、`time_ms: None`・
//! `exact_from_empties: 0`固定で完全読みを一切使わない)を求め、
//! 差分(`v(d) - v(d - REDUCTION)`)の標本標準偏差を計算した
//! (`calibrate_mpc`は既定(`mpc_enabled`フィーチャなし)のビルドで測る
//! こと。MPC有効(`--features mpc_enabled`)ビルドで測ると、測定対象の
//! 探索自体が既存の(校正前の)σテーブルによる打ち切りで汚染され、
//! 正しく実測できない)。
//! 実測条件・サンプル数・生の統計値はT048の作業ログに記録している
//! (再検証可能な形で`--seed`等のパラメータも記録済み)。
//! Edaxのσテーブルの値をそのまま使うことはしていない(自作エンジンの
//! 評価関数・探索アルゴリズムが異なるため、Edaxの実測値を流用しても
//! 意味がない)。
//!
//! # 現状の結論(T048作業ログに詳細を記録): デフォルト無効
//! 実測の結果、本エンジン(パターン評価v2)は浅い探索と深い探索の評価値の
//! 差分の標準偏差が非常に大きく(centi-discで350〜660、すなわち3.5〜6.6
//! 石相当。Edaxのσが一般に数十〜百程度のオーダーであるのとは条件が
//! 大きく異なる)。この大きなσのもとでは、誤カットを許容範囲に抑える
//! だけのマージン(`t * sigma`)を使うと、カットオフが実際に発動する
//! ノードが非常に限定され、プローブ探索自体のコスト(発動しなかった
//! 場合は完全に無駄になる)がその節約分を上回り、**同一深さでの総探索
//! ノード数・同一時間予算での到達深さのいずれで比較しても、有効化した
//! 方がわずかに遅い**という結果になった(削減量2・4の両方で検証、
//! 作業ログ参照)。このため、実装自体は完成させたが、既定では無効化し
//! (`mpc_enabled`フィーチャで明示的に有効化しない限りOFF)、将来
//! パターン評価の分散が小さくなった場合(評価関数の改善)や、ETC・
//! 安定石カット等の補完的な技術(T049/T050)と組み合わせた場合の
//! 再評価に備えて温存する。

/// MPCを適用する最小の残り探索深さ(プライ数)。これ未満の深さでは、
/// カットオフ判定のために必要な浅い探索1〜2回のオーバーヘッドが、
/// 削減できるノード数に見合わない(浅い探索自体のコストが元の探索と
/// 大差なくなる)ため適用しない。
pub const MIN_DEPTH: u8 = 5;

/// MPCの浅い探索の深さ削減量(`d' = d - REDUCTION`)。
/// `calibrate_mpc`のσ実測もこの値を前提に行っている。この定数を変更する
/// 場合はσテーブルも再実測すること。
pub const REDUCTION: u8 = 2;

/// カットオフの許容誤判定確率に対応する係数(t値)。
///
/// 大きいほど安全側(誤カットが減るが枝刈り効果も減る)、小さいほど
/// 積極的(枝刈り効果が増すが誤カットのリスクが増す)。
///
/// 実測の結果、自作エンジン(パターン評価v2 + 2ply削減)は差分の標準偏差が
/// 非常に大きく(centi-discで350〜660、すなわち3.5〜6.6石相当。Edaxの
/// σが一般に数十〜百程度のオーダーであるのとは条件が大きく異なる。
/// これはEdaxのσをそのまま使ってはいけない理由そのものでもある)。
/// t=1.5(Edaxの目安)で最初に検証した際、PV系ノード(`alpha`/`beta`の
/// どちらかが番兵値のまま伝播しているノード。作業ログ参照)にも誤って
/// 適用してしまう実装上の不具合があり、depth=8で明確な棋力低下
/// (24局中mpc有効側7勝17敗、平均石差-13.5)が観測されたが、この不具合を
/// 修正した後は同じt=1.5で24局中12勝10敗2分・平均石差-2.88と、
/// 統計的にほぼ互角の結果になった(作業ログ参照)。
pub const T: f64 = 1.5;

/// 実測したσ(centi-disc単位、1石=100)。`(残り探索深さd, σ(d))` のペア。
/// `REDUCTION`だけ浅い探索(`d - REDUCTION`)との差分から実測した値
/// (`calibrate_mpc calibrate`の出力、T048作業ログ参照)。
///
/// 深さの昇順に並んでいる必要がある(`sigma_for`の線形補間が前提とする)。
const SIGMA_TABLE: &[(u8, f64)] = &[
    (5, 663.1),
    (6, 531.0),
    (7, 542.5),
    (8, 467.9),
    (9, 461.8),
    (10, 367.3),
    (11, 398.1),
    (12, 352.5),
];

/// 残り探索深さ`depth`に対応するσ(centi-disc単位)を返す。
///
/// `SIGMA_TABLE`にちょうど一致するエントリがあればその値を、
/// テーブルの範囲内で一致しない深さ(将来`MIN_DEPTH`やテーブルの粒度を
/// 変えた場合に備える)は前後の実測値から線形補間する。テーブルの範囲外
/// (実測していない深さ)では`None`を返し、呼び出し元(`search.rs`)は
/// その深さでのMPC適用を諦めて通常探索にフォールバックする
/// (実測していない深さで当てずっぽうのマージンを使うと誤カットの
/// リスクを制御できないため)。
pub fn sigma_for(depth: u8) -> Option<f64> {
    if depth < MIN_DEPTH {
        return None;
    }

    let (min_d, _) = *SIGMA_TABLE.first()?;
    let (max_d, _) = *SIGMA_TABLE.last()?;
    if depth < min_d || depth > max_d {
        return None;
    }

    // 完全一致を探す。
    if let Some(&(_, sigma)) = SIGMA_TABLE.iter().find(|&&(d, _)| d == depth) {
        return Some(sigma);
    }

    // 前後のエントリから線形補間する。
    let mut lower: Option<(u8, f64)> = None;
    let mut upper: Option<(u8, f64)> = None;
    for &(d, sigma) in SIGMA_TABLE {
        if d < depth {
            lower = Some((d, sigma));
        } else if d > depth && upper.is_none() {
            upper = Some((d, sigma));
        }
    }
    match (lower, upper) {
        (Some((d0, s0)), Some((d1, s1))) => {
            let t = (depth - d0) as f64 / (d1 - d0) as f64;
            Some(s0 + (s1 - s0) * t)
        }
        _ => None,
    }
}

/// 残り探索深さ`depth`でのカットオフ判定に使うマージン(centi-disc単位、
/// `t * sigma`を四捨五入して丸めた整数)を返す。`depth`が`MIN_DEPTH`未満、
/// または実測範囲外(`sigma_for`が`None`)ならMPCを適用しないことを示す
/// `None`を返す。
pub fn margin_centidisc(depth: u8) -> Option<i32> {
    // T048: コンパイル時フィーチャフラグでMPCの有効/無効を切り替える。
    // 実測の結果(このファイル冒頭「現状の結論」参照)、本エンジンでは
    // MPCが同一深さでの総ノード数・同一時間予算での到達深さのいずれも
    // 改善しなかった(むしろわずかに悪化した)ため、**既定では無効**に
    // している。`mpc_enabled`フィーチャを明示的に有効にしたビルドでのみ
    // MPCが働く(`cargo build --features mpc_enabled`)。
    if !cfg!(feature = "mpc_enabled") {
        return None;
    }

    let sigma = sigma_for(depth)?;
    Some((T * sigma).round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigma_for_returns_none_below_min_depth() {
        assert_eq!(sigma_for(MIN_DEPTH - 1), None);
    }

    #[test]
    fn sigma_for_returns_none_above_calibrated_range() {
        let (max_d, _) = *SIGMA_TABLE.last().unwrap();
        assert_eq!(sigma_for(max_d + 1), None);
    }

    #[test]
    fn sigma_for_matches_table_exactly_for_calibrated_depths() {
        for &(d, sigma) in SIGMA_TABLE {
            assert_eq!(sigma_for(d), Some(sigma));
        }
    }

    #[test]
    #[cfg(feature = "mpc_enabled")]
    fn margin_centidisc_is_positive_and_scales_with_t() {
        let depth = SIGMA_TABLE[0].0;
        let margin = margin_centidisc(depth).expect("calibrated depth should yield a margin");
        assert!(margin > 0);
        let sigma = sigma_for(depth).unwrap();
        assert_eq!(margin, (T * sigma).round() as i32);
    }

    #[test]
    #[cfg(feature = "mpc_enabled")]
    fn margin_centidisc_none_out_of_range_when_mpc_enabled() {
        assert_eq!(margin_centidisc(MIN_DEPTH - 1), None);
    }

    #[test]
    #[cfg(not(feature = "mpc_enabled"))]
    fn margin_centidisc_is_always_none_when_mpc_feature_is_not_enabled() {
        // T048: 既定(`mpc_enabled`フィーチャなし)ではMPCは常に無効
        // (このファイル冒頭「現状の結論」参照: 実測でノード数・到達深さの
        // いずれも改善しなかったため、既定でオプトインの機能にしている)。
        for &(d, _) in SIGMA_TABLE {
            assert_eq!(
                margin_centidisc(d),
                None,
                "margin_centidisc({d}) should be None by default (mpc_enabled feature not set)"
            );
        }
    }
}

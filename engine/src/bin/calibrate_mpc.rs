//! T048 (MPCによる中盤探索の枝刈り高速化) 専用の開発補助バイナリ。
//!
//! `bench/edax-compare/` 配下のPythonスクリプトや `eval_cli`(T022)と同様、
//! アプリ本体・WASM APIには一切影響しない(`engine::mpc` を含む既存の公開
//! APIのみを使う。新規に `#[wasm_bindgen]` を追加していない)。
//!
//! # サブコマンド
//!
//! - `calibrate --depths "5,6,7,8,9,10,11,12" [--reduction N] [--pattern-weights PATH]`
//!   標準入力からJSON配列(`eval_cli gen` と全く同じ形式:
//!   `[{id, category, board, side_to_move}, ...]`)を読み込み、各局面・各深さ
//!   `d`について、フルウィンドウの`search::search_with_eval`を
//!   `max_depth=d`と`max_depth=d-reduction`の2回実行し(`time_ms: None`,
//!   `exact_from_empties: 0` 固定、終盤完全読みを一切使わない)、
//!   差分 `v(d) - v(d-reduction)`(centi-disc単位)の標本平均・標本標準偏差
//!   を計算する。深さごとの統計値と、`engine/src/mpc.rs`の`SIGMA_TABLE`に
//!   そのまま貼り付けられるRustの配列リテラルを標準出力に出す。
//!   MPCが実際に使う`REDUCTION`(既定値は`engine::mpc::REDUCTION`と同じ)と
//!   ずれた削減量で実測しても意味が無いため、`--reduction`を省略した場合は
//!   必ず`engine::mpc::REDUCTION`を使う(値がハードコードで重複してドリフト
//!   することを避けるため、本ファイルでは独自の定数を持たずengineクレートの
//!   ものをそのまま参照する)。
//! - `bench [--depth N] [--time-ms MS] [--pattern-weights PATH]`
//!   標準入力から同じ形式のJSON配列を読み込み、各局面について
//!   `search::search_with_eval`を1回実行し(`exact_from_empties: 0`固定)、
//!   探索ノード数・到達深さ・所要時間を計測する。`--depth`を指定すれば
//!   固定深さ(`time_ms: None`)でのノード数比較、`--time-ms`を指定すれば
//!   固定時間予算での到達深さ比較ができる(両方指定した場合は両方とも
//!   `limit`にセットする)。
//!   MPC有効/無効の比較は、本バイナリ自体を`cargo build --release -p engine
//!   --bin calibrate_mpc`(既定でMPC無効。T048作業ログ参照: 実測でノード数・
//!   到達深さのいずれも改善しなかったため既定は無効)と`cargo build
//!   --release -p engine --bin calibrate_mpc --features mpc_enabled`
//!   (MPC有効)の2通りでビルドして実行ファイルを別名で保存し、同じ標準入力
//!   (同じ局面集合)に対して両方実行して比較する(T048作業ログ参照)。
//!   なお`calibrate`サブコマンドでのσ実測は、必ずMPC無効ビルド(既定の
//!   ビルドでよい)で行うこと(MPC有効ビルドで測ると、測定対象の探索
//!   自体が既存の(校正前の)σテーブルによる打ち切りで汚染され、正しく
//!   実測できない)。

use engine::bitboard::{Board, Side};
use engine::mpc;
use engine::pattern_eval::PatternWeights;
use engine::search::{self, SearchLimit};
use engine::tt::TranspositionTable;
use serde_json::{json, Value};
use std::io::{self, Read};
use std::time::Instant;

fn load_pattern_weights(args: &[String]) -> Option<PatternWeights> {
    let path = get_arg(args, "--pattern-weights")?;
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        eprintln!("failed to read pattern weights file {path}: {e}");
        std::process::exit(1);
    });
    let weights = PatternWeights::from_bytes(&bytes).unwrap_or_else(|e| {
        eprintln!("failed to parse pattern weights file {path}: {e}");
        std::process::exit(1);
    });
    Some(weights)
}

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn get_arg_u64(args: &[String], name: &str) -> Option<u64> {
    get_arg(args, name).map(|v| v.parse().unwrap_or_else(|_| panic!("invalid {name}: {v}")))
}

/// `obf`表現(`X`=黒/`O`=白/`-`=空、64文字)を`Board`に変換する。
/// `eval_cli.rs`の同名関数と同じ規約(独立して再定義している。理由も同じ:
/// このファイルは別クレート扱いのbinターゲットであり、`eval_cli.rs`側の
/// private関数を参照できないため)。
fn obf_to_board(s: &str) -> Board {
    let mut black = 0u64;
    let mut white = 0u64;
    for (i, c) in s.chars().enumerate().take(64) {
        match c {
            'X' | 'x' | '*' => black |= 1u64 << i,
            'O' | 'o' => white |= 1u64 << i,
            _ => {}
        }
    }
    Board { black, white }
}

fn parse_side(s: &str) -> Side {
    match s {
        "black" => Side::Black,
        "white" => Side::White,
        other => panic!("invalid side_to_move: {other}"),
    }
}

struct Position {
    id: String,
    board: Board,
    side: Side,
}

fn read_positions_from_stdin() -> Vec<Position> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let parsed: Value = serde_json::from_str(&input).expect("invalid input JSON");
    let arr = parsed.as_array().expect("expected a JSON array");

    arr.iter()
        .enumerate()
        .map(|(idx, pos)| {
            let id = pos
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            let board_str = pos
                .get("board")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("position {idx} missing 'board'"));
            let side_str = pos
                .get("side_to_move")
                .and_then(Value::as_str)
                .unwrap_or("black");
            Position {
                id,
                board: obf_to_board(board_str),
                side: parse_side(side_str),
            }
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "calibrate" => cmd_calibrate(&args[2..]),
        "bench" => cmd_bench(&args[2..]),
        _ => {
            eprintln!(
                "usage:\n  calibrate_mpc calibrate --depths \"5,6,7,8,9,10,11,12\" [--reduction N] [--pattern-weights PATH]   (JSON配列を標準入力から読む)\n  calibrate_mpc bench [--depth N] [--time-ms MS] [--pattern-weights PATH]   (JSON配列を標準入力から読む)"
            );
            std::process::exit(2);
        }
    }
}

/// 標本平均・標本標準偏差(n-1で割る不偏推定量)を返す。`values`が空または
/// 1件のみの場合は`(mean, 0.0)`を返す(分散未定義を避けるための単純な扱い、
/// 本バイナリは開発補助ツールでありnが1以下になるのは引数ミス程度のため
/// パニックにはしない)。
fn mean_and_stddev(values: &[f64]) -> (f64, f64) {
    let n = values.len();
    if n == 0 {
        return (0.0, 0.0);
    }
    let mean = values.iter().sum::<f64>() / n as f64;
    if n < 2 {
        return (mean, 0.0);
    }
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1) as f64;
    (mean, variance.sqrt())
}

fn cmd_calibrate(args: &[String]) {
    let depths_arg = get_arg(args, "--depths").unwrap_or_else(|| "5,6,7,8,9,10,11,12".to_string());
    let depths: Vec<u8> = depths_arg
        .split(',')
        .map(|s| s.trim().parse().unwrap_or_else(|_| panic!("invalid --depths entry: {s}")))
        .collect();
    let reduction = get_arg(args, "--reduction")
        .map(|v| v.parse().unwrap_or_else(|_| panic!("invalid --reduction: {v}")))
        .unwrap_or(mpc::REDUCTION);
    let weights = load_pattern_weights(args);

    let positions = read_positions_from_stdin();
    eprintln!(
        "[calibrate_mpc calibrate] positions={} reduction={} pattern_weights={}",
        positions.len(),
        reduction,
        weights.is_some()
    );

    let mut table_entries: Vec<(u8, usize, f64, f64)> = Vec::new();

    for &d in &depths {
        let Some(d_shallow) = d.checked_sub(reduction) else {
            eprintln!("skipping depth={d}: reduction={reduction} would underflow (d <= reduction)");
            continue;
        };
        if d_shallow == 0 {
            eprintln!("skipping depth={d}: shallow depth would be 0 (no search to compare against)");
            continue;
        }

        let mut diffs: Vec<f64> = Vec::with_capacity(positions.len());
        for pos in &positions {
            let limit_deep = SearchLimit {
                max_depth: d,
                time_ms: None,
                exact_from_empties: 0,
            };
            let mut tt_deep = TranspositionTable::new(16);
            let deep = search::search_with_eval(&pos.board, pos.side, &limit_deep, &mut tt_deep, weights.as_ref());

            let limit_shallow = SearchLimit {
                max_depth: d_shallow,
                time_ms: None,
                exact_from_empties: 0,
            };
            let mut tt_shallow = TranspositionTable::new(16);
            let shallow =
                search::search_with_eval(&pos.board, pos.side, &limit_shallow, &mut tt_shallow, weights.as_ref());

            diffs.push((deep.score - shallow.score) as f64);
        }

        let (mean, stddev) = mean_and_stddev(&diffs);
        eprintln!(
            "depth={d:>2} (shallow={d_shallow:>2}) n={:>4} mean={mean:>8.2} stddev={stddev:>8.2}",
            diffs.len()
        );
        table_entries.push((d, diffs.len(), mean, stddev));
    }

    println!("// engine/src/mpc.rs SIGMA_TABLE用(reduction={reduction}, n=positions per depth):");
    println!("const SIGMA_TABLE: &[(u8, f64)] = &[");
    for (d, n, mean, stddev) in &table_entries {
        println!("    ({d}, {stddev:.1}), // n={n}, mean={mean:.2}");
    }
    println!("];");
}

fn cmd_bench(args: &[String]) {
    let depth = get_arg(args, "--depth").map(|v| v.parse::<u8>().unwrap_or_else(|_| panic!("invalid --depth: {v}")));
    let time_ms = get_arg_u64(args, "--time-ms");
    let weights = load_pattern_weights(args);

    if depth.is_none() && time_ms.is_none() {
        eprintln!("bench requires at least one of --depth or --time-ms");
        std::process::exit(2);
    }

    let positions = read_positions_from_stdin();
    // `--depth`未指定(time-ms専用モード)の場合、反復深化の上限として十分
    // 大きい値を使う(時間予算で必ず打ち切られる想定)。
    let max_depth = depth.unwrap_or(60);

    let mut total_nodes: u64 = 0;
    let mut total_depth: u64 = 0;
    let mut total_elapsed_ms: f64 = 0.0;
    let mut per_position: Vec<Value> = Vec::with_capacity(positions.len());

    for pos in &positions {
        let limit = SearchLimit {
            max_depth,
            time_ms,
            exact_from_empties: 0,
        };
        let mut tt = TranspositionTable::new(16);
        let start = Instant::now();
        let result = search::search_with_eval(&pos.board, pos.side, &limit, &mut tt, weights.as_ref());
        let elapsed = start.elapsed();

        total_nodes += result.nodes;
        total_depth += result.depth as u64;
        total_elapsed_ms += elapsed.as_secs_f64() * 1000.0;

        per_position.push(json!({
            "id": pos.id,
            "nodes": result.nodes,
            "depth": result.depth,
            "elapsedMs": elapsed.as_secs_f64() * 1000.0,
        }));
    }

    let n = positions.len().max(1) as f64;
    eprintln!(
        "[calibrate_mpc bench] positions={} depth={:?} time_ms={:?} pattern_weights={} total_nodes={} total_elapsed_ms={:.1} avg_depth={:.2} nps={:.0}",
        positions.len(),
        depth,
        time_ms,
        weights.is_some(),
        total_nodes,
        total_elapsed_ms,
        total_depth as f64 / n,
        (total_nodes as f64) / (total_elapsed_ms / 1000.0).max(1e-9),
    );

    println!(
        "{}",
        json!({
            "positions": positions.len(),
            "depth": depth,
            "timeMs": time_ms,
            "totalNodes": total_nodes,
            "totalElapsedMs": total_elapsed_ms,
            "avgDepth": total_depth as f64 / n,
            "nps": (total_nodes as f64) / (total_elapsed_ms / 1000.0).max(1e-9),
            "perPosition": per_position,
        })
    );
}

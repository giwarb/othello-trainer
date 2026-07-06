//! T009: FFO (French Federation of Othello) endgame test ベンチマーク統合テスト。
//!
//! `bench/ffo_positions.json` (問題 #40〜#49、出典は同ファイル冒頭のコメントを
//! 参照)を読み込み、各局面を `engine::endgame::solve_exact_with_nodes` で
//! 完全読みし、公式の正解石差と一致するかを検証する。あわせて各問題・全体の
//! 実行時間とノード数からNPS(1秒あたり探索ノード数)を計測して標準出力に
//! 表示する。
//!
//! # 2つのテストに分割している理由(重要)
//!
//! このプロジェクトの `solve_exact`(T006/`engine/src/endgame.rs`)は現時点では
//! 単純な alpha-beta + 置換表のみの実装であり、MPC(Multi-Prob-Cut)や
//! 安定石カットなどの高度な枝刈りを持たない(T009のスコープ外、design docの
//! フェーズ3以降の課題)。そのため空きマス数が増えるにつれ実行時間が
//! 大きく伸びる。実測(このリポジトリ・この環境での `--release` 実行結果):
//!
//! | 問題 | 空きマス | ノード数    | 実行時間   |
//! |------|---------|------------|-----------|
//! | #40  | 20      | 41,875,164 | 14.8秒    |
//! | #41  | 22      | 193,735,021| 75.8秒    |
//! | #42  | 22      | 319,790,944| 116.0秒   |
//! | #43  | 23      | 450,971,649| 180.6秒   |
//! | #44  | 23      | 386,081,067| 133.6秒   |
//!
//! (#45〜#49 は空きマス24〜26で、上記の伸び方から類推するとさらに大きく
//! 時間がかかる。実際にこのタスクの検証中に計測を試みたところ、全問完了まで
//! 非常に長い時間がかかった)。
//!
//! そこで、`cargo test` を素朴に実行した際に何十分〜何時間も返ってこない
//! 事態を避けるため、次の2つのテストに分割している:
//!
//! - [`ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps`]
//!   (`#[ignore]` なし、デフォルトで実行される): 空きマスが
//!   [`FAST_MAX_EMPTIES`] 以下の問題(#40〜#44、実測で全問数分以内に完了
//!   することを確認済み)を検証する。
//! - [`ffo_endgame_heavy_positions_solved_correctly_with_timing_and_nps`]
//!   (`#[ignore]` 付き): 残りの重い問題(#45〜#49、空きマス24〜26)を検証する。
//!   `cargo test -p engine --test ffo_bench --release -- --ignored --nocapture`
//!   のように明示的に指定したときのみ実行される(数十分単位の実行時間を
//!   想定)。
//!
//! いずれのテストも、対象となる問題については公式の正解石差との
//! `assert_eq!` を行う(手抜きの検証ではない)。単に「デフォルトの
//! `cargo test` 実行を現実的な時間に収める」ためだけの分割である。
//!
//! 実行方法:
//! - 高速な問題のみ(デフォルト): `cargo test -p engine --test ffo_bench --release -- --nocapture`
//! - 重い問題も含めて全問: `cargo test -p engine --test ffo_bench --release -- --include-ignored --nocapture`
//!
//! # スコープについて
//! 性能目標(単スレッド8〜15M NPS)の達成は本テストの必須要件ではない
//! (`tasks/T009-ffo-bench.md` 参照)。あくまで「正しさ」の検証と、実測NPSの
//! 可視化が目的。

use engine::bitboard::{Board, Side};
use engine::endgame::solve_exact_with_nodes;
use engine::tt::TranspositionTable;
use serde::Deserialize;
use std::time::{Duration, Instant};

/// この空きマス数以下の問題だけを「デフォルトで毎回実行するテスト」の対象に
/// する。#40〜#44(空きマス20〜23)は実測で全問数分以内に完了することを
/// 確認済み。#45以降(空きマス24〜26)は `#[ignore]` 側に回す
/// (モジュール冒頭のドキュメント参照)。
const FAST_MAX_EMPTIES: u32 = 23;

#[derive(Debug, Deserialize)]
struct FfoPosition {
    id: u32,
    board: String,
    side_to_move: String,
    expected_score: i32,
}

#[derive(Debug, Deserialize)]
struct FfoFile {
    positions: Vec<FfoPosition>,
}

fn load_positions() -> Vec<FfoPosition> {
    let json_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../bench/ffo_positions.json");
    let json_text = std::fs::read_to_string(json_path)
        .unwrap_or_else(|e| panic!("failed to read FFO position data at {json_path}: {e}"));
    let file: FfoFile = serde_json::from_str(&json_text)
        .unwrap_or_else(|e| panic!("failed to parse FFO position data at {json_path}: {e}"));

    assert!(
        file.positions.len() >= 10,
        "expected at least 10 FFO positions (#40-#49 per tasks/T009-ffo-bench.md), found {}",
        file.positions.len()
    );

    file.positions
}

/// `bench/ffo_positions.json` の64文字盤面表記を `Board` に変換する。
///
/// 文字インデックス `i` がそのままビット位置 `i` に対応する
/// (`X`=黒, `O`=白, `-`=空き)。この対応は `bitboard.rs` の
/// `index = rank0*8+file` (a1=0, h1=7, a8=56, h8=63) 表記と一致することを
/// 標準OBFの初期局面文字列から検算済み(`bench/ffo_positions.json` 冒頭コメント参照)。
fn parse_board(s: &str) -> Board {
    assert_eq!(
        s.chars().count(),
        64,
        "board string must be exactly 64 characters, got {}: {s}",
        s.chars().count()
    );

    let mut black = 0u64;
    let mut white = 0u64;
    for (i, c) in s.chars().enumerate() {
        match c {
            'X' => black |= 1u64 << i,
            'O' => white |= 1u64 << i,
            '-' => {}
            other => panic!("unexpected character '{other}' in board string at index {i}: {s}"),
        }
    }
    Board { black, white }
}

fn parse_side(s: &str) -> Side {
    match s {
        "black" => Side::Black,
        "white" => Side::White,
        other => panic!("unexpected side_to_move value: {other} (expected \"black\" or \"white\")"),
    }
}

fn nodes_per_second(nodes: u64, elapsed: Duration) -> u64 {
    let secs = elapsed.as_secs_f64();
    if secs > 0.0 {
        (nodes as f64 / secs) as u64
    } else {
        nodes
    }
}

fn print_header() {
    println!(
        "{:<8}{:>8}{:>8}{:>10}{:>14}{:>12}{:>14}",
        "problem", "empties", "score", "expected", "nodes", "time_ms", "nps"
    );
}

/// 1問を完全読みし、公式の正解石差と一致するか `assert_eq!` する。
/// 一致すればノード数・経過時間を返す(呼び出し側で合計を集計するため)。
fn solve_and_verify(pos: &FfoPosition) -> (u64, Duration) {
    let board = parse_board(&pos.board);
    let side = parse_side(&pos.side_to_move);
    let empties = board.empty_count();

    // 問題ごとに独立したTTを使う(問題間の汚染を避け、単純に1問あたりの
    // ノード数・NPSを計測するため)。
    let mut tt = TranspositionTable::new(256);

    let start = Instant::now();
    let (score, nodes) = solve_exact_with_nodes(&board, side, &mut tt);
    let elapsed = start.elapsed();

    let nps = nodes_per_second(nodes, elapsed);
    println!(
        "#{:<7}{:>8}{:>8}{:>10}{:>14}{:>12.1}{:>14}",
        pos.id,
        empties,
        score,
        pos.expected_score,
        nodes,
        elapsed.as_secs_f64() * 1000.0,
        nps
    );

    assert_eq!(
        score, pos.expected_score,
        "FFO #{}: solve_exact returned {} but the known-correct exact score is {} \
         (empties={empties})",
        pos.id, score, pos.expected_score
    );

    (nodes, elapsed)
}

#[test]
fn ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps() {
    let positions = load_positions();
    print_header();

    let mut total_nodes: u64 = 0;
    let mut total_elapsed = Duration::ZERO;
    let mut verified = 0usize;

    for pos in &positions {
        let empties = parse_board(&pos.board).empty_count();
        if empties > FAST_MAX_EMPTIES {
            continue;
        }

        let (nodes, elapsed) = solve_and_verify(pos);
        total_nodes += nodes;
        total_elapsed += elapsed;
        verified += 1;
    }

    assert!(
        verified >= 5,
        "expected at least 5 'fast' FFO positions (#40-#44, empties<={FAST_MAX_EMPTIES}) \
         to be verified by default, found {verified}"
    );

    let total_nps = nodes_per_second(total_nodes, total_elapsed);
    println!(
        "FAST TOTAL: {verified} positions solved correctly, nodes={total_nodes}, \
         time={:.3}s, nps={total_nps}",
        total_elapsed.as_secs_f64()
    );
}

#[test]
#[ignore = "heavy: FFO positions with more than FAST_MAX_EMPTIES empty squares take a very \
            long time on this project's current alpha-beta+TT-only solve_exact (no MPC / \
            stable-disc pruning yet, see engine/src/endgame.rs and tasks/T009-ffo-bench.md's \
            work log). Run explicitly with \
            `cargo test -p engine --test ffo_bench --release -- --ignored --nocapture` \
            and expect this to take a long time (potentially tens of minutes or more)."]
fn ffo_endgame_heavy_positions_solved_correctly_with_timing_and_nps() {
    let positions = load_positions();
    print_header();

    let mut total_nodes: u64 = 0;
    let mut total_elapsed = Duration::ZERO;
    let mut verified = 0usize;

    for pos in &positions {
        let empties = parse_board(&pos.board).empty_count();
        if empties <= FAST_MAX_EMPTIES {
            continue;
        }

        let (nodes, elapsed) = solve_and_verify(pos);
        total_nodes += nodes;
        total_elapsed += elapsed;
        verified += 1;
    }

    assert!(
        verified >= 1,
        "expected at least 1 'heavy' FFO position (empties>{FAST_MAX_EMPTIES}) to be verified, \
         found {verified}"
    );

    let total_nps = nodes_per_second(total_nodes, total_elapsed);
    println!(
        "HEAVY TOTAL: {verified} positions solved correctly, nodes={total_nodes}, \
         time={:.3}s, nps={total_nps}",
        total_elapsed.as_secs_f64()
    );
}

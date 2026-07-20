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
use engine::search::{self, SearchLimit, SearchPolicy};
use engine::tt::TranspositionTable;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusPosition {
    id: String,
    board: String,
    #[serde(alias = "side_to_move")]
    side_to_move: String,
    empties: u32,
    empty_bucket: String,
    split: String,
    game_id: String,
    pilot: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DepthMeasurement {
    depth: u8,
    score: i32,
    nodes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionMeasurement {
    id: String,
    empties: u32,
    empty_bucket: String,
    split: String,
    game_id: String,
    results: Vec<DepthMeasurement>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementFile {
    schema_version: u32,
    positions_fingerprint: String,
    weights_fingerprint: String,
    depths: Vec<u8>,
    pilot_only: bool,
    records: Vec<PositionMeasurement>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GateConfig {
    positions_fingerprint: String,
    weights_fingerprint: String,
    depths: Vec<u8>,
    max_nodes: Option<u64>,
    exact_from_empties: u8,
    exact_quota_percent: u8,
    mpc: bool,
    aspiration: bool,
    history: bool,
    split: Option<String>,
    min_empties: u32,
    max_positions: Option<usize>,
    selected_positions_count: usize,
    selected_positions_fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GateMpcStats {
    eligible_nodes: u64,
    probe_attempts_high: u64,
    probe_attempts_low: u64,
    probe_nodes: u64,
    cuts_high: u64,
    cuts_low: u64,
    skipped_pv_window: u64,
    skipped_exact_boundary: u64,
    skipped_uncalibrated: u64,
    cut_depth_histogram: Vec<u64>,
    probe_depth_histogram: Vec<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GateRecord {
    id: String,
    game_id: String,
    empties: u32,
    depth_requested: u8,
    best_move: Option<String>,
    score: i32,
    depth: u8,
    nodes: u64,
    node_limit_hit: bool,
    wall_limit_hit: bool,
    exact_root_attempts: u32,
    exact_leaf_attempts: u32,
    exact_root_completed: bool,
    exact_bound_proof_completed: u32,
    exact_leaf_completed: u32,
    exact_aborted_by_quota: u32,
    exact_nodes: u64,
    midgame_nodes: u64,
    aspiration_fail_low: u32,
    aspiration_fail_high: u32,
    mpc: GateMpcStats,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateFile {
    schema_version: u32,
    config: GateConfig,
    records: Vec<GateRecord>,
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
        "measure" => cmd_measure(&args[2..]),
        "merge" => cmd_merge(&args[2..]),
        "gate" => cmd_gate(&args[2..]),
        _ => {
            eprintln!(
                "usage:\n  calibrate_mpc calibrate --depths \"5,6,7,8,9,10,11,12\" [--reduction N] [--pattern-weights PATH]\n  calibrate_mpc bench [--depth N] [--time-ms MS] [--pattern-weights PATH]\n  calibrate_mpc measure --positions FILE --out FILE --pattern-weights FILE [--depths 1,2,...,12] [--pilot-only] [--max-positions N]"
            );
            eprintln!("  calibrate_mpc measure ... [--shard-count N --shard-index I]\n  calibrate_mpc merge --positions FILE --inputs SHARD1,SHARD2,... --out FILE\n  calibrate_mpc gate --positions FILE --out FILE --pattern-weights FILE --depths 8,10,12 [--configuration A|B|C|D | --mpc on|off --aspiration on|off --history on|off] [--max-nodes N] [--exact-from-empties N] [--exact-quota-percent N] [--split test] [--min-empties N] [--max-positions N]");
            std::process::exit(2);
        }
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}:{}", bytes.len())
}

fn atomic_write_json(path: &Path, value: &MeasurementFile) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let file_name = path
        .file_name()
        .ok_or("output path has no file name")?
        .to_string_lossy();
    let temp = path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|e| format!("write {}: {e}", temp.display()))?;
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("replace {}: {e}", path.display()));
    }
    Ok(())
}

fn atomic_write_gate(path: &Path, value: &GateFile) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let file_name = path
        .file_name()
        .ok_or("output path has no file name")?
        .to_string_lossy();
    let temp = path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|e| format!("write {}: {e}", temp.display()))?;
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("replace {}: {e}", path.display()));
    }
    Ok(())
}

fn square_to_notation(idx: u8) -> String {
    format!("{}{}", (b'a' + idx % 8) as char, (b'1' + idx / 8) as char)
}

fn parse_on_off(args: &[String], name: &str) -> bool {
    match get_arg(args, name).as_deref() {
        Some("on") => true,
        Some("off") => false,
        Some(value) => panic!("invalid {name}: {value}; expected on or off"),
        None => panic!("missing required arg {name}"),
    }
}

fn gate_policy(args: &[String]) -> SearchPolicy {
    if let Some(configuration) = get_arg(args, "--configuration") {
        assert!(
            !["--mpc", "--aspiration", "--history"]
                .iter()
                .any(|flag| has_flag(args, flag)),
            "--configuration cannot be combined with independent policy switches"
        );
        match configuration.as_str() {
            "A" => SearchPolicy {
                enable_history: true,
                enable_aspiration: true,
                enable_mpc: false,
            },
            "B" => SearchPolicy {
                enable_history: true,
                enable_aspiration: false,
                enable_mpc: true,
            },
            "C" => SearchPolicy {
                enable_history: true,
                enable_aspiration: true,
                enable_mpc: true,
            },
            "D" => SearchPolicy {
                enable_history: true,
                enable_aspiration: false,
                enable_mpc: false,
            },
            _ => panic!("invalid --configuration: {configuration}; expected A, B, C, or D"),
        }
    } else {
        SearchPolicy {
            enable_mpc: parse_on_off(args, "--mpc"),
            enable_aspiration: parse_on_off(args, "--aspiration"),
            enable_history: parse_on_off(args, "--history"),
        }
    }
}

fn parse_depths(args: &[String]) -> Vec<u8> {
    let text = get_arg(args, "--depths").unwrap_or_else(|| {
        (1..=12)
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join(",")
    });
    let depths: Vec<u8> = text
        .split(',')
        .map(|s| {
            s.trim()
                .parse()
                .unwrap_or_else(|_| panic!("invalid depth: {s}"))
        })
        .collect();
    assert!(!depths.is_empty() && depths.iter().all(|&d| (1..=12).contains(&d)));
    assert!(
        depths.windows(2).all(|w| w[0] < w[1]),
        "depths must be sorted and unique"
    );
    depths
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn cmd_measure(args: &[String]) {
    if cfg!(feature = "mpc_enabled") {
        panic!("measure must use a build without mpc_enabled");
    }
    let positions_path = PathBuf::from(get_arg(args, "--positions").expect("missing --positions"));
    let out_path = PathBuf::from(get_arg(args, "--out").expect("missing --out"));
    let weights_path =
        PathBuf::from(get_arg(args, "--pattern-weights").expect("missing --pattern-weights"));
    let positions_bytes = fs::read(&positions_path).expect("failed to read positions");
    let weights_bytes = fs::read(&weights_path).expect("failed to read pattern weights");
    let positions_fingerprint = fingerprint(&positions_bytes);
    let weights_fingerprint = fingerprint(&weights_bytes);
    let weights = PatternWeights::from_bytes(&weights_bytes).expect("invalid pattern weights");
    let depths = parse_depths(args);
    let pilot_only = has_flag(args, "--pilot-only");
    let max_positions: Option<usize> =
        get_arg(args, "--max-positions").map(|s| s.parse().expect("invalid --max-positions"));
    let shard_count: usize = get_arg(args, "--shard-count")
        .map(|s| s.parse().expect("invalid --shard-count"))
        .unwrap_or(1);
    let shard_index: usize = get_arg(args, "--shard-index")
        .map(|s| s.parse().expect("invalid --shard-index"))
        .unwrap_or(0);
    assert!(
        shard_count > 0 && shard_index < shard_count,
        "invalid shard"
    );
    let positions: Vec<CorpusPosition> =
        serde_json::from_slice(&positions_bytes).expect("invalid positions JSON");
    let positions: Vec<_> = positions
        .into_iter()
        .filter(|position| !pilot_only || position.pilot)
        .collect();

    let mut output = if out_path.exists() {
        let existing: MeasurementFile =
            serde_json::from_slice(&fs::read(&out_path).expect("failed to read checkpoint"))
                .expect("invalid checkpoint JSON");
        assert_eq!(existing.schema_version, 1, "checkpoint schema mismatch");
        assert_eq!(
            existing.positions_fingerprint, positions_fingerprint,
            "positions changed"
        );
        assert_eq!(
            existing.weights_fingerprint, weights_fingerprint,
            "weights changed"
        );
        assert_eq!(existing.depths, depths, "depths changed");
        assert_eq!(existing.pilot_only, pilot_only, "pilot-only changed");
        existing
    } else {
        MeasurementFile {
            schema_version: 1,
            positions_fingerprint,
            weights_fingerprint,
            depths: depths.clone(),
            pilot_only,
            records: Vec::new(),
        }
    };
    let completed: HashSet<String> = output.records.iter().map(|r| r.id.clone()).collect();
    let mut added = 0usize;
    for (position_index, position) in positions.iter().enumerate() {
        if position_index % shard_count != shard_index {
            continue;
        }
        if completed.contains(&position.id) {
            continue;
        }
        if max_positions.is_some_and(|limit| added >= limit) {
            break;
        }
        assert_eq!(
            position.board.len(),
            64,
            "invalid board for {}",
            position.id
        );
        let board = obf_to_board(&position.board);
        assert_eq!(
            board.empty_count(),
            position.empties,
            "empties mismatch for {}",
            position.id
        );
        let side = parse_side(&position.side_to_move);
        let mut results = Vec::with_capacity(depths.len());
        for &depth in &depths {
            let limit = SearchLimit {
                max_depth: depth,
                time_ms: None,
                exact_from_empties: 0,
            };
            let mut tt = TranspositionTable::new(16);
            let result = search::search_with_eval(&board, side, &limit, &mut tt, Some(&weights));
            results.push(DepthMeasurement {
                depth,
                score: result.score,
                nodes: result.nodes,
            });
        }
        output.records.push(PositionMeasurement {
            id: position.id.clone(),
            empties: position.empties,
            empty_bucket: position.empty_bucket.clone(),
            split: position.split.clone(),
            game_id: position.game_id.clone(),
            results,
        });
        atomic_write_json(&out_path, &output).unwrap_or_else(|e| panic!("{e}"));
        added += 1;
        eprintln!(
            "[measure] completed={}/{} added_this_run={} id={}",
            output.records.len(),
            positions.len(),
            added,
            position.id
        );
    }
    eprintln!(
        "[measure] checkpoint={} completed={}/{} depths={:?}",
        out_path.display(),
        output.records.len(),
        positions.len(),
        depths
    );
}

fn cmd_gate(args: &[String]) {
    let positions_path = PathBuf::from(get_arg(args, "--positions").expect("missing --positions"));
    let out_path = PathBuf::from(get_arg(args, "--out").expect("missing --out"));
    let weights_path =
        PathBuf::from(get_arg(args, "--pattern-weights").expect("missing --pattern-weights"));
    let positions_bytes = fs::read(&positions_path).expect("failed to read positions");
    let weights_bytes = fs::read(&weights_path).expect("failed to read pattern weights");
    let weights = PatternWeights::from_bytes(&weights_bytes).expect("invalid pattern weights");
    let depths = parse_depths(args);
    let max_nodes = get_arg_u64(args, "--max-nodes");
    assert!(
        max_nodes != Some(0),
        "--max-nodes must be greater than zero"
    );
    let exact_from_empties = get_arg(args, "--exact-from-empties")
        .map(|s| s.parse::<u8>().expect("invalid --exact-from-empties"))
        .unwrap_or(0);
    let exact_quota_percent = get_arg(args, "--exact-quota-percent")
        .map(|s| s.parse::<u8>().expect("invalid --exact-quota-percent"))
        .unwrap_or(60);
    assert!(
        exact_quota_percent <= 100,
        "exact quota must be at most 100"
    );
    let split = get_arg(args, "--split");
    let min_empties = get_arg(args, "--min-empties")
        .map(|s| s.parse::<u32>().expect("invalid --min-empties"))
        .unwrap_or(0);
    let max_positions = get_arg(args, "--max-positions")
        .map(|s| s.parse::<usize>().expect("invalid --max-positions"));
    let policy = gate_policy(args);
    if policy.enable_mpc && !cfg!(feature = "mpc_enabled") {
        panic!("--mpc on requires --features mpc_enabled");
    }
    let parsed: Value = serde_json::from_slice(&positions_bytes).expect("invalid positions JSON");
    let positions = parsed
        .as_array()
        .or_else(|| parsed.get("positions").and_then(Value::as_array))
        .expect("positions JSON must be an array or contain a positions array");
    let selected: Vec<&Value> = positions
        .iter()
        .filter(|position| {
            let position_split = position.get("split").and_then(Value::as_str);
            let empties = position
                .get("empties")
                .and_then(Value::as_u64)
                .expect("position missing empties") as u32;
            split
                .as_deref()
                .is_none_or(|wanted| position_split == Some(wanted))
                && empties >= min_empties
        })
        .take(max_positions.unwrap_or(usize::MAX))
        .collect();
    assert!(!selected.is_empty(), "no positions selected");

    let selected_ids: Vec<&str> = selected
        .iter()
        .map(|position| {
            position
                .get("id")
                .and_then(Value::as_str)
                .expect("position missing id")
        })
        .collect();
    let unique_selected_ids: HashSet<&str> = selected_ids.iter().copied().collect();
    assert_eq!(
        unique_selected_ids.len(),
        selected_ids.len(),
        "selected positions contain duplicate ids"
    );
    let selected_positions_fingerprint = fingerprint(selected_ids.join("\n").as_bytes());
    let config = GateConfig {
        positions_fingerprint: fingerprint(&positions_bytes),
        weights_fingerprint: fingerprint(&weights_bytes),
        depths: depths.clone(),
        max_nodes,
        exact_from_empties,
        exact_quota_percent,
        mpc: policy.enable_mpc,
        aspiration: policy.enable_aspiration,
        history: policy.enable_history,
        split: split.clone(),
        min_empties,
        max_positions,
        selected_positions_count: selected_ids.len(),
        selected_positions_fingerprint,
    };

    let mut output = if out_path.exists() {
        let existing: GateFile =
            serde_json::from_slice(&fs::read(&out_path).expect("failed to read gate checkpoint"))
                .expect("invalid gate checkpoint JSON");
        assert_eq!(
            existing.schema_version, 1,
            "gate checkpoint schema mismatch"
        );
        assert_eq!(
            existing.config, config,
            "gate checkpoint configuration changed"
        );
        let expected_keys: HashSet<(&str, u8)> = selected_ids
            .iter()
            .flat_map(|id| depths.iter().map(move |depth| (*id, *depth)))
            .collect();
        let actual_keys: HashSet<(&str, u8)> = existing
            .records
            .iter()
            .map(|record| (record.id.as_str(), record.depth_requested))
            .collect();
        assert_eq!(
            actual_keys.len(),
            existing.records.len(),
            "gate checkpoint contains duplicate records"
        );
        assert!(
            actual_keys.is_subset(&expected_keys),
            "gate checkpoint contains records outside the selected positions/depths"
        );
        existing
    } else {
        GateFile {
            schema_version: 1,
            config,
            records: Vec::new(),
        }
    };
    let mut completed: HashSet<(String, u8)> = output
        .records
        .iter()
        .map(|record| (record.id.clone(), record.depth_requested))
        .collect();
    let total = selected.len() * depths.len();
    for position in selected {
        let id = position
            .get("id")
            .and_then(Value::as_str)
            .expect("position missing id");
        let board_text = position
            .get("board")
            .and_then(Value::as_str)
            .expect("position missing board");
        assert_eq!(board_text.len(), 64, "invalid board for {id}");
        let board = obf_to_board(board_text);
        let empties = position
            .get("empties")
            .and_then(Value::as_u64)
            .expect("position missing empties") as u32;
        assert_eq!(board.empty_count(), empties, "empties mismatch for {id}");
        let side_text = position
            .get("side_to_move")
            .or_else(|| position.get("sideToMove"))
            .and_then(Value::as_str)
            .expect("position missing side_to_move");
        let side = parse_side(side_text);
        let game_id = position
            .get("gameId")
            .or_else(|| position.get("game_id"))
            .and_then(Value::as_str)
            .unwrap_or(id);
        for &depth in &depths {
            if completed.contains(&(id.to_string(), depth)) {
                continue;
            }
            let limit = SearchLimit {
                max_depth: depth,
                time_ms: None,
                exact_from_empties,
            };
            let mut tt = TranspositionTable::new(16);
            let result = search::search_with_eval_with_policy(
                &board,
                side,
                &limit,
                &mut tt,
                Some(&weights),
                max_nodes,
                exact_quota_percent,
                policy,
            );
            let m = &result.mpc_stats;
            output.records.push(GateRecord {
                id: id.to_string(),
                game_id: game_id.to_string(),
                empties,
                depth_requested: depth,
                best_move: result.best_move.map(square_to_notation),
                score: result.score,
                depth: result.depth,
                nodes: result.nodes,
                node_limit_hit: result.node_limit_hit,
                wall_limit_hit: result.wall_limit_hit,
                exact_root_attempts: result.exact_root_attempts,
                exact_leaf_attempts: result.exact_leaf_attempts,
                exact_root_completed: result.exact_root_completed,
                exact_bound_proof_completed: result.exact_bound_proof_completed,
                exact_leaf_completed: result.exact_leaf_completed,
                exact_aborted_by_quota: result.exact_aborted_by_quota,
                exact_nodes: result.exact_nodes,
                midgame_nodes: result.midgame_nodes,
                aspiration_fail_low: result.aspiration_fail_low,
                aspiration_fail_high: result.aspiration_fail_high,
                mpc: GateMpcStats {
                    eligible_nodes: m.eligible_nodes,
                    probe_attempts_high: m.probe_attempts_high,
                    probe_attempts_low: m.probe_attempts_low,
                    probe_nodes: m.probe_nodes,
                    cuts_high: m.cuts_high,
                    cuts_low: m.cuts_low,
                    skipped_pv_window: m.skipped_pv_window,
                    skipped_exact_boundary: m.skipped_exact_boundary,
                    skipped_uncalibrated: m.skipped_uncalibrated,
                    cut_depth_histogram: m.cut_depth_histogram.to_vec(),
                    probe_depth_histogram: m.probe_depth_histogram.to_vec(),
                },
            });
            completed.insert((id.to_string(), depth));
            atomic_write_gate(&out_path, &output).unwrap_or_else(|e| panic!("{e}"));
            eprintln!(
                "[gate] completed={}/{} id={} requested_depth={} reached_depth={} nodes={}",
                output.records.len(),
                total,
                id,
                depth,
                result.depth,
                result.nodes
            );
        }
    }
    eprintln!(
        "[gate] checkpoint={} completed={}/{}",
        out_path.display(),
        output.records.len(),
        total
    );
}

fn cmd_merge(args: &[String]) {
    let positions_path = PathBuf::from(get_arg(args, "--positions").expect("missing --positions"));
    let out_path = PathBuf::from(get_arg(args, "--out").expect("missing --out"));
    let input_paths = get_arg(args, "--inputs").expect("missing --inputs");
    let positions_bytes = fs::read(positions_path).expect("failed to read positions");
    let positions_fingerprint = fingerprint(&positions_bytes);
    let positions: Vec<CorpusPosition> =
        serde_json::from_slice(&positions_bytes).expect("invalid positions");
    let corpus: HashMap<&str, &CorpusPosition> = positions
        .iter()
        .map(|position| (position.id.as_str(), position))
        .collect();
    let mut header: Option<MeasurementFile> = None;
    let mut records = HashMap::new();
    for path in input_paths.split(',') {
        let mut file: MeasurementFile =
            serde_json::from_slice(&fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}")))
                .unwrap_or_else(|e| panic!("parse {path}: {e}"));
        assert_eq!(file.schema_version, 1, "schemaVersion mismatch in {path}");
        assert_eq!(
            file.positions_fingerprint, positions_fingerprint,
            "positions fingerprint does not match --positions in {path}"
        );
        assert!(
            !file.depths.is_empty() && file.depths.windows(2).all(|window| window[0] < window[1]),
            "invalid depth set in {path}"
        );
        if let Some(first) = &header {
            assert_eq!(file.positions_fingerprint, first.positions_fingerprint);
            assert_eq!(file.weights_fingerprint, first.weights_fingerprint);
            assert_eq!(file.depths, first.depths);
            assert_eq!(file.pilot_only, first.pilot_only);
        } else {
            header = Some(MeasurementFile {
                schema_version: file.schema_version,
                positions_fingerprint: file.positions_fingerprint.clone(),
                weights_fingerprint: file.weights_fingerprint.clone(),
                depths: file.depths.clone(),
                pilot_only: file.pilot_only,
                records: Vec::new(),
            });
        }
        for record in file.records.drain(..) {
            let source = corpus
                .get(record.id.as_str())
                .unwrap_or_else(|| panic!("unknown position {} in {path}", record.id));
            assert_eq!(
                record.empties, source.empties,
                "empties mismatch for {}",
                record.id
            );
            assert_eq!(
                record.empty_bucket, source.empty_bucket,
                "bucket mismatch for {}",
                record.id
            );
            assert_eq!(
                record.split, source.split,
                "split mismatch for {}",
                record.id
            );
            assert_eq!(
                record.game_id, source.game_id,
                "gameId mismatch for {}",
                record.id
            );
            let result_depths: Vec<u8> = record.results.iter().map(|result| result.depth).collect();
            assert_eq!(
                result_depths, file.depths,
                "record depth set mismatch for {}",
                record.id
            );
            if let Some(previous) = records.insert(record.id.clone(), record.clone()) {
                assert_eq!(
                    previous.empties, record.empties,
                    "duplicate empties mismatch"
                );
                assert_eq!(
                    previous.empty_bucket, record.empty_bucket,
                    "duplicate bucket mismatch"
                );
                assert_eq!(previous.split, record.split, "duplicate split mismatch");
                assert_eq!(
                    previous.game_id, record.game_id,
                    "duplicate gameId mismatch"
                );
                assert_eq!(previous.results, record.results, "conflicting duplicate");
            }
        }
    }
    let mut merged = header.expect("no inputs");
    let expected_ids: Vec<&str> = positions
        .iter()
        .filter(|position| !merged.pilot_only || position.pilot)
        .map(|position| position.id.as_str())
        .collect();
    merged.records = expected_ids
        .iter()
        .map(|id| {
            records
                .remove(*id)
                .unwrap_or_else(|| panic!("missing record {id}"))
        })
        .collect();
    assert!(
        records.is_empty(),
        "unexpected records for selected pilotOnly mode"
    );
    atomic_write_json(&out_path, &merged).unwrap_or_else(|e| panic!("{e}"));
    eprintln!(
        "[merge] wrote {} records to {}",
        merged.records.len(),
        out_path.display()
    );
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
        .map(|s| {
            s.trim()
                .parse()
                .unwrap_or_else(|_| panic!("invalid --depths entry: {s}"))
        })
        .collect();
    let reduction = get_arg(args, "--reduction")
        .map(|v| {
            v.parse()
                .unwrap_or_else(|_| panic!("invalid --reduction: {v}"))
        })
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
            eprintln!(
                "skipping depth={d}: shallow depth would be 0 (no search to compare against)"
            );
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
            let deep = search::search_with_eval(
                &pos.board,
                pos.side,
                &limit_deep,
                &mut tt_deep,
                weights.as_ref(),
            );

            let limit_shallow = SearchLimit {
                max_depth: d_shallow,
                time_ms: None,
                exact_from_empties: 0,
            };
            let mut tt_shallow = TranspositionTable::new(16);
            let shallow = search::search_with_eval(
                &pos.board,
                pos.side,
                &limit_shallow,
                &mut tt_shallow,
                weights.as_ref(),
            );

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
    let depth = get_arg(args, "--depth").map(|v| {
        v.parse::<u8>()
            .unwrap_or_else(|_| panic!("invalid --depth: {v}"))
    });
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
        let result =
            search::search_with_eval(&pos.board, pos.side, &limit, &mut tt, weights.as_ref());
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

#[cfg(test)]
mod gate_tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn named_gate_configurations_map_to_registered_policies() {
        let cases = [
            (
                "A",
                SearchPolicy {
                    enable_history: true,
                    enable_aspiration: true,
                    enable_mpc: false,
                },
            ),
            (
                "B",
                SearchPolicy {
                    enable_history: true,
                    enable_aspiration: false,
                    enable_mpc: true,
                },
            ),
            (
                "C",
                SearchPolicy {
                    enable_history: true,
                    enable_aspiration: true,
                    enable_mpc: true,
                },
            ),
            (
                "D",
                SearchPolicy {
                    enable_history: true,
                    enable_aspiration: false,
                    enable_mpc: false,
                },
            ),
        ];
        for (name, expected) in cases {
            assert_eq!(gate_policy(&strings(&["--configuration", name])), expected);
        }
    }

    #[test]
    fn named_and_independent_policy_switches_are_rejected() {
        let args = strings(&["--configuration", "A", "--mpc", "off"]);
        assert!(std::panic::catch_unwind(|| gate_policy(&args)).is_err());
    }

    #[test]
    fn selected_position_fingerprint_is_order_and_limit_sensitive() {
        let all = fingerprint(["p1", "p2"].join("\n").as_bytes());
        let reversed = fingerprint(["p2", "p1"].join("\n").as_bytes());
        let limited = fingerprint(["p1"].join("\n").as_bytes());
        assert_ne!(all, reversed);
        assert_ne!(all, limited);
    }

    #[test]
    fn merge_rejects_record_metadata_mismatch() {
        let dir = std::env::temp_dir().join(format!("t156d-merge-mismatch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let positions_path = dir.join("positions.json");
        let input_path = dir.join("input.json");
        let out_path = dir.join("out.json");
        let positions = json!([{
            "id": "p1", "board": "-".repeat(64), "side_to_move": "black",
            "empties": 30, "empty_bucket": "29-36", "split": "test",
            "game_id": "g1", "pilot": false
        }]);
        let positions_bytes = serde_json::to_vec(&positions).unwrap();
        fs::write(&positions_path, &positions_bytes).unwrap();
        let invalid = MeasurementFile {
            schema_version: 1,
            positions_fingerprint: fingerprint(&positions_bytes),
            weights_fingerprint: "test-weights".to_string(),
            depths: vec![1],
            pilot_only: false,
            records: vec![PositionMeasurement {
                id: "p1".to_string(),
                empties: 29,
                empty_bucket: "29-36".to_string(),
                split: "test".to_string(),
                game_id: "g1".to_string(),
                results: vec![DepthMeasurement {
                    depth: 1,
                    score: 0,
                    nodes: 1,
                }],
            }],
        };
        fs::write(&input_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        let args = strings(&[
            "--positions",
            positions_path.to_str().unwrap(),
            "--inputs",
            input_path.to_str().unwrap(),
            "--out",
            out_path.to_str().unwrap(),
        ]);
        assert!(std::panic::catch_unwind(|| cmd_merge(&args)).is_err());
        assert!(!out_path.exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}

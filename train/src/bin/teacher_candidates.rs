//! T090a: Edax教師コーパス生成の第一段(候補局面プール抽出)。
//!
//! WTHOR棋譜(`train/data/WTH_*.wtb`)を`train::wthor::parse` + `train::train_data::samples_from_game`で
//! 再生し(合法手判定・パス処理は既存の学習パイプラインと完全に同じロジックを再利用する。
//! Othelloのルール自体をこのファイルで再実装しない)、各対局から
//!
//!  - 空きマス帯(6段階、目安の「フェーズ」)ごとに最大`--per-bin-cap`局面(既定1)
//!  - 1対局あたり `--per-game-cap`(既定6 = フェーズ数と同数)
//!  - 各対局の8プライ後D4正準化局面を`openingKey`として付与し、Python側で同一opening
//!    の抽出上限を適用可能にする
//!
//! を決定的な擬似乱数(対局ごとに`--seed`から導出したxorshift64、依存クレート追加を
//! 避けるための自作実装。`eval_cli.rs`の`Rng`と同種だが本ファイル用に独立実装)で選び、
//! `train::experiment::canonicalize`(D4正準化、T088既存実装をそのまま再利用)で
//! 全体重複除去した上でJSON配列を書き出す。
//!
//! 出力の各要素は「Edaxに投げる前の候補局面」であり、教師値そのものはここでは
//! 計算しない(Edax呼び出し・チェックポイント/resumeは
//! `bench/edax-compare/gen_teacher_corpus.py` 側の責務)。
//!
//! 使い方(3つのサブコマンド):
//! ```text
//! cargo run -p train --release --bin teacher_candidates -- extract \
//!   --data-dir train/data --years 2015-2024 --seed 90100 --per-game-cap 6 \
//!   --out train/data/teacher/candidates.json
//!
//! # T090a: 選定済み局面(標準入力のJSON配列 `[{board, sideToMove}, ...]`)について、
//! # 各局面の全合法手・着手後の子局面・子局面の合法手有無を
//! # `engine::bitboard::Board`(既存の認定済み実装)で計算し、JSON配列を標準出力に返す。
//! # Pythonの生成スクリプト(`bench/edax-compare/gen_teacher_corpus.py`)がEdaxを
//! # 呼ぶ前段としてこれを使う(Othelloのルール自体をPython側で再実装しないため)。
//! echo '[{"board":"...","sideToMove":"black"}]' | \
//!   cargo run -p train --release --bin teacher_candidates -- children
//! ```
//! (`extract`引数を省略した場合も後方互換として`extract`扱いにする。)

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::bitboard::{Board, Side};
use serde_json::{json, Value};
use train::experiment::canonicalize;
use train::train_data::{samples_from_game, Sample};
use train::wthor;

/// X/Cマス(0-indexed、`train_data.rs`の`last_move_metadata`と同じ定義)。
const X_SQUARES: [u8; 4] = [9, 14, 49, 54];
const C_SQUARES: [u8; 8] = [1, 8, 6, 15, 48, 57, 55, 62];

/// フェーズ境界(空きマス数の下限、6段階)。`empties`がこの配列のどの区間に
/// 入るかで`phaseBin`(0..5)を決める(値は本タスクの設計判断、README/manifestに明記)。
const PHASE_BIN_LOWER_BOUNDS: [u32; 6] = [50, 40, 30, 20, 10, 1];

fn phase_bin(empties: u32) -> Option<usize> {
    for (i, &lower) in PHASE_BIN_LOWER_BOUNDS.iter().enumerate() {
        let upper = if i == 0 { 60 } else { PHASE_BIN_LOWER_BOUNDS[i - 1] - 1 };
        if empties >= lower && empties <= upper {
            return Some(i);
        }
    }
    None
}

/// `eval_cli.rs`の`Rng`と同じSplitMix64混合によるシード初期化 + xorshift64*。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        Rng(z.max(1))
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x.wrapping_mul(2_685_821_657_736_338_717)
    }

    fn gen_range(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

fn select_bucket_indices(rng: &mut Rng, bucket_len: usize, wanted: usize) -> Vec<usize> {
    let mut seen_indices = HashSet::with_capacity(wanted);
    let mut picked_indices = Vec::with_capacity(wanted);
    while picked_indices.len() < wanted {
        // wanted=1 (the K=1 default) deliberately performs exactly the legacy
        // single gen_range call. K>1 only adds draws inside this bin.
        let pick_index = rng.gen_range(bucket_len);
        if seen_indices.insert(pick_index) {
            picked_indices.push(pick_index);
        }
    }
    picked_indices
}

fn board_to_obf(b: &Board) -> String {
    let mut s = String::with_capacity(64);
    for i in 0..64u32 {
        let bit = 1u64 << i;
        if b.black & bit != 0 {
            s.push('X');
        } else if b.white & bit != 0 {
            s.push('O');
        } else {
            s.push('-');
        }
    }
    s
}

fn side_name(s: Side) -> &'static str {
    match s {
        Side::Black => "black",
        Side::White => "white",
    }
}

/// `eval_cli.rs::obf_to_board`と同じ変換(`X`/`x`/`*`=黒、`O`/`o`=白)。
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
        other => panic!("invalid sideToMove: {other}"),
    }
}

/// `eval_cli.rs::square_to_notation`と同じ規約(`index = rank0*8+file`)。
fn square_to_notation(idx: u8) -> String {
    let file = idx % 8;
    let rank = idx / 8;
    format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
}

fn has_xc_legal_move(board: &Board, mover: Side) -> bool {
    let legal = board.legal_moves(mover);
    for &sq in X_SQUARES.iter().chain(C_SQUARES.iter()) {
        if legal & (1u64 << sq) != 0 {
            return true;
        }
    }
    false
}

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn parse_years(spec: &str) -> Vec<u32> {
    if let Some((lo, hi)) = spec.split_once('-') {
        let lo: u32 = lo.trim().parse().expect("invalid --years lower bound");
        let hi: u32 = hi.trim().parse().expect("invalid --years upper bound");
        (lo..=hi).collect()
    } else {
        spec.split(',')
            .map(|s| s.trim().parse().expect("invalid --years entry"))
            .collect()
    }
}

struct CandidateRow {
    board: Board,
    side_to_move: Side,
    empties: u32,
    year: u16,
    game_index: usize,
    phase_bin: usize,
    has_xc_legal_move: bool,
    opening_key: String,
}

fn main() -> ExitCode {
    let all_args: Vec<String> = env::args().skip(1).collect();
    let (sub, rest): (&str, &[String]) = match all_args.first().map(String::as_str) {
        Some("extract") => ("extract", &all_args[1..]),
        Some("children") => ("children", &all_args[1..]),
        Some("canonical") => ("canonical", &all_args[1..]),
        Some(other) if other.starts_with("--") => ("extract", &all_args[..]), // 後方互換
        None => ("extract", &all_args[..]),
        Some(other) => {
            eprintln!("unknown subcommand: {other} (expected 'extract' or 'children')");
            return ExitCode::FAILURE;
        }
    };
    match sub {
        "extract" => cmd_extract(rest),
        "children" => {
            cmd_children();
            ExitCode::SUCCESS
        }
        "canonical" => {
            cmd_canonical();
            ExitCode::SUCCESS
        }
        _ => unreachable!(),
    }
}

/// 標準入力の局面配列について、Rust正本のD4 canonical keyを返すテスト用API。
fn cmd_canonical() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("failed to read stdin");
    let positions: Value = serde_json::from_str(&input).expect("invalid input JSON");
    let result: Vec<Value> = positions
        .as_array()
        .expect("expected a JSON array")
        .iter()
        .map(|pos| {
            let board = obf_to_board(pos["board"].as_str().expect("position.board missing"));
            let mover = parse_side(pos["sideToMove"].as_str().expect("position.sideToMove missing"));
            let sample = Sample {
                board,
                mover,
                outcome: 0.0,
                last_move_kind: train::train_data::LastMoveKind::Other,
                vulnerable_xc: false,
            };
            let (key, _) = canonicalize(&sample);
            json!([key.0, key.1, key.2])
        })
        .collect();
    println!("{}", Value::Array(result));
}

/// T090a: 標準入力のJSON配列 `[{board, sideToMove}, ...]` について、各局面の
/// 全合法手・着手後の子局面(手番自動反転・パス処理込み)を計算し、
/// JSON配列を標準出力に返す。Edax呼び出し前の「合法手列挙・着手適用」を
/// Python側で再実装しないためのバッチAPI(`eval_cli apply`を局面×合法手の
/// 組み合わせぶん逐次subprocess起動するとオーバーヘッドが大きいため、
/// 1プロセス起動で全件処理する)。
fn cmd_children() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let positions: Value = serde_json::from_str(&input).expect("invalid input JSON");
    let arr = positions.as_array().expect("expected a JSON array");

    let mut out: Vec<Value> = Vec::with_capacity(arr.len());
    for pos in arr {
        let board_str = pos
            .get("board")
            .and_then(Value::as_str)
            .expect("position.board missing")
            .to_string();
        let side_str = pos
            .get("sideToMove")
            .and_then(Value::as_str)
            .expect("position.sideToMove missing")
            .to_string();
        let board = obf_to_board(&board_str);
        let side = parse_side(&side_str);

        let legal = board.legal_moves(side);
        let mut moves: Vec<Value> = Vec::new();
        let mut rem = legal;
        while rem != 0 {
            let lsb = rem & rem.wrapping_neg();
            let idx = lsb.trailing_zeros() as u8;
            rem &= rem - 1;

            let next_board = board.apply_move(side, lsb);
            let mut next_side = side.opposite();
            // `eval_cli.rs::cmd_apply`と同じパス処理: 相手に合法手が無く、
            // 着手した側にはまだ合法手があるならそのまま着手側の手番を続ける。
            if !next_board.has_legal_move(next_side) && next_board.has_legal_move(side) {
                next_side = side;
            }
            let child_has_legal_move =
                next_board.has_legal_move(next_side) || next_board.has_legal_move(next_side.opposite());

            moves.push(json!({
                "move": square_to_notation(idx),
                "childBoard": board_to_obf(&next_board),
                "childSideToMove": side_name(next_side),
                "childHasLegalMove": next_board.has_legal_move(next_side),
                "childIsTerminal": !child_has_legal_move,
                "childEmpties": next_board.empty_count(),
            }));
        }

        out.push(json!({
            "board": board_str,
            "sideToMove": side_str,
            "empties": board.empty_count(),
            "legalMoveCount": moves.len(),
            "moves": moves,
        }));
    }

    println!("{}", Value::Array(out));
}

fn cmd_extract(args: &[String]) -> ExitCode {
    let data_dir = get_arg(args, "--data-dir").unwrap_or_else(|| "train/data".to_string());
    let years_spec = get_arg(&args, "--years").unwrap_or_else(|| "2015-2024".to_string());
    let years: HashSet<u32> = parse_years(&years_spec).into_iter().collect();
    let seed: u64 = get_arg(&args, "--seed")
        .map(|v| v.parse().expect("invalid --seed"))
        .unwrap_or(90100);
    let per_game_cap: usize = get_arg(&args, "--per-game-cap")
        .map(|v| v.parse().expect("invalid --per-game-cap"))
        .unwrap_or(PHASE_BIN_LOWER_BOUNDS.len());
    let per_bin_cap: usize = get_arg(&args, "--per-bin-cap")
        .map(|v| v.parse().expect("invalid --per-bin-cap"))
        .unwrap_or(1);
    let out_path = get_arg(&args, "--out")
        .unwrap_or_else(|| "train/data/teacher/candidates.json".to_string());

    let mut files: Vec<PathBuf> = Vec::new();
    match fs::read_dir(&data_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "wtb").unwrap_or(false) {
                    files.push(path);
                }
            }
        }
        Err(e) => {
            eprintln!("failed to read --data-dir {data_dir}: {e}");
            return ExitCode::FAILURE;
        }
    }
    files.sort();

    if files.is_empty() {
        eprintln!("no .wtb files found under {data_dir}");
        return ExitCode::FAILURE;
    }

    let mut rows: Vec<CandidateRow> = Vec::new();
    let mut total_games_scanned = 0usize;
    let mut total_games_in_year_range = 0usize;
    let mut files_used: Vec<String> = Vec::new();

    for path in &files {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("failed to read {}: {e}", path.display());
                return ExitCode::FAILURE;
            }
        };
        let parsed = match wthor::parse(&bytes) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("failed to parse {}: {e:?}", path.display());
                return ExitCode::FAILURE;
            }
        };
        let year = parsed.header.year_of_games;
        if !years.contains(&(year as u32)) {
            continue;
        }
        files_used.push(path.display().to_string());

        for (game_index, game) in parsed.games.iter().enumerate() {
            total_games_scanned += 1;
            let samples = match samples_from_game(&game.moves) {
                Ok(s) => s,
                Err(_) => continue, // 非合法な着手列(防御的スキップ、train_data.rsと同じ扱い)
            };
            total_games_in_year_range += 1;

            // 8プライ後(8手目適用後)の局面をopeningの識別子とする。短い対局は
            // 最終サンプルへフォールバックする。
            let opening_sample = &samples[usize::min(7, samples.len() - 1)];
            let (opening_canonical, _) = canonicalize(opening_sample);
            let opening_key = format!(
                "{:016x}:{:016x}:{}",
                opening_canonical.0, opening_canonical.1, opening_canonical.2
            );

            // フェーズbinごとに、その対局内で合法手が存在する候補局面を集める。
            let mut by_bin: Vec<Vec<&Sample>> = vec![Vec::new(); PHASE_BIN_LOWER_BOUNDS.len()];
            for sample in &samples {
                if sample.board.legal_moves(sample.mover) == 0 {
                    continue; // 終局間際でmoverに合法手が無い局面は候補にしない
                }
                let empties = sample.board.empty_count();
                if let Some(bin) = phase_bin(empties) {
                    by_bin[bin].push(sample);
                }
            }

            let mut game_rng = Rng::new(seed.wrapping_add((game_index as u64).wrapping_mul(1_000_003).wrapping_add(year as u64)));
            let mut picked_for_game = 0usize;
            for (bin_idx, bucket) in by_bin.iter().enumerate() {
                if picked_for_game >= per_game_cap {
                    break;
                }
                if bucket.is_empty() {
                    continue;
                }
                let wanted = per_bin_cap.min(bucket.len()).min(per_game_cap - picked_for_game);
                for pick_index in select_bucket_indices(&mut game_rng, bucket.len(), wanted) {
                    let pick = bucket[pick_index];
                    rows.push(CandidateRow {
                        board: pick.board,
                        side_to_move: pick.mover,
                        empties: pick.board.empty_count(),
                        year,
                        game_index,
                        phase_bin: bin_idx,
                        has_xc_legal_move: has_xc_legal_move(&pick.board, pick.mover),
                        opening_key: opening_key.clone(),
                    });
                    picked_for_game += 1;
                }
            }
        }
    }

    let before_dedup = rows.len();

    // D4正準化によるグローバル重複除去(先勝ち)。`canonicalize`は`Sample`全体を
    // 要求するので、dedup判定用に必要最小限のフィールドだけを埋めたダミーを渡す
    // (`board`と`mover`だけがキー計算に使われる。`train_data.rs`のcanonicalize実装参照)。
    let mut seen = HashSet::new();
    let mut deduped: Vec<CandidateRow> = Vec::with_capacity(rows.len());
    for row in rows {
        let dummy_sample = Sample {
            board: row.board,
            mover: row.side_to_move,
            outcome: 0.0,
            last_move_kind: train::train_data::LastMoveKind::Other,
            vulnerable_xc: false,
        };
        let (key, _) = canonicalize(&dummy_sample);
        if seen.insert(key) {
            deduped.push(row);
        }
    }
    let after_dedup = deduped.len();

    let positions: Vec<serde_json::Value> = deduped
        .iter()
        .map(|row| {
            json!({
                "board": board_to_obf(&row.board),
                "sideToMove": side_name(row.side_to_move),
                "empties": row.empties,
                "year": row.year,
                "gameIndex": row.game_index,
                "phaseBin": row.phase_bin,
                "hasXcLegalMove": row.has_xc_legal_move,
                "openingKey": row.opening_key,
                "source": "wthor",
            })
        })
        .collect();

    let mut doc = json!({
        "schemaVersion": 1,
        "tool": "train::bin::teacher_candidates",
        "dataDir": data_dir,
        "years": years_spec,
        "seed": seed,
        "perGameCap": per_game_cap,
        "phaseBinLowerBounds": PHASE_BIN_LOWER_BOUNDS,
        "filesUsed": files_used,
        "totalGamesScanned": total_games_scanned,
        "totalGamesInYearRange": total_games_in_year_range,
        "totalCandidatesBeforeDedup": before_dedup,
        "totalCandidatesAfterDedup": after_dedup,
        "positions": positions,
    });

    // K=1の候補JSONをバイト単位でも後方互換に保つ。新フィールドはK>1だけ記録する。
    if per_bin_cap != 1 {
        doc["perBinCap"] = json!(per_bin_cap);
    }

    if let Some(parent) = Path::new(&out_path).parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("failed to create output directory {}: {e}", parent.display());
            return ExitCode::FAILURE;
        }
    }
    if let Err(e) = fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap()) {
        eprintln!("failed to write {out_path}: {e}");
        return ExitCode::FAILURE;
    }

    eprintln!(
        "wrote {after_dedup} candidate position(s) (before dedup: {before_dedup}, games scanned: {total_games_scanned}) to {out_path}"
    );

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::{select_bucket_indices, Rng};

    #[test]
    fn per_bin_cap_one_preserves_legacy_draw_and_rng_state() {
        for bucket_len in [1, 2, 7, 31] {
            let mut legacy = Rng::new(90_103);
            let expected = legacy.gen_range(bucket_len);
            let expected_next = legacy.next_u64();

            let mut current = Rng::new(90_103);
            assert_eq!(select_bucket_indices(&mut current, bucket_len, 1), vec![expected]);
            assert_eq!(current.next_u64(), expected_next);
        }
    }

    #[test]
    fn per_bin_cap_extension_is_deterministic_and_without_replacement() {
        let mut first = Rng::new(90_104);
        let mut second = Rng::new(90_104);
        let selected = select_bucket_indices(&mut first, 8, 4);
        assert_eq!(selected, select_bucket_indices(&mut second, 8, 4));
        let mut unique = selected.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 4);
    }
}

//! T022 (Edaxとの評価値比較) 専用の、最小限のコマンドライン評価ツール。
//!
//! `bench/edax-compare/` の比較スクリプトから呼び出されることのみを想定した
//! 開発補助バイナリであり、アプリ本体・WASM APIには一切影響しない
//! (`lib.rs` の `pub struct Engine` / `pub mod bitboard` など、既存の公開API
//! のみを使って実装しており、`eval`/`search`/`protocol` 等の非公開モジュールに
//! 手を加えたり可視性を変更したりはしていない)。
//!
//! # サブコマンド
//!
//! - `gen --category NAME --min-empties N --max-empties M --count C --seed S`
//!   初期局面から乱数(自作xorshift64、依存クレート追加を避けるため)で
//!   ランダムな合法手を選び続ける自己対戦を`--seed`から独立に`--count`回行い、
//!   各対局から空きマス数が`[--min-empties, --max-empties]`の範囲に入る局面を
//!   1つずつ抽出する。「定跡書に載っている名前付きオープニング」ではなく、
//!   あくまで「代表的な序盤/中盤の一局面」を再現可能な形で生成するための
//!   簡易ジェネレータである(T022の作業ログ参照)。
//!   標準出力にJSON配列 `[{id, category, board, side_to_move}, ...]` を出力する。
//! - `eval --depth N --exact-from-empties M`
//!   標準入力からJSON配列(`gen`と同じ形。`ffo_positions.json`を変換した
//!   ものでもよい)を読み込み、各局面について
//!   `Engine::analyze`(既存の公開WASM APIと全く同じJSONプロトコル、
//!   `protocol.rs`)を使って (a) 静的評価のみ(`depth=0`,
//!   `exactFromEmpties=0`) と (b) 指定した `--depth`/`--exact-from-empties`
//!   での評価、の2つを計算し、結果をJSON配列で標準出力に出す。
//!
//! 盤面の局面表現は本リポジトリ既存の規約 (`bench/ffo_positions.json` および
//! Edaxの `.obf` 形式と同じ) に従う: 64文字 (a1,b1,...,h1,a2,...,h8の順、
//! `bitboard.rs` の `index = rank0*8+file` 規約と一致) の `X`(黒)/`O`(白)/`-`
//! (空)文字列。

use engine::bitboard::{Board, Side};
use engine::eval::feature_diffs;
use engine::Engine;
use serde_json::{json, Value};
use std::io::{self, Read};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "gen" => cmd_gen(&args[2..]),
        "eval" => cmd_eval(&args[2..]),
        "moves" => cmd_moves(&args[2..]),
        "apply" => cmd_apply(&args[2..]),
        _ => {
            eprintln!(
                "usage:\n  eval_cli gen --category NAME --min-empties N --max-empties M --count C --seed S\n  eval_cli eval --depth N --exact-from-empties M   (JSON配列を標準入力から読む)\n  eval_cli moves --depth N --exact-from-empties M  (単一局面のJSONオブジェクトを標準入力から読み、全合法手のスコアを返す)"
            );
            std::process::exit(2);
        }
    }
}

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn get_arg_u32(args: &[String], name: &str, default: Option<u32>) -> u32 {
    match get_arg(args, name) {
        Some(v) => v.parse().unwrap_or_else(|_| panic!("invalid {name}: {v}")),
        None => default.unwrap_or_else(|| panic!("missing required arg {name}")),
    }
}

/// 依存クレートを増やさないための、テスト専用の最小限xorshift64*実装。
/// 暗号論的な強度は不要(比較用局面の再現可能な多様性が得られれば十分)。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // 単純な `seed * 定数` だけだと、近い `seed` 値(例:
        // `game_idx` を線形に混ぜただけの値)から生成した複数の乱数列が、
        // 序盤の(選択肢が少ない)数手だけを見ると偶然一致してしまう
        // ケースが実際に観測された(同一プロセス内で異なる `--seed` の
        // つもりが同じ局面を2回生成した)。SplitMix64の既知の終段混合関数を
        // シード初期化に使い、隣接するseed同士でも初期状態を十分に
        // 分散させることで、この相関を避ける。
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

    fn gen_range(&mut self, n: u32) -> u32 {
        (self.next_u64() % n as u64) as u32
    }
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

fn side_name(s: Side) -> &'static str {
    match s {
        Side::Black => "black",
        Side::White => "white",
    }
}

fn parse_side(s: &str) -> Side {
    match s {
        "black" => Side::Black,
        "white" => Side::White,
        other => panic!("invalid side_to_move: {other}"),
    }
}

/// `--seed` を起点に `--count` 個の独立したランダム自己対戦を行い、各対局から
/// 空きマス数が `[min_empties, max_empties]` に収まる局面を1つずつ抽出する。
fn cmd_gen(args: &[String]) {
    let category = get_arg(args, "--category").unwrap_or_else(|| "position".to_string());
    let min_empties = get_arg_u32(args, "--min-empties", None);
    let max_empties = get_arg_u32(args, "--max-empties", None);
    let count = get_arg_u32(args, "--count", None);
    let seed = get_arg_u32(args, "--seed", None) as u64;

    let mut results: Vec<Value> = Vec::new();
    let mut produced = 0u32;
    let mut game_idx: u64 = 0;
    let max_attempts = (count as u64) * 200 + 100;

    while produced < count && game_idx < max_attempts {
        let mut rng = Rng::new(seed.wrapping_add(game_idx * 1_000_003 + 7));
        game_idx += 1;

        let mut board = Board::initial();
        let mut side = Side::Black;
        let mut candidates_in_range: Vec<(Board, Side)> = Vec::new();

        loop {
            if board.is_terminal() {
                break;
            }
            if !board.has_legal_move(side) {
                side = side.opposite();
                continue;
            }

            let empties = board.empty_count();
            if empties <= max_empties && empties >= min_empties {
                candidates_in_range.push((board, side));
            }
            if empties < min_empties {
                break;
            }

            let legal = board.legal_moves(side);
            let mut moves: Vec<u64> = Vec::new();
            let mut rem = legal;
            while rem != 0 {
                let lsb = rem & rem.wrapping_neg();
                moves.push(lsb);
                rem &= rem - 1;
            }
            let pick = moves[rng.gen_range(moves.len() as u32) as usize];
            board = board.apply_move(side, pick);
            side = side.opposite();
        }

        if candidates_in_range.is_empty() {
            continue;
        }

        let pick_idx = rng.gen_range(candidates_in_range.len() as u32) as usize;
        let (b, s) = candidates_in_range[pick_idx];
        produced += 1;
        results.push(json!({
            "id": format!("{}-{}", category, produced),
            "category": category,
            "board": board_to_obf(&b),
            "side_to_move": side_name(s),
        }));
    }

    if produced < count {
        eprintln!(
            "warning: only produced {} of {} requested positions (category={})",
            produced, count, category
        );
    }

    println!("{}", Value::Array(results));
}

/// 標準入力のJSON配列の各局面について、静的評価(depth=0)と指定深さ/完全読み
/// 設定での評価を、`Engine::analyze`(既存公開API)経由で計算する。
fn cmd_eval(args: &[String]) {
    let depth = get_arg_u32(args, "--depth", Some(10)) as u8;
    let exact_from_empties = get_arg_u32(args, "--exact-from-empties", Some(0)) as u8;

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let positions: Value = serde_json::from_str(&input).expect("invalid input JSON");
    let arr = positions.as_array().expect("expected a JSON array");

    let mut engine = Engine::new();
    let mut out: Vec<Value> = Vec::new();

    for (idx, pos) in arr.iter().enumerate() {
        let id = pos
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let category = pos
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let board_str = pos
            .get("board")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let side_str = pos
            .get("side_to_move")
            .and_then(Value::as_str)
            .unwrap_or("black")
            .to_string();

        let b = obf_to_board(&board_str);
        let side = parse_side(&side_str);
        let black_hex = format!("{:x}", b.black);
        let white_hex = format!("{:x}", b.white);

        let static_req = json!({
            "id": idx,
            "cmd": "analyze",
            "board": { "black": black_hex, "white": white_hex, "turn": side_name(side) },
            "limit": { "depth": 0, "exactFromEmpties": 0 }
        });
        let static_resp: Value =
            serde_json::from_str(&engine.analyze(&static_req.to_string())).unwrap_or(Value::Null);

        let search_req = json!({
            "id": idx,
            "cmd": "analyze",
            "board": { "black": black_hex, "white": white_hex, "turn": side_name(side) },
            "limit": { "depth": depth, "exactFromEmpties": exact_from_empties }
        });
        let search_resp: Value =
            serde_json::from_str(&engine.analyze(&search_req.to_string())).unwrap_or(Value::Null);

        // T024: 較正用の生の特徴量差分(黒視点、重み付け前)。手番視点への変換は
        // 回帰スクリプト側の責務とする(黒視点のまま出す方が `eval.rs` の
        // 規約と一致し、変換ミスの余地が少ない)。
        let f = feature_diffs(&b);

        out.push(json!({
            "id": id,
            "category": category,
            "board": board_str,
            "side_to_move": side_str,
            "empties": b.empty_count(),
            "featureDiffs": {
                "mobility": f.mobility_diff,
                "corner": f.corner_diff,
                "stable": f.stable_diff,
            },
            "staticDiscDiff": static_resp.get("score").and_then(|s| s.get("discDiff")),
            "searchDiscDiff": search_resp.get("score").and_then(|s| s.get("discDiff")),
            "searchDepth": search_resp.get("depth"),
            "searchKind": search_resp.get("score").and_then(|s| s.get("type")),
            "bestMove": search_resp.get("pv").and_then(|p| p.get(0)).cloned().unwrap_or(Value::Null),
            "requestedDepth": depth,
            "requestedExactFromEmpties": exact_from_empties,
        }));
    }

    println!("{}", Value::Array(out));
}

/// 標準入力の単一局面(JSONオブジェクト `{board, side_to_move}`)について、
/// `Engine::analyze` の `allMoves: true`(T018で追加済みの既存公開API)を
/// 使い、現局面の全合法手それぞれの評価値をスコア降順で返す。
/// T022の「明白な悪手の検出」検証(隅の隣接マスへの着手など)で、
/// 特定の1手だけをEdaxと突き合わせるために使う。
/// 標準入力の単一局面(JSONオブジェクト `{board, side_to_move}`)に対して
/// `--move`(`"a1"`〜`"h8"` 記法)で指定した1手を適用し、着手後の局面を
/// 同じJSON形式(`{board, side_to_move}`、手番は着手前の相手側に自動で
/// 反転する)で標準出力に返す。T022で「特定の1手を打った後の局面」を
/// Edaxにも独立に評価させる(悪手検出の突き合わせ)ために使う。
/// 合法手であることは `Board::apply_move` 呼び出し前に確認し、
/// 非合法であればエラーメッセージをstderrに出して終了コード1で終了する。
fn cmd_apply(args: &[String]) {
    let mv_notation = get_arg(args, "--move").expect("missing required arg --move");

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let pos: Value = serde_json::from_str(&input).expect("invalid input JSON");

    let board_str = pos
        .get("board")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let side_str = pos
        .get("side_to_move")
        .and_then(Value::as_str)
        .unwrap_or("black")
        .to_string();

    let b = obf_to_board(&board_str);
    let side = parse_side(&side_str);

    let mv_bytes = mv_notation.as_bytes();
    if mv_bytes.len() != 2 {
        eprintln!("invalid move notation: {mv_notation}");
        std::process::exit(1);
    }
    let file = (mv_bytes[0] as char).to_ascii_lowercase() as u32 - 'a' as u32;
    let rank = (mv_bytes[1] as char) as u32 - '1' as u32;
    let idx = rank * 8 + file;
    let mv_bit = 1u64 << idx;

    if b.legal_moves(side) & mv_bit == 0 {
        eprintln!("illegal move {mv_notation} for {side_str} on board {board_str}");
        std::process::exit(1);
    }

    let next_board = b.apply_move(side, mv_bit);
    let mut next_side = side.opposite();
    // 相手に合法手が無ければパスして手番を戻す(両者パスなら終局のまま返す)。
    if !next_board.has_legal_move(next_side) && next_board.has_legal_move(side) {
        next_side = side;
    }

    println!(
        "{}",
        json!({
            "board": board_to_obf(&next_board),
            "side_to_move": side_name(next_side),
        })
    );
}

fn cmd_moves(args: &[String]) {
    let depth = get_arg_u32(args, "--depth", Some(10)) as u8;
    let exact_from_empties = get_arg_u32(args, "--exact-from-empties", Some(0)) as u8;

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let pos: Value = serde_json::from_str(&input).expect("invalid input JSON");

    let board_str = pos
        .get("board")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let side_str = pos
        .get("side_to_move")
        .and_then(Value::as_str)
        .unwrap_or("black")
        .to_string();

    let b = obf_to_board(&board_str);
    let side = parse_side(&side_str);

    let req = json!({
        "id": 0,
        "cmd": "analyze",
        "board": { "black": format!("{:x}", b.black), "white": format!("{:x}", b.white), "turn": side_name(side) },
        "limit": { "depth": depth, "exactFromEmpties": exact_from_empties },
        "allMoves": true
    });

    let mut engine = Engine::new();
    let resp: Value = serde_json::from_str(&engine.analyze(&req.to_string())).unwrap_or(Value::Null);

    println!(
        "{}",
        json!({
            "board": board_str,
            "side_to_move": side_str,
            "moves": resp.get("moves").cloned().unwrap_or(Value::Null),
        })
    );
}

//! T022 (Edaxとの評価値比較) 専用の、最小限のコマンドライン評価ツール。
//!
//! `bench/edax-compare/` の比較スクリプトから呼び出されることのみを想定した
//! 開発補助バイナリであり、アプリ本体・WASM APIには一切影響しない
//! (`lib.rs` の `pub struct Engine` / `pub mod bitboard` など、既存の公開API
//! のみを使って実装している。T043で`patterns`/`pattern_eval`/`search`を
//! `pub mod`にした際も、あくまでモジュールの可視性変更のみであり
//! `#[wasm_bindgen]`はどの項目にも新規追加していないため、WASM公開API
//! (JS側から見えるエクスポート)への影響はない)。
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
//! - `eval --depth N --exact-from-empties M [--pattern-weights PATH]`
//!   標準入力からJSON配列(`gen`と同じ形。`ffo_positions.json`を変換した
//!   ものでもよい)を読み込み、各局面について (a) 静的評価のみ(`depth=0`,
//!   `exactFromEmpties=0`) と (b) 指定した `--depth`/`--exact-from-empties`
//!   での評価、の2つを計算し、結果をJSON配列で標準出力に出す。
//!   `--pattern-weights PATH` を指定すると(T043)、3項ヒューリスティック
//!   評価の代わりにT041で学習したパターン評価(`train/weights/pattern_v1.bin`
//!   形式、`engine::pattern_eval::PatternWeights::from_bytes`)を静的評価に
//!   使う。省略時は従来どおり `Engine::analyze`(既存の公開WASM APIと全く
//!   同じJSONプロトコル、`protocol.rs`)経由で評価する(挙動は変更していない)。
//! - `moves --depth N --exact-from-empties M [--pattern-weights PATH]`
//!   同様に `--pattern-weights` を指定すると、全合法手のランキングを
//!   パターン評価で計算する。
//! - `best --depth N [--time-ms T] --exact-from-empties M [--pattern-weights PATH]`
//!   (T084) 単一局面(標準入力、`moves`/`apply`と同じJSONオブジェクト)を
//!   **単一ルートのPVS探索**(`search::search_with_eval`、反復深化+NegaScout+TT+
//!   ETC+終盤完全読み。`moves`が使う`search_all_moves_with_eval`とは異なり、
//!   全合法手を個別にfull-window探索して時間予算を分割する方式ではない)で
//!   1回だけ探索し、最善手とテレメトリ一式(到達深さ・総ノード数・経過ms・
//!   NPS・タイムアウト有無・exact読みの試行/完走/フォールバックの別)を
//!   返す。`--time-ms`を省略すると時間無制限(fixed-depthモード、決定性
//!   検証・回帰検知用)、指定するとその予算内で反復深化を打ち切る
//!   (wall-timeモード、Edax対戦ハーネス`bench/edax-compare/vs_edax.py`の
//!   single-root着手選択がこのモードを使う)。
//!
//! 盤面の局面表現は本リポジトリ既存の規約 (`bench/ffo_positions.json` および
//! Edaxの `.obf` 形式と同じ) に従う: 64文字 (a1,b1,...,h1,a2,...,h8の順、
//! `bitboard.rs` の `index = rank0*8+file` 規約と一致) の `X`(黒)/`O`(白)/`-`
//! (空)文字列。

use engine::bitboard::{Board, Side};
use engine::eval::feature_diffs;
use engine::pattern_eval::PatternWeights;
use engine::search::{self, SearchLimit};
use engine::tt::TranspositionTable;
use engine::Engine;
use serde_json::{json, Value};
use std::io::{self, Read};

/// `--pattern-weights PATH` が指定されていれば、そのファイルを読み込んで
/// [`PatternWeights`] を返す(読み込み・パース失敗時はエラーメッセージを
/// stderrに出して終了コード1で終了する)。指定が無ければ `None`
/// (呼び出し側は従来どおり3項ヒューリスティック評価を使う)。
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

/// [`search::MoveEval::is_exact`] / [`search::SearchResult::is_exact`] を
/// `protocol.rs` の `ScoreJson`/`MoveEvalJson` と同じ語彙(`"exact"`/
/// `"midgame"`)に変換する(`protocol` モジュールは非公開なのでこのCLI
/// 内で同じ変換を再定義している。ロジック自体は if/else 1行のみで
/// ドリフトの実害は小さい)。
fn eval_kind(is_exact: bool) -> &'static str {
    if is_exact {
        "exact"
    } else {
        "midgame"
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "gen" => cmd_gen(&args[2..]),
        "eval" => cmd_eval(&args[2..]),
        "moves" => cmd_moves(&args[2..]),
        "apply" => cmd_apply(&args[2..]),
        "best" => cmd_best(&args[2..]),
        _ => {
            eprintln!(
                "usage:\n  eval_cli gen --category NAME --min-empties N --max-empties M --count C --seed S\n  eval_cli eval --depth N --exact-from-empties M [--pattern-weights PATH]   (JSON配列を標準入力から読む)\n  eval_cli moves --depth N --exact-from-empties M [--pattern-weights PATH]  (単一局面のJSONオブジェクトを標準入力から読み、全合法手のスコアを返す)\n  eval_cli best --depth N [--time-ms T] --exact-from-empties M [--pattern-weights PATH]  (T084: 単一局面のJSONオブジェクトを標準入力から読み、single-root探索で最善手1つとテレメトリを返す)"
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

/// マス番号(0..63)を `"a1"`〜`"h8"` の記法に変換する。
/// `protocol::square_to_notation`と同じ規約だが、`protocol`モジュールは
/// 非公開でこのCLI(別クレート扱いのbinターゲット)からは参照できないため、
/// この1行の純粋関数だけをこのファイル内で再定義している。
fn square_to_notation(idx: u8) -> String {
    let file = idx % 8;
    let rank = idx / 8;
    format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
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
/// 設定での評価を計算する。`--pattern-weights` 省略時は従来どおり
/// `Engine::analyze`(既存公開API)経由、指定時は`engine::search`を直接
/// 呼び出しパターン評価(T043)を使う。
fn cmd_eval(args: &[String]) {
    let depth = get_arg_u32(args, "--depth", Some(10)) as u8;
    let exact_from_empties = get_arg_u32(args, "--exact-from-empties", Some(0)) as u8;
    let pattern_weights = load_pattern_weights(args);

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

        let (static_disc_diff, search_disc_diff, search_depth, search_kind, best_move) =
            match &pattern_weights {
                None => {
                    let black_hex = format!("{:x}", b.black);
                    let white_hex = format!("{:x}", b.white);

                    let static_req = json!({
                        "id": idx,
                        "cmd": "analyze",
                        "board": { "black": &black_hex, "white": &white_hex, "turn": side_name(side) },
                        "limit": { "depth": 0, "exactFromEmpties": 0 }
                    });
                    let static_resp: Value = serde_json::from_str(&engine.analyze(&static_req.to_string()))
                        .unwrap_or(Value::Null);

                    let search_req = json!({
                        "id": idx,
                        "cmd": "analyze",
                        "board": { "black": &black_hex, "white": &white_hex, "turn": side_name(side) },
                        "limit": { "depth": depth, "exactFromEmpties": exact_from_empties }
                    });
                    let search_resp: Value = serde_json::from_str(&engine.analyze(&search_req.to_string()))
                        .unwrap_or(Value::Null);

                    (
                        static_resp
                            .get("score")
                            .and_then(|s| s.get("discDiff"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        search_resp
                            .get("score")
                            .and_then(|s| s.get("discDiff"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        search_resp.get("depth").cloned().unwrap_or(Value::Null),
                        search_resp
                            .get("score")
                            .and_then(|s| s.get("type"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        search_resp
                            .get("pv")
                            .and_then(|p| p.get(0))
                            .cloned()
                            .unwrap_or(Value::Null),
                    )
                }
                Some(w) => {
                    // T043: パターン評価(`search::search_with_eval`)を直接呼び出す。
                    // T045で`Engine::analyze`/`protocol.rs`もパターン評価の重み
                    // (`Engine::load_pattern_weights`で読み込んだもの)を受け取れる
                    // ようになったが、このCLIはEdax比較専用の開発補助ツールであり
                    // `Engine`インスタンスを介さず`search`モジュールを直接呼んでも
                    // 支障はないため、変更せずそのままにしている。
                    let static_limit = SearchLimit {
                        max_depth: 0,
                        time_ms: None,
                        exact_from_empties: 0,
                    };
                    let mut tt_static = TranspositionTable::new(16);
                    let static_result =
                        search::search_with_eval(&b, side, &static_limit, &mut tt_static, Some(w));

                    let search_limit = SearchLimit {
                        max_depth: depth,
                        time_ms: None,
                        exact_from_empties,
                    };
                    let mut tt_search = TranspositionTable::new(16);
                    let search_result =
                        search::search_with_eval(&b, side, &search_limit, &mut tt_search, Some(w));

                    (
                        json!(static_result.score as f64 / 100.0),
                        json!(search_result.score as f64 / 100.0),
                        json!(search_result.depth),
                        json!(eval_kind(search_result.is_exact)),
                        search_result
                            .best_move
                            .map(square_to_notation)
                            .map(Value::from)
                            .unwrap_or(Value::Null),
                    )
                }
            };

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
            "staticDiscDiff": static_disc_diff,
            "searchDiscDiff": search_disc_diff,
            "searchDepth": search_depth,
            "searchKind": search_kind,
            "bestMove": best_move,
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
    // T034診断用: `timeMs` を任意で指定できるようにする(本番 `ANALYZE_LIMIT`
    // と同じ条件を再現するため)。省略時は従来どおり時間無制限。
    let time_ms = get_arg(args, "--time-ms").map(|v| v.parse::<u64>().expect("invalid --time-ms"));
    let pattern_weights = load_pattern_weights(args);

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

    let start = std::time::Instant::now();

    let moves_json: Value = match &pattern_weights {
        None => {
            let mut limit = json!({ "depth": depth, "exactFromEmpties": exact_from_empties });
            if let Some(t) = time_ms {
                limit["timeMs"] = json!(t);
            }

            let req = json!({
                "id": 0,
                "cmd": "analyze",
                "board": { "black": format!("{:x}", b.black), "white": format!("{:x}", b.white), "turn": side_name(side) },
                "limit": limit,
                "allMoves": true
            });

            let mut engine = Engine::new();
            let resp: Value =
                serde_json::from_str(&engine.analyze(&req.to_string())).unwrap_or(Value::Null);
            resp.get("moves").cloned().unwrap_or(Value::Null)
        }
        Some(w) => {
            // T043: パターン評価を使う場合は`Engine::analyze`を経由せず
            // `search::search_all_moves_with_eval`を直接呼ぶ(理由は`cmd_eval`
            // 内の同種の分岐のコメントを参照)。
            let limit = SearchLimit {
                max_depth: depth,
                time_ms,
                exact_from_empties,
            };
            let mut tt = TranspositionTable::new(16);
            let evals = search::search_all_moves_with_eval(&b, side, &limit, &mut tt, Some(w));
            let moves: Vec<Value> = evals
                .iter()
                .map(|e| {
                    json!({
                        "move": square_to_notation(e.mv),
                        "score": e.score,
                        "discDiff": e.score as f64 / 100.0,
                        "type": eval_kind(e.is_exact),
                    })
                })
                .collect();
            Value::Array(moves)
        }
    };

    let elapsed = start.elapsed();
    eprintln!("[eval_cli moves] elapsed={elapsed:?} depth={depth} exact_from_empties={exact_from_empties} time_ms={time_ms:?} pattern_weights={}", pattern_weights.is_some());

    println!(
        "{}",
        json!({
            "board": board_str,
            "side_to_move": side_str,
            "moves": moves_json,
        })
    );
}

/// T084: 標準入力の単一局面(`moves`/`apply`と同じJSON形式)に対して、
/// **単一ルート**の探索(`search::search_with_eval`。反復深化+NegaScout+TT+
/// ETC+終盤完全読み。`cmd_moves`が使う`search_all_moves_with_eval`のように
/// 全合法手を個別にfull-window探索して時間予算を候補数で分割する方式
/// ではない)を1回だけ行い、最善手とテレメトリ一式を返す。
///
/// エンジン強化ロードマップの設計レビュー(`tasks/design/T083-engine-strengthening-report.md`)
/// で、既存のEdax対戦ハーネス(T082)が`moves`(全合法手分割探索)を着手選択に
/// 使っており、単一ルートで1秒使った場合の実力が一度も測られていないことが
/// 判明したため、その計測を可能にするために追加した。
///
/// `--pattern-weights`省略時は`None`(3項ヒューリスティック評価)で
/// `search::search_with_eval`を直接呼ぶ(`cmd_eval`/`cmd_moves`と異なり
/// `Engine::analyze`経由にはしない。理由は同じ: このCLIはEdax比較専用の
/// 開発補助ツールであり、`search`モジュールを直接呼んでも`Engine`インスタンスの
/// 挙動と支障なく一致する。既存公開API(`#[wasm_bindgen]`)には一切触れない)。
fn cmd_best(args: &[String]) {
    let depth = get_arg_u32(args, "--depth", Some(10)) as u8;
    let exact_from_empties = get_arg_u32(args, "--exact-from-empties", Some(0)) as u8;
    let time_ms = get_arg(args, "--time-ms").map(|v| v.parse::<u64>().expect("invalid --time-ms"));
    let pattern_weights = load_pattern_weights(args);

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

    // exact読みが「試みられた」かどうかは、ルート局面自体の空きマス数と
    // `exact_from_empties`の比較だけで(探索前に)決まる(探索木の途中で
    // さらにexactへ入るケースはここでは数えない。あくまでルート局面が
    // 完全読みショートカットの対象だったかどうか)。「完走したか」は
    // `SearchResult::is_exact`が正確に報告する(T034の教訓どおり、
    // 事前計算した空きマス数ベースの判定だけでは実態と食い違いうるため)。
    let exact_attempted = b.empty_count() <= exact_from_empties as u32;

    let limit = SearchLimit {
        max_depth: depth,
        time_ms,
        exact_from_empties,
    };
    let mut tt = TranspositionTable::new(16);
    let result = search::search_with_eval(&b, side, &limit, &mut tt, pattern_weights.as_ref());

    let exact_completed = result.is_exact;
    // 「試みたが完走できず、通常の反復深化(またはその反復深化すら一度も
    // 完了せず静的評価)にフォールバックした」ケース。
    let exact_fallback = exact_attempted && !exact_completed;

    let nps: u64 = if result.elapsed_ms > 0 {
        ((result.nodes as f64) / (result.elapsed_ms as f64 / 1000.0)).round() as u64
    } else {
        // 経過時間が1ms未満に丸められた場合、0除算を避けてノード数を
        // そのままNPSとして報告する(1秒未満で完了した場合の下限値の目安)。
        result.nodes
    };

    eprintln!(
        "[eval_cli best] elapsed_ms={} depth={} nodes={} nps={} timed_out={} is_exact={} exact_attempted={} exact_fallback={}",
        result.elapsed_ms, result.depth, result.nodes, nps, result.timed_out, result.is_exact, exact_attempted, exact_fallback
    );

    println!(
        "{}",
        json!({
            "board": board_str,
            "side_to_move": side_str,
            "move": result.best_move.map(square_to_notation),
            "score": {
                "discDiff": result.score as f64 / 100.0,
                "type": eval_kind(result.is_exact),
            },
            "depth": result.depth,
            "nodes": result.nodes,
            "elapsedMs": result.elapsed_ms,
            "nps": nps,
            "timedOut": result.timed_out,
            "exact": {
                "attempted": exact_attempted,
                "completed": exact_completed,
                "fallback": exact_fallback,
            },
            "requestedDepth": depth,
            "requestedExactFromEmpties": exact_from_empties,
            "requestedTimeMs": time_ms,
        })
    );
}

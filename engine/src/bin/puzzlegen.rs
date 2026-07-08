//! T027 (詰めオセロ問題データ生成パイプライン) 用の、生データ計算専用の
//! コマンドライン補助ツール。
//!
//! `puzzlegen/generate.ts` から呼び出されることのみを想定した開発補助バイナリ
//! であり、アプリ本体・WASM APIには一切影響しない(`lib.rs` の
//! `pub struct Engine` 等、既存の公開APIのみを使って実装しており、
//! `search`/`protocol` 等の非公開モジュールには一切手を加えていない)。
//!
//! 「唯一解性フィルタ」「明確さフィルタ」「難易度スコアリング」「デイリー選択」
//! といった**判定・スコアリングロジック自体はこのバイナリでは行わない**
//! (それらはテスト容易性のため `app/src/tsume/*.ts` の純粋関数として実装し、
//! Vitestで単体テストする)。このバイナリの責務は「完全読み(`solve_exact`、
//! 既存の `engine::endgame` を再実装せずそのまま呼び出す)によってしか
//! 得られない生データ(各候補局面・各合法手ごとの真の最終石差、浅い静的評価値、
//! 隅の隣接判定・確定石数といった機械的に判定できる事実)を計算して
//! JSONとして出力する」ことに限定する。
//!
//! # サブコマンド
//!
//! - `candidates --min-empties N --max-empties M --target-per-empties K --seed S`
//!   初期局面から乱数(自作xorshift64、`eval_cli.rs` と同じ実装。依存クレート
//!   追加を避けるためこのバイナリ内に複製している)で自己対戦を行い、
//!   空きマス数が `[N, M]` の範囲にある局面を、空きマス数ごとに最大 `K` 個ずつ
//!   収集する(1ゲームで空き `N..=M` の各値を通過するたびに候補として拾うため、
//!   `eval_cli.rs gen` のように1ゲームにつき1局面だけ拾う方式より効率的)。
//!   着手選択は「6割の確率で直後の静的評価が最良の手を選び、4割はランダム」
//!   という軽い誘導(半グリーディ)を入れる。完全ランダムウォークだけだと
//!   非現実的に石がバラけた盤面になりやすく、かといって候補生成の時点で
//!   毎手探索するとコストが跳ね上がる(高コストな完全読みは後段の `evaluate`
//!   に一任したい)ため、静的評価1手読みという軽量な誘導に留めた
//!   (作業ログにも根拠を記載)。
//!   標準出力にJSON配列 `[{id, board, sideToMove, empties}, ...]` を出す。
//! - `evaluate --per-candidate-timeout-secs T --overall-timeout-secs O`
//!   標準入力から `candidates` と同じ形のJSON配列を読み、各候補局面について
//!   全合法手を `solve_exact` で完全読みする。**候補1件ごとに別スレッドで
//!   実行し、`T` 秒でタイムアウトしなければ諦めてその候補全体をスキップする**
//!   (過去にFFO問題の完全読みで長時間ハングした事故の再発防止。1手ごとではなく
//!   候補1件ごとの粒度にしているのは、スレッド生成コストを抑えつつ、
//!   タスク仕様が例示する「1問あたりTTL秒」という粒度とも一致するため)。
//!   加えて全体でも `O` 秒を超えたら以降の候補の処理を打ち切り、そこまでの
//!   結果を出力する(全体のハング防止の保険)。
//!   標準出力にJSON配列
//!   `[{id, board, sideToMove, empties, moves: [{square, valueForMover,
//!   shallowEval, cornerSacrificeCandidate, stableGain}, ...]}, ...]`
//!   (タイムアウトした候補は含まれない)を出す。

use engine::bitboard::{Board, Side};
use engine::endgame::solve_exact;
use engine::eval::{evaluate_for, stable_count};
use engine::tt::TranspositionTable;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "candidates" => cmd_candidates(&args[2..]),
        "evaluate" => cmd_evaluate(&args[2..]),
        _ => {
            eprintln!(
                "usage:\n  puzzlegen candidates --min-empties N --max-empties M --target-per-empties K --seed S\n  puzzlegen evaluate --per-candidate-timeout-secs T --overall-timeout-secs O   (JSON配列を標準入力から読む)"
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

/// `eval_cli.rs` の `Rng` と同一実装(依存クレートを増やさないための、
/// テスト専用の最小限xorshift64*)。既存バイナリを直接importできないため
/// 複製している(小さい実装であり、`eval_cli.rs` 自体には手を加えない方針)。
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

    fn gen_range(&mut self, n: u32) -> u32 {
        (self.next_u64() % n as u64) as u32
    }

    /// `[0, 1000)` の一様乱数(確率判定用。浮動小数の再現性の揺れを避けるため
    /// 整数の千分率で扱う)。
    fn gen_permille(&mut self) -> u32 {
        self.gen_range(1000)
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
        other => panic!("invalid sideToMove: {other}"),
    }
}

fn square_to_notation(square: u32) -> String {
    let file = (square % 8) as u8;
    let rank1 = (square / 8) + 1;
    format!("{}{}", (b'a' + file) as char, rank1)
}

fn moves_of(legal: u64) -> Vec<u64> {
    let mut moves = Vec::with_capacity(legal.count_ones() as usize);
    let mut rem = legal;
    while rem != 0 {
        let lsb = rem & rem.wrapping_neg();
        moves.push(lsb);
        rem &= rem - 1;
    }
    moves
}

/// 隅に隣接する12マス(X打ち4マス+C打ち8マス)それぞれが、どの隅に対応するか。
/// タスク仕様の「隅の犠牲」タグ簡易判定(正解手が、対応する隅がまだ空いている
/// 隅隣接マスであるケース)に使う。
const CORNER_ADJACENT: [(u32, u32); 12] = [
    (1, 0),
    (8, 0),
    (9, 0), // b1, a2, b2 -> a1
    (6, 7),
    (15, 7),
    (14, 7), // g1, h2, g2 -> h1
    (48, 56),
    (57, 56),
    (49, 56), // a7, b8, b7 -> a8
    (55, 63),
    (62, 63),
    (54, 63), // h7, g8, g7 -> h8
];

/// `square` が隅隣接マスであり、かつ対応する隅がまだ空いていれば `true`。
/// (「意図的な隅の犠牲」の機械判定の元になる事実。実際に犠牲として妥当かの
/// 最終判断はTS側の `deriveTags` に委ねる。)
fn corner_sacrifice_candidate(board_before: &Board, square: u32) -> bool {
    for &(sq, corner) in CORNER_ADJACENT.iter() {
        if sq == square {
            let occupied = board_before.black | board_before.white;
            return occupied & (1u64 << corner) == 0;
        }
    }
    false
}

/// 空きマス数が `[min_empties, max_empties]` の候補局面を、自己対戦で
/// 空きマス数ごとに最大 `target_per_empties` 個ずつ集める。
fn cmd_candidates(args: &[String]) {
    let min_empties = get_arg_u32(args, "--min-empties", None);
    let max_empties = get_arg_u32(args, "--max-empties", None);
    let target_per_empties = get_arg_u32(args, "--target-per-empties", None);
    let seed = get_arg_u32(args, "--seed", None) as u64;
    let target_total = (max_empties - min_empties + 1) * target_per_empties;
    let max_games =
        get_arg_u32(args, "--max-games", Some(target_total.saturating_mul(30) + 500)) as u64;

    let mut collected: HashMap<u32, u32> = (min_empties..=max_empties).map(|e| (e, 0)).collect();
    let mut seen: HashSet<(u64, u64, u8)> = HashSet::new();
    let mut results: Vec<Value> = Vec::new();
    let mut produced_total = 0u32;
    let mut game_idx: u64 = 0;
    let mut produced_id = 0u32;

    while produced_total < target_total && game_idx < max_games {
        let mut rng = Rng::new(seed.wrapping_add(game_idx * 1_000_003 + 7));
        game_idx += 1;

        let mut board = Board::initial();
        let mut side = Side::Black;

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
                let bucket = collected.get_mut(&empties).unwrap();
                if *bucket < target_per_empties {
                    let key = (board.black, board.white, side as u8);
                    if seen.insert(key) {
                        *bucket += 1;
                        produced_total += 1;
                        produced_id += 1;
                        results.push(json!({
                            "id": format!("tsume-{}", produced_id),
                            "board": board_to_obf(&board),
                            "sideToMove": side_name(side),
                            "empties": empties,
                        }));
                    }
                }
            }
            if empties <= min_empties {
                break;
            }

            let legal = board.legal_moves(side);
            let moves = moves_of(legal);

            let pick = if rng.gen_permille() < 600 {
                // 6割: 直後の静的評価(着手側視点)が最大の手を選ぶ(半グリーディ)。
                *moves
                    .iter()
                    .max_by_key(|&&mv| evaluate_for(&board.apply_move(side, mv), side))
                    .unwrap()
            } else {
                moves[rng.gen_range(moves.len() as u32) as usize]
            };

            board = board.apply_move(side, pick);
            side = side.opposite();
        }
    }

    if produced_total < target_total {
        eprintln!(
            "[puzzlegen candidates] warning: only produced {} of {} requested positions ({} games played)",
            produced_total, target_total, game_idx
        );
    }
    eprintln!(
        "[puzzlegen candidates] produced {} positions across {} empties-buckets ({} games played)",
        produced_total,
        max_empties - min_empties + 1,
        game_idx
    );

    println!("{}", Value::Array(results));
}

struct MoveRaw {
    square: String,
    value_for_mover: i32,
    shallow_eval: i32,
    corner_sacrifice_candidate: bool,
    stable_gain: bool,
}

/// 1候補局面の全合法手を完全読みする(タイムアウトする呼び出し元スレッドから
/// 独立して動かすための本体)。
fn evaluate_candidate(board: Board, side: Side) -> Vec<MoveRaw> {
    let mut tt = TranspositionTable::new(16);
    let legal = board.legal_moves(side);
    let moves = moves_of(legal);

    let stable_before = stable_count(&board, side);

    moves
        .into_iter()
        .map(|mv| {
            let next_board = board.apply_move(side, mv);
            // `solve_exact` は「渡した手番に合法手が無ければ内部で自動的に
            // パスして相手番の探索に切り替える」ため(`endgame.rs` の
            // `negamax` 参照)、ここで着手後の手番のパス有無を個別に
            // 判定する必要はなく、常に「相手番から見た完全読み値を符号反転」
            // するだけで着手側から見た正しい最終石差が得られる。
            let value_for_mover = -solve_exact(&next_board, side.opposite(), &mut tt);
            let shallow_eval = evaluate_for(&next_board, side);
            let square = mv.trailing_zeros();
            let stable_after = stable_count(&next_board, side);

            MoveRaw {
                square: square_to_notation(square),
                value_for_mover,
                shallow_eval,
                corner_sacrifice_candidate: corner_sacrifice_candidate(&board, square),
                stable_gain: stable_after > stable_before,
            }
        })
        .collect()
}

/// 1候補局面ぶんの、`evaluate_candidate` に渡す前のパース済み入力。
struct ParsedCandidate {
    id: String,
    board_str: String,
    side_str: String,
    board: Board,
    side: Side,
}

fn cmd_evaluate(args: &[String]) {
    let per_candidate_timeout_secs = get_arg_u32(args, "--per-candidate-timeout-secs", Some(20));
    let overall_timeout_secs = get_arg_u32(args, "--overall-timeout-secs", Some(1800));
    // 同時に評価する候補数(スレッド数)。空き20近辺の完全読みは1件あたり
    // 数十秒かかることがあり、逐次実行だと候補数×最大タイムアウト秒に
    // 近い時間がかかってしまう。マシンの論理コア数を目安に複数候補を
    // 並列で完全読みすることで、総所要時間を大きく短縮する
    // (1候補=1スレッドなので、`evaluate_candidate`内部の探索自体は
    // 逐次のまま。`solve_exact`自体を並列化するわけではない)。
    let workers = get_arg_u32(args, "--workers", Some(8)).max(1) as usize;

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let candidates: Value = serde_json::from_str(&input).expect("invalid input JSON");
    let arr = candidates.as_array().expect("expected a JSON array");

    let run_start = Instant::now();
    let overall_budget = Duration::from_secs(overall_timeout_secs as u64);
    let per_candidate_budget = Duration::from_secs(per_candidate_timeout_secs as u64);

    let parsed: Vec<ParsedCandidate> = arr
        .iter()
        .map(|cand| {
            let id = cand
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            let board_str = cand
                .get("board")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let side_str = cand
                .get("sideToMove")
                .and_then(Value::as_str)
                .unwrap_or("black")
                .to_string();
            let board = obf_to_board(&board_str);
            let side = parse_side(&side_str);
            ParsedCandidate {
                id,
                board_str,
                side_str,
                board,
                side,
            }
        })
        .collect();

    let mut out: Vec<Value> = Vec::new();
    let mut timed_out = 0u32;
    let mut processed = 0u32;
    let mut stopped_early = false;

    'outer: for chunk in parsed.chunks(workers) {
        if run_start.elapsed() >= overall_budget {
            stopped_early = true;
            break;
        }

        // チャンク内の各候補を同時に別スレッドへ投入する。全スレッドの
        // 開始時刻をほぼ揃えた上で、候補ごとの `rx` に対して
        // `per_candidate_budget` を「このチャンクの開始時刻からの絶対期限」
        // として個別に適用する(逐次に `recv_timeout` を呼んでも、後続の
        // 受信待ちが先行スレッドの実行を妨げることはない。スレッドは
        // 独立に走っているため)。
        let chunk_start = Instant::now();
        let mut receivers = Vec::with_capacity(chunk.len());
        for c in chunk {
            let board = c.board;
            let side = c.side;
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                let result = evaluate_candidate(board, side);
                // 受信側が既にタイムアウトで諦めていれば send は失敗するが、
                // それ自体はエラーとして扱わなくてよい(スレッドはそのまま
                // 終了するだけで、プロセス終了時にOSに回収される)。
                let _ = tx.send(result);
            });
            receivers.push(rx);
        }

        for (c, rx) in chunk.iter().zip(receivers.into_iter()) {
            if run_start.elapsed() >= overall_budget {
                stopped_early = true;
                break 'outer;
            }
            processed += 1;
            let empties = c.board.empty_count();
            let deadline = chunk_start + per_candidate_budget;
            let remaining = deadline.saturating_duration_since(Instant::now());

            match rx.recv_timeout(remaining) {
                Ok(move_results) => {
                    let moves_json: Vec<Value> = move_results
                        .iter()
                        .map(|m| {
                            json!({
                                "square": m.square,
                                "valueForMover": m.value_for_mover,
                                "shallowEval": m.shallow_eval,
                                "cornerSacrificeCandidate": m.corner_sacrifice_candidate,
                                "stableGain": m.stable_gain,
                            })
                        })
                        .collect();
                    out.push(json!({
                        "id": c.id,
                        "board": c.board_str,
                        "sideToMove": c.side_str,
                        "empties": empties,
                        "moves": moves_json,
                    }));
                }
                Err(_) => {
                    timed_out += 1;
                    eprintln!(
                        "[puzzlegen evaluate] timeout after {}s: id={} empties={} (skipped)",
                        per_candidate_timeout_secs, c.id, empties
                    );
                }
            }
        }
    }

    if stopped_early {
        eprintln!(
            "[puzzlegen evaluate] overall timeout ({}s) reached; stopped after {} of {} candidates",
            overall_timeout_secs,
            processed,
            arr.len()
        );
    }
    eprintln!(
        "[puzzlegen evaluate] processed {} candidates ({} timed out, {} evaluated) in {:?}",
        processed,
        timed_out,
        out.len(),
        run_start.elapsed()
    );

    println!("{}", Value::Array(out));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_to_notation_matches_known_squares() {
        assert_eq!(square_to_notation(0), "a1");
        assert_eq!(square_to_notation(7), "h1");
        assert_eq!(square_to_notation(56), "a8");
        assert_eq!(square_to_notation(63), "h8");
        assert_eq!(square_to_notation(27), "d4");
    }

    #[test]
    fn obf_round_trips_through_board_to_obf() {
        let board = Board::initial();
        let obf = board_to_obf(&board);
        let parsed = obf_to_board(&obf);
        assert_eq!(parsed, board);
    }

    #[test]
    fn corner_sacrifice_candidate_detects_x_and_c_squares_only_when_corner_is_empty() {
        let empty = Board { black: 0, white: 0 };
        // b2 (idx9) は a1(idx0) に隣接するX打ちマス。隅が空いていれば true。
        assert!(corner_sacrifice_candidate(&empty, 9));
        // d3 (idx19) はどの隅にも隣接しない。
        assert!(!corner_sacrifice_candidate(&empty, 19));

        // a1に既に石があれば、隣接するb2はもう「隅の犠牲」候補ではない。
        let corner_taken = Board { black: 1u64 << 0, white: 0 };
        assert!(!corner_sacrifice_candidate(&corner_taken, 9));
    }

    /// `endgame.rs` のテストにある `play_until_empties` と同じ方針
    /// (常に最初の合法手を選ぶ決定的な手順で、空きマス数が `target_empties`
    /// 以下になるまで進める)。**空きマスが多い局面で `solve_exact`/
    /// `evaluate_candidate` を呼ぶと現実的な時間で終わらない
    /// (本タスクが警告する「長時間ハング」そのものになる)ため、
    /// このテスト専用に、完全読みが実用的な空きマス数まで確実に
    /// 進めてから評価する。**
    fn play_until_empties(target_empties: u32) -> (Board, Side) {
        let mut board = Board::initial();
        let mut side = Side::Black;
        loop {
            if board.empty_count() <= target_empties || board.is_terminal() {
                return (board, side);
            }
            let legal = board.legal_moves(side);
            if legal == 0 {
                side = side.opposite();
                continue;
            }
            let mv = legal & legal.wrapping_neg();
            board = board.apply_move(side, mv);
            side = side.opposite();
        }
    }

    #[test]
    fn evaluate_candidate_value_for_mover_matches_direct_solve_exact_computation() {
        // 空きマス8程度まで進めた小さな局面で、`evaluate_candidate` が返す
        // `value_for_mover` が、独立に計算した
        // `-solve_exact(next_board, opponent, tt)` と一致することを確認する
        // (`evaluate_candidate` 内部の符号規約が正しいことの直接検証)。
        let (small_board, small_side) = play_until_empties(8);
        assert!(
            small_board.empty_count() <= 8,
            "test setup should reach a low-empties position"
        );

        let small_results = evaluate_candidate(small_board, small_side);
        assert!(!small_results.is_empty());
        for res in &small_results {
            // `square` から着手ビットへ逆変換して、独立に同じ値を再計算する。
            let file = (res.square.as_bytes()[0] - b'a') as u32;
            let rank1 = (res.square.as_bytes()[1] - b'1') as u32;
            let idx = rank1 * 8 + file;
            let mv_bit = 1u64 << idx;
            let next_board = small_board.apply_move(small_side, mv_bit);
            let mut tt = TranspositionTable::new(1);
            let expected = -solve_exact(&next_board, small_side.opposite(), &mut tt);
            assert_eq!(
                res.value_for_mover, expected,
                "square={} value_for_mover mismatch",
                res.square
            );
        }
    }
}

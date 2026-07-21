//! T178: 自己対戦データ生成パイロット。
//!
//! 自前エンジン(v6+深さ12+MPC t=1.0)同士を対局させ、各局面の探索値
//! (mover視点discDiff)を`--simple-corpus`が読める形式
//! (`train/src/simple_corpus.rs`、`<64文字盤面> <スコア>`、
//! `X`=手番側own/`O`=相手opponent/`-`=空き、1行1レコード)で出力する。
//!
//! # 決定性
//!
//! 同一`--seed`・同一設定であれば、対局の乱数散らし(序盤`opening-plies`手を
//! 一様ランダムに選ぶ)を含めて完全に同一の出力が再現される。
//! `time_ms: None`(壁時計に基づく打ち切りを一切使わない)ことがこの決定性の
//! 前提であり、本バイナリは意図的に`--time-ms`のようなオプションを持たない。
//!
//! # 長時間実行・resume
//!
//! `--games N`は「N局に達するまで」の目標局数(累積、resumeで再指定してよい)。
//! `--checkpoint PATH`に完了局数と設定のfingerprintを保存し、起動時に既存の
//! checkpointと設定が一致するか検証する(不一致ならエラー終了、黙って別条件の
//! データを混ぜない)。出力ファイル(`--out`)は1局完了ごとに追記
//! (その局の全行をまとめて1回の書き込みで追記、既存内容は変更しない)。
//! 進捗はstderrに1局ごとに出力する。
//!
//! # ラベル
//!
//! 各局面で`search::search_with_eval_with_policy_and_margin_t`
//! (T176で追加、`mpc_margin_t`で本番既定t=1.5から積極化できる)を呼び、
//! 返ってきた評価値をそのままその局面のラベルとする。序盤の
//! `opening-plies`手の間は、この探索結果の`best_move`ではなく一様ランダムに
//! 選んだ合法手を実際の着手として採用する(「着手決定と同じ探索を流用して
//! ラベルを取る」設計だが、序盤は着手選択だけ乱数に差し替える。ラベル自体は
//! 常に実際の探索値)。

use engine::bitboard::{Board, Side};
use engine::pattern_eval::PatternWeights;
use engine::search::{self, SearchLimit, SearchPolicy};
use engine::tt::TranspositionTable;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// `eval_cli.rs::Rng`・`search.rs`テストの`EtcTestRng`と同じSplitMix64ベースの
/// 疑似乱数生成器。別クレート扱いのbinターゲットであり共有できないため、
/// この最小限の実装(15行程度)を独立して複製している(理由も同じ: 隣接する
/// seed同士でも初期状態を十分に分散させるため、単純な`seed*定数`ではなく
/// SplitMix64の終段混合関数でシード初期化する)。
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

    /// `[0, bound)`の一様乱数(`bound > 0`)。
    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn get_arg_or(args: &[String], name: &str, default: &str) -> String {
    get_arg(args, name).unwrap_or_else(|| default.to_string())
}

fn fingerprint(bytes: &[u8]) -> String {
    // T156a由来のFNV-1a 64bit(`calibrate_mpc.rs::fingerprint`と同じ式、
    // 別クレート扱いのbinターゲットのため独立複製)。
    let mut hash: u64 = 0xCBF2_9CE4_8422_2325;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("fnv1a64:{hash:016x}:{}", bytes.len())
}

/// `board`(実際の黒白ビットボード)を`mover`視点(`X`=own/`O`=opponent/`-`=空き)
/// の64文字文字列へ変換する。`train/src/simple_corpus.rs`の`parse_board`と
/// 対になる書き出し側。
fn encode_mover_relative(board: &Board, mover: Side) -> String {
    let (own, opp) = match mover {
        Side::Black => (board.black, board.white),
        Side::White => (board.white, board.black),
    };
    let mut s = String::with_capacity(64);
    for i in 0..64u8 {
        let bit = 1u64 << i;
        if own & bit != 0 {
            s.push('X');
        } else if opp & bit != 0 {
            s.push('O');
        } else {
            s.push('-');
        }
    }
    s
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GenConfig {
    seed: u64,
    weights_fingerprint: String,
    depth: u8,
    exact_from_empties: u8,
    unlimited_exact_empties: u8,
    exact_quota_percent: u8,
    /// マージン係数tを千分率の整数で保持する(`f32`は`Eq`を導出できないため。
    /// `calibrate_mpc.rs::GateConfig`と同じ理由・同じ表現)。
    mpc_margin_t_permille: u32,
    tt_mb: usize,
    opening_plies_min: u32,
    opening_plies_max: u32,
    /// 空きマス数が`unlimited_exact_empties`超の(depth固定探索)ノード上限。
    /// `time_ms`を使わない(決定性維持のため)代わりの安全弁: 上限なし
    /// (`None`)だと稀な局面で探索が極端に長引くことが実測で判明したため
    /// (パイロット準備中に1局が13分超で完走せず、ノード上限追加で解消した)、
    /// 決定的な(壁時計に依存しない)ノード数ベースの上限を必ず設ける。
    max_nodes_midgame: u64,
    /// 空きマス数が`unlimited_exact_empties`以下のときのノード上限。
    /// 完全読みがほぼ確実に完走する程度に大きく設定する
    /// (`max_nodes_midgame`より大きい値を想定)。
    max_nodes_exact: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    schema_version: u32,
    config: GenConfig,
    games_completed: u64,
    positions_written: u64,
}

fn load_checkpoint(path: &Path) -> Option<Checkpoint> {
    if !path.exists() {
        return None;
    }
    let mut text = String::new();
    File::open(path)
        .and_then(|mut f| f.read_to_string(&mut text))
        .unwrap_or_else(|e| panic!("failed to read checkpoint {}: {e}", path.display()));
    Some(serde_json::from_str(&text).unwrap_or_else(|e| panic!("invalid checkpoint JSON: {e}")))
}

fn write_checkpoint_atomic(path: &Path, checkpoint: &Checkpoint) {
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(checkpoint).expect("serialize checkpoint");
    fs::write(&temp, text).unwrap_or_else(|e| panic!("failed to write {}: {e}", temp.display()));
    fs::rename(&temp, path).unwrap_or_else(|e| panic!("failed to rename checkpoint: {e}"));
}

/// 1局を対局し、(このゲームで書き出す行のリスト, 実際に打った半手数) を返す。
fn play_one_game(
    game_seed: u64,
    config: &GenConfig,
    weights: &PatternWeights,
) -> Vec<String> {
    let mut rng = Rng::new(game_seed);
    let opening_range = config.opening_plies_max - config.opening_plies_min + 1;
    let opening_plies = config.opening_plies_min + rng.below(opening_range as u64) as u32;

    let policy = SearchPolicy {
        enable_history: true,
        enable_aspiration: true,
        enable_mpc: true,
    };
    let mpc_margin_t = config.mpc_margin_t_permille as f32 / 1000.0;

    let mut board = Board::initial();
    let mut side = Side::Black;
    let mut tt = TranspositionTable::new(config.tt_mb);
    let mut lines = Vec::new();
    let mut ply: u32 = 0;

    loop {
        if board.is_terminal() {
            break;
        }
        if !board.has_legal_move(side) {
            side = side.opposite();
            continue;
        }

        let empties = board.empty_count();
        let use_unlimited_exact = empties <= config.unlimited_exact_empties as u32;
        let (limit, max_nodes) = if use_unlimited_exact {
            (
                SearchLimit {
                    max_depth: config.unlimited_exact_empties,
                    time_ms: None,
                    exact_from_empties: config.unlimited_exact_empties,
                },
                Some(config.max_nodes_exact),
            )
        } else {
            (
                SearchLimit {
                    max_depth: config.depth,
                    time_ms: None,
                    exact_from_empties: config.exact_from_empties,
                },
                Some(config.max_nodes_midgame),
            )
        };

        let result = search::search_with_eval_with_policy_and_margin_t(
            &board,
            side,
            &limit,
            &mut tt,
            Some(weights),
            max_nodes,
            config.exact_quota_percent,
            policy,
            Some(mpc_margin_t),
        );

        let disc_diff = result.score as f32 / 100.0;
        let encoded = encode_mover_relative(&board, side);
        lines.push(format!("{encoded} {disc_diff}"));

        let legal = board.legal_moves(side);
        let mv_bit = if ply < opening_plies {
            // 序盤散らし: 探索のbest_moveではなく一様ランダムな合法手を選ぶ。
            let mut candidates: Vec<u64> = Vec::new();
            let mut remaining = legal;
            while remaining != 0 {
                let lsb = remaining & remaining.wrapping_neg();
                candidates.push(lsb);
                remaining &= remaining - 1;
            }
            candidates[rng.below(candidates.len() as u64) as usize]
        } else {
            match result.best_move {
                Some(mv) => 1u64 << mv,
                // 合法手はあるはずなので通常起きないが、万一探索が手を返さなければ
                // 最下位ビットの合法手にフォールバックする(対局を止めないため)。
                None => legal & legal.wrapping_neg(),
            }
        };

        board = board.apply_move(side, mv_bit);
        side = side.opposite();
        ply += 1;
    }

    lines
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("run") {
        eprintln!(
            "usage: self_play_gen run --seed N --games N --pattern-weights PATH --out PATH \
             --checkpoint PATH [--opening-plies-min 8] [--opening-plies-max 12] [--depth 12] \
             [--exact-from-empties 16] [--unlimited-exact-empties 20] [--mpc-margin-t 1.0] \
             [--exact-quota-percent 60] [--tt-mb 64] [--progress-every 1] \
             [--max-nodes-midgame 100000000] [--max-nodes-exact 500000000]"
        );
        std::process::exit(1);
    }
    let args = &args[1..];

    let seed: u64 = get_arg(args, "--seed")
        .expect("missing --seed")
        .parse()
        .expect("invalid --seed");
    let target_games: u64 = get_arg(args, "--games")
        .expect("missing --games")
        .parse()
        .expect("invalid --games");
    let weights_path = PathBuf::from(get_arg(args, "--pattern-weights").expect("missing --pattern-weights"));
    let out_path = PathBuf::from(get_arg(args, "--out").expect("missing --out"));
    let checkpoint_path =
        PathBuf::from(get_arg(args, "--checkpoint").expect("missing --checkpoint"));
    let opening_plies_min: u32 = get_arg_or(args, "--opening-plies-min", "8").parse().expect("invalid --opening-plies-min");
    let opening_plies_max: u32 = get_arg_or(args, "--opening-plies-max", "12").parse().expect("invalid --opening-plies-max");
    assert!(opening_plies_max >= opening_plies_min, "--opening-plies-max must be >= --opening-plies-min");
    let depth: u8 = get_arg_or(args, "--depth", "12").parse().expect("invalid --depth");
    let exact_from_empties: u8 = get_arg_or(args, "--exact-from-empties", "16").parse().expect("invalid --exact-from-empties");
    let unlimited_exact_empties: u8 = get_arg_or(args, "--unlimited-exact-empties", "20").parse().expect("invalid --unlimited-exact-empties");
    let mpc_margin_t: f32 = get_arg_or(args, "--mpc-margin-t", "1.0").parse().expect("invalid --mpc-margin-t");
    let exact_quota_percent: u8 = get_arg_or(args, "--exact-quota-percent", "60").parse().expect("invalid --exact-quota-percent");
    let tt_mb: usize = get_arg_or(args, "--tt-mb", "64").parse().expect("invalid --tt-mb");
    let progress_every: u64 = get_arg_or(args, "--progress-every", "1").parse().expect("invalid --progress-every");
    // T178: 決定性(壁時計に依存しない)を保ったまま探索時間の上限を設ける
    // ノード数ベースの安全弁(パイロット準備中に上限なしで1局が13分超に
    // なる実測があったため必須)。exact枝は完全読みがほぼ確実に完走する
    // 程度に大きい値、depth固定の中盤探索枝はT175/T176実績のmax_nodesと
    // 同じ値を既定にする。
    let max_nodes_midgame: u64 = get_arg_or(args, "--max-nodes-midgame", "100000000").parse().expect("invalid --max-nodes-midgame");
    let max_nodes_exact: u64 = get_arg_or(args, "--max-nodes-exact", "500000000").parse().expect("invalid --max-nodes-exact");

    if !cfg!(feature = "mpc_enabled") {
        eprintln!("self_play_gen requires a build with --features mpc_enabled (MPC t={{mpc_margin_t}} would otherwise stay OFF)");
        std::process::exit(1);
    }

    let weights_bytes = fs::read(&weights_path)
        .unwrap_or_else(|e| panic!("failed to read pattern weights {}: {e}", weights_path.display()));
    let weights_fingerprint = fingerprint(&weights_bytes);
    let weights = PatternWeights::from_bytes(&weights_bytes).expect("invalid pattern weights");

    let config = GenConfig {
        seed,
        weights_fingerprint,
        depth,
        exact_from_empties,
        unlimited_exact_empties,
        exact_quota_percent,
        mpc_margin_t_permille: (mpc_margin_t * 1000.0).round() as u32,
        tt_mb,
        opening_plies_min,
        opening_plies_max,
        max_nodes_midgame,
        max_nodes_exact,
    };

    let mut checkpoint = match load_checkpoint(&checkpoint_path) {
        Some(existing) => {
            assert_eq!(
                existing.schema_version, 1,
                "checkpoint schema mismatch"
            );
            assert_eq!(
                existing.config, config,
                "checkpoint config mismatch: existing run used different settings; refusing to \
                 mix data generated under different conditions into the same output file"
            );
            existing
        }
        None => Checkpoint {
            schema_version: 1,
            config: config.clone(),
            games_completed: 0,
            positions_written: 0,
        },
    };

    if checkpoint.games_completed >= target_games {
        eprintln!(
            "[self_play_gen] already at or past target: games_completed={} target={target_games}",
            checkpoint.games_completed
        );
        return;
    }

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut out_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&out_path)
        .unwrap_or_else(|e| panic!("failed to open {} for append: {e}", out_path.display()));

    let start = Instant::now();
    let start_games = checkpoint.games_completed;
    for game_index in checkpoint.games_completed..target_games {
        // T156a/eval_cli.rs::Rng::newと同じ理由でSplitMix64混合済みのseedを渡す
        // ため、`game_seed`自体を単純加算するだけでよい(`Rng::new`内部で
        // さらに混合される)。
        let game_seed = seed.wrapping_add(game_index);
        let lines = play_one_game(game_seed, &config, &weights);

        let mut buffer = String::new();
        for line in &lines {
            buffer.push_str(line);
            buffer.push('\n');
        }
        out_file
            .write_all(buffer.as_bytes())
            .unwrap_or_else(|e| panic!("failed to append to {}: {e}", out_path.display()));
        out_file.flush().expect("failed to flush output file");

        checkpoint.games_completed = game_index + 1;
        checkpoint.positions_written += lines.len() as u64;
        write_checkpoint_atomic(&checkpoint_path, &checkpoint);

        if (game_index - start_games + 1) % progress_every == 0 || game_index + 1 == target_games {
            let elapsed = start.elapsed();
            let games_done_this_run = game_index - start_games + 1;
            let rate_games_per_sec = games_done_this_run as f64 / elapsed.as_secs_f64().max(1e-6);
            eprintln!(
                "[self_play_gen] game={}/{target_games} (this run: {games_done_this_run}) \
                 positions_total={} elapsed={:?} rate={:.3} games/s ({:.1} games/hour)",
                checkpoint.games_completed,
                checkpoint.positions_written,
                elapsed,
                rate_games_per_sec,
                rate_games_per_sec * 3600.0,
            );
        }
    }

    eprintln!(
        "[self_play_gen] done: games_completed={} positions_written={}",
        checkpoint.games_completed, checkpoint.positions_written
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_deterministic_for_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn rng_differs_for_different_seeds() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        let sequence_a: Vec<u64> = (0..10).map(|_| a.next_u64()).collect();
        let sequence_b: Vec<u64> = (0..10).map(|_| b.next_u64()).collect();
        assert_ne!(sequence_a, sequence_b);
    }

    #[test]
    fn encode_mover_relative_matches_simple_corpus_convention() {
        // train/src/simple_corpus.rs::parse_boardの逆変換であることを確認する:
        // mover=Blackなら通常のX=black/O=white表現とそのまま一致するはず。
        let board = Board::initial();
        let encoded = encode_mover_relative(&board, Side::Black);
        assert_eq!(encoded.len(), 64);
        // 初期局面: d4(27)=White, e4(28)=Black, d5(35)=Black, e5(36)=White
        let chars: Vec<char> = encoded.chars().collect();
        assert_eq!(chars[27], 'O');
        assert_eq!(chars[28], 'X');
        assert_eq!(chars[35], 'X');
        assert_eq!(chars[36], 'O');
        // mover=Whiteなら自石/相手石が入れ替わる(own=white, opp=black)。
        let encoded_white = encode_mover_relative(&board, Side::White);
        let chars_white: Vec<char> = encoded_white.chars().collect();
        assert_eq!(chars_white[27], 'X');
        assert_eq!(chars_white[28], 'O');
    }

    fn fast_test_config(weights_fingerprint: String) -> GenConfig {
        // T178: 決定性テスト専用の軽量設定(浅い深さ+小さい完全読み閾値)。
        // 本番設定(depth=12・unlimited_exact_empties=20)そのままでは
        // 1局あたり数十秒かかりテストとして重すぎるため、深さと空きマス閾値を
        // 下げて数秒で完走するようにする(探索ロジック自体は本番と共通)。
        GenConfig {
            seed: 0, // play_one_gameは呼び出し側でgame_seedを渡すため未使用
            weights_fingerprint,
            depth: 4,
            exact_from_empties: 8,
            unlimited_exact_empties: 10,
            exact_quota_percent: 60,
            mpc_margin_t_permille: 1000,
            tt_mb: 4,
            opening_plies_min: 4,
            opening_plies_max: 6,
            max_nodes_midgame: 2_000_000,
            max_nodes_exact: 5_000_000,
        }
    }

    #[test]
    fn play_one_game_is_deterministic_for_the_same_seed_and_config() {
        let weights_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../train/weights/pattern_v6.bin");
        let bytes = std::fs::read(weights_path).expect("failed to read pattern_v6.bin");
        let weights = PatternWeights::from_bytes(&bytes).expect("invalid pattern weights");
        let config = fast_test_config(fingerprint(&bytes));

        let first = play_one_game(12345, &config, &weights);
        let second = play_one_game(12345, &config, &weights);
        assert_eq!(first, second, "same seed+config must reproduce identical output lines");
        assert!(!first.is_empty(), "a full game should produce at least one labeled position");

        // 各行が simple_corpus.rs の想定形式(64文字盤面 + 空白 + スコア)であることを確認する。
        for line in &first {
            let (board_text, score_text) = line.split_once(' ').expect("missing score field");
            assert_eq!(board_text.len(), 64);
            score_text.parse::<f32>().expect("score must parse as f32");
        }
    }

    #[test]
    fn play_one_game_differs_for_different_seeds() {
        let weights_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../train/weights/pattern_v6.bin");
        let bytes = std::fs::read(weights_path).expect("failed to read pattern_v6.bin");
        let weights = PatternWeights::from_bytes(&bytes).expect("invalid pattern weights");
        let config = fast_test_config(fingerprint(&bytes));

        let a = play_one_game(1, &config, &weights);
        let b = play_one_game(2, &config, &weights);
        assert_ne!(a, b, "different seeds should (almost certainly) diverge via opening randomization");
    }
}

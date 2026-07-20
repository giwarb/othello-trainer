//! T150: WTHOR棋譜(`train/data/WTH_*.wtb`)から頻出序盤進行(定石ライン候補)を
//! 抽出し、`app/src/joseki/types.ts` の `RawJosekiLine` 互換形式(+出現局数
//! `gameCount`)で `bookgen/wthor-lines.json` に書き出すツール。
//!
//! # 目的・位置づけ
//!
//! 既存の定石DB(`bookgen/joseki-research.json`、T016系の35→112ライン)は
//! 日本語オセロ戦術解説サイトからの手作業収集データであり、着手頻度の情報を
//! 持たない。本ツールはWTHOR実戦棋譜(2000〜2024年、74,024局)から機械的に
//! 頻出進行を抽出し、頻度情報(`gameCount`)付きの候補ラインを生成する
//! (T151でEdax評価値によるフィルタを経て初めて `app/public/joseki.json` に
//! 反映される。本ツール自体は公開データを一切変更しない)。
//!
//! # 正規化(初手をf5に写す)
//!
//! 標準オセロの初期局面で黒が打てる手は `d3`/`c4`/`f5`/`e6` の4通りしかない。
//! `app/src/joseki/normalize.ts` と同じ流儀で、初期局面を不動点に保つ4つの
//! 色保存対称変換(恒等・180°回転・主対角線反転・反対角線反転。それぞれ
//! `engine::patterns::apply_symmetry` のインデックス0/2/6/7に対応)のうち、
//! 実際の初手を`f5`に写すものを選び、その対局の全着手(先頭`--max-depth`手まで)
//! に同じ変換を適用する。初期局面はこれら4変換の不動点であり、Othelloの
//! 着手・裏返しルールはD4対称変換と可換であるため、「初手だけ変換を決めて
//! 以降の全着手に同じ変換をそのまま適用する」ことと「1手ごとに盤面を
//! 正規化しながら進める」ことは同じ結果になる(`normalize.ts`の設計コメント、
//! および本ファイルの`normalizing_alternate_basis_game_recovers_canonical_tora_line`
//! テストが実際に検証している)。
//!
//! # 抽出アルゴリズム
//!
//! 1. 全対局を正規化し、先頭`--max-depth`手までの着手列を接頭辞木(トライ)に
//!    挿入する(木の各ノード = ある着手列プレフィックスであり、`count`は
//!    そのプレフィックスを持つ対局数)。
//! 2. 木を根から辿り、`count >= --min-games` のノードだけを残す。
//! 3. 残った木の葉(それ以上`count >= --min-games`な子を持たないノード、または
//!    深さが`--max-depth`に達したノード)を1本のラインとして列挙する。
//!    分岐点(複数の子が閾値を満たす)自体はライン化しない(既存の
//!    `bookgen/joseki-research.json`と同じ「末端だけを列挙し、共有プレフィックスは
//!    DAG構築側(`buildDb.ts`)で合流させる」設計)。
//!
//! # 決定性
//!
//! `.wtb`ファイルの列挙をソートし、トライの子は`BTreeMap`(着手マス番号で
//! 昇順)を使うため、同一入力に対して常に同一の出力(ライン順序・
//! 自動命名インデックスとも)になる。
//!
//! # 使い方
//! ```text
//! cargo run -p train --release --bin wthor_lines -- \
//!   --data-dir train/data --years 2000-2024 --max-depth 16 --min-games 100 \
//!   --existing-lines bookgen/joseki-research.json --out bookgen/wthor-lines.json
//! ```

use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use engine::patterns::apply_symmetry;
use serde_json::{json, Value};
use train::wthor;

const MAX_DEPTH_DEFAULT: usize = 16;
const MIN_GAMES_DEFAULT: u64 = 100;

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

/// 初期局面からの黒の合法な初手(`d3`=19, `c4`=26, `f5`=37, `e6`=44。
/// `index = rank0*8+file`規約)を、その手を`f5`(37)に写す色保存対称変換
/// (`engine::patterns::apply_symmetry`のインデックス)に対応付ける。
/// `normalize.ts`の`FIRST_MOVE_TO_OP`と同じ対応関係(0=identity, 2=rot180,
/// 6=flipDiag(転置), 7=flipAntiDiag(反転転置))。
fn op_for_first_move(square: u8) -> Option<usize> {
    match square {
        37 => Some(0), // f5 -> identity
        19 => Some(7), // d3 -> flipAntiDiag
        26 => Some(2), // c4 -> rot180
        44 => Some(6), // e6 -> flipDiag
        _ => None,
    }
}

/// 着手列プレフィックスの接頭辞木(トライ)。各ノードは「ここまでの
/// (正規化後の)着手列」を表し、`count`はそのプレフィックスを持つ対局数。
#[derive(Debug, Default)]
struct TrieNode {
    count: u64,
    children: BTreeMap<u8, TrieNode>,
}

impl TrieNode {
    fn insert(&mut self, moves: &[u8]) {
        self.count += 1;
        if let Some((&head, tail)) = moves.split_first() {
            self.children.entry(head).or_default().insert(tail);
        }
    }

    /// 与えられた着手列をたどれるだけ辿り、末尾まで到達できればそのノードの
    /// `count`(=WTHORデータ中の出現局数)を返す。既存ラインとの重複分析用。
    fn lookup(&self, moves: &[u8]) -> Option<u64> {
        match moves.split_first() {
            None => Some(self.count),
            Some((&head, tail)) => self.children.get(&head).and_then(|c| c.lookup(tail)),
        }
    }
}

#[derive(Debug, Clone)]
struct EmittedLine {
    moves: Vec<u8>,
    depth: usize,
    game_count: u64,
}

/// 木を根から辿り、`count >= min_games` の葉(それ以上閾値を満たす子を
/// 持たないノード)をラインとして`out`に集める。`total_qualifying_nodes`には
/// 閾値を満たした(葉・分岐点いずれも含む)ノード総数を積算する。
fn collect_lines(
    node: &TrieNode,
    path: &mut Vec<u8>,
    min_games: u64,
    out: &mut Vec<EmittedLine>,
    total_qualifying_nodes: &mut u64,
) {
    for (&mv, child) in node.children.iter() {
        if child.count < min_games {
            continue;
        }
        *total_qualifying_nodes += 1;
        path.push(mv);
        let qualifying_children = child.children.values().filter(|c| c.count >= min_games).count();
        if qualifying_children == 0 {
            out.push(EmittedLine {
                moves: path.clone(),
                depth: path.len(),
                game_count: child.count,
            });
        } else {
            collect_lines(child, path, min_games, out, total_qualifying_nodes);
        }
        path.pop();
    }
}

/// `"a1"`〜`"h8"`記法をマス番号(0..63、`index = rank0*8+file`)に変換する。
fn notation_to_square(notation: &str) -> u8 {
    let bytes = notation.as_bytes();
    let file = bytes[0] - b'a';
    let rank = bytes[1] - b'1';
    rank * 8 + file
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let data_dir = get_arg(&args, "--data-dir").unwrap_or_else(|| "train/data".to_string());
    let years_spec = get_arg(&args, "--years").unwrap_or_else(|| "2000-2024".to_string());
    let years: HashSet<u32> = parse_years(&years_spec).into_iter().collect();
    let max_depth: usize = get_arg(&args, "--max-depth")
        .map(|v| v.parse().expect("invalid --max-depth"))
        .unwrap_or(MAX_DEPTH_DEFAULT);
    let min_games: u64 = get_arg(&args, "--min-games")
        .map(|v| v.parse().expect("invalid --min-games"))
        .unwrap_or(MIN_GAMES_DEFAULT);
    let existing_lines_path = get_arg(&args, "--existing-lines")
        .unwrap_or_else(|| "bookgen/joseki-research.json".to_string());
    let out_path = get_arg(&args, "--out").unwrap_or_else(|| "bookgen/wthor-lines.json".to_string());

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

    let mut root = TrieNode::default();
    let mut total_games_scanned: u64 = 0;
    let mut total_games_used: u64 = 0;
    let mut invalid_games_skipped: u64 = 0;
    let mut empty_games_skipped: u64 = 0;
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

        for game in &parsed.games {
            total_games_scanned += 1;
            if game.moves.is_empty() {
                empty_games_skipped += 1;
                continue;
            }
            if wthor::replay(&game.moves).is_err() {
                invalid_games_skipped += 1;
                continue;
            }
            let first = game.moves[0];
            let sym = match op_for_first_move(first) {
                Some(s) => s,
                // replay()がOkである以上、初手は必ずd3/c4/f5/e6のいずれかのはず。
                // 防御的に(理論上到達しない)スキップとして扱う。
                None => {
                    invalid_games_skipped += 1;
                    continue;
                }
            };

            let take = max_depth.min(game.moves.len());
            let normalized: Vec<u8> = game.moves[..take]
                .iter()
                .map(|&sq| apply_symmetry(sym, sq))
                .collect();
            root.insert(&normalized);
            total_games_used += 1;
        }
    }

    let mut lines: Vec<EmittedLine> = Vec::new();
    let mut total_qualifying_nodes: u64 = 0;
    {
        let mut path: Vec<u8> = Vec::new();
        collect_lines(&root, &mut path, min_games, &mut lines, &mut total_qualifying_nodes);
    }

    // 既存の bookgen/joseki-research.json との名前継承・重複分析。
    let existing_bytes = fs::read(&existing_lines_path).unwrap_or_else(|e| {
        panic!("failed to read --existing-lines {existing_lines_path}: {e}")
    });
    let existing_json: Value =
        serde_json::from_slice(&existing_bytes).expect("invalid --existing-lines JSON");
    let existing_lines = existing_json
        .get("lines")
        .and_then(Value::as_array)
        .expect("--existing-lines JSON missing 'lines' array")
        .clone();

    let mut existing_moves_to_name: HashMap<Vec<u8>, String> = HashMap::new();
    for el in &existing_lines {
        let name = el["name"].as_str().expect("existing line missing name").to_string();
        let moves: Vec<u8> = el["moves"]
            .as_array()
            .expect("existing line missing moves")
            .iter()
            .map(|m| notation_to_square(m.as_str().expect("move must be a string")))
            .collect();
        existing_moves_to_name.entry(moves).or_insert(name);
    }

    let mut existing_present_any: usize = 0;
    let mut existing_present_at_threshold: usize = 0;
    for el in &existing_lines {
        let depth = el["depth"].as_u64().expect("existing line missing depth") as usize;
        let take = depth.min(max_depth);
        let moves: Vec<u8> = el["moves"]
            .as_array()
            .expect("existing line missing moves")
            .iter()
            .take(take)
            .map(|m| notation_to_square(m.as_str().expect("move must be a string")))
            .collect();
        if let Some(count) = root.lookup(&moves) {
            if count > 0 {
                existing_present_any += 1;
            }
            if count >= min_games {
                existing_present_at_threshold += 1;
            }
        }
    }

    let mut output_lines: Vec<Value> = Vec::new();
    let mut auto_index: u64 = 0;
    let mut inherited_name_count: u64 = 0;
    for line in &lines {
        let notations: Vec<String> = line.moves.iter().map(|&sq| wthor::index_to_notation(sq)).collect();
        let inherited = existing_moves_to_name.get(&line.moves);
        let name = match inherited {
            Some(existing_name) => {
                inherited_name_count += 1;
                existing_name.clone()
            }
            None => {
                auto_index += 1;
                format!("WTHOR-{auto_index:04}")
            }
        };
        let notes = if inherited.is_some() {
            format!(
                "T150: WTHOR頻出ライン抽出。出現{}局(最大深さ{}手)。既存bookgen/joseki-research.jsonの同名ラインと着手列が完全一致(名前継承)。",
                line.game_count, max_depth
            )
        } else {
            format!(
                "T150: WTHOR頻出ライン抽出。出現{}局(最大深さ{}手)。既存bookgen/joseki-research.jsonに一致するラインなし(自動命名)。",
                line.game_count, max_depth
            )
        };
        output_lines.push(json!({
            "name": name,
            "moves": notations,
            "firstMoveBasis": "f5",
            "depth": line.depth,
            "gameCount": line.game_count,
            "sources": [format!("WTHOR game archive, years {years_spec} ({data_dir})")],
            "notes": notes,
        }));
    }

    let mut depth_histogram: BTreeMap<usize, u64> = BTreeMap::new();
    for line in &lines {
        *depth_histogram.entry(line.depth).or_insert(0) += 1;
    }

    let doc = json!({
        "$schemaNote": "T150: WTHOR実戦棋譜(2000-2024)から初手f5正規化した頻出序盤進行(深さ<=maxDepth・出現>=minGames局)を train::bin::wthor_lines で機械抽出したライン集合。bookgen/joseki-research.json(T016系の手作業データ)とは独立のソース。app/public/joseki.json には未反映(T151でEdax評価値によるフィルタ後に反映予定)。",
        "meta": {
            "tool": "train::bin::wthor_lines",
            "dataDir": data_dir,
            "years": years_spec,
            "filesUsed": files_used,
            "maxDepth": max_depth,
            "minGames": min_games,
            "totalGamesScanned": total_games_scanned,
            "totalGamesUsed": total_games_used,
            "invalidGamesSkipped": invalid_games_skipped,
            "emptyGamesSkipped": empty_games_skipped,
            "totalQualifyingTrieNodes": total_qualifying_nodes,
            "totalLines": lines.len(),
            "inheritedNameCount": inherited_name_count,
            "autoNamedCount": auto_index,
            "depthHistogram": depth_histogram,
            "existingLinesFile": existing_lines_path,
            "existingLinesTotal": existing_lines.len(),
            "existingLinesPresentInWthorAny": existing_present_any,
            "existingLinesPresentAtOrAboveMinGames": existing_present_at_threshold,
        },
        "lines": output_lines,
    });

    if let Some(parent) = Path::new(&out_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("failed to create output directory {}: {e}", parent.display());
                return ExitCode::FAILURE;
            }
        }
    }
    let serialized = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());
    if let Err(e) = fs::write(&out_path, serialized) {
        eprintln!("failed to write {out_path}: {e}");
        return ExitCode::FAILURE;
    }

    eprintln!(
        "wrote {} line(s) ({} qualifying trie nodes, {} inherited names, {} auto names) from {} games (scanned {}, invalid {}, empty {}) to {out_path}",
        lines.len(),
        total_qualifying_nodes,
        inherited_name_count,
        auto_index,
        total_games_used,
        total_games_scanned,
        invalid_games_skipped,
        empty_games_skipped
    );
    eprintln!(
        "existing lines overlap: {}/{} appear at least once in WTHOR data, {}/{} reach the >= {} games threshold",
        existing_present_any,
        existing_lines.len(),
        existing_present_at_threshold,
        existing_lines.len(),
        min_games
    );

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 正規化(初手をf5に写す変換の選択) ---

    #[test]
    fn op_for_first_move_matches_normalize_ts_mapping() {
        assert_eq!(op_for_first_move(37), Some(0)); // f5 -> identity
        assert_eq!(op_for_first_move(19), Some(7)); // d3 -> flipAntiDiag
        assert_eq!(op_for_first_move(26), Some(2)); // c4 -> rot180
        assert_eq!(op_for_first_move(44), Some(6)); // e6 -> flipDiag
        assert_eq!(op_for_first_move(0), None); // a1: 合法な初手ではない
    }

    #[test]
    fn chosen_op_actually_maps_the_first_move_to_f5() {
        for &sq in &[19u8, 26, 37, 44] {
            let sym = op_for_first_move(sq).expect("should be a legal opening move");
            assert_eq!(apply_symmetry(sym, sq), 37, "square {sq} should normalize to f5(37)");
        }
    }

    /// 「初手だけ変換を決めて全着手に同じ変換を適用する」正規化が、
    /// `buildDb.ts`/`normalize.ts` の設計コメントどおり
    /// 「1手ごとに盤面を正規化しながら進める」のと同じ結果になることを
    /// 実際に確認する。虎定石(f5,d6,c3,d3,c4)を4通りの対称変換で
    /// 「別の初手基準の対局」に変換してから正規化し、必ず元のf5基準の
    /// 着手列に戻ることを検証する(4変換はいずれも自己逆変換であるため、
    /// 同じ変換を順方向・逆方向の両方に使ってよい)。
    #[test]
    fn normalizing_alternate_basis_game_recovers_canonical_tora_line() {
        // f5, d6, c3, d3, c4 (train/src/wthor.rs のテストと同じ着手列)。
        let tora_f5: Vec<u8> = vec![37, 43, 18, 19, 26];
        assert!(wthor::replay(&tora_f5).is_ok(), "canonical tora line must be legal");

        for &op in &[0usize, 2, 6, 7] {
            let transformed: Vec<u8> = tora_f5.iter().map(|&sq| apply_symmetry(op, sq)).collect();
            assert!(
                wthor::replay(&transformed).is_ok(),
                "transformed (op={op}) line must remain legal (D4 preserves Othello legality)"
            );

            let sym = op_for_first_move(transformed[0])
                .expect("transformed first move must still be a legal opening");
            let renormalized: Vec<u8> = transformed.iter().map(|&sq| apply_symmetry(sym, sq)).collect();
            assert_eq!(renormalized, tora_f5, "op={op} should round-trip back to the canonical f5 line");
        }
    }

    // --- トライ構築・閾値枝刈り・ライン列挙 ---

    fn extract(games: &[Vec<u8>], min_games: u64) -> (Vec<EmittedLine>, u64) {
        let mut root = TrieNode::default();
        for g in games {
            root.insert(g);
        }
        let mut lines = Vec::new();
        let mut total_qualifying_nodes = 0u64;
        let mut path = Vec::new();
        collect_lines(&root, &mut path, min_games, &mut lines, &mut total_qualifying_nodes);
        (lines, total_qualifying_nodes)
    }

    #[test]
    fn below_threshold_branch_is_pruned_and_does_not_appear_as_a_line() {
        let mut games: Vec<Vec<u8>> = Vec::new();
        for _ in 0..150 {
            games.push(vec![1, 2, 3]);
        }
        for _ in 0..50 {
            games.push(vec![1, 2, 4]);
        }
        let (lines, _) = extract(&games, 100);
        // [1,2,4]枝(50局<100)は枝刈りされ、[1,2,3]枝(150局)だけがラインになる。
        // [1,2]自体は分岐点であり(閾値を満たす子[1,2,3]が1つ)、それ自体は
        // ライン化されない(末端だけを列挙する設計)。
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].moves, vec![1, 2, 3]);
        assert_eq!(lines[0].depth, 3);
        assert_eq!(lines[0].game_count, 150);
    }

    #[test]
    fn branch_point_with_multiple_qualifying_children_yields_multiple_lines() {
        let mut games: Vec<Vec<u8>> = Vec::new();
        for _ in 0..120 {
            games.push(vec![1, 2, 3]);
        }
        for _ in 0..110 {
            games.push(vec![1, 2, 4]);
        }
        let (mut lines, total_qualifying_nodes) = extract(&games, 100);
        lines.sort_by(|a, b| a.moves.cmp(&b.moves));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].moves, vec![1, 2, 3]);
        assert_eq!(lines[0].game_count, 120);
        assert_eq!(lines[1].moves, vec![1, 2, 4]);
        assert_eq!(lines[1].game_count, 110);
        // 閾値を満たすノード: [1](230), [1,2](230), [1,2,3](120), [1,2,4](110) の4つ。
        assert_eq!(total_qualifying_nodes, 4);
    }

    #[test]
    fn a_node_exactly_at_the_threshold_is_kept() {
        let games: Vec<Vec<u8>> = (0..100).map(|_| vec![5, 6]).collect();
        let (lines, _) = extract(&games, 100);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].game_count, 100);
    }

    #[test]
    fn max_depth_truncation_stops_lines_at_the_configured_depth() {
        // 「木を挿入前に max_depth 手で打ち切る」処理(main関数の責務)を
        // ここでも再現し、深さ制限が正しく末端を作ることを確認する。
        let mut games: Vec<Vec<u8>> = Vec::new();
        for _ in 0..120 {
            games.push(vec![1, 2, 3, 4]); // 元は4手だが、max_depth=2で打ち切る想定
        }
        let max_depth = 2usize;
        let truncated: Vec<Vec<u8>> = games
            .iter()
            .map(|g| g[..max_depth.min(g.len())].to_vec())
            .collect();
        let (lines, _) = extract(&truncated, 100);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].moves, vec![1, 2]);
        assert_eq!(lines[0].depth, 2);
        assert_eq!(lines[0].game_count, 120);
    }

    #[test]
    fn deterministic_child_ordering_via_btreemap() {
        // 挿入順序を変えても、トライの子の走査順(BTreeMapの昇順)は
        // 着手マス番号順で安定している。
        let games_a: Vec<Vec<u8>> = vec![vec![5], vec![5], vec![3], vec![3], vec![3]]
            .into_iter()
            .flat_map(|g| std::iter::repeat(g).take(100))
            .collect();
        let games_b: Vec<Vec<u8>> = {
            let mut v = games_a.clone();
            v.reverse();
            v
        };
        let (lines_a, _) = extract(&games_a, 100);
        let (lines_b, _) = extract(&games_b, 100);
        let moves_a: Vec<Vec<u8>> = lines_a.iter().map(|l| l.moves.clone()).collect();
        let moves_b: Vec<Vec<u8>> = lines_b.iter().map(|l| l.moves.clone()).collect();
        assert_eq!(moves_a, moves_b);
        assert_eq!(moves_a, vec![vec![3], vec![5]]); // マス番号昇順
    }

    // --- notation変換 ---

    #[test]
    fn notation_to_square_round_trips_with_wthor_index_to_notation() {
        for sq in 0u8..64 {
            let notation = wthor::index_to_notation(sq);
            assert_eq!(notation_to_square(&notation), sq);
        }
    }

    #[test]
    fn lookup_finds_exact_prefix_count_and_none_for_missing_path() {
        let games: Vec<Vec<u8>> = (0..30).map(|_| vec![7, 8, 9]).collect();
        let mut root = TrieNode::default();
        for g in &games {
            root.insert(g);
        }
        assert_eq!(root.lookup(&[7, 8, 9]), Some(30));
        assert_eq!(root.lookup(&[7, 8]), Some(30));
        assert_eq!(root.lookup(&[]), Some(30));
        assert_eq!(root.lookup(&[7, 9]), None);
    }
}

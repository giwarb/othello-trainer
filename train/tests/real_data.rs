//! `train/data/`に実際にダウンロードしたWTHOR(.wtb)ファイルが置かれている場合に、
//! それらを本実装のパーサーで解析し、全ゲームの着手列が
//! `engine::bitboard`の合法手判定に照らして常に合法であることを検証する統合テスト。
//!
//! `train/data/`はライセンス上の理由でリポジトリにコミットしない
//! (ルート`.gitignore`参照)ため、このファイルが存在しない環境
//! (フレッシュチェックアウト・CI等)では実データが無く、その場合は
//! テストを失敗させずにスキップする。

use std::fs;
use std::path::Path;

use train::wthor;

#[test]
fn downloaded_wthor_files_parse_and_all_moves_are_legal() {
    let data_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("data");

    let entries = match fs::read_dir(&data_dir) {
        Ok(e) => e,
        Err(_) => {
            eprintln!(
                "train/data/ が存在しないためスキップ(WTHORデータ未ダウンロード: {})",
                data_dir.display()
            );
            return;
        }
    };

    let mut wtb_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|ext| ext.eq_ignore_ascii_case("wtb"))
                .unwrap_or(false)
        })
        .collect();
    wtb_files.sort();

    if wtb_files.is_empty() {
        eprintln!("train/data/ に .wtb ファイルが見つからないためスキップ");
        return;
    }

    let mut total_games: usize = 0;
    let mut total_moves: usize = 0;

    for path in &wtb_files {
        let bytes = fs::read(path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"));
        let file =
            wthor::parse(&bytes).unwrap_or_else(|e| panic!("failed to parse {path:?}: {e}"));

        assert_eq!(
            file.header.num_games as usize,
            file.games.len(),
            "{path:?}: ヘッダのゲーム数とパース結果の件数が一致しない"
        );

        for (i, game) in file.games.iter().enumerate() {
            total_games += 1;
            total_moves += game.moves.len();

            if let Err(msg) = wthor::replay(&game.moves) {
                panic!("{path:?} のゲーム#{i}に不正な着手列が含まれる: {msg}");
            }
        }
    }

    eprintln!(
        "検証済み: {} ファイル, {total_games} ゲーム, 総手数 {total_moves}",
        wtb_files.len()
    );
    assert!(
        total_games >= 100,
        "実データのゲーム数が少なすぎる(train/data/にWTHORファイルを配置したか確認): {total_games}"
    );
}

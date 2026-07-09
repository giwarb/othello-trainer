//! WTHOR形式(`.wtb`、"game archive")棋譜ファイルのパーサー。
//!
//! # 一次情報源
//!
//! WTHOR形式の公式仕様書(フランス語、`https://www.ffothello.org/wthor/Format_WThor.pdf`)は
//! 正確な仕様を細部まで確定させるには不十分なため、本実装は
//! `https://github.com/LimeEng/wthor`(Rust実装のWTHORパーサー、2026-07時点の
//! `master`ブランチ、特に `src/header.rs` と `src/game_archive.rs`)を一次情報として
//! 実地に参照し、その構造体定義・レコード長・着手バイトのデコード方法をそのまま踏襲した。
//! さらに、FFO公式サイト(`https://www.ffothello.org/wthor/base/WTH_2023.wtb`,
//! `WTH_2024.wtb`)から実際にダウンロードしたファイルのバイト列をこの実装で解析し、
//! ヘッダのレコード数(N1)とファイル本体の実際のバイト数が
//! `N1 * 68` と一致することを確認済み(T040作業ログ参照)。
//!
//! # ファイル全体のレイアウト
//!
//! ```text
//! [16バイトヘッダ][ゲームレコード#0 (68バイト)][ゲームレコード#1 (68バイト)]...
//! ```
//!
//! 全フィールドはリトルエンディアン。本実装は8x8盤のゲームアーカイブ(`.wtb`)のみを
//! 対象とする(付随ファイルの`.JOU`・`.TRN`、10x10盤、ソリティア形式はスコープ外)。
//!
//! ## ヘッダ(16バイト)
//!
//! | オフセット | サイズ | 内容 |
//! |---|---|---|
//! | 0 | 1 | 作成日: 世紀 (例: 20) |
//! | 1 | 1 | 作成日: 年の下2桁 |
//! | 2 | 1 | 作成日: 月 |
//! | 3 | 1 | 作成日: 日 |
//! | 4 | 4 | N1: ゲーム数(u32 LE) |
//! | 8 | 2 | N2: ゲームアーカイブでは常に0(u16 LE。非0は`.JOU`/`.TRN`など別種ファイル) |
//! | 10 | 2 | 対象年(u16 LE。例: 2024) |
//! | 12 | 1 | P1: 盤サイズ(0または8 = 8x8、10 = 10x10) |
//! | 13 | 1 | P2: 種別(0 = 通常のゲームアーカイブ、1 = ソリティア) |
//! | 14 | 1 | P3: 理論スコア算出時の探索深さ |
//! | 15 | 1 | 予約(未使用) |
//!
//! ## ゲームレコード(8x8盤、68バイト)
//!
//! | オフセット | サイズ | 内容 |
//! |---|---|---|
//! | 0 | 2 | 大会番号(u16 LE、`.TRN`への索引。本実装では未解決のまま保持) |
//! | 2 | 2 | 黒選手番号(u16 LE、`.JOU`への索引) |
//! | 4 | 2 | 白選手番号(u16 LE、`.JOU`への索引) |
//! | 6 | 1 | 実測スコア(終局時の黒石数) |
//! | 7 | 1 | 理論スコア(深さP3での完全読み evaluation) |
//! | 8 | 60 | 着手列。1バイト1着手、`10*行+列`(行・列とも1始まり)。
//! |   |    | 例: a1=11, h1=18, a8=81, h8=88。0はパディング(それ以降着手なし)。 |
//!
//! 着手バイトのデコードは `decode_move_byte` を参照。

use std::fmt;

use engine::bitboard::{Board, Side};

/// ヘッダのバイト長。
pub const HEADER_LEN: usize = 16;
/// 8x8盤のゲームレコード1件のバイト長
/// (大会番号2 + 黒選手番号2 + 白選手番号2 + 実測スコア1 + 理論スコア1 + 着手60 = 68)。
pub const RECORD_LEN_8X8: usize = 68;
/// 1ゲームレコード内の着手バイト数(64マス - 開始局面の4石 = 60)。
pub const MOVES_PER_RECORD: usize = 60;

/// ファイル作成日(ヘッダ先頭4バイト)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreationDate {
    pub century: u8,
    pub year: u8,
    pub month: u8,
    pub day: u8,
}

/// WTHORファイルの16バイトヘッダ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WthorHeader {
    pub creation_date: CreationDate,
    /// N1: ゲーム数。
    pub num_games: u32,
    /// N2: ゲームアーカイブでは常に0。非0の場合は`.JOU`/`.TRN`等の別種ファイルとみなし
    /// `parse`はエラーを返す。
    pub num_records_n2: u16,
    /// 対象年(例: 2024)。
    pub year_of_games: u16,
    /// P1: 盤サイズ(0または8 = 8x8、10 = 10x10)。
    pub board_size: u8,
    /// P2: 種別(0 = 通常、1 = ソリティア)。
    pub game_type: u8,
    /// P3: 理論スコア算出時の探索深さ。
    pub depth: u8,
    /// 予約バイト(未使用)。
    pub reserved: u8,
}

/// 1ゲーム分のレコード。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WthorGame {
    pub tournament_number: u16,
    pub black_player_number: u16,
    pub white_player_number: u16,
    /// 終局時の黒石数(実測スコア)。
    pub black_disc_count: u8,
    /// 理論スコア(深さP3での完全読み評価値)。
    pub theoretical_score: u8,
    /// 着手マスの列。各要素は`engine::bitboard`と同じ座標系
    /// (`index = rank0*8 + file`、a1=0, h1=7, a8=56, h8=63)のビット位置(0..63)。
    pub moves: Vec<u8>,
}

/// パース済みのWTHORファイル全体。
#[derive(Debug, Clone)]
pub struct WthorFile {
    pub header: WthorHeader,
    pub games: Vec<WthorGame>,
}

/// パース失敗の理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// ヘッダ(16バイト)にすら満たない。
    TooShortForHeader,
    /// N2が0でない(ゲームアーカイブ以外の形式、またはソリティア形式)。
    NotAGameArchive { n2: u16 },
    /// P1が8x8(0または8)以外(10x10盤など、本実装ではサポート外)。
    UnsupportedBoardSize(u8),
    /// ヘッダのN1から期待されるボディ長と、実際のファイル残りバイト数が一致しない。
    SizeMismatch {
        expected_games: u32,
        record_len: usize,
        actual_body_len: usize,
    },
    /// 着手バイトが`行=1..8, 列=1..8`の範囲外(不正な値)。
    InvalidMoveByte { game_index: usize, byte: u8 },
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::TooShortForHeader => {
                write!(f, "ファイルが16バイトのヘッダより短い")
            }
            ParseError::NotAGameArchive { n2 } => {
                write!(f, "N2が0でない({n2})ため、ゲームアーカイブ(.wtb)ではない")
            }
            ParseError::UnsupportedBoardSize(p1) => {
                write!(f, "サポート外の盤サイズ(P1={p1}, 8x8以外)")
            }
            ParseError::SizeMismatch {
                expected_games,
                record_len,
                actual_body_len,
            } => write!(
                f,
                "ヘッダのゲーム数({expected_games})とファイル本体のサイズが不整合 \
                 (期待={expected_games} * {record_len} = {}, 実際={actual_body_len})",
                (*expected_games as usize) * record_len
            ),
            ParseError::InvalidMoveByte { game_index, byte } => write!(
                f,
                "ゲーム#{game_index}に不正な着手バイト({byte})が含まれる"
            ),
        }
    }
}

impl std::error::Error for ParseError {}

/// WTHOR形式(`.wtb`)のバイト列をパースする。
///
/// 8x8盤の通常のゲームアーカイブのみをサポートする(N2は0、P1は0または8であること)。
/// それ以外(10x10盤、ソリティア形式、`.JOU`/`.TRN`)は`ParseError`を返す。
pub fn parse(bytes: &[u8]) -> Result<WthorFile, ParseError> {
    if bytes.len() < HEADER_LEN {
        return Err(ParseError::TooShortForHeader);
    }
    let header_bytes = &bytes[..HEADER_LEN];
    let body = &bytes[HEADER_LEN..];

    let creation_date = CreationDate {
        century: header_bytes[0],
        year: header_bytes[1],
        month: header_bytes[2],
        day: header_bytes[3],
    };
    let num_games = u32::from_le_bytes(header_bytes[4..8].try_into().unwrap());
    let num_records_n2 = u16::from_le_bytes(header_bytes[8..10].try_into().unwrap());
    let year_of_games = u16::from_le_bytes(header_bytes[10..12].try_into().unwrap());
    let board_size = header_bytes[12];
    let game_type = header_bytes[13];
    let depth = header_bytes[14];
    let reserved = header_bytes[15];

    if num_records_n2 != 0 {
        return Err(ParseError::NotAGameArchive { n2: num_records_n2 });
    }
    if board_size != 0 && board_size != 8 {
        return Err(ParseError::UnsupportedBoardSize(board_size));
    }

    let record_len = RECORD_LEN_8X8;
    let expected_body_len = (num_games as usize) * record_len;
    if expected_body_len != body.len() {
        return Err(ParseError::SizeMismatch {
            expected_games: num_games,
            record_len,
            actual_body_len: body.len(),
        });
    }

    let header = WthorHeader {
        creation_date,
        num_games,
        num_records_n2,
        year_of_games,
        board_size,
        game_type,
        depth,
        reserved,
    };

    let mut games = Vec::with_capacity(num_games as usize);
    for i in 0..num_games as usize {
        let start = i * record_len;
        let record = &body[start..start + record_len];
        games.push(parse_game(i, record)?);
    }

    Ok(WthorFile { header, games })
}

fn parse_game(game_index: usize, record: &[u8]) -> Result<WthorGame, ParseError> {
    debug_assert_eq!(record.len(), RECORD_LEN_8X8);

    let tournament_number = u16::from_le_bytes(record[0..2].try_into().unwrap());
    let black_player_number = u16::from_le_bytes(record[2..4].try_into().unwrap());
    let white_player_number = u16::from_le_bytes(record[4..6].try_into().unwrap());
    let black_disc_count = record[6];
    let theoretical_score = record[7];

    let mut moves = Vec::with_capacity(MOVES_PER_RECORD);
    for &byte in &record[8..8 + MOVES_PER_RECORD] {
        if byte == 0 {
            // 0は「それ以降着手なし」を表すパディング。
            continue;
        }
        moves.push(decode_move_byte(byte).map_err(|_| ParseError::InvalidMoveByte {
            game_index,
            byte,
        })?);
    }

    Ok(WthorGame {
        tournament_number,
        black_player_number,
        white_player_number,
        black_disc_count,
        theoretical_score,
        moves,
    })
}

/// WTHORの着手バイト(`10*行+列`、行・列とも1始まり。例: a1=11, h1=18, a8=81, h8=88)を、
/// `engine::bitboard`と同じ座標系のビット位置(0..63、`index = rank0*8 + file`)に変換する。
///
/// 行・列がそれぞれ1..8の範囲外であれば`Err(())`を返す。
pub fn decode_move_byte(byte: u8) -> Result<u8, ()> {
    let row = byte / 10; // 1始まりの行 (1..8)
    let col = byte % 10; // 1始まりの列 (1..8)
    if !(1..=8).contains(&row) || !(1..=8).contains(&col) {
        return Err(());
    }
    let rank0 = row - 1;
    let file0 = col - 1;
    Ok(rank0 * 8 + file0)
}

/// ビット位置(0..63)を`"a1"`〜`"h8"`のような記法に変換する(CLI表示用)。
pub fn index_to_notation(index: u8) -> String {
    let file = index % 8;
    let rank = index / 8;
    format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
}

/// 着手列を初期局面から再生し、常に合法手のみが指されていることを検証する。
///
/// 手番はまず黒から始まり、着手ごとに交互に入れ替わる。ただし相手に合法手が
/// 存在しない場合はパス(その回の手番を飛ばして同じ側が続けて着手する)を
/// 自動的に処理する(WTHORの着手列にはパスは記録されないため)。
///
/// 全ての着手が合法であれば、最終局面の`Board`を返す。途中で非合法手や
/// 「両者とも合法手がないのに着手が続いている」異常が見つかった場合は
/// `Err`にその内容を返す。
pub fn replay(moves: &[u8]) -> Result<Board, String> {
    let mut board = Board::initial();
    let mut side = Side::Black;

    for (step, &mv_index) in moves.iter().enumerate() {
        if mv_index >= 64 {
            return Err(format!(
                "moves[{step}]: マスインデックスが範囲外です({mv_index})"
            ));
        }

        if !board.has_legal_move(side) {
            side = side.opposite();
        }
        if !board.has_legal_move(side) {
            return Err(format!(
                "moves[{step}]: 両者とも合法手が無い局面で着手が続いています(手順が異常)"
            ));
        }

        let mv_bit = 1u64 << mv_index;
        if board.legal_moves(side) & mv_bit == 0 {
            return Err(format!(
                "moves[{step}]: 非合法手です(side={side:?}, index={mv_index}, notation={})",
                index_to_notation(mv_index)
            ));
        }

        board = board.apply_move(side, mv_bit);
        side = side.opposite();
    }

    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実際にダウンロードしたWTH_2024.wtbの先頭16バイトをそのまま書き写した
    /// 合成ヘッダ(作成日2026-02-23、N1=2891、N2=0、対象年2024、P1=8、P2=0、P3=24)。
    /// (T040作業ログの`xxd`/pythonでのバイト確認結果を参照)
    fn sample_2024_header_bytes() -> [u8; HEADER_LEN] {
        [
            0x14, 0x1a, 0x02, 0x17, 0x4b, 0x0b, 0x00, 0x00, 0x00, 0x00, 0xe8, 0x07, 0x08, 0x00,
            0x18, 0x00,
        ]
    }

    #[test]
    fn header_parses_real_wth_2024_prefix_bytes() {
        let header_bytes = sample_2024_header_bytes();
        // N1(ゲーム数)を1件に差し替えたヘッダ + 1ゲーム分のダミーレコードで
        // parseを通し、ヘッダの各フィールドが正しくデコードされることを確認する。
        let mut bytes = header_bytes.to_vec();
        bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
        bytes.extend(build_game_record(0, 1, 2, 40, 24, &[]));

        let file = parse(&bytes).expect("should parse");
        let h = file.header;
        assert_eq!(h.creation_date, CreationDate { century: 20, year: 26, month: 2, day: 23 });
        assert_eq!(h.num_games, 1);
        assert_eq!(h.num_records_n2, 0);
        assert_eq!(h.year_of_games, 2024);
        assert_eq!(h.board_size, 8);
        assert_eq!(h.game_type, 0);
        assert_eq!(h.depth, 24);
        assert_eq!(file.games.len(), 1);
    }

    /// テスト用: 1ゲーム分の68バイトレコードを組み立てるヘルパー。
    fn build_game_record(
        tournament: u16,
        black_player: u16,
        white_player: u16,
        black_disc_count: u8,
        theoretical_score: u8,
        move_bytes: &[u8],
    ) -> Vec<u8> {
        assert!(move_bytes.len() <= MOVES_PER_RECORD);
        let mut record = Vec::with_capacity(RECORD_LEN_8X8);
        record.extend_from_slice(&tournament.to_le_bytes());
        record.extend_from_slice(&black_player.to_le_bytes());
        record.extend_from_slice(&white_player.to_le_bytes());
        record.push(black_disc_count);
        record.push(theoretical_score);
        record.extend_from_slice(move_bytes);
        record.resize(RECORD_LEN_8X8, 0);
        record
    }

    fn build_file(num_games_field: u32, records: &[Vec<u8>]) -> Vec<u8> {
        let mut header = sample_2024_header_bytes();
        header[4..8].copy_from_slice(&num_games_field.to_le_bytes());
        let mut bytes = header.to_vec();
        for r in records {
            bytes.extend_from_slice(r);
        }
        bytes
    }

    #[test]
    fn parse_decodes_game_record_fields() {
        // 実際のWTH_2023.wtb先頭ゲーム(黒番, real_score=37, theoretical_score=29)の
        // 冒頭手順を使う(T040作業ログのpython確認結果を参照): f5 d6 c3 d3 c4 ...
        let move_bytes: Vec<u8> = vec![56, 64, 33, 34, 43, 46, 66, 36, 47, 37];
        let record = build_game_record(9, 3344, 2589, 37, 29, &move_bytes);
        let bytes = build_file(1, &[record]);

        let file = parse(&bytes).expect("should parse");
        assert_eq!(file.games.len(), 1);
        let game = &file.games[0];
        assert_eq!(game.tournament_number, 9);
        assert_eq!(game.black_player_number, 3344);
        assert_eq!(game.white_player_number, 2589);
        assert_eq!(game.black_disc_count, 37);
        assert_eq!(game.theoretical_score, 29);

        let notations: Vec<String> = game.moves.iter().map(|&i| index_to_notation(i)).collect();
        assert_eq!(
            notations,
            vec!["f5", "d6", "c3", "d3", "c4", "f4", "f6", "f3", "g4", "g3"]
        );
    }

    #[test]
    fn parse_stops_moves_at_zero_padding() {
        // 60バイトのうち先頭10バイトだけ着手を入れ、残りは0パディング。
        // パース結果の着手数が10件になる(0以降は無視される)ことを確認する。
        let move_bytes: Vec<u8> = vec![56, 64, 33, 34, 43, 46, 66, 36, 47, 37];
        let record = build_game_record(0, 0, 0, 0, 0, &move_bytes);
        let bytes = build_file(1, &[record]);

        let file = parse(&bytes).expect("should parse");
        assert_eq!(file.games[0].moves.len(), 10);
    }

    #[test]
    fn parse_rejects_n2_nonzero_as_not_a_game_archive() {
        let mut header = sample_2024_header_bytes();
        header[8..10].copy_from_slice(&1u16.to_le_bytes());
        let bytes = header.to_vec();
        assert_eq!(
            parse(&bytes).unwrap_err(),
            ParseError::NotAGameArchive { n2: 1 }
        );
    }

    #[test]
    fn parse_rejects_size_mismatch() {
        // N1=2のはずが、レコードが1件分しかない。
        let record = build_game_record(0, 0, 0, 0, 0, &[]);
        let bytes = build_file(2, &[record]);
        let err = parse(&bytes).unwrap_err();
        assert_eq!(
            err,
            ParseError::SizeMismatch {
                expected_games: 2,
                record_len: RECORD_LEN_8X8,
                actual_body_len: RECORD_LEN_8X8,
            }
        );
    }

    #[test]
    fn parse_too_short_for_header_is_rejected() {
        let bytes = vec![0u8; 10];
        assert_eq!(parse(&bytes).unwrap_err(), ParseError::TooShortForHeader);
    }

    // --- 着手デコード・座標変換 ---

    #[test]
    fn decode_move_byte_matches_documented_corner_examples() {
        // タスク仕様に明記された例: a1=11, h1=18, a8=81, h8=88。
        assert_eq!(decode_move_byte(11), Ok(0)); // a1 -> index 0
        assert_eq!(decode_move_byte(18), Ok(7)); // h1 -> index 7
        assert_eq!(decode_move_byte(81), Ok(56)); // a8 -> index 56
        assert_eq!(decode_move_byte(88), Ok(63)); // h8 -> index 63
    }

    #[test]
    fn decode_move_byte_matches_index_to_notation_roundtrip() {
        for index in 0u8..64 {
            let file = index % 8;
            let rank = index / 8;
            let byte = 10 * (rank + 1) + (file + 1);
            assert_eq!(decode_move_byte(byte), Ok(index));
            assert_eq!(
                index_to_notation(index),
                format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
            );
        }
    }

    #[test]
    fn decode_move_byte_rejects_out_of_range_values() {
        assert_eq!(decode_move_byte(0), Err(()));
        assert_eq!(decode_move_byte(9), Err(())); // 列0相当は範囲外
        assert_eq!(decode_move_byte(19), Err(())); // 列9相当は範囲外
        assert_eq!(decode_move_byte(91), Err(())); // 行9相当は範囲外
    }

    // --- 合法手検証(replay) ---

    #[test]
    fn replay_accepts_known_legal_opening_sequence() {
        // WTH_2023.wtb先頭ゲームの冒頭手順(実データから抽出): f5 d6 c3 d3 c4 f4 f6 f3 g4 g3
        let moves: Vec<u8> = ["f5", "d6", "c3", "d3", "c4", "f4", "f6", "f3", "g4", "g3"]
            .iter()
            .map(|n| notation_to_index(n))
            .collect();
        let result = replay(&moves);
        assert!(result.is_ok(), "expected legal sequence, got {:?}", result);
    }

    #[test]
    fn replay_rejects_illegal_first_move() {
        // 黒番の初手として合法な4マス(d3, c4, f5, e6)以外はすべて非合法。
        let moves = vec![notation_to_index("a1")];
        let result = replay(&moves);
        assert!(result.is_err());
    }

    #[test]
    fn replay_rejects_out_of_range_index() {
        let moves = vec![64u8];
        let result = replay(&moves);
        assert!(result.is_err());
    }

    /// テスト用: "d3"のような記法をビット位置(0..63)に変換する。
    fn notation_to_index(notation: &str) -> u8 {
        let bytes = notation.as_bytes();
        let file = bytes[0] - b'a';
        let rank = bytes[1] - b'1';
        rank * 8 + file
    }
}

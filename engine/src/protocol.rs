//! JSON入出力プロトコル(設計書 §2.4 Worker プロトコル)。
//!
//! `Engine::analyze`(`lib.rs`)から呼び出される、JSON文字列 <-> Rust の
//! 変換ロジックをまとめたモジュール。本タスク(T008)では `final: true` の
//! 1回きりの応答のみを扱う(逐次進捗報告・`multiPV` はスコープ外)。
//!
//! # panicしないことについて(最重要)
//! wasm上でのpanicはモジュール全体をクラッシュさせ、以後Engineインスタンスが
//! 一切使い物にならなくなる。そのため、JSONパース失敗・16進数パース失敗・
//! 不正な `turn`/`cmd` 値など、外部入力に起因するあらゆるエラーは
//! `Result`/`Option` で受け止め、`.unwrap()` 等でパニックさせず
//! [`ErrorResponse`] をJSON化して返す。

use crate::bitboard::{Board, Side};
use crate::search::{search, SearchLimit};
use crate::tt::TranspositionTable;
use serde::{Deserialize, Serialize};
// search.rs 同様、`wasm32-unknown-unknown` で実行時panicする
// `std::time::Instant` の代わりに `web-time` のドロップイン実装を使う。
use web_time::Instant;

/// リクエストの `board` フィールド。
#[derive(Debug, Deserialize)]
pub struct BoardJson {
    pub black: String,
    pub white: String,
    pub turn: String,
}

/// リクエストの `limit` フィールド。
#[derive(Debug, Deserialize)]
pub struct LimitJson {
    pub depth: u8,
    #[serde(default, rename = "timeMs")]
    pub time_ms: Option<u64>,
    #[serde(rename = "exactFromEmpties")]
    pub exact_from_empties: u8,
}

/// `analyze` コマンドのリクエスト全体。
///
/// `multiPV` は本タスクのスコープ外(§T008「やらないこと」)のため、
/// フィールドとしては受け取るが読み捨てる。存在しなくてもエラーにしない。
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    pub id: u64,
    pub cmd: String,
    pub board: BoardJson,
    pub limit: LimitJson,
    /// 複数候補手の指定(T008のスコープ外)。読み捨てる。
    /// リクエストに含まれていてもエラーにしないためだけに受け皿として
    /// 持っておくフィールドで、意図的に読み取らない。
    #[serde(default, rename = "multiPV")]
    #[allow(dead_code)]
    pub multi_pv: Option<u32>,
}

/// レスポンスの `score` フィールド。
#[derive(Debug, Serialize)]
pub struct ScoreJson {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "discDiff")]
    pub disc_diff: f64,
}

/// `analyze` コマンドの正常応答。本タスクでは常に `is_final: true`。
#[derive(Debug, Serialize)]
pub struct AnalyzeResponse {
    pub id: u64,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub depth: u8,
    pub pv: Vec<String>,
    pub score: ScoreJson,
    pub nodes: u64,
    pub nps: u64,
}

/// エラー応答。JSONパース自体に失敗して `id` すら読み取れない場合は `None`。
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub id: Option<u64>,
    pub error: String,
}

/// マス番号(0..63)を `"a1"`〜`"h8"` の記法に変換する。
///
/// ビットとマスの対応は `bitboard.rs` 冒頭の規約
/// (`index = rank0 * 8 + file`, a=0..h=7)に従う。
pub fn square_to_notation(idx: u8) -> String {
    let file = idx % 8;
    let rank = idx / 8;
    format!("{}{}", (b'a' + file) as char, (b'1' + rank) as char)
}

/// JSONリクエスト文字列を解析して探索を実行し、JSONレスポンス文字列を返す。
///
/// `tt` は呼び出しをまたいで同じインスタンスを使い回すことを想定している
/// (`Engine::analyze` から呼ばれ、`Engine` が保持する置換表を渡す)。
///
/// 絶対にpanicしない: JSONパース失敗・16進数パース失敗・不正な `turn`/`cmd`
/// はすべて [`ErrorResponse`] のJSON文字列として返す。
pub fn handle_analyze(request_json: &str, tt: &mut TranspositionTable) -> String {
    let request: AnalyzeRequest = match serde_json::from_str(request_json) {
        Ok(req) => req,
        Err(e) => return error_json(None, format!("invalid request JSON: {e}")),
    };

    if request.cmd != "analyze" {
        let cmd = request.cmd;
        return error_json(Some(request.id), format!("unsupported command: {cmd}"));
    }

    let black_hex = request
        .board
        .black
        .strip_prefix("0x")
        .unwrap_or(request.board.black.as_str());
    let white_hex = request
        .board
        .white
        .strip_prefix("0x")
        .unwrap_or(request.board.white.as_str());

    let black = match u64::from_str_radix(black_hex, 16) {
        Ok(v) => v,
        Err(e) => return error_json(Some(request.id), format!("invalid board.black: {e}")),
    };
    let white = match u64::from_str_radix(white_hex, 16) {
        Ok(v) => v,
        Err(e) => return error_json(Some(request.id), format!("invalid board.white: {e}")),
    };

    let side = match request.board.turn.as_str() {
        "black" => Side::Black,
        "white" => Side::White,
        other => {
            return error_json(Some(request.id), format!("invalid board.turn: {other}"));
        }
    };

    let board = Board { black, white };
    let empties = board.empty_count();

    let limit = SearchLimit {
        max_depth: request.limit.depth,
        time_ms: request.limit.time_ms,
        exact_from_empties: request.limit.exact_from_empties,
    };

    let score_kind = if empties <= limit.exact_from_empties as u32 {
        "exact"
    } else {
        "midgame"
    };

    let start = Instant::now();
    let result = search(&board, side, &limit, tt);
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 経過時間が極端に短い(0ms)場合はゼロ除算を避け、nodesをそのままnpsとする
    // 安全なフォールバックにする。
    let nps = result
        .nodes
        .saturating_mul(1000)
        .checked_div(elapsed_ms)
        .unwrap_or(result.nodes);

    let pv: Vec<String> = result
        .pv
        .iter()
        .map(|&mv| square_to_notation(mv))
        .collect();

    let response = AnalyzeResponse {
        id: request.id,
        is_final: true,
        depth: result.depth,
        pv,
        score: ScoreJson {
            kind: score_kind.to_string(),
            disc_diff: result.score as f64 / 100.0,
        },
        nodes: result.nodes,
        nps,
    };

    serde_json::to_string(&response)
        .unwrap_or_else(|e| error_json(Some(request.id), format!("failed to serialize response: {e}")))
}

/// [`ErrorResponse`] を組み立ててJSON文字列化する。
///
/// `serde_json::to_string` 自体が失敗することは通常あり得ない
/// (`ErrorResponse` は `Option<u64>` と `String` のみで構成される単純な
/// 構造体のため)が、万一に備えて手書きの最小限のJSONにフォールバックする。
fn error_json(id: Option<u64>, error: String) -> String {
    let response = ErrorResponse { id, error };
    serde_json::to_string(&response)
        .unwrap_or_else(|_| "{\"id\":null,\"error\":\"failed to serialize error response\"}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    const INITIAL_BLACK: &str = "0x0000000810000000";
    const INITIAL_WHITE: &str = "0x0000001008000000";

    fn analyze_request_json(
        id: u64,
        black: &str,
        white: &str,
        turn: &str,
        depth: u8,
        exact_from_empties: u8,
    ) -> String {
        format!(
            r#"{{"id":{id},"cmd":"analyze","board":{{"black":"{black}","white":"{white}","turn":"{turn}"}},"limit":{{"depth":{depth},"exactFromEmpties":{exact_from_empties}}},"multiPV":3}}"#
        )
    }

    /// テスト用ユーティリティ: 初期局面から決定的(最下位ビット優先)に手を
    /// 進めて空きマスを減らす(`search.rs`のテストと同様の考え方。
    /// モジュールをまたいだ共有はしていない)。
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
    fn analyze_initial_position_returns_valid_pv_and_score() {
        let mut engine = Engine::new();
        let request = analyze_request_json(42, INITIAL_BLACK, INITIAL_WHITE, "black", 6, 24);

        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");

        assert_eq!(response["id"], 42);
        assert_eq!(response["final"], true);
        assert!(response["depth"].as_u64().unwrap() >= 1);

        let pv = response["pv"].as_array().expect("pv should be an array");
        assert!(!pv.is_empty(), "pv should not be empty");

        let first_move = pv[0].as_str().expect("pv[0] should be a string");
        let expected_opening_moves = ["d3", "c4", "f5", "e6"];
        assert!(
            expected_opening_moves.contains(&first_move),
            "first pv move {first_move} should be one of the legal opening moves"
        );

        assert!(response["score"]["discDiff"].as_f64().is_some());
        assert_eq!(response["score"]["type"], "midgame");
    }

    #[test]
    fn broken_json_returns_error_response_without_panicking() {
        let mut engine = Engine::new();
        let response_json = engine.analyze("{ this is not valid json");
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("error response should still be valid JSON");
        assert!(response.get("error").is_some());
    }

    #[test]
    fn invalid_hex_board_returns_error_response_without_panicking() {
        let mut engine = Engine::new();
        let request = analyze_request_json(1, "not_hex", INITIAL_WHITE, "black", 6, 24);
        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("error response should still be valid JSON");
        assert!(response.get("error").is_some());
    }

    #[test]
    fn unsupported_command_returns_error_response() {
        let mut engine = Engine::new();
        let request = format!(
            r#"{{"id":7,"cmd":"stop","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":1,"exactFromEmpties":24}}}}"#
        );
        let response_json = engine.analyze(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).unwrap();
        assert!(response.get("error").is_some());
        assert_eq!(response["id"], 7);
    }

    #[test]
    fn score_type_is_exact_when_within_exact_from_empties_threshold() {
        let (board, side) = play_until_empties(10);
        let exact_threshold = board.empty_count() as u8;
        let black = board.black;
        let white = board.white;
        let turn = if side == Side::Black { "black" } else { "white" };

        let request = format!(
            r#"{{"id":99,"cmd":"analyze","board":{{"black":"0x{black:x}","white":"0x{white:x}","turn":"{turn}"}},"limit":{{"depth":20,"exactFromEmpties":{exact_threshold}}}}}"#
        );

        let mut engine = Engine::new();
        let response_json = engine.analyze(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).unwrap();
        assert_eq!(response["score"]["type"], "exact");
    }

    #[test]
    fn score_type_is_midgame_when_above_exact_from_empties_threshold() {
        let mut engine = Engine::new();
        let request = analyze_request_json(1, INITIAL_BLACK, INITIAL_WHITE, "black", 4, 10);
        let response_json = engine.analyze(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).unwrap();
        assert_eq!(response["score"]["type"], "midgame");
    }

    #[test]
    fn reusing_engine_across_two_analyze_calls_does_not_panic() {
        let mut engine = Engine::new();
        let request1 = analyze_request_json(1, INITIAL_BLACK, INITIAL_WHITE, "black", 4, 10);
        let response1 = engine.analyze(&request1);
        assert!(serde_json::from_str::<serde_json::Value>(&response1).is_ok());

        let request2 = analyze_request_json(2, INITIAL_BLACK, INITIAL_WHITE, "black", 5, 10);
        let response2 = engine.analyze(&request2);
        let response2_json: serde_json::Value = serde_json::from_str(&response2).unwrap();
        assert_eq!(response2_json["id"], 2);
        assert!(response2_json.get("error").is_none());
    }
}

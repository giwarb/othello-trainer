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
use crate::pattern_eval::PatternWeights;
use crate::search::{search_all_moves_with_eval, search_with_eval, search_with_eval_with_node_limit, SearchLimit};
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
    #[serde(default, rename = "maxNodes")]
    pub max_nodes: Option<u64>,
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
    /// `true` の場合、最善手1つではなく現局面の**全合法手**の評価値を
    /// `search_all_moves`(T018)で計算し、レスポンスの `moves` フィールドに
    /// 含める。省略時は `false`(既存の `analyze` と同じ挙動)。
    #[serde(default, rename = "allMoves")]
    pub all_moves: bool,
}

/// レスポンスの `score` フィールド。
#[derive(Debug, Serialize)]
pub struct ScoreJson {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "discDiff")]
    pub disc_diff: f64,
}

/// `moves` 配列(T018: `allMoves: true` 指定時のみレスポンスに含まれる)の
/// 各要素。現局面のある1つの合法手についての評価値を表す。
#[derive(Debug, Serialize)]
pub struct MoveEvalJson {
    /// 着手先マス(`square_to_notation` による `"a1"`〜`"h8"` 記法)。
    #[serde(rename = "move")]
    pub mv: String,
    /// 評価値。centi-disc単位(1石=100)、手番視点。
    pub score: i32,
    #[serde(rename = "discDiff")]
    pub disc_diff: f64,
    /// この手が実際にどちらの方式で評価されたか(`"exact"` = 終盤完全読み、
    /// `"midgame"` = 中盤探索)。`ScoreJson::kind` と同じ語彙・同じ
    /// JSONフィールド名(`"type"`)を使う。`search::MoveEval::is_exact` を
    /// そのまま文字列化したもので、着手前の局面の空きマス数ではなく
    /// **この手について実際に使われた評価方式**を反映する
    /// (レビュー指摘によりT018で追加。詳細は `eval_kind` のコメント参照)。
    #[serde(rename = "type")]
    pub kind: String,
}

/// [`crate::search::MoveEval::is_exact`] を `ScoreJson`/`MoveEvalJson` の
/// `type` 文字列(`"exact"` | `"midgame"`)に変換する。
///
/// `allMoves` 分岐では、トップレベルの `score.type` および各 `moves[].type`
/// の両方を、**その手について実際に使われた評価方式**
/// (`search_all_moves` が返す `MoveEval::is_exact`)から決定する。
/// 着手前の局面の空きマス数と `limit.exact_from_empties` を比較するだけの
/// 判定では、着手後に空きマス数が必ず1減ることを考慮できておらず、
/// `exact_from_empties + 1` の境界で実態と食い違うバグがあった
/// (レビュー指摘、T018フィードバック参照)。
fn eval_kind(is_exact: bool) -> &'static str {
    if is_exact {
        "exact"
    } else {
        "midgame"
    }
}

/// `analyze` コマンドの正常応答。本タスクでは常に `is_final: true`。
///
/// `moves` は `allMoves: true` を指定したリクエストに対してのみ
/// `Some(...)` になる(T018)。`allMoves` を指定しない既存のリクエストでは
/// 常に `None` となり `skip_serializing_if` によりJSON上のフィールド自体が
/// 現れないため、既存クライアントとの後方互換性は保たれる。
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moves: Option<Vec<MoveEvalJson>>,
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

/// `"a1"`〜`"h8"` の記法をマス番号(0..63)に変換する。[`square_to_notation`] の逆変換。
///
/// T031(`explain.rs`)の `move` フィールド解析で使う。不正な記法(長さ違反・
/// 範囲外の文字)は `Err` を返す(呼び出し元は絶対にpanicしないという本モジュールの
/// 方針に従い、この関数もpanicしない)。
pub fn notation_to_square(notation: &str) -> Result<u8, String> {
    let bytes = notation.as_bytes();
    if bytes.len() != 2 {
        return Err(format!("invalid square notation: {notation}"));
    }
    let file = bytes[0];
    let rank = bytes[1];
    if !(b'a'..=b'h').contains(&file) || !(b'1'..=b'8').contains(&rank) {
        return Err(format!("invalid square notation: {notation}"));
    }
    Ok((rank - b'1') * 8 + (file - b'a'))
}

/// [`BoardJson`] を `(Board, Side)` にパースする。
///
/// `handle_analyze` と `explain::handle_explain` の両方から使う共通ロジック
/// (16進数パース・`turn` の妥当性検証)。絶対にpanicしない: 不正な入力は
/// `Err(String)`(エラーメッセージ)を返す。
pub(crate) fn parse_board(board: &BoardJson) -> Result<(Board, Side), String> {
    let black_hex = board.black.strip_prefix("0x").unwrap_or(board.black.as_str());
    let white_hex = board.white.strip_prefix("0x").unwrap_or(board.white.as_str());

    let black = u64::from_str_radix(black_hex, 16).map_err(|e| format!("invalid board.black: {e}"))?;
    let white = u64::from_str_radix(white_hex, 16).map_err(|e| format!("invalid board.white: {e}"))?;

    let side = match board.turn.as_str() {
        "black" => Side::Black,
        "white" => Side::White,
        other => return Err(format!("invalid board.turn: {other}")),
    };

    Ok((Board { black, white }, side))
}

/// JSONリクエスト文字列を解析して探索を実行し、JSONレスポンス文字列を返す。
///
/// `tt` は呼び出しをまたいで同じインスタンスを使い回すことを想定している
/// (`Engine::analyze` から呼ばれ、`Engine` が保持する置換表を渡す)。
///
/// `weights`(T045)が`Some`なら中盤探索の静的評価にT044のパターン評価v2を
/// 使い(`search_with_eval`/`search_all_moves_with_eval`)、`None`なら従来の
/// 3項ヒューリスティック評価を使う(`Engine::load_pattern_weights`が
/// 呼ばれていない、または失敗した場合のグレースフルフォールバック)。
/// 終盤完全読みの結果には影響しない。
///
/// 絶対にpanicしない: JSONパース失敗・16進数パース失敗・不正な `turn`/`cmd`
/// はすべて [`ErrorResponse`] のJSON文字列として返す。
pub fn handle_analyze(request_json: &str, tt: &mut TranspositionTable, weights: Option<&PatternWeights>) -> String {
    let request: AnalyzeRequest = match serde_json::from_str(request_json) {
        Ok(req) => req,
        Err(e) => return error_json(None, format!("invalid request JSON: {e}")),
    };

    if request.cmd != "analyze" {
        let cmd = request.cmd;
        return error_json(Some(request.id), format!("unsupported command: {cmd}"));
    }

    if request.all_moves && request.limit.max_nodes.is_some() {
        return error_json(Some(request.id), "maxNodes is not supported with allMoves: true".to_string());
    }

    let (board, side) = match parse_board(&request.board) {
        Ok(v) => v,
        Err(e) => return error_json(Some(request.id), e),
    };
    let empties = board.empty_count();

    let limit = SearchLimit {
        max_depth: request.limit.depth,
        time_ms: request.limit.time_ms,
        exact_from_empties: request.limit.exact_from_empties,
    };

    // `score_kind`は、**着手前**の局面の空きマス数と `exact_from_empties`
    // の比較だけで事前計算した値であり、実際にどちらの方式で評価された
    // かは反映しない。そのため `allMoves: true` の分岐(各手を実際に
    // どちらの方式で評価したか)には使わない(レビュー指摘、T018フィード
    // バック参照。詳細は `eval_kind` のドキュメントコメントを参照)。
    //
    // T034での訂正: 以前は「`allMoves`を指定しない既存の`analyze`専用の
    // 値」として、非`allMoves`応答の`score.type`にもそのまま使っていたが、
    // これは誤りだった。`search()`のルート分岐に時間予算付き完全読み
    // (`solve_exact_bounded`)を導入したことで、「空きマス数的には
    // `exact_from_empties`以下だが、タイムアウトにより実際には完全読みを
    // 完走できなかった」局面が`search()`から`is_exact: false`の結果を
    // 返しうるようになったため、着手前の空きマス数だけで判定する
    // `score_kind`では「exact」と誤表示してしまう(レビュー指摘、T034
    // フィードバック参照)。非`allMoves`応答は下で`result.is_exact`
    // (`search()`が実際に使った評価方式)を根拠に決定するよう修正した。
    // `score_kind`自体は、`allMoves: true`かつ合法手が0件(パス・終局)の
    // 場合のフォールバック値としてのみ、引き続き使う(この場合は実際の
    // 探索が行われないため`is_exact`相当の情報が存在しない)。
    let score_kind = if empties <= limit.exact_from_empties as u32 {
        "exact"
    } else {
        "midgame"
    };

    // T018: `allMoves: true` が指定されていれば、最善手1つではなく
    // 現局面の全合法手の評価値(`search_all_moves`)を計算し、`moves`
    // フィールドに含めて返す。既存の `analyze`(`allMoves` 省略/false)は
    // この分岐に入らず、従来どおりの応答を返す(後方互換性の維持)。
    if request.all_moves {
        // T139: `search_all_moves_with_eval`はもう呼び出し元のTT(`tt`、
        // 対局CPU着手の探索と共有される`Engine::analyze`のTT)を読み書き
        // しない(関数内で完結するローカルTTを使う)。この分岐でも`tt`を
        // 渡さなくなったことで、表示用のこの経路が対局用のTTを汚す経路が
        // なくなった(詳細はsearch.rsの関数docコメント参照)。
        let evals = search_all_moves_with_eval(&board, side, &limit, weights);

        let moves: Vec<MoveEvalJson> = evals
            .iter()
            .map(|e| MoveEvalJson {
                mv: square_to_notation(e.mv),
                score: e.score,
                disc_diff: e.score as f64 / 100.0,
                kind: eval_kind(e.is_exact).to_string(),
            })
            .collect();

        // トップレベルの `depth`/`pv`/`score.type` は、合法手が0件でなければ
        // 最善手(`moves`の先頭、スコア降順ソート済み)が**実際にどちらの
        // 方式で評価されたか**(`MoveEval::is_exact`)を根拠に決める
        // (着手前の局面の空きマス数だけで判定すると `exact_from_empties + 1`
        // の境界で実態と食い違うバグがあった。レビュー指摘、T018フィード
        // バック参照)。完全読みの場合、`depth` は `search()`(単体API)の
        // 完全読み経路と同じ規約に合わせ、着手後の残り空きマス数を報告する。
        // パス・終局で合法手が無い場合のみ、`score_kind`(着手前ベースの
        // フォールバック)と `limit.max_depth` を使う。
        let (pv, score_value, top_kind, depth) = match evals.first() {
            Some(best) => {
                let pv = vec![square_to_notation(best.mv)];
                let kind = eval_kind(best.is_exact);
                let depth = if best.is_exact {
                    let next_board = board.apply_move(side, 1u64 << best.mv);
                    next_board.empty_count() as u8
                } else {
                    limit.max_depth
                };
                (pv, best.score, kind, depth)
            }
            None => (Vec::new(), 0, score_kind, limit.max_depth),
        };

        let response = AnalyzeResponse {
            id: request.id,
            is_final: true,
            depth,
            pv,
            score: ScoreJson {
                kind: top_kind.to_string(),
                disc_diff: score_value as f64 / 100.0,
            },
            // 各手ごとのノード数集計はスコープ外(T018「やらないこと」)。
            nodes: 0,
            nps: 0,
            moves: Some(moves),
        };

        return serde_json::to_string(&response).unwrap_or_else(|e| {
            error_json(Some(request.id), format!("failed to serialize response: {e}"))
        });
    }

    let start = Instant::now();
    let result = match request.limit.max_nodes {
        Some(max_nodes) => {
            // T085bの校正は探索ごとに空のTTを使っている。Workerが保持するTTの
            // 過去リクエスト依存を除き、同じノード予算を同じ探索条件にする。
            // maxNodes未指定の通常探索/allMovesは従来どおりTTを再利用する。
            tt.clear();
            search_with_eval_with_node_limit(&board, side, &limit, tt, weights, max_nodes)
        }
        None => search_with_eval(&board, side, &limit, tt, weights),
    };
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
            // T034: 着手前の空きマス数ベースの`score_kind`ではなく、
            // `search()`が実際に使った評価方式(`result.is_exact`)を
            // 根拠にする(`allMoves`分岐の`eval_kind(best.is_exact)`と
            // 同じ方針。レビュー指摘、T034フィードバック参照)。
            kind: eval_kind(result.is_exact).to_string(),
            disc_diff: result.score as f64 / 100.0,
        },
        nodes: result.nodes,
        nps,
        moves: None,
    };

    serde_json::to_string(&response)
        .unwrap_or_else(|e| error_json(Some(request.id), format!("failed to serialize response: {e}")))
}

/// [`ErrorResponse`] を組み立ててJSON文字列化する。
///
/// `serde_json::to_string` 自体が失敗することは通常あり得ない
/// (`ErrorResponse` は `Option<u64>` と `String` のみで構成される単純な
/// 構造体のため)が、万一に備えて手書きの最小限のJSONにフォールバックする。
pub(crate) fn error_json(id: Option<u64>, error: String) -> String {
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
    fn score_type_is_midgame_not_exact_when_root_exact_solve_times_out() {
        // T034レビュー指摘(1回目のやり直し)の回帰テスト。
        //
        // `search()`のルート分岐(局面自体の空きマス数が`exactFromEmpties`
        // 以下)は、`timeMs`が指定されていれば`solve_exact_bounded`を使う
        // ようになった(T034)。この完全読みがタイムアウトした場合、
        // `search()`は通常の反復深化(NegaScout)経路にフォールバックし、
        // それも一度も完走できなければ最終的に静的評価1回分の値を返す
        // (`SearchResult::is_exact = false`)。
        //
        // 修正前のバグ: `protocol.rs`はこのフォールバックを考慮せず、
        // **着手前**の局面の空きマス数と`exactFromEmpties`の比較だけで
        // 事前計算した`score_kind`をそのまま`score.type`に使っていたため、
        // タイムアウトで得られた不正確な静的評価値が`"exact"`(確定)だと
        // 誤って報告されてしまっていた(`BlunderPanel.tsx`のフリー分岐
        // 探索機能で「確定」の緑バッジとして誤表示される実害があった)。
        //
        // ここでは空き18の局面(完全読みに一定のノード数を要する)に対し、
        // `timeMs: 1`という極端に短い予算を与えて確実にタイムアウトさせ、
        // `score.type`が`"midgame"`(実際に使われた評価方式)を正しく
        // 報告することを確認する。
        let (board, side) = play_until_empties(18);
        let exact_threshold = board.empty_count() as u8;
        let black = board.black;
        let white = board.white;
        let turn = if side == Side::Black { "black" } else { "white" };

        let request = format!(
            r#"{{"id":100,"cmd":"analyze","board":{{"black":"0x{black:x}","white":"0x{white:x}","turn":"{turn}"}},"limit":{{"depth":20,"timeMs":1,"exactFromEmpties":{exact_threshold}}}}}"#
        );

        let mut engine = Engine::new();
        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");

        assert!(response.get("error").is_none(), "response should not be an error: {response}");
        assert_eq!(
            response["score"]["type"], "midgame",
            "when the root exact solve times out (timeMs=1 on an 18-empties position), \
             score.type must reflect the actual (incomplete/static) evaluation method \
             ('midgame'), not the pre-move-empties-based guess ('exact'); got response={response}"
        );
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

    // ------------------------------------------------------------------
    // T018: `allMoves: true` のテスト
    // ------------------------------------------------------------------

    /// `analyze_request_json` に `"allMoves":true` を追加したリクエストJSONを組み立てる。
    fn analyze_all_moves_request_json(
        id: u64,
        black: &str,
        white: &str,
        turn: &str,
        depth: u8,
        exact_from_empties: u8,
    ) -> String {
        format!(
            r#"{{"id":{id},"cmd":"analyze","board":{{"black":"{black}","white":"{white}","turn":"{turn}"}},"limit":{{"depth":{depth},"exactFromEmpties":{exact_from_empties}}},"allMoves":true}}"#
        )
    }

    #[test]
    fn analyze_with_all_moves_true_returns_moves_array_for_all_legal_moves() {
        let mut engine = Engine::new();
        let request = analyze_all_moves_request_json(1, INITIAL_BLACK, INITIAL_WHITE, "black", 4, 10);

        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");

        assert_eq!(response["id"], 1);
        assert_eq!(response["final"], true);
        assert!(response.get("error").is_none());

        let moves = response["moves"].as_array().expect("moves should be an array");
        assert_eq!(moves.len(), 4, "initial position has 4 legal moves");

        let notations: Vec<&str> = moves
            .iter()
            .map(|m| m["move"].as_str().expect("move should be a string"))
            .collect();
        for expected in ["d3", "c4", "f5", "e6"] {
            assert!(
                notations.contains(&expected),
                "expected {expected} to be among moves {notations:?}"
            );
        }

        // 各要素が score/discDiff/type を持ち、discDiff = score/100 であること。
        // 初期局面(exactFromEmpties=10)では、全ての手が探索(midgame)経由
        // で評価されるはず。
        for m in moves {
            let score = m["score"].as_i64().expect("score should be an integer");
            let disc_diff = m["discDiff"].as_f64().expect("discDiff should be a number");
            assert!((disc_diff - score as f64 / 100.0).abs() < 1e-9);
            assert_eq!(m["type"], "midgame");
        }
        assert_eq!(response["score"]["type"], "midgame");

        // トップレベルのpvも、moves先頭(最善手)の記法と一致するはず。
        let pv = response["pv"].as_array().expect("pv should be an array");
        assert_eq!(pv[0].as_str().unwrap(), notations[0]);
    }

    #[test]
    fn analyze_without_all_moves_does_not_include_moves_field() {
        // 後方互換性: allMoves を指定しない既存のリクエストは、
        // レスポンスに `moves` フィールド自体が含まれない。
        let mut engine = Engine::new();
        let request = analyze_request_json(1, INITIAL_BLACK, INITIAL_WHITE, "black", 4, 10);
        let response_json = engine.analyze(&request);
        let response: serde_json::Value = serde_json::from_str(&response_json).unwrap();
        assert!(
            response.get("moves").is_none(),
            "moves field should be absent when allMoves is not specified"
        );
    }

    #[test]
    fn analyze_with_all_moves_true_returns_empty_moves_array_when_no_legal_moves() {
        // 手番側に合法手が無い局面(黒がほぼ全マスを占め、白の合法手が無い)
        // を人工的に構築し、`allMoves:true` を指定してもエラーにならず
        // 空の `moves` 配列を返すことを確認する。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;

        let request = format!(
            r#"{{"id":5,"cmd":"analyze","board":{{"black":"0x{black:x}","white":"0x{white:x}","turn":"white"}},"limit":{{"depth":4,"exactFromEmpties":0}},"allMoves":true}}"#
        );

        let mut engine = Engine::new();
        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");

        assert!(response.get("error").is_none());
        let moves = response["moves"].as_array().expect("moves should be an array");
        assert!(moves.is_empty());
    }

    #[test]
    fn analyze_with_all_moves_true_reports_score_type_matching_actual_evaluation_method_at_boundary() {
        // レビュー指摘(T018フィードバック1件目)の回帰テスト。
        //
        // 現局面の空きマス数がちょうど `exact_from_empties + 1` の境界を
        // 作る。着手すると空きマス数は必ず1減るので、この境界では
        // **全ての合法手が実際には完全読み(exact solver)で評価される**。
        //
        // 修正前のバグでは、トップレベルの `score.type` を「着手前」の
        // 局面の空きマス数 (`empties_before`) と `exact_from_empties` の
        // 比較だけで決めていたため、`empties_before > exact_from_empties`
        // (境界のちょうど1つ上)であるこのケースで `"midgame"` と誤判定
        // していた。修正後は各手の実際の評価方式(`moves[].type`)、および
        // それに基づくトップレベルの `score.type` の両方が `"exact"` に
        // なるはず。
        let (board, side) = play_until_empties(8);
        let empties_before = board.empty_count();
        let exact_threshold = (empties_before - 1) as u8;
        assert_eq!(empties_before, exact_threshold as u32 + 1);

        let black = board.black;
        let white = board.white;
        let turn = if side == Side::Black { "black" } else { "white" };

        let request = format!(
            r#"{{"id":11,"cmd":"analyze","board":{{"black":"0x{black:x}","white":"0x{white:x}","turn":"{turn}"}},"limit":{{"depth":20,"exactFromEmpties":{exact_threshold}}},"allMoves":true}}"#
        );

        let mut engine = Engine::new();
        let response_json = engine.analyze(&request);
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");
        assert!(response.get("error").is_none());

        let moves = response["moves"].as_array().expect("moves should be an array");
        assert!(!moves.is_empty());
        for m in moves {
            assert_eq!(
                m["type"], "exact",
                "every move should be exact-solved at the exact_from_empties+1 boundary"
            );
        }

        assert_eq!(
            response["score"]["type"], "exact",
            "top-level score.type should reflect the actual evaluation method (exact), \
             not just the pre-move empties count"
        );
        assert_eq!(
            response["depth"].as_u64().unwrap(),
            exact_threshold as u64,
            "depth should report the remaining empties after the best move, matching search()'s \
             exact-solve convention"
        );
    }

    #[test]
    fn analyze_with_all_moves_true_respects_time_ms_and_returns_promptly() {
        // レビュー指摘(T018フィードバック2件目)の回帰テスト。
        // time_ms を指定すれば、max_depth が大きくてもエンジンが妥当な
        // 時間で応答を返すことを確認する(性能目標「0.5〜2秒程度」の
        // 土台となるタイムアウト機構が実際に効いていることの疎通確認)。
        let request = format!(
            r#"{{"id":21,"cmd":"analyze","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":20,"timeMs":50,"exactFromEmpties":10}},"allMoves":true}}"#
        );

        let mut engine = Engine::new();
        let start = std::time::Instant::now();
        let response_json = engine.analyze(&request);
        let elapsed = start.elapsed();

        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("response should be valid JSON");
        assert!(response.get("error").is_none());
        let moves = response["moves"].as_array().expect("moves should be an array");
        assert_eq!(moves.len(), 4, "all 4 legal moves should still be present");

        assert!(
            elapsed < std::time::Duration::from_millis(2000),
            "analyze() with allMoves:true should honor timeMs and return well within 2s, took {elapsed:?}"
        );
    }

    #[test]
    fn limit_json_deserializes_optional_max_nodes_with_camel_case_name() {
        let request = format!(
            r#"{{"id":31,"cmd":"analyze","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":12,"timeMs":1500,"maxNodes":160000,"exactFromEmpties":16}}}}"#
        );
        let with_nodes: AnalyzeRequest = serde_json::from_str(&request).unwrap();
        assert_eq!(with_nodes.limit.max_nodes, Some(160_000));

        let legacy: AnalyzeRequest = serde_json::from_str(&analyze_request_json(
            32, INITIAL_BLACK, INITIAL_WHITE, "black", 12, 16,
        ))
        .unwrap();
        assert_eq!(legacy.limit.max_nodes, None);
    }

    #[test]
    fn analyze_rejects_all_moves_with_max_nodes_via_standard_error_response() {
        let request = format!(
            r#"{{"id":33,"cmd":"analyze","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":12,"timeMs":1500,"maxNodes":160000,"exactFromEmpties":16}},"allMoves":true}}"#
        );
        let mut engine = Engine::new();
        let response: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();

        assert_eq!(response["id"], 33);
        assert_eq!(response["error"], "maxNodes is not supported with allMoves: true");
        assert!(response.get("final").is_none());
    }

    /// T139関連の確認: CPU着手経路(`cpuLimit`、`maxNodes`指定)の探索は、
    /// 途中に挟まる無関係な`allMoves: true`リクエスト(表示用analyzeAll、
    /// `search_all_moves_with_eval`経由)の影響を一切受けない。
    ///
    /// T139以前から、`max_nodes.is_some()`分岐は呼び出しのたびに`tt.clear()`
    /// してから探索する実装だったため(このテスト自体もT139より前から
    /// 存在する)、この不変性は元々成立していた。T139では
    /// `search_all_moves_with_eval`が呼び出し元の`tt`(=`Engine`が保持し、
    /// この`maxNodes`分岐とも共有される置換表)を一切読み書きしなくなった
    /// ため、この不変性がより強く(=`tt.clear()`の有無に関わらず)保証される
    /// ようになった。このテストがT139適用後も変更なしに通ることが、
    /// 「表示経路の変更がCPU着手探索(ノード数・選択手)に一切影響しない」
    /// ことの直接的な回帰確認になる。
    #[test]
    fn node_limited_protocol_requests_are_deterministic() {
        const SMOKE_01_BLACK: &str = "0x1030100004080000";
        const SMOKE_01_WHITE: &str = "0x0000241C18100000";
        // debugビルドは本番WASMより大幅に遅く、1500msではwall保険が先に
        // 発火する。releaseでは本番値をそのまま使い、debugではノード予算へ
        // 到達できる猶予を与えてTT状態からの独立性を検証する。
        let time_ms = if cfg!(debug_assertions) { 15_000 } else { 1_500 };
        let request = format!(
            r#"{{"id":34,"cmd":"analyze","board":{{"black":"{SMOKE_01_BLACK}","white":"{SMOKE_01_WHITE}","turn":"black"}},"limit":{{"depth":12,"timeMs":{time_ms},"maxNodes":160000,"exactFromEmpties":16}}}}"#
        );
        let unrelated_request = format!(
            r#"{{"id":35,"cmd":"analyze","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":6,"timeMs":100,"exactFromEmpties":10}},"allMoves":true}}"#
        );
        let weights = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v2.bin"
        ));
        let mut engine = Engine::new();
        engine
            .load_pattern_weights(weights)
            .expect("production pattern weights should load");

        let first: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();
        let second: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();
        let unrelated: serde_json::Value =
            serde_json::from_str(&engine.analyze(&unrelated_request)).unwrap();
        let after_unrelated: serde_json::Value =
            serde_json::from_str(&engine.analyze(&request)).unwrap();

        assert!(first.get("error").is_none());
        assert!(unrelated.get("error").is_none());
        for response in [&second, &after_unrelated] {
            assert_eq!(response["pv"][0], first["pv"][0]);
            assert_eq!(response["score"], first["score"]);
            assert_eq!(response["depth"], first["depth"]);
            assert_eq!(response["nodes"], first["nodes"]);
        }
    }

    /// T139関連の確認: `maxNodes`を指定しないCPU着手経路(`app.tsx`の
    /// `weak`/`normal`レベル、および`strong`レベルの空き20以下の終盤区間が
    /// 使う`ENDGAME_UNLIMITED_LIMIT`。いずれも`search_with_eval`経由で、
    /// `max_nodes.is_some()`分岐のような呼び出し前`tt.clear()`は行わない)も、
    /// 途中に挟まる無関係な`allMoves: true`リクエストの影響を受けないことを
    /// 確認する。
    ///
    /// この経路は`node_limited_protocol_requests_are_deterministic`と異なり、
    /// T139以前は呼び出し前の`tt.clear()`という safety net が無かったため、
    /// `search_all_moves_with_eval`が呼び出し元の`Engine`の共有TTを読み書き
    /// していた旧実装のままだと、この経路の探索結果(ノード数・最善手)が
    /// 直前のanalyzeAll呼び出しの有無・順序に依存しうる、より脆弱な経路
    /// だった。T139で`search_all_moves_with_eval`が呼び出し元のTTを一切
    /// 読み書きしなくなったことで、この経路もTT状態から完全に独立する。
    ///
    /// 注意: この経路は`maxNodes`分岐と異なり呼び出し前に`tt.clear()`を
    /// 行わないため、同一リクエストを繰り返すだけでも(前回の探索が
    /// 残したTTエントリのおかげで)2回目以降はノード数が減る、という
    /// **意図した**挙動がある(これはバグではない)。そのためこのテストは
    /// 「1回目」との比較ではなく、「2回目(間に無関係な呼び出しを挟まない)」
    /// と「4回目(間にallMovesを挟む)」を比較する。
    ///
    /// 訂正(T145、レビュー指摘L1): 以前のコメントは「両者とも直前の1回目が
    /// 残したTT状態を引き継ぐ点は同じ」と書いていたが、これは厳密には
    /// 不正確だった。実際には`second`(2回目)は「1回目」が残したTT状態から
    /// 始まるのに対し、`after_unrelated`(4回目)は「1回目→2回目」の後の
    /// TT状態(allMovesはT139によりTTを一切読み書きしないため3回目の影響は
    /// 無いが、2回目自身が追加したエントリの影響は残る)から始まる。したがって
    /// この2つの開始TT状態が一致すると言えるのは、**2回目の呼び出しで
    /// 探索が到達するTTエントリの集合が1回目終了時点からすでに不動点に
    /// 達している(=2回目が新たに意味のあるエントリを追加しない)**という
    /// 経験的な前提があるからである(この局面・limitの組み合わせで実際に
    /// 成立することを本テストで確認している)。この前提が崩れる変更を
    /// 加えた場合、本テストは`second`と`after_unrelated`のノード数不一致
    /// という形で(allMovesの影響とは無関係な理由で)フレーキーに落ちうる
    /// ことに注意。それでも「間に挟むallMovesの有無だけが両者の差分」で
    /// あることに変わりはなく、この2つが完全一致することは引き続き
    /// 「allMovesがこの経路に一切影響しない」ことの確認になる。
    #[test]
    fn node_unlimited_protocol_requests_are_deterministic_even_without_a_pre_clear() {
        const SMOKE_01_BLACK: &str = "0x1030100004080000";
        const SMOKE_01_WHITE: &str = "0x0000241C18100000";
        let request = format!(
            r#"{{"id":36,"cmd":"analyze","board":{{"black":"{SMOKE_01_BLACK}","white":"{SMOKE_01_WHITE}","turn":"black"}},"limit":{{"depth":8,"exactFromEmpties":12}}}}"#
        );
        let unrelated_request = format!(
            r#"{{"id":37,"cmd":"analyze","board":{{"black":"{INITIAL_BLACK}","white":"{INITIAL_WHITE}","turn":"black"}},"limit":{{"depth":6,"timeMs":100,"exactFromEmpties":10}},"allMoves":true}}"#
        );
        let weights = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v2.bin"
        ));
        let mut engine = Engine::new();
        engine
            .load_pattern_weights(weights)
            .expect("production pattern weights should load");

        let _first: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();
        let second: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();
        let unrelated: serde_json::Value =
            serde_json::from_str(&engine.analyze(&unrelated_request)).unwrap();
        let after_unrelated: serde_json::Value =
            serde_json::from_str(&engine.analyze(&request)).unwrap();

        assert!(_first.get("error").is_none());
        assert!(unrelated.get("error").is_none());
        assert!(second.get("error").is_none());
        assert_eq!(after_unrelated["pv"][0], second["pv"][0]);
        assert_eq!(after_unrelated["score"], second["score"]);
        assert_eq!(after_unrelated["depth"], second["depth"]);
        assert_eq!(
            after_unrelated["nodes"], second["nodes"],
            "an intervening allMoves:true request must not change this path's node count at all"
        );
    }

    /// T145(M2、T139レビュー指摘): `search.rs`の
    /// `search_all_moves_from_initial_position_gives_the_four_d4_symmetric_opening_moves_identical_scores`
    /// は`weights=None`(3項ヒューリスティック評価)でのみ対称性を検証しており、
    /// 本番構成(`Engine::load_pattern_weights`でパターン重みをロードした状態)
    /// での自動テストが欠落していた(レビュー指摘M2)。
    ///
    /// # 対称性(D4値一致)テストではなく決定性テストにした理由
    /// 当初はこの箇所に、上記`search.rs`のテストと同じ「初期局面4合法手の
    /// analyzeAll値が完全一致する」というD4対称性テストを本番重み構成
    /// (`pattern_v2.bin`)で追加する予定だった(タスク仕様の元々の想定)。
    /// しかし実際に実装して実行したところ、**本番重みを使うと4手のスコアは
    /// 実際には一致しない**ことを確認した(このテストの前身は
    /// `assertion left == right failed: ... c4 (score=-489) ... d3's score
    /// (-151)`で落ちた)。追加調査で判明した事実:
    ///
    /// - `depth=1`(MPCの`mpc::MIN_DEPTH`=5未満、MPCは一切発動しない)時点で
    ///   既に4手のスコアが大きく乖離する(`pattern_v2.bin`、
    ///   `exactFromEmpties=0`: d3=-765, c4=-1167, f5=-438, e6=-37)。
    ///   つまりこの乖離は`ordered_moves`のタイブレークやMPCの近似枝刈りとは
    ///   無関係に、**静的評価(`PatternWeights::score`)そのものの
    ///   D4非不変性だけで**既に生じる。
    /// - `depth=12`(`app.tsx`の「強い」CPUレベルが実際に使う設定、
    ///   `exactFromEmpties=16`)でも、`pattern_v2.bin`で最大約0.09disc、
    ///   `pattern_v3.bin`(本番配信中の重み)で最大約1.45disc相当の乖離が残る。
    ///
    /// これは`pattern_eval.rs`のコメント(T145で訂正)が説明する
    /// `compute_pattern_classes`のD4不変性の破れが、机上の理論的な懸念に
    /// 留まらず、本番重み構成では実際に(かつMPCとは独立に)効いている
    /// ことを裏付ける。したがって「対称局面同値」を本番重み構成で保証する
    /// テストは原理的に書けない(書けたとしても、たまたま特定のdepth・
    /// 重みバージョンで乖離が小さかっただけの偶然の一致に依存する脆い
    /// テストになり、重みの再学習(v4以降)で簡単に壊れる)。この点は
    /// タスク仕様(T145)の元々の想定と食い違うため、完了報告でオーケストレー
    /// ターに明示的に申し送る。
    ///
    /// 代わりに本テストは、T139が実際に保証した性質(`search_all_moves_with_eval`
    /// が呼び出し元の`Engine`が保持するTTの状態に一切依存しないこと)を、
    /// 本番重み構成下で直接検証する。`search.rs`の対応テスト
    /// (`search_all_moves_is_deterministic_across_repeated_calls_even_with_a_prewarmed_local_state`)
    /// は`weights=None`だが、こちらは本番重みロード経路
    /// (`Engine::load_pattern_weights`、既存テストに倣いpattern_v2.binを使用)
    /// を通す点が異なる。
    #[test]
    fn analyze_all_moves_from_initial_position_is_deterministic_with_production_weights_loaded() {
        const SMOKE_01_BLACK: &str = "0x1030100004080000";
        const SMOKE_01_WHITE: &str = "0x0000241C18100000";

        let weights = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../train/weights/pattern_v2.bin"
        ));
        let mut engine = Engine::new();
        engine
            .load_pattern_weights(weights)
            .expect("production pattern weights should load");

        // 事前にTTを汚す先行探索(無関係な局面のallMoves)を挟む。
        let warmup_request = format!(
            r#"{{"id":40,"cmd":"analyze","board":{{"black":"{SMOKE_01_BLACK}","white":"{SMOKE_01_WHITE}","turn":"black"}},"limit":{{"depth":10,"exactFromEmpties":12}},"allMoves":true}}"#
        );
        let request =
            analyze_all_moves_request_json(41, INITIAL_BLACK, INITIAL_WHITE, "black", 10, 12);

        let warmup: serde_json::Value =
            serde_json::from_str(&engine.analyze(&warmup_request)).unwrap();
        let first: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();
        let second: serde_json::Value = serde_json::from_str(&engine.analyze(&request)).unwrap();

        assert!(warmup.get("error").is_none());
        assert!(first.get("error").is_none());
        assert!(second.get("error").is_none());

        let first_moves = first["moves"].as_array().expect("moves should be an array");
        assert_eq!(first_moves.len(), 4, "initial position has 4 legal moves");
        assert_eq!(
            first["moves"], second["moves"],
            "with production pattern weights loaded, repeating the same analyzeAll request \
             (with an unrelated allMoves request warming the engine's shared TT beforehand) \
             should give byte-for-byte identical results, regardless of prior TT activity"
        );
    }
}

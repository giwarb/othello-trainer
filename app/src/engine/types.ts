// Web Worker <-> UIスレッド間、および WASM Engine とのJSON入出力プロトコル型定義。
// リクエスト/レスポンスの形状は `engine/src/protocol.rs`(T008)と一致させること。
// 参照: tasks/T008-wasm-api.md, tasks/T012-worker-engine.md

/** 手番。Rust側の `Side`(`"black"` | `"white"`)と対応する。 */
export type Side = 'black' | 'white';

/**
 * UIスレッド側で扱う盤面表現。
 * `black`/`white` は64bitのビットボードを `bigint` として保持する。
 * Workerに送る際は `hex.ts` の `bigintToHex` で `0x`始まりの16進文字列に変換する。
 */
export interface Board {
  black: bigint;
  white: bigint;
}

/** リクエストの `board` フィールド(JSON化後、Worker/Engineに渡す形)。 */
export interface BoardJson {
  black: string;
  white: string;
  turn: Side;
}

/** 探索の打ち切り条件。`engine/src/protocol.rs` の `LimitJson` と対応する。 */
export interface AnalyzeLimit {
  depth: number;
  /** 省略可能。指定しない場合はエンジン側で `depth` のみを打ち切り条件とする。 */
  timeMs?: number;
  exactFromEmpties: number;
}

/** Engine/Workerへ送る `analyze` コマンドのリクエスト全体。 */
export interface AnalyzeRequestMessage {
  id: number;
  cmd: 'analyze';
  board: BoardJson;
  limit: AnalyzeLimit;
  /**
   * `true` の場合、最善手1つではなく現局面の全合法手の評価値を
   * `moves` フィールドとして返してもらう(T018)。省略時は `false` 相当
   * (既存の `analyze` と同じ挙動)。
   */
  allMoves?: boolean;
}

/** レスポンスの `score` フィールド。 */
export interface ScoreJson {
  type: 'midgame' | 'exact';
  discDiff: number;
}

/**
 * `moves` 配列(T018: `allMoves: true` 指定時のみレスポンスに含まれる)の
 * 各要素。現局面のある1つの合法手についての評価値を表す。
 * `engine/src/protocol.rs` の `MoveEvalJson` と対応する。
 */
export interface MoveEvalJson {
  /** 着手先マスの記法(`"a1"`〜`"h8"`)。 */
  move: string;
  /** 評価値。centi-disc単位(1石=100)、手番視点。 */
  score: number;
  discDiff: number;
  /**
   * この手が実際にどちらの方式で評価されたか(`ScoreJson.type` と同じ語彙)。
   * `"exact"` = 終盤完全読み、`"midgame"` = 中盤探索。着手前の局面の空きマス数
   * ではなく、この手について実際に使われた評価方式を表す
   * (レビュー指摘によりT018で追加。`engine/src/protocol.rs` の `eval_kind` 参照)。
   */
  type: 'midgame' | 'exact';
}

/**
 * `analyze` コマンドの正常応答。
 * 本タスク(T012)・T008ともに逐次進捗報告はスコープ外のため `final` は常に `true`。
 * `moves` は `allMoves: true` を指定したリクエストに対してのみ含まれる(T018)。
 */
export interface AnalyzeResponseMessage {
  id: number;
  final: true;
  depth: number;
  pv: string[];
  score: ScoreJson;
  nodes: number;
  nps: number;
  moves?: MoveEvalJson[];
}

/** エンジン側でエラーが発生した場合の応答。JSON構文エラー等で `id` が読み取れない場合は `null`。 */
export interface ErrorResponseMessage {
  id: number | null;
  error: string;
}

/** Workerから返ってくるメッセージ(正常応答またはエラー応答)。 */
export type EngineResponseMessage = AnalyzeResponseMessage | ErrorResponseMessage;

/** `EngineResponseMessage` がエラー応答かどうかを判定する型ガード。 */
export function isErrorResponse(message: EngineResponseMessage): message is ErrorResponseMessage {
  return 'error' in message;
}

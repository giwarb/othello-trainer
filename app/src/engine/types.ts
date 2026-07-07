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
}

/** レスポンスの `score` フィールド。 */
export interface ScoreJson {
  type: 'midgame' | 'exact';
  discDiff: number;
}

/**
 * `analyze` コマンドの正常応答。
 * 本タスク(T012)・T008ともに逐次進捗報告はスコープ外のため `final` は常に `true`。
 */
export interface AnalyzeResponseMessage {
  id: number;
  final: true;
  depth: number;
  pv: string[];
  score: ScoreJson;
  nodes: number;
  nps: number;
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

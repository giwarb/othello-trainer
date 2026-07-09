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

// ---------------------------------------------------------------------
// T031: 特徴量層・評価内訳分解層(`Engine::explain`、`engine/src/explain.rs`)
// ---------------------------------------------------------------------

/**
 * `evalTerms` コマンドのリクエスト。現行評価関数(`eval.rs`)の3項
 * (モビリティ差・隅差・安定石差)の生の特徴量差分と、重み適用済みの3項を
 * 1局面ぶん取得する。
 *
 * 【T031やり直し1回目・must 2対応】以前は生の特徴量差分のみを返し、加重
 * (重み定数の適用)はTypeScript側(`app/src/analysis/attribution.ts`)で
 * 行っていたが、TS側が`eval.rs`の重み定数を複製する必要がありdrift
 * (Rust側の重みが変わってもTS側が無言でズレる)のリスクがあった
 * (reviewer/verifier指摘)。修正: Rust側(`engine/src/explain.rs`)で
 * 重み適用まで完了させ、`mobilityTerm`/`cornerTerm`/`stableTerm`
 * (加重後、centi-disc単位)を追加フィールドとして返す。TS側はこれらの値を
 * 差し引くだけでよく、重み定数を一切知らずに済む(`attribution.ts`
 * モジュール冒頭のコメント参照)。
 */
export interface EvalTermsRequestMessage {
  id: number;
  cmd: 'evalTerms';
  board: BoardJson;
}

/** `evalTerms` コマンドの正常応答。`engine/src/explain.rs` の `EvalTermsResponse` と対応する。 */
export interface EvalTermsResponseMessage {
  id: number;
  final: true;
  /** 黒視点(黒が多い/有利なら正)の着手可能数差。 */
  mobilityDiff: number;
  /** 黒視点の隅の保有数差。 */
  cornerDiff: number;
  /** 黒視点の安定石(確定石、簡易判定)差。 */
  stableDiff: number;
  /** `mobilityDiff * eval::MOBILITY_WEIGHT`(黒視点、centi-disc単位、1石=100)。 */
  mobilityTerm: number;
  /** `cornerDiff * eval::CORNER_WEIGHT`(黒視点、centi-disc単位)。 */
  cornerTerm: number;
  /** `stableDiff * eval::STABLE_WEIGHT`(黒視点、centi-disc単位)。 */
  stableTerm: number;
  /** `eval::evaluate` の生の出力(黒視点、centi-disc単位、1石=100)。`mobilityTerm + cornerTerm + stableTerm` と厳密に一致する。 */
  evaluateBlack: number;
}

/**
 * `featureSet` コマンドのリクエスト。設計書§1「特徴量層」の12特徴量のうち
 * Rust側(`engine/src/explain.rs`)で計算する11個(余裕手を除く)を、
 * ある局面である1手について取得する。
 */
export interface FeatureSetRequestMessage {
  id: number;
  cmd: 'featureSet';
  board: BoardJson;
  /** 着手先マスの記法("a1"〜"h8")。`board` の手番にとって合法手である必要がある。 */
  move: string;
}

/** 辺の形の簡易分類(`engine/src/explain.rs` の `EdgeShapeKind` と対応)。 */
export type EdgeShapeKind = 'block' | 'both_corners_open' | 'wing' | 'one_corner_open' | 'open';

export interface EdgeShapeJson {
  edge: 'top' | 'bottom' | 'left' | 'right';
  shape: EdgeShapeKind;
  emptyCount: number;
}

export interface CornerRiskJson {
  kind: 'x' | 'c';
  corner: string;
  stableRisk: number;
}

export interface ParityRegionJson {
  size: number;
  parity: 'odd' | 'even';
  squares: string[];
}

export interface LineJson {
  name: 'main_diagonal' | 'anti_diagonal';
  mover: number;
  opponent: number;
  empty: number;
}

/** 設計書§1「特徴量層」の12特徴量のうちRust側で計算する11個(余裕手を除く)。 */
export interface FeatureSetJson {
  mobilityDiff: number;
  moverMobilityBefore: number;
  opponentMobilityBefore: number;
  opponentMobilityAfter: number;
  moverMobilityAfter: number;
  potentialMobilityDiff: number;
  openness: number;
  isUchiwari: boolean;
  frontierDiff: number;
  newOpponentMoves: string[];
  lostOwnMoves: string[];
  stableDiff: number;
  edgeShapes: EdgeShapeJson[];
  cornerRisk: CornerRiskJson | null;
  parityRegions: ParityRegionJson[];
  seedStones: string[];
  lines: LineJson[];
}

/** `featureSet` コマンドの正常応答。 */
export interface FeatureSetResponseMessage {
  id: number;
  final: true;
  features: FeatureSetJson;
}

/** Workerから返ってくるメッセージ(正常応答またはエラー応答)。 */
export type EngineResponseMessage =
  | AnalyzeResponseMessage
  | EvalTermsResponseMessage
  | FeatureSetResponseMessage
  | ErrorResponseMessage;

/** Workerへ送るメッセージ全体(コマンド種別で分岐する)。 */
export type EngineRequestMessage = AnalyzeRequestMessage | EvalTermsRequestMessage | FeatureSetRequestMessage;

/** `EngineResponseMessage` がエラー応答かどうかを判定する型ガード。 */
export function isErrorResponse(message: EngineResponseMessage): message is ErrorResponseMessage {
  return 'error' in message;
}

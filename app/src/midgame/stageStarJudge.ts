/**
 * T141: 中盤練習「ステージクリア型」の★判定(要件4)。
 *
 * ユーザー原文(2026-07-19朝): 「評価値が常に出ているようにして、3回応手しあう。
 * 評価値が5以上減らなければ★、評価値が1以上減らなければ★★、すべて最善手を
 * 打ち返し続けられたら★★★という感じのステージクリア型にしたい。」
 *
 * オーケストレーター裁定により、損失は「開始時評価値 − 終了時評価値」
 * (プレイヤー視点、同一エンジン設定`MIDGAME_ANALYZE_LIMIT`で計測)で測る。
 * ★3(「3手すべて最善手」)は、3手全てが打てて(=セッションが3往復完走して)
 * かつ全て`isBest`だった場合のみ成立する。3手未満で終了した場合(要件2
 * 「途中で終局・打てる手なし等の場合はその時点で終了し、打てたぶんで判定」)は
 * 文字どおり「3手すべて」を満たしようがないため、損失ベースの閾値(★0〜★2)
 * にフォールバックする(判断根拠: 仕様の「3手すべてが最善手」という文言を
 * 字義どおりに解釈した。3手未満でも損失が小さければ★1・★2は引き続き
 * 獲得できる)。
 *
 * ★の優先順位(高い方から): ★3(3手全て最善) > 損失<1(★2) > 損失<5(★1) > それ以外(★0)。
 * 「全手最善」の場合、理論上は損失もほぼ0になるはずだが(同一エンジン設定での
 * 探索深さの僅かなブレによる例外はありうる)、仕様の文言どおり★3判定を
 * 損失閾値より優先する。
 */

/** ステージクリアの★数(0=失敗)。 */
export type Stars = 0 | 1 | 2 | 3

/** 浮動小数点誤差対策(「最善手と同値」とみなす許容誤差、`judgeMidgameMove.ts`と同じ考え方で独立に定義)。 */
const BEST_EPSILON = 1e-9

/** 損失(石差)が「最善手と同値」とみなせるかどうか。 */
export function isBestMove(lossDiscs: number): boolean {
  return lossDiscs <= BEST_EPSILON
}

/** 1手ぶんの結果(★判定に必要な最小限の情報)。 */
export interface StageMoveOutcome {
  /** その手番時点での最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** `isBestMove(lossDiscs)`と同じ(呼び出し側が既に計算済みの値をそのまま渡す)。 */
  readonly isBest: boolean
}

export interface ComputeStageStarsInput {
  /** セッション開始時(プレイヤーの1手目を打つ前)の評価値、プレイヤー視点。 */
  readonly startEval: number
  /** セッション終了時(3往復完走後、または途中終局時)の評価値、プレイヤー視点。 */
  readonly endEval: number
  /** プレイヤーが実際に打てた手の結果(0〜3件、順序どおり)。 */
  readonly moveOutcomes: readonly StageMoveOutcome[]
}

/** 1回の挑戦セッションから★数を求める(要件4)。 */
export function computeStageStars(input: ComputeStageStarsInput): Stars {
  const { startEval, endEval, moveOutcomes } = input
  const lossTotal = Math.max(0, startEval - endEval)
  const allBest = moveOutcomes.length === 3 && moveOutcomes.every((move) => move.isBest)

  if (allBest) return 3
  if (lossTotal < 1) return 2
  if (lossTotal < 5) return 1
  return 0
}

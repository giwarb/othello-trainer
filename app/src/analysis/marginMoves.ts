/**
 * T031「特徴量層」(§1)の特徴量10「余裕手」。
 *
 * 定義(`othello-trainer-design-verbalization.md` §1.1): 「打っても形が悪化
 * しない手の数(浅い評価でロス<0.5の手を数える)」。
 *
 * タスク仕様の要件2は、この特徴量の実装場所を「エンジンの浅い探索呼び出しが
 * 必要になるため、既存の`requestAnalyzeAll`相当の情報を使う設計にしてよい
 * (Rust側で完結させる必要はない。TS側で計算してもよい)」と明示的に許容して
 * いる。`requestAnalyzeAll`(`app/src/engine/client.ts`)は現局面の全合法手の
 * 評価値(`MoveEvalJson[]`、石差単位の`discDiff`を含む)を1回のエンジン呼び出しで
 * 返す既存APIであり、これをそのまま再利用する(エンジン呼び出し自体は
 * 呼び出し側の責務とし、本モジュールは`whyBad.ts`/`comparePv.ts`と同じ方針で
 * 副作用のない純粋関数のみで構成する)。
 *
 * 【T031やり直し1回目・must 1対応】1回目の実装では本特徴量が未実装のまま
 * 完了報告されていた(reviewer/verifier指摘、
 * `tasks/T031-feature-layer-attribution.md`のフィードバック参照)。本ファイルで
 * 実装し、個別の単体テスト(`marginMoves.test.ts`)で検証する。
 */

/** 「余裕手」と判定するロスの閾値(石差単位)。設計書の定義どおり0.5石未満。 */
export const MARGIN_MOVE_LOSS_THRESHOLD = 0.5

/** `countMarginMoves`が受け取る、1手ぶんの評価値の最小限の形。 */
export interface MoveEvalLike {
  readonly discDiff: number
}

/**
 * 現局面の全合法手の評価値(`requestAnalyzeAll`の応答、または同じ形の配列)から、
 * 「余裕手」(最善手からのロスが`MARGIN_MOVE_LOSS_THRESHOLD`(0.5石)未満の手)の
 * 数を数える。
 *
 * 最善手そのもの(ロス0)も余裕手に含まれる(ロス<0.5を満たすため)。
 * `moveEvals`が空(合法手なし、終局・要求側の異常)の場合は0を返す。
 */
export function countMarginMoves(moveEvals: readonly MoveEvalLike[]): number {
  if (moveEvals.length === 0) return 0

  const best = Math.max(...moveEvals.map((m) => m.discDiff))
  return moveEvals.filter((m) => best - m.discDiff < MARGIN_MOVE_LOSS_THRESHOLD).length
}

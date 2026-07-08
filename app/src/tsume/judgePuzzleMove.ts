/**
 * 詰めオセロプレイモードにおけるプレイヤーの着手判定(T028、要件2)。
 *
 * 設計書§5.3「プレイ仕様」の「着手 → 即時完全読みで最善維持か判定」を実装する
 * 純粋関数。`EngineClient.requestAnalyzeAll`(着手前局面・完全読み)が返す
 * `MoveEvalJson[]`(手番側視点の最終石差、以後の最適進行込み)と、実際に
 * プレイヤーが打った手を突き合わせて判定する。
 *
 * `MoveEvalJson.discDiff` は「その手を打った場合の局面評価(手番側から見た
 * 最終石差、以後の最適進行を織り込んだ値)」であり(`midgame/judgeMidgameMove.ts`
 * と同じ規約)、詰めオセロの完全読みでは常に `type === 'exact'` になる
 * (`PlayMode.tsx` が `exactFromEmpties` を問題の空きマス数以上に設定して呼ぶため)。
 *
 * 「最善結果を維持しているか」は、着手前局面の全合法手中の最大値(`best`)と
 * プレイヤーが打った手の値が一致するか(浮動小数点誤差を許容)で判定する。
 * ミニマックスの定義上、相手(エンジン)が常に「最も粘る手」(自分にとっての
 * 最善手 = プレイヤーにとっての最小化)を選ぶ前提であれば、これは
 * 「出題局面のbestDiscDiffを維持し続けているか」の判定として厳密に妥当。
 */

import type { MoveEvalJson } from '../engine/types.ts'

/** `discDiff` が「同値」とみなす許容誤差(浮動小数点誤差対策)。 */
const EPSILON = 1e-9

export interface JudgePuzzleMoveResult {
  /** 最善結果を維持していれば `true`。 */
  readonly correct: boolean
  /** プレイヤーが打った手("a1"〜"h8"記法)。 */
  readonly playedMove: string
  /** プレイヤーが打った手の評価値(石差)。`allMoves` に見つからない場合は `null`。 */
  readonly playedDiscDiff: number | null
  /** 最善手の記法。`allMoves` が空の場合は `null`。 */
  readonly bestMove: string | null
  /** 最善手の評価値(石差)。`allMoves` が空の場合は `null`。 */
  readonly bestDiscDiff: number | null
  /** 最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
}

/**
 * 着手前局面の全合法手評価(`allMoves`、手番側視点)と、実際にプレイヤーが
 * 打った手(`playedMove`)から、最善結果を維持しているかを判定する。
 *
 * - `allMoves` が空(合法手なし)の場合は `correct: false` を返す
 *   (通常は呼び出し側で合法手なしをパス扱いするため到達しない防御的分岐)。
 * - `playedMove` が `allMoves` に見つからない場合(呼び出し側の不整合)も
 *   `correct: false` を返す。
 */
export function judgePuzzleMove(
  allMoves: readonly MoveEvalJson[],
  playedMove: string,
): JudgePuzzleMoveResult {
  if (allMoves.length === 0) {
    return {
      correct: false,
      playedMove,
      playedDiscDiff: null,
      bestMove: null,
      bestDiscDiff: null,
      lossDiscs: 0,
    }
  }

  const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
  const played = allMoves.find((m) => m.move === playedMove)
  const playedDiscDiff = played?.discDiff ?? null
  const lossDiscs = played ? Math.max(0, best.discDiff - played.discDiff) : Math.max(0, best.discDiff)

  return {
    correct: played !== undefined && lossDiscs <= EPSILON,
    playedMove,
    playedDiscDiff,
    bestMove: best.move,
    bestDiscDiff: best.discDiff,
    lossDiscs,
  }
}

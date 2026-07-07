/**
 * 定石練習モードにおけるプレイヤーの着手判定(T020)。
 *
 * 設計書§2.6.2の要件3を実装する純粋関数。
 * - `bookMoves` に含まれる手を打った → 続行(`kind: 'inBook'`)。
 * - 含まれない手を打った場合、T018の `requestAnalyzeAll` が返す現局面の
 *   全合法手評価(`allMoves`)からプレイヤーの手と最善手の評価差(石差ロス)を
 *   計算し、ロス<1.0なら `'offBookClose'`(定石外・惜しい)、
 *   ロス>=1.0なら `'blunder'`(悪手)と判定する。
 *   本タスクの要件どおり、いずれの場合も呼び出し側でゲームオーバー扱いとする
 *   (このモジュール自体はゲーム進行を管理しない)。
 *
 * `requestAnalyzeAll` そのものは呼ばず、既に取得済みの結果(`allMoves`)を
 * 引数として受け取るだけなので、非同期処理・エンジン呼び出しは一切行わない
 * (単体テストではモックした `MoveEvalJson[]` を直接渡せる)。
 */

import type { MoveEvalJson } from '../engine/types.ts'
import { squareToNotation } from '../game/othello.ts'
import type { JosekiBookMoveView } from './lookup.ts'

/** 定石外判定の閾値(石差ロス)。これ未満なら「惜しい」、以上なら「悪手」。 */
export const OFF_BOOK_CLOSE_THRESHOLD = 1.0

export interface JudgeMoveInBook {
  readonly kind: 'inBook'
}

/** 定石外(共通フィールド)。 */
export interface JudgeMoveOffBook {
  readonly kind: 'offBookClose' | 'blunder'
  /** 最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** 最善手の記法("a1"〜"h8")。全合法手評価が空の場合は `null`。 */
  readonly bestMove: string | null
  /** プレイヤーが打った手の評価値(石差)。評価が見つからない場合は `null`。 */
  readonly playedDiscDiff: number | null
  /** この局面での定石内の正解手(参考表示用)。 */
  readonly correctMoves: readonly JosekiBookMoveView[]
}

export type MoveJudgement = JudgeMoveInBook | JudgeMoveOffBook

/**
 * プレイヤーの着手 (`playedSquare`) を判定する。
 *
 * @param bookMoves 現局面(着手前)の定石DBノードの候補手(実盤面座標)。
 * @param playedSquare プレイヤーが実際に打ったマス(0〜63)。
 * @param allMoves 着手前の局面に対する `requestAnalyzeAll` の結果(現局面の全合法手評価)。
 *   `bookMoves` に含まれる手を打った場合は参照されない。
 */
export function judgeMove(
  bookMoves: readonly JosekiBookMoveView[],
  playedSquare: number,
  allMoves: readonly MoveEvalJson[],
): MoveJudgement {
  if (bookMoves.some((bm) => bm.move === playedSquare)) {
    return { kind: 'inBook' }
  }

  if (allMoves.length === 0) {
    return {
      kind: 'blunder',
      lossDiscs: 0,
      bestMove: null,
      playedDiscDiff: null,
      correctMoves: bookMoves,
    }
  }

  const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
  const playedNotation = squareToNotation(playedSquare)
  const played = allMoves.find((m) => m.move === playedNotation)

  const lossDiscs = played ? Math.max(0, best.discDiff - played.discDiff) : Math.max(0, best.discDiff)
  const kind = lossDiscs < OFF_BOOK_CLOSE_THRESHOLD ? 'offBookClose' : 'blunder'

  return {
    kind,
    lossDiscs,
    bestMove: best.move,
    playedDiscDiff: played?.discDiff ?? null,
    correctMoves: bookMoves,
  }
}

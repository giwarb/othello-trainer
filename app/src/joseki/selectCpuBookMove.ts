/** T093: CPU opening-book move selection for play mode. */

import type { Board, Side } from '../game/othello.ts'
import { lookupJosekiNode } from './lookup.ts'
import { pickBookMove } from './pickBookMove.ts'
import type { JosekiDb } from './types.ts'

/** Returns a weighted book move, or null when this position has no continuation. */
export function selectCpuBookMove(
  db: JosekiDb,
  board: Board,
  sideToMove: Side,
  firstMoveSquare: number,
  random: () => number = Math.random,
): number | null {
  try {
    const lookup = lookupJosekiNode(db, board, sideToMove, firstMoveSquare)
    if (!lookup || lookup.bookMoves.length === 0) return null
    return pickBookMove(lookup.bookMoves, random)
  } catch {
    return null
  }
}

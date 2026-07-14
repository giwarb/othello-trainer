import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare, opposite, type Side } from '../game/othello.ts'
import { buildJosekiDb } from './buildDb.ts'
import { denormalizeSquare, opForFirstMove } from './normalize.ts'
import { selectCpuBookMove } from './selectCpuBookMove.ts'
import type { RawJosekiLine } from './types.ts'

const lines: RawJosekiLine[] = [
  { name: 'line-a', moves: ['f5', 'd6', 'c3'], firstMoveBasis: 'f5', depth: 3 },
  { name: 'line-b', moves: ['f5', 'f6', 'e6'], firstMoveBasis: 'f5', depth: 3 },
]

describe('selectCpuBookMove', () => {
  const db = buildJosekiDb(lines)

  it('normalizes by the actual first move and returns a real-board square', () => {
    const firstMove = notationToSquare('d3')
    const op = opForFirstMove(firstMove)
    const board = applyMove(initialBoard(), 'black', firstMove)

    const selected = selectCpuBookMove(db, board, 'white', firstMove, () => 0)

    expect(selected).toBe(denormalizeSquare(notationToSquare('d6'), op))
  })

  it('selects according to the candidate weights', () => {
    const firstMove = notationToSquare('f5')
    const board = applyMove(initialBoard(), 'black', firstMove)

    expect(selectCpuBookMove(db, board, 'white', firstMove, () => 0)).toBe(notationToSquare('d6'))
    expect(selectCpuBookMove(db, board, 'white', firstMove, () => 0.999)).toBe(notationToSquare('f6'))
  })

  it('returns null for an off-book position or a node without continuations', () => {
    let board = initialBoard()
    let side: Side = 'black'
    for (const move of ['f5', 'd6', 'c3']) {
      board = applyMove(board, side, notationToSquare(move))
      side = opposite(side)
    }

    expect(selectCpuBookMove(db, board, side, notationToSquare('f5'))).toBeNull()
    expect(selectCpuBookMove(db, initialBoard(), 'black', notationToSquare('a1'))).toBeNull()
  })
})

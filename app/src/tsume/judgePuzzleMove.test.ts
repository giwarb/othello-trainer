import { describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { judgePuzzleMove } from './judgePuzzleMove.ts'

function moveEval(move: string, discDiff: number): MoveEvalJson {
  return { move, score: discDiff * 100, discDiff, type: 'exact' }
}

describe('judgePuzzleMove', () => {
  it('打った手が最善(discDiff最大)なら正解と判定する', () => {
    const allMoves = [moveEval('a1', 4), moveEval('b2', 10), moveEval('c3', -2)]
    const result = judgePuzzleMove(allMoves, 'b2')

    expect(result.correct).toBe(true)
    expect(result.bestMove).toBe('b2')
    expect(result.bestDiscDiff).toBe(10)
    expect(result.playedDiscDiff).toBe(10)
    expect(result.lossDiscs).toBe(0)
  })

  it('打った手が最善でなければ不正解と判定し、ロス幅を返す', () => {
    const allMoves = [moveEval('a1', 4), moveEval('b2', 10), moveEval('c3', -2)]
    const result = judgePuzzleMove(allMoves, 'a1')

    expect(result.correct).toBe(false)
    expect(result.bestMove).toBe('b2')
    expect(result.playedDiscDiff).toBe(4)
    expect(result.lossDiscs).toBe(6)
  })

  it('同点の最善手が複数ある場合、そのいずれを打っても正解と判定する', () => {
    const allMoves = [moveEval('a1', 8), moveEval('b2', 8), moveEval('c3', 2)]

    expect(judgePuzzleMove(allMoves, 'a1').correct).toBe(true)
    expect(judgePuzzleMove(allMoves, 'b2').correct).toBe(true)
    expect(judgePuzzleMove(allMoves, 'c3').correct).toBe(false)
  })

  it('allMovesが空配列の場合は不正解とし、bestMove/playedDiscDiffはnullを返す', () => {
    const result = judgePuzzleMove([], 'a1')

    expect(result.correct).toBe(false)
    expect(result.bestMove).toBeNull()
    expect(result.bestDiscDiff).toBeNull()
    expect(result.playedDiscDiff).toBeNull()
    expect(result.lossDiscs).toBe(0)
  })

  it('playedMoveがallMovesに含まれない場合(呼び出し側の不整合)は不正解と判定する', () => {
    const allMoves = [moveEval('a1', 4), moveEval('b2', 10)]
    const result = judgePuzzleMove(allMoves, 'z9')

    expect(result.correct).toBe(false)
    expect(result.playedDiscDiff).toBeNull()
    expect(result.bestMove).toBe('b2')
  })
})

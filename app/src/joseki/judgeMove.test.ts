import { describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { notationToSquare } from '../game/othello.ts'
import { judgeMove } from './judgeMove.ts'
import type { JosekiBookMoveView } from './lookup.ts'

const bookMoves: JosekiBookMoveView[] = [
  { move: notationToSquare('d3'), weight: 0.5 },
  { move: notationToSquare('c4'), weight: 0.5 },
]

describe('judgeMove', () => {
  it('定石内の手を打った場合は inBook を返す(requestAnalyzeAllの結果は参照しない)', () => {
    const result = judgeMove(bookMoves, notationToSquare('d3'), [])
    expect(result).toEqual({ kind: 'inBook' })
  })

  it('定石外だが石差ロス<1.0なら offBookClose(定石外・惜しい)と判定する', () => {
    const allMoves: MoveEvalJson[] = [
      { move: 'd3', score: 500, discDiff: 5.0, type: 'midgame' },
      { move: 'c4', score: 500, discDiff: 5.0, type: 'midgame' },
      { move: 'e3', score: 460, discDiff: 4.6, type: 'midgame' },
    ]
    const result = judgeMove(bookMoves, notationToSquare('e3'), allMoves)
    expect(result.kind).toBe('offBookClose')
    if (result.kind !== 'inBook') {
      expect(result.lossDiscs).toBeCloseTo(0.4, 5)
      expect(result.bestMove).toBe('d3')
      expect(result.playedDiscDiff).toBeCloseTo(4.6, 5)
      expect(result.correctMoves).toBe(bookMoves)
    }
  })

  it('定石外で石差ロス>=1.0なら blunder(悪手)と判定する', () => {
    const allMoves: MoveEvalJson[] = [
      { move: 'd3', score: 500, discDiff: 5.0, type: 'midgame' },
      { move: 'c4', score: 500, discDiff: 5.0, type: 'midgame' },
      { move: 'e3', score: 200, discDiff: 2.0, type: 'midgame' },
    ]
    const result = judgeMove(bookMoves, notationToSquare('e3'), allMoves)
    expect(result.kind).toBe('blunder')
    if (result.kind !== 'inBook') {
      expect(result.lossDiscs).toBeCloseTo(3.0, 5)
      expect(result.bestMove).toBe('d3')
    }
  })

  it('石差ロスがちょうど閾値(1.0)なら blunder(悪手)と判定する(境界値)', () => {
    const allMoves: MoveEvalJson[] = [
      { move: 'd3', score: 500, discDiff: 5.0, type: 'midgame' },
      { move: 'e3', score: 400, discDiff: 4.0, type: 'midgame' },
    ]
    const result = judgeMove(bookMoves, notationToSquare('e3'), allMoves)
    expect(result.kind).toBe('blunder')
  })

  it('全合法手評価が空配列の場合はbestMove=nullでblunder扱いにする', () => {
    const result = judgeMove(bookMoves, notationToSquare('e3'), [])
    expect(result.kind).toBe('blunder')
    if (result.kind !== 'inBook') {
      expect(result.bestMove).toBeNull()
      expect(result.playedDiscDiff).toBeNull()
    }
  })
})

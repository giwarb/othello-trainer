import { describe, expect, it } from 'vitest'
import { DEFAULT_CLASSIFY_THRESHOLDS } from '../analysis/classifyMove.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { computeCellEvals, formatLoss } from './moveEvalOverlayLogic.ts'

function move(notation: string, discDiff: number): MoveEvalJson {
  return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
}

describe('computeCellEvals', () => {
  it('allMovesがnullなら空のMapを返す', () => {
    expect(computeCellEvals(null, DEFAULT_CLASSIFY_THRESHOLDS).size).toBe(0)
  })

  it('allMovesが空配列なら空のMapを返す', () => {
    expect(computeCellEvals([], DEFAULT_CLASSIFY_THRESHOLDS).size).toBe(0)
  })

  it('最善手はlossDiscs=0・classification="best"になる', () => {
    const result = computeCellEvals([move('d3', 2.0), move('c4', 1.5)], DEFAULT_CLASSIFY_THRESHOLDS)
    // d3 -> square 2*8+3=19
    const best = result.get(19)
    expect(best).toEqual({ classification: 'best', lossDiscs: 0 })
  })

  it('最善手との差(石差)からlossDiscsを計算し、閾値どおりに分類する', () => {
    const thresholds: ClassifyThresholds = { inaccuracy: 1, dubious: 3, blunder: 6 }
    const moves = [
      move('a1', 5.0), // best
      move('b1', 4.5), // loss 0.5 -> best
      move('c1', 3.5), // loss 1.5 -> inaccuracy
      move('d1', 1.5), // loss 3.5 -> dubious
      move('e1', -2.0), // loss 7.0 -> blunder
    ]
    const result = computeCellEvals(moves, thresholds)

    expect(result.get(0)).toEqual({ classification: 'best', lossDiscs: 0 }) // a1 -> square 0
    expect(result.get(1)).toEqual({ classification: 'best', lossDiscs: 0.5 }) // b1 -> square 1
    expect(result.get(2)).toEqual({ classification: 'inaccuracy', lossDiscs: 1.5 }) // c1 -> square 2
    expect(result.get(3)).toEqual({ classification: 'dubious', lossDiscs: 3.5 }) // d1 -> square 3
    expect(result.get(4)).toEqual({ classification: 'blunder', lossDiscs: 7.0 }) // e1 -> square 4
  })

  it('マス番号は"a1"〜"h8"記法からnotationToSquareの変換規則どおりに求める', () => {
    const result = computeCellEvals([move('h8', 0), move('a1', -1)], DEFAULT_CLASSIFY_THRESHOLDS)
    expect(result.has(63)).toBe(true) // h8 -> square 63
    expect(result.has(0)).toBe(true) // a1 -> square 0
    expect(result.size).toBe(2)
  })
})

describe('formatLoss', () => {
  it('0の場合は"±0"を返す', () => {
    expect(formatLoss(0)).toBe('±0')
  })

  it('四捨五入して0になる微小値の場合も"±0"を返す', () => {
    expect(formatLoss(0.04)).toBe('±0')
  })

  it('正のロス量は"-N"の形式で整数表示する(T049)', () => {
    expect(formatLoss(1.2)).toBe('-1')
    expect(formatLoss(1.6)).toBe('-2')
    expect(formatLoss(6)).toBe('-6')
  })
})

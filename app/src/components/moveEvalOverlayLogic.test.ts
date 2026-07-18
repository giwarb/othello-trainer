import { describe, expect, it } from 'vitest'
import { DEFAULT_CLASSIFY_THRESHOLDS } from '../analysis/classifyMove.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { applyBookCap, computeBoardEvalScore, computeCellEvals, formatEvalScore } from './moveEvalOverlayLogic.ts'

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

  it('最善手はevalScore=discDiffそのもの・classification="best"になる', () => {
    const result = computeCellEvals([move('d3', 2.0), move('c4', 1.5)], DEFAULT_CLASSIFY_THRESHOLDS)
    // d3 -> square 2*8+3=19
    const best = result.get(19)
    expect(best).toEqual({ classification: 'best', evalScore: 2.0 })
  })

  it('evalScoreは各手のdiscDiffそのもの(ロスではない)を保持し、分類は最善手との差(石差)から閾値どおりに判定する', () => {
    const thresholds: ClassifyThresholds = { inaccuracy: 1, dubious: 3, blunder: 6 }
    const moves = [
      move('a1', 5.0), // best, loss 0
      move('b1', 4.5), // loss 0.5 -> best
      move('c1', 3.5), // loss 1.5 -> inaccuracy
      move('d1', 1.5), // loss 3.5 -> dubious
      move('e1', -2.0), // loss 7.0 -> blunder
    ]
    const result = computeCellEvals(moves, thresholds)

    expect(result.get(0)).toEqual({ classification: 'best', evalScore: 5.0 }) // a1 -> square 0
    expect(result.get(1)).toEqual({ classification: 'best', evalScore: 4.5 }) // b1 -> square 1
    expect(result.get(2)).toEqual({ classification: 'inaccuracy', evalScore: 3.5 }) // c1 -> square 2
    expect(result.get(3)).toEqual({ classification: 'dubious', evalScore: 1.5 }) // d1 -> square 3
    expect(result.get(4)).toEqual({ classification: 'blunder', evalScore: -2.0 }) // e1 -> square 4
  })

  it('マス番号は"a1"〜"h8"記法からnotationToSquareの変換規則どおりに求める', () => {
    const result = computeCellEvals([move('h8', 0), move('a1', -1)], DEFAULT_CLASSIFY_THRESHOLDS)
    expect(result.has(63)).toBe(true) // h8 -> square 63
    expect(result.has(0)).toBe(true) // a1 -> square 0
    expect(result.size).toBe(2)
  })
})

describe('applyBookCap(T138仕様2〜4)', () => {
  const thresholds = DEFAULT_CLASSIFY_THRESHOLDS

  it('仕様4: bookSquaresが空なら何もせずそのまま返す(素の評価値)', () => {
    const cellEvals = computeCellEvals([move('a1', 3.0), move('b1', -1.0)], thresholds)
    const result = applyBookCap(cellEvals, new Set())
    expect(result).toBe(cellEvals) // 同一参照を返す(不要なコピーをしない)
    expect(result.get(0)?.evalScore).toBe(3.0)
    expect(result.get(1)?.evalScore).toBe(-1.0)
  })

  it('仕様3前半: ブック手自身の評価値は0にする(元がプラスでもマイナスでも)', () => {
    const cellEvals = computeCellEvals([move('a1', 3.0), move('b1', -2.0)], thresholds)
    // a1(square 0)・b1(square 1)いずれもブック手とする
    const result = applyBookCap(cellEvals, new Set([0, 1]))
    expect(result.get(0)?.evalScore).toBe(0)
    expect(result.get(1)?.evalScore).toBe(0)
  })

  it('仕様3後半: 非ブック手のプラスの評価値は0に丸める', () => {
    const cellEvals = computeCellEvals([move('a1', 0), move('b1', 4.0)], thresholds)
    // a1(square 0)だけがブック手、b1(square 1)は非ブック手でプラス
    const result = applyBookCap(cellEvals, new Set([0]))
    expect(result.get(1)?.evalScore).toBe(0)
  })

  it('仕様3但し書き: 非ブック手のマイナスの評価値はそのまま', () => {
    const cellEvals = computeCellEvals([move('a1', 0), move('b1', -3.5)], thresholds)
    const result = applyBookCap(cellEvals, new Set([0]))
    expect(result.get(1)?.evalScore).toBe(-3.5)
  })

  it('classification(色分類)はcap適用の影響を受けない', () => {
    const thr: ClassifyThresholds = { inaccuracy: 1, dubious: 3, blunder: 6 }
    const cellEvals = computeCellEvals([move('a1', 5.0), move('b1', -2.0)], thr) // b1: loss 7 -> blunder
    const result = applyBookCap(cellEvals, new Set([0, 1]))
    expect(result.get(1)?.evalScore).toBe(0)
    expect(result.get(1)?.classification).toBe('blunder')
  })
})

describe('computeBoardEvalScore(T138仕様1・2)', () => {
  it('allMovesがnullならnullを返す', () => {
    expect(computeBoardEvalScore(null, new Set())).toBeNull()
  })

  it('allMovesが空配列ならnullを返す', () => {
    expect(computeBoardEvalScore([], new Set())).toBeNull()
  })

  it('仕様1: bookSquaresが空のとき、各合法手の評価値の最大値を返す', () => {
    const moves = [move('a1', 1.0), move('b1', 3.0), move('c1', -2.0)]
    expect(computeBoardEvalScore(moves, new Set())).toBe(3.0)
  })

  it('仕様2: bookSquaresが空でない(定石ブック内)なら、最大値に関わらず0を返す', () => {
    const moves = [move('a1', 1.0), move('b1', 3.0)]
    expect(computeBoardEvalScore(moves, new Set([0]))).toBe(0)
  })
})

describe('formatEvalScore', () => {
  it('0の場合は符号なしの"0"を返す', () => {
    expect(formatEvalScore(0)).toBe('0')
  })

  it('四捨五入して0になる微小値の場合も符号なしの"0"を返す', () => {
    expect(formatEvalScore(0.04)).toBe('0')
    expect(formatEvalScore(-0.04)).toBe('0')
  })

  it('正の評価値は"+N"の形式で整数表示する', () => {
    expect(formatEvalScore(1.2)).toBe('+1')
    expect(formatEvalScore(1.6)).toBe('+2')
    expect(formatEvalScore(6)).toBe('+6')
  })

  it('負の評価値は"-N"の形式で整数表示する', () => {
    expect(formatEvalScore(-1.2)).toBe('-1')
    expect(formatEvalScore(-1.6)).toBe('-2')
    expect(formatEvalScore(-6)).toBe('-6')
  })
})

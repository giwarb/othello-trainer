import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare } from '../game/othello.ts'
import { buildAttribution, replayContinuation } from './attribution.ts'
import { TranscriptReplayError } from './analyzeGame.ts'
import type { EvalTerms } from './types.ts'

function terms(mobilityDiff: number, cornerDiff: number, stableDiff: number, evaluateBlack = 0): EvalTerms {
  return { mobilityDiff, cornerDiff, stableDiff, evaluateBlack }
}

describe('analysis/attribution: buildAttribution', () => {
  it('黒視点で、各項目の寄与(重み×特徴量差)を石差単位で計算する', () => {
    // A: mobility=2, corner=1, stable=0 / B: mobility=0, corner=0, stable=0
    // 重みは engine/src/eval.rs と同じ(MOBILITY_WEIGHT=253, CORNER_WEIGHT=1088, STABLE_WEIGHT=93)。
    const a = terms(2, 1, 0)
    const b = terms(0, 0, 0)
    const result = buildAttribution(a, b, 'black')

    const mobilityTerm = result.terms.find((t) => t.key === 'mobility')!
    const cornerTerm = result.terms.find((t) => t.key === 'corner')!
    const stableTerm = result.terms.find((t) => t.key === 'stable')!

    expect(mobilityTerm.delta).toBeCloseTo((253 * 2) / 100, 6)
    expect(cornerTerm.delta).toBeCloseTo((1088 * 1) / 100, 6)
    expect(stableTerm.delta).toBeCloseTo(0, 6)
  })

  it('3項の合計(total)は各項目のdeltaの合計と一致する', () => {
    const a = terms(3, -2, 1)
    const b = terms(-1, 1, 0)
    const result = buildAttribution(a, b, 'black')

    const sumOfTerms = result.terms.reduce((sum, t) => sum + t.delta, 0)
    expect(result.total).toBeCloseTo(sumOfTerms, 9)
  })

  it('白視点では符号が反転する(黒視点で見た合計のちょうど-1倍)', () => {
    const a = terms(4, 2, 1)
    const b = terms(0, 0, 0)
    const blackView = buildAttribution(a, b, 'black')
    const whiteView = buildAttribution(a, b, 'white')

    expect(whiteView.total).toBeCloseTo(-blackView.total, 9)
    for (let i = 0; i < blackView.terms.length; i++) {
      expect(whiteView.terms[i]!.delta).toBeCloseTo(-blackView.terms[i]!.delta, 9)
    }
  })

  it('2局面が同一の特徴量差分を持てば、分解結果はすべて0になる', () => {
    const a = terms(5, -3, 2)
    const result = buildAttribution(a, a, 'black')
    for (const term of result.terms) {
      expect(term.delta).toBeCloseTo(0, 9)
    }
    expect(result.total).toBeCloseTo(0, 9)
  })

  it('3つの項目(mobility/corner/stable)が過不足なく含まれる', () => {
    const result = buildAttribution(terms(1, 1, 1), terms(0, 0, 0), 'black')
    const keys = result.terms.map((t) => t.key).sort()
    expect(keys).toEqual(['corner', 'mobility', 'stable'])
  })
})

describe('analysis/attribution: replayContinuation', () => {
  it('着手列を順番に適用し、applyMoveを直接呼んだ場合と同じ末端局面を返す', () => {
    const start = initialBoard()
    // 初期局面で黒がd3に着手した後、白の合法手の1つはc3。
    const moves = ['d3', 'c3']
    const result = replayContinuation(start, 'black', moves)

    let expected = start
    expected = applyMove(expected, 'black', notationToSquare('d3'))
    expected = applyMove(expected, 'white', notationToSquare('c3'))

    expect(result).toEqual(expected)
  })

  it('手順が空なら開始局面をそのまま返す', () => {
    const start = initialBoard()
    const result = replayContinuation(start, 'black', [])
    expect(result).toEqual(start)
  })

  it('非合法手を含む手順はTranscriptReplayErrorを投げる', () => {
    const start = initialBoard()
    // a1は初期局面の黒番にとって非合法手。
    expect(() => replayContinuation(start, 'black', ['a1'])).toThrow(TranscriptReplayError)
  })
})

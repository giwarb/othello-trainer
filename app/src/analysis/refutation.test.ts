import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare } from '../game/othello.ts'
import { replayContinuationSteps } from './attribution.ts'
import {
  buildRefutationLine,
  buildRefutationResult,
  describeRefutationStep,
  REFUTATION_THRESHOLD_DISCS,
  type RefutationStep,
} from './refutation.ts'
import type { EvalTerms } from './types.ts'

/**
 * `attribution.test.ts`と同じ方針のテスト用`EvalTerms`フィクスチャ
 * (重み適用済みの3項をそのまま渡す。`mobilityDiff`等の生の特徴量差分は
 * `buildAttribution`/`buildRefutationLine`が参照しないためダミー値0)。
 */
function terms(mobilityTerm: number, cornerTerm: number, stableTerm: number): EvalTerms {
  return { mobilityDiff: 0, cornerDiff: 0, stableDiff: 0, mobilityTerm, cornerTerm, stableTerm, evaluateBlack: 0 }
}

describe('analysis/refutation: buildRefutationLine', () => {
  const start = initialBoard()
  const moves = ['d3', 'c3']
  const boards = replayContinuationSteps(start, 'black', moves)

  it('隣接する手同士の評価内訳分解を計算し、ステップ数は手数と一致する', () => {
    const termsSequence = [terms(0, 0, 0), terms(50, 0, 0), terms(50, 500, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect(line.steps).toHaveLength(2)
    expect(line.steps[0]!.move).toBe('d3')
    expect(line.steps[1]!.move).toBe('c3')
  })

  it('閾値未満の変化は回収点として検出しない', () => {
    // d3: mobilityTermが0→50(0.5石)だけ動く。既定閾値(3石)未満なので回収点ではない。
    const termsSequence = [terms(0, 0, 0), terms(50, 0, 0), terms(50, 0, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect(line.steps[0]!.isCriticalPly).toBe(false)
    expect(line.steps[0]!.criticalTermKeys).toEqual([])
  })

  it('閾値以上の変化を回収点として検出し、どの項が動いたかを特定する', () => {
    // c3: cornerTermが0→500(5.0石)動く。既定閾値(3石)を超えるので回収点。
    const termsSequence = [terms(0, 0, 0), terms(50, 0, 0), terms(50, 500, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect(line.steps[1]!.isCriticalPly).toBe(true)
    expect(line.steps[1]!.criticalTermKeys).toEqual(['corner'])
    const cornerTerm = line.steps[1]!.breakdown.terms.find((t) => t.key === 'corner')!
    expect(cornerTerm.delta).toBeCloseTo(5.0, 9)
  })

  it('ちょうど閾値と等しい変化は回収点として検出する(閾値は"以上")', () => {
    const thresholdCenti = REFUTATION_THRESHOLD_DISCS * 100
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 0, thresholdCenti)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect(line.steps[1]!.isCriticalPly).toBe(true)
    expect(line.steps[1]!.criticalTermKeys).toEqual(['stable'])
  })

  it('複数の項が同時に閾値を超えれば、両方をcriticalTermKeysに含める', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(400, -400, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect([...line.steps[1]!.criticalTermKeys].sort()).toEqual(['corner', 'mobility'])
  })

  it('perspectiveがwhiteなら符号が反転する', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 500, 0)]
    const blackLine = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    const whiteLine = buildRefutationLine('black', boards, moves, termsSequence, 'white')
    const blackCorner = blackLine.steps[1]!.breakdown.terms.find((t) => t.key === 'corner')!
    const whiteCorner = whiteLine.steps[1]!.breakdown.terms.find((t) => t.key === 'corner')!
    expect(whiteCorner.delta).toBeCloseTo(-blackCorner.delta, 9)
  })

  it('カスタム閾値を指定すればそれに従う', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(150, 0, 0)]
    const strict = buildRefutationLine('black', boards, moves, termsSequence, 'black', 1)
    const loose = buildRefutationLine('black', boards, moves, termsSequence, 'black', 10)
    expect(strict.steps[1]!.isCriticalPly).toBe(true)
    expect(loose.steps[1]!.isCriticalPly).toBe(false)
  })

  it('局面配列の長さが手数+1と一致しなければ例外を投げる', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 0, 0)]
    expect(() => buildRefutationLine('black', boards.slice(0, 2), moves, termsSequence, 'black')).toThrow()
  })

  it('EvalTerms配列の長さが手数+1と一致しなければ例外を投げる', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0)]
    expect(() => buildRefutationLine('black', boards, moves, termsSequence, 'black')).toThrow()
  })
})

describe('analysis/refutation: buildRefutationResult', () => {
  it('実際の進行・最善進行それぞれの局面を自前で複製し、両系列の回収点を返す', () => {
    const start = initialBoard()
    const playedMoves = ['d3', 'c3']
    const bestMoves = ['f5']
    const playedTerms = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 500, 0)]
    const bestTerms = [terms(0, 0, 0), terms(300, 0, 0)]

    const result = buildRefutationResult(start, 'black', playedMoves, bestMoves, playedTerms, bestTerms, 'black')

    expect(result.played.steps).toHaveLength(2)
    expect(result.best.steps).toHaveLength(1)
    expect(result.played.steps[1]!.isCriticalPly).toBe(true)
    expect(result.best.steps[0]!.isCriticalPly).toBe(true)

    // 局面は`replayContinuationSteps`(T031で使われているものと同一ロジック)で
    // 複製されており、applyMoveを直接呼んだ場合と一致する。
    const expectedAfterD3 = applyMove(start, 'black', notationToSquare('d3'))
    expect(result.played.steps[0]!.board).toEqual(expectedAfterD3)
  })
})

describe('analysis/refutation: describeRefutationStep', () => {
  const start = initialBoard()
  const moves = ['d3', 'c3']
  const boards = replayContinuationSteps(start, 'black', moves)

  it('回収点でなければnullを返す', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 0, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    expect(describeRefutationStep('実際の進行', line.steps[0]!)).toBeNull()
  })

  it('回収点であれば、手数・系列ラベル・動いた項目・量を含むテキストを返す', () => {
    const termsSequence = [terms(0, 0, 0), terms(0, 0, 0), terms(0, 500, 0)]
    const line = buildRefutationLine('black', boards, moves, termsSequence, 'black')
    const step: RefutationStep = line.steps[1]!
    const text = describeRefutationStep('実際の進行', step)
    expect(text).not.toBeNull()
    expect(text).toContain('2手目')
    expect(text).toContain('実際の進行')
    expect(text).toContain('隅')
    expect(text).toContain('+5.0')
  })
})

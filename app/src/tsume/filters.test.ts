import { describe, expect, it } from 'vitest'
import {
  analyzeMoveOutcomes,
  isAcceptedPuzzleCandidate,
  MAX_WINNING_MOVES,
  MIN_CLARITY_MARGIN,
} from './filters.ts'

describe('tsume/filters: analyzeMoveOutcomes(唯一解性フィルタ)', () => {
  it('最善手が1手だけなら唯一解性を満たす', () => {
    const a = analyzeMoveOutcomes([10, 2, -4, 6])
    expect(a.best).toBe(10)
    expect(a.winnerIndices).toEqual([0])
    expect(a.uniquenessOk).toBe(true)
  })

  it('最善手が2手(同値)でも唯一解性を満たす(上限ちょうど)', () => {
    const a = analyzeMoveOutcomes([10, 10, -4, 6])
    expect(a.winnerIndices).toEqual([0, 1])
    expect(a.winnerIndices.length).toBe(MAX_WINNING_MOVES)
    expect(a.uniquenessOk).toBe(true)
  })

  it('最善手が3手(同値)だと唯一解性を満たさない', () => {
    const a = analyzeMoveOutcomes([10, 10, 10, 6])
    expect(a.winnerIndices.length).toBe(3)
    expect(a.uniquenessOk).toBe(false)
  })

  it('全ての手が同値(退化ケース)だと唯一解性は満たすが明確さは満たさない', () => {
    const a = analyzeMoveOutcomes([4, 4])
    expect(a.winnerIndices).toEqual([0, 1])
    expect(a.uniquenessOk).toBe(true)
    expect(a.second).toBe(a.best)
    expect(a.clarityMargin).toBe(0)
    expect(a.clarityOk).toBe(false)
  })

  it('合法手が1手のみの場合は唯一解性を満たすが、次善手が無いため明確さは満たさない', () => {
    const a = analyzeMoveOutcomes([8])
    expect(a.winnerIndices).toEqual([0])
    expect(a.uniquenessOk).toBe(true)
    expect(a.clarityOk).toBe(false)
  })

  it('空配列を渡すとエラーになる', () => {
    expect(() => analyzeMoveOutcomes([])).toThrow(RangeError)
  })
})

describe('tsume/filters: analyzeMoveOutcomes(明確さフィルタ)', () => {
  it('最善手と次善手の差がちょうど4なら明確さを満たす(境界値)', () => {
    const a = analyzeMoveOutcomes([10, 6, 0])
    expect(a.clarityMargin).toBe(MIN_CLARITY_MARGIN)
    expect(a.clarityOk).toBe(true)
  })

  it('最善手と次善手の差が3だと明確さを満たさない(境界値の内側)', () => {
    const a = analyzeMoveOutcomes([10, 7, 0])
    expect(a.clarityMargin).toBe(3)
    expect(a.clarityOk).toBe(false)
  })

  it('次善手は「最善タイの手グループ」の外で最大の値を指す', () => {
    // 最善10が2手(唯一解性OK)、残りの中で最大は3。
    const a = analyzeMoveOutcomes([10, 10, 3, -20])
    expect(a.second).toBe(3)
    expect(a.clarityMargin).toBe(7)
  })
})

describe('tsume/filters: isAcceptedPuzzleCandidate', () => {
  it('唯一解性・明確さの両方を満たす候補はtrue', () => {
    expect(isAcceptedPuzzleCandidate([10, 2, -4])).toBe(true)
  })

  it('唯一解性を満たさない候補はfalse', () => {
    expect(isAcceptedPuzzleCandidate([10, 10, 10, 2])).toBe(false)
  })

  it('明確さを満たさない候補はfalse', () => {
    expect(isAcceptedPuzzleCandidate([10, 8, 2])).toBe(false)
  })
})

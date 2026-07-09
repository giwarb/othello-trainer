import { describe, expect, it } from 'vitest'
import { buildComparePv, COMPARE_PV_MAX_PLIES } from './comparePv.ts'

describe('analysis/comparePv: buildComparePv', () => {
  it('実際の進行(本譜の以後の着手)と最善進行(最善手+PV)をそれぞれ構築する', () => {
    const gameMoves = ['f5', 'f4', 'f6', 'e6', 'g5']
    const result = buildComparePv(gameMoves, 1, 'd3', ['c3', 'c4'])

    expect(result.playedContinuation).toEqual(['f4', 'f6', 'e6', 'g5'])
    expect(result.bestContinuation).toEqual(['d3', 'c3', 'c4'])
  })

  it('最大8手までに切り詰める', () => {
    const gameMoves = Array.from({ length: 20 }, (_, i) => `move${i}`)
    const bestPv = Array.from({ length: 20 }, (_, i) => `best${i}`)
    const result = buildComparePv(gameMoves, 0, 'bestMove', bestPv)

    expect(result.playedContinuation).toHaveLength(COMPARE_PV_MAX_PLIES)
    expect(result.bestContinuation).toHaveLength(COMPARE_PV_MAX_PLIES)
    expect(result.playedContinuation[0]).toBe('move0')
    expect(result.bestContinuation[0]).toBe('bestMove')
  })

  it('先頭(実際に打った手 vs 最善手)から一致しなければfirstDivergenceIndexは0', () => {
    const result = buildComparePv(['f4', 'x', 'y'], 0, 'd3', ['a', 'b'])
    expect(result.firstDivergenceIndex).toBe(0)
    expect(result.diverges[0]).toBe(true)
  })

  it('途中まで一致していれば、最初に分岐したインデックスを返す', () => {
    const result = buildComparePv(['d3', 'x', 'y', 'z'], 0, 'd3', ['x', 'w'])
    expect(result.diverges).toEqual([false, false, true])
    expect(result.firstDivergenceIndex).toBe(2)
  })

  it('打った手と最善手が同じ(逆転悪手など)場合はfirstDivergenceIndexがnullになりうる', () => {
    const result = buildComparePv(['d3', 'x'], 0, 'd3', ['x'])
    expect(result.diverges).toEqual([false, false])
    expect(result.firstDivergenceIndex).toBeNull()
  })

  it('本譜が悪手局面で終わっている(継続手が無い)場合はplayedContinuationが短くなる', () => {
    const result = buildComparePv(['f5'], 0, 'd3', ['c3', 'c4'])
    expect(result.playedContinuation).toEqual(['f5'])
    expect(result.bestContinuation).toEqual(['d3', 'c3', 'c4'])
    // playedContinuationの方が短いため、重複区間はその長さ(1)までしか比較しない。
    expect(result.diverges).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import { isBlunder } from './isBlunder.ts'
import type { BlunderConfig } from './types.ts'
import type { MoveEvalJson } from '../engine/types.ts'

/** テスト用ヘルパー: `score`(centi-disc)から`discDiff`(石差)を機械的に算出して`MoveEvalJson`を作る。 */
function moveEval(move: string, score: number, type: 'midgame' | 'exact' = 'midgame'): MoveEvalJson {
  return { move, score, discDiff: score / 100, type }
}

// 人工的な4手の評価値データ: f5が最善(+3.2)、g4が僅差(+2.4, ロス0.8, 2位)、
// c3が中程度(+1.0, ロス2.2, 3位)、a1が大悪手(-4.0, ロス7.2, 4位)。
const MOVES: MoveEvalJson[] = [
  moveEval('f5', 320),
  moveEval('g4', 240),
  moveEval('c3', 100),
  moveEval('a1', -400),
]

describe('isBlunder', () => {
  describe('method: worseThanBest ((a) 最善以外)', () => {
    const config: BlunderConfig = { method: 'worseThanBest', lossThreshold: 1.0, rankThreshold: 3 }

    it('最善手を打った場合は悪手にならない', () => {
      const result = isBlunder(MOVES, 'f5', config)
      expect(result.blunder).toBe(false)
      expect(result.rank).toBe(1)
      expect(result.lossDiscs).toBe(0)
      expect(result.bestMove).toBe('f5')
    })

    it('最善手でなければ、僅差であっても悪手と判定する', () => {
      const result = isBlunder(MOVES, 'g4', config)
      expect(result.blunder).toBe(true)
      expect(result.rank).toBe(2)
      expect(result.lossDiscs).toBeCloseTo(0.8, 10)
    })

    it('大きく劣る手も当然悪手と判定する', () => {
      const result = isBlunder(MOVES, 'a1', config)
      expect(result.blunder).toBe(true)
      expect(result.rank).toBe(4)
      expect(result.lossDiscs).toBeCloseTo(7.2, 10)
    })
  })

  describe('method: lossThreshold ((b) 差分n以上)', () => {
    const config: BlunderConfig = { method: 'lossThreshold', lossThreshold: 1.0, rankThreshold: 3 }

    it('最善手を打った場合は悪手にならない', () => {
      expect(isBlunder(MOVES, 'f5', config).blunder).toBe(false)
    })

    it('ロスが閾値未満(0.8 < 1.0)の僅差の手は悪手にならない', () => {
      const result = isBlunder(MOVES, 'g4', config)
      expect(result.blunder).toBe(false)
      expect(result.lossDiscs).toBeCloseTo(0.8, 10)
    })

    it('ロスが閾値以上(2.2 >= 1.0)の手は悪手と判定する', () => {
      const result = isBlunder(MOVES, 'c3', config)
      expect(result.blunder).toBe(true)
      expect(result.lossDiscs).toBeCloseTo(2.2, 10)
    })

    it('ロスがちょうど閾値と等しい場合も悪手と判定する(境界値、以上なので含む)', () => {
      const boundaryMoves: MoveEvalJson[] = [moveEval('f5', 200), moveEval('g4', 100)]
      const result = isBlunder(boundaryMoves, 'g4', { ...config, lossThreshold: 1.0 })
      expect(result.lossDiscs).toBeCloseTo(1.0, 10)
      expect(result.blunder).toBe(true)
    })
  })

  describe('method: rankThreshold ((c) 順位n位より下)', () => {
    const config: BlunderConfig = { method: 'rankThreshold', lossThreshold: 1.0, rankThreshold: 2 }

    it('最善手を打った場合は悪手にならない', () => {
      expect(isBlunder(MOVES, 'f5', config).blunder).toBe(false)
    })

    it('閾値以内の順位(2位 <= 2位)なら悪手にならない', () => {
      const result = isBlunder(MOVES, 'g4', config)
      expect(result.rank).toBe(2)
      expect(result.blunder).toBe(false)
    })

    it('閾値より下の順位(3位 > 2位)なら悪手と判定する', () => {
      const result = isBlunder(MOVES, 'c3', config)
      expect(result.rank).toBe(3)
      expect(result.blunder).toBe(true)
    })

    it('同点は同順位として扱う(タイの手は繰り上がらない)', () => {
      const tiedMoves: MoveEvalJson[] = [
        moveEval('f5', 300),
        moveEval('g4', 300),
        moveEval('c3', 100),
      ]
      // f5とg4は同点1位、c3は3位(2位が2つあるので3位に繰り下がる)。
      expect(isBlunder(tiedMoves, 'g4', { ...config, rankThreshold: 1 }).rank).toBe(1)
      expect(isBlunder(tiedMoves, 'g4', { ...config, rankThreshold: 1 }).blunder).toBe(false)
      expect(isBlunder(tiedMoves, 'c3', { ...config, rankThreshold: 1 }).rank).toBe(3)
      expect(isBlunder(tiedMoves, 'c3', { ...config, rankThreshold: 1 }).blunder).toBe(true)
    })
  })

  it('合法手が無い(空配列)場合は悪手にならない', () => {
    const config: BlunderConfig = { method: 'worseThanBest', lossThreshold: 1.0, rankThreshold: 3 }
    const result = isBlunder([], 'f5', config)
    expect(result.blunder).toBe(false)
    expect(result.lossDiscs).toBe(0)
    expect(result.rank).toBe(0)
    expect(result.bestMove).toBe('')
  })

  it('打った手が候補一覧に無い(想定外の呼び出し)場合は最善手扱いとして悪手にしない', () => {
    const config: BlunderConfig = { method: 'worseThanBest', lossThreshold: 1.0, rankThreshold: 3 }
    const result = isBlunder(MOVES, 'z9', config)
    expect(result.blunder).toBe(false)
  })
})

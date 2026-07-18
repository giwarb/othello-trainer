/**
 * T137要件2のテスト: 詰めオセロ設定画面「難易度で選ぶ」カードの集計
 * (`computeDifficultyStats`)。
 */
import { describe, expect, it } from 'vitest'
import { recordStageAttempt, type StorageLike } from './stageProgress.ts'
import { computeDifficultyStats } from './difficultyStats.ts'
import type { DifficultyLevel, Puzzle } from './types.ts'

function makePuzzle(id: string, difficulty: DifficultyLevel, empties: number): Puzzle {
  return {
    id,
    board: { black: '0x0', white: '0x0' },
    sideToMove: 'black',
    empties,
    correctMoves: ['f5'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty,
    difficultyRawScore: 0,
    tags: [],
  }
}

function makeStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

const LEVELS: readonly DifficultyLevel[] = [1, 2, 3, 4, 5]

describe('computeDifficultyStats', () => {
  it('難易度ごとに空きマス数の範囲(最小〜最大)を求める', () => {
    const pool: Puzzle[] = [
      makePuzzle('p1', 1, 8),
      makePuzzle('p2', 1, 10),
      makePuzzle('p3', 1, 6),
      makePuzzle('p4', 2, 15),
    ]
    const stats = computeDifficultyStats(pool, {}, LEVELS)

    const level1 = stats.find((s) => s.level === 1)!
    expect(level1.total).toBe(3)
    expect(level1.minEmpties).toBe(6)
    expect(level1.maxEmpties).toBe(10)

    const level2 = stats.find((s) => s.level === 2)!
    expect(level2.total).toBe(1)
    expect(level2.minEmpties).toBe(15)
    expect(level2.maxEmpties).toBe(15)
  })

  it('該当問題が0件の難易度は total=0・minEmpties/maxEmpties=null(空状態)', () => {
    const pool: Puzzle[] = [makePuzzle('p1', 1, 8)]
    const stats = computeDifficultyStats(pool, {}, LEVELS)
    const level5 = stats.find((s) => s.level === 5)!
    expect(level5).toEqual({ level: 5, total: 0, cleared: 0, minEmpties: null, maxEmpties: null })
  })

  it('クリア済み(stageStatus===cleared)の問題数をclearedとして数える', () => {
    const pool: Puzzle[] = [makePuzzle('p1', 3, 12), makePuzzle('p2', 3, 14), makePuzzle('p3', 3, 16)]
    const storage = makeStorage()
    recordStageAttempt(storage, 'p1', 'clear')
    const progress = recordStageAttempt(storage, 'p2', 'fail')

    const stats = computeDifficultyStats(pool, progress, LEVELS)
    const level3 = stats.find((s) => s.level === 3)!
    expect(level3.total).toBe(3)
    expect(level3.cleared).toBe(1)
  })

  it('levelsの順序どおりに1件ずつ返す', () => {
    const stats = computeDifficultyStats([], {}, LEVELS)
    expect(stats.map((s) => s.level)).toEqual([1, 2, 3, 4, 5])
  })
})

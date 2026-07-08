import { describe, expect, it } from 'vitest'
import { todaysDateString, todaysPuzzle } from './dailyPuzzle.ts'
import { dailyPuzzle } from './daily.ts'
import type { Puzzle } from './types.ts'

function makePuzzle(id: string): Puzzle {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    sideToMove: 'black',
    empties: 10,
    correctMoves: ['d3'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty: 1,
    difficultyRawScore: 0,
    tags: [],
  }
}

describe('tsume/dailyPuzzle: todaysDateString', () => {
  it('YYYY-MM-DD形式の文字列を返す(月・日は2桁ゼロ埋め)', () => {
    expect(todaysDateString(new Date(2026, 0, 9))).toBe('2026-01-09')
    expect(todaysDateString(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('tsume/dailyPuzzle: todaysPuzzle', () => {
  const pool = Array.from({ length: 30 }, (_, i) => makePuzzle(`tsume-${i}`))

  it('同じ日付なら常に同じ問題を返す(決定性)', () => {
    const date = new Date(2026, 6, 9)
    const first = todaysPuzzle(pool, date)
    for (let i = 0; i < 5; i++) {
      expect(todaysPuzzle(pool, date)).toBe(first)
    }
  })

  it('daily.tsのdailyPuzzleと同じ結果を返す(薄いラッパーであることの確認)', () => {
    const date = new Date(2026, 6, 9)
    expect(todaysPuzzle(pool, date)).toBe(dailyPuzzle('2026-07-09', pool))
  })

  it('poolが空配列の場合はRangeErrorを投げる', () => {
    expect(() => todaysPuzzle([], new Date(2026, 6, 9))).toThrow(RangeError)
  })
})

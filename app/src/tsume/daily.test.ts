import { describe, expect, it } from 'vitest'
import { dailyPuzzle, dailyPuzzleIndex, hashDateString } from './daily.ts'

describe('tsume/daily: hashDateString', () => {
  it('同じ文字列は常に同じハッシュ値を返す(決定性)', () => {
    expect(hashDateString('2026-07-09')).toBe(hashDateString('2026-07-09'))
  })

  it('異なる日付文字列は(基本的に)異なるハッシュ値になる', () => {
    const dates = Array.from({ length: 60 }, (_, i) => {
      const day = `${(i % 28) + 1}`.padStart(2, '0')
      const month = `${Math.floor(i / 28) + 1}`.padStart(2, '0')
      return `2026-${month}-${day}`
    })
    const hashes = new Set(dates.map(hashDateString))
    // 完全な一意性までは要求しないが、60件中ほとんどが異なる値であることを確認する。
    expect(hashes.size).toBeGreaterThan(50)
  })
})

describe('tsume/daily: dailyPuzzleIndex / dailyPuzzle', () => {
  it('同じ日付・同じプール長なら常に同じインデックスを返す(決定性)', () => {
    const first = dailyPuzzleIndex('2026-07-09', 137)
    for (let i = 0; i < 5; i++) {
      expect(dailyPuzzleIndex('2026-07-09', 137)).toBe(first)
    }
  })

  it('インデックスは常に [0, poolLength) の範囲に収まる', () => {
    for (let i = 0; i < 200; i++) {
      const idx = dailyPuzzleIndex(`2026-01-${(i % 28) + 1}`, 17)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(17)
    }
  })

  it('poolLengthが0以下だとRangeErrorを投げる', () => {
    expect(() => dailyPuzzleIndex('2026-07-09', 0)).toThrow(RangeError)
  })

  it('dailyPuzzleは同じ日付・同じプールなら常に同じ要素を返す(決定性)', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const first = dailyPuzzle('2026-07-09', pool)
    for (let i = 0; i < 5; i++) {
      expect(dailyPuzzle('2026-07-09', pool)).toBe(first)
    }
  })

  it('dailyPuzzleは空プールに対してRangeErrorを投げる', () => {
    expect(() => dailyPuzzle('2026-07-09', [])).toThrow(RangeError)
  })

  it('日付が変わればプール内の異なる問題が選ばれうる', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `puzzle-${i}`)
    const results = new Set(
      Array.from({ length: 30 }, (_, i) => dailyPuzzle(`2026-01-${(i % 28) + 1}`, pool)),
    )
    // 30日分で全て同じ問題になってしまうことはない(バラけていることの緩い確認)。
    expect(results.size).toBeGreaterThan(1)
  })
})

import { describe, expect, it } from 'vitest'
import { bucketDifficultyThresholds, difficultyRawScore, levelForScore } from './difficulty.ts'

describe('tsume/difficulty: difficultyRawScore の単調性', () => {
  it('空き数を増やすとスコアは単調非減少になる', () => {
    const base = { apparentRank: 2, trapScore: 100 }
    let prev = difficultyRawScore({ empties: 6, ...base })
    for (let empties = 7; empties <= 20; empties++) {
      const score = difficultyRawScore({ empties, ...base })
      expect(score).toBeGreaterThanOrEqual(prev)
      prev = score
    }
  })

  it('見かけの順位(apparentRank)を増やすとスコアは単調非減少になる', () => {
    const base = { empties: 12, trapScore: 100 }
    let prev = difficultyRawScore({ apparentRank: 1, ...base })
    for (let rank = 2; rank <= 10; rank++) {
      const score = difficultyRawScore({ apparentRank: rank, ...base })
      expect(score).toBeGreaterThanOrEqual(prev)
      prev = score
    }
  })

  it('罠手の魅力度(trapScore)を増やすとスコアは単調非減少になる', () => {
    const base = { empties: 12, apparentRank: 3 }
    let prev = difficultyRawScore({ trapScore: 0, ...base })
    for (const trapScore of [50, 100, 500, 1000, 5000]) {
      const score = difficultyRawScore({ trapScore, ...base })
      expect(score).toBeGreaterThanOrEqual(prev)
      prev = score
    }
  })

  it('apparentRank=1(浅い評価でも即正解)はランクペナルティが0', () => {
    const withRank1 = difficultyRawScore({ empties: 10, apparentRank: 1, trapScore: 0 })
    const withoutOthers = difficultyRawScore({ empties: 10, apparentRank: 1, trapScore: 0 })
    expect(withRank1).toBe(withoutOthers)
    // 空き10のみが寄与する(重み1固定)ことを確認。
    expect(withRank1).toBe(10)
  })

  it('trapScoreが負の値(理論上発生しないが防御的に)でもスコアが減らない(0扱い)', () => {
    const score = difficultyRawScore({ empties: 10, apparentRank: 1, trapScore: -50 })
    expect(score).toBe(10)
  })
})

describe('tsume/difficulty: bucketDifficultyThresholds / levelForScore', () => {
  it('スコアが完全に均等分布していれば、5段階にほぼ均等な件数で分かれる', () => {
    // 0..99 の100件のスコア(1件ずつ全て異なる値)を用意する。
    const scores = Array.from({ length: 100 }, (_, i) => i)
    const thresholds = bucketDifficultyThresholds(scores)
    expect(thresholds.length).toBe(4)

    const counts = [0, 0, 0, 0, 0]
    for (const s of scores) {
      const level = levelForScore(s, thresholds)
      counts[level - 1]!++
    }
    // 完全に均等(各20件)である必要はないが、極端な偏りが無いことを確認する。
    for (const c of counts) {
      expect(c).toBeGreaterThanOrEqual(15)
      expect(c).toBeLessThanOrEqual(25)
    }
  })

  it('levelForScoreはスコアが大きいほど単調非減少なレベルを返す', () => {
    const scores = [1, 5, 5, 8, 12, 12, 12, 20, 33, 50]
    const thresholds = bucketDifficultyThresholds(scores)

    let prevLevel = levelForScore(Math.min(...scores) - 1, thresholds)
    for (const s of [...scores].sort((a, b) => a - b)) {
      const level = levelForScore(s, thresholds)
      expect(level).toBeGreaterThanOrEqual(prevLevel)
      prevLevel = level
    }
  })

  it('levelForScoreは常に1〜5の範囲に収まる', () => {
    const scores = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    const thresholds = bucketDifficultyThresholds(scores)
    for (const s of [-100, 0, 45, 1000]) {
      const level = levelForScore(s, thresholds)
      expect(level).toBeGreaterThanOrEqual(1)
      expect(level).toBeLessThanOrEqual(5)
    }
  })

  it('空配列を渡すと境界値は空配列(全件レベル1になる)', () => {
    const thresholds = bucketDifficultyThresholds([])
    expect(thresholds).toEqual([])
    expect(levelForScore(999, thresholds)).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { assemblePuzzles } from './assemble.ts'
import type { RawPuzzleGenCandidate } from './types.ts'

const EMPTY_BOARD = '-'.repeat(64)

function move(
  square: string,
  valueForMover: number,
  shallowEval: number,
  facts: { cornerSacrificeCandidate?: boolean; stableGain?: boolean } = {},
) {
  return {
    square,
    valueForMover,
    shallowEval,
    cornerSacrificeCandidate: facts.cornerSacrificeCandidate ?? false,
    stableGain: facts.stableGain ?? false,
  }
}

describe('tsume/assemble: assemblePuzzles', () => {
  it('唯一解性・明確さの両方を満たす候補のみ採用し、統計を正しく数える', () => {
    const candidates: RawPuzzleGenCandidate[] = [
      // 1. 採用: 正解手1つ(rank1、罠なし)。
      {
        id: 'c1',
        board: EMPTY_BOARD,
        sideToMove: 'black',
        empties: 10,
        moves: [move('d3', 10, 500), move('c4', 2, 100), move('f5', -4, 50)],
      },
      // 2. 除外(唯一解性): 3手が最善タイ。
      {
        id: 'c2',
        board: EMPTY_BOARD,
        sideToMove: 'black',
        empties: 10,
        moves: [move('d3', 10, 500), move('c4', 10, 400), move('f5', 10, 300), move('g6', 2, 10)],
      },
      // 3. 除外(明確さ): 最善と次善の差が2しかない。
      {
        id: 'c3',
        board: EMPTY_BOARD,
        sideToMove: 'black',
        empties: 10,
        moves: [move('d3', 10, 500), move('c4', 8, 100), move('f5', 2, 50)],
      },
      // 4. 採用: 正解手(b2、隅の犠牲)がrank2(浅い評価ではd3の方が良く見える罠あり)。
      {
        id: 'c4',
        board: EMPTY_BOARD,
        sideToMove: 'black',
        empties: 10,
        moves: [
          move('b2', 8, 50, { cornerSacrificeCandidate: true }),
          move('d3', 2, 900),
          move('f5', -6, 10),
        ],
      },
    ]

    const { puzzles, stats } = assemblePuzzles(candidates)

    expect(stats.totalCandidates).toBe(4)
    expect(stats.acceptedCount).toBe(2)
    expect(stats.rejectedUniqueness).toBe(1)
    expect(stats.rejectedClarity).toBe(1)
    expect(puzzles.map((p) => p.id).sort()).toEqual(['c1', 'c4'])

    const p1 = puzzles.find((p) => p.id === 'c1')!
    expect(p1.correctMoves).toEqual(['d3'])
    expect(p1.bestDiscDiff).toBe(10)
    expect(p1.outcome).toBe('win')
    expect(p1.clarityMargin).toBe(8)
    expect(p1.tags).toEqual([])
    expect(p1.board).toEqual({ black: '0x0000000000000000', white: '0x0000000000000000' })

    const p4 = puzzles.find((p) => p.id === 'c4')!
    expect(p4.correctMoves).toEqual(['b2'])
    expect(p4.bestDiscDiff).toBe(8)
    expect(p4.tags).toEqual(['corner-sacrifice'])

    // c4は正解手が浅い評価で2位(rank2、罠あり)、c1は1位(rank1、罠なし)なので、
    // 空き数が同じ(10)であればc4の方が難易度スコアが高い(=難しい)はず。
    expect(p4.difficultyRawScore).toBeGreaterThan(p1.difficultyRawScore)
    expect(p4.difficulty).toBeGreaterThanOrEqual(p1.difficulty)
    for (const p of puzzles) {
      expect(p.difficulty).toBeGreaterThanOrEqual(1)
      expect(p.difficulty).toBeLessThanOrEqual(5)
    }
  })

  it('全ての手のvalueForMoverが負(手番側が負ける)候補はoutcome=lossになる', () => {
    const candidates: RawPuzzleGenCandidate[] = [
      {
        id: 'c-lose',
        board: EMPTY_BOARD,
        sideToMove: 'white',
        empties: 8,
        moves: [move('a1', -2, 10), move('b1', -10, 5)],
      },
    ]
    const { puzzles } = assemblePuzzles(candidates)
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0]!.outcome).toBe('loss')
    expect(puzzles[0]!.bestDiscDiff).toBe(-2)
  })

  it('候補が0件なら空の結果を返す', () => {
    const { puzzles, stats } = assemblePuzzles([])
    expect(puzzles).toEqual([])
    expect(stats.totalCandidates).toBe(0)
    expect(stats.acceptedCount).toBe(0)
  })
})

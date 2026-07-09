import { describe, expect, it } from 'vitest'
import { buildProblemFromEntry, filterPoolBySource, pickProblem } from './pickProblem.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'

function makeEntry(id: string, overrides: Partial<MidgamePoolEntry> = {}): MidgamePoolEntry {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    turn: 'black',
    source: 'blunder-review',
    createdAt: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('verbalize/pickProblem', () => {
  describe('filterPoolBySource', () => {
    it('pool指定では全件を返す', () => {
      const entries = [makeEntry('a'), makeEntry('b', { source: 'other' })]
      expect(filterPoolBySource(entries, 'pool').map((e) => e.id)).toEqual(['a', 'b'])
    })

    it('myBlunder指定ではsource=blunder-reviewのみを返す', () => {
      const entries = [makeEntry('a', { source: 'blunder-review' }), makeEntry('b', { source: 'other' })]
      expect(filterPoolBySource(entries, 'myBlunder').map((e) => e.id)).toEqual(['a'])
    })
  })

  describe('buildProblemFromEntry', () => {
    it('16進文字列の盤面をbigintに復元し、positionKeyを付与する', () => {
      const entry = makeEntry('a', { turn: 'white' })
      const problem = buildProblemFromEntry(entry, 'pool')
      expect(problem.id).toBe('a')
      expect(problem.sideToMove).toBe('white')
      expect(problem.source).toBe('pool')
      expect(problem.board.black).toBe(BigInt('0x0000000810000000'))
      expect(problem.board.white).toBe(BigInt('0x0000001008000000'))
      expect(problem.positionKey).toContain('white')
    })
  })

  describe('pickProblem', () => {
    it('候補が空なら null を返す', () => {
      expect(pickProblem([], 'pool')).toBeNull()
      expect(pickProblem([makeEntry('a', { source: 'other' })], 'myBlunder')).toBeNull()
    })

    it('random()の値に応じて候補の中から決定的に1件選ぶ', () => {
      const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')]
      expect(pickProblem(entries, 'pool', () => 0)?.id).toBe('a')
      expect(pickProblem(entries, 'pool', () => 0.99)?.id).toBe('c')
    })
  })
})

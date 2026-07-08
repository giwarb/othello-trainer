import { describe, expect, it, vi } from 'vitest'
import { loadPuzzles, resetPuzzlesCacheForTest } from './loadPuzzles.ts'
import type { PuzzleFile } from './types.ts'

function makeFile(): PuzzleFile {
  return {
    generatedAt: '2026-07-08T23:09:10.127Z',
    puzzles: [
      {
        id: 'tsume-1',
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
      },
    ],
  }
}

describe('tsume/loadPuzzles', () => {
  it('fetchで取得したJSONをPuzzleFileとして返し、キャッシュして2回目以降はfetchしない', async () => {
    resetPuzzlesCacheForTest()
    const file = makeFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => file,
    })) as unknown as typeof fetch

    const loaded1 = await loadPuzzles(fetchImpl, '/base/')
    const loaded2 = await loadPuzzles(fetchImpl, '/base/')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/base/puzzles.json')
    expect(loaded1).toBe(loaded2)
    expect(loaded1.puzzles).toEqual(file.puzzles)

    resetPuzzlesCacheForTest()
  })

  it('fetchが失敗した場合は例外を伝播し、次回呼び出しで再試行できる', async () => {
    resetPuzzlesCacheForTest()
    const failingFetch = vi.fn(async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch

    await expect(loadPuzzles(failingFetch, '/base/')).rejects.toThrow('network error')
    expect(failingFetch).toHaveBeenCalledTimes(1)

    const file = makeFile()
    const succeedingFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => file,
    })) as unknown as typeof fetch

    const loaded = await loadPuzzles(succeedingFetch, '/base/')
    expect(loaded.puzzles.length).toBe(1)

    resetPuzzlesCacheForTest()
  })

  it('レスポンスがokでない場合は例外を投げる', async () => {
    resetPuzzlesCacheForTest()
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch

    await expect(loadPuzzles(fetchImpl, '/base/')).rejects.toThrow(/404/)
    resetPuzzlesCacheForTest()
  })
})

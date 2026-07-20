import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { applyMove, createBoard, initialBoard, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb, deserializeJosekiDb, serializeJosekiDb } from './buildDb.ts'
import {
  loadJosekiDb,
  loadOpeningBookDb,
  lookupJosekiNode,
  resetJosekiDbCacheForTest,
  resetOpeningBookDbCacheForTest,
} from './lookup.ts'
import { denormalizeSquare, opForFirstMove } from './normalize.ts'
import type { RawJosekiFile, RawJosekiLine } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAW_JOSEKI_PATH = path.resolve(__dirname, '../../../bookgen/joseki-research.json')

function loadRawLines(): readonly RawJosekiLine[] {
  const raw = JSON.parse(readFileSync(RAW_JOSEKI_PATH, 'utf-8')) as RawJosekiFile
  return raw.lines
}

describe('lookupJosekiNode', () => {
  const rawLines = loadRawLines()
  const db = buildJosekiDb(rawLines)

  it('検出: 初期局面(1手目未定)ではf5が(唯一の)bookMoveとして見つかる', () => {
    const result = lookupJosekiNode(db, initialBoard(), 'black', notationToSquare('f5'))
    expect(result).not.toBeNull()
    expect(result!.bookMoves.map((bm) => bm.move)).toEqual([notationToSquare('f5')])
    expect(result!.names.length).toBe(112)
  })

  it('検出: 「虎」の手順(f5-d6-c3-d3-c4)を実際に打ち進めた各局面がすべて定石DBに見つかる', () => {
    let board = initialBoard()
    let side: Side = 'black'
    const toraMoves = ['f5', 'd6', 'c3', 'd3', 'c4']

    for (const notation of toraMoves) {
      const result = lookupJosekiNode(db, board, side, notationToSquare('f5'))
      expect(result, `no joseki node before move ${notation}`).not.toBeNull()
      expect(result!.names).toContain('虎')
      expect(result!.bookMoves.map((bm) => bm.move)).toContain(notationToSquare(notation))

      board = applyMove(board, side, notationToSquare(notation))
      side = opposite(side)
    }

    // 5手打ち終えた最終局面は「虎」ラインの終端(isLeaf=true)。
    const leafResult = lookupJosekiNode(db, board, side, notationToSquare('f5'))
    expect(leafResult).not.toBeNull()
    expect(leafResult!.isLeaf).toBe(true)
  })

  it('検出: 初手がf5以外(実際の対局座標)でも、正しく正規化して定石を検出する', () => {
    // 実際の初手をd3にした対局をシミュレートする。opForFirstMove(d3) は
    // f5基準への変換(flipAntiDiag)を返す。「虎」の2手目(正規化後d6)に
    // 対応する実際の盤面座標は denormalizeSquare(d6, op) で求まる。
    const op = opForFirstMove(notationToSquare('d3'))

    let board = initialBoard()
    let side: Side = 'black'

    board = applyMove(board, side, notationToSquare('d3'))
    side = opposite(side)

    const realSecondMove = denormalizeSquare(notationToSquare('d6'), op)
    board = applyMove(board, side, realSecondMove)
    side = opposite(side)

    const result = lookupJosekiNode(db, board, side, notationToSquare('d3'))
    expect(result).not.toBeNull()
    expect(result!.names).toContain('虎')
    // f5基準の局面(実データ)では、f5-d6直後はisLeaf=true(「縦取り」の終端)。
    expect(result!.isLeaf).toBe(true)
  })

  it('未検出: 定石DBに無い局面ではnullを返す', () => {
    // 実戦であり得るかどうかに関わらず、既存のどのノードのハッシュとも
    // 一致し得ない人工的な盤面を使う。
    const offBookBoard: Board = createBoard([0], [63])
    const result = lookupJosekiNode(db, offBookBoard, 'black', notationToSquare('f5'))
    expect(result).toBeNull()
  })
})

describe('loadJosekiDb', () => {
  it('fetchで取得したJSONをJosekiDbとして復元し、キャッシュして2回目以降はfetchしない', async () => {
    resetJosekiDbCacheForTest()
    const rawLines = loadRawLines()
    const db = buildJosekiDb(rawLines)
    const serialized = serializeJosekiDb(db)

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => serialized,
    })) as unknown as typeof fetch

    const loaded1 = await loadJosekiDb(fetchImpl, '/base/')
    const loaded2 = await loadJosekiDb(fetchImpl, '/base/')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/base/joseki.json')
    expect(loaded1).toBe(loaded2)

    const restored = deserializeJosekiDb(serialized)
    expect(loaded1.lines).toEqual(restored.lines)
    expect(loaded1.nodes.size).toBe(restored.nodes.size)

    resetJosekiDbCacheForTest()
  })

  it('fetchが失敗した場合は例外を伝播し、次回呼び出しで再試行できる', async () => {
    resetJosekiDbCacheForTest()
    const failingFetch = vi.fn(async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch

    await expect(loadJosekiDb(failingFetch, '/base/')).rejects.toThrow('network error')
    expect(failingFetch).toHaveBeenCalledTimes(1)

    // 再試行できる(キャッシュが失敗したPromiseのまま残っていない)ことを確認。
    const rawLines = loadRawLines()
    const serialized = serializeJosekiDb(buildJosekiDb(rawLines))
    const succeedingFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => serialized,
    })) as unknown as typeof fetch

    const loaded = await loadJosekiDb(succeedingFetch, '/base/')
    expect(loaded.lines.length).toBe(112)

    resetJosekiDbCacheForTest()
  })
})

// T151: `loadOpeningBookDb`は`loadJosekiDb`と同じ実装を共有するが、
// (1) fetch先が`opening-book.json`であること、(2) 独立したキャッシュを持ち
// `loadJosekiDb`のfetchと混ざらないことを検証する。
describe('loadOpeningBookDb', () => {
  it('opening-book.jsonをfetchし、joseki.jsonとは独立にキャッシュする', async () => {
    resetJosekiDbCacheForTest()
    resetOpeningBookDbCacheForTest()

    const rawLines = loadRawLines()
    const serialized = serializeJosekiDb(buildJosekiDb(rawLines))

    const josekiFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => serialized,
    })) as unknown as typeof fetch
    const openingBookFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => serialized,
    })) as unknown as typeof fetch

    await loadJosekiDb(josekiFetch, '/base/')
    await loadOpeningBookDb(openingBookFetch, '/base/')

    expect(josekiFetch).toHaveBeenCalledWith('/base/joseki.json')
    expect(openingBookFetch).toHaveBeenCalledWith('/base/opening-book.json')

    // 2回目はどちらもキャッシュ済みのため、再fetchは発生しない。
    await loadJosekiDb(josekiFetch, '/base/')
    await loadOpeningBookDb(openingBookFetch, '/base/')
    expect(josekiFetch).toHaveBeenCalledTimes(1)
    expect(openingBookFetch).toHaveBeenCalledTimes(1)

    resetJosekiDbCacheForTest()
    resetOpeningBookDbCacheForTest()
  })

  it('fetchが失敗した場合は例外を伝播し、次回呼び出しで再試行できる', async () => {
    resetOpeningBookDbCacheForTest()
    const failingFetch = vi.fn(async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch

    await expect(loadOpeningBookDb(failingFetch, '/base/')).rejects.toThrow('network error')
    expect(failingFetch).toHaveBeenCalledTimes(1)

    const rawLines = loadRawLines()
    const serialized = serializeJosekiDb(buildJosekiDb(rawLines))
    const succeedingFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => serialized,
    })) as unknown as typeof fetch

    const loaded = await loadOpeningBookDb(succeedingFetch, '/base/')
    expect(loaded.lines.length).toBe(112)

    resetOpeningBookDbCacheForTest()
  })
})

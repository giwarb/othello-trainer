import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { notationToSquare } from '../game/othello.ts'
import { buildJosekiDb, deserializeJosekiDb, serializeJosekiDb } from './buildDb.ts'
import { hashBoard, normalizeBoard, opForFirstMove } from './normalize.ts'
import type { RawJosekiFile, RawJosekiLine } from './types.ts'
import { applyMove, initialBoard, opposite, type Board, type Side } from '../game/othello.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAW_JOSEKI_PATH = path.resolve(__dirname, '../../../bookgen/joseki-research.json')

function loadRawLines(): readonly RawJosekiLine[] {
  const raw = JSON.parse(readFileSync(RAW_JOSEKI_PATH, 'utf-8')) as RawJosekiFile
  return raw.lines
}

/** テスト用ヘルパー: "a1"記法の着手列を初期局面から順に適用した最終盤面/手番を返す。 */
function playSequence(notations: readonly string[]): { board: Board; side: Side } {
  let board = initialBoard()
  let side: Side = 'black'
  for (const notation of notations) {
    board = applyMove(board, side, notationToSquare(notation))
    side = opposite(side)
  }
  return { board, side }
}

describe('buildJosekiDb with the real bookgen/joseki-research.json', () => {
  const rawLines = loadRawLines()
  const db = buildJosekiDb(rawLines)

  it('reflects all 90 lines from T016+T025', () => {
    expect(rawLines.length).toBe(90)
    expect(db.lines.length).toBe(90)
    expect(db.lines.map((l) => l.name).sort()).toEqual(rawLines.map((l) => l.name).sort())
  })

  it('builds a non-trivial DAG (many nodes, confluent at shallow depth)', () => {
    // ルート(初期局面)+各ラインの各手数だけノードがありうるが、合流により
    // ノード数は「全ラインのdepth合計」より必ず少なくなる(少なくとも
    // 「f5」直後の局面はほぼ全ラインが共有するため)。
    const totalMoveCount = rawLines.reduce((sum, l) => sum + l.moves.length, 0)
    expect(db.nodes.size).toBeGreaterThan(0)
    expect(db.nodes.size).toBeLessThan(totalMoveCount)
  })

  it('walks the known "虎" (tora) line f5-d6-c3-d3-c4 and finds the correct bookMoves at each step', () => {
    const toraLine = rawLines.find((l) => l.name === '虎')
    expect(toraLine).toBeDefined()
    expect(toraLine!.moves).toEqual(['f5', 'd6', 'c3', 'd3', 'c4'])

    // 虎は firstMoveBasis が f5 なので正規化は恒等変換(op='identity')。
    let board = initialBoard()
    let side: Side = 'black'
    const expectedNextMoves = ['f5', 'd6', 'c3', 'd3', 'c4']

    for (const expectedMove of expectedNextMoves) {
      const key = hashBoard(board, side)
      const node = db.nodes.get(key)
      expect(node, `node missing for key ${key} (before move ${expectedMove})`).toBeDefined()
      const moveSquares = node!.bookMoves.map((bm) => bm.move)
      expect(moveSquares).toContain(notationToSquare(expectedMove))
      expect(node!.names).toContain('虎')

      board = applyMove(board, side, notationToSquare(expectedMove))
      side = opposite(side)
    }

    // 5手打ち終えた最終局面は「虎」ラインの終端(isLeaf=true)。
    const leafKey = hashBoard(board, side)
    const leafNode = db.nodes.get(leafKey)
    expect(leafNode).toBeDefined()
    expect(leafNode!.isLeaf).toBe(true)
    expect(leafNode!.names).toContain('虎')
  })

  it('confluence: multiple joseki lines sharing the f5-d6 prefix all register their name on the same node', () => {
    // 虎・猫・羊・虎C・虎D・虎E・兎・馬・野兎・縦取り は全て f5,d6 で始まる。
    const { board, side } = playSequence(['f5', 'd6'])
    const node = db.nodes.get(hashBoard(board, side))
    expect(node).toBeDefined()

    const expectedNames = ['虎', '猫', '羊', '虎C', '虎D', '虎E', '兎', '馬', '野兎', '縦取り']
    for (const name of expectedNames) {
      expect(node!.names).toContain(name)
    }

    // 縦取り(f5,d6のみ、depth2)はこの局面自体が終端。
    expect(node!.isLeaf).toBe(true)

    // この局面からの分岐候補(bookMoves)には、虎/兎/野兎などの3手目が
    // 複数含まれているはず(c3, c4, c5, c6 のいずれか)。
    const branchSquares = node!.bookMoves.map((bm) => bm.move).sort((a, b) => a - b)
    expect(branchSquares.length).toBeGreaterThan(1)

    // 均等重み: 分岐数がNなら各重みは1/N、合計は1に近い。
    const totalWeight = node!.bookMoves.reduce((sum, bm) => sum + bm.weight, 0)
    expect(totalWeight).toBeCloseTo(1, 10)
    for (const bm of node!.bookMoves) {
      expect(bm.weight).toBeCloseTo(1 / node!.bookMoves.length, 10)
    }
  })

  it('the root node (initial position) has f5 as (one of) its book moves for all lines', () => {
    const rootKey = hashBoard(initialBoard(), 'black')
    const node = db.nodes.get(rootKey)
    expect(node).toBeDefined()
    // 全90ラインが f5 基準に正規化されているため、初手は常に f5 になる。
    const moveSquares = node!.bookMoves.map((bm) => bm.move)
    expect(moveSquares).toEqual([notationToSquare('f5')])
    expect(node!.names.length).toBe(90)
  })

  it('serializeJosekiDb / deserializeJosekiDb round-trip losslessly', () => {
    const serialized = serializeJosekiDb(db)
    const restored = deserializeJosekiDb(serialized)
    expect(restored.lines).toEqual(db.lines)
    expect(restored.nodes.size).toBe(db.nodes.size)
    for (const [key, node] of db.nodes) {
      expect(restored.nodes.get(key)).toEqual(node)
    }
  })

  it('sanity: opForFirstMove agrees with the data (all lines are f5-basis => identity op)', () => {
    for (const line of rawLines) {
      expect(line.firstMoveBasis).toBe('f5')
      const firstSquare = notationToSquare(line.moves[0]!)
      expect(opForFirstMove(firstSquare)).toBe('identity')
      // 恒等変換なので normalizeBoard は何もしない。
      const board = initialBoard()
      expect(normalizeBoard(board, 'identity')).toEqual(board)
    }
  })
})

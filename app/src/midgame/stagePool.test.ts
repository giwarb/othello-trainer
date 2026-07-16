import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare, opposite, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { RawJosekiFile, RawJosekiLine } from '../joseki/types.ts'
import { buildMidgameStagePool, parseStageKey } from './stagePool.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAW_JOSEKI_PATH = path.resolve(__dirname, '../../../bookgen/joseki-research.json')

/** `buildDb.test.ts`と同じ手法: 実データ(`bookgen/joseki-research.json`)を読み込む。 */
function loadRealRawLines(): readonly RawJosekiLine[] {
  const raw = JSON.parse(readFileSync(RAW_JOSEKI_PATH, 'utf-8')) as RawJosekiFile
  return raw.lines
}

function makeLine(name: string, moves: readonly string[], depth = moves.length): RawJosekiLine {
  return { name, aliases: [], moves, firstMoveBasis: 'f5', depth }
}

describe('buildMidgameStagePool', () => {
  it('実データ(bookgen/joseki-research.json)から決定的にステージを列挙できる(要件1・3)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    // 実データのライン数(112件)に対し、終端局面の重複除去後は111件になる
    // ことを確認済み(作業ログ参照)。bookgen/joseki-research.jsonの内容が
    // 将来更新された場合はこの数値も見直すこと。
    expect(rawLines.length).toBe(112)
    expect(stages.length).toBe(111)
  })

  it('2回列挙しても同一の結果になる(決定性、要件6)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)

    const first = buildMidgameStagePool(db)
    const second = buildMidgameStagePool(db)

    expect(second).toEqual(first)
    expect(first.map((s) => s.key)).toEqual(second.map((s) => s.key))
  })

  it('別々に構築した同一内容のJosekiDbからも同じ順序で列挙される(Map挿入順に依存しないことの確認)', () => {
    const rawLines = loadRealRawLines()
    const dbA = buildJosekiDb(rawLines)
    // ライン順を変えて構築する(Mapへのノード挿入順が変わるはず)。
    const dbB = buildJosekiDb([...rawLines].reverse())

    const stagesA = buildMidgameStagePool(dbA)
    const stagesB = buildMidgameStagePool(dbB)

    expect(stagesA.map((s) => s.key)).toEqual(stagesB.map((s) => s.key))
  })

  it('キーが辞書順にソートされている(決定的な順序、要件1)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    const keys = stages.map((s) => s.key)
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
  })

  it('stageNumberは1始まりの連番で、配列の並び順と一致する', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    stages.forEach((stage, index) => {
      expect(stage.stageNumber).toBe(index + 1)
    })
  })

  it('同一終端局面に到達する2ラインは1ステージに重複除去され、josekiNamesに両方の名前が入る(要件1)', () => {
    // "小定石A"(f5,f6)と"小定石B"(f5,f6,e6,f4)は前者が後者の途中に
    // 一致するわけではなく、ここでは同一の最終局面に別ラインから到達する
    // ケースとして、同じmoveSeqを持つ2つのラインを用意する(名前だけ異なる)。
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6']), makeLine('定石B', ['f5', 'f6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    expect(stages).toHaveLength(1)
    expect(stages[0]!.josekiNames).toEqual(['定石A', '定石B'])
  })

  it('異なる終端局面を持つラインはそれぞれ別ステージになる', () => {
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6']), makeLine('定石C', ['f5', 'd6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    expect(stages).toHaveLength(2)
    const keys = new Set(stages.map((s) => s.key))
    expect(keys.size).toBe(2)
  })

  it('列挙されたboard/sideToMoveが、実際にmoveSeqを再生した局面と一致する', () => {
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6', 'e6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)
    expect(stages).toHaveLength(1)

    // 期待値: 初期局面からf5,f6,e6を順に適用した局面(正規化変換はf5始まりのため恒等変換)。
    let expectedBoard = initialBoard()
    let expectedSide: Side = 'black'
    for (const notation of ['f5', 'f6', 'e6']) {
      expectedBoard = applyMove(expectedBoard, expectedSide, notationToSquare(notation))
      expectedSide = opposite(expectedSide)
    }

    expect(stages[0]!.board).toEqual(expectedBoard)
    expect(stages[0]!.sideToMove).toBe(expectedSide)
    expect(stages[0]!.key).toBe(hashBoard(expectedBoard, expectedSide))
  })
})

describe('parseStageKey', () => {
  it('hashBoardの出力を往復できる(round-trip)', () => {
    let board = initialBoard()
    let side: Side = 'black'
    board = applyMove(board, side, notationToSquare('f5'))
    side = opposite(side)

    const key = hashBoard(board, side)
    const parsed = parseStageKey(key)

    expect(parsed.board).toEqual(board)
    expect(parsed.sideToMove).toBe(side)
  })

  it('形式が不正なキーは例外を投げる', () => {
    expect(() => parseStageKey('invalid')).toThrow(RangeError)
    expect(() => parseStageKey('abc_def_purple')).toThrow(RangeError)
    expect(() => parseStageKey('abc_def')).toThrow(RangeError)
  })
})

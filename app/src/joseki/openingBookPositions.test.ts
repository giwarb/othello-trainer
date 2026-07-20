import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyMove,
  countDiscs,
  hasLegalMove,
  initialBoard,
  isTerminal,
  legalMoves,
  opposite,
  type Side,
} from '../game/othello.ts'
import { buildJosekiDb } from './buildDb.ts'
import { hashBoard } from './normalize.ts'
import { boardToObf, collectMoveEvalRequests, parseNodeKey } from './openingBookPositions.ts'
import type { RawJosekiFile, RawJosekiLine } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAW_JOSEKI_PATH = path.resolve(__dirname, '../../../bookgen/joseki-research.json')
const RAW_WTHOR_PATH = path.resolve(__dirname, '../../../bookgen/wthor-lines.json')

function loadRawLines(fixturePath: string): readonly RawJosekiLine[] {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as RawJosekiFile
  return raw.lines
}

describe('boardToObf / parseNodeKey', () => {
  it('boardToObfは初期局面をEdax/OBF形式の64文字に変換する(中央4マスのみX/O)', () => {
    const obf = boardToObf(initialBoard())
    expect(obf).toHaveLength(64)
    // d4=27(白), e4=28(黒), d5=35(黒), e5=36(白)
    const expected = Array.from({ length: 64 }, (_, i) => {
      if (i === 28 || i === 35) return 'X'
      if (i === 27 || i === 36) return 'O'
      return '-'
    }).join('')
    expect(obf).toBe(expected)
  })

  it('parseNodeKeyはhashBoardの逆変換になっている(round-trip)', () => {
    const board = initialBoard()
    const side: Side = 'black'
    const key = hashBoard(board, side)
    const parsed = parseNodeKey(key)
    expect(parsed.side).toBe(side)
    expect(parsed.board).toEqual(board)
  })

  it('parseNodeKeyは不正な形式のキーで例外を投げる', () => {
    expect(() => parseNodeKey('not-a-valid-key')).toThrow(RangeError)
    expect(() => parseNodeKey('1_2_purple')).toThrow(RangeError)
  })
})

describe('collectMoveEvalRequests (small synthetic db)', () => {
  const rawLines: RawJosekiLine[] = [
    {
      name: 'テスト定石A',
      moves: ['f5', 'f4', 'c3'],
      firstMoveBasis: 'f5',
      depth: 3,
    },
  ]
  const db = buildJosekiDb(rawLines)

  it('各ノードについて、bookMovesに限らずlegalMovesの全件をrequestsに含む(要件1)', () => {
    const { requests } = collectMoveEvalRequests(db)

    for (const nodeKey of db.nodes.keys()) {
      const { board, side } = parseNodeKey(nodeKey)
      const expectedMoves = legalMoves(board, side)
      const actualMoves = requests
        .filter((r) => r.nodeKey === nodeKey)
        .map((r) => r.move)
        .sort((a, b) => a - b)
      expect(actualMoves).toEqual([...expectedMoves].sort((a, b) => a - b))
    }
  })

  it('初期局面(ルート)の合法手は4つとも通常ケース(非終局)で、needsFlip=trueになる', () => {
    const { requests } = collectMoveEvalRequests(db)
    const rootKey = hashBoard(initialBoard(), 'black')
    const rootRequests = requests.filter((r) => r.nodeKey === rootKey)
    expect(rootRequests).toHaveLength(4)
    for (const r of rootRequests) {
      expect(r.terminal).toBe(false)
      expect(r.needsFlip).toBe(true)
      expect(r.positionKey).toBeDefined()
    }
  })

  it('positionsはpositionKeyで重複排除されている(同じ着手後局面への合流)', () => {
    const { requests, positions } = collectMoveEvalRequests(db)
    const nonTerminalKeys = requests.filter((r) => !r.terminal).map((r) => r.positionKey!)
    const uniqueKeys = new Set(nonTerminalKeys)
    expect(positions.map((p) => p.key).sort()).toEqual([...uniqueKeys].sort())
    expect(new Set(positions.map((p) => p.key)).size).toBe(positions.length)
  })

  it('positionsの各エントリは着手後局面のboard(OBF)/sideと整合する', () => {
    const { positions } = collectMoveEvalRequests(db)
    for (const pos of positions) {
      const { board, side } = parseNodeKey(pos.key)
      expect(pos.side).toBe(side)
      expect(pos.board).toBe(boardToObf(board))
    }
  })
})

describe('collectMoveEvalRequests (実データ全件をゲームルールのオラクルと突き合わせ)', () => {
  // bookgen/joseki-research.json(112ライン)+bookgen/wthor-lines.json(251ライン)を
  // 統合した実データ全件について、`requests`の各エントリ(terminal/needsFlip/
  // positionKey/terminalValue)が`app/src/game/othello.ts`の実装(isTerminal/
  // hasLegalMove/applyMove/countDiscs)から独立に再計算した「あるべき値」と
  // 一致することを検証する。パス(相手が着手後に手番を持てず、元の手番が
  // 続行する)のケースは実データ中で自然に発生するかどうか保証できないため、
  // 個別の具体例を用意する代わりに全件を独立再計算と突き合わせることで
  // needsFlip=falseの分岐(パス)ロジックの正しさも(発生していれば)担保する。
  const rawLines = [...loadRawLines(RAW_JOSEKI_PATH), ...loadRawLines(RAW_WTHOR_PATH)]
  const db = buildJosekiDb(rawLines)
  const { requests, positions } = collectMoveEvalRequests(db)
  const positionsByKey = new Map(positions.map((p) => [p.key, p]))

  it('統合DBは800ノード以上を持つ(T150の見込み800〜1400と整合)', () => {
    expect(db.nodes.size).toBeGreaterThan(800)
  })

  it('全requestsがオラクル(othello.tsの実装から独立に再計算した期待値)と一致する', () => {
    let terminalCount = 0
    let normalCount = 0
    let passCount = 0

    for (const r of requests) {
      const { board, side } = parseNodeKey(r.nodeKey)
      const after = applyMove(board, side, r.move)
      const opponent = opposite(side)

      if (isTerminal(after)) {
        terminalCount++
        expect(r.terminal).toBe(true)
        expect(r.terminalValue).toBe(countDiscs(after, side) - countDiscs(after, opponent))
        expect(r.positionKey).toBeUndefined()
        expect(r.needsFlip).toBeUndefined()
        continue
      }

      expect(r.terminal).toBe(false)
      const effectiveSide: Side = hasLegalMove(after, opponent) ? opponent : side
      const expectedNeedsFlip = effectiveSide !== side
      expect(r.needsFlip).toBe(expectedNeedsFlip)
      expect(r.positionKey).toBe(hashBoard(after, effectiveSide))
      expect(positionsByKey.has(r.positionKey!)).toBe(true)
      const pos = positionsByKey.get(r.positionKey!)!
      expect(pos.side).toBe(effectiveSide)
      expect(pos.board).toBe(boardToObf(after))

      if (expectedNeedsFlip) normalCount++
      else passCount++
    }

    expect(terminalCount + normalCount + passCount).toBe(requests.length)
    // 定石データはいずれも浅い(depth<=16程度)ため、収集した合法手のうち
    // 大多数は「通常ケース(相手番に手番が渡る)」になっているはず。
    expect(normalCount).toBeGreaterThan(0)
  })
})

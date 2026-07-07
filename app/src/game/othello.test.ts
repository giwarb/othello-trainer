import { describe, expect, it } from 'vitest'
import {
  applyMove,
  cellAt,
  countDiscs,
  countEmpty,
  createBoard,
  hasLegalMove,
  initialBoard,
  isTerminal,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
} from './othello.ts'

describe('opposite', () => {
  it('flips black/white', () => {
    expect(opposite('black')).toBe('white')
    expect(opposite('white')).toBe('black')
  })
})

describe('notation <-> square conversion', () => {
  it('matches the engine bitboard convention (a1 = 0, h8 = 63)', () => {
    expect(notationToSquare('a1')).toBe(0)
    expect(notationToSquare('h1')).toBe(7)
    expect(notationToSquare('a2')).toBe(8)
    expect(notationToSquare('h8')).toBe(63)
    expect(notationToSquare('d4')).toBe(27)
    expect(notationToSquare('e5')).toBe(36)
  })

  it('round-trips through squareToNotation', () => {
    for (const notation of ['a1', 'h1', 'a8', 'h8', 'd3', 'c4', 'f5', 'e6']) {
      expect(squareToNotation(notationToSquare(notation))).toBe(notation)
    }
  })
})

describe('initialBoard', () => {
  it('places the standard four center discs', () => {
    const board = initialBoard()
    expect(cellAt(board, notationToSquare('d4'))).toBe('white')
    expect(cellAt(board, notationToSquare('e5'))).toBe('white')
    expect(cellAt(board, notationToSquare('e4'))).toBe('black')
    expect(cellAt(board, notationToSquare('d5'))).toBe('black')
    expect(countDiscs(board, 'black')).toBe(2)
    expect(countDiscs(board, 'white')).toBe(2)
    expect(countEmpty(board)).toBe(60)
  })

  it("black's opening legal moves are d3, c4, f5, e6", () => {
    const board = initialBoard()
    const moves = legalMoves(board, 'black').map(squareToNotation).sort()
    expect(moves).toEqual(['c4', 'd3', 'e6', 'f5'])
  })

  it("white's opening legal moves are c5, d6, e3, f4", () => {
    const board = initialBoard()
    const moves = legalMoves(board, 'white').map(squareToNotation).sort()
    expect(moves).toEqual(['c5', 'd6', 'e3', 'f4'])
  })
})

describe('applyMove', () => {
  it('flips the correct disc when black opens with d3', () => {
    const board = initialBoard()
    const next = applyMove(board, 'black', notationToSquare('d3'))

    // 標準的な最初の一手: d3に打つとd4が黒にひっくり返り、
    // 黒4枚(d3,d4,d5,e4)・白1枚(e5)になる。
    expect(cellAt(next, notationToSquare('d3'))).toBe('black')
    expect(cellAt(next, notationToSquare('d4'))).toBe('black')
    expect(cellAt(next, notationToSquare('d5'))).toBe('black')
    expect(cellAt(next, notationToSquare('e4'))).toBe('black')
    expect(cellAt(next, notationToSquare('e5'))).toBe('white')

    expect(countDiscs(next, 'black')).toBe(4)
    expect(countDiscs(next, 'white')).toBe(1)
    expect(countEmpty(next)).toBe(59)
  })

  it('flips discs in multiple directions at once', () => {
    // 人工局面: c4=黒, d4=白, e4=空(着手マス), e5=白, e6=黒。
    // 黒がe4に打つと、西方向(d4を挟む)と南方向(e5を挟む)の両方で
    // ひっくり返しが発生することを確認する。
    const board = createBoard(
      [notationToSquare('c4'), notationToSquare('e6')],
      [notationToSquare('d4'), notationToSquare('e5')],
    )

    expect(legalMoves(board, 'black')).toContain(notationToSquare('e4'))

    const next = applyMove(board, 'black', notationToSquare('e4'))
    expect(cellAt(next, notationToSquare('e4'))).toBe('black')
    expect(cellAt(next, notationToSquare('d4'))).toBe('black')
    expect(cellAt(next, notationToSquare('e5'))).toBe('black')
    expect(cellAt(next, notationToSquare('c4'))).toBe('black')
    expect(cellAt(next, notationToSquare('e6'))).toBe('black')
    expect(countDiscs(next, 'white')).toBe(0)
  })

  it('flips a run of multiple opponent discs in one direction', () => {
    // a1(黒) - b1(白) - c1(白) - d1(白) - e1(空) で、黒がe1に打つと
    // b1,c1,d1がまとめてひっくり返る。
    const board = createBoard(
      [notationToSquare('a1')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1')],
    )
    expect(legalMoves(board, 'black')).toContain(notationToSquare('e1'))

    const next = applyMove(board, 'black', notationToSquare('e1'))
    expect(cellAt(next, notationToSquare('a1'))).toBe('black')
    expect(cellAt(next, notationToSquare('b1'))).toBe('black')
    expect(cellAt(next, notationToSquare('c1'))).toBe('black')
    expect(cellAt(next, notationToSquare('d1'))).toBe('black')
    expect(cellAt(next, notationToSquare('e1'))).toBe('black')
    expect(countDiscs(next, 'white')).toBe(0)
  })
})

describe('pass / terminal detection (artificial boundary positions)', () => {
  it('one side must pass while the other still has a legal move', () => {
    // a1=黒, b1=白, 他は全て空き。
    // 黒はc1に打ってb1を挟める(合法手あり)が、
    // 白は盤上に他の石が無いため、どの方向にも「相手を挟んで自分の石に
    // 到達する」パターンが作れず、合法手が存在しない(パス)。
    const board = createBoard([notationToSquare('a1')], [notationToSquare('b1')])

    expect(hasLegalMove(board, 'black')).toBe(true)
    expect(legalMoves(board, 'black')).toEqual([notationToSquare('c1')])
    expect(hasLegalMove(board, 'white')).toBe(false)
    expect(legalMoves(board, 'white')).toEqual([])

    // 片方でも合法手があるので終局ではない。
    expect(isTerminal(board)).toBe(false)
  })

  it('is terminal when neither side has a legal move', () => {
    // 盤上に黒石が1つだけ存在し、白石が無い状態: 両者とも合法手なし。
    const board = createBoard([notationToSquare('d4')], [])

    expect(hasLegalMove(board, 'black')).toBe(false)
    expect(hasLegalMove(board, 'white')).toBe(false)
    expect(isTerminal(board)).toBe(true)
  })

  it('is terminal when the board is completely full', () => {
    const allSquares = Array.from({ length: 64 }, (_, i) => i)
    const board = createBoard(allSquares, [])

    expect(countDiscs(board, 'black')).toBe(64)
    expect(countDiscs(board, 'white')).toBe(0)
    expect(countEmpty(board)).toBe(0)
    expect(isTerminal(board)).toBe(true)
  })
})

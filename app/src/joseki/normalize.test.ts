import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare } from '../game/othello.ts'
import { denormalizeSquare, hashBoard, normalizeBoard, normalizeSquare, opForFirstMove } from './normalize.ts'

describe('opForFirstMove', () => {
  it('maps each of the 4 legal opening squares to a symmetry op', () => {
    expect(opForFirstMove(notationToSquare('f5'))).toBe('identity')
    expect(opForFirstMove(notationToSquare('d3'))).toBe('flipAntiDiag')
    expect(opForFirstMove(notationToSquare('c4'))).toBe('rot180')
    expect(opForFirstMove(notationToSquare('e6'))).toBe('flipDiag')
  })

  it('throws for a square that is not a legal opening move', () => {
    expect(() => opForFirstMove(notationToSquare('a1'))).toThrow(RangeError)
    expect(() => opForFirstMove(notationToSquare('d4'))).toThrow(RangeError)
  })
})

// ★最重要テスト★
// 初期局面から4通りの初手(f5/d3/c4/e6)それぞれを打った盤面について、
// 正規化変換を適用すると、すべて「f5を打った場合の盤面」と完全に一致する
// ことを確認する。8対称変換の実装ミスが最も起きやすい箇所であり、これが
// 崩れると定石DB全体の局面照合(合流判定)が破綻するため、bit単位の
// 完全一致で検証する。
describe('normalizeBoard: the 4 opening moves all normalize to the same board as f5', () => {
  const f5Board = applyMove(initialBoard(), 'black', notationToSquare('f5'))

  it('f5 (identity) matches itself', () => {
    const played = applyMove(initialBoard(), 'black', notationToSquare('f5'))
    const op = opForFirstMove(notationToSquare('f5'))
    const normalized = normalizeBoard(played, op)
    expect(normalized).toEqual(f5Board)
    expect(normalized.black).toBe(f5Board.black)
    expect(normalized.white).toBe(f5Board.white)
  })

  it('d3 normalizes to the f5 board', () => {
    const played = applyMove(initialBoard(), 'black', notationToSquare('d3'))
    const op = opForFirstMove(notationToSquare('d3'))
    const normalized = normalizeBoard(played, op)
    expect(normalized.black).toBe(f5Board.black)
    expect(normalized.white).toBe(f5Board.white)
  })

  it('c4 normalizes to the f5 board', () => {
    const played = applyMove(initialBoard(), 'black', notationToSquare('c4'))
    const op = opForFirstMove(notationToSquare('c4'))
    const normalized = normalizeBoard(played, op)
    expect(normalized.black).toBe(f5Board.black)
    expect(normalized.white).toBe(f5Board.white)
  })

  it('e6 normalizes to the f5 board', () => {
    const played = applyMove(initialBoard(), 'black', notationToSquare('e6'))
    const op = opForFirstMove(notationToSquare('e6'))
    const normalized = normalizeBoard(played, op)
    expect(normalized.black).toBe(f5Board.black)
    expect(normalized.white).toBe(f5Board.white)
  })

  it('all 4 openings hash identically after normalization (side to move = white)', () => {
    const openings = ['f5', 'd3', 'c4', 'e6'] as const
    const hashes = openings.map((notation) => {
      const square = notationToSquare(notation)
      const played = applyMove(initialBoard(), 'black', square)
      const op = opForFirstMove(square)
      return hashBoard(normalizeBoard(played, op), 'white')
    })
    expect(new Set(hashes).size).toBe(1)
  })

  it('the normalized first-move square itself is always f5', () => {
    const f5 = notationToSquare('f5')
    for (const notation of ['f5', 'd3', 'c4', 'e6'] as const) {
      const square = notationToSquare(notation)
      const op = opForFirstMove(square)
      expect(normalizeSquare(square, op)).toBe(f5)
    }
  })
})

describe('denormalizeSquare', () => {
  it('inverts normalizeSquare for every opening + every board square', () => {
    for (const notation of ['f5', 'd3', 'c4', 'e6'] as const) {
      const op = opForFirstMove(notationToSquare(notation))
      for (let sq = 0; sq < 64; sq++) {
        const normalized = normalizeSquare(sq, op)
        expect(denormalizeSquare(normalized, op)).toBe(sq)
      }
    }
  })
})

describe('hashBoard', () => {
  it('produces distinct hashes for different boards or different side to move', () => {
    const a = initialBoard()
    const b = applyMove(a, 'black', notationToSquare('f5'))
    expect(hashBoard(a, 'black')).not.toBe(hashBoard(b, 'white'))
    expect(hashBoard(a, 'black')).not.toBe(hashBoard(a, 'white'))
  })

  it('produces identical hashes for structurally identical boards', () => {
    const a = initialBoard()
    const b = initialBoard()
    expect(hashBoard(a, 'black')).toBe(hashBoard(b, 'black'))
  })
})

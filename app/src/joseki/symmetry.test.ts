import { describe, expect, it } from 'vitest'
import { notationToSquare, squareToNotation } from '../game/othello.ts'
import { ALL_SYMMETRY_OPS, inverseOp, transformBoard, transformSquare } from './symmetry.ts'

describe('transformSquare', () => {
  it('leaves squares unchanged under identity', () => {
    for (let sq = 0; sq < 64; sq++) {
      expect(transformSquare('identity', sq)).toBe(sq)
    }
  })

  it('maps the four corners as expected for each op (hand-verified geometry)', () => {
    const a1 = notationToSquare('a1')
    const h1 = notationToSquare('h1')
    const a8 = notationToSquare('a8')
    const h8 = notationToSquare('h8')

    // 90°回転(時計回り): a1 -> h1 -> h8 -> a8 -> a1 と巡回する。
    expect(transformSquare('rot90', a1)).toBe(h1)
    expect(transformSquare('rot90', h1)).toBe(h8)
    expect(transformSquare('rot90', h8)).toBe(a8)
    expect(transformSquare('rot90', a8)).toBe(a1)

    // 180°回転: 対角線上で向かい合う隅同士が入れ替わる。
    expect(transformSquare('rot180', a1)).toBe(h8)
    expect(transformSquare('rot180', h8)).toBe(a1)
    expect(transformSquare('rot180', h1)).toBe(a8)
    expect(transformSquare('rot180', a8)).toBe(h1)

    // 270°回転(反時計回り90°): rot90の逆順に巡回する。
    expect(transformSquare('rot270', a1)).toBe(a8)
    expect(transformSquare('rot270', a8)).toBe(h8)
    expect(transformSquare('rot270', h8)).toBe(h1)
    expect(transformSquare('rot270', h1)).toBe(a1)

    // 水平反転(列を反転): a1<->h1, a8<->h8。
    expect(transformSquare('flipH', a1)).toBe(h1)
    expect(transformSquare('flipH', h1)).toBe(a1)
    expect(transformSquare('flipH', a8)).toBe(h8)
    expect(transformSquare('flipH', h8)).toBe(a8)

    // 垂直反転(行を反転): a1<->a8, h1<->h8。
    expect(transformSquare('flipV', a1)).toBe(a8)
    expect(transformSquare('flipV', a8)).toBe(a1)
    expect(transformSquare('flipV', h1)).toBe(h8)
    expect(transformSquare('flipV', h8)).toBe(h1)

    // 主対角線(a1-h8)反転: a1,h8は不動、h1<->a8。
    expect(transformSquare('flipDiag', a1)).toBe(a1)
    expect(transformSquare('flipDiag', h8)).toBe(h8)
    expect(transformSquare('flipDiag', h1)).toBe(a8)
    expect(transformSquare('flipDiag', a8)).toBe(h1)

    // 反対角線(a8-h1)反転: h1,a8は不動、a1<->h8。
    expect(transformSquare('flipAntiDiag', h1)).toBe(h1)
    expect(transformSquare('flipAntiDiag', a8)).toBe(a8)
    expect(transformSquare('flipAntiDiag', a1)).toBe(h8)
    expect(transformSquare('flipAntiDiag', h8)).toBe(a1)
  })

  it('is a bijection on 0..63 for every op', () => {
    for (const op of ALL_SYMMETRY_OPS) {
      const seen = new Set<number>()
      for (let sq = 0; sq < 64; sq++) {
        const t = transformSquare(op, sq)
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThan(64)
        expect(seen.has(t)).toBe(false)
        seen.add(t)
      }
      expect(seen.size).toBe(64)
    }
  })

  it('round-trips through the inverse op for every square and every op', () => {
    for (const op of ALL_SYMMETRY_OPS) {
      const inv = inverseOp(op)
      for (let sq = 0; sq < 64; sq++) {
        expect(transformSquare(inv, transformSquare(op, sq))).toBe(sq)
        expect(transformSquare(op, transformSquare(inv, sq))).toBe(sq)
      }
    }
  })
})

describe('transformBoard', () => {
  it('leaves a board unchanged under identity', () => {
    const board = { black: 0b1010n, white: 0b0101n }
    expect(transformBoard(board, 'identity')).toEqual(board)
  })

  it('round-trips through the inverse op for an arbitrary board', () => {
    // 適当に散らしたマス目(全マスをカバーするわけではない実戦的なパターン)。
    const blackSquares = ['a1', 'd4', 'f5', 'h8', 'b7', 'g2'].map(notationToSquare)
    const whiteSquares = ['h1', 'e5', 'c3', 'a8', 'g6', 'b2'].map(notationToSquare)
    let black = 0n
    let white = 0n
    for (const sq of blackSquares) black |= 1n << BigInt(sq)
    for (const sq of whiteSquares) white |= 1n << BigInt(sq)
    const board = { black, white }

    for (const op of ALL_SYMMETRY_OPS) {
      const transformed = transformBoard(board, op)
      const roundTripped = transformBoard(transformed, inverseOp(op))
      expect(roundTripped).toEqual(board)
    }
  })

  it('matches transformSquare for each individual set bit', () => {
    const squares = ['a1', 'd4', 'f5', 'h8', 'c6'].map(notationToSquare)
    let black = 0n
    for (const sq of squares) black |= 1n << BigInt(sq)
    const board = { black, white: 0n }

    for (const op of ALL_SYMMETRY_OPS) {
      const transformed = transformBoard(board, op)
      const expectedSquares = squares.map((sq) => transformSquare(op, sq)).sort((a, b) => a - b)
      const actualSquares: number[] = []
      for (let sq = 0; sq < 64; sq++) {
        if ((transformed.black & (1n << BigInt(sq))) !== 0n) actualSquares.push(sq)
      }
      expect(actualSquares).toEqual(expectedSquares)
    }
  })

  it('preserves black/white set membership under the 4 "color-preserving" ops on the initial board', () => {
    // normalize.ts が使う4つの変換(identity/rot180/flipDiag/flipAntiDiag)は、
    // 初期局面の黒石集合・白石集合をそれぞれ自分自身に写す(色を保存する)。
    const d4 = notationToSquare('d4')
    const e5 = notationToSquare('e5')
    const e4 = notationToSquare('e4')
    const d5 = notationToSquare('d5')
    const board = { white: (1n << BigInt(d4)) | (1n << BigInt(e5)), black: (1n << BigInt(e4)) | (1n << BigInt(d5)) }

    for (const op of ['identity', 'rot180', 'flipDiag', 'flipAntiDiag'] as const) {
      const transformed = transformBoard(board, op)
      // 白石2枚・黒石2枚という枚数自体は必ず保存される。
      expect(transformed.white | transformed.black).toBe(
        (1n << BigInt(notationToSquare('d4'))) |
          (1n << BigInt(notationToSquare('e5'))) |
          (1n << BigInt(notationToSquare('e4'))) |
          (1n << BigInt(notationToSquare('d5'))),
      )
      // 色が入れ替わっていないこと(黒石はすべて元の黒石マスの中に収まる)。
      const originalBlackSquares = new Set([squareToNotation(e4), squareToNotation(d5)])
      for (let sq = 0; sq < 64; sq++) {
        if ((transformed.black & (1n << BigInt(sq))) !== 0n) {
          expect(originalBlackSquares.has(squareToNotation(sq))).toBe(true)
        }
      }
    }
  })
})

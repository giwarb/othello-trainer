import { describe, expect, it } from 'vitest'
import { cellAt, initialBoard } from '../game/othello.ts'
import { EMPTY_BOARD, setSquare } from './boardEditorLogic.ts'

describe('setSquare', () => {
  it('places a black disc on an empty square', () => {
    const next = setSquare(EMPTY_BOARD, 0, 'black')
    expect(cellAt(next, 0)).toBe('black')
  })

  it('places a white disc on an empty square', () => {
    const next = setSquare(EMPTY_BOARD, 63, 'white')
    expect(cellAt(next, 63)).toBe('white')
  })

  it('removes a disc when placement is "empty"', () => {
    const withBlack = setSquare(EMPTY_BOARD, 27, 'black')
    expect(cellAt(withBlack, 27)).toBe('black')

    const cleared = setSquare(withBlack, 27, 'empty')
    expect(cellAt(cleared, 27)).toBeNull()
  })

  it('replaces the opposite color rather than stacking both colors on the same square', () => {
    const withWhite = setSquare(EMPTY_BOARD, 10, 'white')
    const overwritten = setSquare(withWhite, 10, 'black')

    expect(cellAt(overwritten, 10)).toBe('black')
    // 黒白どちらのビットも同時には立っていないことを内部表現からも確認する。
    expect(overwritten.black & (1n << 10n)).toBe(1n << 10n)
    expect(overwritten.white & (1n << 10n)).toBe(0n)
  })

  it('does not mutate the board passed in (pure function)', () => {
    const original = initialBoard()
    const originalBlack = original.black
    const originalWhite = original.white

    setSquare(original, 0, 'black')

    expect(original.black).toBe(originalBlack)
    expect(original.white).toBe(originalWhite)
  })

  it('leaves other squares untouched', () => {
    const board = initialBoard()
    const next = setSquare(board, 0, 'black')

    // d4/e4/d5/e5(27,28,35,36)は初期配置のまま変化しない。
    expect(cellAt(next, 27)).toBe(cellAt(board, 27))
    expect(cellAt(next, 28)).toBe(cellAt(board, 28))
    expect(cellAt(next, 35)).toBe(cellAt(board, 35))
    expect(cellAt(next, 36)).toBe(cellAt(board, 36))
  })
})

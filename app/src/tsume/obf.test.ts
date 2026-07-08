import { describe, expect, it } from 'vitest'
import { obfToBigints, obfToSerializedBoard } from './obf.ts'

describe('tsume/obf: obfToBigints', () => {
  it('全て空のOBF文字列は black=0n, white=0n になる', () => {
    const obf = '-'.repeat(64)
    expect(obfToBigints(obf)).toEqual({ black: 0n, white: 0n })
  })

  it('先頭(a1)がXなら black のビット0が立つ', () => {
    const obf = 'X' + '-'.repeat(63)
    expect(obfToBigints(obf)).toEqual({ black: 1n, white: 0n })
  })

  it('末尾(h8)がOなら white のビット63が立つ', () => {
    const obf = '-'.repeat(63) + 'O'
    expect(obfToBigints(obf)).toEqual({ black: 0n, white: 1n << 63n })
  })

  it('初期局面相当(d4=27:O, e4=28:X, d5=35:X, e5=36:O)を正しく変換する', () => {
    const chars = new Array(64).fill('-')
    chars[27] = 'O'
    chars[28] = 'X'
    chars[35] = 'X'
    chars[36] = 'O'
    const obf = chars.join('')
    const { black, white } = obfToBigints(obf)
    expect(black).toBe((1n << 28n) | (1n << 35n))
    expect(white).toBe((1n << 27n) | (1n << 36n))
  })

  it('長さが64でなければRangeErrorを投げる', () => {
    expect(() => obfToBigints('XO-')).toThrow(RangeError)
  })
})

describe('tsume/obf: obfToSerializedBoard', () => {
  it('16進文字列(0x始まり16桁)のペアに変換する', () => {
    const obf = 'X' + '-'.repeat(63)
    const board = obfToSerializedBoard(obf)
    expect(board.black).toBe('0x0000000000000001')
    expect(board.white).toBe('0x0000000000000000')
  })
})

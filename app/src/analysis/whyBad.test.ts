import { describe, expect, it } from 'vitest'
import { applyMove, createBoard, initialBoard, legalMoves, notationToSquare } from '../game/othello.ts'
import { analyzeWhyBad, countStableDiscs } from './whyBad.ts'

describe('analysis/whyBad: countStableDiscs', () => {
  it('隅1つだけなら確定石は1個(隅は常に確定石として種付けされる)', () => {
    const board = createBoard([notationToSquare('a1')], [])
    expect(countStableDiscs(board, 'black')).toBe(1)
  })

  it('隅が相手の色なら確定石は0個', () => {
    const board = createBoard([], [notationToSquare('a1')])
    expect(countStableDiscs(board, 'black')).toBe(0)
  })

  it('盤面が完全に埋まっていれば、その色の全ての石が確定石になる(全ラインが常に「埋まっている」ため)', () => {
    const blackSquares: number[] = []
    const whiteSquares: number[] = []
    for (let sq = 0; sq < 64; sq++) {
      if (sq % 2 === 0) blackSquares.push(sq)
      else whiteSquares.push(sq)
    }
    const board = createBoard(blackSquares, whiteSquares)
    expect(countStableDiscs(board, 'black')).toBe(blackSquares.length)
    expect(countStableDiscs(board, 'white')).toBe(whiteSquares.length)
  })

  it('石が1つも無ければ確定石は0個', () => {
    const board = createBoard([], [])
    expect(countStableDiscs(board, 'black')).toBe(0)
  })
})

describe('analysis/whyBad: analyzeWhyBad', () => {
  it('着手可能数(mobility)を初期局面からのf5で正しく計算する(既知の事実: 初期局面は黒白とも4手ずつ打てる対称局面)', () => {
    const before = initialBoard()
    const square = notationToSquare('f5')
    const after = applyMove(before, 'black', square)

    const result = analyzeWhyBad(before, 'black', square)

    expect(result.mobility.moverMobilityBefore).toBe(4)
    expect(result.mobility.opponentMobilityBefore).toBe(4)
    expect(result.mobility.moverMobilityBefore).toBe(legalMoves(before, 'black').length)
    expect(result.mobility.opponentMobilityBefore).toBe(legalMoves(before, 'white').length)
    expect(result.mobility.opponentMobilityAfter).toBe(legalMoves(after, 'white').length)
    expect(result.mobility.moverMobilityAfter).toBe(legalMoves(after, 'black').length)
  })

  it('確定石数の変化(delta)がcountStableDiscsの直接呼び出しと一致する(wiringの検証)', () => {
    const before = initialBoard()
    const square = notationToSquare('f5')
    const after = applyMove(before, 'black', square)

    const result = analyzeWhyBad(before, 'black', square)

    expect(result.stability.moverStableBefore).toBe(countStableDiscs(before, 'black'))
    expect(result.stability.moverStableAfter).toBe(countStableDiscs(after, 'black'))
    expect(result.stability.delta).toBe(result.stability.moverStableAfter - result.stability.moverStableBefore)
  })

  it('X打ち(対応する隅がまだ空いているX打ちマス)を検出する', () => {
    // a1(隅)を空けたまま、黒がb2(X打ちマス)に着手する人工的な局面ペア。
    const before = createBoard(
      [notationToSquare('c3')],
      [notationToSquare('b3'), notationToSquare('a3')],
    )
    const square = notationToSquare('b2')
    const result = analyzeWhyBad(before, 'black', square)
    expect(result.cornerRisk).toEqual({ kind: 'x', corner: 'a1' })
  })

  it('C打ち(対応する隅がまだ空いているC打ちマス)を検出する', () => {
    const before = createBoard([notationToSquare('c3')], [])
    const square = notationToSquare('b1')
    const result = analyzeWhyBad(before, 'black', square)
    expect(result.cornerRisk).toEqual({ kind: 'c', corner: 'a1' })
  })

  it('対応する隅が既に埋まっていればX打ち/C打ちとして検出しない', () => {
    const before = createBoard([notationToSquare('a1'), notationToSquare('c3')], [])
    const square = notationToSquare('b2')
    const result = analyzeWhyBad(before, 'black', square)
    expect(result.cornerRisk).toBeNull()
  })

  it('X打ち/C打ちに該当しない通常の手ではcornerRiskはnull', () => {
    const before = initialBoard()
    const square = notationToSquare('f5')
    const result = analyzeWhyBad(before, 'black', square)
    expect(result.cornerRisk).toBeNull()
  })

  it('reasonsに人が読める理由テキストが含まれる', () => {
    const before = initialBoard()
    const square = notationToSquare('f5')
    const result = analyzeWhyBad(before, 'black', square)
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.reasons.some((r) => r.includes('着手可能数'))).toBe(true)
    expect(result.reasons.some((r) => r.includes('確定石数'))).toBe(true)
  })
})

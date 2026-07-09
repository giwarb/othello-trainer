import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { createBoard, initialBoard, type Board, type Side } from '../game/othello.ts'
import { getAllPoolEntries } from '../midgame/pool.ts'
import {
  buildInstantTsumePuzzle,
  MAX_INSTANT_TSUME_EMPTIES,
  sendToMidgamePractice,
  type TsumeCheckEngine,
} from './sendToPractice.ts'

function freshFactory(): IDBFactory {
  return new IDBFactory()
}

/**
 * 空き20マスちょうど(`MAX_INSTANT_TSUME_EMPTIES`以下)で、かつ黒に実在の合法手が
 * 1つある(d3、初期局面由来の既知の捕獲パターン)人工的な盤面を作る。
 * 初期局面の中央4マス(d4/e4/d5/e5)とd3/c4/f5/e6を変更せず維持し、それ以外の
 * 56マスのうち40マスを黒白交互に埋めることで空き20マスに調整する
 * (捕獲判定はd3から見て隣接するd4・d5だけで完結するため、遠くのマスを
 * 埋めても影響しない)。
 */
function buildNearEndgameBoardWithLegalMove(): Board {
  const base = initialBoard()
  const reservedEmpty = new Set([19, 26, 37, 44]) // d3, c4, f5, e6
  const alreadyFilled = new Set([27, 28, 35, 36]) // d4, e4, d5, e5
  const extraBlack: number[] = []
  const extraWhite: number[] = []
  let toFill = 40
  for (let sq = 0; sq < 64 && toFill > 0; sq++) {
    if (reservedEmpty.has(sq) || alreadyFilled.has(sq)) continue
    if (extraBlack.length <= extraWhite.length) extraBlack.push(sq)
    else extraWhite.push(sq)
    toFill--
  }
  let black = base.black
  let white = base.white
  for (const sq of extraBlack) black |= 1n << BigInt(sq)
  for (const sq of extraWhite) white |= 1n << BigInt(sq)
  return { black, white }
}

function fakeEngine(moves: MoveEvalJson[]): TsumeCheckEngine & { calls: number } {
  return {
    calls: 0,
    async requestAnalyzeAll(_board: Board, _turn: Side, _limit: AnalyzeLimit): Promise<MoveEvalJson[]> {
      this.calls++
      return moves
    },
  }
}

describe('analysis/sendToPractice: sendToMidgamePractice', () => {
  it('出題プール(IndexedDB)にsource: blunder-reviewで登録される', async () => {
    const factory = freshFactory()
    const board = initialBoard()
    await sendToMidgamePractice(board, 'black', factory)

    const all = await getAllPoolEntries(factory)
    expect(all).toHaveLength(1)
    expect(all[0]?.source).toBe('blunder-review')
    expect(all[0]?.turn).toBe('black')
  })
})

describe('analysis/sendToPractice: buildInstantTsumePuzzle', () => {
  it('空きマス数が上限を超える場合はエンジンを呼ばずに却下する(完全読みハング対策)', async () => {
    const engine = fakeEngine([])
    const result = await buildInstantTsumePuzzle(engine, initialBoard(), 'black')
    expect(result.accepted).toBe(false)
    if (result.accepted) throw new Error('unreachable')
    expect(result.reason).toContain(String(MAX_INSTANT_TSUME_EMPTIES))
    expect(engine.calls).toBe(0)
  })

  it('手番側に合法手が無い場合は却下する', async () => {
    const blackSquares: number[] = []
    for (let sq = 0; sq < 64; sq++) {
      if (sq !== 0 && sq !== 1) blackSquares.push(sq)
    }
    // 白石が存在しないため黒は挟める相手石が無く、合法手が無い。
    const board = createBoard(blackSquares, [])
    const engine = fakeEngine([])
    const result = await buildInstantTsumePuzzle(engine, board, 'black')
    expect(result.accepted).toBe(false)
    expect(engine.calls).toBe(0)
  })

  it('唯一解性・明確さを満たせばPuzzle相当のデータを構築する', async () => {
    const board = buildNearEndgameBoardWithLegalMove()
    const engine = fakeEngine([
      { move: 'd3', score: 500, discDiff: 5, type: 'exact' },
      { move: 'c4', score: -100, discDiff: -1, type: 'exact' },
      { move: 'f5', score: -300, discDiff: -3, type: 'exact' },
    ])

    const result = await buildInstantTsumePuzzle(engine, board, 'black')
    expect(result.accepted).toBe(true)
    if (!result.accepted) throw new Error('unreachable')
    expect(result.puzzle.correctMoves).toEqual(['d3'])
    expect(result.puzzle.bestDiscDiff).toBe(5)
    expect(result.puzzle.outcome).toBe('win')
    expect(result.puzzle.clarityMargin).toBe(6)
    expect(result.puzzle.sideToMove).toBe('black')
    expect(result.puzzle.moves).toHaveLength(3)
    expect(result.puzzle.moves.find((m) => m.square === 'd3')?.isBest).toBe(true)
    expect(result.puzzle.moves.find((m) => m.square === 'c4')?.isBest).toBe(false)
  })

  it('唯一解性・明確さを満たさなければ却下する', async () => {
    const board = buildNearEndgameBoardWithLegalMove()
    const engine = fakeEngine([
      { move: 'd3', score: 500, discDiff: 5, type: 'exact' },
      { move: 'c4', score: 500, discDiff: 5, type: 'exact' },
      { move: 'f5', score: 500, discDiff: 5, type: 'exact' },
    ])

    const result = await buildInstantTsumePuzzle(engine, board, 'black')
    expect(result.accepted).toBe(false)
    if (result.accepted) throw new Error('unreachable')
    expect(result.reason).toContain('詰めオセロ')
  })
})

import { describe, expect, it } from 'vitest'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { applyMove, initialBoard, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { generateSelfPlayPosition, pickJosekiEndPosition, type SelfPlayEngine } from './generateStart.ts'

/** テスト用ヘルパー: "a1"記法の着手列を初期局面から順に適用した最終盤面/手番を返す。 */
function playSequence(notations: readonly string[]): { board: Board; sideToMove: Side } {
  let board = initialBoard()
  let side: Side = 'black'
  for (const notation of notations) {
    board = applyMove(board, side, notationToSquare(notation))
    side = opposite(side)
  }
  return { board, sideToMove: side }
}

const RAW_LINES: readonly RawJosekiLine[] = [
  { name: '虎', moves: ['f5', 'd6', 'c3', 'd3', 'c4'], firstMoveBasis: 'f5', depth: 5 },
  { name: '縦取り', moves: ['f5', 'd6'], firstMoveBasis: 'f5', depth: 2 },
  { name: '兎', moves: ['f5', 'd6', 'c4'], firstMoveBasis: 'f5', depth: 3 },
]

describe('pickJosekiEndPosition', () => {
  const db = buildJosekiDb(RAW_LINES)

  it('josekiDbにラインが無ければ例外を投げる', () => {
    const emptyDb = buildJosekiDb([])
    expect(() => pickJosekiEndPosition(emptyDb)).toThrow(RangeError)
  })

  it('random()の返り値に応じて対応するラインの終端局面を返す(先頭のライン)', () => {
    // random() が常に0を返す => 最初のライン(虎)が選ばれる。
    const result = pickJosekiEndPosition(db, () => 0)
    const expected = playSequence(RAW_LINES[0]!.moves)
    expect(result.board).toEqual(expected.board)
    expect(result.sideToMove).toBe(expected.sideToMove)
  })

  it('random()の返り値に応じて対応するラインの終端局面を返す(末尾のライン)', () => {
    // random() が1未満ギリギリの値を返す => 最後のライン(兎)が選ばれる。
    const result = pickJosekiEndPosition(db, () => 0.999999)
    const expected = playSequence(RAW_LINES[2]!.moves)
    expect(result.board).toEqual(expected.board)
    expect(result.sideToMove).toBe(expected.sideToMove)
  })

  it('選んだラインのmoveSeqを初期局面から再生した局面と一致する(2番目のライン、短いライン)', () => {
    // 3ライン中2番目(縦取り)を選ぶ: random() in [1/3, 2/3)
    const result = pickJosekiEndPosition(db, () => 0.5)
    const expected = playSequence(RAW_LINES[1]!.moves)
    expect(result.board).toEqual(expected.board)
    expect(result.sideToMove).toBe(expected.sideToMove)
  })
})

describe('generateSelfPlayPosition', () => {
  function fakeEngine(discDiffForBest: (board: Board, side: Side) => number): SelfPlayEngine {
    return {
      requestAnalyzeAll: async (board: Board, side: Side, _limit: AnalyzeLimit): Promise<MoveEvalJson[]> => {
        const discDiff = discDiffForBest(board, side)
        return [{ move: 'd3', score: discDiff * 100, discDiff, type: 'midgame' }]
      },
    }
  }

  it('1回目の試行で互角±3石差以内なら、その局面をそのまま返す', async () => {
    const engine = fakeEngine(() => 1) // 常に石差+1(±3以内)
    const random = () => 0.4 // 手数選択・各手選択に使う適当な値
    const result = await generateSelfPlayPosition(engine, { minPly: 15, maxPly: 15, random })
    expect(result.board).toBeDefined()
    expect(['black', 'white']).toContain(result.sideToMove)
  })

  it('互角±3石差を超える局面が続く場合、maxAttempts回試行した上で最後の局面をフォールバックとして返す', async () => {
    let calls = 0
    const engine = fakeEngine(() => {
      calls++
      return 10 // 常に石差+10(±3を超える)
    })
    const random = () => 0.4
    const result = await generateSelfPlayPosition(engine, { minPly: 5, maxPly: 5, maxAttempts: 3, random })
    expect(calls).toBe(3)
    expect(result.board).toBeDefined()
  })

  it('allMovesが空(合法手なし)の試行はスキップして次の試行に進む', async () => {
    let calls = 0
    const engine: SelfPlayEngine = {
      requestAnalyzeAll: async () => {
        calls++
        if (calls === 1) return []
        return [{ move: 'd3', score: 0, discDiff: 0, type: 'midgame' }]
      },
    }
    const result = await generateSelfPlayPosition(engine, { minPly: 5, maxPly: 5, random: () => 0.4 })
    expect(calls).toBe(2)
    expect(result.board).toBeDefined()
  })

  it('minPly=maxPly=0の場合、初期局面のまま評価される', async () => {
    const engine = fakeEngine(() => 0)
    const result = await generateSelfPlayPosition(engine, { minPly: 0, maxPly: 0, random: () => 0.5 })
    expect(result.board).toEqual(initialBoard())
    expect(result.sideToMove).toBe('black')
  })
})

import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { applyMove, initialBoard, notationToSquare, type Board, type Side } from '../game/othello.ts'
import { hashBoard } from '../joseki/normalize.ts'
import { analyzeGame, type AnalyzeEngine, replayGame, TranscriptReplayError } from './analyzeGame.ts'

const BOARD0 = initialBoard()
const BOARD1 = applyMove(BOARD0, 'black', notationToSquare('f5'))

const MOVES_BOARD0: MoveEvalJson[] = [
  { move: 'd3', score: 300, discDiff: 3.0, type: 'midgame' },
  { move: 'c4', score: 100, discDiff: 1.0, type: 'midgame' },
  { move: 'f5', score: -50, discDiff: -0.5, type: 'midgame' },
  { move: 'e6', score: 0, discDiff: 0.0, type: 'midgame' },
]

const MOVES_BOARD1: MoveEvalJson[] = [
  { move: 'f4', score: 200, discDiff: 2.0, type: 'midgame' },
  { move: 'f6', score: 50, discDiff: 0.5, type: 'midgame' },
]

/** 決定的なフェイクエンジン: 局面ハッシュに応じて固定の評価結果を返す。呼び出し回数も記録する。 */
function makeFakeEngine(): AnalyzeEngine & { calls: number } {
  const byHash = new Map<string, MoveEvalJson[]>([
    [hashBoard(BOARD0, 'black'), MOVES_BOARD0],
    [hashBoard(BOARD1, 'white'), MOVES_BOARD1],
  ])
  return {
    calls: 0,
    async requestAnalyzeAll(board: Board, turn: Side, _limit: AnalyzeLimit): Promise<MoveEvalJson[]> {
      this.calls++
      const key = hashBoard(board, turn)
      const found = byHash.get(key)
      if (!found) throw new Error(`unexpected position queried: ${key}`)
      return found
    },
  }
}

describe('analysis/analyzeGame: replayGame', () => {
  it('着手列の数+1個の局面を返す', () => {
    const positions = replayGame(['f5', 'f4'])
    expect(positions).toHaveLength(3)
    expect(positions[0]!.board).toEqual(initialBoard())
    expect(positions[0]!.mover).toBe('black')
  })

  it('非合法手が含まれる場合はTranscriptReplayErrorを投げる', () => {
    // 初期局面から'a1'は合法手ではない。
    expect(() => replayGame(['a1'])).toThrow(TranscriptReplayError)
  })
})

describe('analysis/analyzeGame: analyzeGame', () => {
  it('1手だけの棋譜を解析し、ロス・分類・逆転を正しく計算する', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()
    const progressCalls: { done: number; total: number; justAnalyzedPly: number }[] = []

    const results = await analyzeGame(engine, ['f5'], {
      dbFactory,
      onProgress: (p) => progressCalls.push(p),
    })

    expect(results).toHaveLength(1)
    const m = results[0]!
    expect(m.ply).toBe(0)
    expect(m.move).toBe('f5')
    expect(m.side).toBe('black')
    expect(m.bestMove).toBe('d3')
    expect(m.bestDiscDiff).toBe(3.0)
    expect(m.playedDiscDiff).toBe(-0.5)
    expect(m.lossDiscs).toBeCloseTo(3.5)
    expect(m.classification).toBe('dubious')
    expect(m.isExact).toBe(false)
    expect(m.blackAdvantageBefore).toBeCloseTo(3.0)
    // 白の最善応手(discDiff 2.0、白視点)を黒視点に変換すると-2.0。
    expect(m.blackAdvantageAfter).toBeCloseTo(-2.0)
    // 黒視点の符号が+から-に反転しているため逆転悪手。
    expect(m.reversal).toBe(true)

    expect(progressCalls).toEqual([{ done: 1, total: 1, justAnalyzedPly: 0 }])
  })

  it('同一局面の解析結果はIndexedDBキャッシュにより2回目はエンジンを呼ばない(要件5)', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()

    await analyzeGame(engine, ['f5'], { dbFactory })
    const callsAfterFirst = engine.calls
    expect(callsAfterFirst).toBeGreaterThan(0)

    await analyzeGame(engine, ['f5'], { dbFactory })
    expect(engine.calls).toBe(callsAfterFirst)
  })

  it('カスタム閾値を反映する', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()

    const results = await analyzeGame(engine, ['f5'], {
      dbFactory,
      thresholds: { inaccuracy: 10, dubious: 20, blunder: 30 },
    })
    expect(results[0]!.classification).toBe('best')
  })

  it('空の着手列に対しては空配列を返す', async () => {
    const engine = makeFakeEngine()
    const results = await analyzeGame(engine, [])
    expect(results).toEqual([])
    expect(engine.calls).toBe(0)
  })
})

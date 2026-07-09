import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { applyMove, initialBoard, notationToSquare, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { analyzeGame, type AnalyzeEngine, replayGame, TranscriptReplayError } from './analyzeGame.ts'

const BOARD0 = initialBoard()
const BOARD1 = applyMove(BOARD0, 'black', notationToSquare('f5'))
// f5に対する白の合法手はd6/f4/f6の3つ(e6は合法手ではない)。d6は定石内、f6は
// 定石DBに未収録(定石外)の手として使う(T038の要件2テスト用)。
const BOARD1_AFTER_D6 = applyMove(BOARD1, 'white', notationToSquare('d6'))
const BOARD1_AFTER_F6 = applyMove(BOARD1, 'white', notationToSquare('f6'))

const MOVES_BOARD0: MoveEvalJson[] = [
  { move: 'd3', score: 300, discDiff: 3.0, type: 'midgame' },
  { move: 'c4', score: 100, discDiff: 1.0, type: 'midgame' },
  { move: 'f5', score: -50, discDiff: -0.5, type: 'midgame' },
  { move: 'e6', score: 0, discDiff: 0.0, type: 'midgame' },
]

const MOVES_BOARD1: MoveEvalJson[] = [
  { move: 'f4', score: 200, discDiff: 2.0, type: 'midgame' },
  { move: 'd6', score: 100, discDiff: 1.0, type: 'midgame' },
  { move: 'f6', score: -400, discDiff: -4.0, type: 'midgame' },
]

/** T038: `BOARD1`から`d6`を打った後(定石内)の最終局面の解析(最終局面のnextBlackAdvantage算出用)。 */
const MOVES_BOARD1_AFTER_D6: MoveEvalJson[] = [{ move: 'c3', score: 0, discDiff: 0.0, type: 'midgame' }]
/** T038: `BOARD1`から`f6`を打った後(定石外)の最終局面の解析(最終局面のnextBlackAdvantage算出用)。 */
const MOVES_BOARD1_AFTER_F6: MoveEvalJson[] = [{ move: 'c3', score: 0, discDiff: 0.0, type: 'midgame' }]

/** 決定的なフェイクエンジン: 局面ハッシュに応じて固定の評価結果を返す。呼び出し回数も記録する。 */
function makeFakeEngine(): AnalyzeEngine & { calls: number } {
  const byHash = new Map<string, MoveEvalJson[]>([
    [hashBoard(BOARD0, 'black'), MOVES_BOARD0],
    [hashBoard(BOARD1, 'white'), MOVES_BOARD1],
    [hashBoard(BOARD1_AFTER_D6, 'black'), MOVES_BOARD1_AFTER_D6],
    [hashBoard(BOARD1_AFTER_F6, 'black'), MOVES_BOARD1_AFTER_F6],
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

/** T038: `f5`(1手目)、`d6`(2手目)のみを収録した最小の定石DB(単一ライン)。 */
function makeTestJosekiDb() {
  const rawLine: RawJosekiLine = {
    name: 'テスト定石',
    moves: ['f5', 'd6'],
    firstMoveBasis: 'f5',
    depth: 2,
  }
  return buildJosekiDb([rawLine])
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

describe('analysis/analyzeGame: 定石DB連携(T038)', () => {
  it('定石内の手はevalSource:josekiとなり、悪手・逆転判定から除外される(要件1)', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()
    const josekiDb = makeTestJosekiDb()

    // f5(定石内)→d6(定石内)。定石DBなしなら3.5石ロスで「疑問手」・逆転判定される
    // 局面(既存の「1手だけの棋譜を解析」テストと同じMOVES_BOARD0データ)だが、
    // 定石DBを渡すと`evalSource:'joseki'`・`classification:'best'`・`reversal:false`に
    // 上書きされる。
    const results = await analyzeGame(engine, ['f5', 'd6'], { dbFactory, josekiDb })

    expect(results).toHaveLength(2)
    const m0 = results[0]!
    expect(m0.move).toBe('f5')
    expect(m0.evalSource).toBe('joseki')
    expect(m0.classification).toBe('best')
    expect(m0.reversal).toBe(false)
    expect(m0.lossDiscs).toBe(0)
    expect(m0.josekiNames).toEqual(['テスト定石'])
    // スコア自体(bestDiscDiff/playedDiscDiff)は上書きされない(要件4)。
    expect(m0.bestDiscDiff).toBe(3.0)
    expect(m0.playedDiscDiff).toBe(-0.5)

    const m1 = results[1]!
    expect(m1.move).toBe('d6')
    expect(m1.evalSource).toBe('joseki')
    expect(m1.classification).toBe('best')
    expect(m1.reversal).toBe(false)
    expect(m1.lossDiscs).toBe(0)
  })

  it('定石を外れた手以降は通常の評価・悪手判定に戻る(要件2)', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()
    const josekiDb = makeTestJosekiDb()

    // f5(定石内)→f6(定石DBのbookMovesはd6のみのため定石外)。
    const results = await analyzeGame(engine, ['f5', 'f6'], { dbFactory, josekiDb })

    expect(results).toHaveLength(2)
    const m0 = results[0]!
    expect(m0.move).toBe('f5')
    expect(m0.evalSource).toBe('joseki')
    expect(m0.classification).toBe('best')
    expect(m0.reversal).toBe(false)

    const m1 = results[1]!
    expect(m1.move).toBe('f6')
    expect(m1.evalSource).toBe('midgame')
    expect(m1.josekiNames).toBeUndefined()
    expect(m1.bestMove).toBe('f4')
    expect(m1.lossDiscs).toBeCloseTo(6.0)
    expect(m1.classification).toBe('blunder')
  })

  it('定石DBがnull(ロード失敗時のフォールバック等)なら定石照会をスキップし、従来通り評価する(要件3)', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()

    const results = await analyzeGame(engine, ['f5'], { dbFactory, josekiDb: null })

    expect(results).toHaveLength(1)
    const m = results[0]!
    expect(m.evalSource).toBe('midgame')
    expect(m.classification).toBe('dubious')
    expect(m.reversal).toBe(true)
    expect(m.josekiNames).toBeUndefined()
  })
})

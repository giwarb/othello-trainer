import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  countDiscs,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board,
  type Side,
} from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import {
  analyzeGame,
  type AnalyzeEngine,
  DISC_DIFF_THEORETICAL_MAX,
  replayGame,
  TranscriptReplayError,
} from './analyzeGame.ts'

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
    // 累積評価値(T056): E[0]=0(互角)を起点に、黒番のロス3.5を差し引く。
    expect(m.blackAdvantageBefore).toBeCloseTo(0)
    expect(m.blackAdvantageAfter).toBeCloseTo(-3.5)
    // 0(互角扱い)から非0への最初の遷移は、符号が厳密に反転(+→-または-→+)した
    // わけではないため逆転悪手ではない(T057)。
    expect(m.reversal).toBe(false)

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

  it(
    '実際に打った手(played)がタイムアウト等でヒューリスティックフォールバックした場合' +
      '(type:"midgame")、最善手(best)が完全読み(type:"exact")でもevalSourceは' +
      '"midgame"になり、isExactもfalseになる(T059: 以前はbest.typeだけを見て' +
      '誤って"exact"(終盤確定)と表示していた不具合の回帰テスト)',
    async () => {
      const engine: AnalyzeEngine = {
        async requestAnalyzeAll(): Promise<MoveEvalJson[]> {
          return [
            { move: 'd3', score: 300, discDiff: 3.0, type: 'exact' },
            { move: 'f5', score: -50, discDiff: -0.5, type: 'midgame' },
          ]
        },
      }
      const dbFactory = new IDBFactory()

      const results = await analyzeGame(engine, ['f5'], { dbFactory })

      const m = results[0]!
      expect(m.bestMove).toBe('d3')
      expect(m.move).toBe('f5')
      expect(m.isExact).toBe(false)
      expect(m.evalSource).toBe('midgame')
    },
  )

  it(
    '逆に、実際に打った手(played)自身が完全読みでも、best側がタイムアウトで' +
      'フォールバックしていればevalSourceは"midgame"になる(T059、対照テスト)',
    async () => {
      const engine: AnalyzeEngine = {
        async requestAnalyzeAll(): Promise<MoveEvalJson[]> {
          return [
            { move: 'd3', score: 300, discDiff: 3.0, type: 'midgame' },
            { move: 'f5', score: -50, discDiff: -0.5, type: 'exact' },
          ]
        },
      }
      const dbFactory = new IDBFactory()

      const results = await analyzeGame(engine, ['f5'], { dbFactory })

      const m = results[0]!
      expect(m.isExact).toBe(false)
      expect(m.evalSource).toBe('midgame')
    },
  )

  it(
    'best・played両方が完全読み(type:"exact")の場合のみevalSourceが"exact"になる' +
      '(T059、対照テスト)',
    async () => {
      const engine: AnalyzeEngine = {
        async requestAnalyzeAll(): Promise<MoveEvalJson[]> {
          return [
            { move: 'd3', score: 300, discDiff: 3.0, type: 'exact' },
            { move: 'f5', score: -50, discDiff: -0.5, type: 'exact' },
          ]
        },
      }
      const dbFactory = new IDBFactory()

      const results = await analyzeGame(engine, ['f5'], { dbFactory })

      const m = results[0]!
      expect(m.isExact).toBe(true)
      expect(m.evalSource).toBe('exact')
    },
  )

  it(
    'lossDiscsは理論上限(64石)でクランプされる(T059、表示層の最終防御の回帰テスト)',
    async () => {
      // エンジン側のクランプ(engine/src/search.rs)で本来は起こり得ないが、
      // 表示層でも二重に防御していることを確認する(理論上限を超えるbest/played
      // の差分を意図的に与える)。
      const engine: AnalyzeEngine = {
        async requestAnalyzeAll(): Promise<MoveEvalJson[]> {
          return [
            { move: 'd3', score: 6400, discDiff: 64, type: 'midgame' },
            { move: 'f5', score: -6400, discDiff: -64, type: 'midgame' },
          ]
        },
      }
      const dbFactory = new IDBFactory()

      const results = await analyzeGame(engine, ['f5'], { dbFactory })

      const m = results[0]!
      // 生の差分は64 - (-64) = 128だが、理論上限64にクランプされる。
      expect(m.lossDiscs).toBe(64)
    },
  )
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
    // 0(互角扱い)から非0への最初の遷移は厳密な符号反転ではないため逆転ではない(T057)。
    expect(m.reversal).toBe(false)
    expect(m.josekiNames).toBeUndefined()
  })
})

describe('analysis/analyzeGame: 累積評価値(T056)', () => {
  it('最善手が連続する場合、評価値(累積)が変化しない', async () => {
    // f5(黒)・d6(白)とも「最善かつ実際に打った手」(ロス0)にする。
    const bestF5: MoveEvalJson[] = [
      { move: 'f5', score: 100, discDiff: 1.0, type: 'midgame' },
      { move: 'd3', score: 50, discDiff: 0.5, type: 'midgame' },
    ]
    const bestD6: MoveEvalJson[] = [
      { move: 'd6', score: 100, discDiff: 1.0, type: 'midgame' },
      { move: 'f4', score: 50, discDiff: 0.5, type: 'midgame' },
    ]
    const byHash = new Map<string, MoveEvalJson[]>([
      [hashBoard(BOARD0, 'black'), bestF5],
      [hashBoard(BOARD1, 'white'), bestD6],
    ])
    const engine: AnalyzeEngine = {
      async requestAnalyzeAll(board, turn) {
        const found = byHash.get(hashBoard(board, turn))
        if (!found) throw new Error('unexpected position queried')
        return found
      },
    }
    const dbFactory = new IDBFactory()

    const results = await analyzeGame(engine, ['f5', 'd6'], { dbFactory })

    expect(results[0]!.lossDiscs).toBeCloseTo(0)
    expect(results[0]!.blackAdvantageBefore).toBeCloseTo(0)
    expect(results[0]!.blackAdvantageAfter).toBeCloseTo(0)
    expect(results[0]!.reversal).toBe(false)

    expect(results[1]!.lossDiscs).toBeCloseTo(0)
    expect(results[1]!.blackAdvantageBefore).toBeCloseTo(0)
    expect(results[1]!.blackAdvantageAfter).toBeCloseTo(0)
    expect(results[1]!.reversal).toBe(false)
  })

  it('悪手を打った場合、評価値がちょうどロス分だけ悪化する(黒番・白番双方で符号が正しい)', async () => {
    const engine = makeFakeEngine()
    const dbFactory = new IDBFactory()

    // f5(黒、MOVES_BOARD0の最善はd3のdiscDiff3.0、実際はf5のdiscDiff-0.5でロス3.5)
    // → d6(白、MOVES_BOARD1の最善はf4のdiscDiff2.0、実際はd6のdiscDiff1.0でロス1.0)。
    const results = await analyzeGame(engine, ['f5', 'd6'], { dbFactory })

    // 黒番のロス3.5: E[0]=0 → E[1] = 0 - 3.5 = -3.5(黒が損した分だけ黒視点で悪化)。
    expect(results[0]!.side).toBe('black')
    expect(results[0]!.lossDiscs).toBeCloseTo(3.5)
    expect(results[0]!.blackAdvantageBefore).toBeCloseTo(0)
    expect(results[0]!.blackAdvantageAfter).toBeCloseTo(-3.5)

    // 白番のロス1.0: E[1] = -3.5 → E[2] = -3.5 + 1.0 = -2.5(白が損した分だけ黒視点で改善)。
    expect(results[1]!.side).toBe('white')
    expect(results[1]!.lossDiscs).toBeCloseTo(1.0)
    expect(results[1]!.blackAdvantageBefore).toBeCloseTo(-3.5)
    expect(results[1]!.blackAdvantageAfter).toBeCloseTo(-2.5)
  })

  it('逆転判定は累積評価値の符号が厳密に反転した場合にのみ発生する(T057)', async () => {
    // 決定的な方策(dictionary順の先頭)で4手分の実際に合法な着手列を作り、
    // 各局面の評価値(discDiff)だけをテスト用に上書きする
    // (telescoping性質のテストと同じ手法)。
    const moves: string[] = []
    let board = initialBoard()
    let side: Side = 'black'
    for (let step = 0; step < 4; step++) {
      const chosen = legalMoves(board, side).map(squareToNotation).sort()[0]!
      moves.push(chosen)
      board = applyMove(board, side, notationToSquare(chosen))
      side = opposite(side)
    }
    const positions = replayGame(moves)

    // ply0(黒): ロス0 → E: 0→0。
    // ply1(白): ロス5 → E: 0→+5(0からの遷移のため逆転ではない)。
    // ply2(黒): ロス8 → E: +5→-3(符号が厳密に反転するため逆転)。
    // ply3(白): ロス2 → E: -3→-1(符号は負のまま変わらないため逆転ではない)。
    const entriesByPly: MoveEvalJson[][] = [
      [{ move: moves[0]!, score: 0, discDiff: 0, type: 'midgame' }],
      [
        { move: moves[1]!, score: 0, discDiff: 0, type: 'midgame' },
        { move: '__alt1__', score: 0, discDiff: 5, type: 'midgame' },
      ],
      [
        { move: moves[2]!, score: 0, discDiff: -8, type: 'midgame' },
        { move: '__alt2__', score: 0, discDiff: 0, type: 'midgame' },
      ],
      [
        { move: moves[3]!, score: 0, discDiff: 0, type: 'midgame' },
        { move: '__alt3__', score: 0, discDiff: 2, type: 'midgame' },
      ],
    ]
    const byHash = new Map<string, MoveEvalJson[]>()
    for (let i = 0; i < moves.length; i++) {
      byHash.set(hashBoard(positions[i]!.board, positions[i]!.mover!), entriesByPly[i]!)
    }
    const engine: AnalyzeEngine = {
      async requestAnalyzeAll(b, turn) {
        const found = byHash.get(hashBoard(b, turn))
        if (!found) throw new Error('unexpected position queried')
        return found
      },
    }
    const dbFactory = new IDBFactory()

    const results = await analyzeGame(engine, moves, { dbFactory })

    expect(results[0]!.blackAdvantageBefore).toBeCloseTo(0)
    expect(results[0]!.blackAdvantageAfter).toBeCloseTo(0)
    expect(results[0]!.reversal).toBe(false)

    expect(results[1]!.blackAdvantageBefore).toBeCloseTo(0)
    expect(results[1]!.blackAdvantageAfter).toBeCloseTo(5)
    expect(results[1]!.reversal).toBe(false)

    expect(results[2]!.blackAdvantageBefore).toBeCloseTo(5)
    expect(results[2]!.blackAdvantageAfter).toBeCloseTo(-3)
    expect(results[2]!.reversal).toBe(true)

    expect(results[3]!.blackAdvantageBefore).toBeCloseTo(-3)
    expect(results[3]!.blackAdvantageAfter).toBeCloseTo(-1)
    expect(results[3]!.reversal).toBe(false)
  })

  it('終盤まで含めた累積評価値の最終値が実際の最終石差と一致する(telescoping性質)', async () => {
    // 決定的な方策(各局面の合法手を記法の辞書順に並べ、先頭の手を選ぶ)で、
    // 実際のオセロ規則(`legalMoves`/`applyMove`)に従い4手進めた棋譜を作る。
    const moves: string[] = []
    let board = initialBoard()
    let side: Side = 'black'
    for (let step = 0; step < 4; step++) {
      const chosen = legalMoves(board, side).map(squareToNotation).sort()[0]!
      moves.push(chosen)
      board = applyMove(board, side, notationToSquare(chosen))
      side = opposite(side)
    }
    const realFinalDiff = countDiscs(board, 'black') - countDiscs(board, 'white')

    // 4手全てを「最善かつ実際の手」(ロス0)にすると累積評価値は0のまま変化
    // しないため、`realFinalDiff`と一致させるには1手だけ意図的にロスを持たせる
    // 必要がある。黒番のロスはE(黒視点)を減らし、白番のロスはEを増やすため、
    // `realFinalDiff`の符号に応じてロスを持たせる手番(ply0=黒 or ply1=白)を選ぶ。
    const blunderPly = realFinalDiff <= 0 ? 0 : 1
    const lossMagnitude = Math.abs(realFinalDiff)

    const positions = replayGame(moves)
    const byHash = new Map<string, MoveEvalJson[]>()
    for (let i = 0; i < moves.length; i++) {
      const pos = positions[i]!
      const played = moves[i]!
      const entries: MoveEvalJson[] =
        i === blunderPly
          ? [
              { move: played, score: 0, discDiff: 0, type: 'midgame' },
              { move: '__best__', score: 0, discDiff: lossMagnitude, type: 'midgame' },
            ]
          : [{ move: played, score: 0, discDiff: 0, type: 'midgame' }]
      byHash.set(hashBoard(pos.board, pos.mover!), entries)
    }
    const engine: AnalyzeEngine = {
      async requestAnalyzeAll(b, turn) {
        const found = byHash.get(hashBoard(b, turn))
        if (!found) throw new Error('unexpected position queried')
        return found
      },
    }
    const dbFactory = new IDBFactory()

    const results = await analyzeGame(engine, moves, { dbFactory })
    const last = results[results.length - 1]!

    expect(last.blackAdvantageAfter).toBeCloseTo(realFinalDiff)
  })

  it(
    '悪手が連続する対局(20手以上)でも累積評価値は理論上限±64を超えない(T064、' +
      'T063のverifierが発見した-290等への発散バグの回帰テスト)',
    async () => {
      // 決定的な方策(各局面の合法手を記法の辞書順に並べ、先頭の手を選ぶ、パスは
      // `resolveMover`で自動処理)で24手分の実際に合法な着手列を作る(既存の
      // telescopingテストと同じ手法をより長い手数に拡張)。
      const moves: string[] = []
      let board = initialBoard()
      let mover: Side | null = resolveMover(board, 'black')
      const moveSides: Side[] = []
      for (let step = 0; step < 24 && mover !== null; step++) {
        const chosen = legalMoves(board, mover).map(squareToNotation).sort()[0]!
        moves.push(chosen)
        moveSides.push(mover)
        board = applyMove(board, mover, notationToSquare(chosen))
        mover = resolveMover(board, opposite(mover))
      }
      expect(moves.length).toBeGreaterThanOrEqual(20)

      // 黒番の手は常に「最善から30石ロス」する大悪手、白番の手は常に最善手
      // (ロス0)にする(黒番の連続悪手により、累積評価値がクランプ無しでは
      // 大きく発散するシナリオを再現する)。
      const positions = replayGame(moves)
      const byHash = new Map<string, MoveEvalJson[]>()
      for (let i = 0; i < moves.length; i++) {
        const pos = positions[i]!
        const played = moves[i]!
        const entries: MoveEvalJson[] =
          moveSides[i] === 'black'
            ? [
                { move: played, score: 0, discDiff: 0, type: 'midgame' },
                { move: '__best__', score: 0, discDiff: 30, type: 'midgame' },
              ]
            : [{ move: played, score: 0, discDiff: 0, type: 'midgame' }]
        byHash.set(hashBoard(pos.board, pos.mover!), entries)
      }
      const engine: AnalyzeEngine = {
        async requestAnalyzeAll(b, turn) {
          const found = byHash.get(hashBoard(b, turn))
          if (!found) throw new Error('unexpected position queried')
          return found
        },
      }
      const dbFactory = new IDBFactory()

      const results = await analyzeGame(engine, moves, { dbFactory })

      // クランプ無しなら黒番の悪手が積み重なり続けて-64を大きく下回る(例:
      // 12手の黒番悪手だけで-360)はずだが、クランプにより-64で頭打ちになる。
      for (const m of results) {
        expect(Math.abs(m.blackAdvantageBefore)).toBeLessThanOrEqual(DISC_DIFF_THEORETICAL_MAX)
        expect(Math.abs(m.blackAdvantageAfter)).toBeLessThanOrEqual(DISC_DIFF_THEORETICAL_MAX)
      }
      // 十分な手数の黒番悪手が積み重なった後は、実際に-64で頭打ちになっている
      // ことを確認する(クランプが発火せずただ範囲内に収まっただけ、ではないこと
      // の確認)。
      const last = results[results.length - 1]!
      expect(last.blackAdvantageAfter).toBe(-DISC_DIFF_THEORETICAL_MAX)
    },
  )
})

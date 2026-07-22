import { describe, expect, it, vi } from 'vitest'
import { createGame, createGameFromPosition, playMove, requestCpuMove, type EngineQuery } from './gameLoop.ts'
import { createBoard, hasLegalMove, legalMoves, notationToSquare, squareToNotation } from './othello.ts'

const limit = { depth: 4, exactFromEmpties: 8 }

describe('createGame', () => {
  it('starts from the standard initial position with black to move', () => {
    const game = createGame('black')
    expect(game.sideToMove).toBe('black')
    expect(game.phase).toBe('human')
    expect(game.lastMove).toBeNull()
    expect(game.passMessage).toBeNull()
    expect(game.result).toBeNull()
  })

  it('sets phase to cpu when the human plays white (black moves first)', () => {
    const game = createGame('white')
    expect(game.sideToMove).toBe('black')
    expect(game.phase).toBe('cpu')
  })
})

describe('playMove', () => {
  it('ignores clicks on illegal squares and returns the same state', () => {
    const game = createGame('black')
    const illegal = notationToSquare('a1')
    const next = playMove(game, illegal)
    expect(next).toBe(game)
  })

  it('applies a legal human move and hands the turn to the cpu', () => {
    const game = createGame('black')
    const move = notationToSquare('d3')
    const next = playMove(game, move)

    expect(next.lastMove).toBe(move)
    expect(next.sideToMove).toBe('white')
    expect(next.phase).toBe('cpu')
    expect(next.passMessage).toBeNull()
    expect(next.result).toBeNull()
  })
})

describe('requestCpuMove', () => {
  it('does nothing (and does not call the engine) when it is not the cpu turn', async () => {
    const game = createGame('black') // phase: 'human'
    const engine: EngineQuery = { requestAnalyze: vi.fn() }

    const result = await requestCpuMove(game, engine, limit)

    expect(result.state).toBe(game)
    expect(result.evalScore).toBeNull()
    expect(engine.requestAnalyze).not.toHaveBeenCalled()
  })

  it('queries the engine for the cpu side and applies pv[0], handing the turn back to the human', async () => {
    const afterHumanMove = playMove(createGame('black'), notationToSquare('d3'))
    expect(afterHumanMove.phase).toBe('cpu')
    expect(afterHumanMove.sideToMove).toBe('white')

    // 実際にその局面で白にとって合法な手を選び、モックエンジンにそれを返させる。
    const whiteReply = legalMoves(afterHumanMove.board, 'white')[0]
    expect(whiteReply).toBeDefined()

    const requestAnalyze = vi
      .fn()
      .mockResolvedValue({ pv: [squareToNotation(whiteReply)], score: { discDiff: 3, type: 'midgame' as const } })
    const engine: EngineQuery = { requestAnalyze }

    const result = await requestCpuMove(afterHumanMove, engine, limit)

    expect(requestAnalyze).toHaveBeenCalledWith(afterHumanMove.board, 'white', limit)
    expect(result.state.lastMove).toBe(whiteReply)
    expect(result.state.sideToMove).toBe('black')
    expect(result.state.phase).toBe('human')
    // T197: `response.score`(以前は捨てていた値)がそのまま返る(白=CPU視点)。
    expect(result.evalScore).toEqual({ discDiff: 3, type: 'midgame' })
  })

  it('applies a supplied book move without calling the engine, and returns evalScore: null (T197: 定石ブック手は探索していないため評価値なし)', async () => {
    const afterHumanMove = playMove(createGame('black'), notationToSquare('d3'))
    const bookMove = legalMoves(afterHumanMove.board, 'white')[0]!
    const engine: EngineQuery = { requestAnalyze: vi.fn() }

    const result = await requestCpuMove(afterHumanMove, engine, limit, bookMove)

    expect(engine.requestAnalyze).not.toHaveBeenCalled()
    expect(result.state.lastMove).toBe(bookMove)
    expect(result.state.phase).toBe('human')
    expect(result.evalScore).toBeNull()
  })

  it('falls back to the engine when no book move is supplied', async () => {
    const afterHumanMove = playMove(createGame('black'), notationToSquare('d3'))
    const engineMove = legalMoves(afterHumanMove.board, 'white')[0]!
    const requestAnalyze = vi
      .fn()
      .mockResolvedValue({ pv: [squareToNotation(engineMove)], score: { discDiff: -2, type: 'exact' as const } })
    const engine: EngineQuery = { requestAnalyze }

    const result = await requestCpuMove(afterHumanMove, engine, limit, null)

    expect(requestAnalyze).toHaveBeenCalledOnce()
    expect(result.state.lastMove).toBe(engineMove)
    expect(result.evalScore).toEqual({ discDiff: -2, type: 'exact' })
  })
})

describe('createGame with vsHuman (T077)', () => {
  it('defaults to vsHuman: false and behaves exactly like before', () => {
    const game = createGame('black')
    expect(game.vsHuman).toBe(false)
    expect(game.phase).toBe('human')
  })

  it('starts both sides in phase "human" and never "cpu" when vsHuman: true', () => {
    const game = createGame('black', { vsHuman: true })
    expect(game.vsHuman).toBe(true)
    expect(game.phase).toBe('human')

    const afterBlackMove = playMove(game, notationToSquare('d3'))
    expect(afterBlackMove.sideToMove).toBe('white')
    // vsHuman: trueのままなら、白番になっても'cpu'にならず'human'のまま。
    expect(afterBlackMove.phase).toBe('human')
    expect(afterBlackMove.vsHuman).toBe(true)
  })

  it('never calls the engine via requestCpuMove while vsHuman: true', async () => {
    const game = createGame('black', { vsHuman: true })
    const afterBlackMove = playMove(game, notationToSquare('d3'))
    const engine: EngineQuery = { requestAnalyze: vi.fn() }

    const result = await requestCpuMove(afterBlackMove, engine, { depth: 4, exactFromEmpties: 8 })

    expect(result.state).toBe(afterBlackMove)
    expect(result.evalScore).toBeNull()
    expect(engine.requestAnalyze).not.toHaveBeenCalled()
  })
})

describe('createGameFromPosition (T077: 盤面自由配置からの開始)', () => {
  it('starts from the given board/sideToMove when the mover has a legal move', () => {
    const board = createGame('black').board // 標準初期局面を流用
    const game = createGameFromPosition(board, 'black', 'black')

    expect(game.board).toBe(board)
    expect(game.sideToMove).toBe('black')
    expect(game.phase).toBe('human')
    expect(game.lastMove).toBeNull()
    expect(game.passMessage).toBeNull()
    expect(game.result).toBeNull()
  })

  it('auto-passes to the other side when the given sideToMove has no legal move but the opponent does', () => {
    // 黒だけが合法手を持ち、白は合法手を持たない局面(gameLoop.test.tsのpass handlingと同じ構成)。
    const board = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    expect(hasLegalMove(board, 'black')).toBe(true)
    expect(hasLegalMove(board, 'white')).toBe(false)

    const game = createGameFromPosition(board, 'white', 'black')

    expect(game.sideToMove).toBe('black')
    expect(game.phase).toBe('human')
    expect(game.passMessage).toBe('白はパスしました')
    expect(game.result).toBeNull()
  })

  it('immediately ends the game (phase: "over") when neither side has a legal move', () => {
    // 全マスが黒石で埋まった盤面: どちらの色にも合法手が無い。
    const allSquares = Array.from({ length: 64 }, (_, i) => i)
    const board = createBoard(allSquares, [])

    const game = createGameFromPosition(board, 'black', 'black')

    expect(game.phase).toBe('over')
    expect(game.result).toBe('black')
    expect(game.passMessage).toBeNull()
  })

  it('supports vsHuman: true from a custom position', () => {
    const board = createGame('black').board
    const game = createGameFromPosition(board, 'white', 'black', { vsHuman: true })

    expect(game.vsHuman).toBe(true)
    expect(game.phase).toBe('human')
  })
})

describe('pass handling', () => {
  // a1(黒) - b1(白) - c1(白) - d1(白) - (e1 空) の並びに加え、盤の反対側の隅に
  // h8(黒) - g8(白) - (f8 空) という独立した領域を用意する。
  //
  // 黒がe1に着手するとb1-d1がひっくり返り、盤上から白石がb1,c1,d1の3つとも
  // 消えてg8だけが残る。この時点で白は合法手を持たない(手掛かりとなる
  // 「黒に挟まれた白石列の先の空きマス」がg8側にしか存在しないが、そちら方向
  // には白は関与できない)一方、黒はf8への合法手(g8を挟んでh8に到達)をまだ
  // 持っているため、「白パス・黒の連続手番」が発生する。
  function buildIsolatedPocketsBoard() {
    return createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
  }

  it('auto-passes the side with no legal moves and keeps the other side to move', () => {
    const board = buildIsolatedPocketsBoard()
    // 前提確認: この局面で黒はe1に合法手を持つ。
    expect(legalMoves(board, 'black')).toContain(notationToSquare('e1'))

    const game = createGame('black')
    const midGame = { ...game, board }

    const afterE1 = playMove(midGame, notationToSquare('e1'))

    // 白は合法手を持たなくなり、黒の連続手番としてパス通知が出る。
    expect(hasLegalMove(afterE1.board, 'white')).toBe(false)
    expect(hasLegalMove(afterE1.board, 'black')).toBe(true)
    expect(afterE1.sideToMove).toBe('black')
    expect(afterE1.phase).toBe('human')
    expect(afterE1.passMessage).toBe('白はパスしました')
    expect(afterE1.result).toBeNull()
  })

  it('ends the game once neither side has a legal move (both sides effectively pass)', () => {
    const board = buildIsolatedPocketsBoard()
    const game = { ...createGame('black'), board }

    const afterE1 = playMove(game, notationToSquare('e1'))
    expect(afterE1.phase).toBe('human') // 白パスにより黒の連続手番

    const afterF8 = playMove(afterE1, notationToSquare('f8'))

    // 白石が盤上から消え、黒にももう合法手がないため終局する。
    expect(hasLegalMove(afterF8.board, 'black')).toBe(false)
    expect(hasLegalMove(afterF8.board, 'white')).toBe(false)
    expect(afterF8.phase).toBe('over')
    expect(afterF8.result).toBe('black')
  })
})

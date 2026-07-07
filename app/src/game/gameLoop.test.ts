import { describe, expect, it, vi } from 'vitest'
import { createGame, playMove, requestCpuMove, type EngineQuery } from './gameLoop.ts'
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

    const next = await requestCpuMove(game, engine, limit)

    expect(next).toBe(game)
    expect(engine.requestAnalyze).not.toHaveBeenCalled()
  })

  it('queries the engine for the cpu side and applies pv[0], handing the turn back to the human', async () => {
    const afterHumanMove = playMove(createGame('black'), notationToSquare('d3'))
    expect(afterHumanMove.phase).toBe('cpu')
    expect(afterHumanMove.sideToMove).toBe('white')

    // 実際にその局面で白にとって合法な手を選び、モックエンジンにそれを返させる。
    const whiteReply = legalMoves(afterHumanMove.board, 'white')[0]
    expect(whiteReply).toBeDefined()

    const requestAnalyze = vi.fn().mockResolvedValue({ pv: [squareToNotation(whiteReply)] })
    const engine: EngineQuery = { requestAnalyze }

    const next = await requestCpuMove(afterHumanMove, engine, limit)

    expect(requestAnalyze).toHaveBeenCalledWith(afterHumanMove.board, 'white', limit)
    expect(next.lastMove).toBe(whiteReply)
    expect(next.sideToMove).toBe('black')
    expect(next.phase).toBe('human')
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

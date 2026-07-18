import { describe, expect, it } from 'vitest'
import { appendPlayedMove, computeUndoLength, isStandardStartPosition, movesToTranscript, replayMoves } from './gameHistory.ts'
import { createGame, createGameFromPosition, playMove, type GameState } from './gameLoop.ts'
import { createBoard, hasLegalMove, initialBoard, legalMoves, notationToSquare, squareToNotation } from './othello.ts'

/**
 * `buildIsolatedPocketsBoard`(`gameLoop.test.ts`の「pass handling」テストと同じ構成):
 * 黒がe1に着手するとb1-d1がひっくり返り、白は合法手を失う(白パス)。続けて
 * 黒がf8に着手すると盤上から白石が消え、どちらの色にも合法手が無くなり終局する。
 * この2手だけで「パスを挟む対局」を短く再現できる。
 */
function buildIsolatedPocketsBoard() {
  return createBoard(
    [notationToSquare('a1'), notationToSquare('h8')],
    [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
  )
}

describe('appendPlayedMove', () => {
  it('通常対局: 合法手が適用されるたびに着手記法を末尾へ追記する', () => {
    let history: string[] = []
    let game: GameState = createGame('black')

    const d3 = notationToSquare('d3')
    let next = playMove(game, d3)
    history = appendPlayedMove(history, game, next)
    game = next
    expect(history).toEqual(['d3'])

    const whiteReply = legalMoves(game.board, 'white')[0]!
    const whiteReplyNotation = squareToNotation(whiteReply)
    next = playMove(game, whiteReply)
    history = appendPlayedMove(history, game, next)
    game = next
    expect(history).toEqual(['d3', whiteReplyNotation])
    expect(movesToTranscript(history)).toBe(`d3${whiteReplyNotation}`)
  })

  it('非合法手クリックでは状態が変化しないため、履歴に何も追記しない', () => {
    const game = createGame('black')
    const illegal = notationToSquare('a1')
    const next = playMove(game, illegal) // othello.tsの規約により非合法手はそのまま同じ状態を返す
    expect(next).toBe(game)

    const history = appendPlayedMove([], game, next)
    expect(history).toEqual([])
  })

  it('パス含み対局: パスは着手として記録されず、実際に打たれた手だけが残る', () => {
    const board = buildIsolatedPocketsBoard()
    const game: GameState = { ...createGame('black'), board }
    expect(legalMoves(board, 'black')).toContain(notationToSquare('e1'))

    let history: string[] = []

    // 黒がe1に着手 -> 白がパスし、黒の連続手番になる。
    const afterE1 = playMove(game, notationToSquare('e1'))
    expect(afterE1.passMessage).toBe('白はパスしました')
    history = appendPlayedMove(history, game, afterE1)
    expect(history).toEqual(['e1'])

    // 黒がf8に着手 -> 白石が消え、どちらにも合法手が無くなり終局する。
    const afterF8 = playMove(afterE1, notationToSquare('f8'))
    expect(afterF8.phase).toBe('over')
    history = appendPlayedMove(history, afterE1, afterF8)
    expect(history).toEqual(['e1', 'f8'])

    // 棋譜文字列には「白のパス」がどこにも現れない
    // (parseTranscript/replayGameの「パスは記法上表現しない」規約と一致)。
    expect(movesToTranscript(history)).toBe('e1f8')
  })

  it('短い対局: 1手だけの履歴も正しく変換できる', () => {
    const game = createGame('black')
    const next = playMove(game, notationToSquare('d3'))
    const history = appendPlayedMove([], game, next)
    expect(history).toEqual(['d3'])
    expect(movesToTranscript(history)).toBe('d3')
  })

  it('渡した配列を書き換えず、新しい配列を返す(イミュータブル)', () => {
    const original: string[] = ['d3']
    const game = createGame('black')
    const next = playMove(game, notationToSquare('d3'))
    const appended = appendPlayedMove(original, { lastMove: null }, next)
    expect(appended).not.toBe(original)
    expect(original).toEqual(['d3'])
  })
})

describe('movesToTranscript', () => {
  it('区切りなしで着手記法を連結する', () => {
    expect(movesToTranscript(['d3', 'c4', 'f5'])).toBe('d3c4f5')
  })

  it('空配列は空文字列になる', () => {
    expect(movesToTranscript([])).toBe('')
  })
})

describe('isStandardStartPosition', () => {
  it('標準初期局面・黒番なら true', () => {
    expect(isStandardStartPosition(initialBoard(), 'black')).toBe(true)
  })

  it('標準初期局面でも白番なら false(黒番前提のオセロの規約から外れる)', () => {
    expect(isStandardStartPosition(initialBoard(), 'white')).toBe(false)
  })

  it('盤面配置が標準と異なれば false(盤面自由配置エディタからの対局)', () => {
    const board = buildIsolatedPocketsBoard()
    expect(isStandardStartPosition(board, 'black')).toBe(false)
  })

  it('createGameFromPositionで標準局面を明示的に組み立てても true になる', () => {
    const game = createGameFromPosition(initialBoard(), 'black', 'black')
    expect(isStandardStartPosition(game.board, game.sideToMove)).toBe(true)
    // 前提確認: この局面で黒に合法手がある(パス即終局ではない通常の開始)。
    expect(hasLegalMove(game.board, 'black')).toBe(true)
  })
})

/**
 * `moves`の記法列を実際に順番に着手して(常に現局面の最初の合法手を選ぶ
 * 決定的な手順で)組み立てるテスト用ヘルパー。標準初期局面(黒番)から始まる
 * 対局を、CPU対戦(`humanSide`/`vsHuman: false`)を想定して`count`手ぶん進める。
 */
function playMovesFromStart(count: number): string[] {
  let game: GameState = createGame('black')
  const moves: string[] = []
  for (let i = 0; i < count; i += 1) {
    const square = legalMoves(game.board, game.sideToMove)[0]!
    game = playMove(game, square)
    moves.push(squareToNotation(square))
  }
  return moves
}

describe('replayMoves(T140: 1手戻るのリプレイ再構築)', () => {
  it('空配列を渡すと、createGameと同じ開始局面のGameStateを返す', () => {
    const replayed = replayMoves('black', false, [])
    const started = createGame('black')
    expect(replayed).toEqual(started)
  })

  it('着手記法列を順に適用した結果は、playMoveを手動で連鎖させた結果と一致する', () => {
    const moves = playMovesFromStart(4)

    let expected: GameState = createGame('black')
    for (const move of moves) {
      expected = playMove(expected, notationToSquare(move))
    }

    expect(replayMoves('black', false, moves)).toEqual(expected)
  })

  it('2人対戦(vsHuman)でも同様にリプレイできる', () => {
    let game: GameState = createGame('black', { vsHuman: true })
    const d3 = notationToSquare('d3')
    game = playMove(game, d3)
    const whiteReply = legalMoves(game.board, 'white')[0]!
    game = playMove(game, whiteReply)

    const moves = ['d3', squareToNotation(whiteReply)]
    expect(replayMoves('black', true, moves)).toEqual(game)
  })

  it('人間が白番の対局(黒=CPU)も正しくリプレイできる(humanSideがCPUの色判定に使われる)', () => {
    const moves = playMovesFromStart(3)
    let expected: GameState = createGame('white')
    for (const move of moves) {
      expected = playMove(expected, notationToSquare(move))
    }
    expect(replayMoves('white', false, moves)).toEqual(expected)
  })
})

describe('computeUndoLength(T140: 1手戻るの保持すべき着手数)', () => {
  it('2人対戦(vsHuman)は単純に1ply戻す', () => {
    const moves = playMovesFromStart(3)
    expect(computeUndoLength(moves, 'black', true)).toBe(2)
  })

  it('2人対戦(vsHuman)で履歴が1件だけなら0(初期局面へ戻る)', () => {
    const moves = playMovesFromStart(1)
    expect(computeUndoLength(moves, 'black', true)).toBe(0)
  })

  it('2人対戦(vsHuman)で履歴が空なら0のまま(0未満にはしない)', () => {
    expect(computeUndoLength([], 'black', true)).toBe(0)
  })

  it('CPU対戦: 人間の着手1件+CPUの応手1件のペアがある場合、まとめて2件戻す', () => {
    // 黒(human)が1手・白(CPU)が応手1手、という2手ぶんの対局を組み立てる。
    const moves = playMovesFromStart(2)
    expect(computeUndoLength(moves, 'black', false)).toBe(0)
  })

  it('CPU対戦: 4手(human, cpu, human, cpu)進めた後は、直前のペア(3・4手目)だけ戻す(1手目直後の自分の手番に戻る)', () => {
    const moves = playMovesFromStart(4)
    expect(computeUndoLength(moves, 'black', false)).toBe(2)
    // 戻した後の状態は、1手目(human)+2手目(cpuの応手)まで進めた局面と一致する
    // (=「1手目直後の自分の手番」、要件1)。
    const truncated = moves.slice(0, computeUndoLength(moves, 'black', false))
    const afterUndo = replayMoves('black', false, truncated)
    expect(afterUndo.phase).toBe('human')
    expect(truncated).toEqual(moves.slice(0, 2))
  })

  it('CPU対戦: CPUがまだ応手していない(思考中)場合、自分の直前の手のみ(1件)戻す', () => {
    // 2手目(cpuの応手)をまだ`moves`に積んでいない状態を模す(=CPUが思考中)。
    const moves = playMovesFromStart(2)
    const whileThinking = moves.slice(0, 1) // humanの着手のみ記録済み
    expect(computeUndoLength(whileThinking, 'black', false)).toBe(0)
  })

  it('CPU対戦: 履歴が空なら0のまま', () => {
    expect(computeUndoLength([], 'black', false)).toBe(0)
  })

  it('CPU対戦: 人間が白番でCPU(黒)が初手を指した直後(履歴が1件・すべてCPU側)は0まで戻る', () => {
    // humanSideが'white'なので、standard開始の1手目(黒)は必ずCPU側の着手になる。
    const moves = playMovesFromStart(1)
    expect(computeUndoLength(moves, 'white', false)).toBe(0)
  })
})

/**
 * T195/T198: `twoPlyCompare.ts`(悪手直後の「5盤面比較」)の単体テスト。
 *
 * 4つの局面フィクスチャ(通常/相手パス/自分パス/真の終局)は、いずれも
 * `game/othello.ts`の実装をそのまま使った実在の盤面(scratchpadで
 * `npx tsx`により事前確認済み、`resolveMover.test.ts`の
 * `buildIsolatedPocketsBoard`と同じ「独立した孤立領域」構成手法)。
 *
 * T198で`TwoPlyBranchResult`に追加された`board1Ply`/`opponentMoves`
 * (1手先パネル用のデータ、追加のエンジン呼び出し無しで既存の
 * `requestAnalyzeAll`呼び出しの結果を保持しただけ)の検証を追加した。
 */
import { describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  createBoard,
  hasLegalMove,
  legalMoves,
  notationToSquare,
  squareToNotation,
  type Board,
  type Side,
} from '../game/othello.ts'
import {
  computeTwoPlyBranch,
  computeTwoPlyCompare,
  formatOpponentLegalCountHeader,
  formatOpponentPassNote,
  formatOriginalLegalCountHeader,
  formatSelfLegalCountHeader,
  formatTwoPlyCompareLossMessage,
  formatTwoPlyCompareMainMessage,
  twoPlyCompareSupplementalMessages,
  type RequestAnalyzeAllFn,
  type TwoPlyBranchResult,
} from './twoPlyCompare.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'

/** `board`上の`side`の全合法手を、`discDiff`は`pickBest`が最大になるよう並べたモック応答にする。 */
function movesFor(board: Board, side: Side, pickBest?: string, bestDiscDiff = 3): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => {
    const notation = squareToNotation(square)
    const discDiff = pickBest !== undefined && notation === pickBest ? bestDiscDiff : 0
    return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
  })
}

describe('midgame/twoPlyCompare: computeTwoPlyBranch', () => {
  it('通常ケース: 相手が実応手し、自分にも次の合法手がある(kind: ok)。1手先の相手合法手評価も保持する', async () => {
    // 初期局面からf5(黒)を打つ。ごく普通の中盤局面、双方に合法手が豊富にある
    // (白の応手選択肢: f4/d6/f6、scratchpadで`npx tsx`により確認済み)。
    const board = createBoard(
      [notationToSquare('d5'), notationToSquare('e4')],
      [notationToSquare('d4'), notationToSquare('e5')],
    )
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side, 'f4', 4)

    const result = await computeTwoPlyBranch(board, 'black', notationToSquare('f5'), requestAnalyzeAll)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.ownSquare).toBe(notationToSquare('f5'))
    expect(result.opponentPassed).toBe(false)
    expect(result.opponentSquare).not.toBeNull()
    // 白の最善応手として`f4`(discDiff 4)を選んだはず。
    expect(squareToNotation(result.opponentSquare!)).toBe('f4')
    expect(result.selfLegalCount).toBe(result.selfMoves.length)
    expect(result.selfLegalCount).toBeGreaterThan(0)
    expect(result.bestSelfEval).toBe(0) // このケースではmoversFor既定でdiscDiff0(pickBest指定なし)

    // T198: 1手先(自分の手の直後、相手番)の盤面・相手の全合法手評価。
    const boardAfterSelf = applyMove(board, 'black', notationToSquare('f5'))
    expect(result.board1Ply).toEqual(boardAfterSelf)
    expect(result.opponentMoves).not.toBeNull()
    expect(result.opponentMoves!.map((m) => m.move).sort()).toEqual(
      legalMoves(boardAfterSelf, 'white').map((sq) => squareToNotation(sq)).sort(),
    )
  })

  it('相手パス: 相手に合法手が無いが自分にはまだある(kind: ok, opponentPassed: true)。opponentMovesはnull', async () => {
    // resolveMover.test.tsの`buildIsolatedPocketsBoard`と同じ孤立領域構成。
    // 黒がe1を打つとb1-d1が反転、白は合法手0(パス)だが黒はまだf8に打てる。
    const board = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side)

    const result = await computeTwoPlyBranch(board, 'black', notationToSquare('e1'), requestAnalyzeAll)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.opponentPassed).toBe(true)
    expect(result.opponentSquare).toBeNull()
    // 相手がパスしたので盤面は自分の着手直後のまま。自分の合法手はf8のみ。
    expect(result.selfLegalCount).toBe(1)
    expect(result.selfMoves.map((m) => m.move)).toEqual(['f8'])
    // T198: 相手に合法手が無いので1手先の合法手評価は取得しない(null)。
    expect(result.opponentMoves).toBeNull()
    expect(result.board1Ply).toEqual(applyMove(board, 'black', notationToSquare('e1')))
  })

  it('自分パス: (相手の応手後)自分に合法手が無いが相手にはまだある(kind: selfPass)。相手の1手先合法手評価は保持する', async () => {
    // scratchpadで`npx tsx`により事前確認済みの孤立領域構成(3ブロック:
    // row1のa1/b1-d1/e1、row8のe8-h8+f8、column hのh3-h5)。
    // 黒がe1を打った後、白はg8を打てる(他にh2/h6/c8も打てるがg8を選ばせる)。
    // g8適用後、黒は合法手0、白はまだ合法手あり(自分パスケース)。
    const board = createBoard(
      [
        notationToSquare('a1'),
        notationToSquare('f8'),
        notationToSquare('d8'),
        notationToSquare('h5'),
        notationToSquare('h3'),
      ],
      [
        notationToSquare('b1'),
        notationToSquare('c1'),
        notationToSquare('d1'),
        notationToSquare('e8'),
        notationToSquare('h8'),
        notationToSquare('h4'),
      ],
    )
    // 前提確認(このテスト固有のフィクスチャが壊れていないことのガード)。
    expect(legalMoves(board, 'black')).toEqual([notationToSquare('e1')])

    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side, 'g8', 2)

    const result = await computeTwoPlyBranch(board, 'black', notationToSquare('e1'), requestAnalyzeAll)

    expect(result.kind).toBe('selfPass')
    if (result.kind !== 'selfPass') throw new Error('unreachable')
    expect(result.opponentPassed).toBe(false)
    expect(squareToNotation(result.opponentSquare!)).toBe('g8')
    expect(hasLegalMove(result.board, 'black')).toBe(false)
    expect(hasLegalMove(result.board, 'white')).toBe(true)
    // T198: 相手は実際に応手した(パスではない)ので、1手先の合法手評価が保持されている。
    expect(result.opponentMoves).not.toBeNull()
    expect(result.opponentMoves!.length).toBeGreaterThan(0)
  })

  it('真の終局(自分の手の直後): 相手・自分とも合法手が無い(kind: ended)。opponentMovesはnull、board1Ply === board', async () => {
    // resolveMover.test.tsの「両者とも合法手が無ければnull」ケースをそのまま使う。
    // afterE1(黒f8がまだ打てる状態)を`preMoveBoard`とし、黒がf8を打つと真の終局になる。
    const isolatedPockets = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    const afterE1 = applyMove(isolatedPockets, 'black', notationToSquare('e1'))
    expect(legalMoves(afterE1, 'black')).toEqual([notationToSquare('f8')])

    const requestAnalyzeAll: RequestAnalyzeAllFn = async () => {
      throw new Error('真の終局ケースではrequestAnalyzeAllは呼ばれないはず')
    }

    const result = await computeTwoPlyBranch(afterE1, 'black', notationToSquare('f8'), requestAnalyzeAll)

    expect(result.kind).toBe('ended')
    if (result.kind !== 'ended') throw new Error('unreachable')
    expect(result.opponentSquare).toBeNull()
    expect(result.opponentPassed).toBe(false)
    expect(hasLegalMove(result.board, 'black')).toBe(false)
    expect(hasLegalMove(result.board, 'white')).toBe(false)
    // T198: 1手先の時点で既に終局(=2手先と同じ盤面)。相手の合法手評価は無い。
    expect(result.opponentMoves).toBeNull()
    expect(result.board1Ply).toEqual(result.board)
  })

  it('真の終局(相手の応手直後): 相手の実応手の後で双方合法手が無くなる(kind: ended)。相手の1手先合法手評価は保持する', async () => {
    // scratchpadで事前確認済み: 黒e1(b1-d1反転)→白の唯一の合法手d8を打つと、
    // その後は黒・白とも合法手が0になる。
    const board = createBoard(
      [notationToSquare('a1'), notationToSquare('e8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('f8')],
    )
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side, 'd8', 1)

    const result = await computeTwoPlyBranch(board, 'black', notationToSquare('e1'), requestAnalyzeAll)

    expect(result.kind).toBe('ended')
    if (result.kind !== 'ended') throw new Error('unreachable')
    expect(squareToNotation(result.opponentSquare!)).toBe('d8')
    expect(result.opponentPassed).toBe(false)
    expect(hasLegalMove(result.board, 'black')).toBe(false)
    expect(hasLegalMove(result.board, 'white')).toBe(false)
    // T198: 相手は実際に応手した(d8)ので、1手先の合法手評価が保持されている。
    expect(result.opponentMoves).not.toBeNull()
    expect(result.opponentMoves!.some((m) => m.move === 'd8')).toBe(true)
    expect(result.board1Ply).not.toEqual(result.board)
  })
})

describe('midgame/twoPlyCompare: computeTwoPlyCompare', () => {
  it('実際の手・最善手の2系列を並列に計算し、requestAnalyzeAllは系列ごとに独立して呼ばれる', async () => {
    const board = createBoard(
      [notationToSquare('d5'), notationToSquare('e4')],
      [notationToSquare('d4'), notationToSquare('e5')],
    )
    const calls: Array<{ board: Board; side: Side }> = []
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => {
      calls.push({ board: b, side })
      return movesFor(b, side)
    }

    const result = await computeTwoPlyCompare(
      board,
      'black',
      notationToSquare('f5'),
      notationToSquare('f4'),
      requestAnalyzeAll,
    )

    expect(result.played.ownSquare).toBe(notationToSquare('f5'))
    expect(result.best.ownSquare).toBe(notationToSquare('f4'))
    // 系列ごとに最大2回(相手応手+自分の合法手)、2系列で最大4回(既存の呼び出し回数構成を崩さない、T198でも不変)。
    expect(calls.length).toBeLessThanOrEqual(4)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('midgame/twoPlyCompare: メッセージ生成', () => {
  it('通常ケース(両系列ともok)の主文を、着手可能数といちばん良い手の評価値を対にして組み立てる', async () => {
    const board = createBoard(
      [notationToSquare('d5'), notationToSquare('e4')],
      [notationToSquare('d4'), notationToSquare('e5')],
    )
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side, 'd3', 4)
    const compare = await computeTwoPlyCompare(
      board,
      'black',
      notationToSquare('f5'),
      notationToSquare('f4'),
      requestAnalyzeAll,
    )

    const main = formatTwoPlyCompareMainMessage(compare)
    expect(main).toContain('この手だと次にあなたは')
    expect(main).toContain('か所に打てます')
    expect(main).toContain('最善手なら')
    expect(main).toContain('でした。')
  })

  it('損失1行を石差の四捨五入で組み立てる', () => {
    expect(formatTwoPlyCompareLossMessage(2.4)).toBe('この手は最善手より約2石損しています。')
    expect(formatTwoPlyCompareLossMessage(2.6)).toBe('この手は最善手より約3石損しています。')
  })

  it('補足行: `ClearBlunderPattern`のmessageをそのまま最大2件返す(nullなら空配列)', () => {
    const patterns: ClearBlunderPattern[] = [
      { id: 'corner-gift', message: 'この手だと相手に隅を取られます。', severity: 10, playedHighlightSquares: [], bestHighlightSquares: [] },
    ]
    expect(twoPlyCompareSupplementalMessages(patterns)).toEqual(['この手だと相手に隅を取られます。'])
    expect(twoPlyCompareSupplementalMessages(null)).toEqual([])
    expect(twoPlyCompareSupplementalMessages(undefined)).toEqual([])
  })
})

describe('midgame/twoPlyCompare: T198 パネルヘッダ生成', () => {
  it('formatOriginalLegalCountHeader: 未取得はローディング文言、取得済みは「あなたの打てる場所: N か所」(T199要件2)', () => {
    expect(formatOriginalLegalCountHeader(null)).toBe('打てる場所を計算しています…')
    const moves: MoveEvalJson[] = [
      { move: 'd3', score: 0, discDiff: 0, type: 'midgame' },
      { move: 'c4', score: 0, discDiff: 0, type: 'midgame' },
    ]
    expect(formatOriginalLegalCountHeader(moves)).toBe('あなたの打てる場所: 2 か所')
  })

  it('formatOpponentLegalCountHeader: 相手が応手可能なら「相手の打てる場所: N か所」、パスなら「0 か所(パス)」、終局なら「0 か所(終局)」(T199要件2)', async () => {
    const board = createBoard(
      [notationToSquare('d5'), notationToSquare('e4')],
      [notationToSquare('d4'), notationToSquare('e5')],
    )
    const okBranch = await computeTwoPlyBranch(
      board,
      'black',
      notationToSquare('f5'),
      async (b, side) => movesFor(b, side, 'f4', 4),
    )
    expect(formatOpponentLegalCountHeader(okBranch)).toMatch(/^相手の打てる場所: \d+ か所$/)

    const passBoard = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    const passBranch = await computeTwoPlyBranch(
      passBoard,
      'black',
      notationToSquare('e1'),
      async (b, side) => movesFor(b, side),
    )
    expect(formatOpponentLegalCountHeader(passBranch)).toBe('相手の打てる場所: 0 か所(パス)')

    const isolatedPockets = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    const afterE1 = applyMove(isolatedPockets, 'black', notationToSquare('e1'))
    const endedBranch = await computeTwoPlyBranch(
      afterE1,
      'black',
      notationToSquare('f8'),
      async () => {
        throw new Error('呼ばれないはず')
      },
    )
    expect(formatOpponentLegalCountHeader(endedBranch)).toBe('相手の打てる場所: 0 か所(終局)')
  })

  it('formatSelfLegalCountHeader: kindごとに「あなたの打てる場所: N か所」/パス/終局(石差)を表示する(T199要件2)', () => {
    const board = createBoard([notationToSquare('a1')], [])
    const okBranch: TwoPlyBranchResult = {
      kind: 'ok',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: 0,
      opponentSquare: null,
      opponentPassed: false,
      selfMoves: [{ move: 'c3', score: 0, discDiff: 0, type: 'midgame' }],
      selfLegalCount: 1,
      bestSelfEval: 0,
    }
    expect(formatSelfLegalCountHeader(okBranch)).toBe('あなたの打てる場所: 1 か所')

    const selfPassBranch: TwoPlyBranchResult = {
      kind: 'selfPass',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: 0,
      opponentSquare: null,
      opponentPassed: false,
    }
    expect(formatSelfLegalCountHeader(selfPassBranch)).toBe('あなたの打てる場所: 0 か所(パス)')

    const endedBranch: TwoPlyBranchResult = {
      kind: 'ended',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: 0,
      opponentSquare: null,
      opponentPassed: false,
      finalDiscDiff: 5,
    }
    expect(formatSelfLegalCountHeader(endedBranch)).toBe('終局(石差+5)')
  })

  it('formatOpponentPassNote: 相手がパスした場合のみ注記文を返す', () => {
    const board = createBoard([notationToSquare('a1')], [])
    const passedBranch: TwoPlyBranchResult = {
      kind: 'ok',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: 0,
      opponentSquare: null,
      opponentPassed: true,
      selfMoves: [],
      selfLegalCount: 0,
      bestSelfEval: 0,
    }
    expect(formatOpponentPassNote(passedBranch)).toBe('相手はパスしたため、盤面は1手先と同じです。')

    const normalBranch: TwoPlyBranchResult = { ...passedBranch, opponentPassed: false, opponentSquare: 1 }
    expect(formatOpponentPassNote(normalBranch)).toBeNull()
  })
})

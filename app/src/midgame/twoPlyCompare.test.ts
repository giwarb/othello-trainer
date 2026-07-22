/**
 * T195: `twoPlyCompare.ts`(悪手直後の「2手先」2盤面比較)の単体テスト。
 *
 * 4つの局面フィクスチャ(通常/相手パス/自分パス/真の終局)は、いずれも
 * `game/othello.ts`の実装をそのまま使った実在の盤面(scratchpadで
 * `npx tsx`により事前確認済み、`resolveMover.test.ts`の
 * `buildIsolatedPocketsBoard`と同じ「独立した孤立領域」構成手法)。
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
  formatTwoPlyCompareLossMessage,
  formatTwoPlyCompareMainMessage,
  formatTwoPlyBranchHeader,
  twoPlyCompareSupplementalMessages,
  type RequestAnalyzeAllFn,
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
  it('通常ケース: 相手が実応手し、自分にも次の合法手がある(kind: ok)', async () => {
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
  })

  it('相手パス: 相手に合法手が無いが自分にはまだある(kind: ok, opponentPassed: true)', async () => {
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
  })

  it('自分パス: (相手の応手後)自分に合法手が無いが相手にはまだある(kind: selfPass)', async () => {
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
  })

  it('真の終局(自分の手の直後): 相手・自分とも合法手が無い(kind: ended)', async () => {
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
  })

  it('真の終局(相手の応手直後): 相手の実応手の後で双方合法手が無くなる(kind: ended)', async () => {
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
    // 系列ごとに最大2回(相手応手+自分の合法手)、2系列で最大4回。
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

  it('ヘッダ文言: 相手パスは「パス」、自分パスは「0 か所(パス)」と明記する', async () => {
    const board = createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
    const requestAnalyzeAll: RequestAnalyzeAllFn = async (b, side) => movesFor(b, side)
    const branch = await computeTwoPlyBranch(board, 'black', notationToSquare('e1'), requestAnalyzeAll)
    const header = formatTwoPlyBranchHeader('e1', branch)
    expect(header).toContain('相手: パス')
    expect(header).toContain('打てる場所: 1 か所')
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

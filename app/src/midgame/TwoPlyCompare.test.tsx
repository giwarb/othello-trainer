// @vitest-environment jsdom
/**
 * T195/T198: `TwoPlyCompare.tsx`のコンポーネントテスト。
 *
 * `Board`(Canvas描画)は関心事ではないため`ClearBlunderCompare.test.tsx`と
 * 同じ方針でスタブ化する。`MoveEvalOverlay`は実物を使い、盤面セルの評価値
 * 表示(`.move-eval-overlay__cell`)が実際に描画されることを確認する。
 *
 * T198: 2盤面→5盤面(元局面+1手先×2+2手先×2)表示への拡張に伴い全面書き換え。
 * `.two-ply-compare__board-col`は5枚描画されるはず。着手位置バッジ
 * (`.two-ply-compare__move-markers__badge`)の手番・エッジケースの検証を追加した。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { createBoard, notationToSquare, type Board as BoardState } from '../game/othello.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'
import type { TwoPlyBranchResult, TwoPlyCompareResult } from './twoPlyCompare.ts'

vi.mock('../components/Board.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Board: (props: any) => (
    <div
      data-testid="stub-board"
      data-black={props.board.black.toString()}
      data-white={props.board.white.toString()}
      data-side={props.sideToMove}
      data-last-move={props.lastMove}
    >
      board
    </div>
  ),
}))

const THRESHOLDS = loadClassifyThresholds({
  getItem: () => null,
  setItem: () => {},
} as unknown as Storage)

const PRE_MOVE_BOARD = createBoard([notationToSquare('d5'), notationToSquare('e4')], [notationToSquare('d4'), notationToSquare('e5')])

function originalMovesFixture(): MoveEvalJson[] {
  return [
    { move: 'f5', score: 0, discDiff: 0, type: 'midgame' },
    { move: 'f4', score: 0, discDiff: 0, type: 'midgame' },
  ]
}

/** T198: `board1Ply`/`opponentMoves`を含む`ok`ブランチのフィクスチャを組み立てる。 */
function okBranch(
  board1Ply: BoardState,
  opponentMoves: MoveEvalJson[] | null,
  board: BoardState,
  ownSquare: number,
  opponentSquare: number | null,
  selfMoves: MoveEvalJson[],
): TwoPlyBranchResult {
  return {
    kind: 'ok',
    board1Ply,
    opponentMoves,
    board,
    ownSquare,
    opponentSquare,
    opponentPassed: false,
    selfMoves,
    selfLegalCount: selfMoves.length,
    bestSelfEval: selfMoves.length > 0 ? Math.max(...selfMoves.map((m) => m.discDiff)) : 0,
  }
}

describe('midgame/TwoPlyCompare', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('5盤面(元局面+1手先×2+2手先×2)+ヘッダ+MoveEvalOverlayのセル評価値+主文+損失1行を描画する', async () => {
    const board1PlyPlayed = createBoard([notationToSquare('g6')], [])
    const boardAfterPlayed = createBoard([notationToSquare('a1')], [])
    const board1PlyBest = createBoard([notationToSquare('b1')], [])
    const boardAfterBest = createBoard([], [notationToSquare('h8')])

    const compare: TwoPlyCompareResult = {
      played: okBranch(
        board1PlyPlayed,
        [{ move: 'a2', score: 0, discDiff: 0, type: 'midgame' }],
        boardAfterPlayed,
        notationToSquare('g6'),
        notationToSquare('a2'),
        [
          { move: 'c3', score: 200, discDiff: 2, type: 'midgame' },
          { move: 'd3', score: 0, discDiff: 0, type: 'midgame' },
        ],
      ),
      best: okBranch(
        board1PlyBest,
        [{ move: 'h7', score: 0, discDiff: 0, type: 'midgame' }],
        boardAfterBest,
        notationToSquare('b1'),
        notationToSquare('h7'),
        [{ move: 'e3', score: 400, discDiff: 4, type: 'midgame' }],
      ),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={2}
          thresholds={THRESHOLDS}
        />,
        container,
      )
    })

    const text = container.textContent ?? ''
    // 5枚のboard-colパネルが描画されている(元局面1+1手先2+2手先2)。
    expect(container.querySelectorAll('.two-ply-compare__board-col').length).toBe(5)
    expect(container.querySelectorAll('[data-testid="stub-board"]').length).toBe(5)

    expect(text).toContain('元局面')
    expect(text).toContain('実際に打った手')
    expect(text).toContain('最善手')
    expect(text).toContain('打てる場所: 2 か所') // 元局面のoriginalMoves(2件)
    expect(text).toContain('打てる場所: 1 か所') // 1手先(相手の合法手1件、played/best両方)

    // 主文: 着手可能数といちばん良い手の評価値。
    expect(text).toContain('この手だと次にあなたは2か所に打てます(いちばん良い手で+2)')
    expect(text).toContain('最善手なら1か所(いちばん良い手で+4)でした。')
    // 損失1行。
    expect(text).toContain('この手は最善手より約2石損しています。')

    // MoveEvalOverlay: 元局面(2)+1手先played(1)+1手先best(1)+2手先played(2)+2手先best(1) = 7セル。
    const overlayCells = container.querySelectorAll('.move-eval-overlay__value')
    expect(overlayCells.length).toBe(7)

    // T198要件4: 着手位置バッジ。1手先パネルは「自分」1件、2手先パネルは「自分」「相手」2件。
    const ownBadges = container.querySelectorAll('.two-ply-compare__move-markers__badge--own')
    const opponentBadges = container.querySelectorAll('.two-ply-compare__move-markers__badge--opponent')
    // 元局面(0)+1手先played(自分1)+1手先best(自分1)+2手先played(自分1)+2手先best(自分1) = 4。
    expect(ownBadges.length).toBe(4)
    // 2手先played(相手1)+2手先best(相手1) = 2(1手先パネルには相手バッジは無い)。
    expect(opponentBadges.length).toBe(2)

    // `onContinue`未指定なら「続ける」ボタンは描画されない(結果画面での静的表示、要件5)。
    expect(container.querySelector('.two-ply-compare__continue')).toBeNull()
  })

  it('1手先パネルの`MoveEvalOverlay`は相手番(mover=opponent)で描画される', async () => {
    const board = createBoard([notationToSquare('g6')], [])
    const compare: TwoPlyCompareResult = {
      played: okBranch(board, [{ move: 'a2', score: 0, discDiff: 0, type: 'midgame' }], board, notationToSquare('g6'), null, []),
      best: okBranch(board, null, board, notationToSquare('b1'), null, []),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={null}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={1}
          thresholds={THRESHOLDS}
        />,
        container,
      )
    })

    const stubBoards = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="stub-board"]'))
    // 1枚目は元局面(黒番)、2枚目は実際の手の1手先(相手=白番)のはず。
    expect(stubBoards[0]?.getAttribute('data-side')).toBe('black')
    expect(stubBoards[1]?.getAttribute('data-side')).toBe('white')
    // 元局面はoriginalMoves未取得(null)なのでローディング文言。
    expect(container.textContent).toContain('打てる場所を計算しています…')
  })

  it('`onContinue`指定時のみ「続ける」ボタンを描画し、クリックでコールバックを呼ぶ', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const compare: TwoPlyCompareResult = {
      played: okBranch(board, null, board, notationToSquare('g6'), null, []),
      best: okBranch(board, null, board, notationToSquare('b1'), null, []),
    }
    const onContinue = vi.fn()

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={1}
          thresholds={THRESHOLDS}
          onContinue={onContinue}
        />,
        container,
      )
    })

    const button = container.querySelector<HTMLButtonElement>('.two-ply-compare__continue')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('続ける')
    await act(async () => {
      button?.click()
    })
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('自分パス(kind: selfPass)の盤面はMoveEvalOverlayを描画せず、「0 か所(パス)」と表示する', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const selfPassBranch: TwoPlyBranchResult = {
      kind: 'selfPass',
      board1Ply: board,
      opponentMoves: [{ move: 'a2', score: 0, discDiff: 0, type: 'midgame' }],
      board,
      ownSquare: notationToSquare('g6'),
      opponentSquare: notationToSquare('a2'),
      opponentPassed: false,
    }
    const okBranchValue = okBranch(board, null, board, notationToSquare('b1'), notationToSquare('h7'), [
      { move: 'e3', score: 100, discDiff: 1, type: 'midgame' },
    ])
    const compare: TwoPlyCompareResult = { played: selfPassBranch, best: okBranchValue }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={3}
          thresholds={THRESHOLDS}
        />,
        container,
      )
    })

    const text = container.textContent ?? ''
    expect(text).toContain('打てる場所: 0 か所(パス)')
    // 自分パス側の2手先盤面にはMoveEvalOverlayのセル評価値が無い(合法手が無いため描画しない)。
    // 元局面(2)+1手先played(相手1)+1手先best(相手0=null)+2手先best(自分1) = 4。
    const overlayCells = container.querySelectorAll('.move-eval-overlay__value')
    expect(overlayCells.length).toBe(4)
    // それでも着手位置バッジ(自分/相手)は表示される(合法手の有無と独立)。
    // selfPass側(played)も相手は実応手した(a2)ので相手バッジがあり、best側も
    // opponentSquareを指定しているため、合計2件。
    expect(container.querySelectorAll('.two-ply-compare__move-markers__badge--opponent').length).toBe(2)
  })

  it('真の終局(kind: ended)は合法手オーバーレイ無しで「終局」を表示し、1手先=2手先の盤面は同一(相手パネルも「終局」表示)', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const endedBranch: TwoPlyBranchResult = {
      kind: 'ended',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: notationToSquare('g6'),
      opponentSquare: null,
      opponentPassed: false,
      finalDiscDiff: 5,
    }
    const compare: TwoPlyCompareResult = {
      played: endedBranch,
      best: okBranch(board, null, board, notationToSquare('b1'), notationToSquare('h7'), []),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={4}
          thresholds={THRESHOLDS}
        />,
        container,
      )
    })

    expect(container.textContent).toContain('終局(石差+5)')
    // 1手先パネル(相手番)も「終局」であることを明記する。
    expect(container.textContent).toContain('打てる場所: 0 か所(終局)')
  })

  it('相手パス(opponentPassed: true)の2手先パネルには、盤面が1手先と同じである旨の注記が表示される', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const passedBranch: TwoPlyBranchResult = {
      kind: 'ok',
      board1Ply: board,
      opponentMoves: null,
      board,
      ownSquare: notationToSquare('g6'),
      opponentSquare: null,
      opponentPassed: true,
      selfMoves: [{ move: 'f8', score: 0, discDiff: 0, type: 'midgame' }],
      selfLegalCount: 1,
      bestSelfEval: 0,
    }
    const compare: TwoPlyCompareResult = {
      played: passedBranch,
      best: okBranch(board, null, board, notationToSquare('b1'), notationToSquare('h7'), []),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={1}
          thresholds={THRESHOLDS}
        />,
        container,
      )
    })

    expect(container.textContent).toContain('相手はパスしたため、盤面は1手先と同じです。')
    // 相手がパスした系列の2手先盤面には「相手」バッジは無い(opponentSquareがnullのため自分のみ)。
    expect(container.querySelectorAll('.two-ply-compare__move-markers__badge--opponent').length).toBe(1) // best側の1件のみ
  })

  it('補足パターン(最大2件)を渡すと言語化文がリスト表示される(廃止していない、要件3)', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const compare: TwoPlyCompareResult = {
      played: okBranch(board, null, board, notationToSquare('g6'), notationToSquare('a2'), []),
      best: okBranch(board, null, board, notationToSquare('b1'), notationToSquare('h7'), []),
    }
    const patterns: ClearBlunderPattern[] = [
      {
        id: 'corner-gift',
        message: 'この手だと相手に隅(a1)を取られます。最善手なら取られませんでした。',
        severity: 10,
        playedHighlightSquares: [],
        bestHighlightSquares: [],
      },
    ]

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
          preMoveBoard={PRE_MOVE_BOARD}
          originalMoves={originalMovesFixture()}
          playedMoveNotation="g6"
          bestMoveNotation="b1"
          compare={compare}
          lossDiscs={1}
          thresholds={THRESHOLDS}
          patterns={patterns}
        />,
        container,
      )
    })

    const items = container.querySelectorAll('.two-ply-compare__patterns li')
    expect(items.length).toBe(1)
    expect(items[0]?.textContent).toContain('この手だと相手に隅(a1)を取られます。')
  })
})

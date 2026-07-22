// @vitest-environment jsdom
/**
 * T195: `TwoPlyCompare.tsx`のコンポーネントテスト。
 *
 * `Board`(Canvas描画)は関心事ではないため`ClearBlunderCompare.test.tsx`と
 * 同じ方針でスタブ化する。`MoveEvalOverlay`は実物を使い、盤面セルの評価値
 * 表示(`.move-eval-overlay__cell`)が実際に描画されることを確認する。
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

function okBranch(board: BoardState, ownSquare: number, opponentSquare: number, selfMoves: MoveEvalJson[]): TwoPlyBranchResult {
  return {
    kind: 'ok',
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

  it('盤面2枚(実際に打った手/最善手)+ヘッダ+MoveEvalOverlayのセル評価値+主文+損失1行を描画する', async () => {
    const boardAfterPlayed = createBoard([notationToSquare('a1')], [])
    const boardAfterBest = createBoard([], [notationToSquare('h8')])

    const compare: TwoPlyCompareResult = {
      played: okBranch(boardAfterPlayed, notationToSquare('g6'), notationToSquare('a2'), [
        { move: 'c3', score: 200, discDiff: 2, type: 'midgame' },
        { move: 'd3', score: 0, discDiff: 0, type: 'midgame' },
      ]),
      best: okBranch(boardAfterBest, notationToSquare('b1'), notationToSquare('h7'), [
        { move: 'e3', score: 400, discDiff: 4, type: 'midgame' },
      ]),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
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
    expect(text).toContain('実際に打った手')
    expect(text).toContain('最善手')
    expect(text).toContain('あなた: g6')
    expect(text).toContain('あなた: b1')
    expect(text).toContain('打てる場所: 2 か所')
    expect(text).toContain('打てる場所: 1 か所')

    // 主文: 着手可能数といちばん良い手の評価値。
    expect(text).toContain('この手だと次にあなたは2か所に打てます(いちばん良い手で+2)')
    expect(text).toContain('最善手なら1か所(いちばん良い手で+4)でした。')
    // 損失1行。
    expect(text).toContain('この手は最善手より約2石損しています。')

    // MoveEvalOverlayが両盤面ぶん描画されている(合計2+1=3合法手のセルに数値が入る)。
    const overlayCells = container.querySelectorAll('.move-eval-overlay__value')
    expect(overlayCells.length).toBe(3)

    const stubBoards = container.querySelectorAll('[data-testid="stub-board"]')
    expect(stubBoards.length).toBe(2)
    expect(stubBoards[0]?.getAttribute('data-last-move')).toBe(String(notationToSquare('a2')))
    expect(stubBoards[1]?.getAttribute('data-last-move')).toBe(String(notationToSquare('h7')))

    // `onContinue`未指定なら「続ける」ボタンは描画されない(結果画面での静的表示、要件5)。
    expect(container.querySelector('.two-ply-compare__continue')).toBeNull()
  })

  it('`onContinue`指定時のみ「続ける」ボタンを描画し、クリックでコールバックを呼ぶ', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const compare: TwoPlyCompareResult = {
      played: okBranch(board, notationToSquare('g6'), notationToSquare('a2'), []),
      best: okBranch(board, notationToSquare('b1'), notationToSquare('h7'), []),
    }
    const onContinue = vi.fn()

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
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
      board,
      ownSquare: notationToSquare('g6'),
      opponentSquare: notationToSquare('a2'),
      opponentPassed: false,
    }
    const okBranchValue = okBranch(board, notationToSquare('b1'), notationToSquare('h7'), [
      { move: 'e3', score: 100, discDiff: 1, type: 'midgame' },
    ])
    const compare: TwoPlyCompareResult = { played: selfPassBranch, best: okBranchValue }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
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
    // 自分パス側の盤面にはMoveEvalOverlayのセル評価値が無い(合法手が無いため描画しない)。
    const overlayCells = container.querySelectorAll('.move-eval-overlay__value')
    expect(overlayCells.length).toBe(1) // best側の1件のみ。
  })

  it('真の終局(kind: ended)は合法手オーバーレイ無しで「終局」を表示する', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const endedBranch: TwoPlyBranchResult = {
      kind: 'ended',
      board,
      ownSquare: notationToSquare('g6'),
      opponentSquare: null,
      opponentPassed: false,
      finalDiscDiff: 5,
    }
    const compare: TwoPlyCompareResult = {
      played: endedBranch,
      best: okBranch(board, notationToSquare('b1'), notationToSquare('h7'), []),
    }

    const { TwoPlyCompare } = await import('./TwoPlyCompare.tsx')
    await act(async () => {
      render(
        <TwoPlyCompare
          mover="black"
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
    expect(container.querySelectorAll('.move-eval-overlay__value').length).toBe(0)
  })

  it('補足パターン(最大2件)を渡すと言語化文がリスト表示される(廃止していない、要件3)', async () => {
    const board = createBoard([notationToSquare('a1')], [])
    const compare: TwoPlyCompareResult = {
      played: okBranch(board, notationToSquare('g6'), notationToSquare('a2'), []),
      best: okBranch(board, notationToSquare('b1'), notationToSquare('h7'), []),
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

// @vitest-environment jsdom
/**
 * T128要件3のコンポーネントテスト: 失敗画面の「1手先対比」表示
 * (`ClearBlunderCompare.tsx`)が、盤面2枚(「あなたの手のあと」「最善手の
 * あと」)と検出パターンの言語化文を描画すること、および
 * `detectClearBlunderPatterns`(`clearBlunder.ts`)からの実出力を渡した場合に
 * 「明確パターン2件が上限」であることを確認する。
 *
 * `Board`(Canvas描画)は本テストの関心事ではないため、他のPracticeMode系
 * テストと同じ方針でスタブ化する(盤面の石の色分布を`data-*`属性で覗ける
 * ようにし、「あなたの手のあと」「最善手のあと」で異なる盤面が渡っている
 * ことも確認できるようにする)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoard, notationToSquare, type Board as BoardState } from '../game/othello.ts'
import type { FeatureSet } from '../analysis/types.ts'
import { detectClearBlunderPatterns, type ClearBlunderInput } from './clearBlunder.ts'

vi.mock('../components/Board.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Board: (props: any) => (
    <div data-testid="stub-board" data-black={props.board.black.toString()} data-white={props.board.white.toString()}>
      board
    </div>
  ),
}))

function baseFeatures(overrides: Partial<FeatureSet> = {}): FeatureSet {
  return {
    mobilityDiff: 0,
    moverMobilityBefore: 4,
    opponentMobilityBefore: 4,
    opponentMobilityAfter: 4,
    moverMobilityAfter: 4,
    potentialMobilityDiff: 0,
    openness: 1,
    isUchiwari: true,
    frontierDiff: 0,
    newOpponentMoves: [],
    lostOwnMoves: [],
    stableDiff: 0,
    edgeShapes: [
      { edge: 'top', shape: 'open', emptyCount: 4 },
      { edge: 'bottom', shape: 'open', emptyCount: 4 },
      { edge: 'left', shape: 'open', emptyCount: 4 },
      { edge: 'right', shape: 'open', emptyCount: 4 },
    ],
    cornerRisk: null,
    parityRegions: [],
    seedStones: [],
    lines: [
      { name: 'main_diagonal', mover: 0, opponent: 0, empty: 8 },
      { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
    ],
    ...overrides,
  }
}

describe('midgame/ClearBlunderCompare', () => {
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

  it('盤面2枚(あなたの手のあと/最善手のあと)+検出パターンの言語化文を描画し、パターンは最大2件を超えない', async () => {
    // `clearBlunder.test.ts`の「複数検出時は影響の大きい順に最大2件」テストと同じ局面:
    // 黒: c1, b3, f3 / 白: d1, b2, f4。黒がb1に着手すると corner-gift(隅を失う)
    // と x-c-danger(b1は隅a1に対するC打ち)の両方が同時に検出される
    // (scratchpadで`clearBlunder.ts`を直接実行して事前確認済み)。
    const preMoveBoard: BoardState = createBoard(
      [notationToSquare('c1'), notationToSquare('b3'), notationToSquare('f3')],
      [notationToSquare('d1'), notationToSquare('b2'), notationToSquare('f4')],
    )
    const input: ClearBlunderInput = {
      preMoveBoard,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b1'),
      bestSquare: notationToSquare('f5'),
      playedFeatures: baseFeatures(),
      bestFeatures: baseFeatures(),
    }
    const patterns = detectClearBlunderPatterns(input)
    expect(patterns).not.toBeNull()
    expect(patterns!.length).toBe(2)

    const { ClearBlunderCompare } = await import('./ClearBlunderCompare.tsx')
    await act(async () => {
      render(
        <ClearBlunderCompare
          opponentSide="white"
          boardAfterPlayed={createBoard([notationToSquare('a1')], [])}
          boardAfterBest={createBoard([], [notationToSquare('h8')])}
          playedSquare={notationToSquare('b1')}
          bestSquare={notationToSquare('f5')}
          patterns={patterns!}
        />,
        container,
      )
    })

    // 盤面2枚(ラベルで判別)。
    const text = container.textContent ?? ''
    expect(text).toContain('あなたの手のあと')
    expect(text).toContain('最善手のあと')

    const stubBoards = container.querySelectorAll('[data-testid="stub-board"]')
    expect(stubBoards.length).toBe(2)
    // 2枚は異なる盤面(それぞれboardAfterPlayed/boardAfterBest)が渡っている。
    expect(stubBoards[0]?.getAttribute('data-black')).not.toBe(stubBoards[1]?.getAttribute('data-black'))

    // 検出パターンの言語化文(要件1のテンプレ文言そのまま、専門用語を使わない平易な日本語)。
    const messageItems = container.querySelectorAll('.clear-blunder-compare__messages li')
    expect(messageItems.length).toBe(2)
    expect(text).toContain('この手だと相手に隅(a1)を取られます。最善手なら取られませんでした。')
    expect(text).toContain('隅がまだ空いているのに、その隣(C)に打つと隅を取られやすくなります。')
  })

  it('検出パターンが1件のみでも盤面2枚+その1件の言語化文を描画する', async () => {
    const { ClearBlunderCompare } = await import('./ClearBlunderCompare.tsx')
    const onePattern = [
      {
        id: 'wall-frontier' as const,
        message: 'この手は自分の石を外側にさらします(壁)。相手から攻めやすい形です。',
        severity: 5,
        playedHighlightSquares: [notationToSquare('h4')],
        bestHighlightSquares: [notationToSquare('a5')],
      },
    ]
    await act(async () => {
      render(
        <ClearBlunderCompare
          opponentSide="white"
          boardAfterPlayed={createBoard([notationToSquare('a1')], [])}
          boardAfterBest={createBoard([], [notationToSquare('h8')])}
          playedSquare={notationToSquare('h4')}
          bestSquare={notationToSquare('a5')}
          patterns={onePattern}
        />,
        container,
      )
    })

    expect(container.querySelectorAll('[data-testid="stub-board"]').length).toBe(2)
    const messageItems = container.querySelectorAll('.clear-blunder-compare__messages li')
    expect(messageItems.length).toBe(1)
    expect(container.textContent).toContain('この手は自分の石を外側にさらします(壁)。相手から攻めやすい形です。')
  })
})

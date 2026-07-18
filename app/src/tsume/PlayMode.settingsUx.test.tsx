// @vitest-environment jsdom
/**
 * T137要件2・3のコンポーネントテスト: 詰めオセロの設定画面・ステージ一覧の
 * 磨き込み。
 * 1. 「難易度で選ぶ」が空きマス数帯+クリア数を持つカードになっていること(要件2)。
 * 2. ステージ一覧に「クリア x/N」サマリと進捗バーが表示され、クリア済み数に
 *    応じて値が追従すること(要件3)。
 *
 * Board/エンジンは他の`tsume/PlayMode.*.test.tsx`と同じ方針でモックする
 * (設定画面・ステージ一覧はいずれもエンジン呼び出しを伴わない)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bigintToHex } from '../engine/hex.ts'
import { initialBoard } from '../game/othello.ts'
import { PlayMode } from './PlayMode.tsx'
import { recordStageAttempt } from './stageProgress.ts'
import type { Puzzle, PuzzleFile } from './types.ts'

vi.mock('../components/Board.tsx', () => ({
  Board: () => <button type="button" data-testid="stub-board" />,
}))

function makePuzzle(id: string, difficulty: Puzzle['difficulty'], empties: number): Puzzle {
  const board = initialBoard()
  return {
    id,
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    sideToMove: 'black',
    empties,
    correctMoves: ['f5'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty,
    difficultyRawScore: 0,
    tags: [],
  }
}

// 難易度1: 2問(空き6〜10)。難易度2: 1問(空き15)。難易度3〜5: 0問。
const POOL: Puzzle[] = [
  makePuzzle('tsume-1', 1, 10),
  makePuzzle('tsume-2', 1, 6),
  makePuzzle('tsume-3', 2, 15),
]

vi.mock('./loadPuzzles.ts', () => ({
  loadPuzzles: () => Promise.resolve<PuzzleFile>({ generatedAt: '2026-07-18T00:00:00.000Z', puzzles: POOL }),
}))

async function flushAsyncEffects(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function findButton(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) => btn.textContent === text)
}

describe('T137要件2・3: 詰めオセロの設定画面・ステージ一覧', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('難易度カードに空きマス数帯とクリア数が表示され、該当問題が無い難易度は「問題なし」になる', async () => {
    await act(async () => {
      render(<PlayMode />, container)
    })
    await flushAsyncEffects()

    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>('.tsume-difficulty-card'))
    expect(cards.length).toBe(5)

    const level1 = cards.find((c) => c.textContent?.includes('難易度1'))!
    expect(level1.textContent).toContain('空き6〜10マス')
    expect(level1.textContent).toContain('クリア 0/2')

    const level2 = cards.find((c) => c.textContent?.includes('難易度2'))!
    expect(level2.textContent).toContain('空き15〜15マス')
    expect(level2.textContent).toContain('クリア 0/1')

    const level3 = cards.find((c) => c.textContent?.includes('難易度3'))!
    expect(level3.textContent).toContain('問題なし')
  })

  it('クリア済み問題があれば難易度カードのクリア数に反映される', async () => {
    recordStageAttempt(localStorage, 'tsume-1', 'clear')

    await act(async () => {
      render(<PlayMode />, container)
    })
    await flushAsyncEffects()

    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>('.tsume-difficulty-card'))
    const level1 = cards.find((c) => c.textContent?.includes('難易度1'))!
    expect(level1.textContent).toContain('クリア 1/2')
  })

  it('ステージ一覧に「クリア x/N」サマリと進捗バーが表示され、クリア済み数に応じて値が変わる', async () => {
    recordStageAttempt(localStorage, 'tsume-2', 'clear')

    await act(async () => {
      render(<PlayMode />, container)
    })
    await flushAsyncEffects()
    await act(async () => {
      findButton(container, 'ステージ一覧')?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.tsume-stage-select__summary-text')?.textContent).toBe('クリア 1/3')
    const bar = container.querySelector('.tsume-stage-select__progress-bar')
    expect(bar?.getAttribute('aria-valuenow')).toBe('1')
    expect(bar?.getAttribute('aria-valuemax')).toBe('3')
    const fill = container.querySelector<HTMLDivElement>('.tsume-stage-select__progress-fill')
    // 1/3 ≈ 33.33...%
    expect(fill?.style.width).toMatch(/^33\.3+%$/)
  })
})

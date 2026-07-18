// @vitest-environment jsdom
/**
 * T130: 詰めオセロステージ一覧の復習フィルタ(すべて/未挑戦/失敗あり/未クリア/
 * クリア済み)が`localStorage`の挑戦記録(`stageProgress.ts`)どおりに絞り込み、
 * 選択が`localStorage`へ永続化され次回起動時も保持されることを検証する。
 *
 * モック方針は`PlayMode.stageProgressTiming.test.tsx`(T117 redo #1)と同じ
 * (Board/engine/loadPuzzlesをスタブ化)。ステージ一覧のクリック挙動・状態
 * (`stageStatus`)自体はT117で検証済みのため、本テストではフィルタの絞り込み
 * ・永続化のみを対象にする(セッションを開始しての対局は行わない)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bigintToHex } from '../engine/hex.ts'
import { createBoard, type Side } from '../game/othello.ts'
import { TSUME_REVIEW_FILTER_STORAGE_KEY } from '../settings/reviewFilter.ts'
import { TSUME_STAGE_PROGRESS_STORAGE_KEY, type StageProgress } from './stageProgress.ts'
import type { Puzzle, PuzzleFile } from './types.ts'

vi.mock('../components/Board.tsx', () => ({
  Board: () => (
    <button type="button" data-testid="stub-board">
      board
    </button>
  ),
}))

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: () => Promise.reject(new Error('T130テストでは使用しない')),
    requestAnalyze: () => Promise.reject(new Error('T130テストでは使用しない')),
    terminate: () => {},
  }),
}))

function makePuzzle(id: string): Puzzle {
  const board = createBoard([], [])
  const side: Side = 'black'
  return {
    id,
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    sideToMove: side,
    empties: 60,
    correctMoves: ['d3'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty: 1,
    difficultyRawScore: 0,
    tags: [],
  }
}

/**
 * ステージ1〜4(pool内0-indexedで p1〜p4)に、フィルタ5種を書き分けるための
 * 挑戦記録:
 * - p1: 記録なし -> 未挑戦
 * - p2: 失敗1回・クリアなし -> 挑戦済み未クリア、失敗あり
 * - p3: クリア1回・失敗なし -> クリア済み、失敗なし
 * - p4: クリア1回・失敗2回 -> クリア済みだが失敗経験あり(「失敗あり」フィルタにも一致する)
 */
function makeProgress(): StageProgress {
  const now = '2026-07-18T00:00:00.000Z'
  return {
    p2: { firstClearedAt: null, lastClearedAt: null, clearCount: 0, failCount: 1, lastAttemptAt: now, lastResult: 'fail' },
    p3: { firstClearedAt: now, lastClearedAt: now, clearCount: 1, failCount: 0, lastAttemptAt: now, lastResult: 'clear' },
    p4: { firstClearedAt: now, lastClearedAt: now, clearCount: 1, failCount: 2, lastAttemptAt: now, lastResult: 'clear' },
  }
}

vi.mock('./loadPuzzles.ts', () => ({
  loadPuzzles: () =>
    Promise.resolve<PuzzleFile>({
      generatedAt: '2026-07-18T00:00:00.000Z',
      puzzles: ['p1', 'p2', 'p3', 'p4'].map((id) => makePuzzle(id)),
    }),
}))

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** 設定画面 → ステージ一覧まで進める共通手順。 */
async function enterStageSelect(container: HTMLDivElement): Promise<void> {
  const { PlayMode } = await import('./PlayMode.tsx')
  await act(async () => {
    render(<PlayMode />, container)
  })
  await flushAsyncEffects()

  const stageListButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
    btn.textContent?.includes('ステージ一覧'),
  )
  expect(stageListButton).toBeDefined()
  await act(async () => {
    stageListButton?.click()
  })
  await flushAsyncEffects()

  expect(container.querySelector('.tsume-stage-select')).not.toBeNull()
}

function clickFilter(container: HTMLDivElement, label: string): void {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.tsume-stage-select__filter-button'),
  ).find((btn) => btn.textContent === label)
  expect(button).toBeDefined()
  button?.click()
}

function gridNumbers(container: HTMLDivElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tsume-stage-grid__number'))
    .map((el) => el.textContent ?? '')
    .sort()
}

describe('T130: 詰めオセロステージ一覧の復習フィルタ', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(TSUME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(makeProgress()))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('フィルタ5種それぞれで、表示されるステージ番号が記録どおりになる', async () => {
    await enterStageSelect(container)

    // 既定は「すべて」: 4問すべて表示。
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])

    await act(async () => clickFilter(container, '未挑戦'))
    expect(gridNumbers(container)).toEqual(['1'])

    await act(async () => clickFilter(container, '失敗あり'))
    expect(gridNumbers(container)).toEqual(['2', '4'])

    await act(async () => clickFilter(container, '未クリア'))
    expect(gridNumbers(container)).toEqual(['1', '2'])

    await act(async () => clickFilter(container, 'クリア済み'))
    expect(gridNumbers(container)).toEqual(['3', '4'])

    await act(async () => clickFilter(container, 'すべて'))
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])
  })

  it('該当0件のとき、グリッドの代わりに空表示メッセージを出す', async () => {
    // p1(未挑戦)のみ記録を消して、「未挑戦」フィルタが0件になるようにする。
    localStorage.setItem(
      TSUME_STAGE_PROGRESS_STORAGE_KEY,
      JSON.stringify({
        p1: { firstClearedAt: '2026-07-18T00:00:00.000Z', lastClearedAt: '2026-07-18T00:00:00.000Z', clearCount: 1, failCount: 0, lastAttemptAt: '2026-07-18T00:00:00.000Z', lastResult: 'clear' },
        p2: { firstClearedAt: '2026-07-18T00:00:00.000Z', lastClearedAt: '2026-07-18T00:00:00.000Z', clearCount: 1, failCount: 0, lastAttemptAt: '2026-07-18T00:00:00.000Z', lastResult: 'clear' },
        p3: { firstClearedAt: '2026-07-18T00:00:00.000Z', lastClearedAt: '2026-07-18T00:00:00.000Z', clearCount: 1, failCount: 0, lastAttemptAt: '2026-07-18T00:00:00.000Z', lastResult: 'clear' },
        p4: { firstClearedAt: '2026-07-18T00:00:00.000Z', lastClearedAt: '2026-07-18T00:00:00.000Z', clearCount: 1, failCount: 0, lastAttemptAt: '2026-07-18T00:00:00.000Z', lastResult: 'clear' },
      } satisfies StageProgress),
    )

    await enterStageSelect(container)
    await act(async () => clickFilter(container, '未挑戦'))

    expect(container.querySelector('.tsume-stage-grid')).toBeNull()
    const empty = container.querySelector('.tsume-stage-select__empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('条件に一致する問題がありません')
  })

  it('フィルタ選択はlocalStorageへ永続化され、再マウント後も保持される', async () => {
    await enterStageSelect(container)
    await act(async () => clickFilter(container, 'クリア済み'))

    expect(localStorage.getItem(TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(JSON.stringify('cleared'))
    expect(gridNumbers(container)).toEqual(['3', '4'])

    // 「再マウント」でアプリ再起動をシミュレートする。
    render(null, container)
    await enterStageSelect(container)

    // 既定の「すべて」に戻らず、直前に選んだ「クリア済み」のまま4問中2問だけが表示される。
    expect(gridNumbers(container)).toEqual(['3', '4'])
    const activeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.tsume-stage-select__filter-button'),
    ).find((btn) => btn.textContent === 'クリア済み')
    expect(activeButton?.classList.contains('tsume-stage-select__filter-button--active')).toBe(true)
  })
})

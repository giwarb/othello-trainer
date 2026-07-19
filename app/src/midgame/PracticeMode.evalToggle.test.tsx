// @vitest-environment jsdom
/**
 * T142: 中盤練習「候補手評価を表示」トグルの復活。
 *
 * - 既定はON(要件1): 初回(localStorage未保存)は候補手評価オーバーレイが表示される。
 * - OFFにすると盤上のオーバーレイだけが消え、評価バーは表示され続ける(要件1)。
 * - OFFでも★判定・相手応手は通常どおり動作する(要件2、表示だけの切り替え)。
 * - 設定は`localStorage`に永続化され、再マウント後も保持される(要件1)。
 *
 * モック方針は`PracticeMode.flow.test.tsx`を踏襲する(Boardスタブ・
 * 決定的な評価値を返すエンジンモック・定石DBモック)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { legalMoves, squareToNotation, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import { MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY } from '../settings/moveEvalOverlaySettings.ts'
import { MIDGAME_STAGE_STARS_STORAGE_KEY } from './stageProgress.ts'

/** 現局面の全合法手をnotationラベル付きボタンとして描画するBoardスタブ(`PracticeMode.flow.test.tsx`と同一方式)。 */
vi.mock('../components/Board.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Board: (props: any) => {
    const board = props.board as Board
    const side = props.sideToMove as Side
    const moves = legalMoves(board, side)
    return (
      <div data-testid="stub-board">
        {moves.map((sq) => (
          <button
            key={sq}
            type="button"
            data-testid={`move-${squareToNotation(sq)}`}
            onClick={() => props.onMove?.(sq)}
          >
            {squareToNotation(sq)}
          </button>
        ))}
      </div>
    )
  },
}))

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () =>
    Promise.resolve(buildJosekiDb([{ name: 'ダミーライン', aliases: [], moves: ['f5'], firstMoveBasis: 'f5', depth: 1 }])),
  lookupJosekiNode: () => null,
}))

/** 全合法手を評価値0で並べる(全手「同点最善」扱い、`PracticeMode.flow.test.tsx`と同一)。 */
function neutralMoves(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => ({ move: squareToNotation(square), score: 0, discDiff: 0, type: 'midgame' }))
}

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => Promise.resolve(neutralMoves(board, side)),
    requestFeatureSet: () => Promise.reject(new Error('T142トグルテストでは使用しない')),
    requestAnalyze: () => Promise.reject(new Error('T142トグルテストでは使用しない')),
    requestEvalTerms: () => Promise.reject(new Error('T142トグルテストでは使用しない')),
    terminate: () => {},
  }),
}))

async function flushAsyncEffects(rounds = 20, delayMs = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    })
  }
}

function clickFirstMove(container: HTMLDivElement): void {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid^="move-"]')
  expect(btn).not.toBeNull()
  btn?.click()
}

async function startFirstStage(container: HTMLDivElement): Promise<void> {
  const { PracticeMode } = await import('./PracticeMode.tsx')
  await act(async () => {
    render(<PracticeMode />, container)
  })
  await flushAsyncEffects()

  const stageCell = container.querySelector<HTMLButtonElement>('.midgame-stage-grid__cell')
  expect(stageCell).not.toBeNull()
  await act(async () => {
    stageCell?.click()
  })
  await flushAsyncEffects()
  expect(container.querySelector('.midgame-practice')).not.toBeNull()
}

describe('T142: 中盤練習の候補手評価表示トグル', () => {
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

  it('既定ON: 初回起動時は候補手評価オーバーレイが表示され、チェックボックスもONになっている', async () => {
    await startFirstStage(container)

    const checkbox = container.querySelector<HTMLInputElement>('.move-eval-overlay-toggle input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.checked).toBe(true)
    expect(container.querySelector('.move-eval-overlay')).not.toBeNull()
  })

  it('OFFに切り替えると盤上のオーバーレイは消えるが、評価バーは表示され続ける', async () => {
    await startFirstStage(container)

    // 評価バーは1手目の解析完了後に表示される(既存の`evalBarValue !== null`条件)。
    expect(container.querySelector('.midgame-eval-bar-panel')).not.toBeNull()

    const checkbox = container.querySelector<HTMLInputElement>('.move-eval-overlay-toggle input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    await act(async () => {
      checkbox!.checked = false
      checkbox!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushAsyncEffects(1, 0)

    expect(container.querySelector('.move-eval-overlay')).toBeNull()
    expect(container.querySelector('.midgame-eval-bar-panel')).not.toBeNull()
  })

  it('OFFでも★判定・相手応手は正常に動作する(3往復完走してクリア判定できる)', async () => {
    await startFirstStage(container)

    const checkbox = container.querySelector<HTMLInputElement>('.move-eval-overlay-toggle input[type="checkbox"]')
    await act(async () => {
      checkbox!.checked = false
      checkbox!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushAsyncEffects(1, 0)

    for (let round = 0; round < 3; round += 1) {
      await act(async () => clickFirstMove(container))
      await flushAsyncEffects()
    }

    expect(container.querySelector('.midgame-result')).not.toBeNull()
    expect(container.querySelector('.midgame-result--clear')).not.toBeNull()
    expect(container.querySelector('.midgame-result__stars')?.textContent).toBe('★★★')

    const raw = localStorage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const progress = JSON.parse(raw!)
    const entries = Object.values(progress) as Array<{ bestStars: number; attempts: number }>
    expect(entries.length).toBe(1)
    expect(entries[0]?.bestStars).toBe(3)
  })

  it('OFFにした設定はlocalStorageへ永続化され、再マウント後も保持される', async () => {
    await startFirstStage(container)

    const checkbox = container.querySelector<HTMLInputElement>('.move-eval-overlay-toggle input[type="checkbox"]')
    await act(async () => {
      checkbox!.checked = false
      checkbox!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushAsyncEffects(1, 0)

    expect(localStorage.getItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY)).toBe('false')

    // アンマウントして再マウント(リロードのシミュレーション)。
    render(null, container)
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)

    await startFirstStage(container)
    const reloadedCheckbox = container.querySelector<HTMLInputElement>('.move-eval-overlay-toggle input[type="checkbox"]')
    expect(reloadedCheckbox?.checked).toBe(false)
    expect(container.querySelector('.move-eval-overlay')).toBeNull()
  })
})

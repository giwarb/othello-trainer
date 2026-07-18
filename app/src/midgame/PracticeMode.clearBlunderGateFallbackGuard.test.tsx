// @vitest-environment jsdom
/**
 * T128b回帰テスト(codex-review指摘・中1、
 * `tasks/review/T128-clear-blunder-claude-review.md`観点1): ゲート
 * (`handlePlayerMove`内の`detectClearBlunderPatterns`判定)のための
 * `requestFeatureSet`(`Promise.all`)がエラーで拒否された場合のフォールバック
 * 経路(`catch`節)で、`sessionGenerationRef`の世代チェックが欠けていた
 * (T119で対処したのと同型のstale書き込みバグ)。
 *
 * 検証方法: `requestFeatureSet`を「意図的に解決/拒否しないPromise」に差し替え、
 * ゲート判定中(`Promise.all`のawaitで止まっている間)に「やめる」を押して
 * 設定画面へ離脱し、その後で`requestFeatureSet`を拒否させる。この時点で
 * `localStorage`にステージ記録(不合格)が書き込まれておらず、画面も
 * 失敗結果画面へ遷移していないことを確認する(修正前のコードでは、離脱後に
 * `requestFeatureSet`が拒否されると`handleModeFailure`が無条件に呼ばれ、
 * `recordStageAttemptNow(stageKey, 'fail')`がlocalStorageに書き込まれて
 * しまっていた)。
 *
 * モック方針・局面設計は`PracticeMode.clearBlunderGate.test.tsx`(T128)・
 * `PracticeMode.staleSession.test.tsx`(T119 redo #1)と同じ。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureSetResponseMessage, MoveEvalJson } from '../engine/types.ts'
import { applyMove, initialBoard, legalMoves, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_STAGE_PROGRESS_STORAGE_KEY } from './stageProgress.ts'

vi.mock('../components/Board.tsx', () => {
  function sq(notation: string): number {
    const file = notation.charCodeAt(0) - 97
    const rank0 = notation.charCodeAt(1) - 49
    return rank0 * 8 + file
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Board: (props: any) => (
      <div data-testid="stub-board">
        {['c1', 'd1'].map((n) => (
          <button key={n} type="button" data-testid={`move-${n}`} onClick={() => props.onMove?.(sq(n))}>
            {n}
          </button>
        ))}
      </div>
    ),
  }
})

/** `PracticeMode.clearBlunderGate.test.tsx`と同じ局面(初期局面から12手、黒番)。 */
const SEQ = ['f5', 'f4', 'c3', 'c4', 'd3', 'f6', 'b3', 'd6', 'g4', 'c2', 'e2', 'h4']

function boardAfterSequence(moves: readonly string[]): { board: Board; side: Side } {
  let board: Board = initialBoard()
  let side: Side = 'black'
  for (const mv of moves) {
    board = applyMove(board, side, notationToSquare(mv))
    side = opposite(side)
  }
  return { board, side }
}

const { board: DECISION_BOARD, side: DECISION_SIDE } = boardAfterSequence(SEQ)

const SYNTHETIC_LINE: RawJosekiLine = {
  name: 'T128bフォールバックテスト用ライン',
  aliases: [],
  moves: SEQ,
  firstMoveBasis: SEQ[0]!,
  depth: SEQ.length,
}

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(buildJosekiDb([SYNTHETIC_LINE])),
  lookupJosekiNode: () => null,
}))

function isDecisionBoard(board: Board, side: Side): boolean {
  return board.black === DECISION_BOARD.black && board.white === DECISION_BOARD.white && side === DECISION_SIDE
}

function squareNotation(square: number): string {
  const file = square % 8
  const rank0 = Math.floor(square / 8)
  return `${String.fromCharCode(97 + file)}${rank0 + 1}`
}

/** `requestFeatureSet`を意図的に解決/拒否しないPromiseに差し替えるための手動resolver群。 */
let pendingFeatureSetRejects: Array<(error: unknown) => void> = []

function rejectAllPendingFeatureSets(error: unknown): void {
  const rejecters = pendingFeatureSetRejects
  pendingFeatureSetRejects = []
  rejecters.forEach((reject) => reject(error))
}

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      if (isDecisionBoard(board, side)) {
        // 決定局面: d1を最善手(discDiff5)、c1を明確な劣着(discDiff0)にし、
        // 評価値ベースの判定が必ず不合格(ゲート発動)になるようにする。
        const moves: MoveEvalJson[] = legalMoves(board, side).map((square) => {
          const notation = squareNotation(square)
          const discDiff = notation === 'd1' ? 5 : 0
          return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
        })
        return Promise.resolve(moves)
      }
      const moves: MoveEvalJson[] = legalMoves(board, side).map((square) => ({
        move: squareNotation(square),
        score: 0,
        discDiff: 0,
        type: 'midgame',
      }))
      return Promise.resolve(moves)
    },
    // ゲート判定用の特徴量取得を意図的に保留する(離脱後に`rejectAllPendingFeatureSets`で拒否させる)。
    requestFeatureSet: (): Promise<FeatureSetResponseMessage> =>
      new Promise<FeatureSetResponseMessage>((_resolve, reject) => {
        pendingFeatureSetRejects.push(reject)
      }),
    requestAnalyze: () => Promise.reject(new Error('T128bフォールバックテストでは使用しない(handleModeFailureのcatch経路には比較PV取得まで到達しないはず)')),
    requestEvalTerms: () => Promise.reject(new Error('T128bフォールバックテストでは使用しない')),
    terminate: () => {},
  }),
}))

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T128b: ゲートのrequestFeatureSet拒否フォールバックは離脱後の世代チェックを守る', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    pendingFeatureSetRejects = []
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    // 未解決のまま残ったPromiseを片付ける。
    rejectAllPendingFeatureSets(new Error('afterEach cleanup'))
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('ゲート判定中(requestFeatureSet待ち)に離脱し、その後requestFeatureSetが拒否されても、ステージ記録に不合格が書き込まれず結果画面へも遷移しない', async () => {
    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
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

    const stageCell = container.querySelector<HTMLButtonElement>('.midgame-stage-grid__cell')
    expect(stageCell).not.toBeNull()
    await act(async () => {
      stageCell?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.midgame-practice')).not.toBeNull()

    // 「最善手ではない」c1をクリックする。評価値判定は不合格になり、
    // ゲートのrequestFeatureSet(x2)が呼ばれた時点でPromiseが保留される。
    const c1Button = container.querySelector<HTMLButtonElement>('[data-testid="move-c1"]')
    expect(c1Button).not.toBeNull()
    await act(async () => {
      c1Button?.click()
    })
    await flushAsyncEffects(5)

    // ゲート判定中(requestFeatureSetの応答待ち)であることを確認する。
    expect(pendingFeatureSetRejects.length).toBeGreaterThan(0)
    expect(container.querySelector('.midgame-practice')).not.toBeNull()

    // ゲート判定中に「やめる」を押して設定画面へ戻る(離脱)。
    const quitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'やめる',
    )
    expect(quitButton).toBeDefined()
    await act(async () => {
      quitButton?.click()
    })
    await flushAsyncEffects()

    expect(container.textContent).toContain('中盤練習モード: 条件を選んで開始してください')
    expect(localStorage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)).toBeNull()

    // 離脱後に、保留中のrequestFeatureSetを拒否させる(修正前のバグ再現条件)。
    await act(async () => {
      rejectAllPendingFeatureSets(new Error('離脱後のエンジンエラー(意図的)'))
    })
    await flushAsyncEffects()

    // 本題: 離脱後にrequestFeatureSetが拒否されても、ステージ記録は書き込まれない。
    expect(localStorage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)).toBeNull()
    // 失敗結果画面にも遷移しない。設定画面に留まったまま。
    expect(container.querySelector('.midgame-result')).toBeNull()
    expect(container.querySelector('.midgame-result--fail')).toBeNull()
    expect(container.textContent).toContain('中盤練習モード: 条件を選んで開始してください')
  })
})

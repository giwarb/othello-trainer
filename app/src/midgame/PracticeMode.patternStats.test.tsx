// @vitest-environment jsdom
/**
 * T129回帰テスト: 中盤練習で失敗画面に至ったとき、検出された明確な悪化パターン
 * (`clearBlunder.ts`)の全パターンID(表示上限2件でなく検出全件、要件1)が
 * `localStorage`(`patternStats.ts`)へ記録され、設定画面に「苦手パターン」
 * として表示・リセットできる(要件2・3)ことを固定する。
 *
 * モック方針・局面設計は`PracticeMode.clearBlunderGate.test.tsx`(T128)・
 * `PracticeMode.clearBlunderGateFallbackGuard.test.tsx`(T128b)と同じ。
 * 「複数パターン同時検出」の局面は`clearBlunder.test.ts`の
 * opponent-mobility陽性ケース(初期局面から12手進めた局面、g6:白10か所 vs
 * b1:白5か所、差5→opponent-mobility検出)をそのまま再利用し、
 * `requestFeatureSet`の応答をown-mobility-collapse・stable-lossも同時に
 * 検出されるよう上書きする(`clearBlunder.test.ts`の
 * 「detectAllClearBlunderPatternsは表示上限を超えても全件を返す」テストと
 * 同じ組み合わせ)。これにより「表示は上位2件(opponent-mobility・
 * own-mobility-collapse)まで、記録は3件とも」という要件1の核心を検証できる。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureSetJson, FeatureSetResponseMessage, MoveEvalJson } from '../engine/types.ts'
import { applyMove, initialBoard, legalMoves, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_PATTERN_STATS_STORAGE_KEY } from './patternStats.ts'

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
        {['c1', 'd1', 'g6', 'b1'].map((n) => (
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
  name: 'T129テスト用ライン',
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

/** 検出条件に関わらない「無害」な`FeatureSetJson`(`clearBlunder.test.ts`の`baseFeatures`と同じ既定値)。 */
function neutralFeatures(overrides: Partial<FeatureSetJson> = {}): FeatureSetJson {
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

/** どの決定局面用のシナリオを使うかを切り替える(`bestMoveNotation`のdiscDiffのみ高くする)。 */
let bestMoveNotation = 'd1'
/** `requestFeatureSet(move)`ごとに返す`FeatureSetJson`の上書き(未指定なら`neutralFeatures()`)。 */
let featureOverridesByMove: Record<string, Partial<FeatureSetJson>> = {}
/** trueの間、`requestFeatureSet`は解決も拒否もしないPromiseを返す(世代ガードテスト用)。 */
let holdFeatureSetResolution = false
let pendingFeatureSetResolvers: Array<(resp: FeatureSetResponseMessage) => void> = []

function resolveAllPendingFeatureSets(): void {
  const resolvers = pendingFeatureSetResolvers
  pendingFeatureSetResolvers = []
  resolvers.forEach((resolve) => resolve({ id: 0, final: true, features: neutralFeatures() }))
}

const requestFeatureSetSpy = vi.fn()

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      if (isDecisionBoard(board, side)) {
        const moves: MoveEvalJson[] = legalMoves(board, side).map((square) => {
          const notation = squareNotation(square)
          const discDiff = notation === bestMoveNotation ? 5 : 0
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
    requestFeatureSet: (_board: Board, _side: Side, move: string): Promise<FeatureSetResponseMessage> => {
      requestFeatureSetSpy(move)
      if (holdFeatureSetResolution) {
        return new Promise<FeatureSetResponseMessage>((resolve) => {
          pendingFeatureSetResolvers.push(resolve)
        })
      }
      return Promise.resolve({ id: 0, final: true, features: neutralFeatures(featureOverridesByMove[move]) })
    },
    requestAnalyze: () => Promise.reject(new Error('T129テストでは使用しない(handleModeFailureの比較PV取得には到達しないはず)')),
    requestEvalTerms: () => Promise.reject(new Error('T129テストでは使用しない')),
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

/** 設定画面 → ステージ一覧 → 最初のステージへ進み、`.midgame-practice`が表示されるまで進める共通手順。 */
async function enterPracticeFromStageSelect(container: HTMLDivElement): Promise<void> {
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
}

describe('T129: 苦手パターン統計の記録', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    requestFeatureSetSpy.mockClear()
    bestMoveNotation = 'd1'
    featureOverridesByMove = {}
    holdFeatureSetResolution = false
    pendingFeatureSetResolvers = []
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    resolveAllPendingFeatureSets()
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('失敗時、表示は上位2件までだが記録は検出された全件(3件)を加算する', async () => {
    bestMoveNotation = 'b1'
    featureOverridesByMove = {
      g6: { moverMobilityAfter: 2, stableDiff: 0 },
      b1: { moverMobilityAfter: 6, stableDiff: 3 },
    }

    await enterPracticeFromStageSelect(container)

    const g6Button = container.querySelector<HTMLButtonElement>('[data-testid="move-g6"]')
    expect(g6Button).not.toBeNull()
    await act(async () => {
      g6Button?.click()
    })
    await flushAsyncEffects(20)

    // 失敗結果画面へ遷移していること(明確な悪化パターンが検出されたことの前提条件)。
    expect(container.querySelector('.midgame-result--fail')).not.toBeNull()

    const raw = localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const stats = JSON.parse(raw!)

    // 要件1の核心: 表示上限(2件)を超えて、検出された全パターン(3件)が加算されている。
    expect(stats['opponent-mobility']).toEqual({ failCount: 1, lastAt: expect.any(String) })
    expect(stats['own-mobility-collapse']).toEqual({ failCount: 1, lastAt: expect.any(String) })
    expect(stats['stable-loss']).toEqual({ failCount: 1, lastAt: expect.any(String) })
    expect(Object.keys(stats).length).toBe(3)
  })

  it('ゲートで合格扱い(明確な悪化パターンが1件も無い)になった手は統計に記録しない', async () => {
    bestMoveNotation = 'd1'
    featureOverridesByMove = {}

    await enterPracticeFromStageSelect(container)

    // 「最善手ではない」c1をクリックする(評価値ベースの判定は不合格になるが、
    // 明確な悪化パターンは無いため合格扱いになる、T128要件2)。
    const c1Button = container.querySelector<HTMLButtonElement>('[data-testid="move-c1"]')
    expect(c1Button).not.toBeNull()
    await act(async () => {
      c1Button?.click()
    })
    await flushAsyncEffects(20)

    expect(container.querySelector('.midgame-result--fail')).toBeNull()
    expect(localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)).toBeNull()
  })

  it('世代ガード: 判定待ち中に離脱すると、その後応答が返っても統計に記録されない', async () => {
    bestMoveNotation = 'b1'
    featureOverridesByMove = {
      g6: { moverMobilityAfter: 2, stableDiff: 0 },
      b1: { moverMobilityAfter: 6, stableDiff: 3 },
    }
    holdFeatureSetResolution = true

    await enterPracticeFromStageSelect(container)

    const g6Button = container.querySelector<HTMLButtonElement>('[data-testid="move-g6"]')
    expect(g6Button).not.toBeNull()
    await act(async () => {
      g6Button?.click()
    })
    await flushAsyncEffects(5)

    // ゲート判定中(requestFeatureSetの応答待ち)であることを確認する。
    expect(pendingFeatureSetResolvers.length).toBeGreaterThan(0)
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

    expect(localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)).toBeNull()

    // 離脱後に、保留中のrequestFeatureSetを解決させる(検出条件を満たす値で)。
    await act(async () => {
      resolveAllPendingFeatureSets()
    })
    await flushAsyncEffects()

    // 離脱後に応答が返っても、統計には一切記録されない(世代ガード)。
    expect(localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)).toBeNull()
    expect(container.querySelector('.midgame-result')).toBeNull()
  })
})

describe('T129: 苦手パターン統計の表示・リセット(設定画面)', () => {
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

  it('記録が無ければ「まだ記録がありません」と表示する', async () => {
    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    expect(container.textContent).toContain('苦手パターン')
    // T137要件1: 空状態の文言をアイコン付き説明文に刷新した(旧「まだ記録がありません」)。
    expect(container.textContent).toContain('失敗するとここに苦手パターンが貯まります')
  })

  it('failCount降順で最大5件を表示し、リセットボタンで消せる(確認つき)', async () => {
    localStorage.setItem(
      MIDGAME_PATTERN_STATS_STORAGE_KEY,
      JSON.stringify({
        'corner-gift': { failCount: 3, lastAt: '2026-07-10T00:00:00.000Z' },
        'x-c-danger': { failCount: 5, lastAt: '2026-07-11T00:00:00.000Z' },
        'wall-frontier': { failCount: 1, lastAt: '2026-07-12T00:00:00.000Z' },
        'stable-loss': { failCount: 4, lastAt: '2026-07-13T00:00:00.000Z' },
        'missed-corner': { failCount: 2, lastAt: '2026-07-14T00:00:00.000Z' },
        'opponent-pass-missed': { failCount: 6, lastAt: '2026-07-15T00:00:00.000Z' },
      }),
    )

    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    const list = container.querySelector('.midgame-pattern-stats__list')
    expect(list).not.toBeNull()
    const items = Array.from(list!.querySelectorAll('li')).map((li) => li.textContent)
    expect(items.length).toBe(5)
    // failCount降順(6,5,4,3,2)。6件目(wall-frontier、最小)は表示されない。
    expect(items[0]).toContain('相手のパスを逃す手')
    expect(items[0]).toContain('6回')
    expect(items[1]).toContain('X打ち・C打ち')
    expect(items[1]).toContain('5回')
    expect(container.textContent).not.toContain('壁を作る手')

    // リセットボタン(確認つき)。
    const resetButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '記録をリセット',
    )
    expect(resetButton).toBeDefined()
    await act(async () => {
      resetButton?.click()
    })
    await flushAsyncEffects()

    expect(container.textContent).toContain('本当にリセットしますか?')
    // まだ確定していないのでlocalStorageは変化しない。
    expect(localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)).not.toBeNull()

    const yesButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'はい',
    )
    expect(yesButton).toBeDefined()
    await act(async () => {
      yesButton?.click()
    })
    await flushAsyncEffects()

    // T137要件1: 空状態の文言をアイコン付き説明文に刷新した(旧「まだ記録がありません」)。
    expect(container.textContent).toContain('失敗するとここに苦手パターンが貯まります')
    expect(JSON.parse(localStorage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY) ?? '{}')).toEqual({})
  })
})

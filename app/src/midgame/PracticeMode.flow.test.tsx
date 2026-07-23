// @vitest-environment jsdom
/**
 * T141: 中盤練習「ステージクリア型」の主要プレイフロー(要件2・4・7)の
 * コンポーネントテスト。
 *
 * - ステージ選択 → 3往復(自分3手+相手3応手)完走 → 結果画面(★・損失一覧)。
 * - 3往復とも最善手 → ★3。
 * - 損失があり明確な悪化パターンが検出できる手がある → 結果画面に
 *   「あなたの手のあと」「最善手のあと」対比(`ClearBlunderCompare`)が表示される。
 * - 途中終局(打てる手なし)の打ち切り判定 → 打てたぶんの手数で★判定する。
 *
 * モック方針は`PracticeMode.staleSession.test.tsx`(3往復を決定的に進める手法)・
 * `PracticeMode.patternStats.test.tsx`(特定局面での`discDiff`差し替え・
 * `requestFeatureSet`によるパターン検出)を踏襲する。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureSetJson, FeatureSetResponseMessage, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  countDiscs,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board,
  type Side,
} from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import type { MidgameStage } from './stagePool.ts'
import { MIDGAME_STAGE_STARS_STORAGE_KEY } from './stageProgress.ts'

/** 現局面の全合法手をnotationラベル付きボタンとして描画するBoardスタブ(汎用、複数テストで共有)。 */
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

/** テストごとに`buildMidgameStagePool`の結果を差し替えられるようにする(要件「途中終局」の局面を人工的に注入するため)。 */
let stagePoolOverride: MidgameStage[] | null = null
vi.mock('./stagePool.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stagePool.ts')>()
  return {
    ...actual,
    buildMidgameStagePool: (db: Parameters<typeof actual.buildMidgameStagePool>[0]) =>
      stagePoolOverride ?? actual.buildMidgameStagePool(db),
  }
})

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(buildJosekiDb([{ name: 'ダミーライン', aliases: [], moves: ['f5'], firstMoveBasis: 'f5', depth: 1 }])),
  lookupJosekiNode: () => null,
}))

function boardAfterSequence(moves: readonly string[]): { board: Board; side: Side } {
  let board: Board = initialBoard()
  let side: Side = 'black'
  for (const mv of moves) {
    board = applyMove(board, side, notationToSquare(mv))
    side = opposite(side)
  }
  return { board, side }
}

/** 「複数パターン検出」局面(`PracticeMode.patternStats.test.tsx`と同じ、初期局面から12手・黒番)。 */
const DECISION_SEQ = ['f5', 'f4', 'c3', 'c4', 'd3', 'f6', 'b3', 'd6', 'g4', 'c2', 'e2', 'h4']
const { board: DECISION_BOARD, side: DECISION_SIDE } = boardAfterSequence(DECISION_SEQ)

function isDecisionBoard(board: Board, side: Side): boolean {
  return board.black === DECISION_BOARD.black && board.white === DECISION_BOARD.white && side === DECISION_SIDE
}

/** 全合法手を評価値0で並べる(全手「同点最善」扱い)。 */
function neutralMoves(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => ({ move: squareToNotation(square), score: 0, discDiff: 0, type: 'midgame' }))
}

/**
 * 決定局面専用: `DECISION_BEST_MOVE`だけ評価値`decisionBestDiscDiff`、他は0
 * (要件「損失があるが検出困難ではない手」)。`decisionBestDiscDiff`はテストごとに
 * 差し替える(T199: 発火閾値の境界テストのため、既定は新閾値と同じ6石)。
 */
const DECISION_BEST_MOVE = 'b1'
let decisionBestDiscDiff = 6
function decisionMoves(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => {
    const notation = squareToNotation(square)
    const discDiff = notation === DECISION_BEST_MOVE ? decisionBestDiscDiff : 0
    return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
  })
}

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

/** g6(決定局面での「悪手」役)・b1(最善)の特徴量差し替え(`clearBlunder.test.ts`のopponent-mobility陽性ケースを再利用)。 */
const FEATURE_OVERRIDES_BY_MOVE: Record<string, Partial<FeatureSetJson>> = {
  g6: { moverMobilityAfter: 2 },
  b1: { moverMobilityAfter: 6 },
}

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      if (isDecisionBoard(board, side)) return Promise.resolve(decisionMoves(board, side))
      return Promise.resolve(neutralMoves(board, side))
    },
    requestFeatureSet: (_board: Board, _side: Side, move: string): Promise<FeatureSetResponseMessage> =>
      Promise.resolve({ id: 0, final: true, features: neutralFeatures(FEATURE_OVERRIDES_BY_MOVE[move]) }),
    requestAnalyze: () => Promise.reject(new Error('T141フローテストでは使用しない')),
    requestEvalTerms: () => Promise.reject(new Error('T141フローテストでは使用しない')),
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

function clickMove(container: HTMLDivElement, notation: string): void {
  const btn = container.querySelector<HTMLButtonElement>(`[data-testid="move-${notation}"]`)
  expect(btn).not.toBeNull()
  btn?.click()
}

describe('T141: 中盤練習ステージクリア型のプレイフロー', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    stagePoolOverride = null
    decisionBestDiscDiff = 6
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it(
    '3往復とも最善手を打ち続けると★3でクリアし、損失一覧が全て「最善手」表示になる',
    async () => {
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

      for (let round = 0; round < 3; round += 1) {
        await act(async () => clickFirstMove(container))
        await flushAsyncEffects()
      }

      expect(container.querySelector('.midgame-result')).not.toBeNull()
      expect(container.querySelector('.midgame-result--clear')).not.toBeNull()
      expect(container.querySelector('.midgame-result__stars')?.textContent).toBe('★★★')

      const moveItems = Array.from(container.querySelectorAll('.midgame-result__moves li')).map((li) => li.textContent)
      expect(moveItems.length).toBe(3)
      moveItems.forEach((text) => expect(text).toContain('(最善手)'))

      const raw = localStorage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)
      expect(raw).not.toBeNull()
      const progress = JSON.parse(raw!)
      const entries = Object.values(progress) as Array<{ bestStars: number; attempts: number }>
      expect(entries.length).toBe(1)
      expect(entries[0]?.bestStars).toBe(3)
      expect(entries[0]?.attempts).toBe(1)
    },
    15000,
  )

  it(
    '損失が発火閾値以上の手を打つと直後に2手先2盤面比較が表示され、「続ける」で進行し、結果画面にも同じ比較が表示される(T195/T199)',
    async () => {
      // このテストだけは「決定局面」から始まるライン(DECISION_SEQ)を使う。
      const decisionLine: RawJosekiLine = {
        name: 'テスト用決定局面ライン',
        aliases: [],
        moves: DECISION_SEQ,
        firstMoveBasis: DECISION_SEQ[0]!,
        depth: DECISION_SEQ.length,
      }
      const { buildMidgameStagePool } = await import('./stagePool.ts')
      stagePoolOverride = buildMidgameStagePool(buildJosekiDb([decisionLine]))

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

      // 1手目: あえて最善(b1)ではないg6を打つ(損失6石=既定の発火閾値ちょうど、
      // 明確な悪化パターンが検出される)。
      await act(async () => clickMove(container, 'g6'))
      await flushAsyncEffects()

      // T195要件1・T199要件3: 損失が発火閾値(既定6石)以上の手を打った直後、
      // 相手の自動応手を保留して2手先2盤面比較が表示される
      // (「続ける」を押すまでステージが進まない)。
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()
      expect(container.querySelector('.midgame-result')).toBeNull()
      const continueButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '続ける',
      )
      expect(continueButton).toBeDefined()
      expect(container.textContent).toContain('実際に打った手')
      expect(container.textContent).toContain('最善手')

      await act(async () => {
        continueButton?.click()
      })
      await flushAsyncEffects()

      // 「続ける」を押した後は通常どおり相手が応手し、ステージが続行する。
      expect(container.querySelector('.midgame-practice__blunder-compare')).toBeNull()

      // 2・3手目: 以後は決定局面ではなくなるため、常に「先頭の合法手」(損失0扱い)を打つ。
      for (let round = 0; round < 2; round += 1) {
        await act(async () => clickFirstMove(container))
        await flushAsyncEffects()
      }

      expect(container.querySelector('.midgame-result')).not.toBeNull()

      const moveItems = Array.from(container.querySelectorAll('.midgame-result__moves li')).map((li) => li.textContent)
      expect(moveItems.length).toBe(3)
      expect(moveItems[0]).toContain('g6')
      expect(moveItems[0]).toContain('最善手 b1')
      expect(moveItems[0]).toContain('ロス6石')

      // 要件5: 最も損失が大きかった手(1手目)について、結果画面にも同じ
      // `TwoPlyCompare`が表示される。
      await flushAsyncEffects()
      expect(container.querySelector('.two-ply-compare')).not.toBeNull()
      expect(container.textContent).toContain('実際に打った手')
    },
    15000,
  )

  it(
    'T199境界テスト: 損失が発火閾値未満(3石、「1〜3石損では発火しない」要件)なら即時フィードバック・結果画面比較のいずれも表示されない',
    async () => {
      decisionBestDiscDiff = 3

      const decisionLine: RawJosekiLine = {
        name: 'テスト用決定局面ライン(閾値未満)',
        aliases: [],
        moves: DECISION_SEQ,
        firstMoveBasis: DECISION_SEQ[0]!,
        depth: DECISION_SEQ.length,
      }
      const { buildMidgameStagePool } = await import('./stagePool.ts')
      stagePoolOverride = buildMidgameStagePool(buildJosekiDb([decisionLine]))

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

      // 1手目: あえて最善(b1)ではないg6を打つ(損失3石、発火閾値6石未満)。
      await act(async () => clickMove(container, 'g6'))
      await flushAsyncEffects()

      // T199要件3の核心: 損失3石(「1〜3石損」)では即時フィードバック(2手先2盤面比較)が
      // 表示されず、相手の自動応手がそのまま進む(保留されない)。
      expect(container.querySelector('.midgame-practice__blunder-compare')).toBeNull()

      // 2・3手目: 以後は決定局面ではなくなるため、常に「先頭の合法手」(損失0扱い)を打つ。
      for (let round = 0; round < 2; round += 1) {
        await act(async () => clickFirstMove(container))
        await flushAsyncEffects()
      }

      expect(container.querySelector('.midgame-result')).not.toBeNull()

      const moveItems = Array.from(container.querySelectorAll('.midgame-result__moves li')).map((li) => li.textContent)
      expect(moveItems.length).toBe(3)
      expect(moveItems[0]).toContain('g6')
      expect(moveItems[0]).toContain('最善手 b1')
      expect(moveItems[0]).toContain('ロス3石')

      // 結果画面の最悪手比較(`worstMoveCompareInfo`)も同じ閾値のため表示されない。
      await flushAsyncEffects()
      expect(container.querySelector('.two-ply-compare')).toBeNull()
    },
    15000,
  )

  it('途中で終局(打てる手なし)した場合、打てたぶんの手数(1手)で★判定を確定する', async () => {
    // 黒に合法手が"a1"の1箇所だけあり、打つと双方とも合法手が無くなる(真の終局)人工局面。
    // scratchpadで`game/othello.ts`を直接実行して構成・検証済み(作業ログ参照)。
    const board: Board = { black: 0x5555555555555554n, white: 0xaaaaaaaaaaaaaaaan }
    const stage: MidgameStage = {
      key: 'test-terminal-stage',
      stageNumber: 1,
      board,
      sideToMove: 'black',
      josekiNames: ['終局テスト用'],
    }
    stagePoolOverride = [stage]

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

    // 唯一の合法手(a1)を打つ。打った瞬間に双方とも合法手が無くなり、
    // 3往復に満たない(1手のみ)まま真の終局としてセッションが終了するはず。
    await act(async () => clickMove(container, 'a1'))
    await flushAsyncEffects()

    expect(container.querySelector('.midgame-result')).not.toBeNull()
    const moveItems = Array.from(container.querySelectorAll('.midgame-result__moves li'))
    expect(moveItems.length).toBe(1) // 打てたぶん(1手)だけが記録されている。

    // 終了後の石差(黒34/白30)がそのまま結果画面のテキストに反映されているはず。
    const finalBoard = applyMove(board, 'black', notationToSquare('a1'))
    expect(countDiscs(finalBoard, 'black')).toBe(34)
    expect(countDiscs(finalBoard, 'white')).toBe(30)

    // ステージ一覧へ戻ると、この1回の挑戦結果がグリッドに反映されている。
    const backButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'ステージ一覧へ戻る',
    )
    expect(backButton).toBeDefined()
    await act(async () => {
      backButton?.click()
    })
    await flushAsyncEffects()

    const raw = localStorage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const progress = JSON.parse(raw!)
    expect(progress['test-terminal-stage']).toBeDefined()
    expect(progress['test-terminal-stage'].attempts).toBe(1)
  })
})

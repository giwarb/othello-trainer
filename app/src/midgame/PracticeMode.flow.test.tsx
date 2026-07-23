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
import { pickOpponentMove } from './pickOpponentMove.ts'
import { resolveNextSideOrFallback } from './resolveMover.ts'
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

/**
 * T200 redo#2: 連続悪手(1手目・2手目とも悪手)の再発防止テスト専用の
 * 「決定局面2」。決定局面1(`DECISION_BOARD`)で1手目の悪手`g6`を打った直後の
 * 局面から、相手(CPU)の応手をプロダクションコードと同じ関数
 * (`pickOpponentMove(neutralMoves, 'best')`、`neutralMoves`は全て評価値0)で
 * シミュレートして求める。`Array.prototype.sort`の安定性により、全手同点の
 * ときは`legalMoves`が返す先頭のマス(最小のマス番号)が選ばれる決定的な結果になる
 * (`pickOpponentMove.ts`のコメント参照)。これにより、テストの外から
 * `requestAnalyzeAll`をモックで差し替えるだけで、実際のゲームフロー(相手の
 * 自動応手を含む)を経由してもこの局面に到達することを保証できる。
 */
const boardAfterDecisionMove1 = applyMove(DECISION_BOARD, DECISION_SIDE, notationToSquare('g6'))
const sideAfterDecisionMove1 = resolveNextSideOrFallback(boardAfterDecisionMove1, opposite(DECISION_SIDE))
const decisionMove1OpponentReplyMoves = legalMoves(boardAfterDecisionMove1, sideAfterDecisionMove1).map((square) => ({
  move: squareToNotation(square),
  score: 0,
  discDiff: 0,
  type: 'midgame' as const,
}))
const decisionMove1OpponentReply = pickOpponentMove(decisionMove1OpponentReplyMoves, 'best')
if (decisionMove1OpponentReply === null) {
  throw new Error('T200 redo#2テスト用局面の前提が崩れている(1手目直後に相手の合法手が無い)')
}
if (sideAfterDecisionMove1 === DECISION_SIDE) {
  // 1手目の直後に相手がパスして即座に人間の手番へ戻ると、テストが前提とする
  // 「相手の自動応手を1回挟んでから2手目」という段取りが崩れる(そのケースは
  // 別途モックを組み直す必要がある)。この決定局面ではパスは起きない前提。
  throw new Error('T200 redo#2テスト用局面の前提が崩れている(1手目直後に相手がパスしている)')
}
const DECISION_BOARD_2 = applyMove(
  boardAfterDecisionMove1,
  sideAfterDecisionMove1,
  notationToSquare(decisionMove1OpponentReply),
)
const DECISION_SIDE_2 = resolveNextSideOrFallback(DECISION_BOARD_2, opposite(sideAfterDecisionMove1))
if (DECISION_SIDE_2 !== DECISION_SIDE) {
  // 2手目も人間(`DECISION_SIDE`)の手番であることが前提(相手の応手1回ぶんの
  // 通常の往復)。
  throw new Error('T200 redo#2テスト用局面の前提が崩れている(2手目が人間の手番になっていない)')
}

function isDecisionBoard2(board: Board, side: Side): boolean {
  return board.black === DECISION_BOARD_2.black && board.white === DECISION_BOARD_2.white && side === DECISION_SIDE_2
}

/** 決定局面2で実際に合法な手のnotation一覧(先頭を最善役、2番目を悪手役に使う)。 */
const decisionBoard2LegalMoves = legalMoves(DECISION_BOARD_2, DECISION_SIDE_2).map(squareToNotation)
if (decisionBoard2LegalMoves.length < 2) {
  throw new Error('T200 redo#2テスト用局面の前提が崩れている(決定局面2の合法手が2箇所未満)')
}
const DECISION_BEST_MOVE_2 = decisionBoard2LegalMoves[0]!
const DECISION_BAD_MOVE_2 = decisionBoard2LegalMoves[1]!

/**
 * 決定局面2専用: `DECISION_BEST_MOVE_2`だけ評価値`decisionBestDiscDiff2`、他は0。
 * 1手目(`decisionBestDiscDiff`、既定6)と意図的に異なる値にして、パネルの表示内容が
 * 手ごとに正しく区別できているかをテストで検証しやすくする。
 */
let decisionBestDiscDiff2 = 10
function decisionMoves2(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => {
    const notation = squareToNotation(square)
    const discDiff = notation === DECISION_BEST_MOVE_2 ? decisionBestDiscDiff2 : 0
    return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
  })
}

/**
 * T200: 決定局面**以外**(=2手先2盤面比較の`computeTwoPlyBranch`が着手後の
 * 盤面に対して呼ぶ`requestAnalyzeAll`)の応答を意図的に遅延させるための
 * スイッチ(既定0=遅延なし、既存テストの挙動を変えない)。「悪手検出直後
 * (計算完了前)に『悪手です』バナーが出る」テストだけがこれを使い、
 * 判定用の初回`requestAnalyzeAll`(決定局面向け、`isDecisionBoard`で分岐)は
 * 遅延させずに済ませることで、「損失は確定済みだが比較はまだ計算中」という
 * 状態を意図的に作り出す。
 */
let branchDelayMs = 0

/**
 * T200 redo#1: 明確な悪化パターン検出(`requestFeatureSet`)の応答を意図的に
 * 遅延させるためのスイッチ(既定0=遅延なし、既存テストの挙動を変えない)。
 * 「生成中に『続ける』を押した直後でも次の一手がanalyzingフラグの固着で
 * 無視されない」再発防止テストだけがこれを使う(`detectPatternsForPendingCompare`が
 * `handlePlayerMove`から完全に切り離されているかを検証するため、意図的に
 * 長く未解決のままにする)。
 */
let featureDelayMs = 0

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      if (isDecisionBoard(board, side)) return Promise.resolve(decisionMoves(board, side))
      // T200 redo#2: 決定局面2(連続悪手テスト用)も、判定用の初回呼び出しは
      // 決定局面1と同様に遅延させない(損失確定はただちに行われる必要があるため)。
      if (isDecisionBoard2(board, side)) return Promise.resolve(decisionMoves2(board, side))
      if (branchDelayMs > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(neutralMoves(board, side)), branchDelayMs))
      }
      return Promise.resolve(neutralMoves(board, side))
    },
    requestFeatureSet: (_board: Board, _side: Side, move: string): Promise<FeatureSetResponseMessage> => {
      const response: FeatureSetResponseMessage = {
        id: 0,
        final: true,
        features: neutralFeatures(FEATURE_OVERRIDES_BY_MOVE[move]),
      }
      if (featureDelayMs > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(response), featureDelayMs))
      }
      return Promise.resolve(response)
    },
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
    decisionBestDiscDiff2 = 10
    branchDelayMs = 0
    featureDelayMs = 0
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
    'T200: 悪手検出直後(比較計算の完了前)に「悪手です」バナーと生成中表示が出て、完了後に5盤面へ差し替わる',
    async () => {
      // 2手先2盤面比較(`computeTwoPlyBranch`)が着手後の盤面に投げる
      // `requestAnalyzeAll`だけを意図的に遅延させる(判定用の初回呼び出しは
      // 決定局面向けで遅延しない、`branchDelayMs`のコメント参照)。
      branchDelayMs = 400

      const decisionLine: RawJosekiLine = {
        name: 'テスト用決定局面ライン(T200)',
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

      // 1手目: あえて最善(b1)ではないg6を打つ(損失6石=既定の発火閾値ちょうど)。
      await act(async () => clickMove(container, 'g6'))
      // `branchDelayMs`(400ms)より十分短い時間だけ待つ: 判定用の初回
      // `requestAnalyzeAll`(遅延なし)は既に解決しているはずだが、
      // 2手先2盤面比較の計算(遅延あり)はまだ終わっていないはず。
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })

      // 悪手検出直後、比較計算の完了を待たずにパネル自体と「悪手です」バナーが
      // 出ている(損失は検出時点で確定済みのため即表示、要件1)。
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()
      expect(container.textContent).toContain('悪手です')
      expect(container.textContent).toContain('最善より約6石損')
      // 5盤面比較(`TwoPlyCompare`本体)はまだ計算中で描画されていない。
      expect(container.querySelector('.two-ply-compare')).toBeNull()
      // その間も「解説を生成中…」のローディング表示が出ている(要件1・2)。
      expect(container.textContent).toContain('解説を生成中…')
      // 「続ける」ボタンは生成中でも押せる(要件1)。
      const continueButtonWhileLoading = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '続ける',
      )
      expect(continueButtonWhileLoading).toBeDefined()

      // 比較計算が完了するまで待つと、5盤面比較に差し替わる。
      // (`computeTwoPlyBranch`は1系列あたり最大2回まで逐次`requestAnalyzeAll`を
      // 呼ぶため、`branchDelayMs`ぶんの遅延が最大2回連続しうる。余裕を見て待つ。)
      await flushAsyncEffects(20, 80)
      expect(container.querySelector('.two-ply-compare')).not.toBeNull()
      expect(container.textContent).not.toContain('解説を生成中…')
    },
    15000,
  )

  it(
    'T200 redo#1(重大指摘の再発防止): 生成中に「続ける」を押した直後でも、次の一手がanalyzingフラグの固着で無視されない',
    async () => {
      // 明確な悪化パターン検出(`requestFeatureSet`)の応答を長く未解決のままにする。
      // これが`handlePlayerMove`と同じtryブロックに残っていた(redo#1指摘)場合、
      // このPromiseが解決するまで`analyzing`が固着し、後続の一手クリックが
      // 冒頭ガードで黙って無視されるはず(=このテストがその回帰を検知する)。
      featureDelayMs = 1500

      const decisionLine: RawJosekiLine = {
        name: 'テスト用決定局面ライン(T200 redo#1)',
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

      // 1手目: 悪手(g6、損失6石)を打つ。
      await act(async () => clickMove(container, 'g6'))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()

      // 生成中(パターン検出がまだ未解決)のうちに「続ける」を押す。
      const continueButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '続ける',
      )
      expect(continueButton).toBeDefined()
      await act(async () => {
        continueButton?.click()
      })

      // 相手の自動応手(`OPPONENT_MOVE_DELAY_MS`=350ms)が終わり、人間の手番に
      // 戻るまで待つ(`featureDelayMs`=1500msより十分短い)。
      await flushAsyncEffects(10, 60)
      const moveButton = container.querySelector<HTMLButtonElement>('[data-testid^="move-"]')
      expect(moveButton).not.toBeNull()

      // 2手目をただちに打つ(この時点でパターン検出のPromiseはまだ未解決のはず)。
      await act(async () => clickFirstMove(container))
      await flushAsyncEffects(5, 60)

      // 2手目が実際に反映されている(黙って無視されていない)ことを確認する。
      const roundText = container.querySelector('.midgame-practice__round')?.textContent ?? ''
      expect(roundText).toContain('2/3手')
    },
    15000,
  )

  it(
    'T200 redo#2(重大指摘の再発防止): 連続悪手でN手目の未解決な非同期結果がN+1手目のpendingCompareに混入しない',
    async () => {
      // 1手目・2手目とも明確な悪化パターン検出(`requestFeatureSet`)の応答を
      // 長く未解決のままにする。redo#1の切り離しにより、1手目のこの検出が
      // 2手目の`pendingCompare`表示中に解決するタイミングを作り出し、
      // (token guardが無ければ)1手目だけの`nextSession`(2手目の着手を含まない)が
      // 2手目の`pendingCompare`に誤ってマージされてしまうことを検証する。
      featureDelayMs = 1500

      const decisionLine: RawJosekiLine = {
        name: 'テスト用決定局面ライン(T200 redo#2)',
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

      // 1手目: 悪手(g6、決定局面1、損失6石)を打つ。
      await act(async () => clickMove(container, 'g6'))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()
      expect(container.textContent).toContain('最善より約6石損')

      // 生成中(1手目のパターン検出がまだ未解決)のうちに「続ける」を押す。
      const continueButton1 = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '続ける',
      )
      expect(continueButton1).toBeDefined()
      await act(async () => {
        continueButton1?.click()
      })

      // 相手の自動応手(`OPPONENT_MOVE_DELAY_MS`=350ms)が終わり、人間の手番
      // (決定局面2)に戻るまで待つ。
      await flushAsyncEffects(10, 60)

      // 2手目: あえて最善(`DECISION_BEST_MOVE_2`)ではない`DECISION_BAD_MOVE_2`を
      // 打つ(決定局面2、損失10石=1手目とは異なる値にしてあり、パネルの取り違えを
      // 検知しやすくしてある)。この時点で1手目の`requestFeatureSet`はまだ
      // 未解決(featureDelayMs=1500msに対し、経過時間は高々1秒未満)のはず。
      await act(async () => clickMove(container, DECISION_BAD_MOVE_2))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()
      expect(container.textContent).toContain('最善より約10石損')
      let roundText = container.querySelector('.midgame-practice__round')?.textContent ?? ''
      // `pendingCompare.nextSession`(2手目の着手まで含む)を反映しているはず。
      expect(roundText).toContain('2/3手')

      // 1手目の`requestFeatureSet`(t≈0起点、1500ms後に解決)が解決する時間まで待つ
      // (2手目の`requestFeatureSet`はt≈700ms前後に発火したばかりで、まだ未解決のはず)。
      await flushAsyncEffects(15, 60)

      // 本題: 1手目の遅れて届いた結果が2手目の`pendingCompare`を上書きしていないこと
      // (token guardが無ければ、2手目の着手を含まない1手目単独の`nextSession`で
      // 上書きされ、`2/3手`→`1/3手`に後退してしまうはず)。
      expect(container.querySelector('.midgame-practice__blunder-compare')).not.toBeNull()
      roundText = container.querySelector('.midgame-practice__round')?.textContent ?? ''
      expect(roundText).toContain('2/3手')
      expect(container.textContent).toContain('最善より約10石損')

      // 2手目自身の検出・比較計算が完了するまでさらに待ってから「続ける」を押す。
      await flushAsyncEffects(10, 60)
      const continueButton2 = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '続ける',
      )
      expect(continueButton2).toBeDefined()
      await act(async () => {
        continueButton2?.click()
      })

      // 相手の2回目の自動応手を待ち、3手目(以後は決定局面ではないため「先頭の
      // 合法手」=損失0扱い)を打って3往復を完了させる。
      await flushAsyncEffects(10, 60)
      await act(async () => clickFirstMove(container))
      await flushAsyncEffects(10, 60)

      // 結果画面に、1手目(g6、ロス6石)・2手目(`DECISION_BAD_MOVE_2`、ロス10石)の
      // 両方が(巻き戻りや欠落なく)正しく記録されていることを確認する。
      expect(container.querySelector('.midgame-result')).not.toBeNull()
      const moveItems = Array.from(container.querySelectorAll('.midgame-result__moves li')).map((li) => li.textContent)
      expect(moveItems.length).toBe(3)
      expect(moveItems[0]).toContain('g6')
      expect(moveItems[0]).toContain('ロス6石')
      expect(moveItems[1]).toContain(DECISION_BAD_MOVE_2)
      expect(moveItems[1]).toContain('ロス10石')
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

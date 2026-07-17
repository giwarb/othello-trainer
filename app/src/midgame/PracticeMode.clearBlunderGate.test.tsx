// @vitest-environment jsdom
/**
 * T128要件2の回帰テスト: 評価値ベースの判定(`judgeMidgameMove`)では不合格でも、
 * `detectClearBlunderPatterns`(`clearBlunder.ts`)が明確な悪化パターンを1件も
 * 検出しなければ、中盤練習モードはその着手を合格として扱い(対局を続行し、
 * ステージ挑戦記録に不合格を書き込まない)ことを固定する。
 *
 * 局面設計: `clearBlunder.test.ts`の「opponent-mobility(陰性)」で使っている
 * 局面と同じ、初期局面から`f5,f4,c3,c4,d3,f6,b3,d6,g4,c2,e2,h4`(12手)進めた
 * 局面(黒番)を使う。この局面で黒が c1 に着手した場合(discDiffは低く設定し
 * 「最善手ではない」判定を強制する)と d1(最善手役)に着手した場合とで、
 * `detectClearBlunderPatterns`が`null`を返すこと(=明確な悪化パターンなし)は
 * scratchpadで`clearBlunder.ts`を直接実行して事前に確認済み。
 *
 * モック方針は`PracticeMode.staleSession.test.tsx`(T119 redo #1)と同じ
 * (Board/engineをスタブ化)。`Board`のスタブは、本テストが着手先を明示的に
 * クリックできるよう、'c1'/'d1'ボタンを描画する専用版にする。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureSetJson, MoveEvalJson } from '../engine/types.ts'
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

/** 初期局面から12手(黒から交互)進めた局面(黒番、空き48)。`clearBlunder.test.ts`と同じ局面構築。 */
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
  name: 'T128テスト用ライン',
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

/** 検出条件に関わらない「無害」な`FeatureSetJson`(`clearBlunder.test.ts`の`baseFeatures`と同じ既定値)。 */
function neutralFeatures(): FeatureSetJson {
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
  }
}

const requestFeatureSetSpy = vi.fn()

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    // 決定局面(黒番、DECISION_BOARD)では c1(discDiff低) を「最善手ではない」、
    // d1(discDiff高) を最善手にする。それ以外の局面(相手の着手選択等)は
    // 実際の合法手全てにdiscDiff0を割り当てる汎用フォールバック。
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      if (isDecisionBoard(board, side)) {
        // 決定局面: d1を最善手(discDiff5)、c1を明確な劣着(discDiff0)にする。
        // それ以外の合法手は最善手候補から外れるよう十分低いdiscDiffにする。
        const moves: MoveEvalJson[] = legalMoves(board, side).map((square) => {
          const notation = squareNotation(square)
          const discDiff = notation === 'd1' ? 5 : 0
          return { move: notation, score: discDiff * 100, discDiff, type: 'midgame' }
        })
        return Promise.resolve(moves)
      }
      // 汎用フォールバック(相手の着手選択・オーバーレイ再取得等): 全合法手を同評価にする。
      const moves: MoveEvalJson[] = legalMoves(board, side).map((square) => ({
        move: squareNotation(square),
        score: 0,
        discDiff: 0,
        type: 'midgame',
      }))
      return Promise.resolve(moves)
    },
    requestFeatureSet: (_board: Board, _side: Side, move: string) => {
      requestFeatureSetSpy(move)
      return Promise.resolve({ id: 0, final: true as const, features: neutralFeatures() })
    },
    requestAnalyze: () => Promise.reject(new Error('T128ゲートテストでは使用しない(handleModeFailureに到達しないはず)')),
    requestEvalTerms: () => Promise.reject(new Error('T128ゲートテストでは使用しない')),
    terminate: () => {},
  }),
}))

function squareNotation(square: number): string {
  const file = square % 8
  const rank0 = Math.floor(square / 8)
  return `${String.fromCharCode(97 + file)}${rank0 + 1}`
}

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T128: 明確な悪化パターンが無い不合格判定は合格扱いになる(ゲート)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    requestFeatureSetSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('評価値では不合格(最善手ではない)だが明確な悪化パターンが無いc1に着手すると、対局が続行しステージ記録に不合格が書かれない', async () => {
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

    // 「最善手ではない」c1をクリックする(評価値ベースの判定は不合格になるはず)。
    const c1Button = container.querySelector<HTMLButtonElement>('[data-testid="move-c1"]')
    expect(c1Button).not.toBeNull()
    await act(async () => {
      c1Button?.click()
    })
    await flushAsyncEffects(20)

    // ゲート(要件2)が実際に働いたことを、両手のrequestFeatureSet呼び出しで確認する。
    const calledMoves = requestFeatureSetSpy.mock.calls.map((args) => args[0])
    expect(calledMoves).toContain('c1')
    expect(calledMoves).toContain('d1')

    // 合格扱い: 結果画面(失敗)には遷移しない。対局(playing)が続いているか、
    // その後の完全読み確定等で別画面に進んでいても、少なくとも「失敗」画面ではない。
    expect(container.querySelector('.midgame-result--fail')).toBeNull()

    // 合格扱い: ステージ挑戦記録に不合格が書き込まれない
    // (`recordStageAttemptNow(stageKey, 'fail')`が呼ばれるのは
    // `handleModeFailure`内のみで、ゲート通過時はそれ自体が呼ばれない)。
    const raw = localStorage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      for (const stageKey of Object.keys(parsed)) {
        for (const mode of Object.keys(parsed[stageKey])) {
          expect(parsed[stageKey][mode].failCount ?? 0).toBe(0)
        }
      }
    }
  })
})

// @vitest-environment jsdom
/**
 * T196: `BlunderPanel`(悪手解析)の既定表示刷新のコンポーネントテスト。
 *
 * - 既定表示: T195由来の2手先2盤面比較(`TwoPlyCompare`、`midgame/twoPlyCompare.ts`
 *   を再利用)が最上部に表示される(要件1)。
 * - 折りたたみ: 比較PV・評価内訳waterfall・反証層・whyBad文章は
 *   「詳細分析(上級者向け)」`<details>`(既定で閉)に退避されている
 *   (削除はしていない。`<summary>`を開くと中身が描画される、要件1)。
 * - フリー分岐探索・練習送りは折りたたみの外にそのまま残る(要件1)。
 *
 * `<details>`のopen/close自体はCSSの`display:none`によるものであり、jsdomの
 * `textContent`はレイアウトを計算しないため非表示中でも中身の文字列を返す
 * (実ブラウザと異なる)。そのため「既定で閉じている」の確認は`details.open`
 * プロパティで行い、「中身が退避されているだけで削除されていない」の確認は
 * `open`にしてから対応する見出しの描画を待つ形で行う。
 *
 * `Board`(Canvas描画)は関心事ではないため、他のコンポーネントテスト
 * (`midgame/TwoPlyCompare.test.tsx`・`midgame/PracticeMode.flow.test.tsx`)と
 * 同じ方針でスタブ化する。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineClient } from '../engine/client.ts'
import type {
  AnalyzeResponseMessage,
  EvalTermsResponseMessage,
  FeatureSetJson,
  FeatureSetResponseMessage,
  MoveEvalJson,
} from '../engine/types.ts'
import { initialBoard, legalMoves, squareToNotation, type Board, type Side } from '../game/othello.ts'
import type { MoveAnalysis } from './types.ts'

vi.mock('../components/Board.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Board: (props: any) => (
    <div data-testid="stub-board" data-last-move={props.lastMove}>
      board
    </div>
  ),
}))

/** `PracticeMode.flow.test.tsx`の`neutralFeatures`と同じ「特に何も検出されない」特徴量。 */
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

/** 全合法手を評価値0で並べる(`PracticeMode.flow.test.tsx`の`neutralMoves`と同じ方針)。 */
function neutralMoves(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => ({ move: squareToNotation(square), score: 0, discDiff: 0, type: 'midgame' }))
}

/** `BlunderPanel`が呼ぶ4メソッド全てに決定的な応答を返すフェイクエンジン。 */
function makeFakeEngine(): EngineClient {
  return {
    requestFeatureSet: (): Promise<FeatureSetResponseMessage> =>
      Promise.resolve({ id: 0, final: true, features: neutralFeatures() }),
    requestAnalyze: (): Promise<AnalyzeResponseMessage> =>
      Promise.resolve({
        id: 0,
        final: true,
        depth: 1,
        pv: [],
        score: { type: 'midgame', discDiff: 0 },
        nodes: 1,
        nps: 1,
      }),
    requestEvalTerms: (): Promise<EvalTermsResponseMessage> =>
      Promise.resolve({
        id: 0,
        final: true,
        mobilityDiff: 0,
        cornerDiff: 0,
        stableDiff: 0,
        mobilityTerm: 0,
        cornerTerm: 0,
        stableTerm: 0,
        evaluateBlack: 0,
      }),
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => Promise.resolve(neutralMoves(board, side)),
  } as unknown as EngineClient
}

const BOARD = initialBoard()

const MOVE_ANALYSIS: MoveAnalysis = {
  ply: 0,
  move: 'd3',
  side: 'black',
  board: BOARD,
  isExact: false,
  evalSource: 'midgame',
  bestMove: 'c4',
  bestDiscDiff: 0,
  playedDiscDiff: -5,
  lossDiscs: 5,
  classification: 'blunder',
  reversal: false,
  blackAdvantageBefore: 0,
  blackAdvantageAfter: -5,
}

async function flushAsyncEffects(rounds = 6, delayMs = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    })
  }
}

describe('analysis/BlunderPanel: T196既定表示の刷新', () => {
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

  it('既定表示は2手先2盤面比較(損失1行込み)が最上部にあり、詳細分析は閉じたdetailsに退避されている', async () => {
    const { BlunderPanel } = await import('./BlunderPanel.tsx')

    await act(async () => {
      render(
        <BlunderPanel moveAnalysis={MOVE_ANALYSIS} gameMoves={['d3']} engine={makeFakeEngine()} onClose={() => {}} />,
        container,
      )
    })
    await flushAsyncEffects()

    const text = container.textContent ?? ''
    expect(text).toContain('2手先比較')
    // TwoPlyCompareの主文(打てる場所の言い回し)が描画されている。
    expect(text).toMatch(/この手だと次にあなたは\d+か所に打てます/)
    // 損失1行(要件1「損失の1行要約を添える」、TwoPlyCompare内蔵)。
    expect(text).toContain('この手は最善手より約5石損しています。')

    // フリー分岐探索・練習送りは折りたたみの外に残っている(要件1「残す」)。
    expect(text).toContain('フリー分岐探索')
    expect(text).toContain('練習送り')

    // 詳細分析は既定で閉じている(要件1「折りたたみへ退避」)。
    const details = container.querySelector<HTMLDetailsElement>('.blunder-panel__advanced')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('詳細分析(上級者向け)')
  })

  it('詳細分析を開くと比較PV・評価内訳・反証層・なぜ悪いかが表示される(退避のみで削除していない)', async () => {
    const { BlunderPanel } = await import('./BlunderPanel.tsx')

    await act(async () => {
      render(
        <BlunderPanel moveAnalysis={MOVE_ANALYSIS} gameMoves={['d3']} engine={makeFakeEngine()} onClose={() => {}} />,
        container,
      )
    })
    await flushAsyncEffects()

    const details = container.querySelector<HTMLDetailsElement>('.blunder-panel__advanced')
    expect(details).not.toBeNull()
    await act(async () => {
      details!.open = true
      details!.dispatchEvent(new Event('toggle'))
    })
    await flushAsyncEffects()

    const text = container.textContent ?? ''
    expect(text).toContain('比較PV(実際の進行 vs 最善進行)')
    expect(text).toContain('評価内訳(実際の進行 vs 最善進行の末端局面)')
    expect(text).toContain('反証層: 回収点(寄与が急変した手)')
    expect(text).toContain('なぜ悪いか')
  })
})

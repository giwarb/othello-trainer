import { describe, expect, it } from 'vitest'
import type { FeatureSet } from '../analysis/types.ts'
import { bigintToHex } from '../engine/hex.ts'
import type { AnalyzeLimit, EvalTermsResponseMessage, FeatureSetResponseMessage, MoveEvalJson } from '../engine/types.ts'
import { initialBoard, notationToSquare, type Board, type Side } from '../game/othello.ts'
import { findGlossaryEntry } from './glossary.ts'
import { findGlossaryExamples, type GlossaryExampleEngine } from './glossaryExamples.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'

/** テスト用にひとまず「無害」な既定値を持つ`FeatureSet`を作る(`analysis/motifs.test.ts`と同じ方針)。 */
function baseFeatures(overrides: Partial<FeatureSet> = {}): FeatureSet {
  return {
    mobilityDiff: 0,
    moverMobilityBefore: 4,
    opponentMobilityBefore: 4,
    opponentMobilityAfter: 4,
    moverMobilityAfter: 4,
    potentialMobilityDiff: 0,
    openness: 1,
    isUchiwari: false,
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

function makeEntry(id: string, board: Board, turn: Side): MidgamePoolEntry {
  return {
    id,
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    turn,
    source: 'blunder-review',
    createdAt: '2026-07-09T00:00:00.000Z',
  }
}

/** `requestFeatureSet`のみ差し替え可能なフェイクエンジン(motif検索テスト用)。 */
function motifFakeEngine(
  isUchiwariFor: (move: string) => boolean,
): GlossaryExampleEngine & { calls: number } {
  return {
    calls: 0,
    async requestFeatureSet(_board: Board, _turn: Side, move: string): Promise<FeatureSetResponseMessage> {
      this.calls++
      return { id: 0, final: true, features: baseFeatures({ isUchiwari: isUchiwariFor(move) }) }
    },
    async requestAnalyzeAll(): Promise<MoveEvalJson[]> {
      throw new Error('not used in this test')
    },
    async requestEvalTerms(): Promise<EvalTermsResponseMessage> {
      throw new Error('not used in this test')
    },
  }
}

describe('verbalize/glossaryExamples: findGlossaryExamples (motif項目)', () => {
  const nakawariEntry = findGlossaryEntry('nakawari')!
  const board = initialBoard()
  const entries = [makeEntry('a', board, 'black')]

  it('検出条件を満たす手を例局面として、満たさない手を反例として返す', async () => {
    // 初期局面の黒の合法手は d3/c4/f5/e6。d3のみisUchiwari=trueとする。
    const engine = motifFakeEngine((move) => move === 'd3')
    const result = await findGlossaryExamples(engine, entries, nakawariEntry, () => 0)

    expect(result.examples).toHaveLength(1)
    expect(result.examples[0]?.square).toBe(notationToSquare('d3'))
    expect(result.counterexample).not.toBeNull()
    expect(result.counterexample?.square).not.toBe(notationToSquare('d3'))
  })

  it('プールが空なら例局面0件・反例nullを返し、エンジンを呼ばない', async () => {
    const engine = motifFakeEngine(() => true)
    const result = await findGlossaryExamples(engine, [], nakawariEntry, () => 0)
    expect(result.examples).toHaveLength(0)
    expect(result.counterexample).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('該当する手が1つも無ければexamplesは空になる', async () => {
    const engine = motifFakeEngine(() => false)
    const result = await findGlossaryExamples(engine, entries, nakawariEntry, () => 0)
    expect(result.examples).toHaveLength(0)
    expect(result.counterexample).not.toBeNull()
  })
})

describe('verbalize/glossaryExamples: findGlossaryExamples (attribution項目)', () => {
  const mobilityEntry = findGlossaryEntry('attr-mobility')!
  const board = initialBoard()
  const entries = [makeEntry('a', board, 'black')]

  function attributionFakeEngine(
    moves: MoveEvalJson[],
    termsForMobilityDominant: boolean,
  ): GlossaryExampleEngine & { calls: number } {
    return {
      calls: 0,
      async requestFeatureSet(): Promise<FeatureSetResponseMessage> {
        throw new Error('not used in this test')
      },
      async requestAnalyzeAll(_board: Board, _turn: Side, _limit: AnalyzeLimit): Promise<MoveEvalJson[]> {
        this.calls++
        return moves
      },
      async requestEvalTerms(_board: Board, _turn: Side): Promise<EvalTermsResponseMessage> {
        // mobilityTermだけ差がある(モビリティが支配的)か、cornerTermだけ差がある(モビリティ非支配的)かを
        // 呼び出し回数で切り替える(1回目=best側、2回目=other側の値のペアで差を作る)。
        this.calls++
        const isFirstOfPair = this.calls % 2 === 1
        if (termsForMobilityDominant) {
          return {
            id: 0,
            final: true,
            mobilityDiff: 0,
            cornerDiff: 0,
            stableDiff: 0,
            mobilityTerm: isFirstOfPair ? 500 : 0,
            cornerTerm: 0,
            stableTerm: 0,
            evaluateBlack: isFirstOfPair ? 500 : 0,
          }
        }
        return {
          id: 0,
          final: true,
          mobilityDiff: 0,
          cornerDiff: 0,
          stableDiff: 0,
          mobilityTerm: 0,
          cornerTerm: isFirstOfPair ? 500 : 0,
          stableTerm: 0,
          evaluateBlack: isFirstOfPair ? 500 : 0,
        }
      },
    }
  }

  it('モビリティ項が支配的な局面を例局面として返す', async () => {
    const moves: MoveEvalJson[] = [
      { move: 'd3', score: 100, discDiff: 2, type: 'exact' },
      { move: 'c4', score: 50, discDiff: 1, type: 'exact' },
    ]
    const engine = attributionFakeEngine(moves, true)
    const result = await findGlossaryExamples(engine, entries, mobilityEntry, () => 0)
    expect(result.examples).toHaveLength(1)
  })

  it('モビリティ項が支配的でない局面は反例になる', async () => {
    const moves: MoveEvalJson[] = [
      { move: 'd3', score: 100, discDiff: 2, type: 'exact' },
      { move: 'c4', score: 50, discDiff: 1, type: 'exact' },
    ]
    const engine = attributionFakeEngine(moves, false)
    const result = await findGlossaryExamples(engine, entries, mobilityEntry, () => 0)
    expect(result.examples).toHaveLength(0)
    expect(result.counterexample).not.toBeNull()
  })

  it('候補手が1つ以下の局面はスキップされる(エンジンのrequestEvalTermsは呼ばれない)', async () => {
    const engine = attributionFakeEngine([{ move: 'd3', score: 0, discDiff: 0, type: 'exact' }], true)
    const result = await findGlossaryExamples(engine, entries, mobilityEntry, () => 0)
    expect(result.examples).toHaveLength(0)
    expect(result.counterexample).toBeNull()
  })
})

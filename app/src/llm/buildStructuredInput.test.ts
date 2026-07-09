import { describe, expect, it } from 'vitest'
import { buildAttribution } from '../analysis/attribution.ts'
import { buildComparePv } from '../analysis/comparePv.ts'
import type { MotifDefinition } from '../analysis/motifs.ts'
import { buildRefutationResult } from '../analysis/refutation.ts'
import type { EvalTerms, MoveAnalysis } from '../analysis/types.ts'
import { analyzeWhyBad } from '../analysis/whyBad.ts'
import { initialBoard, notationToSquare } from '../game/othello.ts'
import { buildGameSummaryInput, buildMoveFacts, buildStructuredInput } from './buildStructuredInput.ts'

/** `refutation.test.ts`と同じ方針のテスト用`EvalTerms`フィクスチャ。 */
function terms(mobilityTerm: number, cornerTerm: number, stableTerm: number): EvalTerms {
  return { mobilityDiff: 0, cornerDiff: 0, stableDiff: 0, mobilityTerm, cornerTerm, stableTerm, evaluateBlack: 0 }
}

function makeMoveAnalysis(overrides: Partial<MoveAnalysis> = {}): MoveAnalysis {
  const board = initialBoard()
  return {
    ply: 3,
    move: 'd3',
    side: 'black',
    board,
    isExact: false,
    bestMove: 'c3',
    bestDiscDiff: 4,
    playedDiscDiff: -2,
    lossDiscs: 6,
    classification: 'blunder',
    reversal: true,
    blackAdvantageBefore: 1,
    blackAdvantageAfter: -2,
    ...overrides,
  }
}

describe('llm/buildStructuredInput: buildMoveFacts', () => {
  it('MoveAnalysisから生局面情報を含まない事実だけを抜き出す', () => {
    const moveAnalysis = makeMoveAnalysis()
    const facts = buildMoveFacts(moveAnalysis)
    expect(facts).toEqual({
      ply: 3,
      side: 'black',
      playedMove: 'd3',
      bestMove: 'c3',
      playedDiscDiff: -2,
      bestDiscDiff: 4,
      lossDiscs: 6,
      classification: 'blunder',
      reversal: true,
      isExact: false,
    })
    // 生の盤面(board)や座標マス番号そのものは含まれない(ハルシネーション防止の一環)。
    expect(Object.keys(facts)).not.toContain('board')
  })
})

describe('llm/buildStructuredInput: buildStructuredInput', () => {
  const moveAnalysis = makeMoveAnalysis()
  // whyBadは`moveAnalysis.move`("d3")と同じ合法手について計算する(reasonsのテキストは検証しない)。
  const whyBad = analyzeWhyBad(moveAnalysis.board, moveAnalysis.side, notationToSquare(moveAnalysis.move))

  it('attribution/refutation/comparePvが揃っている場合、それぞれの構造化データを組み立てる', () => {
    const motifs: MotifDefinition[] = [{ key: 'zengaeshi', label: '全返し', kind: 'bad' }]
    const attribution = buildAttribution(terms(0, 500, 0), terms(0, 0, 0), 'black')

    // 実際の進行/最善進行とも"d3","c3"という同一の合法手順を使う(`refutation.test.ts`と同じ
    // 検証済みの手順)。評価内訳(EvalTerms)だけを変え、実際の進行の2手目のみ回収点にする。
    const comparePv = buildComparePv(['d3', 'c3'], 0, 'd3', ['c3'])
    const refutation = buildRefutationResult(
      moveAnalysis.board,
      'black',
      ['d3', 'c3'],
      ['d3', 'c3'],
      [terms(0, 0, 0), terms(0, 0, 0), terms(0, 500, 0)],
      [terms(0, 0, 0), terms(0, 0, 0), terms(0, 0, 0)],
      'black',
    )

    const result = buildStructuredInput(moveAnalysis, whyBad, motifs, attribution, refutation, comparePv)

    expect(result.move.playedMove).toBe('d3')
    expect(result.move.bestMove).toBe('c3')
    expect(result.motifTags).toEqual([{ key: 'zengaeshi', label: '全返し', kind: 'bad' }])
    expect(result.attribution).not.toBeNull()
    expect(result.attribution!.total).toBeCloseTo(5.0, 9)
    expect(result.attribution!.terms.find((t) => t.key === 'corner')!.delta).toBeCloseTo(5.0, 9)
    expect(result.comparePv).toEqual({
      playedContinuation: comparePv.playedContinuation,
      bestContinuation: comparePv.bestContinuation,
      firstDivergenceIndex: comparePv.firstDivergenceIndex,
    })
    // 実際の進行の2手目(corner項が5.0石動く)が回収点として検出され、文章化される。
    expect(result.refutation!.playedCriticalPlies).toHaveLength(1)
    expect(result.refutation!.playedCriticalPlies[0]!.move).toBe('c3')
    expect(result.refutation!.bestCriticalPlies).toHaveLength(0)
    expect(result.whyBadReasons).toEqual(whyBad.reasons)
  })

  it('attribution/refutation/comparePvが未取得(null)の場合、対応するフィールドをnullのまま渡す(存在しない情報を捏造しない)', () => {
    const result = buildStructuredInput(moveAnalysis, whyBad, [], null, null, null)
    expect(result.attribution).toBeNull()
    expect(result.refutation).toBeNull()
    expect(result.comparePv).toBeNull()
    expect(result.motifTags).toEqual([])
  })
})

describe('llm/buildStructuredInput: buildGameSummaryInput', () => {
  it('悪手判定された手(◎以外・逆転)のみを抜き出し、最善手(◎)は含めない', () => {
    const best = makeMoveAnalysis({ ply: 0, classification: 'best', reversal: false })
    const blunder = makeMoveAnalysis({ ply: 1, classification: 'blunder', reversal: false })
    const reversalOnly = makeMoveAnalysis({ ply: 2, classification: 'best', reversal: true })

    const summary = buildGameSummaryInput([best, blunder, reversalOnly])

    expect(summary.totalMoves).toBe(3)
    expect(summary.blunderCount).toBe(1)
    expect(summary.notableMoves).toHaveLength(2)
    expect(summary.notableMoves.map((m) => m.ply)).toEqual([1, 2])
  })

  it('目立った手が多い場合、上限件数で切り詰める', () => {
    const moves = Array.from({ length: 20 }, (_, i) => makeMoveAnalysis({ ply: i, classification: 'blunder' }))
    const summary = buildGameSummaryInput(moves, 5)
    expect(summary.notableMoves).toHaveLength(5)
  })
})

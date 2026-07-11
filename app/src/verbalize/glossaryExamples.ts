/**
 * T036用語集の「最小例局面2つ+反例局面1つ」(`othello-trainer-design-verbalization.md`
 * §7)を、既存の出題プール(`midgame/pool.ts`)から実際の検出ロジックを使って動的に
 * 検索するモジュール(`glossary.ts`冒頭コメント参照)。
 *
 * - モチーフ項目(`kind: 'motif'`): `analysis/motifs.ts`の`detectMotifs`をそのまま使い、
 *   プールの各局面・各合法手について検出有無を調べる。
 * - 評価内訳項目(`kind: 'attribution'`): `TwoChoiceDrill.tsx`(T035)と同じ方式
 *   (探索で評価上位2手を求め、`buildAttribution`で寄与分解し、絶対値最大の項を
 *   「その手の主要な軸」とみなす)を流用する。
 *
 * 探索コスト対策: プールの走査件数・1局面あたりの合法手数のいずれにも上限を設け、
 * 目的の例/反例が見つかり次第打ち切る(`TwoChoiceDrill.buildDrillProblem`の
 * `MAX_SELECTION_ATTEMPTS`と同じ「上限つきサンプリング」方針)。`requestAnalyzeAll`
 * には`timeMs`予算を必ず設定する(CLAUDE.md「完全読み・深い探索を使う機能では
 * time_ms予算を必ず設定すること」)。`requestFeatureSet`/`requestEvalTerms`は
 * 深い探索を行わない1手ぶんの特徴量・評価値計算のため`timeMs`の概念自体が無い。
 */

import { detectMotifs } from '../analysis/motifs.ts'
import type { AttributionTerm } from '../analysis/types.ts'
import { buildAttribution } from '../analysis/attribution.ts'
import type { AnalyzeLimit, EvalTermsResponseMessage, FeatureSetResponseMessage, MoveEvalJson } from '../engine/types.ts'
import { applyMove, legalMoves, notationToSquare, opposite, squareToNotation, type Board, type Side } from '../game/othello.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import type { GlossaryEntry } from './glossary.ts'
import { deserializeBoard } from './pickProblem.ts'

/** 1個の例局面/反例局面。 */
export interface GlossaryExample {
  readonly board: Board
  readonly side: Side
  /** この局面でハイライトする着手(モチーフ項目なら検出対象の手、評価内訳項目なら評価上位手)。 */
  readonly square: number
  readonly positionKey: string
}

export interface GlossaryExampleSearchResult {
  /** 該当する例局面(最大2件、要件1)。 */
  readonly examples: readonly GlossaryExample[]
  /** 該当しない反例局面(最大1件、要件1)。見つからなければ`null`。 */
  readonly counterexample: GlossaryExample | null
}

/** 例局面検索に必要な最小限のエンジンインターフェース(`TwoChoiceDrill.tsx`の`DrillEngine`と同じ方針)。 */
export interface GlossaryExampleEngine {
  requestFeatureSet: (board: Board, turn: Side, move: string) => Promise<FeatureSetResponseMessage>
  requestAnalyzeAll: (board: Board, turn: Side, limit: AnalyzeLimit) => Promise<MoveEvalJson[]>
  requestEvalTerms: (board: Board, turn: Side) => Promise<EvalTermsResponseMessage>
}

const MAX_EXAMPLES = 2
/** 走査するプールエントリ数の上限(ハング対策、`TwoChoiceDrill`と同水準)。 */
const MAX_ENTRIES_SCAN = 12
/** 1局面あたりに試す合法手数の上限(モチーフ検索用)。 */
const MAX_MOVES_PER_ENTRY = 8
/**
 * 評価内訳の例局面検索に使う探索条件。`TwoChoiceDrill.tsx`の`DRILL_ANALYZE_LIMIT`と
 * 同じ値(T076により`300`→`1000`に引き上げ済み)。
 */
const EXAMPLE_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 1000, exactFromEmpties: 24 }

/** `array`を`random`でシャッフルした新しい配列を返す(Fisher-Yates)。 */
function shuffled<T>(array: readonly T[], random: () => number): T[] {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

function toExample(board: Board, side: Side, square: number): GlossaryExample {
  return { board, side, square, positionKey: hashBoard(board, side) }
}

/**
 * モチーフ項目の例/反例を探す。プールの各局面の合法手を1つずつ調べ、
 * `detectMotifs`の結果に`motifKey`が含まれるものを例、含まれないものを反例とする。
 */
async function findMotifExamples(
  engine: GlossaryExampleEngine,
  entries: readonly MidgamePoolEntry[],
  motifKey: string,
  random: () => number,
): Promise<GlossaryExampleSearchResult> {
  const examples: GlossaryExample[] = []
  let counterexample: GlossaryExample | null = null

  for (const entry of shuffled(entries, random).slice(0, MAX_ENTRIES_SCAN)) {
    const board = deserializeBoard(entry)
    const side = entry.turn
    const moves = legalMoves(board, side).slice(0, MAX_MOVES_PER_ENTRY)

    for (const square of moves) {
      const move = squareToNotation(square)
      const featureResp = await engine.requestFeatureSet(board, side, move)
      const motifs = detectMotifs({ beforeBoard: board, side, square, features: featureResp.features })
      const matched = motifs.some((m) => m.key === motifKey)

      if (matched && examples.length < MAX_EXAMPLES) {
        examples.push(toExample(board, side, square))
      } else if (!matched && counterexample === null) {
        counterexample = toExample(board, side, square)
      }

      if (examples.length >= MAX_EXAMPLES && counterexample) return { examples, counterexample }
    }
  }

  return { examples, counterexample }
}

/**
 * 評価内訳項目の例/反例を探す。`TwoChoiceDrill.tsx`の`buildDrillProblem`と同じ
 * 手順(探索で上位2手→両方の`EvalTerms`取得→`buildAttribution`)で、絶対値最大の
 * 項が`attributionKey`と一致するものを例、一致しないものを反例とする。
 */
async function findAttributionExamples(
  engine: GlossaryExampleEngine,
  entries: readonly MidgamePoolEntry[],
  attributionKey: AttributionTerm['key'],
  random: () => number,
): Promise<GlossaryExampleSearchResult> {
  const examples: GlossaryExample[] = []
  let counterexample: GlossaryExample | null = null

  for (const entry of shuffled(entries, random).slice(0, MAX_ENTRIES_SCAN)) {
    const board = deserializeBoard(entry)
    const side = entry.turn
    const allMoves = await engine.requestAnalyzeAll(board, side, EXAMPLE_ANALYZE_LIMIT)
    if (allMoves.length < 2) continue

    const sorted = [...allMoves].sort((a, b) => b.discDiff - a.discDiff)
    const best = sorted[0]!
    const other = sorted[1]!
    const opponentSide = opposite(side)
    const bestSquare = notationToSquare(best.move)
    const boardAfterBest = applyMove(board, side, bestSquare)
    const boardAfterOther = applyMove(board, side, notationToSquare(other.move))

    const [bestTerms, otherTerms] = await Promise.all([
      engine.requestEvalTerms(boardAfterBest, opponentSide),
      engine.requestEvalTerms(boardAfterOther, opponentSide),
    ])
    const attribution = buildAttribution(bestTerms, otherTerms, side)
    if (attribution.terms.length === 0) continue
    const dominant = attribution.terms.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
    const matched = dominant.key === attributionKey && Math.abs(dominant.delta) > 0

    if (matched && examples.length < MAX_EXAMPLES) {
      examples.push(toExample(board, side, bestSquare))
    } else if (!matched && counterexample === null) {
      counterexample = toExample(board, side, bestSquare)
    }

    if (examples.length >= MAX_EXAMPLES && counterexample) return { examples, counterexample }
  }

  return { examples, counterexample }
}

/**
 * `entry`(用語集の1項目)に対応する例局面・反例局面を出題プールから探す(要件1)。
 * プールが空、または見つからない場合は`examples`が空/`counterexample`が`null`の
 * ままの結果を返す(呼び出し側が「見つかりませんでした」を表示する)。
 */
export async function findGlossaryExamples(
  engine: GlossaryExampleEngine,
  entries: readonly MidgamePoolEntry[],
  entry: GlossaryEntry,
  random: () => number = Math.random,
): Promise<GlossaryExampleSearchResult> {
  if (entries.length === 0) return { examples: [], counterexample: null }
  if (entry.kind === 'motif') return findMotifExamples(engine, entries, entry.key, random)
  return findAttributionExamples(engine, entries, entry.attributionKey!, random)
}

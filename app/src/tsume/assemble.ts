/**
 * `engine/src/bin/puzzlegen.rs evaluate` の生データ(`RawPuzzleGenCandidate[]`)を、
 * 唯一解性フィルタ・明確さフィルタ・難易度スコアリング・タグ付けを経て
 * 最終的な `Puzzle[]`(`app/public/puzzles.json` の中身)に変換する。
 *
 * `puzzlegen/generate.ts` から呼ばれる、生成パイプラインの中核ロジック。
 * フィルタ・スコアリング自体の判定ロジックは `filters.ts`/`difficulty.ts` の
 * 純粋関数にそのまま委譲し、ここでは「1候補局面の複数の合法手データから、
 * 見かけの順位(`apparentRank`)・罠手の魅力度(`trapScore`)をどう算出するか」
 * という、このモジュール固有の変換のみを担う。
 */

import { difficultyRawScore, bucketDifficultyThresholds, levelForScore } from './difficulty.ts'
import { analyzeMoveOutcomes } from './filters.ts'
import { obfToSerializedBoard } from './obf.ts'
import { deriveTagsFromMultiple } from './tags.ts'
import type { Puzzle, PuzzleMove, PuzzleOutcome, RawPuzzleGenCandidate } from './types.ts'

export interface AssembleStats {
  readonly totalCandidates: number
  readonly acceptedCount: number
  /** 唯一解性フィルタ(正解手が3手以上)で除外された件数。 */
  readonly rejectedUniqueness: number
  /** 唯一解性は満たしたが、明確さフィルタ(石差4未満)で除外された件数。 */
  readonly rejectedClarity: number
}

/**
 * 正解手グループ(`winnerIndices`)の中で、浅い評価(`shallowEval`)の順位が
 * 最も良いものを「代表正解手」とし、その順位(`apparentRank`、1始まり)と、
 * 不正解の手の中で最も浅い評価が高いものとの差(`trapScore`、0未満は0に
 * クリップ)を求める。`difficulty.ts` のコメント参照。
 */
function computeApparentRankAndTrap(
  moves: RawPuzzleGenCandidate['moves'],
  winnerIndices: readonly number[],
): { apparentRank: number; trapScore: number } {
  const indicesSortedByShallowDesc = moves
    .map((_, i) => i)
    .sort((a, b) => moves[b]!.shallowEval - moves[a]!.shallowEval)

  let apparentRank = moves.length
  let representativeWinnerIdx = winnerIndices[0]!
  for (let rank = 0; rank < indicesSortedByShallowDesc.length; rank++) {
    const idx = indicesSortedByShallowDesc[rank]!
    if (winnerIndices.includes(idx)) {
      apparentRank = rank + 1
      representativeWinnerIdx = idx
      break
    }
  }

  const nonWinnerShallows = moves
    .filter((_, i) => !winnerIndices.includes(i))
    .map((m) => m.shallowEval)
  const maxNonWinnerShallow = nonWinnerShallows.length > 0 ? Math.max(...nonWinnerShallows) : -Infinity
  const representativeShallow = moves[representativeWinnerIdx]!.shallowEval
  const trapScore = Math.max(0, maxNonWinnerShallow - representativeShallow)

  return { apparentRank, trapScore }
}

interface Draft {
  readonly raw: RawPuzzleGenCandidate
  readonly analysis: ReturnType<typeof analyzeMoveOutcomes>
  readonly rawScore: number
}

/** `rawCandidates` からフィルタ・スコアリング・タグ付け済みの `Puzzle[]` を組み立てる。 */
export function assemblePuzzles(rawCandidates: readonly RawPuzzleGenCandidate[]): {
  puzzles: Puzzle[]
  stats: AssembleStats
} {
  let rejectedUniqueness = 0
  let rejectedClarity = 0
  const drafts: Draft[] = []

  for (const raw of rawCandidates) {
    if (raw.moves.length === 0) continue // 合法手0件の候補は来ないはずだが防御的にskip

    const values = raw.moves.map((m) => m.valueForMover)
    const analysis = analyzeMoveOutcomes(values)
    if (!analysis.uniquenessOk) {
      rejectedUniqueness++
      continue
    }
    if (!analysis.clarityOk) {
      rejectedClarity++
      continue
    }

    const { apparentRank, trapScore } = computeApparentRankAndTrap(raw.moves, analysis.winnerIndices)
    const rawScore = difficultyRawScore({ empties: raw.empties, apparentRank, trapScore })
    drafts.push({ raw, analysis, rawScore })
  }

  const thresholds = bucketDifficultyThresholds(drafts.map((d) => d.rawScore))

  const puzzles: Puzzle[] = drafts.map((d) => {
    const { raw, analysis } = d
    const outcome: PuzzleOutcome = analysis.best > 0 ? 'win' : analysis.best < 0 ? 'loss' : 'draw'
    const winnerFacts = analysis.winnerIndices.map((i) => raw.moves[i]!)
    const tags = deriveTagsFromMultiple(winnerFacts)

    const moves: PuzzleMove[] = raw.moves.map((m, i) => ({
      square: m.square,
      discDiffForMover: m.valueForMover,
      isBest: analysis.winnerIndices.includes(i),
    }))

    return {
      id: raw.id,
      board: obfToSerializedBoard(raw.board),
      sideToMove: raw.sideToMove,
      empties: raw.empties,
      correctMoves: analysis.winnerIndices.map((i) => raw.moves[i]!.square),
      bestDiscDiff: analysis.best,
      outcome,
      clarityMargin: analysis.clarityMargin,
      moves,
      difficulty: levelForScore(d.rawScore, thresholds),
      difficultyRawScore: d.rawScore,
      tags,
    }
  })

  return {
    puzzles,
    stats: {
      totalCandidates: rawCandidates.length,
      acceptedCount: puzzles.length,
      rejectedUniqueness,
      rejectedClarity,
    },
  }
}

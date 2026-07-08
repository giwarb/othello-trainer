/**
 * 詰めオセロ問題生成パイプライン(T027)の「唯一解性フィルタ」「明確さフィルタ」。
 *
 * 設計書§5.2の選別条件:
 * - 唯一解性: 全合法手中、最善結果を維持する手が1〜2手のみ。
 * - 明確さ: 最善手と第2候補(次善手、最善手以外で最も結果の良い値)との
 *   最終石差の差が4以上。
 *
 * 入力は「候補局面の各合法手を完全読みした結果(出題局面の手番から見た最終石差)」
 * の数値配列のみで、盤面やRust CLIの出力形式には依存しない純粋関数にしてある
 * (`puzzlegen/generate.ts` からも、人工的なテストデータからも同じロジックで
 * 検証できるようにするため。要件11の単体テスト参照)。
 */

/** 1候補局面につき許容する正解手(最善結果を維持する手)の最大数。 */
export const MAX_WINNING_MOVES = 2

/** 最善手と次善手の最終石差の差として要求する最小値(「明確さ」フィルタ)。 */
export const MIN_CLARITY_MARGIN = 4

export interface MoveOutcomeAnalysis {
  /** 最善の最終石差(出題局面の手番から見た値)。 */
  readonly best: number
  /** `best` を達成する手のインデックス(入力配列内での位置、昇順)。 */
  readonly winnerIndices: readonly number[]
  /** 次善(最善以外で最大)の値。最善しか存在しない(全手が同値)場合は `best` と同じ。 */
  readonly second: number
  /** `best - second`。 */
  readonly clarityMargin: number
  /** 唯一解性フィルタを満たすか(正解手が1〜2手)。 */
  readonly uniquenessOk: boolean
  /** 明確さフィルタを満たすか(`clarityMargin >= MIN_CLARITY_MARGIN`)。 */
  readonly clarityOk: boolean
}

/**
 * 1候補局面の全合法手の完全読み結果(出題局面の手番視点の最終石差の配列)を
 * 分析し、唯一解性・明確さの判定結果を返す。
 *
 * @throws {RangeError} `values` が空配列の場合(合法手が1つも無い候補は
 *   そもそも生成段階で除外されているべきであり、呼び出し側のバグを示すため)。
 */
export function analyzeMoveOutcomes(values: readonly number[]): MoveOutcomeAnalysis {
  if (values.length === 0) {
    throw new RangeError('analyzeMoveOutcomes: values must not be empty')
  }

  const best = Math.max(...values)
  const winnerIndices = values.reduce<number[]>((acc, v, i) => {
    if (v === best) acc.push(i)
    return acc
  }, [])

  const distinctDesc = Array.from(new Set(values)).sort((a, b) => b - a)
  // 最善しか無い(全手が同値、または勝ち手グループがそのまま全体)場合は
  // 「次善」が存在しないため、`second = best` とすることで
  // `clarityMargin = 0` となり明確さフィルタが自然に不合格になる(意図的な挙動)。
  const second = distinctDesc.length >= 2 ? distinctDesc[1]! : best

  const clarityMargin = best - second

  return {
    best,
    winnerIndices,
    second,
    clarityMargin,
    uniquenessOk: winnerIndices.length >= 1 && winnerIndices.length <= MAX_WINNING_MOVES,
    clarityOk: clarityMargin >= MIN_CLARITY_MARGIN,
  }
}

/** 唯一解性・明確さの両方を満たせば `true`(問題として採用可能)。 */
export function isAcceptedPuzzleCandidate(values: readonly number[]): boolean {
  const analysis = analyzeMoveOutcomes(values)
  return analysis.uniquenessOk && analysis.clarityOk
}

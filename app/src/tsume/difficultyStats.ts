/**
 * 詰めオセロ設定画面の「難易度で選ぶ」カード(T137要件2)のための集計。
 *
 * 難易度バケット自体は生成時のパーセンタイル分割(`difficulty.ts`)で決まり、
 * 「難易度nは空きm〜kマス」という固定の対応表は存在しない(相対比較のみに
 * 意味があるスコアのため)。そのため、表示する空きマス数帯は事前生成データに
 * 依存せず、実際にロード済みの問題プール(`Puzzle[]`)から**その場で**求める
 * (難易度nに属する問題の`empties`の最小〜最大)。
 */

import { stageStatus, type StageProgress } from './stageProgress.ts'
import type { DifficultyLevel, Puzzle } from './types.ts'

export interface DifficultyStat {
  readonly level: DifficultyLevel
  /** この難易度に属する問題数(プールに1問も無ければ0)。 */
  readonly total: number
  /** このうちクリア済み(`stageStatus`が`'cleared'`)の問題数。 */
  readonly cleared: number
  /** この難易度に属する問題の空きマス数の最小値。`total === 0`なら`null`。 */
  readonly minEmpties: number | null
  /** 同、最大値。`total === 0`なら`null`。 */
  readonly maxEmpties: number | null
}

/** `pool`を難易度ごとに集計する(`levels`の順序どおりに1件ずつ返す)。 */
export function computeDifficultyStats(
  pool: readonly Puzzle[],
  progress: StageProgress,
  levels: readonly DifficultyLevel[],
): readonly DifficultyStat[] {
  return levels.map((level) => {
    const levelPuzzles = pool.filter((puzzle) => puzzle.difficulty === level)
    if (levelPuzzles.length === 0) {
      return { level, total: 0, cleared: 0, minEmpties: null, maxEmpties: null }
    }
    const empties = levelPuzzles.map((puzzle) => puzzle.empties)
    const cleared = levelPuzzles.filter((puzzle) => stageStatus(progress, puzzle.id) === 'cleared').length
    return {
      level,
      total: levelPuzzles.length,
      cleared,
      minEmpties: Math.min(...empties),
      maxEmpties: Math.max(...empties),
    }
  })
}

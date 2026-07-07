/**
 * 中盤練習モードにおける相手(エンジン)の着手選択(T021、要件5)。
 *
 * `OpponentStrength` に応じて、着手前局面の全合法手評価(`requestAnalyzeAll` の結果)
 * から相手の着手を選ぶ純粋関数。「実戦模倣(WTHOR頻度分布)」はWTHORデータ未導入の
 * ためスコープ外(タスク仕様「本タスクでのスコープ縮小」参照。「最善」「上位3手
 * ランダム」の2種のみ実装する)。
 */

import type { MoveEvalJson } from '../engine/types.ts'
import type { OpponentStrength } from './types.ts'

/**
 * `allMoves`(着手前局面の全合法手評価、手番側視点)から、`strength` に応じて
 * 1手選んで返す("a1"〜"h8"記法)。
 *
 * - `'best'`: 評価値(`discDiff`)が最大の手(同点があれば先に見つかったものを返す)。
 * - `'top3Random'`: 評価値の上位3手(合法手が3手未満ならその全て)から均等ランダムに1手。
 *
 * `allMoves` が空の場合は `null` を返す(合法手なし。呼び出し側でパス処理する)。
 * `random` は `[0, 1)` の一様乱数を返す関数(既定は `Math.random`、テストでは
 * 決定的な値を返すフェイクに差し替えて分布を検証できる)。
 */
export function pickOpponentMove(
  allMoves: readonly MoveEvalJson[],
  strength: OpponentStrength,
  random: () => number = Math.random,
): string | null {
  if (allMoves.length === 0) return null

  const sorted = [...allMoves].sort((a, b) => b.discDiff - a.discDiff)

  if (strength === 'best') {
    return sorted[0]!.move
  }

  const top = sorted.slice(0, 3)
  const index = Math.min(Math.floor(random() * top.length), top.length - 1)
  return top[index]!.move
}

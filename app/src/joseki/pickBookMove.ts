/**
 * 定石練習モードの「相手」の着手選択ロジック(T020)。
 *
 * 設計書§2.6.2の要件2「相手は現局面の `bookMoves` から `weight` に比例した
 * ランダム抽選で着手する(毎回進行が変わる)」を実装する。
 * T017のデータは同一局面から分岐する `bookMoves` が常に均等重みのため、
 * 実質は均等ランダムになる(`buildDb.ts` の `assignEqualWeights` 参照)。
 */

import type { JosekiBookMoveView } from './lookup.ts'

/**
 * `bookMoves` の `weight` に比例した確率で1手を選んで返す。
 *
 * `random` は `[0, 1)` の一様乱数を返す関数(既定は `Math.random`)。
 * テストでは決定的な値を返すフェイクに差し替えて分布を検証する。
 *
 * `bookMoves` が空の場合は例外を投げる(呼び出し側は `bookMoves.length > 0`
 * を事前に保証すること。定石DBのノードは `isLeaf` でなければ必ず1つ以上の
 * `bookMoves` を持つ)。
 */
export function pickBookMove(
  bookMoves: readonly JosekiBookMoveView[],
  random: () => number = Math.random,
): number {
  if (bookMoves.length === 0) {
    throw new RangeError('pickBookMove: bookMoves must not be empty')
  }

  const totalWeight = bookMoves.reduce((sum, bm) => sum + bm.weight, 0)
  let threshold = random() * totalWeight

  for (const bookMove of bookMoves) {
    threshold -= bookMove.weight
    if (threshold <= 0) return bookMove.move
  }

  // 浮動小数点誤差でthresholdが僅かに残った場合のフォールバック。
  return bookMoves[bookMoves.length - 1]!.move
}

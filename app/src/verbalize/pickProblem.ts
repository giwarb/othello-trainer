/**
 * T035「言語化トレーニングモード」の出題選択(要件1)。
 *
 * `midgame/pool.ts`のプール(IndexedDB `midgamePool`ストア)から局面を選ぶ。
 * 出典(`ProblemSource`)のスコープ縮小については`verbalize/types.ts`冒頭コメント参照。
 */

import { hexToBigint } from '../engine/hex.ts'
import type { Board } from '../game/othello.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import type { ProblemSource, VerbalizeProblem } from './types.ts'

/**
 * 「自分の悪手局面」とみなすプールエントリの`source`値。`midgame/PracticeMode.tsx`の
 * `registerFailure`・`analysis/sendToPractice.ts`の`sendToMidgamePractice`が
 * いずれもこの値で登録する。
 */
const BLUNDER_REVIEW_SOURCE = 'blunder-review'

/** `source`に応じてプールエントリをフィルタする(`'pool'`は全件、`'myBlunder'`は悪手レビュー由来のみ)。 */
export function filterPoolBySource(
  entries: readonly MidgamePoolEntry[],
  source: ProblemSource,
): MidgamePoolEntry[] {
  if (source === 'pool') return [...entries]
  return entries.filter((entry) => entry.source === BLUNDER_REVIEW_SOURCE)
}

function deserializeBoard(entry: MidgamePoolEntry): Board {
  return { black: hexToBigint(entry.board.black), white: hexToBigint(entry.board.white) }
}

/** プールエントリ1件から出題データを組み立てる。 */
export function buildProblemFromEntry(entry: MidgamePoolEntry, source: ProblemSource): VerbalizeProblem {
  const board = deserializeBoard(entry)
  return {
    id: entry.id,
    board,
    sideToMove: entry.turn,
    source,
    positionKey: hashBoard(board, entry.turn),
  }
}

/** `entries`(フィルタ前の全件)から`source`に応じてランダムに1問選ぶ。候補が無ければ`null`。 */
export function pickProblem(
  entries: readonly MidgamePoolEntry[],
  source: ProblemSource,
  random: () => number = Math.random,
): VerbalizeProblem | null {
  const filtered = filterPoolBySource(entries, source)
  if (filtered.length === 0) return null
  const index = Math.min(Math.floor(random() * filtered.length), filtered.length - 1)
  return buildProblemFromEntry(filtered[index]!, source)
}

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

/**
 * プールエントリのシリアライズ済み盤面(16進文字列)を`Board`に復元する。
 * T036の`glossaryExamples.ts`が例局面検索のために同じ復元処理を必要とするため、
 * 二重管理を避けてここからexportする(ロジック自体は変更していない)。
 */
export function deserializeBoard(entry: MidgamePoolEntry): Board {
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

/**
 * T036要件6「出題バイアスへの反映」: `weights`(`candidates`と同じ長さ)に応じた
 * 重み付き抽選でインデックスを1つ選ぶ。`tsume/stats.ts`の`pickWeightedPuzzle`
 * (T027)と同じ「累積重みからrandom()*totalを引いていく」アルゴリズムを
 * 汎用化したもの(ロジックの二重管理を避けるため、本関数に一本化する)。
 *
 * `weights`の合計が0以下(全問未挑戦扱いの重み0が並ぶ等、通常起きないが念のため)
 * の場合は一様ランダムにフォールバックする。
 *
 * @throws {RangeError} `weights`が空配列の場合。
 */
export function weightedRandomIndex(weights: readonly number[], random: () => number = Math.random): number {
  if (weights.length === 0) {
    throw new RangeError('weightedRandomIndex: weights is empty')
  }
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    return Math.min(Math.floor(random() * weights.length), weights.length - 1)
  }
  let r = random() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!
    if (r <= 0) return i
  }
  return weights.length - 1
}

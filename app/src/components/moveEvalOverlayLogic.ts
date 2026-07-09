/**
 * 盤面セル評価オーバーレイ(T039)のロジック部分(純粋関数)。
 *
 * `MoveEvalOverlay.tsx`(Preactコンポーネント)から分離してあるのは、
 * このリポジトリの単体テスト(`vitest.config.ts`)が `src/**\/*.test.ts`
 * (拡張子`.tsx`は対象外)のみを対象にしており、コンポーネント本体をテストする
 * 仕組みが無いため(`BoardOverlay.tsx`も同様に無テスト)。分類→色マッピングの
 * ロジックだけはここに切り出してテスト可能にする。
 */

import { classifyMove } from '../analysis/classifyMove.ts'
import type { ClassifyThresholds, MoveClassification } from '../analysis/types.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { notationToSquare } from '../game/othello.ts'

/** あるマス(候補手)についてのオーバーレイ表示情報。 */
export interface CellEval {
  readonly classification: MoveClassification
  /** 候補手中の最善評価値からのロス(石差、0以上)。 */
  readonly lossDiscs: number
}

/**
 * 候補手一括評価(`requestAnalyzeAll`の結果)から、マス(0〜63)ごとの
 * 分類・ロス量を求める。`allMoves`が`null`または空配列の場合は空のMapを返す。
 *
 * 最善手は`discDiff`(石差、手番視点)が最大の候補手とする
 * (`engine/src/protocol.rs`により`discDiff = score / 100`なので`score`基準の
 * 順序と一致する。`blunder/isBlunder.ts`の`isBlunder`と同じ考え方)。
 */
export function computeCellEvals(
  allMoves: readonly MoveEvalJson[] | null,
  thresholds: ClassifyThresholds,
): ReadonlyMap<number, CellEval> {
  const result = new Map<number, CellEval>()
  if (!allMoves || allMoves.length === 0) return result

  const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))

  for (const move of allMoves) {
    const lossDiscs = Math.max(0, best.discDiff - move.discDiff)
    const classification = classifyMove(lossDiscs, thresholds)
    result.set(notationToSquare(move.move), { classification, lossDiscs })
  }

  return result
}

/**
 * ロス量を「±0」「-1.2」のような短い表示用文字列に整形する(要件、
 * `MoveEvalOverlay.tsx`のマーカーに小さく表示する数値)。
 * 四捨五入して0になる場合(最善手自身を含む)は`±0`にする。
 */
export function formatLoss(lossDiscs: number): string {
  const rounded = Math.round(lossDiscs * 10) / 10
  if (rounded <= 0) return '±0'
  return `-${rounded.toFixed(1)}`
}

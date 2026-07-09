/**
 * ロス量(最善手との石差)からの分類判定(T029、要件4)。
 * 設計書§6.2の分類: ロス<1: 最善/準最善 ◎ / 1–3: 緩手 ?! / 3–6: 疑問手 ? / ≥6: 悪手 ??
 * 純粋関数(副作用なし)。閾値はユーザーが調整できる(`ClassifyThresholds`)。
 */

import type { ClassifyThresholds, MoveClassification } from './types.ts'

/** 分類閾値の既定値(設計書§6.2の数値どおり: 1 / 3 / 6石)。 */
export const DEFAULT_CLASSIFY_THRESHOLDS: ClassifyThresholds = {
  inaccuracy: 1,
  dubious: 3,
  blunder: 6,
}

/**
 * `lossDiscs`(0以上、最善手とのロス石差)を分類する。
 * 各閾値は「その値**以上**でその分類」という下限として扱う
 * (例: `inaccuracy: 1`なら、ロスがちょうど1.0石で「緩手」になる)。
 * 閾値は`inaccuracy <= dubious <= blunder`であることを期待するが、
 * 逆転していても上から順に判定するため例外は投げない(単に意図しない分類になるだけ)。
 */
export function classifyMove(
  lossDiscs: number,
  thresholds: ClassifyThresholds = DEFAULT_CLASSIFY_THRESHOLDS,
): MoveClassification {
  if (lossDiscs >= thresholds.blunder) return 'blunder'
  if (lossDiscs >= thresholds.dubious) return 'dubious'
  if (lossDiscs >= thresholds.inaccuracy) return 'inaccuracy'
  return 'best'
}

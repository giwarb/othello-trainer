/**
 * 分類閾値(`ClassifyThresholds`)の`localStorage`への保存・読み込み(T029、要件4)。
 * `blunder/storage.ts`(T019)と同じパターン: `StorageLike`最小インターフェース経由で
 * アクセスし、単体テストでは`Map`ベースのフェイクを注入できる。
 */

import { DEFAULT_CLASSIFY_THRESHOLDS } from './classifyMove.ts'
import type { ClassifyThresholds } from './types.ts'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const CLASSIFY_THRESHOLDS_STORAGE_KEY = 'othello-trainer:analysisClassifyThresholds'

function isValidThresholds(value: unknown): value is ClassifyThresholds {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.inaccuracy === 'number' &&
    Number.isFinite(v.inaccuracy) &&
    typeof v.dubious === 'number' &&
    Number.isFinite(v.dubious) &&
    typeof v.blunder === 'number' &&
    Number.isFinite(v.blunder)
  )
}

/** 保存済みの閾値を読み込む。未保存・不正な形式であれば`DEFAULT_CLASSIFY_THRESHOLDS`を返す。 */
export function loadClassifyThresholds(storage: StorageLike): ClassifyThresholds {
  const raw = storage.getItem(CLASSIFY_THRESHOLDS_STORAGE_KEY)
  if (raw === null) return DEFAULT_CLASSIFY_THRESHOLDS

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidThresholds(parsed) ? parsed : DEFAULT_CLASSIFY_THRESHOLDS
  } catch {
    return DEFAULT_CLASSIFY_THRESHOLDS
  }
}

/** 閾値を`localStorage`へ保存する。 */
export function saveClassifyThresholds(storage: StorageLike, thresholds: ClassifyThresholds): void {
  storage.setItem(CLASSIFY_THRESHOLDS_STORAGE_KEY, JSON.stringify(thresholds))
}

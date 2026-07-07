/**
 * 悪手判定設定(`BlunderConfig`)の `localStorage` への保存・読み込み(T019)。
 *
 * ブラウザの `localStorage` (Web Storage API)にしか依存しないよう、
 * `getItem`/`setItem` のみの最小限インターフェース(`StorageLike`)を介して
 * アクセスする。単体テストでは実際の `localStorage` の代わりに
 * `Map` ベースのフェイクを注入できる。
 */

import { DEFAULT_BLUNDER_CONFIG, type BlunderConfig, type BlunderMethod } from './types.ts'

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const BLUNDER_CONFIG_STORAGE_KEY = 'othello-trainer:blunderConfig'

const VALID_METHODS: readonly BlunderMethod[] = ['worseThanBest', 'lossThreshold', 'rankThreshold']

/** 読み込んだJSONが妥当な `BlunderConfig` の形をしているか検証する。 */
function isValidConfig(value: unknown): value is BlunderConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    VALID_METHODS.includes(v.method as BlunderMethod) &&
    typeof v.lossThreshold === 'number' &&
    Number.isFinite(v.lossThreshold) &&
    typeof v.rankThreshold === 'number' &&
    Number.isFinite(v.rankThreshold)
  )
}

/**
 * 保存済みの `BlunderConfig` を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・形が不正な場合は
 * `DEFAULT_BLUNDER_CONFIG` を返す(例外は投げない)。
 */
export function loadBlunderConfig(storage: StorageLike): BlunderConfig {
  const raw = storage.getItem(BLUNDER_CONFIG_STORAGE_KEY)
  if (raw === null) return DEFAULT_BLUNDER_CONFIG

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidConfig(parsed) ? parsed : DEFAULT_BLUNDER_CONFIG
  } catch {
    return DEFAULT_BLUNDER_CONFIG
  }
}

/** `BlunderConfig` を `localStorage` へ保存する(次回起動時も `loadBlunderConfig` で読み戻せる)。 */
export function saveBlunderConfig(storage: StorageLike, config: BlunderConfig): void {
  storage.setItem(BLUNDER_CONFIG_STORAGE_KEY, JSON.stringify(config))
}

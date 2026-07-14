/** CPU opening-book setting for play mode (T093). */

import type { StorageLike } from './evalBarSettings.ts'

export const OPENING_BOOK_STORAGE_KEY = 'othello-trainer:cpuOpeningBook'
export const DEFAULT_OPENING_BOOK_ENABLED = true

export function loadOpeningBookEnabled(storage: StorageLike): boolean {
  const raw = storage.getItem(OPENING_BOOK_STORAGE_KEY)
  if (raw === null) return DEFAULT_OPENING_BOOK_ENABLED

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : DEFAULT_OPENING_BOOK_ENABLED
  } catch {
    return DEFAULT_OPENING_BOOK_ENABLED
  }
}

export function saveOpeningBookEnabled(storage: StorageLike, enabled: boolean): void {
  storage.setItem(OPENING_BOOK_STORAGE_KEY, JSON.stringify(enabled))
}

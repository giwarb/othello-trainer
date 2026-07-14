import { describe, expect, it } from 'vitest'
import type { StorageLike } from './evalBarSettings.ts'
import {
  DEFAULT_OPENING_BOOK_ENABLED,
  OPENING_BOOK_STORAGE_KEY,
  loadOpeningBookEnabled,
  saveOpeningBookEnabled,
} from './openingBookSettings.ts'

class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

describe('loadOpeningBookEnabled / saveOpeningBookEnabled', () => {
  it('defaults to enabled when no value is stored', () => {
    expect(loadOpeningBookEnabled(new FakeStorage())).toBe(DEFAULT_OPENING_BOOK_ENABLED)
    expect(DEFAULT_OPENING_BOOK_ENABLED).toBe(true)
  })

  it('persists on/off across a reload-equivalent storage instance', () => {
    const beforeReload = new FakeStorage()
    saveOpeningBookEnabled(beforeReload, false)

    const afterReload = new FakeStorage()
    afterReload.setItem(OPENING_BOOK_STORAGE_KEY, beforeReload.getItem(OPENING_BOOK_STORAGE_KEY)!)
    expect(loadOpeningBookEnabled(afterReload)).toBe(false)

    saveOpeningBookEnabled(afterReload, true)
    expect(loadOpeningBookEnabled(afterReload)).toBe(true)
  })

  it('falls back to the default for malformed or non-boolean values', () => {
    const storage = new FakeStorage()
    storage.setItem(OPENING_BOOK_STORAGE_KEY, 'invalid json')
    expect(loadOpeningBookEnabled(storage)).toBe(true)

    storage.setItem(OPENING_BOOK_STORAGE_KEY, JSON.stringify('false'))
    expect(loadOpeningBookEnabled(storage)).toBe(true)
  })
})

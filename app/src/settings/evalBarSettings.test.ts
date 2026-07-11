import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVAL_BAR_ENABLED,
  EVAL_BAR_STORAGE_KEY,
  loadEvalBarEnabled,
  saveEvalBarEnabled,
  type StorageLike,
} from './evalBarSettings.ts'

/** 実際の`localStorage`の代わりに使う、`Map`ベースのフェイク実装。 */
class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

describe('loadEvalBarEnabled / saveEvalBarEnabled', () => {
  it('未保存の場合は既定値(false・非表示)を返す', () => {
    const storage = new FakeStorage()
    expect(loadEvalBarEnabled(storage)).toBe(DEFAULT_EVAL_BAR_ENABLED)
    expect(loadEvalBarEnabled(storage)).toBe(false)
  })

  it('trueを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveEvalBarEnabled(storage, true)
    expect(loadEvalBarEnabled(storage)).toBe(true)
  })

  it('falseを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveEvalBarEnabled(storage, true)
    saveEvalBarEnabled(storage, false)
    expect(loadEvalBarEnabled(storage)).toBe(false)
  })

  it('別のstorageインスタンス間では独立している(次回起動時も保持、のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    saveEvalBarEnabled(storage1, true)

    const storage2 = new FakeStorage()
    storage2.setItem(EVAL_BAR_STORAGE_KEY, storage1.getItem(EVAL_BAR_STORAGE_KEY)!)
    expect(loadEvalBarEnabled(storage2)).toBe(true)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(EVAL_BAR_STORAGE_KEY, '{ this is not valid json')
    expect(loadEvalBarEnabled(storage)).toBe(DEFAULT_EVAL_BAR_ENABLED)
  })

  it('真偽値でない値(数値・文字列・null)が保存されていた場合は既定値を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(EVAL_BAR_STORAGE_KEY, JSON.stringify(1))
    expect(loadEvalBarEnabled(storage)).toBe(DEFAULT_EVAL_BAR_ENABLED)

    storage.setItem(EVAL_BAR_STORAGE_KEY, JSON.stringify('true'))
    expect(loadEvalBarEnabled(storage)).toBe(DEFAULT_EVAL_BAR_ENABLED)

    storage.setItem(EVAL_BAR_STORAGE_KEY, JSON.stringify(null))
    expect(loadEvalBarEnabled(storage)).toBe(DEFAULT_EVAL_BAR_ENABLED)
  })
})

import { describe, expect, it } from 'vitest'
import { BLUNDER_CONFIG_STORAGE_KEY, loadBlunderConfig, saveBlunderConfig, type StorageLike } from './storage.ts'
import { DEFAULT_BLUNDER_CONFIG, type BlunderConfig } from './types.ts'

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

describe('loadBlunderConfig / saveBlunderConfig', () => {
  it('未保存の場合は既定値を返す', () => {
    const storage = new FakeStorage()
    expect(loadBlunderConfig(storage)).toEqual(DEFAULT_BLUNDER_CONFIG)
  })

  it('保存した設定を正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    const config: BlunderConfig = { method: 'rankThreshold', lossThreshold: 2.5, rankThreshold: 5 }

    saveBlunderConfig(storage, config)
    expect(loadBlunderConfig(storage)).toEqual(config)
  })

  it('別のstorageインスタンス間では独立している(次回起動時も保持、のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    const config: BlunderConfig = { method: 'worseThanBest', lossThreshold: 1.5, rankThreshold: 4 }
    saveBlunderConfig(storage1, config)

    // storage1に保存した内容をシリアライズしてstorage2に「引き継ぐ」= 次回起動をシミュレート。
    const storage2 = new FakeStorage()
    storage2.setItem(BLUNDER_CONFIG_STORAGE_KEY, storage1.getItem(BLUNDER_CONFIG_STORAGE_KEY)!)
    expect(loadBlunderConfig(storage2)).toEqual(config)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(BLUNDER_CONFIG_STORAGE_KEY, '{ this is not valid json')
    expect(loadBlunderConfig(storage)).toEqual(DEFAULT_BLUNDER_CONFIG)
  })

  it('形が不正な値(method不正・数値でない閾値)が保存されていた場合は既定値を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(BLUNDER_CONFIG_STORAGE_KEY, JSON.stringify({ method: 'unknown', lossThreshold: 1, rankThreshold: 1 }))
    expect(loadBlunderConfig(storage)).toEqual(DEFAULT_BLUNDER_CONFIG)

    storage.setItem(
      BLUNDER_CONFIG_STORAGE_KEY,
      JSON.stringify({ method: 'lossThreshold', lossThreshold: 'abc', rankThreshold: 1 }),
    )
    expect(loadBlunderConfig(storage)).toEqual(DEFAULT_BLUNDER_CONFIG)

    storage.setItem(BLUNDER_CONFIG_STORAGE_KEY, JSON.stringify(null))
    expect(loadBlunderConfig(storage)).toEqual(DEFAULT_BLUNDER_CONFIG)
  })
})

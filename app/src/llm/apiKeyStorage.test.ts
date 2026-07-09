import { describe, expect, it } from 'vitest'
import { clearApiKey, LLM_API_KEY_STORAGE_KEY, loadApiKey, saveApiKey, type StorageLike } from './apiKeyStorage.ts'

/** 実際の`localStorage`の代わりに使う、`Map`ベースのフェイク実装(`blunder/storage.test.ts`と同じ方針)。 */
class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }
}

describe('llm/apiKeyStorage: loadApiKey / saveApiKey / clearApiKey', () => {
  it('未保存の場合はnullを返す(既定はOFF)', () => {
    const storage = new FakeStorage()
    expect(loadApiKey(storage)).toBeNull()
  })

  it('保存したAPIキーを正しく読み戻せる(往復、ダミー文字列でテストする)', () => {
    const storage = new FakeStorage()
    saveApiKey(storage, 'sk-ant-dummy-test-key-not-real')
    expect(loadApiKey(storage)).toBe('sk-ant-dummy-test-key-not-real')
  })

  it('削除すると未保存状態に戻る', () => {
    const storage = new FakeStorage()
    saveApiKey(storage, 'sk-ant-dummy-test-key-not-real')
    expect(loadApiKey(storage)).not.toBeNull()

    clearApiKey(storage)
    expect(loadApiKey(storage)).toBeNull()
  })

  it('空文字列が保存されている場合もnullを返す(未設定として扱う)', () => {
    const storage = new FakeStorage()
    storage.setItem(LLM_API_KEY_STORAGE_KEY, '')
    expect(loadApiKey(storage)).toBeNull()
  })

  it('別のstorageインスタンス間では独立している(次回起動時も保持、のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    saveApiKey(storage1, 'sk-ant-dummy-test-key-not-real')

    const storage2 = new FakeStorage()
    storage2.setItem(LLM_API_KEY_STORAGE_KEY, storage1.getItem(LLM_API_KEY_STORAGE_KEY)!)
    expect(loadApiKey(storage2)).toBe('sk-ant-dummy-test-key-not-real')
  })
})

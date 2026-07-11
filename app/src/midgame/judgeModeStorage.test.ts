import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JUDGE_MODE,
  JUDGE_MODE_STORAGE_KEY,
  loadJudgeMode,
  saveJudgeMode,
  type StorageLike,
} from './judgeModeStorage.ts'

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

describe('loadJudgeMode / saveJudgeMode', () => {
  it('未保存の場合は既定値(strict)を返す', () => {
    const storage = new FakeStorage()
    expect(loadJudgeMode(storage)).toBe(DEFAULT_JUDGE_MODE)
    expect(loadJudgeMode(storage)).toBe('strict')
  })

  it('standardを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveJudgeMode(storage, 'standard')
    expect(loadJudgeMode(storage)).toBe('standard')
  })

  it('noReversalを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveJudgeMode(storage, 'noReversal')
    expect(loadJudgeMode(storage)).toBe('noReversal')
  })

  it('別のstorageインスタンス間では独立している(次回起動時も保持、のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    saveJudgeMode(storage1, 'standard')

    const storage2 = new FakeStorage()
    storage2.setItem(JUDGE_MODE_STORAGE_KEY, storage1.getItem(JUDGE_MODE_STORAGE_KEY)!)
    expect(loadJudgeMode(storage2)).toBe('standard')
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(JUDGE_MODE_STORAGE_KEY, '{ this is not valid json')
    expect(loadJudgeMode(storage)).toBe(DEFAULT_JUDGE_MODE)
  })

  it('既知の値でない場合(数値・未知の文字列・null)は既定値を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(JUDGE_MODE_STORAGE_KEY, JSON.stringify(1))
    expect(loadJudgeMode(storage)).toBe(DEFAULT_JUDGE_MODE)

    storage.setItem(JUDGE_MODE_STORAGE_KEY, JSON.stringify('unknown-mode'))
    expect(loadJudgeMode(storage)).toBe(DEFAULT_JUDGE_MODE)

    storage.setItem(JUDGE_MODE_STORAGE_KEY, JSON.stringify(null))
    expect(loadJudgeMode(storage)).toBe(DEFAULT_JUDGE_MODE)
  })
})

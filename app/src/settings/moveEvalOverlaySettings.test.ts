import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED,
  DEFAULT_MOVE_EVAL_OVERLAY_ENABLED,
  loadMidgameMoveEvalOverlayEnabled,
  loadMoveEvalOverlayEnabled,
  MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY,
  MOVE_EVAL_OVERLAY_STORAGE_KEY,
  saveMidgameMoveEvalOverlayEnabled,
  saveMoveEvalOverlayEnabled,
  type StorageLike,
} from './moveEvalOverlaySettings.ts'

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

describe('loadMoveEvalOverlayEnabled / saveMoveEvalOverlayEnabled', () => {
  it('未保存の場合は既定値(false・非表示)を返す', () => {
    const storage = new FakeStorage()
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MOVE_EVAL_OVERLAY_ENABLED)
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(false)
  })

  it('trueを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveMoveEvalOverlayEnabled(storage, true)
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(true)
  })

  it('falseを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveMoveEvalOverlayEnabled(storage, true)
    saveMoveEvalOverlayEnabled(storage, false)
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(false)
  })

  it('別のstorageインスタンス間では独立している(次回起動時も保持、のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    saveMoveEvalOverlayEnabled(storage1, true)

    const storage2 = new FakeStorage()
    storage2.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, storage1.getItem(MOVE_EVAL_OVERLAY_STORAGE_KEY)!)
    expect(loadMoveEvalOverlayEnabled(storage2)).toBe(true)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, '{ this is not valid json')
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MOVE_EVAL_OVERLAY_ENABLED)
  })

  it('真偽値でない値(数値・文字列・null)が保存されていた場合は既定値を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(1))
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MOVE_EVAL_OVERLAY_ENABLED)

    storage.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify('true'))
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MOVE_EVAL_OVERLAY_ENABLED)

    storage.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(null))
    expect(loadMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MOVE_EVAL_OVERLAY_ENABLED)
  })
})

describe('loadMidgameMoveEvalOverlayEnabled / saveMidgameMoveEvalOverlayEnabled(T142: 中盤練習専用、既定ON)', () => {
  it('未保存の場合は既定値(true・表示)を返す(対局モード等の既定OFFとは異なる)', () => {
    const storage = new FakeStorage()
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED)
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(true)
  })

  it('falseを保存すると正しく読み戻せる(往復、明示的にOFFへ切り替えたケース)', () => {
    const storage = new FakeStorage()
    saveMidgameMoveEvalOverlayEnabled(storage, false)
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(false)
  })

  it('trueを保存すると正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    saveMidgameMoveEvalOverlayEnabled(storage, false)
    saveMidgameMoveEvalOverlayEnabled(storage, true)
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(true)
  })

  it('対局モード等の共有キー(MOVE_EVAL_OVERLAY_STORAGE_KEY)とは独立したキーに保存される', () => {
    const storage = new FakeStorage()
    saveMidgameMoveEvalOverlayEnabled(storage, false)
    expect(storage.getItem(MOVE_EVAL_OVERLAY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY)).toBe('false')
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値(true)を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY, '{ this is not valid json')
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED)
  })

  it('真偽値でない値(数値・文字列・null)が保存されていた場合は既定値(true)を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(1))
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED)

    storage.setItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify('true'))
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED)

    storage.setItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(null))
    expect(loadMidgameMoveEvalOverlayEnabled(storage)).toBe(DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED)
  })
})

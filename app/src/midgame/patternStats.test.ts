import { describe, expect, it } from 'vitest'
import {
  loadPatternStats,
  MIDGAME_PATTERN_STATS_STORAGE_KEY,
  recordPatternFailures,
  resetPatternStats,
  savePatternStats,
  topPatternStats,
  type PatternStats,
  type StorageLike,
} from './patternStats.ts'

/** 実際の`localStorage`の代わりに使う、`Map`ベースのフェイク実装(`stageProgress.test.ts`と同じ手法)。 */
class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

describe('loadPatternStats / savePatternStats', () => {
  it('未保存の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    expect(loadPatternStats(storage)).toEqual({})
  })

  it('保存した内容を正しく読み戻せる(往復、リロード後も保持されることの確認)', () => {
    const storage = new FakeStorage()
    const stats: PatternStats = {
      'corner-gift': { failCount: 3, lastAt: '2026-07-17T00:00:00.000Z' },
      'x-c-danger': { failCount: 1, lastAt: '2026-07-16T00:00:00.000Z' },
    }
    savePatternStats(storage, stats)
    // 「リロード」を、新しい`load`呼び出しでシミュレートする(同じ`storage`インスタンスは
    // localStorageと同様に永続化された状態を表す)。
    expect(loadPatternStats(storage)).toEqual(stats)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(MIDGAME_PATTERN_STATS_STORAGE_KEY, '{ this is not valid json')
    expect(loadPatternStats(storage)).toEqual({})
  })

  it('形が不正な値(配列・エントリの型違反)の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()

    storage.setItem(MIDGAME_PATTERN_STATS_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadPatternStats(storage)).toEqual({})

    storage.setItem(
      MIDGAME_PATTERN_STATS_STORAGE_KEY,
      JSON.stringify({ 'corner-gift': { failCount: 'not-a-number', lastAt: '2026-07-17T00:00:00.000Z' } }),
    )
    expect(loadPatternStats(storage)).toEqual({})

    storage.setItem(MIDGAME_PATTERN_STATS_STORAGE_KEY, JSON.stringify(null))
    expect(loadPatternStats(storage)).toEqual({})
  })

  it('未知のパターンIDがキーに含まれる場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(
      MIDGAME_PATTERN_STATS_STORAGE_KEY,
      JSON.stringify({ 'not-a-real-pattern': { failCount: 1, lastAt: '2026-07-17T00:00:00.000Z' } }),
    )
    expect(loadPatternStats(storage)).toEqual({})
  })

  it('日時が厳密なtoISOString()形式でない場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(
      MIDGAME_PATTERN_STATS_STORAGE_KEY,
      JSON.stringify({ 'corner-gift': { failCount: 1, lastAt: '2026/07/17' } }),
    )
    expect(loadPatternStats(storage)).toEqual({})
  })

  it('failCountが負の整数の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(
      MIDGAME_PATTERN_STATS_STORAGE_KEY,
      JSON.stringify({ 'corner-gift': { failCount: -1, lastAt: '2026-07-17T00:00:00.000Z' } }),
    )
    expect(loadPatternStats(storage)).toEqual({})
  })
})

describe('recordPatternFailures', () => {
  it('検出された全パターンIDぶん、それぞれfailCountを1ずつ加算する(要件1の核心)', () => {
    const storage = new FakeStorage()
    const stats = recordPatternFailures(
      storage,
      ['corner-gift', 'x-c-danger', 'stable-loss'],
      '2026-07-17T00:00:00.000Z',
    )

    expect(stats['corner-gift']).toEqual({ failCount: 1, lastAt: '2026-07-17T00:00:00.000Z' })
    expect(stats['x-c-danger']).toEqual({ failCount: 1, lastAt: '2026-07-17T00:00:00.000Z' })
    expect(stats['stable-loss']).toEqual({ failCount: 1, lastAt: '2026-07-17T00:00:00.000Z' })
    expect(loadPatternStats(storage)).toEqual(stats)
  })

  it('同じパターンIDで複数回記録すると累積する', () => {
    const storage = new FakeStorage()
    recordPatternFailures(storage, ['corner-gift'], '2026-07-17T00:00:00.000Z')
    const stats = recordPatternFailures(storage, ['corner-gift'], '2026-07-18T00:00:00.000Z')

    expect(stats['corner-gift']).toEqual({ failCount: 2, lastAt: '2026-07-18T00:00:00.000Z' })
  })

  it('パターンIDが空配列の場合は何も書き込まず現状をそのまま返す', () => {
    const storage = new FakeStorage()
    recordPatternFailures(storage, ['corner-gift'], '2026-07-17T00:00:00.000Z')
    const before = loadPatternStats(storage)

    const after = recordPatternFailures(storage, [], '2026-07-18T00:00:00.000Z')
    expect(after).toEqual(before)
    expect(loadPatternStats(storage)).toEqual(before)
  })

  it('他のパターンIDの記録は互いに独立している', () => {
    const storage = new FakeStorage()
    recordPatternFailures(storage, ['corner-gift'], '2026-07-17T00:00:00.000Z')
    const stats = recordPatternFailures(storage, ['x-c-danger'], '2026-07-17T00:01:00.000Z')

    expect(stats['corner-gift']).toEqual({ failCount: 1, lastAt: '2026-07-17T00:00:00.000Z' })
    expect(stats['x-c-danger']).toEqual({ failCount: 1, lastAt: '2026-07-17T00:01:00.000Z' })
  })
})

describe('resetPatternStats', () => {
  it('保存済みの統計を空にする', () => {
    const storage = new FakeStorage()
    recordPatternFailures(storage, ['corner-gift', 'x-c-danger'], '2026-07-17T00:00:00.000Z')
    expect(Object.keys(loadPatternStats(storage)).length).toBeGreaterThan(0)

    const stats = resetPatternStats(storage)
    expect(stats).toEqual({})
    expect(loadPatternStats(storage)).toEqual({})
  })
})

describe('topPatternStats', () => {
  it('記録が無ければ空配列', () => {
    expect(topPatternStats({})).toEqual([])
  })

  it('failCount降順で上位5件のみを返す(要件2)', () => {
    const stats: PatternStats = {
      'corner-gift': { failCount: 3, lastAt: '2026-07-10T00:00:00.000Z' },
      'x-c-danger': { failCount: 5, lastAt: '2026-07-11T00:00:00.000Z' },
      'wall-frontier': { failCount: 1, lastAt: '2026-07-12T00:00:00.000Z' },
      'stable-loss': { failCount: 4, lastAt: '2026-07-13T00:00:00.000Z' },
      'missed-corner': { failCount: 2, lastAt: '2026-07-14T00:00:00.000Z' },
      'opponent-pass-missed': { failCount: 6, lastAt: '2026-07-15T00:00:00.000Z' },
    }
    const rows = topPatternStats(stats)

    expect(rows.length).toBe(5)
    expect(rows.map((r) => r.id)).toEqual([
      'opponent-pass-missed',
      'x-c-danger',
      'stable-loss',
      'corner-gift',
      'missed-corner',
    ])
    // 6件目(wall-frontier、failCount最小)は上位5件に含まれない。
    expect(rows.map((r) => r.id)).not.toContain('wall-frontier')
  })

  it('failCountが同数の場合はlastAt降順(より最近の方を先に)で順序を安定させる', () => {
    const stats: PatternStats = {
      'corner-gift': { failCount: 2, lastAt: '2026-07-10T00:00:00.000Z' },
      'x-c-danger': { failCount: 2, lastAt: '2026-07-15T00:00:00.000Z' },
    }
    const rows = topPatternStats(stats)
    expect(rows.map((r) => r.id)).toEqual(['x-c-danger', 'corner-gift'])
  })

  it('limitを指定すればその件数までに絞れる', () => {
    const stats: PatternStats = {
      'corner-gift': { failCount: 3, lastAt: '2026-07-10T00:00:00.000Z' },
      'x-c-danger': { failCount: 2, lastAt: '2026-07-11T00:00:00.000Z' },
    }
    expect(topPatternStats(stats, 1).map((r) => r.id)).toEqual(['corner-gift'])
  })
})

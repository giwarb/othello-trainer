import { describe, expect, it } from 'vitest'
import {
  loadStageProgress,
  recordStageAttempt,
  saveStageProgress,
  stageStatus,
  TSUME_STAGE_PROGRESS_STORAGE_KEY,
  type StageProgress,
  type StorageLike,
} from './stageProgress.ts'

/** 実際の`localStorage`の代わりに使う、`Map`ベースのフェイク実装(`judgeModeStorage.test.ts`と同じ手法)。 */
class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

describe('loadStageProgress / saveStageProgress', () => {
  it('未保存の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('保存した内容を正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    const progress: StageProgress = {
      'tsume-1': {
        firstClearedAt: '2026-07-17T00:00:00.000Z',
        lastClearedAt: '2026-07-17T00:00:00.000Z',
        clearCount: 1,
        failCount: 0,
        lastAttemptAt: '2026-07-17T00:00:00.000Z',
        lastResult: 'clear',
      },
    }
    saveStageProgress(storage, progress)
    expect(loadStageProgress(storage)).toEqual(progress)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(TSUME_STAGE_PROGRESS_STORAGE_KEY, '{ this is not valid json')
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('形が不正な値(配列・エントリの型違反)の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()

    storage.setItem(TSUME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadStageProgress(storage)).toEqual({})

    storage.setItem(
      TSUME_STAGE_PROGRESS_STORAGE_KEY,
      JSON.stringify({ 'tsume-1': { clearCount: 'not-a-number' } }),
    )
    expect(loadStageProgress(storage)).toEqual({})

    storage.setItem(TSUME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(null))
    expect(loadStageProgress(storage)).toEqual({})
  })
})

describe('recordStageAttempt', () => {
  it('新規IDへの初回クリアで、クリア日時・クリア回数が正しく設定される', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-17T00:00:00.000Z')

    expect(progress['tsume-1']).toEqual({
      firstClearedAt: '2026-07-17T00:00:00.000Z',
      lastClearedAt: '2026-07-17T00:00:00.000Z',
      clearCount: 1,
      failCount: 0,
      lastAttemptAt: '2026-07-17T00:00:00.000Z',
      lastResult: 'clear',
    })
    // 保存もされている(読み戻しでも同じ内容)。
    expect(loadStageProgress(storage)).toEqual(progress)
  })

  it('新規IDへの初回失敗で、クリア日時はnullのまま失敗回数のみ増える', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, 'tsume-1', 'fail', '2026-07-17T00:00:00.000Z')

    expect(progress['tsume-1']).toEqual({
      firstClearedAt: null,
      lastClearedAt: null,
      clearCount: 0,
      failCount: 1,
      lastAttemptAt: '2026-07-17T00:00:00.000Z',
      lastResult: 'fail',
    })
  })

  it('firstClearedAtは初回クリア時刻のまま保持され、lastClearedAtは直近のクリア時刻に更新される', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-18T00:00:00.000Z')

    expect(progress['tsume-1']).toEqual({
      firstClearedAt: '2026-07-17T00:00:00.000Z',
      lastClearedAt: '2026-07-18T00:00:00.000Z',
      clearCount: 2,
      failCount: 0,
      lastAttemptAt: '2026-07-18T00:00:00.000Z',
      lastResult: 'clear',
    })
  })

  it('クリア後に失敗しても、firstClearedAt/lastClearedAt/clearCountは失われない(一度クリアした記録は残る)', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'tsume-1', 'fail', '2026-07-18T00:00:00.000Z')

    expect(progress['tsume-1']).toEqual({
      firstClearedAt: '2026-07-17T00:00:00.000Z',
      lastClearedAt: '2026-07-17T00:00:00.000Z',
      clearCount: 1,
      failCount: 1,
      lastAttemptAt: '2026-07-18T00:00:00.000Z',
      lastResult: 'fail',
    })
  })

  it('別のIDの記録は互いに独立している', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'tsume-2', 'fail', '2026-07-17T00:01:00.000Z')

    expect(progress['tsume-1']?.clearCount).toBe(1)
    expect(progress['tsume-2']).toEqual({
      firstClearedAt: null,
      lastClearedAt: null,
      clearCount: 0,
      failCount: 1,
      lastAttemptAt: '2026-07-17T00:01:00.000Z',
      lastResult: 'fail',
    })
  })

  it('nowを省略すると現在時刻(ISO文字列)が使われる', () => {
    const storage = new FakeStorage()
    const before = Date.now()
    const progress = recordStageAttempt(storage, 'tsume-1', 'clear')
    const after = Date.now()

    const recordedAt = new Date(progress['tsume-1']!.lastAttemptAt).getTime()
    expect(recordedAt).toBeGreaterThanOrEqual(before)
    expect(recordedAt).toBeLessThanOrEqual(after)
  })
})

describe('stageStatus', () => {
  it('記録が無いIDはunattempted', () => {
    expect(stageStatus({}, 'tsume-1')).toBe('unattempted')
  })

  it('クリア回数0で失敗記録のみあればattempted', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, 'tsume-1', 'fail')
    expect(stageStatus(progress, 'tsume-1')).toBe('attempted')
  })

  it('クリア回数1回以上あればcleared', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, 'tsume-1', 'clear')
    expect(stageStatus(progress, 'tsume-1')).toBe('cleared')
  })

  it('クリア後に失敗を挟んでもclearedのまま(一度クリアした実績は失われない)', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'tsume-1', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'tsume-1', 'fail', '2026-07-18T00:00:00.000Z')
    expect(stageStatus(progress, 'tsume-1')).toBe('cleared')
  })

  it('現存しないID(puzzles.json再生成でIDが変わった場合を想定)のレコードがあってもエラーにならず、無関係のID照会に影響しない(要件5)', () => {
    const storage = new FakeStorage()
    // 「もう存在しないID」の記録が紛れ込んでいる状況をシミュレートする。
    recordStageAttempt(storage, 'tsume-old-removed', 'clear', '2026-07-01T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'tsume-2', 'clear', '2026-07-17T00:00:00.000Z')

    // 現存しないIDを問い合わせても例外にならない(単に見つからない=unattempted相当ではなく、
    // 記録自体はあるのでclearedを返す。「現存しない」かどうかの判定はプール側の責務であり、
    // 本モジュールはIDの実在性を検証しないという設計を確認する)。
    expect(() => stageStatus(progress, 'tsume-old-removed')).not.toThrow()
    expect(stageStatus(progress, 'tsume-old-removed')).toBe('cleared')
    // 現在存在するIDの照会は正しく機能する。
    expect(stageStatus(progress, 'tsume-2')).toBe('cleared')
    // 記録が無い全く未知のIDはunattempted。
    expect(stageStatus(progress, 'tsume-unknown')).toBe('unattempted')
  })
})

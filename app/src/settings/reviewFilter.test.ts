import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_FILTER,
  loadReviewFilter,
  matchesReviewFilter,
  MIDGAME_REVIEW_FILTER_STORAGE_KEY,
  REVIEW_FILTER_OPTIONS,
  saveReviewFilter,
  TSUME_REVIEW_FILTER_STORAGE_KEY,
  type ReviewFilter,
  type StorageLike,
} from './reviewFilter.ts'

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

describe('loadReviewFilter / saveReviewFilter', () => {
  it('未保存の場合は既定値(all)を返す', () => {
    const storage = new FakeStorage()
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(DEFAULT_REVIEW_FILTER)
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe('all')
  })

  it.each(REVIEW_FILTER_OPTIONS.map((option) => option.value))('%sを保存すると正しく読み戻せる(往復)', (filter) => {
    const storage = new FakeStorage()
    saveReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY, filter)
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(filter)
  })

  it('詰めオセロ・中盤練習のキーは互いに独立している', () => {
    const storage = new FakeStorage()
    saveReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY, 'hasFailure')
    saveReviewFilter(storage, MIDGAME_REVIEW_FILTER_STORAGE_KEY, 'cleared')

    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe('hasFailure')
    expect(loadReviewFilter(storage, MIDGAME_REVIEW_FILTER_STORAGE_KEY)).toBe('cleared')
  })

  it('別のstorageインスタンス間でも次回起動時に保持される(往復のシミュレーション)', () => {
    const storage1 = new FakeStorage()
    saveReviewFilter(storage1, TSUME_REVIEW_FILTER_STORAGE_KEY, 'uncleared')

    const storage2 = new FakeStorage()
    storage2.setItem(TSUME_REVIEW_FILTER_STORAGE_KEY, storage1.getItem(TSUME_REVIEW_FILTER_STORAGE_KEY)!)
    expect(loadReviewFilter(storage2, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe('uncleared')
  })

  it('壊れたJSONが保存されていた場合は例外を投げず既定値を返す', () => {
    const storage = new FakeStorage()
    storage.setItem(TSUME_REVIEW_FILTER_STORAGE_KEY, '{ this is not valid json')
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(DEFAULT_REVIEW_FILTER)
  })

  it('既知のフィルタ値でない場合は既定値を返す', () => {
    const storage = new FakeStorage()

    storage.setItem(TSUME_REVIEW_FILTER_STORAGE_KEY, JSON.stringify('not-a-filter'))
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(DEFAULT_REVIEW_FILTER)

    storage.setItem(TSUME_REVIEW_FILTER_STORAGE_KEY, JSON.stringify(1))
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(DEFAULT_REVIEW_FILTER)

    storage.setItem(TSUME_REVIEW_FILTER_STORAGE_KEY, JSON.stringify(null))
    expect(loadReviewFilter(storage, TSUME_REVIEW_FILTER_STORAGE_KEY)).toBe(DEFAULT_REVIEW_FILTER)
  })
})

describe('matchesReviewFilter', () => {
  const cases: readonly [ReviewableStatusForTest, number, ReviewFilter, boolean][] = [
    // all: 常に一致
    ['unattempted', 0, 'all', true],
    ['attempted', 3, 'all', true],
    ['cleared', 0, 'all', true],

    // unattempted: 状態が未挑戦のときのみ
    ['unattempted', 0, 'unattempted', true],
    ['attempted', 0, 'unattempted', false],
    ['cleared', 0, 'unattempted', false],

    // hasFailure: 失敗回数のみで判定(状態は問わない)
    ['unattempted', 0, 'hasFailure', false],
    ['attempted', 1, 'hasFailure', true],
    ['cleared', 0, 'hasFailure', false],
    ['cleared', 2, 'hasFailure', true], // クリア済みでも過去に失敗していれば対象

    // uncleared: クリア済みでない(未挑戦・挑戦済み未クリアの両方を含む)
    ['unattempted', 0, 'uncleared', true],
    ['attempted', 1, 'uncleared', true],
    ['cleared', 0, 'uncleared', false],

    // cleared: クリア済みのみ
    ['unattempted', 0, 'cleared', false],
    ['attempted', 1, 'cleared', false],
    ['cleared', 0, 'cleared', true],
  ]

  it.each(cases)('status=%s, failCount=%i, filter=%s -> %s', (status, failCount, filter, expected) => {
    expect(matchesReviewFilter(status, failCount, filter)).toBe(expected)
  })
})

type ReviewableStatusForTest = 'unattempted' | 'attempted' | 'cleared'

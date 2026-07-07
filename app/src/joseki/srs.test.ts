import { describe, expect, it } from 'vitest'
import { createInitialSrsState, isDue, MAX_EASE, MIN_EASE, nextSrsState, toDateKey } from './srs.ts'

describe('toDateKey', () => {
  it('YYYY-MM-DD形式のローカル日付文字列を返す', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(toDateKey(new Date(2026, 10, 23))).toBe('2026-11-23')
  })
})

describe('createInitialSrsState', () => {
  it('interval=0, streak=0, fails=0, dueDateは当日で初期化される', () => {
    const now = new Date(2026, 6, 7)
    const state = createInitialSrsState('虎', now)
    expect(state.lineId).toBe('虎')
    expect(state.interval).toBe(0)
    expect(state.streak).toBe(0)
    expect(state.fails).toBe(0)
    expect(state.dueDate).toBe('2026-07-07')
    expect(state.lastReviewedAt).toBeNull()
  })
})

describe('nextSrsState', () => {
  it('正解(success)を記録すると、次回出題日が延びる(intervalが増える)', () => {
    const now = new Date(2026, 6, 7)
    const first = nextSrsState(null, '虎', 'success', now)
    expect(first.interval).toBeGreaterThan(0)
    expect(first.streak).toBe(1)
    expect(first.dueDate > toDateKey(now)).toBe(true)

    const later = new Date(2026, 6, 8)
    const second = nextSrsState(first, '虎', 'success', later)
    expect(second.interval).toBeGreaterThan(first.interval)
    expect(second.streak).toBe(2)
    expect(second.dueDate > toDateKey(later)).toBe(true)
    // ease factorは上限でクランプされる。
    expect(second.ease).toBeLessThanOrEqual(MAX_EASE)
  })

  it('失敗(fail)を記録すると、intervalが短くリセットされ近い将来に再出題される', () => {
    const now = new Date(2026, 6, 7)
    // まず何度か正解させてintervalを伸ばす。
    let state = nextSrsState(null, '虎', 'success', now)
    state = nextSrsState(state, '虎', 'success', new Date(2026, 6, 8))
    state = nextSrsState(state, '虎', 'success', new Date(2026, 6, 10))
    expect(state.interval).toBeGreaterThan(1)

    const failedAt = new Date(2026, 6, 20)
    const failed = nextSrsState(state, '虎', 'fail', failedAt)
    expect(failed.interval).toBe(1)
    expect(failed.streak).toBe(0)
    expect(failed.fails).toBe(state.fails + 1)
    expect(failed.dueDate).toBe(toDateKey(new Date(2026, 6, 21)))
    // ease factorは下限でクランプされる。
    expect(failed.ease).toBeGreaterThanOrEqual(MIN_EASE)
  })

  it('easeは何度失敗してもMIN_EASE未満にならない', () => {
    let state = createInitialSrsState('虎', new Date(2026, 0, 1))
    for (let i = 0; i < 50; i++) {
      state = nextSrsState(state, '虎', 'fail', new Date(2026, 0, 1 + i))
    }
    expect(state.ease).toBeGreaterThanOrEqual(MIN_EASE)
  })

  it('easeは何度正解してもMAX_EASEを超えない', () => {
    let state = createInitialSrsState('虎', new Date(2026, 0, 1))
    for (let i = 0; i < 50; i++) {
      state = nextSrsState(state, '虎', 'success', new Date(2026, 0, 1 + i))
    }
    expect(state.ease).toBeLessThanOrEqual(MAX_EASE)
  })
})

describe('isDue', () => {
  it('未挑戦(undefined/null)は常に出題対象', () => {
    expect(isDue(undefined)).toBe(true)
    expect(isDue(null)).toBe(true)
  })

  it('dueDateが今日以前なら出題対象、未来なら対象外', () => {
    const now = new Date(2026, 6, 7)
    const due = createInitialSrsState('虎', new Date(2026, 6, 5))
    expect(isDue(due, now)).toBe(true)

    const future = nextSrsState(due, '虎', 'success', now)
    expect(isDue(future, now)).toBe(false)
  })
})

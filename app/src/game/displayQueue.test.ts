import { describe, expect, it, vi } from 'vitest'
import { createDisplaySequencer } from './displayQueue.ts'

/**
 * `createDisplaySequencer`(T134)の単体テスト。
 *
 * `app.tsx`のPlayModeでは、CPUの応手(`game`)は即座に確定してよいが、
 * `<Board>`への反映(`displayGame`)は直前の反転アニメーション完了+短い間まで
 * 待たせたい。この待ち時間の直列化ロジック自体はDOM/WASMに依存しない純粋な
 * キューとして切り出してあるため、`vi.useFakeTimers()`で決定的にテストする。
 */
describe('createDisplaySequencer', () => {
  it('アイドル中にpushした値は待ちなしで即座に反映される', () => {
    vi.useFakeTimers()
    try {
      const applied: number[] = []
      const seq = createDisplaySequencer<number>((v) => applied.push(v), 300)

      seq.push(1)

      // タイマーを一切進めなくても、アイドル中の最初のpushは即座に反映される
      // (人間が自分でクリックした直後の着手は待たされない、という要件)。
      expect(applied).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('直前の反映からdelayMs経過するまで、次のpushは反映されない', () => {
    vi.useFakeTimers()
    try {
      const applied: number[] = []
      const seq = createDisplaySequencer<number>((v) => applied.push(v), 300)

      seq.push(1)
      expect(applied).toEqual([1])

      seq.push(2)
      // 直前(1)の反映からまだ300ms経っていないので、2はまだ反映されない
      // (CPUの応手が確定していても、自分の返しアニメーション中は画面に出さない)。
      expect(applied).toEqual([1])

      vi.advanceTimersByTime(299)
      expect(applied).toEqual([1])

      vi.advanceTimersByTime(1)
      // ちょうど300ms経過した時点で反映される。
      expect(applied).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('複数回連続でpushしても、反映は重ならず順番に1つずつ処理される(パス連打を想定)', () => {
    vi.useFakeTimers()
    try {
      const applied: number[] = []
      const seq = createDisplaySequencer<number>((v) => applied.push(v), 100)

      // 人間の着手直後、CPUがパスを挟んで連続で2手指した状況を想定
      // (3回連続push)。
      seq.push(1)
      seq.push(2)
      seq.push(3)
      expect(applied).toEqual([1])

      vi.advanceTimersByTime(100)
      expect(applied).toEqual([1, 2])

      // この時点でまだ3つ目は反映されていない(2の反映からまだ100ms経っていない)。
      vi.advanceTimersByTime(99)
      expect(applied).toEqual([1, 2])

      vi.advanceTimersByTime(1)
      expect(applied).toEqual([1, 2, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset()はキュー・保留中のタイマーを破棄し、待ちなしで即座に値を反映する(新規対局開始用)', () => {
    vi.useFakeTimers()
    try {
      const applied: number[] = []
      const seq = createDisplaySequencer<number>((v) => applied.push(v), 300)

      seq.push(1)
      seq.push(2) // まだ反映されず保留中
      expect(applied).toEqual([1])

      seq.reset(100)
      // reset直後に即座に反映される。
      expect(applied).toEqual([1, 100])

      // resetで保留中だった2は破棄されているので、タイマーを進めても反映されない。
      vi.advanceTimersByTime(1000)
      expect(applied).toEqual([1, 100])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset()の直後にpushすると、アイドルからの再開として即座に反映される', () => {
    vi.useFakeTimers()
    try {
      const applied: number[] = []
      const seq = createDisplaySequencer<number>((v) => applied.push(v), 300)

      seq.push(1)
      seq.reset(0)
      seq.push(2)

      expect(applied).toEqual([1, 0, 2])
    } finally {
      vi.useRealTimers()
    }
  })
})

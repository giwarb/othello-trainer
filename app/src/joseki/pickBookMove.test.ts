import { describe, expect, it } from 'vitest'
import { pickBookMove } from './pickBookMove.ts'
import type { JosekiBookMoveView } from './lookup.ts'

describe('pickBookMove', () => {
  it('候補が1つだけならそれを返す', () => {
    const bookMoves: JosekiBookMoveView[] = [{ move: 10, weight: 1 }]
    expect(pickBookMove(bookMoves, () => 0)).toBe(10)
    expect(pickBookMove(bookMoves, () => 0.999)).toBe(10)
  })

  it('乱数値に応じて閾値を跨いだ候補を選ぶ(均等重み)', () => {
    const bookMoves: JosekiBookMoveView[] = [
      { move: 1, weight: 0.5 },
      { move: 2, weight: 0.5 },
    ]
    // random()=0 -> threshold=0 -> 最初の候補(move=1)の時点でthreshold=0-0.5=-0.5<=0
    expect(pickBookMove(bookMoves, () => 0)).toBe(1)
    // random()に近い1 -> threshold=1*1=1 -> move=1で0.5残り、move=2で-0.5<=0
    expect(pickBookMove(bookMoves, () => 0.999)).toBe(2)
  })

  it('weightに比例した分布になる(統計的検証、多数回試行)', () => {
    const bookMoves: JosekiBookMoveView[] = [
      { move: 1, weight: 1 },
      { move: 2, weight: 3 },
    ]
    const counts = new Map<number, number>()
    const trials = 20000
    for (let i = 0; i < trials; i++) {
      const move = pickBookMove(bookMoves)
      counts.set(move, (counts.get(move) ?? 0) + 1)
    }

    const ratio1 = (counts.get(1) ?? 0) / trials
    const ratio2 = (counts.get(2) ?? 0) / trials
    // 期待比率は 1:3 (0.25 / 0.75)。統計的揺らぎを見込んで幅を持たせて検証する。
    expect(ratio1).toBeGreaterThan(0.2)
    expect(ratio1).toBeLessThan(0.3)
    expect(ratio2).toBeGreaterThan(0.7)
    expect(ratio2).toBeLessThan(0.8)
  })

  it('3択が均等重みならおおよそ1/3ずつに分布する(統計的検証)', () => {
    const bookMoves: JosekiBookMoveView[] = [
      { move: 1, weight: 1 / 3 },
      { move: 2, weight: 1 / 3 },
      { move: 3, weight: 1 / 3 },
    ]
    const counts = new Map<number, number>()
    const trials = 30000
    for (let i = 0; i < trials; i++) {
      const move = pickBookMove(bookMoves)
      counts.set(move, (counts.get(move) ?? 0) + 1)
    }

    for (const move of [1, 2, 3]) {
      const ratio = (counts.get(move) ?? 0) / trials
      expect(ratio).toBeGreaterThan(0.28)
      expect(ratio).toBeLessThan(0.38)
    }
  })

  it('空配列を渡すと例外を投げる', () => {
    expect(() => pickBookMove([])).toThrow(RangeError)
  })
})

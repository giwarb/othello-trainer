import { describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { pickOpponentMove } from './pickOpponentMove.ts'

function moveEval(move: string, discDiff: number): MoveEvalJson {
  return { move, score: discDiff * 100, discDiff, type: 'midgame' }
}

describe('pickOpponentMove', () => {
  it('allMovesが空ならnullを返す', () => {
    expect(pickOpponentMove([], 'best')).toBeNull()
    expect(pickOpponentMove([], 'top3Random')).toBeNull()
  })

  describe("strength: 'best'", () => {
    it('常に評価値(discDiff)が最大の手を返す', () => {
      const allMoves = [moveEval('d3', 1), moveEval('c4', 5), moveEval('f5', 3)]
      // randomを呼び出すはずがないので、呼ばれたら例外を投げるフェイクを渡して検証する。
      const random = () => {
        throw new Error('best mode should not consult random()')
      }
      expect(pickOpponentMove(allMoves, 'best', random)).toBe('c4')
    })

    it('合法手が1つだけでもその手を返す', () => {
      const allMoves = [moveEval('d3', 0)]
      expect(pickOpponentMove(allMoves, 'best')).toBe('d3')
    })
  })

  describe("strength: 'top3Random'", () => {
    it('上位3手の中からrandomの値に応じて選ぶ(境界値の確認)', () => {
      const allMoves = [moveEval('a', 5), moveEval('b', 4), moveEval('c', 3), moveEval('d', 1)]
      // ソート後: a(5), b(4), c(3), d(1) の上位3つ = a,b,c。dは対象外。
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0)).toBe('a')
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0.34)).toBe('b')
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0.67)).toBe('c')
      // 1未満だが3番目の区間の上限付近でも3手目(c)に収まる。
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0.999)).toBe('c')
      // dが選ばれないことを確認。
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0.999)).not.toBe('d')
    })

    it('合法手が3手未満ならその全てが対象になる', () => {
      const allMoves = [moveEval('a', 5), moveEval('b', 4)]
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0)).toBe('a')
      expect(pickOpponentMove(allMoves, 'top3Random', () => 0.99)).toBe('b')
    })

    it('統計的検証: 十分な試行回数で上位3手それぞれがおおよそ均等に選ばれる', () => {
      const allMoves = [moveEval('a', 5), moveEval('b', 4), moveEval('c', 3), moveEval('d', 1)]
      const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }
      const trials = 3000

      // 決定的な擬似乱数列(線形合同法)でtrials回試行する。
      let seed = 12345
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
      }

      for (let i = 0; i < trials; i++) {
        const move = pickOpponentMove(allMoves, 'top3Random', random)
        counts[move!] = (counts[move!] ?? 0) + 1
      }

      // dは上位3手に含まれないため一度も選ばれない。
      expect(counts.d).toBe(0)
      // a/b/cはそれぞれ概ね trials/3 に近い回数選ばれる(統計的なブレを許容する幅を持たせる)。
      const expected = trials / 3
      for (const key of ['a', 'b', 'c']) {
        expect(counts[key]).toBeGreaterThan(expected * 0.7)
        expect(counts[key]).toBeLessThan(expected * 1.3)
      }
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { judgeMidgameMove, STANDARD_LOSS_THRESHOLD } from './judgeMidgameMove.ts'

function moveEval(move: string, discDiff: number, type: 'midgame' | 'exact' = 'midgame'): MoveEvalJson {
  return { move, score: discDiff * 100, discDiff, type }
}

describe('judgeMidgameMove', () => {
  describe('strict mode(最善手のみ正解)', () => {
    const allMoves = [moveEval('d3', 4), moveEval('c4', 2), moveEval('f5', -1)]

    it('最善手を打てば正解', () => {
      const result = judgeMidgameMove({ mode: 'strict', allMoves, playedMove: 'd3' })
      expect(result.correct).toBe(true)
      expect(result.reasonKind).toBe('ok')
      expect(result.lossDiscs).toBe(0)
      expect(result.bestMove).toBe('d3')
    })

    it('最善手より僅かでも劣る手を打てば失敗', () => {
      const result = judgeMidgameMove({ mode: 'strict', allMoves, playedMove: 'c4' })
      expect(result.correct).toBe(false)
      expect(result.reasonKind).toBe('notBest')
      expect(result.lossDiscs).toBeCloseTo(2)
    })
  })

  describe('standard mode(石差ロス1.0以内は正解)', () => {
    const allMoves = [moveEval('d3', 5), moveEval('c4', 4.2), moveEval('f5', 3)]

    it('ロスがちょうど閾値(1.0)以内なら正解', () => {
      const result = judgeMidgameMove({ mode: 'standard', allMoves, playedMove: 'c4' })
      expect(result.lossDiscs).toBeCloseTo(0.8)
      expect(result.correct).toBe(true)
      expect(result.reasonKind).toBe('ok')
    })

    it('ロスが閾値ちょうど(1.0)でも正解(<=判定)', () => {
      const allMovesExact = [moveEval('d3', 5), moveEval('e3', 4)]
      const result = judgeMidgameMove({ mode: 'standard', allMoves: allMovesExact, playedMove: 'e3' })
      expect(result.lossDiscs).toBeCloseTo(STANDARD_LOSS_THRESHOLD)
      expect(result.correct).toBe(true)
    })

    it('ロスが閾値を超えたら失敗', () => {
      const result = judgeMidgameMove({ mode: 'standard', allMoves, playedMove: 'f5' })
      expect(result.lossDiscs).toBeCloseTo(2)
      expect(result.correct).toBe(false)
      expect(result.reasonKind).toBe('lossExceeded')
    })
  })

  describe('noReversal mode(評価の符号が変わったら失敗)', () => {
    it('着手前後とも優勢(符号+のまま)なら正解', () => {
      // 最善手(d3)の評価が+3(優勢)、実際に打ったc4の評価も+1(優勢を維持)。
      const allMoves = [moveEval('d3', 3), moveEval('c4', 1)]
      const result = judgeMidgameMove({ mode: 'noReversal', allMoves, playedMove: 'c4' })
      expect(result.preSign).toBe(1)
      expect(result.nextSign).toBe(1)
      expect(result.correct).toBe(true)
      expect(result.reasonKind).toBe('ok')
    })

    it('着手前は優勢だったのに着手後は劣勢に転じたら失敗(逆転)', () => {
      const allMoves = [moveEval('d3', 3), moveEval('c4', -2)]
      const result = judgeMidgameMove({ mode: 'noReversal', allMoves, playedMove: 'c4' })
      expect(result.preSign).toBe(1)
      expect(result.nextSign).toBe(-1)
      expect(result.correct).toBe(false)
      expect(result.reasonKind).toBe('reversed')
    })

    it('着手前が劣勢で着手後も劣勢のまま(符号-のまま)なら正解', () => {
      const allMoves = [moveEval('d3', -1), moveEval('c4', -3)]
      const result = judgeMidgameMove({ mode: 'noReversal', allMoves, playedMove: 'c4' })
      expect(result.preSign).toBe(-1)
      expect(result.nextSign).toBe(-1)
      expect(result.correct).toBe(true)
    })

    it('最善手の評価が0(互角)のとき、直前の符号(previousSign)を維持する', () => {
      // best(d3)の評価は0(互角)。previousSign=1(直前は優勢)を渡すと、preSignは1として扱われる。
      // 実際に打った手(c4)の評価も0(互角)なので、nextSignもpreSignを維持して1のまま => 逆転なし。
      const allMoves = [moveEval('d3', 0), moveEval('c4', 0)]
      const result = judgeMidgameMove({ mode: 'noReversal', allMoves, playedMove: 'c4', previousSign: 1 })
      expect(result.preSign).toBe(1)
      expect(result.nextSign).toBe(1)
      expect(result.correct).toBe(true)
    })

    it('previousSignを渡さない(未確定=0)場合、着手後に符号が確定するだけでは逆転扱いにしない', () => {
      const allMoves = [moveEval('d3', 0), moveEval('c4', -2)]
      const result = judgeMidgameMove({ mode: 'noReversal', allMoves, playedMove: 'c4' })
      expect(result.preSign).toBe(0)
      expect(result.nextSign).toBe(-1)
      // preSignが0(互角/未確定)の場合は「反転」とはみなさない仕様。
      expect(result.correct).toBe(true)
    })
  })

  describe('エッジケース', () => {
    it('allMovesが空(合法手なし)ならnoLegalMovesで失敗', () => {
      const result = judgeMidgameMove({ mode: 'standard', allMoves: [], playedMove: 'd3' })
      expect(result.correct).toBe(false)
      expect(result.reasonKind).toBe('noLegalMoves')
    })

    it('打った手がallMovesに見つからない場合はmoveNotFoundで失敗', () => {
      const allMoves = [moveEval('d3', 3), moveEval('c4', 1)]
      const result = judgeMidgameMove({ mode: 'standard', allMoves, playedMove: 'e6' })
      expect(result.correct).toBe(false)
      expect(result.reasonKind).toBe('moveNotFound')
      expect(result.playedDiscDiff).toBeNull()
    })
  })
})

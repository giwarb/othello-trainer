import { describe, expect, it } from 'vitest'
import { countMarginMoves, MARGIN_MOVE_LOSS_THRESHOLD } from './marginMoves.ts'

describe('analysis/marginMoves: countMarginMoves (特徴量10「余裕手」)', () => {
  it('最善手からのロスが0.5石未満の手だけを数える', () => {
    const moveEvals = [
      { discDiff: 2.4 }, // 最善(ロス0)
      { discDiff: 2.0 }, // ロス0.4 -> 余裕手
      { discDiff: 1.95 }, // ロス0.45 -> 余裕手
      { discDiff: 1.9 }, // ロス0.5 -> 余裕手ではない(閾値未満のみ、境界は含まない)
      { discDiff: 0.0 }, // ロス2.4 -> 余裕手ではない
    ]
    expect(countMarginMoves(moveEvals)).toBe(3)
  })

  it('境界値(ロスがちょうど0.5)は余裕手に含まない', () => {
    const moveEvals = [{ discDiff: 1.0 }, { discDiff: 0.5 }]
    expect(countMarginMoves(moveEvals)).toBe(1)
  })

  it('全ての手が最善手と同点なら、全手が余裕手になる', () => {
    const moveEvals = [{ discDiff: 1.0 }, { discDiff: 1.0 }, { discDiff: 1.0 }]
    expect(countMarginMoves(moveEvals)).toBe(3)
  })

  it('合法手が1つだけなら、その手は必ず余裕手(ロス0)', () => {
    expect(countMarginMoves([{ discDiff: -3.2 }])).toBe(1)
  })

  it('合法手が無い(空配列)場合は0を返す', () => {
    expect(countMarginMoves([])).toBe(0)
  })

  it('負の評価値が混在していても、最善手からの相対ロスで正しく判定する', () => {
    const moveEvals = [
      { discDiff: -1.0 }, // 最善(この局面では全て不利)
      { discDiff: -1.3 }, // ロス0.3 -> 余裕手
      { discDiff: -4.0 }, // ロス3.0 -> 余裕手ではない
    ]
    expect(countMarginMoves(moveEvals)).toBe(2)
  })

  it('閾値定数は設計書どおり0.5石', () => {
    expect(MARGIN_MOVE_LOSS_THRESHOLD).toBe(0.5)
  })
})

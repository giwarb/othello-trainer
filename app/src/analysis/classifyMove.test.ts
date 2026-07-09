import { describe, expect, it } from 'vitest'
import { classifyMove, DEFAULT_CLASSIFY_THRESHOLDS } from './classifyMove.ts'

describe('analysis/classifyMove', () => {
  it('ロスが0なら最善/準最善(best)', () => {
    expect(classifyMove(0)).toBe('best')
  })

  it('ロスが1.0未満ならbest(境界値: 0.99)', () => {
    expect(classifyMove(0.99)).toBe('best')
  })

  it('ロスがちょうど1.0ならinaccuracy(緩手、境界値は含む)', () => {
    expect(classifyMove(1.0)).toBe('inaccuracy')
  })

  it('ロスが1.0〜3.0未満ならinaccuracy', () => {
    expect(classifyMove(2.5)).toBe('inaccuracy')
    expect(classifyMove(2.99)).toBe('inaccuracy')
  })

  it('ロスがちょうど3.0ならdubious(疑問手、境界値は含む)', () => {
    expect(classifyMove(3.0)).toBe('dubious')
  })

  it('ロスが3.0〜6.0未満ならdubious', () => {
    expect(classifyMove(4.5)).toBe('dubious')
    expect(classifyMove(5.99)).toBe('dubious')
  })

  it('ロスがちょうど6.0ならblunder(悪手、境界値は含む)', () => {
    expect(classifyMove(6.0)).toBe('blunder')
  })

  it('ロスが6.0を超えてもblunder', () => {
    expect(classifyMove(10)).toBe('blunder')
    expect(classifyMove(64)).toBe('blunder')
  })

  it('カスタム閾値を指定できる', () => {
    const thresholds = { inaccuracy: 0.5, dubious: 2, blunder: 4 }
    expect(classifyMove(0.4, thresholds)).toBe('best')
    expect(classifyMove(0.5, thresholds)).toBe('inaccuracy')
    expect(classifyMove(2, thresholds)).toBe('dubious')
    expect(classifyMove(4, thresholds)).toBe('blunder')
  })

  it('デフォルト閾値は設計書どおり1/3/6石', () => {
    expect(DEFAULT_CLASSIFY_THRESHOLDS).toEqual({ inaccuracy: 1, dubious: 3, blunder: 6 })
  })
})

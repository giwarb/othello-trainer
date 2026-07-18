import { describe, expect, it } from 'vitest'
import { computeStageStars, isBestMove } from './stageStarJudge.ts'

function outcome(lossDiscs: number) {
  return { lossDiscs, isBest: isBestMove(lossDiscs) }
}

describe('T141: computeStageStars(★判定)', () => {
  it('損失が5未満なら★1', () => {
    expect(computeStageStars({ startEval: 10, endEval: 5.01, moveOutcomes: [outcome(1), outcome(1), outcome(2)] })).toBe(1)
  })

  it('損失が1未満なら★2', () => {
    expect(computeStageStars({ startEval: 10, endEval: 9.5, moveOutcomes: [outcome(0.5), outcome(0), outcome(0)] })).toBe(2)
  })

  it('3手すべてが最善手なら★3', () => {
    expect(computeStageStars({ startEval: 10, endEval: 10, moveOutcomes: [outcome(0), outcome(0), outcome(0)] })).toBe(3)
  })

  it('損失が5以上ならクリア失敗(★0)', () => {
    expect(computeStageStars({ startEval: 10, endEval: 4.9, moveOutcomes: [outcome(3), outcome(2), outcome(0)] })).toBe(0)
  })

  it('境界値: 損失がちょうど5は★0(★1の条件は「損失<5」で5は含まない)', () => {
    expect(computeStageStars({ startEval: 10, endEval: 5, moveOutcomes: [outcome(5), outcome(0), outcome(0)] })).toBe(0)
  })

  it('境界値: 損失がちょうど1は★1(★2の条件は「損失<1」で1は含まない)', () => {
    expect(computeStageStars({ startEval: 10, endEval: 9, moveOutcomes: [outcome(1), outcome(0), outcome(0)] })).toBe(1)
  })

  it('境界値: 損失が5未満ギリギリ(4.99)は★1', () => {
    expect(computeStageStars({ startEval: 10, endEval: 5.01, moveOutcomes: [outcome(4.99), outcome(0), outcome(0)] })).toBe(1)
  })

  it('境界値: 損失が1未満ギリギリ(0.99)は★2', () => {
    expect(computeStageStars({ startEval: 10, endEval: 9.01, moveOutcomes: [outcome(0.99), outcome(0), outcome(0)] })).toBe(2)
  })

  it('3手未満で終了(打てた分で判定)し全て最善でも、3手そろっていないため★3にはならず損失ベースで判定する', () => {
    // 2手しか打てず(途中終局)、2手とも最善(損失0)だが評価値の推移自体には損失があるケース。
    expect(computeStageStars({ startEval: 10, endEval: 6, moveOutcomes: [outcome(0), outcome(0)] })).toBe(1)
  })

  it('3手未満で終了し、損失も1未満なら★2', () => {
    expect(computeStageStars({ startEval: 10, endEval: 9.5, moveOutcomes: [outcome(0), outcome(0.5)] })).toBe(2)
  })

  it('0手(セッション開始直後に終局)でも損失ベースで判定できる', () => {
    expect(computeStageStars({ startEval: 10, endEval: 10, moveOutcomes: [] })).toBe(2)
  })

  it('負の損失(評価値が向上した)は0に丸められ★2以上になりうる', () => {
    expect(computeStageStars({ startEval: 5, endEval: 8, moveOutcomes: [outcome(0), outcome(0), outcome(0)] })).toBe(3)
  })
})

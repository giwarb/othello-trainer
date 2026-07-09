import { describe, expect, it } from 'vitest'
import {
  computeConceptStats,
  conceptWeight,
  isMoveCorrect,
  isReasonCorrect,
  moveAccuracy,
  pickWeakestConcept,
  reasonAccuracy,
  sortByWeakness,
  type ConceptStat,
} from './conceptStats.ts'
import type { VerbalizeAttemptRecord, VerbalizeCaseKind } from './types.ts'

function makeRecord(overrides: Partial<VerbalizeAttemptRecord> = {}): VerbalizeAttemptRecord {
  return {
    id: `id-${Math.random()}`,
    positionKey: 'pos-1',
    sideToMove: 'black',
    chosenMove: 'd3',
    chosenTags: ['nakawari'],
    freeText: '',
    caseKind: 'correctBoth',
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('verbalize/conceptStats: caseKindからの正誤導出', () => {
  const cases: readonly [VerbalizeCaseKind, boolean, boolean][] = [
    ['correctBoth', true, true],
    ['correctMoveWrongReason', true, false],
    ['wrongMoveCorrectReason', false, true],
    ['wrongBoth', false, false],
  ]
  for (const [caseKind, moveCorrect, reasonCorrect] of cases) {
    it(`${caseKind}: move=${moveCorrect}, reason=${reasonCorrect}`, () => {
      expect(isMoveCorrect(caseKind)).toBe(moveCorrect)
      expect(isReasonCorrect(caseKind)).toBe(reasonCorrect)
    })
  }
})

describe('verbalize/conceptStats: computeConceptStats', () => {
  it('記録が無ければ空のMapを返す', () => {
    expect(computeConceptStats([]).size).toBe(0)
  })

  it('1回の挑戦で選んだ全タグに1回ずつ加算する', () => {
    const records = [makeRecord({ chosenTags: ['nakawari', 'attr-mobility'], caseKind: 'correctBoth' })]
    const stats = computeConceptStats(records)
    expect(stats.size).toBe(2)
    expect(stats.get('nakawari')).toEqual({
      tagId: 'nakawari',
      attempts: 1,
      correct: 1,
      reasonCorrect: 1,
      lastSeen: '2026-07-08T00:00:00.000Z',
    })
    expect(stats.get('attr-mobility')?.attempts).toBe(1)
  })

  it('複数回の挑戦を正しく積算し、最終挑戦日を最新に保つ', () => {
    const records = [
      makeRecord({ chosenTags: ['nakawari'], caseKind: 'correctBoth', createdAt: '2026-07-01T00:00:00.000Z' }),
      makeRecord({ chosenTags: ['nakawari'], caseKind: 'wrongBoth', createdAt: '2026-07-05T00:00:00.000Z' }),
      makeRecord({ chosenTags: ['nakawari'], caseKind: 'wrongMoveCorrectReason', createdAt: '2026-07-03T00:00:00.000Z' }),
    ]
    const stat = computeConceptStats(records).get('nakawari')!
    expect(stat.attempts).toBe(3)
    expect(stat.correct).toBe(1) // correctBothのみ
    expect(stat.reasonCorrect).toBe(2) // correctBoth + wrongMoveCorrectReason
    expect(stat.lastSeen).toBe('2026-07-05T00:00:00.000Z')
  })

  it('タグを選んでいない記録はどのタグにも計上されない', () => {
    const records = [makeRecord({ chosenTags: [] })]
    expect(computeConceptStats(records).size).toBe(0)
  })
})

describe('verbalize/conceptStats: 正答率ヘルパー', () => {
  it('moveAccuracy/reasonAccuracyは挑戦0件でnullを返す', () => {
    const stat: ConceptStat = { tagId: 'x', attempts: 0, correct: 0, reasonCorrect: 0, lastSeen: '' }
    expect(moveAccuracy(stat)).toBeNull()
    expect(reasonAccuracy(stat)).toBeNull()
  })

  it('moveAccuracy/reasonAccuracyは割合を返す', () => {
    const stat: ConceptStat = { tagId: 'x', attempts: 4, correct: 1, reasonCorrect: 3, lastSeen: '' }
    expect(moveAccuracy(stat)).toBe(0.25)
    expect(reasonAccuracy(stat)).toBe(0.75)
  })
})

describe('verbalize/conceptStats: conceptWeight(T036要件6)', () => {
  it('タグが空なら基準重み1を返す', () => {
    expect(conceptWeight([], new Map())).toBe(1)
  })

  it('未挑戦タグのみなら基準重み1を返す(未挑戦=正答率100%扱い)', () => {
    expect(conceptWeight(['unseen'], new Map())).toBe(1)
  })

  it('正答率が低いタグほど重みが大きくなる', () => {
    const stats = new Map<string, ConceptStat>([
      ['weak', { tagId: 'weak', attempts: 10, correct: 1, reasonCorrect: 1, lastSeen: '' }],
      ['strong', { tagId: 'strong', attempts: 10, correct: 10, reasonCorrect: 10, lastSeen: '' }],
    ])
    const weakWeight = conceptWeight(['weak'], stats)
    const strongWeight = conceptWeight(['strong'], stats)
    expect(weakWeight).toBeGreaterThan(strongWeight)
    expect(strongWeight).toBeCloseTo(1, 5) // 2 - 1.0(全問正解) = 1
  })

  it('重みは最小値0.1を下回らない', () => {
    const stats = new Map<string, ConceptStat>([
      ['perfect', { tagId: 'perfect', attempts: 5, correct: 5, reasonCorrect: 5, lastSeen: '' }],
    ])
    // avgAccuracy=1 -> weight=2-1=1、最小値未満になるケースは無いが安全弁の存在だけ確認
    expect(conceptWeight(['perfect'], stats)).toBeGreaterThanOrEqual(0.1)
  })
})

describe('verbalize/conceptStats: sortByWeakness / pickWeakestConcept', () => {
  const stats = new Map<string, ConceptStat>([
    ['a', { tagId: 'a', attempts: 5, correct: 4, reasonCorrect: 4, lastSeen: '' }], // reasonAcc 0.8
    ['b', { tagId: 'b', attempts: 5, correct: 1, reasonCorrect: 1, lastSeen: '' }], // reasonAcc 0.2 (最弱)
    ['c', { tagId: 'c', attempts: 1, correct: 0, reasonCorrect: 0, lastSeen: '' }], // reasonAcc 0だがサンプル不足
  ])

  it('sortByWeaknessは理由正答率の低い順にソートする', () => {
    const sorted = sortByWeakness(stats)
    expect(sorted.map((s) => s.tagId)).toEqual(['c', 'b', 'a'])
  })

  it('pickWeakestConceptはサンプル不足(MIN_ATTEMPTS_FOR_SUMMARY未満)のタグを除外する', () => {
    expect(pickWeakestConcept(stats)?.tagId).toBe('b')
  })

  it('候補が無ければnullを返す', () => {
    expect(pickWeakestConcept(new Map())).toBeNull()
  })
})

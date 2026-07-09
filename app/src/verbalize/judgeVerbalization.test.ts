import { describe, expect, it } from 'vitest'
import type { MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionBreakdown } from '../analysis/types.ts'
import { ATTRIBUTION_TAG_ID } from './reasonTags.ts'
import {
  attributionConcentration,
  computeTargetTags,
  judgeVerbalization,
  TWO_CHOICE_CONCENTRATION_THRESHOLD,
} from './judgeVerbalization.ts'

/** 人工的な評価内訳分解データ(モビリティが支配的、隅・安定石はほぼ0)。 */
function mobilityDominantAttribution(): AttributionBreakdown {
  return {
    terms: [
      { key: 'mobility', label: '着手可能数', delta: 3.0 },
      { key: 'corner', label: '隅', delta: 0.2 },
      { key: 'stable', label: '確定石', delta: 0.1 },
    ],
    total: 3.3,
  }
}

function cornerDominantAttribution(): AttributionBreakdown {
  return {
    terms: [
      { key: 'mobility', label: '着手可能数', delta: 0.1 },
      { key: 'corner', label: '隅', delta: -4.0 },
      { key: 'stable', label: '確定石', delta: 0.0 },
    ],
    total: -3.9,
  }
}

function zeroAttribution(): AttributionBreakdown {
  return {
    terms: [
      { key: 'mobility', label: '着手可能数', delta: 0 },
      { key: 'corner', label: '隅', delta: 0 },
      { key: 'stable', label: '確定石', delta: 0 },
    ],
    total: 0,
  }
}

const NAKAWARI_MOTIF: MotifDefinition = { key: 'nakawari', label: '中割り', kind: 'good' }

describe('verbalize/judgeVerbalization', () => {
  describe('computeTargetTags', () => {
    it('寄与が最大の項のタグと、検出モチーフのキーをあわせて返す', () => {
      const tags = computeTargetTags(mobilityDominantAttribution(), [NAKAWARI_MOTIF])
      expect(tags).toEqual([ATTRIBUTION_TAG_ID.mobility, 'nakawari'])
    })

    it('3項とも差が0なら寄与分解由来のタグは含めない(モチーフのみ)', () => {
      const tags = computeTargetTags(zeroAttribution(), [NAKAWARI_MOTIF])
      expect(tags).toEqual(['nakawari'])
    })

    it('モチーフが無くても寄与分解由来のタグは含める', () => {
      const tags = computeTargetTags(cornerDominantAttribution(), [])
      expect(tags).toEqual([ATTRIBUTION_TAG_ID.corner])
    })
  })

  describe('judgeVerbalization: 2x2の4ケース', () => {
    it('手○理由○ -> correctBoth', () => {
      const result = judgeVerbalization({
        moveCorrect: true,
        chosenTags: [ATTRIBUTION_TAG_ID.mobility],
        attribution: mobilityDominantAttribution(),
        motifs: [NAKAWARI_MOTIF],
      })
      expect(result.caseKind).toBe('correctBoth')
      expect(result.reasonCorrect).toBe(true)
      expect(result.matchedTags).toEqual([ATTRIBUTION_TAG_ID.mobility])
    })

    it('手○理由× -> correctMoveWrongReason(まぐれ当たり検出)', () => {
      const result = judgeVerbalization({
        moveCorrect: true,
        chosenTags: [ATTRIBUTION_TAG_ID.stable],
        attribution: mobilityDominantAttribution(),
        motifs: [],
      })
      expect(result.caseKind).toBe('correctMoveWrongReason')
      expect(result.reasonCorrect).toBe(false)
      expect(result.matchedTags).toEqual([])
    })

    it('手×理由○ -> wrongMoveCorrectReason(着眼は正しい)', () => {
      const result = judgeVerbalization({
        moveCorrect: false,
        chosenTags: ['nakawari'],
        attribution: mobilityDominantAttribution(),
        motifs: [NAKAWARI_MOTIF],
      })
      expect(result.caseKind).toBe('wrongMoveCorrectReason')
      expect(result.reasonCorrect).toBe(true)
    })

    it('手×理由× -> wrongBoth(概念レッスンへ誘導)', () => {
      const result = judgeVerbalization({
        moveCorrect: false,
        chosenTags: [ATTRIBUTION_TAG_ID.corner],
        attribution: mobilityDominantAttribution(),
        motifs: [],
      })
      expect(result.caseKind).toBe('wrongBoth')
      expect(result.reasonCorrect).toBe(false)
    })

    it('選んだタグのうち1つでもtargetTagsと一致すれば理由は正解扱い(複数選択時)', () => {
      const result = judgeVerbalization({
        moveCorrect: true,
        chosenTags: [ATTRIBUTION_TAG_ID.stable, ATTRIBUTION_TAG_ID.mobility, 'block'],
        attribution: mobilityDominantAttribution(),
        motifs: [],
      })
      expect(result.caseKind).toBe('correctBoth')
      expect(result.matchedTags).toEqual([ATTRIBUTION_TAG_ID.mobility])
    })

    it('targetTagsが空(寄与ゼロ・モチーフ無し)なら理由は必ず不正解になる', () => {
      const result = judgeVerbalization({
        moveCorrect: true,
        chosenTags: [ATTRIBUTION_TAG_ID.mobility],
        attribution: zeroAttribution(),
        motifs: [],
      })
      expect(result.targetTags).toEqual([])
      expect(result.caseKind).toBe('correctMoveWrongReason')
    })
  })

  describe('attributionConcentration(二択比較ドリルの局面フィルタ用)', () => {
    it('1項が支配的な場合は1に近い値を返す', () => {
      const concentration = attributionConcentration(mobilityDominantAttribution())
      expect(concentration).toBeGreaterThanOrEqual(TWO_CHOICE_CONCENTRATION_THRESHOLD)
    })

    it('3項が拮抗している場合は閾値未満になる', () => {
      const balanced: AttributionBreakdown = {
        terms: [
          { key: 'mobility', label: '着手可能数', delta: 1 },
          { key: 'corner', label: '隅', delta: 1 },
          { key: 'stable', label: '確定石', delta: 1 },
        ],
        total: 3,
      }
      expect(attributionConcentration(balanced)).toBeCloseTo(1 / 3)
    })

    it('全項0なら0を返す(ゼロ除算しない)', () => {
      expect(attributionConcentration(zeroAttribution())).toBe(0)
    })
  })
})

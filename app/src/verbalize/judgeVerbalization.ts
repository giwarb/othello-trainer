/**
 * T035「言語化トレーニングモード」の採点ロジック(設計書§6.1手順4〜5)。
 *
 * 手の正誤・理由の正誤をそれぞれ独立に判定し、2×2の4ケース(`VerbalizeCaseKind`)に
 * 分類する純粋関数。エンジン呼び出しは行わない(呼び出し側が`judgeMidgameMove`
 * (手の正誤)・`buildAttribution`(T031評価内訳分解)・`detectMotifs`(T032モチーフ検出)
 * の結果を渡す。`whyBad.ts`・`motifs.ts`と同じ設計方針)。
 *
 * 理由の正誤の判定基準(タスク仕様要件4・設計書§6.1手順5、原文引用): 「選んだタグが
 * §1特徴差・§2寄与分解の上位軸と一致するか(=T031の評価内訳分解で最も寄与が大きかった
 * 項、またはT032で検出されたモチーフと、ユーザーが選んだタグが一致するか)」。
 * すなわち選んだタグが1つでも一致すれば理由は正解とみなす。
 */

import type { MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionBreakdown } from '../analysis/types.ts'
import { ATTRIBUTION_TAG_ID } from './reasonTags.ts'
import type { VerbalizeCaseKind } from './types.ts'

/**
 * `attribution`(3項の寄与分解)・`motifs`(検出されたモチーフ)から、「正しい理由」と
 * みなすタグIDの集合を作る(設計書§6.1手順5)。
 *
 * - 寄与分解は絶対値最大の項(=最も寄与が大きかった項)を1つだけ採用する。ただし
 *   その項の`delta`が厳密に0の場合(3項とも差が無かった特殊な局面)は「寄与の軸」
 *   自体が存在しないとみなし含めない。
 * - モチーフは検出された全件のキーをそのまま含める(良い手/悪い手/罠のいずれの
 *   種類かは問わない。設計書§6.1手順5が「§2寄与分解の上位軸」「§4のモチーフ」を
 *   並列に挙げており、モチーフ側には優先順位づけの指定が無いため)。
 */
export function computeTargetTags(
  attribution: AttributionBreakdown,
  motifs: readonly MotifDefinition[],
): string[] {
  const tags = new Set<string>()

  if (attribution.terms.length > 0) {
    const dominant = attribution.terms.reduce((best, term) =>
      Math.abs(term.delta) > Math.abs(best.delta) ? term : best,
    )
    if (Math.abs(dominant.delta) > 0) {
      tags.add(ATTRIBUTION_TAG_ID[dominant.key])
    }
  }

  for (const motif of motifs) {
    tags.add(motif.key)
  }

  return [...tags]
}

export interface JudgeVerbalizationInput {
  /** 手の正誤(`judgeMidgameMove`等、探索ベースの判定結果をそのまま渡す)。 */
  readonly moveCorrect: boolean
  /** ユーザーが選択した理由タグID(1〜3個)。 */
  readonly chosenTags: readonly string[]
  /** 出題局面の最善手についての評価内訳分解(`buildAttribution`の結果)。 */
  readonly attribution: AttributionBreakdown
  /** 出題局面の最善手について検出されたモチーフ(`detectMotifs`の結果)。 */
  readonly motifs: readonly MotifDefinition[]
}

export interface JudgeVerbalizationResult {
  readonly moveCorrect: boolean
  readonly reasonCorrect: boolean
  /** 「正しい理由」とみなされるタグID一覧(フィードバック表示用)。 */
  readonly targetTags: readonly string[]
  /** `chosenTags`のうち`targetTags`と一致したもの。 */
  readonly matchedTags: readonly string[]
  readonly caseKind: VerbalizeCaseKind
}

/** 手の正誤×理由の正誤を2×2で判定する(設計書§6.1手順4)。 */
export function judgeVerbalization(input: JudgeVerbalizationInput): JudgeVerbalizationResult {
  const targetTags = computeTargetTags(input.attribution, input.motifs)
  const matchedTags = input.chosenTags.filter((tag) => targetTags.includes(tag))
  const reasonCorrect = matchedTags.length > 0

  const caseKind: VerbalizeCaseKind = input.moveCorrect
    ? reasonCorrect
      ? 'correctBoth'
      : 'correctMoveWrongReason'
    : reasonCorrect
      ? 'wrongMoveCorrectReason'
      : 'wrongBoth'

  return { moveCorrect: input.moveCorrect, reasonCorrect, targetTags, matchedTags, caseKind }
}

/**
 * `attribution`の3項のうち、絶対値最大の項が寄与の何割を占めるかを返す(0〜1)。
 * 二択比較ドリル(`TwoChoiceDrill.tsx`、要件7)が「差が1概念に集約される局面ペア」
 * (設計書§6.2)をその場でフィルタするために使う。3項の`delta`が全て0なら`0`を返す。
 */
export function attributionConcentration(attribution: AttributionBreakdown): number {
  const abs = attribution.terms.map((term) => Math.abs(term.delta))
  const sum = abs.reduce((a, b) => a + b, 0)
  if (sum === 0) return 0
  return Math.max(...abs) / sum
}

/**
 * 二択比較ドリルで「差が1概念に集約されている」とみなす濃度の閾値(要件7、
 * 設計書§6.2「寄与分解で1グループが差の70%以上を占める局面」をそのまま採用)。
 */
export const TWO_CHOICE_CONCENTRATION_THRESHOLD = 0.7

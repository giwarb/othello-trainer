/**
 * T037「任意LLM解説層」(`othello-trainer-design-verbalization.md` §9・§10)の
 * 構造化入力組み立て関数。
 *
 * T031(`attribution.ts`)・T032(`motifs.ts`)・T033(`refutation.ts`)・
 * 比較PV(T030、`comparePv.ts`)の既存出力を、LLMに渡す`StructuredCommentaryInput`
 * (`types.ts`)へ変換するだけの純粋関数群。エンジン呼び出しは一切行わない
 * (`attribution.ts`・`motifs.ts`・`refutation.ts`と同じ設計方針)。
 *
 * この構造化データが「LLMが根拠にしてよい事実の全て」であり、本モジュールが
 * 何を含め何を含めないかが、そのままハルシネーション防止の境界線になる
 * (`prompt.ts`のシステムプロンプトが「この事実以外を述べない」と拘束する対象)。
 */

import type { AttributionBreakdown, MoveAnalysis } from '../analysis/types.ts'
import type { ComparePvResult } from '../analysis/comparePv.ts'
import type { MotifDefinition } from '../analysis/motifs.ts'
import { describeRefutationStep, REFUTATION_LINE_LABEL, type RefutationResult } from '../analysis/refutation.ts'
import type { WhyBadResult } from '../analysis/whyBad.ts'
import type {
  StructuredAttribution,
  StructuredCommentaryInput,
  StructuredComparePv,
  StructuredGameSummaryInput,
  StructuredMoveFacts,
  StructuredRefutation,
  StructuredRefutationPoint,
} from './types.ts'

/** `MoveAnalysis`から`StructuredMoveFacts`を抜き出す(座標そのもの以外の生局面情報は含めない)。 */
export function buildMoveFacts(moveAnalysis: MoveAnalysis): StructuredMoveFacts {
  return {
    ply: moveAnalysis.ply,
    side: moveAnalysis.side,
    playedMove: moveAnalysis.move,
    bestMove: moveAnalysis.bestMove,
    playedDiscDiff: moveAnalysis.playedDiscDiff,
    bestDiscDiff: moveAnalysis.bestDiscDiff,
    lossDiscs: moveAnalysis.lossDiscs,
    classification: moveAnalysis.classification,
    reversal: moveAnalysis.reversal,
    isExact: moveAnalysis.isExact,
  }
}

function buildAttributionInput(attribution: AttributionBreakdown | null): StructuredAttribution | null {
  if (!attribution) return null
  return {
    terms: attribution.terms.map((t) => ({ key: t.key, label: t.label, delta: t.delta })),
    total: attribution.total,
  }
}

/** `RefutationResult`の片方の系列(実際の進行/最善進行)から回収点だけを文章化して抜き出す。 */
function buildCriticalPliesText(lineKey: keyof typeof REFUTATION_LINE_LABEL, result: RefutationResult): StructuredRefutationPoint[] {
  const line = result[lineKey]
  const label = REFUTATION_LINE_LABEL[lineKey]
  const points: StructuredRefutationPoint[] = []
  for (const step of line.steps) {
    const description = describeRefutationStep(label, step)
    if (description) {
      points.push({ stepIndex: step.stepIndex, move: step.move, description })
    }
  }
  return points
}

function buildRefutationInput(refutation: RefutationResult | null): StructuredRefutation | null {
  if (!refutation) return null
  return {
    playedCriticalPlies: buildCriticalPliesText('played', refutation),
    bestCriticalPlies: buildCriticalPliesText('best', refutation),
  }
}

function buildComparePvInput(comparePv: ComparePvResult | null): StructuredComparePv | null {
  if (!comparePv) return null
  return {
    playedContinuation: comparePv.playedContinuation,
    bestContinuation: comparePv.bestContinuation,
    firstDivergenceIndex: comparePv.firstDivergenceIndex,
  }
}

/**
 * 悪手分析パネル(`BlunderPanel.tsx`)が保持する各種解析結果から、LLMに渡す
 * 構造化入力データを組み立てる(要件2)。
 *
 * `attribution`/`refutation`/`comparePv`は非同期取得中や取得失敗時に`null`になりうる
 * (`BlunderPanel.tsx`のstate)。その場合、対応するフィールドは`null`のまま渡し、
 * LLMには「この情報は無い」ことがそのまま伝わる(存在しない情報を捏造させないため、
 * フィールド自体を省略せず明示的に`null`にする)。
 */
export function buildStructuredInput(
  moveAnalysis: MoveAnalysis,
  whyBad: WhyBadResult,
  motifs: readonly MotifDefinition[],
  attribution: AttributionBreakdown | null,
  refutation: RefutationResult | null,
  comparePv: ComparePvResult | null,
): StructuredCommentaryInput {
  return {
    move: buildMoveFacts(moveAnalysis),
    attribution: buildAttributionInput(attribution),
    motifTags: motifs.map((m) => ({ key: m.key, label: m.label, kind: m.kind })),
    refutation: buildRefutationInput(refutation),
    comparePv: buildComparePvInput(comparePv),
    whyBadReasons: whyBad.reasons,
  }
}

/** 悪手分析パネルを開ける対象(分類が◎以外、または逆転が起きた手)かどうか(`AnalysisMode.tsx`と同じ判定)。 */
function isNotableMove(m: MoveAnalysis): boolean {
  return m.classification !== 'best' || m.reversal
}

/** 1局まとめの感想戦テキスト生成(要件5)用の構造化入力データを組み立てる(`AnalysisMode.tsx`側)。 */
export function buildGameSummaryInput(
  results: readonly MoveAnalysis[],
  maxNotableMoves = 12,
): StructuredGameSummaryInput {
  const notable = results.filter(isNotableMove)
  return {
    totalMoves: results.length,
    blunderCount: notable.filter((m) => m.classification === 'blunder').length,
    notableMoves: notable.slice(0, maxNotableMoves).map(buildMoveFacts),
  }
}

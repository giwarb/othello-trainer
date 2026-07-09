/**
 * T033「反証層」(`othello-trainer-design-verbalization.md` §3)の
 * TypeScript側実装。
 *
 * 比較PV(T030 `comparePv.ts`)の「実際の進行」「最善進行」それぞれについて、
 * 各手を打つたびの評価内訳分解(T031 `attribution.ts`の`buildAttribution`)を
 * 隣接する手同士で比較し、いずれかの項(モビリティ/隅/確定石)の寄与が
 * 閾値を超えて動いた手を「回収点(critical ply)」として検出する。
 *
 * 新しいエンジン呼び出しや評価ロジックの再実装は行わない。局面の複製
 * (`replayContinuationSteps`)・評価差の3項分解(`buildAttribution`)は
 * いずれもT031で用意済みのものをそのまま使う(T031で発覚した「Rust/TS間の
 * ロジック・定数の二重管理」の教訓を踏まえ、本モジュールは重みや評価式を
 * 一切知らない。呼び出し側(`BlunderPanel.tsx`)が`EngineClient.requestEvalTerms`
 * で各局面の`EvalTerms`を取得し、本モジュールに渡す)。
 *
 * ## 閾値の根拠
 * 設計書§3は「寄与が急変した手」の例として「3石相当」を挙げている。本実装は
 * これを踏襲し`REFUTATION_THRESHOLD_DISCS = 3`(石差)を既定値とする。
 * 悪手分類の最小閾値(`ClassifyThresholds`の既定`inaccuracy`相当、1石)より
 * 大きく、「悪手」判定の既定閾値(6石)より小さい中間的な値であり、
 * 「明確に形勢に影響する規模の寄与変化」を捉えつつ、些細な変動(1〜2石程度の
 * ノイズ)を回収点として拾いすぎないためのバランスとして選んだ
 * (`app/src/blunder/types.ts`等の既存の悪手分類閾値と重複管理にならないよう、
 * 本モジュール内で独立した定数として定義するに留める。呼び出し側で
 * 上書き可能な引数にしてあるため、将来ユーザー調整可能にするのも容易)。
 */

import { opposite, type Board, type Side } from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { buildAttribution, replayContinuationSteps } from './attribution.ts'
import type { AttributionBreakdown, AttributionTerm, EvalTerms } from './types.ts'

/** 回収点判定の既定閾値(石差)。モジュール冒頭のコメント「閾値の根拠」参照。 */
export const REFUTATION_THRESHOLD_DISCS = 3

/** 比較PVの系列を表す2つのラベル。`RefutationResult`のキーと対応する。 */
export type RefutationLineKey = 'played' | 'best'

export const REFUTATION_LINE_LABEL: Record<RefutationLineKey, string> = {
  played: '実際の進行',
  best: '最善進行',
}

/** 比較PVの1手ぶんの回収点検出結果(ステップ実行UIの1ステップに対応)。 */
export interface RefutationStep {
  /** 0始まりのステップ番号(継続手順内でのインデックス。この手が`moves[stepIndex]`)。 */
  readonly stepIndex: number
  /** この手の記法。 */
  readonly move: string
  /** この手を打った側("パス"により手番が飛んでいる場合、これは実際にこの手を指した側)。 */
  readonly mover: Side | null
  /** この手を打った直後の局面(ステップ実行UIの盤面表示に使う)。 */
  readonly board: Board
  /** `board`時点の実際の手番("パス"解決済み。終局していれば`null`)。ステップ実行UIの盤面表示に使う。 */
  readonly sideToMoveAfter: Side | null
  /** 直前のステップの局面からの評価内訳分解の差分(`perspective`視点、石差単位)。 */
  readonly breakdown: AttributionBreakdown
  /** `breakdown.terms`のうち、閾値を超えて変化した項目のキー(0件なら回収点ではない)。 */
  readonly criticalTermKeys: readonly AttributionTerm['key'][]
  /** `criticalTermKeys`が1件以上あるか(回収点かどうか)。 */
  readonly isCriticalPly: boolean
}

/** 比較PVの一方の系列(実際の進行/最善進行)ぶんの回収点検出結果。 */
export interface RefutationLine {
  readonly steps: readonly RefutationStep[]
}

/** 反証層の検出結果全体(実際の進行/最善進行の両方)。 */
export interface RefutationResult {
  readonly played: RefutationLine
  readonly best: RefutationLine
}

/**
 * `boards`(長さ`moves.length + 1`、`boards[0]`が開始局面)と、それぞれの
 * 局面に対応する`termsSequence`(同じく長さ`moves.length + 1`)から、隣接する
 * 局面同士の評価内訳分解を計算し、回収点を検出する。
 *
 * @param startSide `boards[0]`時点の手番("パス"の自動解決に使う。`resolveMover`参照)。
 * @param perspective 評価内訳分解の視点("black"|"white"。通常は悪手を打った側)。
 */
export function buildRefutationLine(
  startSide: Side,
  boards: readonly Board[],
  moves: readonly string[],
  termsSequence: readonly EvalTerms[],
  perspective: Side,
  thresholdDiscs: number = REFUTATION_THRESHOLD_DISCS,
): RefutationLine {
  if (boards.length !== moves.length + 1) {
    throw new Error(
      `refutation.ts: boards.length(${boards.length})はmoves.length + 1(${moves.length + 1})と一致する必要があります`,
    )
  }
  if (termsSequence.length !== moves.length + 1) {
    throw new Error(
      `refutation.ts: termsSequence.length(${termsSequence.length})はmoves.length + 1(${moves.length + 1})と一致する必要があります`,
    )
  }

  const steps: RefutationStep[] = []
  let mover: Side | null = resolveMover(boards[0]!, startSide)

  for (let i = 0; i < moves.length; i++) {
    const moverForThisMove = mover
    const breakdown = buildAttribution(termsSequence[i + 1]!, termsSequence[i]!, perspective)
    const criticalTermKeys = breakdown.terms
      .filter((term) => Math.abs(term.delta) >= thresholdDiscs)
      .map((term) => term.key)
    const sideToMoveAfter = moverForThisMove === null ? null : resolveMover(boards[i + 1]!, opposite(moverForThisMove))

    steps.push({
      stepIndex: i,
      move: moves[i]!,
      mover: moverForThisMove,
      board: boards[i + 1]!,
      sideToMoveAfter,
      breakdown,
      criticalTermKeys,
      isCriticalPly: criticalTermKeys.length > 0,
    })

    mover = sideToMoveAfter
  }

  return { steps }
}

/**
 * 比較PV(T030 `comparePv.ts`の`ComparePvResult`)の両系列(実際の進行/最善進行)に
 * ついて回収点を検出する。局面の複製は本関数が`replayContinuationSteps`を使って
 * 行うため、呼び出し側は`playedTermsSequence`/`bestTermsSequence`(各局面の
 * `EvalTerms`、`EngineClient.requestEvalTerms`で取得したもの)を渡すだけでよい。
 *
 * @param startBoard 悪手局面(比較PVの起点、`MoveAnalysis.board`)。
 * @param startSide 悪手局面の手番(`MoveAnalysis.side`)。
 * @param playedMoves 実際の進行の着手列(`ComparePvResult.playedContinuation`)。
 * @param bestMoves 最善進行の着手列(`ComparePvResult.bestContinuation`)。
 * @param playedTermsSequence `playedMoves`の`replayContinuationSteps`が返す各局面
 *   (開始局面含む、長さ`playedMoves.length + 1`)に対応する`EvalTerms`の配列。
 * @param bestTermsSequence 同様に`bestMoves`側。
 * @param perspective 評価内訳分解の視点(通常は悪手を打った側、`startSide`と同じ)。
 */
export function buildRefutationResult(
  startBoard: Board,
  startSide: Side,
  playedMoves: readonly string[],
  bestMoves: readonly string[],
  playedTermsSequence: readonly EvalTerms[],
  bestTermsSequence: readonly EvalTerms[],
  perspective: Side,
  thresholdDiscs: number = REFUTATION_THRESHOLD_DISCS,
): RefutationResult {
  const playedBoards = replayContinuationSteps(startBoard, startSide, playedMoves)
  const bestBoards = replayContinuationSteps(startBoard, startSide, bestMoves)

  return {
    played: buildRefutationLine(startSide, playedBoards, playedMoves, playedTermsSequence, perspective, thresholdDiscs),
    best: buildRefutationLine(startSide, bestBoards, bestMoves, bestTermsSequence, perspective, thresholdDiscs),
  }
}

/**
 * 回収点(`step.isCriticalPly`)のテキスト表現を組み立てる
 * (設計書§3「◯手先の形で比較すると…」の明示方針に沿う。比較PVは1手ごとに
 * 隣接局面を辿るため、「◯手目」という表現で「その手までの◯手先の形で比較すると」
 * を表す)。回収点でなければ`null`を返す。
 */
export function describeRefutationStep(lineLabel: string, step: RefutationStep): string | null {
  if (!step.isCriticalPly) return null
  const criticalTerms = step.breakdown.terms.filter((term) => step.criticalTermKeys.includes(term.key))
  const parts = criticalTerms.map((term) => {
    const sign = term.delta >= 0 ? '+' : ''
    return `${term.label}の寄与が${sign}${term.delta.toFixed(1)}動きました`
  })
  return `${step.stepIndex + 1}手目(${lineLabel}、${step.move})で、${parts.join('、')}`
}

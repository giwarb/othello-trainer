/**
 * T031「評価内訳分解層」(`othello-trainer-design-verbalization.md` §2)の
 * TypeScript側実装。
 *
 * # スコープ縮小についての重要な注記
 *
 * 設計書§2は「評価値 = Σ(46パターンの重み) + 手数項 + パリティ項」という
 * WTHOR学習パターン評価を前提に分解を設計しているが、本プロジェクトの現行
 * 評価関数(`engine/src/eval.rs`)はモビリティ・隅・安定石の3項のみの線形
 * モデルである(46パターン評価はフェーズ3で後回し、ユーザー承認済み)。
 * そのため本モジュールは46グループではなく、**現行の3項への厳密な分解**
 * として実装する(`buildAttribution`)。3項の合計が実際の評価差と一致する
 * ことは線形結合であることから数学的に保証されるが、`attribution.test.ts`
 * では実際にWASM経由で取得した `evaluateBlack`(`eval::evaluate` の生の
 * 出力)とも突き合わせ、下記の重み定数が `engine/src/eval.rs` の値と
 * driftしていないことも検証する。
 *
 * 「辺の形」「斜めライン」「地域偶数」は現行評価関数に存在しない概念のため、
 * この評価内訳分解には含めない(要件どおり、特徴量としての計算は
 * `engine/src/explain.rs` の `featureSet` コマンドで別途行う)。
 *
 * このファイルは`comparePv.ts`(T030)と同じ設計方針を踏襲し、エンジン呼び出し
 * を含まない純粋関数のみで構成する(`EvalTerms`は呼び出し側が
 * `EngineClient.requestEvalTerms`で取得してから渡す)。
 */

import {
  applyMove,
  legalMoves,
  notationToSquare,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { TranscriptReplayError } from './analyzeGame.ts'
import type { AttributionBreakdown, AttributionTerm, EvalTerms } from './types.ts'

export type { AttributionBreakdown, AttributionTerm, EvalTerms } from './types.ts'

/**
 * 現行評価関数(`engine/src/eval.rs`)の重み(centi-disc単位、T024でEdaxの
 * 評価値へ回帰較正済み)。**この3つの値は`engine/src/eval.rs`の
 * `MOBILITY_WEIGHT`/`CORNER_WEIGHT`/`STABLE_WEIGHT`と同じ値に保つこと。**
 * Rust側の値が変わった場合はここも更新する必要がある(`attribution.test.ts`
 * がWASM経由の実際の評価値との突き合わせでdriftを検出する)。
 */
const MOBILITY_WEIGHT = 253
const CORNER_WEIGHT = 1088
const STABLE_WEIGHT = 93

const TERM_LABELS: Record<AttributionTerm['key'], string> = {
  mobility: '着手可能数',
  corner: '隅',
  stable: '確定石',
}

/**
 * 2局面(`termsA`, `termsB`、いずれも黒視点の生特徴量差分)の評価差を、
 * 現行評価関数の3項(モビリティ・隅・安定石)それぞれの寄与に厳密に分解する。
 *
 * `perspective`が`'white'`の場合は符号を反転する(白視点で見て「損」が
 * 正しく負として表示されるようにするため)。
 *
 * @param termsA 比較対象の局面A(通常は「実際の手」側のPV末端局面)。
 * @param termsB 比較対象の局面B(通常は「最善手」側のPV末端局面)。
 * @returns `termsA`の評価 − `termsB`の評価(`perspective`視点、石差単位)の内訳。
 */
export function buildAttribution(termsA: EvalTerms, termsB: EvalTerms, perspective: Side): AttributionBreakdown {
  const sign = perspective === 'black' ? 1 : -1

  const rawTerms: readonly [AttributionTerm['key'], number][] = [
    ['mobility', MOBILITY_WEIGHT * (termsA.mobilityDiff - termsB.mobilityDiff)],
    ['corner', CORNER_WEIGHT * (termsA.cornerDiff - termsB.cornerDiff)],
    ['stable', STABLE_WEIGHT * (termsA.stableDiff - termsB.stableDiff)],
  ]

  const terms: AttributionTerm[] = rawTerms.map(([key, centiDiscDelta]) => ({
    key,
    label: TERM_LABELS[key],
    delta: (sign * centiDiscDelta) / 100,
  }))

  const total = terms.reduce((sum, t) => sum + t.delta, 0)

  return { terms, total }
}

/**
 * 局面`board`(`side`が手番)から`moves`(最大8手程度を想定するが件数は問わない)
 * を順番に適用し、末端局面を返す。パス(手番側に合法手が無い)は
 * `resolveMover`で自動的に処理する(`analyzeGame.ts`の`replayGame`と同じ方針だが、
 * こちらは任意の開始局面から末端局面のみを返す軽量版)。
 *
 * 比較PV(`comparePv.ts`の`buildComparePv`が返す`playedContinuation`/
 * `bestContinuation`)は既に検証済みの手順であることが多いが、念のため
 * `replayGame`と同じ`TranscriptReplayError`を投げて呼び出し側にエラーとして
 * 伝える(非合法手・手順の途中の終局を無視して局面を誤魔化さないため)。
 */
export function replayContinuation(board: Board, side: Side, moves: readonly string[]): Board {
  let currentBoard = board
  let currentMover: Side | null = resolveMover(board, side)

  for (let i = 0; i < moves.length; i++) {
    if (currentMover === null) {
      throw new TranscriptReplayError(`${i + 1}手目 "${moves[i]}" より前に終局しています(両者とも着手不可)`)
    }
    const square = notationToSquare(moves[i]!)
    if (!legalMoves(currentBoard, currentMover).includes(square)) {
      throw new TranscriptReplayError(`${i + 1}手目 "${moves[i]}" はこの局面で合法手ではありません`)
    }
    currentBoard = applyMove(currentBoard, currentMover, square)
    const nextSide = opposite(currentMover)
    currentMover = resolveMover(currentBoard, nextSide)
  }

  return currentBoard
}

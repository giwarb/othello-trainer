/**
 * 中盤練習モードにおけるプレイヤーの着手判定(T021)。
 *
 * 設計書§4.1の3判定モード(要件4)を実装する純粋関数。`EngineClient.requestAnalyzeAll`
 * が返す着手前局面の全合法手評価(`MoveEvalJson[]`、手番側視点)と、実際にプレイヤーが
 * 打った手を突き合わせて判定する。定石練習(T020)の `joseki/judgeMove.ts` とは
 * 判定基準が異なる別概念のため、タスク仕様の指示どおり新規実装する(既存の
 * `blunder/isBlunder.ts`・`joseki/judgeMove.ts` は参考程度に留め、直接は再利用しない)。
 *
 * ## 逆転禁止モードの符号比較について(要件4、判断根拠)
 *
 * `MoveEvalJson.discDiff` は「その手を打った場合の局面評価(手番側から見た石差、
 * 以後の最適進行を織り込んだ値)」であり、`blunder/isBlunder.ts`・`joseki/judgeMove.ts`
 * と同じ規約に従う。ミニマックス(ネガマックス)の定義上、これは「着手後の局面を
 * 相手番視点で評価した値の符号を反転したもの」と等価である。したがって、
 * タスク仕様が言う「着手後の評価(相手番側から見た値を手番反転して比較する必要が
 * ある)」は、追加のエンジン呼び出しをせずとも、着手前局面の `allMoves` 内の
 * 「打った手」の `discDiff` としてそのまま得られる(`played.discDiff` がそれ)。
 *
 * 「着手前の評価」は、着手前の局面において手番側が最適に指した場合に得られる値、
 * すなわち全合法手中の最善手の `discDiff`(`best.discDiff`)とする。ミニマックスの
 * 定義上、手番側は最善手を選択できるので、局面の(最適play前提の)価値は最善手の
 * 価値と一致するため、これは妥当な近似ではなく厳密な定義である。
 *
 * 評価が0(互角)の場合の符号は「直前の符号を維持する」仕様(要件4)とした。
 * 1回の呼び出し(1手分のデータ)だけでは「直前」を知りようがないため、
 * 呼び出し側(`PracticeMode.tsx`)がセッションを通じて直前の非ゼロ符号
 * (`previousSign`)を保持し、本関数の引数として渡す設計とした。本関数は
 * 次回呼び出し用の符号(`nextSign`)を判定モードによらず常に計算して結果に
 * 含めて返すので、呼び出し側はそれをそのまま次回の `previousSign` として
 * 使い回せばよい。
 */

import type { MoveEvalJson } from '../engine/types.ts'
import type { JudgeMode } from './types.ts'

/** 標準モードで正解とみなす石差ロスの上限(要件4)。 */
export const STANDARD_LOSS_THRESHOLD = 1.0

/** 厳格モードで「最善手と同値」とみなす許容誤差(浮動小数点誤差対策)。 */
const STRICT_EPSILON = 1e-9

/** 評価の符号。`0` は「互角」で、逆転禁止モードでは直前の符号を維持する対象。 */
export type EvalSign = 1 | 0 | -1

export interface JudgeMidgameMoveInput {
  readonly mode: JudgeMode
  /** 着手前局面の全合法手評価(`requestAnalyzeAll` の結果、手番側視点)。 */
  readonly allMoves: readonly MoveEvalJson[]
  /** プレイヤーが実際に打った手("a1"〜"h8"記法)。 */
  readonly playedMove: string
  /** 逆転禁止モード用: 直前の評価の符号。未確定(セッション開始直後等)なら `0`(既定値)。 */
  readonly previousSign?: EvalSign
}

export type JudgeMidgameReasonKind =
  /** 正解(判定モードによらず共通)。 */
  | 'ok'
  /** 厳格モードで最善手ではなかった。 */
  | 'notBest'
  /** 標準モードで石差ロスが閾値を超えた。 */
  | 'lossExceeded'
  /** 逆転禁止モードで評価の符号が反転した。 */
  | 'reversed'
  /** 着手前局面に合法手が無かった(通常到達しない防御的分岐)。 */
  | 'noLegalMoves'
  /** `allMoves` の中に `playedMove` が見つからなかった(呼び出し側の不整合)。 */
  | 'moveNotFound'

export interface JudgeMidgameMoveResult {
  readonly correct: boolean
  readonly reasonKind: JudgeMidgameReasonKind
  /** 最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** 最善手の記法。`allMoves` が空の場合は `null`。 */
  readonly bestMove: string | null
  readonly bestDiscDiff: number | null
  /** プレイヤーが打った手の評価値(石差)。`allMoves` に見つからない場合は `null`。 */
  readonly playedDiscDiff: number | null
  /** 着手前局面の評価の符号(最善手の符号。0の場合は `previousSign` で補完済み)。 */
  readonly preSign: EvalSign
  /** 着手後(プレイヤーが実際に打った手)の評価の符号。次回呼び出しの `previousSign` に使う。 */
  readonly nextSign: EvalSign
}

function signOf(discDiff: number, fallback: EvalSign): EvalSign {
  if (discDiff > 0) return 1
  if (discDiff < 0) return -1
  return fallback
}

/**
 * プレイヤーの着手(`input.playedMove`)を `input.mode` に応じて判定する。
 */
export function judgeMidgameMove(input: JudgeMidgameMoveInput): JudgeMidgameMoveResult {
  const { mode, allMoves, playedMove, previousSign = 0 } = input

  if (allMoves.length === 0) {
    return {
      correct: false,
      reasonKind: 'noLegalMoves',
      lossDiscs: 0,
      bestMove: null,
      bestDiscDiff: null,
      playedDiscDiff: null,
      preSign: previousSign,
      nextSign: previousSign,
    }
  }

  const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
  const played = allMoves.find((m) => m.move === playedMove)
  const playedDiscDiff = played?.discDiff ?? null
  const lossDiscs = played ? Math.max(0, best.discDiff - played.discDiff) : Math.max(0, best.discDiff)

  const preSign = signOf(best.discDiff, previousSign)
  const nextSign = played ? signOf(played.discDiff, preSign) : preSign

  if (!played) {
    return {
      correct: false,
      reasonKind: 'moveNotFound',
      lossDiscs,
      bestMove: best.move,
      bestDiscDiff: best.discDiff,
      playedDiscDiff: null,
      preSign,
      nextSign,
    }
  }

  let correct: boolean
  let failReasonKind: JudgeMidgameReasonKind

  switch (mode) {
    case 'strict':
      correct = lossDiscs <= STRICT_EPSILON
      failReasonKind = 'notBest'
      break
    case 'standard':
      correct = lossDiscs <= STANDARD_LOSS_THRESHOLD
      failReasonKind = 'lossExceeded'
      break
    case 'noReversal':
      // preSign/nextSignのどちらかが0(互角)なら「反転」とはみなさない。
      correct = preSign === 0 || nextSign === 0 || preSign === nextSign
      failReasonKind = 'reversed'
      break
  }

  return {
    correct,
    reasonKind: correct ? 'ok' : failReasonKind,
    lossDiscs,
    bestMove: best.move,
    bestDiscDiff: best.discDiff,
    playedDiscDiff,
    preSign,
    nextSign,
  }
}

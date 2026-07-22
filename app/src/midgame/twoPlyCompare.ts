/**
 * T195: 中盤練習「悪手直後の2手先2盤面比較」フィードバックの純粋計算部分。
 *
 * 背景(ユーザー指示 2026-07-23): 悪手を打った**その場で**、実際に打った手・
 * 最善手それぞれについて「自分の手→相手の最善応手」の2手ぶんを進めた盤面を
 * 作り、その局面で自分が次に持つ合法手数(=着手可能数)と、その中の最善評価値を
 * 比較する。数値の羅列(旧・寄与の滝グラフ等)ではなく「打てる場所の数」という
 * 直感的な主指標を軸に、盤面そのもので見せることが本質(タスク仕様参照)。
 *
 * 本モジュールはエンジン呼び出し(`requestAnalyzeAll`)を関数として注入される
 * だけの純粋な計算ロジックであり、Preactコンポーネントには一切依存しない
 * (`TwoPlyCompare.tsx`が表示、`PracticeMode.tsx`がこの関数の返り値を使って
 * 描画する。T196(棋譜解析)から同じロジック・コンポーネントを再利用できるよう、
 * モード固有の状態を一切参照しない設計にしてある)。
 *
 * ## 2手先の解決規則(要件4のエッジケース)
 *
 * 1. 自分の手を適用した盤面で、相手・自分いずれも合法手が無い
 *    → その時点で真の終局(`kind: 'ended'`、要件「2手進める前に終局」)。
 * 2. 相手に合法手が無く自分にはある → 相手はパスしたとみなし、盤面はそのまま
 *    (要件「相手が応手できない」)。相手に合法手があれば`requestAnalyzeAll`で
 *    最善応手を求めて適用する。
 * 3. (相手の応手 or パス)後の盤面で、自分・相手いずれも合法手が無ければ
 *    真の終局(`kind: 'ended'`)。
 * 4. 自分に合法手が無い(が相手にはまだある) → `kind: 'selfPass'`
 *    (要件「自分の次の番が0か所(パス)」)。ここでは3手目以降を追わず、
 *    「2手先」という固定の分析フレームのまま「0か所」と報告する
 *    (`resolveMover`のように相手の3手目まで遡って解決はしない、実装者判断)。
 * 5. 自分に合法手があれば`requestAnalyzeAll`で自分の全合法手評価を取得する
 *    (この結果が`MoveEvalOverlay`にそのまま渡る)。
 *
 * 1系列(打った手 or 最善手)あたり最大2回の`requestAnalyzeAll`呼び出し
 * (相手応手の特定+自分の合法手評価)。2系列(実際の手・最善手)で最大4回
 * (タスク仕様「新規requestAnalyzeAllは比較用4回のみ」)。
 */

import { formatDiscDiff } from '../components/EvalBadge.tsx'
import type { MoveEvalJson } from '../engine/types.ts'
import { applyMove, countDiscs, hasLegalMove, notationToSquare, opposite, squareToNotation, type Board, type Side } from '../game/othello.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'
import { resolveMover } from './resolveMover.ts'

/** `requestAnalyzeAll`を呼ぶための関数注入(具体的なエンジン設定・キャッシュは呼び出し元の責務)。 */
export type RequestAnalyzeAllFn = (board: Board, side: Side) => Promise<MoveEvalJson[]>

/**
 * 1系列(実際に打った手 or 最善手)の2手先計算結果。
 *
 * - `'ended'`: 2手を進める途中、または進めた後に真の終局に達した
 *   (`finalDiscDiff`は`preMoveSide`視点の石差)。
 * - `'selfPass'`: 相手の応手(またはパス)の後、自分に合法手が無い
 *   (相手はまだ合法手を持ちうる。要件「自分の次の番が0か所」)。
 * - `'ok'`: 自分の合法手評価が取得できた(通常ケース)。
 */
export type TwoPlyBranchResult =
  | {
      readonly kind: 'ended'
      readonly board: Board
      readonly ownSquare: number
      readonly opponentSquare: number | null
      readonly opponentPassed: boolean
      readonly finalDiscDiff: number
    }
  | {
      readonly kind: 'selfPass'
      readonly board: Board
      readonly ownSquare: number
      readonly opponentSquare: number | null
      readonly opponentPassed: boolean
    }
  | {
      readonly kind: 'ok'
      readonly board: Board
      readonly ownSquare: number
      readonly opponentSquare: number | null
      readonly opponentPassed: boolean
      readonly selfMoves: readonly MoveEvalJson[]
      readonly selfLegalCount: number
      readonly bestSelfEval: number
    }

export interface TwoPlyCompareResult {
  /** 実際に打った手の系列。 */
  readonly played: TwoPlyBranchResult
  /** 最善手の系列。 */
  readonly best: TwoPlyBranchResult
}

/** `allMoves`(mover視点)から`discDiff`最大の手を返す(空配列は呼び出し元で除外済みの前提)。 */
function bestOf(allMoves: readonly MoveEvalJson[]): MoveEvalJson {
  return allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
}

/**
 * 1系列(`ownSquare`を打った場合)の2手先を計算する(上記モジュールdocの規則参照)。
 */
export async function computeTwoPlyBranch(
  preMoveBoard: Board,
  preMoveSide: Side,
  ownSquare: number,
  requestAnalyzeAll: RequestAnalyzeAllFn,
): Promise<TwoPlyBranchResult> {
  const opponentSide = opposite(preMoveSide)
  const boardAfterSelf = applyMove(preMoveBoard, preMoveSide, ownSquare)

  // 規則1: 自分の手の直後に既に終局(相手・自分とも合法手なし)。
  if (resolveMover(boardAfterSelf, opponentSide) === null) {
    return {
      kind: 'ended',
      board: boardAfterSelf,
      ownSquare,
      opponentSquare: null,
      opponentPassed: false,
      finalDiscDiff: countDiscs(boardAfterSelf, preMoveSide) - countDiscs(boardAfterSelf, opponentSide),
    }
  }

  let boardAfterOpponent: Board
  let opponentSquare: number | null
  let opponentPassed: boolean

  if (hasLegalMove(boardAfterSelf, opponentSide)) {
    const opponentMoves = await requestAnalyzeAll(boardAfterSelf, opponentSide)
    const best = bestOf(opponentMoves)
    opponentSquare = notationToSquare(best.move)
    boardAfterOpponent = applyMove(boardAfterSelf, opponentSide, opponentSquare)
    opponentPassed = false
  } else {
    // 規則2: 相手はパス(盤面は変化しない)。
    boardAfterOpponent = boardAfterSelf
    opponentSquare = null
    opponentPassed = true
  }

  const selfHasMove = hasLegalMove(boardAfterOpponent, preMoveSide)
  const opponentHasMoveAgain = hasLegalMove(boardAfterOpponent, opponentSide)

  // 規則3: (相手の応手 or パス)後に真の終局。
  if (!selfHasMove && !opponentHasMoveAgain) {
    return {
      kind: 'ended',
      board: boardAfterOpponent,
      ownSquare,
      opponentSquare,
      opponentPassed,
      finalDiscDiff: countDiscs(boardAfterOpponent, preMoveSide) - countDiscs(boardAfterOpponent, opponentSide),
    }
  }

  // 規則4: 自分に合法手が無い(相手はまだ打てる)。
  if (!selfHasMove) {
    return { kind: 'selfPass', board: boardAfterOpponent, ownSquare, opponentSquare, opponentPassed }
  }

  // 規則5: 自分の合法手評価を取得する(この結果をMoveEvalOverlayにそのまま渡す)。
  const selfMoves = await requestAnalyzeAll(boardAfterOpponent, preMoveSide)
  const bestSelfEval = bestOf(selfMoves).discDiff
  return {
    kind: 'ok',
    board: boardAfterOpponent,
    ownSquare,
    opponentSquare,
    opponentPassed,
    selfMoves,
    selfLegalCount: selfMoves.length,
    bestSelfEval,
  }
}

/**
 * 実際の手・最善手の2系列を並列に計算する(要件2「2系列はPromise.allで並列化してよい」)。
 */
export async function computeTwoPlyCompare(
  preMoveBoard: Board,
  preMoveSide: Side,
  playedSquare: number,
  bestSquare: number,
  requestAnalyzeAll: RequestAnalyzeAllFn,
): Promise<TwoPlyCompareResult> {
  const [played, best] = await Promise.all([
    computeTwoPlyBranch(preMoveBoard, preMoveSide, playedSquare, requestAnalyzeAll),
    computeTwoPlyBranch(preMoveBoard, preMoveSide, bestSquare, requestAnalyzeAll),
  ])
  return { played, best }
}

/** 1系列ぶんの「あなた: X → 相手: Y → 打てる場所: N か所」ヘッダ文言を組み立てる(要件3)。 */
export function formatTwoPlyBranchHeader(ownMoveNotation: string, branch: TwoPlyBranchResult): string {
  const opponentPart = branch.opponentPassed
    ? 'パス'
    : branch.opponentSquare !== null
      ? squareToNotation(branch.opponentSquare)
      : '(終局のため着手なし)'

  if (branch.kind === 'ended') {
    return `あなた: ${ownMoveNotation} → 相手: ${opponentPart} → 終局(石差${formatDiscDiff(branch.finalDiscDiff)})`
  }
  const legalPart = branch.kind === 'selfPass' ? '0 か所(パス)' : `${branch.selfLegalCount} か所`
  return `あなた: ${ownMoveNotation} → 相手: ${opponentPart} → 打てる場所: ${legalPart}`
}

/** 主文(要件3)の「実際に打った手」側の文。 */
function playedSentence(branch: TwoPlyBranchResult): string {
  if (branch.kind === 'ended') return `この手の後、盤面は終局しました(石差${formatDiscDiff(branch.finalDiscDiff)})。`
  if (branch.kind === 'selfPass') return 'この手の後、あなたは打てる場所がありません(パス)。'
  return `この手だと次にあなたは${branch.selfLegalCount}か所に打てます(いちばん良い手で${formatDiscDiff(branch.bestSelfEval)})。`
}

/** 主文(要件3)の「最善手」側の文。 */
function bestSentence(branch: TwoPlyBranchResult): string {
  if (branch.kind === 'ended') return `最善手なら盤面は終局し、石差は${formatDiscDiff(branch.finalDiscDiff)}でした。`
  if (branch.kind === 'selfPass') return '最善手でも、あなたが打てる場所はありません(パス)でした。'
  return `最善手なら${branch.selfLegalCount}か所(いちばん良い手で${formatDiscDiff(branch.bestSelfEval)})でした。`
}

/**
 * 主文(要件3、平易な日本語の主指標説明)を組み立てる。
 * 例(両系列とも通常ケース): 「この手だと次にあなたは5か所に打てます(いちばん良い手で+2)。
 * 最善手なら2か所(いちばん良い手で+4)でした。」
 */
export function formatTwoPlyCompareMainMessage(compare: TwoPlyCompareResult): string {
  return `${playedSentence(compare.played)} ${bestSentence(compare.best)}`
}

/** 損失1行(要件3「加えて損失...を1行」)。 */
export function formatTwoPlyCompareLossMessage(lossDiscs: number): string {
  return `この手は最善手より約${Math.round(lossDiscs)}石損しています。`
}

/** 結果画面・即時フィードバック共通で使う、指定した`ClearBlunderPattern`一覧から補足行(最大2件)を取り出す(要件3「廃止はしない」)。 */
export function twoPlyCompareSupplementalMessages(
  patterns: readonly ClearBlunderPattern[] | null | undefined,
): readonly string[] {
  if (!patterns) return []
  return patterns.map((p) => p.message)
}

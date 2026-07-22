/**
 * T195/T198: 中盤練習「悪手直後の5盤面比較」フィードバックの純粋計算部分。
 *
 * 背景(ユーザー指示 2026-07-23): T195で作った「2手先2盤面比較」を、
 * 「元局面+1手先×2(実際の手/最善手)+2手先×2」の5盤面へ拡張する。
 * 悪手を打った**その場で**、実際に打った手・最善手それぞれについて
 * 「自分の手→相手の最善応手」の2手ぶんを進めた盤面を作り、その途中経過
 * (1手先=相手の番)も含めて全5局面をその場で見せる。数値の羅列
 * (旧・寄与の滝グラフ等)ではなく「打てる場所の数」という直感的な主指標を
 * 軸に、盤面そのもので見せることが本質(T195タスク仕様参照)。
 *
 * 本モジュールはエンジン呼び出し(`requestAnalyzeAll`)を関数として注入される
 * だけの純粋な計算ロジックであり、Preactコンポーネントには一切依存しない
 * (`TwoPlyCompare.tsx`が表示、`PracticeMode.tsx`/`BlunderPanel.tsx`がこの
 * 関数の返り値を使って描画する)。
 *
 * ## 2手先の解決規則(T195要件4のエッジケース、T198でも不変)
 *
 * 1. 自分の手を適用した盤面で、相手・自分いずれも合法手が無い
 *    → その時点で真の終局(`kind: 'ended'`、要件「2手進める前に終局」)。
 *    この場合`board1Ply`(1手先の盤面)と`board`(2手先=最終盤面)は同一になる
 *    (T198: 1手先パネルと2手先パネルが同じ盤面を表示することになるが、
 *    ヘッダ文言(いずれも「終局」)で整合させる)。
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
 *    (この結果が2手先パネルの`MoveEvalOverlay`にそのまま渡る)。
 *
 * T198: 規則2/5で相手の合法手評価を取得した場合、従来は`best`を選ぶためだけに
 * 使って捨てていたが、`opponentMoves`としてブランチ結果に含めるようにした
 * (1手先パネルの`MoveEvalOverlay`にそのまま渡せる。追加のエンジン呼び出しは
 * 発生しない、要件1)。1系列(打った手 or 最善手)あたり最大2回の
 * `requestAnalyzeAll`呼び出し(相手応手の特定+自分の合法手評価)は不変。
 * 2系列(実際の手・最善手)で最大4回(既存の呼び出し回数構成を崩さない)。
 *
 * 元局面(悪手を打つ前)の自分の合法手評価は、このモジュールの関心事の外
 * (呼び出し元が`getAnalyzedMoves`キャッシュ等から`TwoPlyCompare`コンポーネントに
 * propsとして渡す設計、T198要件1の「呼び出し元からpropsで渡す」参照)。
 */

import { formatDiscDiff } from '../components/EvalBadge.tsx'
import type { MoveEvalJson } from '../engine/types.ts'
import { applyMove, countDiscs, hasLegalMove, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'
import { resolveMover } from './resolveMover.ts'

/** `requestAnalyzeAll`を呼ぶための関数注入(具体的なエンジン設定・キャッシュは呼び出し元の責務)。 */
export type RequestAnalyzeAllFn = (board: Board, side: Side) => Promise<MoveEvalJson[]>

/**
 * 1系列(実際に打った手 or 最善手)の2手先計算結果。
 *
 * - `board1Ply`/`opponentMoves`: 1手先(自分の手の直後、相手の番)の盤面と、
 *   その局面での相手の全合法手評価(T198追加)。相手に合法手が無い
 *   (パス、または規則1の即終局)場合は`opponentMoves: null`。
 * - `'ended'`: 2手を進める途中、または進めた後に真の終局に達した
 *   (`finalDiscDiff`は`preMoveSide`視点の石差)。
 * - `'selfPass'`: 相手の応手(またはパス)の後、自分に合法手が無い
 *   (相手はまだ合法手を持ちうる。要件「自分の次の番が0か所」)。
 * - `'ok'`: 自分の合法手評価が取得できた(通常ケース)。
 */
export type TwoPlyBranchResult =
  | {
      readonly kind: 'ended'
      readonly board1Ply: Board
      readonly opponentMoves: readonly MoveEvalJson[] | null
      readonly board: Board
      readonly ownSquare: number
      readonly opponentSquare: number | null
      readonly opponentPassed: boolean
      readonly finalDiscDiff: number
    }
  | {
      readonly kind: 'selfPass'
      readonly board1Ply: Board
      readonly opponentMoves: readonly MoveEvalJson[] | null
      readonly board: Board
      readonly ownSquare: number
      readonly opponentSquare: number | null
      readonly opponentPassed: boolean
    }
  | {
      readonly kind: 'ok'
      readonly board1Ply: Board
      readonly opponentMoves: readonly MoveEvalJson[] | null
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
  // この場合、相手に合法手が無いことが確定しているため`opponentMoves`は`null`
  // (1手先パネルは「打てる場所: 0か所(終局)」を表示する、T198)。
  if (resolveMover(boardAfterSelf, opponentSide) === null) {
    return {
      kind: 'ended',
      board1Ply: boardAfterSelf,
      opponentMoves: null,
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
  let opponentMoves: readonly MoveEvalJson[] | null

  if (hasLegalMove(boardAfterSelf, opponentSide)) {
    const fetchedOpponentMoves = await requestAnalyzeAll(boardAfterSelf, opponentSide)
    const best = bestOf(fetchedOpponentMoves)
    opponentSquare = notationToSquare(best.move)
    boardAfterOpponent = applyMove(boardAfterSelf, opponentSide, opponentSquare)
    opponentPassed = false
    // T198: 相手の最善応手を選ぶためだけに使って捨てていた結果を、1手先パネルの
    // `MoveEvalOverlay`にそのまま渡せるよう保持する(追加のエンジン呼び出し無し)。
    opponentMoves = fetchedOpponentMoves
  } else {
    // 規則2: 相手はパス(盤面は変化しない)。合法手が無いので取得すべき評価も無い。
    boardAfterOpponent = boardAfterSelf
    opponentSquare = null
    opponentPassed = true
    opponentMoves = null
  }

  const selfHasMove = hasLegalMove(boardAfterOpponent, preMoveSide)
  const opponentHasMoveAgain = hasLegalMove(boardAfterOpponent, opponentSide)

  // 規則3: (相手の応手 or パス)後に真の終局。
  if (!selfHasMove && !opponentHasMoveAgain) {
    return {
      kind: 'ended',
      board1Ply: boardAfterSelf,
      opponentMoves,
      board: boardAfterOpponent,
      ownSquare,
      opponentSquare,
      opponentPassed,
      finalDiscDiff: countDiscs(boardAfterOpponent, preMoveSide) - countDiscs(boardAfterOpponent, opponentSide),
    }
  }

  // 規則4: 自分に合法手が無い(相手はまだ打てる)。
  if (!selfHasMove) {
    return {
      kind: 'selfPass',
      board1Ply: boardAfterSelf,
      opponentMoves,
      board: boardAfterOpponent,
      ownSquare,
      opponentSquare,
      opponentPassed,
    }
  }

  // 規則5: 自分の合法手評価を取得する(この結果を2手先パネルのMoveEvalOverlayにそのまま渡す)。
  const selfMoves = await requestAnalyzeAll(boardAfterOpponent, preMoveSide)
  const bestSelfEval = bestOf(selfMoves).discDiff
  return {
    kind: 'ok',
    board1Ply: boardAfterSelf,
    opponentMoves,
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

/** 元局面(自分の番)パネルの「打てる場所」ヘッダ(T198要件3)。`originalMoves`未取得中は計算中である旨を表示する。 */
export function formatOriginalLegalCountHeader(originalMoves: readonly MoveEvalJson[] | null): string {
  if (!originalMoves) return '打てる場所を計算しています…'
  return `打てる場所: ${originalMoves.length} か所`
}

/** 1手先(相手番)パネルの「打てる場所」ヘッダ(T198要件3)。相手がパス/その時点で終局なら明記する。 */
export function formatOpponentLegalCountHeader(branch: TwoPlyBranchResult): string {
  if (branch.opponentMoves) return `打てる場所: ${branch.opponentMoves.length} か所`
  if (branch.opponentPassed) return '打てる場所: 0 か所(パス)'
  return '打てる場所: 0 か所(終局)'
}

/** 2手先(自分の番)パネルの「打てる場所」ヘッダ(T198要件3)。旧`formatTwoPlyBranchHeader`のうち末尾部分を独立させたもの。 */
export function formatSelfLegalCountHeader(branch: TwoPlyBranchResult): string {
  if (branch.kind === 'ok') return `打てる場所: ${branch.selfLegalCount} か所`
  if (branch.kind === 'selfPass') return '打てる場所: 0 か所(パス)'
  return `終局(石差${formatDiscDiff(branch.finalDiscDiff)})`
}

/** 相手がパスした(2手先盤面が1手先盤面と同一)ことを明記する注記行(T198: 盤面だけでは伝わりにくいため)。パスでなければ`null`。 */
export function formatOpponentPassNote(branch: TwoPlyBranchResult): string | null {
  return branch.opponentPassed ? '相手はパスしたため、盤面は1手先と同じです。' : null
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

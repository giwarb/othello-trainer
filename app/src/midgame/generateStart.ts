/**
 * 中盤練習モードの開始局面生成(T021、要件2)。
 *
 * (a) 定石DBの終端(`isLeaf`到達ライン)からランダムに1つ選ぶ `pickJosekiEndPosition`。
 * (b) エンジン自己対局によるランダム中盤局面を生成する `generateSelfPlayPosition`
 *    (WTHOR由来のランダム実戦局面の代替。タスク仕様「本タスクでのスコープ縮小」参照)。
 */

import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  hasLegalMove,
  initialBoard,
  legalMoves,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import type { JosekiDb } from '../joseki/types.ts'

export interface StartPosition {
  readonly board: Board
  readonly sideToMove: Side
}

/**
 * 定石DBの各ライン(`JosekiDb.lines`)からランダムに1つ選び、その終端局面
 * (`moveSeq`を初期局面から再生した局面)を返す。
 *
 * `moveSeq`は正規化済み(初手をf5とみなす変換後)の座標だが、初期局面
 * (`initialBoard()`)から素直に再生するだけで、向きが揃っているだけの正当な
 * オセロ局面になる(`joseki/buildDb.ts`が定石DBを構築する際と全く同じ手順)。
 * 練習用の開始局面としては向きを気にする必要がないため、逆正規化は行わない。
 */
export function pickJosekiEndPosition(
  josekiDb: JosekiDb,
  random: () => number = Math.random,
): StartPosition {
  if (josekiDb.lines.length === 0) {
    throw new RangeError('pickJosekiEndPosition: josekiDb has no lines')
  }
  const index = Math.min(Math.floor(random() * josekiDb.lines.length), josekiDb.lines.length - 1)
  const line = josekiDb.lines[index]!

  let board = initialBoard()
  let side: Side = 'black'
  for (const move of line.moveSeq) {
    board = applyMove(board, side, move)
    side = opposite(side)
  }
  return { board, sideToMove: side }
}

/** 自己対局のバランス確認(互角±3石差以内か)に使う軽量な探索条件。 */
const SELF_PLAY_CHECK_LIMIT: AnalyzeLimit = { depth: 6, exactFromEmpties: 0 }

export interface SelfPlayEngine {
  requestAnalyzeAll(board: Board, turn: Side, limit: AnalyzeLimit): Promise<MoveEvalJson[]>
}

export interface GenerateSelfPlayOptions {
  /** 進める手数の下限(既定15)。 */
  readonly minPly?: number
  /** 進める手数の上限(既定30)。 */
  readonly maxPly?: number
  /** 互角±3石差以内が得られるまでの最大試行回数(既定5)。 */
  readonly maxAttempts?: number
  /** 「互角」とみなす石差の絶対値の上限(既定3)。 */
  readonly maxDiscDiff?: number
  readonly random?: () => number
  readonly analyzeLimit?: AnalyzeLimit
}

/**
 * 初期局面からランダムに15〜30手(既定)進めた局面を生成し、
 * `engine.requestAnalyzeAll`で評価して互角±3石差以内であることを確認する。
 * 超えていれば再生成し(既定5回まで試行)、既定回数試行してもだめなら最後に
 * 生成した局面をそのままフォールバックとして返す(タスク仕様「本タスクでの
 * スコープ縮小」参照)。
 *
 * 各手は合法手から一様ランダムに選ぶ。タスク仕様は「毎手『上位数手からランダム』
 * 程度の軽い制約を入れることを推奨するが必須ではない」としているが、本実装では
 * (a)実装をシンプルに保つ、(b)そのような制約を入れるには結局エンジンによる
 * 着手ランキングが必要になり生成コストが増す、という理由から見送り、単純な
 * 一様ランダムウォークとした(バランス確認の`requestAnalyzeAll`呼び出しは
 * 1試行あたり1回で済む設計になっている)。
 */
export async function generateSelfPlayPosition(
  engine: SelfPlayEngine,
  options: GenerateSelfPlayOptions = {},
): Promise<StartPosition> {
  const {
    minPly = 15,
    maxPly = 30,
    maxAttempts = 5,
    maxDiscDiff = 3,
    random = Math.random,
    analyzeLimit = SELF_PLAY_CHECK_LIMIT,
  } = options

  let lastResult: StartPosition = { board: initialBoard(), sideToMove: 'black' }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const targetPly = minPly + Math.floor(random() * (maxPly - minPly + 1))
    const candidate = playRandomPly(targetPly, random)
    lastResult = candidate

    const allMoves = await engine.requestAnalyzeAll(candidate.board, candidate.sideToMove, analyzeLimit)
    if (allMoves.length === 0) continue

    const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
    if (Math.abs(best.discDiff) <= maxDiscDiff) {
      return candidate
    }
  }

  return lastResult
}

function playRandomPly(targetPly: number, random: () => number): StartPosition {
  let board = initialBoard()
  let side: Side = 'black'

  for (let i = 0; i < targetPly; i++) {
    if (!hasLegalMove(board, side)) {
      side = opposite(side)
      if (!hasLegalMove(board, side)) break
      continue
    }
    const moves = legalMoves(board, side)
    const move = moves[Math.min(Math.floor(random() * moves.length), moves.length - 1)]!
    board = applyMove(board, side, move)
    side = opposite(side)
  }

  return { board, sideToMove: side }
}

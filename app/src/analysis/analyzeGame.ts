/**
 * 棋譜解析パイプライン(T029、要件3・4・5、設計書§6.2)。
 *
 * 着手列(`GameRecord.moves`)を受け取り、以下の手順で解析する:
 * 1. `replayGame`で全局面を先頭から再生する(パスは自動処理、非合法手は
 *    `TranscriptReplayError`)。
 * 2. **終局側から**(`moves`の末尾から先頭へ向けて)1手ずつ解析する。
 *    各局面の解析は`AnalyzeEngine.requestAnalyzeAll`(≒`EngineClient`)を呼び、
 *    `ANALYZE_LIMIT`(空き22以下は完全読み、それより前はdepth18)を使う。
 *    キャッシュ(`cache.ts`)により同一局面の再解析を避ける。
 * 3. 各手のロス・分類(`classifyMove`)・逆転悪手判定を求める。逆転判定には
 *    「この手の直後の局面の黒視点評価」が要るが、終局側から処理しているため
 *    常に1つ後(=次に解析するより手数が多い側)の局面の値をすでに持っている
 *    (設計書の「終局側から解析する」意図と実装上も自然に合致する)。
 *
 * 空きマス数が大きい局面で完全読みに入って長時間ハングする事故(過去のFFO重い
 * 問題での経験)を避けるため、`ANALYZE_LIMIT.exactFromEmpties`は22に固定して
 * いる(エンジン側`engine/src/search.rs`の規約により、空き23以上の局面では
 * 完全読みは使われずdepth18の探索で打ち切られる)。
 */

import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  countDiscs,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import { hashBoard } from '../joseki/normalize.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { cacheKey, getCachedAnalysis, putCachedAnalysis } from './cache.ts'
import { classifyMove, DEFAULT_CLASSIFY_THRESHOLDS } from './classifyMove.ts'
import type { AnalyzeGameProgress, ClassifyThresholds, MoveAnalysis } from './types.ts'

/**
 * 棋譜解析で使う探索条件(要件3)。空き22以下は完全読み、それより前はdepth18相当。
 *
 * `timeMs`について: 当初`{ depth: 18, exactFromEmpties: 22 }`(時間予算なし)で
 * 実装したが、実機(Playwright)検証で初期局面1手の解析だけで60秒超かかることが
 * 判明した(`engine/src/search.rs`は`time_ms`未指定だと反復深化を`depth`まで
 * 時間無制限に進めるため、開局面のような分岐が広い局面ではdepth18到達に非常に
 * 長時間かかる)。過去のFFO重い問題での完全読みハング事故と同種のリスクであり、
 * 60手全てを解析する本パイプラインでは看過できないため、`midgame/PracticeMode.tsx`の
 * `MIDGAME_ANALYZE_LIMIT`(depth16, timeMs300)と同じ「反復深化+時間予算」方式に
 * 合わせ、`timeMs: 1500`を設定した(depth18はあくまで上限であり、実際には
 * ほとんどの局面で時間予算に達した時点の探索深さの結果を使うことになる)。
 */
export const ANALYZE_LIMIT: AnalyzeLimit = { depth: 18, timeMs: 1500, exactFromEmpties: 22 }

/** キャッシュキーに含める探索条件タグ。`ANALYZE_LIMIT`を変更した場合は別キーになる。 */
const LIMIT_TAG = `d${ANALYZE_LIMIT.depth}-e${ANALYZE_LIMIT.exactFromEmpties}`

/**
 * `analyzeGame`が解析エンジンに要求する最小限のインターフェース。
 * `EngineClient`はこれを満たすため、本番ではそのまま渡せる。単体テストでは
 * 決定的なフェイクを注入できる。
 */
export interface AnalyzeEngine {
  requestAnalyzeAll(board: Board, turn: Side, limit: AnalyzeLimit): Promise<MoveEvalJson[]>
}

/** 着手列の再生中に非合法手・終局後の着手を検出した場合に投げるエラー。 */
export class TranscriptReplayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptReplayError'
  }
}

/** `replayGame`が返す1局面。 */
export interface ReplayedPosition {
  readonly board: Board
  /** この局面で実際に着手する側(パス自動処理後)。両者とも合法手が無ければ`null`。 */
  readonly mover: Side | null
}

/**
 * 着手列を先頭から再生し、初期局面を含む`moves.length + 1`個の局面を返す
 * (`positions[i]`は`moves[i]`を打つ**前**の局面、`positions[moves.length]`は最終局面)。
 * パス(手番側に合法手が無い)は`resolveMover`で自動的に処理する。
 */
export function replayGame(moves: readonly string[]): ReplayedPosition[] {
  const start = initialBoard()
  const positions: ReplayedPosition[] = [{ board: start, mover: resolveMover(start, 'black') }]

  for (let i = 0; i < moves.length; i++) {
    const cur = positions[i]!
    if (cur.mover === null) {
      throw new TranscriptReplayError(
        `${i + 1}手目 "${moves[i]}" より前に終局しています(両者とも着手不可)`,
      )
    }
    const square = notationToSquare(moves[i]!)
    if (!legalMoves(cur.board, cur.mover).includes(square)) {
      throw new TranscriptReplayError(`${i + 1}手目 "${moves[i]}" はこの局面で合法手ではありません`)
    }
    const board = applyMove(cur.board, cur.mover, square)
    const nextSide = opposite(cur.mover)
    positions.push({ board, mover: resolveMover(board, nextSide) })
  }

  return positions
}

export interface AnalyzeGameOptions {
  readonly thresholds?: ClassifyThresholds
  readonly onProgress?: (progress: AnalyzeGameProgress) => void
  /** テスト用のIndexedDBファクトリ差し替え口(省略時は実際の`indexedDB`)。 */
  readonly dbFactory?: IDBFactory
}

function pickBest(moves: readonly MoveEvalJson[]): MoveEvalJson {
  return moves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
}

/** 局面を解析する(キャッシュヒットすればエンジンを呼ばない、要件5)。 */
async function analyzePosition(
  engine: AnalyzeEngine,
  board: Board,
  side: Side,
  dbFactory: IDBFactory | undefined,
): Promise<MoveEvalJson[]> {
  const key = cacheKey(hashBoard(board, side), LIMIT_TAG)
  const cached = await getCachedAnalysis(key, dbFactory)
  if (cached && cached.length > 0) return cached

  const allMoves = await engine.requestAnalyzeAll(board, side, ANALYZE_LIMIT)
  if (allMoves.length > 0) {
    await putCachedAnalysis(key, allMoves, dbFactory)
  }
  return allMoves
}

/**
 * 着手列を解析する(要件3・4・5)。終局側(`moves`の末尾)から先頭へ向けて解析する。
 * `moves`が空の場合は空配列を返す。
 */
export async function analyzeGame(
  engine: AnalyzeEngine,
  moves: readonly string[],
  options: AnalyzeGameOptions = {},
): Promise<MoveAnalysis[]> {
  const thresholds = options.thresholds ?? DEFAULT_CLASSIFY_THRESHOLDS
  const positions = replayGame(moves)
  const total = moves.length
  if (total === 0) return []

  const results: MoveAnalysis[] = new Array(total)

  // 最終局面の黒視点評価値を先に求める。真の終局(両者とも合法手なし)であれば
  // 確定石差、そうでなければ(棋譜が対局途中で終わっている場合)最終局面自体を
  // 解析して得られる最善手の評価値を使う。
  const finalPos = positions[total]!
  let nextBlackAdvantage: number
  if (finalPos.mover === null) {
    nextBlackAdvantage = countDiscs(finalPos.board, 'black') - countDiscs(finalPos.board, 'white')
  } else {
    const finalMoves = await analyzePosition(engine, finalPos.board, finalPos.mover, options.dbFactory)
    const best = pickBest(finalMoves)
    nextBlackAdvantage = finalPos.mover === 'black' ? best.discDiff : -best.discDiff
  }

  for (let i = total - 1; i >= 0; i--) {
    const pos = positions[i]!
    const mover = pos.mover
    if (mover === null) {
      // `replayGame`が既に検出しているはずだが、念のための防御。
      throw new TranscriptReplayError(`${i + 1}手目より前に終局しています`)
    }

    const allMoves = await analyzePosition(engine, pos.board, mover, options.dbFactory)
    const best = pickBest(allMoves)
    const playedNotation = moves[i]!
    const played = allMoves.find((m) => m.move === playedNotation) ?? best
    const lossDiscs = Math.max(0, best.discDiff - played.discDiff)
    const blackAdvantageBefore = mover === 'black' ? best.discDiff : -best.discDiff

    results[i] = {
      ply: i,
      move: playedNotation,
      side: mover,
      board: pos.board,
      isExact: best.type === 'exact',
      bestMove: best.move,
      bestDiscDiff: best.discDiff,
      playedDiscDiff: played.discDiff,
      lossDiscs,
      classification: classifyMove(lossDiscs, thresholds),
      reversal: Math.sign(blackAdvantageBefore) !== Math.sign(nextBlackAdvantage),
      blackAdvantageBefore,
      blackAdvantageAfter: nextBlackAdvantage,
    }

    nextBlackAdvantage = blackAdvantageBefore
    options.onProgress?.({ done: total - i, total, justAnalyzedPly: i })
  }

  return results
}

/**
 * 悪手分析パネル(T030、要件4・設計書§6.4)の「練習送り」。
 *
 * - 「中盤練習に送る」: 悪手局面を`midgame/pool.ts`の出題プール(IndexedDB)に
 *   `source: 'blunder-review'`として登録する(T021で設計済みの連携先をそのまま使う)。
 * - 「詰めオセロとして解いてみる」: 悪手局面の空きマス数が
 *   `MAX_INSTANT_TSUME_EMPTIES`(20)以下であれば、その場で全合法手を完全読みし、
 *   `tsume/filters.ts`(T027)の唯一解性・明確さフィルタを満たす場合のみ、
 *   即席の`Puzzle`相当のデータを構築する。事前生成プールへの永続登録は行わない
 *   (タスク仕様「やらないこと」によりその場でのプレイのみ)。
 *
 * 完全読みハング対策: `MAX_INSTANT_TSUME_EMPTIES`を超える局面では完全読みを
 * 一切行わない(呼び出し前にガードする)。20以下という上限は
 * `tsume/PlayMode.tsx`の`puzzleAnalyzeLimit`が問題データ(空き6〜20、
 * `tsume/types.ts`の`Puzzle.empties`コメント参照)に対して同じ
 * `{ depth: empties, exactFromEmpties: empties }`(時間予算なし)を安全に
 * 使っている前例に合わせている。
 */

import { bigintToHex } from '../engine/hex.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { countEmpty, hasLegalMove, type Board, type Side } from '../game/othello.ts'
import { addPoolEntry } from '../midgame/pool.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import { analyzeMoveOutcomes } from '../tsume/filters.ts'
import type { Puzzle, PuzzleMove, PuzzleOutcome } from '../tsume/types.ts'

/** 即席詰めオセロ判定を行う空きマス数の上限(タスク仕様「本タスクでのスコープ縮小」参照)。 */
export const MAX_INSTANT_TSUME_EMPTIES = 20

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/** 「中盤練習に送る」: 悪手局面を出題プールに登録する。 */
export async function sendToMidgamePractice(
  board: Board,
  turn: Side,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const entry: MidgamePoolEntry = {
    id: `blunder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    turn,
    source: 'blunder-review',
    createdAt: new Date().toISOString(),
  }
  await addPoolEntry(entry, factory)
}

/** `buildInstantTsumePuzzle`が呼ぶエンジンインターフェース(`EngineClient`のサブセット)。 */
export interface TsumeCheckEngine {
  requestAnalyzeAll(board: Board, turn: Side, limit: AnalyzeLimit): Promise<MoveEvalJson[]>
}

export type InstantTsumeCheck =
  | { readonly accepted: true; readonly puzzle: Puzzle }
  | { readonly accepted: false; readonly reason: string }

/**
 * 悪手局面(`board`・`turn`)を即席の詰めオセロ問題として出題できるか判定し、
 * 満たせば`Puzzle`相当のデータを構築する。
 *
 * - 空きマス数が`MAX_INSTANT_TSUME_EMPTIES`を超える場合はエンジンを呼ばずに却下する
 *   (完全読みハング対策)。
 * - 手番側に合法手が無い場合も却下する。
 * - 全合法手を完全読みし(`{ depth: empties, exactFromEmpties: empties }`、
 *   `puzzleAnalyzeLimit`と同じ規約)、`analyzeMoveOutcomes`で唯一解性・明確さを判定する。
 *   いずれか満たさなければ却下する。
 */
export async function buildInstantTsumePuzzle(
  engine: TsumeCheckEngine,
  board: Board,
  turn: Side,
): Promise<InstantTsumeCheck> {
  const empties = countEmpty(board)
  if (empties > MAX_INSTANT_TSUME_EMPTIES) {
    return {
      accepted: false,
      reason: `この局面は空きマスが${empties}あり、詰めオセロとして出題するには条件を満たしません(空き${MAX_INSTANT_TSUME_EMPTIES}マス以下が条件です)。`,
    }
  }
  if (!hasLegalMove(board, turn)) {
    return { accepted: false, reason: 'この局面には合法手がありません。' }
  }

  const limit: AnalyzeLimit = { depth: empties, exactFromEmpties: empties }
  const allMoves = await engine.requestAnalyzeAll(board, turn, limit)
  if (allMoves.length === 0) {
    return { accepted: false, reason: '合法手の評価取得に失敗しました。' }
  }

  const values = allMoves.map((m) => m.discDiff)
  const analysis = analyzeMoveOutcomes(values)
  if (!analysis.uniquenessOk || !analysis.clarityOk) {
    return {
      accepted: false,
      reason: 'この局面は詰めオセロとして出題するには条件を満たしません(唯一解性または明確さの基準を満たしません)。',
    }
  }

  const correctMoves = analysis.winnerIndices.map((i) => allMoves[i]!.move)
  const moves: PuzzleMove[] = allMoves.map((m, i) => ({
    square: m.move,
    discDiffForMover: m.discDiff,
    isBest: analysis.winnerIndices.includes(i),
  }))
  const outcome: PuzzleOutcome = analysis.best > 0 ? 'win' : analysis.best < 0 ? 'loss' : 'draw'

  const puzzle: Puzzle = {
    id: `blunder-instant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    sideToMove: turn,
    empties,
    correctMoves,
    bestDiscDiff: analysis.best,
    outcome,
    clarityMargin: analysis.clarityMargin,
    moves,
    // 即席判定のため難易度は算出しない(事前生成プールのように問題集団全体での
    // パーセンタイル分布と比較する`difficulty.ts`の仕組みは、1問だけのその場
    // 判定には適用できない)。中間値3を固定で使い、UI上では難易度表示を
    // 目立たせない(即席問題であることが分かる文脈でのみ使う想定)。
    difficulty: 3,
    difficultyRawScore: 0,
    tags: [],
  }

  return { accepted: true, puzzle }
}

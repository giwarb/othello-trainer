/**
 * 悪手分析パネル(T030、要件1・設計書§6.4)の「比較PV」を構築する純粋関数。
 *
 * 悪手局面から「実際に打たれた手→(以後の本譜進行、最大8手)」と
 * 「最善手→(最善進行、最大8手)」を並走リストとして構築する。
 *
 * - 「実際の進行」は棋譜そのものの以後の着手列(`GameRecord.moves`、
 *   `analyzeGame`が解析した実際の対局の継続)をそのまま使う(エンジンに
 *   再度問い合わせる必要はない)。
 * - 「最善進行」は最善手 + エンジンの`requestAnalyze`が返す`pv`フィールド
 *   (T018で追加済み)をそのまま使う。エンジン呼び出し自体は本モジュールの
 *   責務外とし、呼び出し側(`BlunderPanel.tsx`)が`pv`を取得してから
 *   本関数に渡す(本モジュールを副作用なしの純粋関数に保つため)。
 */

/** 比較PVで表示する最大手数(設計書§6.4「8手ずつ」)。 */
export const COMPARE_PV_MAX_PLIES = 8

export interface ComparePvResult {
  /** 実際に打たれた手から始まる本譜の継続(最大8手、`bestMove`側と同じ0始まりインデックス規約)。 */
  readonly playedContinuation: readonly string[]
  /** 最善手から始まる最善進行の継続(最大8手)。 */
  readonly bestContinuation: readonly string[]
  /** 両リストの短い方の長さぶん、各インデックスで手が一致しないか(分岐点ハイライト用)。 */
  readonly diverges: readonly boolean[]
  /** 最初に手が一致しなくなったインデックス(0始まり)。両リストの重複区間内に分岐が無ければ`null`。 */
  readonly firstDivergenceIndex: number | null
}

/**
 * 並走リストを構築する。
 *
 * @param gameMoves 対局全体の着手列("a1"〜"h8"記法)。
 * @param blunderPly 悪手局面の手数(0始まり。`gameMoves[blunderPly]`が実際に打たれた手)。
 * @param bestMove 悪手局面における最善手の記法。
 * @param bestPv 最善手を打った**後**の局面からのPV(エンジンの`AnalyzeResponseMessage.pv`、
 *   最善手自体は含まない)。
 */
export function buildComparePv(
  gameMoves: readonly string[],
  blunderPly: number,
  bestMove: string,
  bestPv: readonly string[],
): ComparePvResult {
  const playedContinuation = gameMoves.slice(blunderPly, blunderPly + COMPARE_PV_MAX_PLIES)
  const bestContinuation = [bestMove, ...bestPv].slice(0, COMPARE_PV_MAX_PLIES)

  const overlapLength = Math.min(playedContinuation.length, bestContinuation.length)
  const diverges: boolean[] = []
  let firstDivergenceIndex: number | null = null
  for (let i = 0; i < overlapLength; i++) {
    const differs = playedContinuation[i] !== bestContinuation[i]
    diverges.push(differs)
    if (differs && firstDivergenceIndex === null) {
      firstDivergenceIndex = i
    }
  }

  return { playedContinuation, bestContinuation, diverges, firstDivergenceIndex }
}

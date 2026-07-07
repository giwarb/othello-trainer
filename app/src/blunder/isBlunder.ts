/**
 * 悪手判定(T019)。
 *
 * T018の `EngineClient.requestAnalyzeAll` が返す現局面の全合法手の評価値
 * (`MoveEvalJson[]`)と、実際にユーザーが打った手を突き合わせ、
 * `BlunderConfig` で指定された3方式のいずれかで悪手かどうかを判定する
 * 純粋関数。副作用・非同期処理は一切行わない(呼び出し側が
 * `requestAnalyzeAll` の結果を取得してから渡す)。
 */

import type { MoveEvalJson } from '../engine/types.ts'
import type { BlunderConfig, BlunderJudgement } from './types.ts'

/**
 * 打った手(`playedMove`、"a1"〜"h8"記法)が悪手かどうかを判定する。
 *
 * - `moves` は着手前の局面における全合法手の評価値(`requestAnalyzeAll` の結果)。
 *   空配列(合法手なし)の場合は判定しようがないため `blunder: false` を返す。
 * - `moves` の中に `playedMove` と一致する要素が無い場合(通常起こらないが、
 *   呼び出し側の不整合に対する防御)は、最善手を打ったものとみなして
 *   `blunder: false` を返す。
 * - 順位は「評価値が同じ手は同順位」とする標準的な競技順位付け
 *   (例: 同点1位が2つあれば、その次は3位)。
 * - `lossDiscs` は最善手の評価値(石差)から打った手の評価値(石差)を引いた値
 *   で、常に0以上にクランプする(打った手がまさかの最善手超えになる
 *   ケース、すなわち探索の非決定性等は通常起こらないが念のため)。
 */
export function isBlunder(
  moves: readonly MoveEvalJson[],
  playedMove: string,
  config: BlunderConfig,
): BlunderJudgement {
  if (moves.length === 0) {
    return { blunder: false, lossDiscs: 0, rank: 0, bestMove: '' }
  }

  const sorted = [...moves].sort((a, b) => b.score - a.score)
  const best = sorted[0]!
  const played = sorted.find((m) => m.move === playedMove) ?? best

  const rank = 1 + sorted.filter((m) => m.score > played.score).length
  const lossDiscs = Math.max(0, best.discDiff - played.discDiff)

  return {
    blunder: judge(config, played, best, lossDiscs, rank),
    lossDiscs,
    rank,
    bestMove: best.move,
  }
}

function judge(
  config: BlunderConfig,
  played: MoveEvalJson,
  best: MoveEvalJson,
  lossDiscs: number,
  rank: number,
): boolean {
  switch (config.method) {
    case 'worseThanBest':
      return played.score < best.score
    case 'lossThreshold':
      return lossDiscs >= config.lossThreshold
    case 'rankThreshold':
      return rank > config.rankThreshold
  }
}

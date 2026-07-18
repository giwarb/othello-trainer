/**
 * 盤面セル評価オーバーレイ(T039)のロジック部分(純粋関数)。
 *
 * `MoveEvalOverlay.tsx`(Preactコンポーネント)から分離してあるのは、
 * このリポジトリの単体テスト(`vitest.config.ts`)が `src/**\/*.test.ts`
 * (拡張子`.tsx`は対象外)のみを対象にしており、コンポーネント本体をテストする
 * 仕組みが無いため(`BoardOverlay.tsx`も同様に無テスト)。分類→色マッピングの
 * ロジックだけはここに切り出してテスト可能にする。
 *
 * T138: 表示の考え方を「最善手からのロス量」から「評価値そのもの(mover視点の
 * 石差)」へ変更した。合法手の色分類(best/inaccuracy/dubious/blunder)は
 * 従来どおり最善手とのロス量で判定するが(定石cap適用前の生の探索品質を表す)、
 * 画面に出す数値は定石ブックcap(`applyBookCap`、仕様2〜4)適用後の評価値にする。
 */

import { classifyMove } from '../analysis/classifyMove.ts'
import type { ClassifyThresholds, MoveClassification } from '../analysis/types.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { notationToSquare } from '../game/othello.ts'

/** あるマス(候補手)についてのオーバーレイ表示情報。 */
export interface CellEval {
  /** 最善手とのロス量(定石cap適用前)に基づく4段階分類。色分けにのみ使う。 */
  readonly classification: MoveClassification
  /** この手を打った場合の評価値(mover視点の石差、centi-discではなく石差)。
   * `applyBookCap`適用前は`MoveEvalJson.discDiff`そのもの。 */
  readonly evalScore: number
}

/**
 * 候補手一括評価(`requestAnalyzeAll`の結果)から、マス(0〜63)ごとの
 * 分類・評価値を求める(定石ブックcapは適用しない生の値、`applyBookCap`で
 * 別途適用する)。`allMoves`が`null`または空配列の場合は空のMapを返す。
 *
 * 最善手は`discDiff`(石差、手番視点)が最大の候補手とする
 * (`engine/src/protocol.rs`により`discDiff = score / 100`なので`score`基準の
 * 順序と一致する。`blunder/isBlunder.ts`の`isBlunder`と同じ考え方)。
 */
export function computeCellEvals(
  allMoves: readonly MoveEvalJson[] | null,
  thresholds: ClassifyThresholds,
): ReadonlyMap<number, CellEval> {
  const result = new Map<number, CellEval>()
  if (!allMoves || allMoves.length === 0) return result

  const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))

  for (const move of allMoves) {
    const lossDiscs = Math.max(0, best.discDiff - move.discDiff)
    const classification = classifyMove(lossDiscs, thresholds)
    result.set(notationToSquare(move.move), { classification, evalScore: move.discDiff })
  }

  return result
}

/**
 * 定石ブックcap(T138仕様2〜4)を適用する純粋関数。
 *
 * `bookSquares`は現局面の合法手のうち定石ブックに登録されている手のマス集合
 * (`lookupJosekiNode`の`bookMoves`から求める。呼び出し側`app.tsx`の責務)。
 *
 * - `bookSquares`が空(合法手にブック手が残っていない、仕様4): 何もせず
 *   `cellEvals`をそのまま返す(素の評価値を表示)。
 * - `bookSquares`が空でない(仕様3): ブック手自身の評価値は0にする。
 *   非ブック手はプラスの評価値なら0に丸め、マイナスならそのまま
 *   (=ブック手が存在する間、表示はすべて0以下になる)。
 */
export function applyBookCap(
  cellEvals: ReadonlyMap<number, CellEval>,
  bookSquares: ReadonlySet<number>,
): ReadonlyMap<number, CellEval> {
  if (bookSquares.size === 0) return cellEvals

  const result = new Map<number, CellEval>()
  for (const [square, cellEval] of cellEvals) {
    const evalScore = bookSquares.has(square) ? 0 : Math.min(0, cellEval.evalScore)
    result.set(square, { ...cellEval, evalScore })
  }
  return result
}

/**
 * 盤面評価値(T138仕様1・2)。「各合法手の評価値の最大値」を基本とするが、
 * 定石ブックcapが働く間(`bookSquares`が空でない間、=現在の進行が定石ブック内)は
 * 0(互角)を返す。`allMoves`が`null`または空配列(合法手が無い・未取得)なら
 * `null`を返す。
 */
export function computeBoardEvalScore(
  allMoves: readonly MoveEvalJson[] | null,
  bookSquares: ReadonlySet<number>,
): number | null {
  if (!allMoves || allMoves.length === 0) return null
  if (bookSquares.size > 0) return 0
  return allMoves.reduce((max, move) => Math.max(max, move.discDiff), -Infinity)
}

/**
 * 評価値を「+3」「-1」のような符号付き整数石差の表示用文字列に整形する
 * (T138仕様: 丸めは四捨五入の整数石差、+0/-0は符号を付けず「0」)。
 */
export function formatEvalScore(evalScore: number): string {
  const rounded = Math.round(evalScore)
  if (rounded === 0) return '0'
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

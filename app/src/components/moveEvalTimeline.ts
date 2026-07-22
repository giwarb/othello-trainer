/**
 * 「打った手の評価値」の折れ線グラフ・評価バー化(T197)。
 *
 * 対局モード(`app.tsx`)・中盤練習モード(`midgame/PracticeMode.tsx`)の両方で、
 * 手を打つたびに記録する評価値の時系列データ(`PlayedMoveEval[]`)から、
 * (a) `EvalGraph`用の点列、(b) 評価バー(「前回の相手の手の評価値」)の表示状態、
 * を導出する純粋関数群。両モードの記録の型をここに集約しているのは、
 * 「打った手の評価値」という同じ概念を2箇所で別々に実装してロジックが
 * ズレるのを避けるため。
 *
 * 重要: `discDiff`は着手前局面の探索でその手に付いた評価値であり、
 * 打った後の盤面を改めて評価した値ではない(各呼び出し元がエンジン応答から
 * そのまま転記する。新規のエンジン呼び出しはこのモジュールも呼び出し元も
 * 一切行わない)。
 *
 * 符号規約: `discDiff`はこの手を実際に打った側(`side`)の視点(手番視点)。
 * 定石内の手(`source === 'joseki'`)・エンジン未呼び出し(`discDiff === null`、
 * CPUの定石ブック手)は、T046の規約に合わせグラフ上は評価値0固定+帯色分け
 * のみで表現し、評価バー上は数値を出さず「定石」表示にする。
 */
import type { EvalSource } from '../blunder/types.ts'
import type { EvalGraphPoint } from '../analysis/EvalGraph.tsx'
import type { Side } from '../game/othello.ts'

/** 1手ぶんの「打った手の評価値」記録。`ply`は1始まり(初期局面がply=0)。 */
export interface PlayedMoveEval {
  readonly ply: number
  readonly notation: string
  readonly side: Side
  /** 評価値(石差、打った側視点)。CPUの定石ブック手など探索していない手は`null`。 */
  readonly discDiff: number | null
  readonly source: EvalSource
  readonly isExact: boolean
}

/** `source === 'joseki'`または`discDiff === null`(定石ブック手)かどうか。 */
function isJosekiLike(entry: PlayedMoveEval): boolean {
  return entry.source === 'joseki' || entry.discDiff === null
}

/**
 * `history`(ply1..Nの各手の記録)から`EvalGraph`用の点列を組み立てる。
 * ply0(初期局面、互角0)を先頭に補い、各手の評価値を黒視点に変換する
 * (黒の手はそのまま、白の手は符号反転)。定石内の手・CPUの定石ブック手は
 * 値0固定+`evalSource: 'joseki'`にする(T046規約)。
 *
 * 悪手マーカー・ツールチップの`move`情報(最善手とのロス量・分類)は本タスクの
 * スコープ外(T195/T196)のため付与しない(`EvalGraphPoint.move`は省略可)。
 */
export function buildEvalGraphPoints(history: readonly PlayedMoveEval[]): EvalGraphPoint[] {
  const points: EvalGraphPoint[] = [{ ply: 0, value: 0, isExact: false, evalSource: 'midgame' }]
  for (const entry of history) {
    const joseki = isJosekiLike(entry)
    const value = joseki ? 0 : entry.side === 'black' ? entry.discDiff! : -entry.discDiff!
    points.push({
      ply: entry.ply,
      value,
      isExact: joseki ? false : entry.isExact,
      evalSource: joseki ? 'joseki' : entry.source,
    })
  }
  return points
}

/** 評価バー表示状態(「前回の相手の手の評価値」、T197)。 */
export type MoveEvalBarState =
  | { readonly kind: 'none' }
  | { readonly kind: 'joseki'; readonly side: Side }
  | { readonly kind: 'value'; readonly side: Side; readonly discDiff: number }

function barStateForEntry(entry: PlayedMoveEval | undefined): MoveEvalBarState {
  if (!entry) return { kind: 'none' }
  if (isJosekiLike(entry)) return { kind: 'joseki', side: entry.side }
  return { kind: 'value', side: entry.side, discDiff: entry.discDiff! }
}

/**
 * 指定した側(`side`。対局モードのCPU・中盤練習の相手)の直近の手の評価バー状態を返す。
 * その側の手がまだ1つも記録されていなければ`{kind: 'none'}`(まだ相手が打っていない)。
 */
export function lastMoveEvalBarStateFor(history: readonly PlayedMoveEval[], side: Side): MoveEvalBarState {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.side === side) return barStateForEntry(history[i])
  }
  return { kind: 'none' }
}

/**
 * 直近の手(手番を問わない)の評価バー状態を返す(2人対戦モード用、T197)。
 * まだ1手も打たれていなければ`{kind: 'none'}`。
 */
export function lastMoveEvalBarState(history: readonly PlayedMoveEval[]): MoveEvalBarState {
  return barStateForEntry(history[history.length - 1])
}

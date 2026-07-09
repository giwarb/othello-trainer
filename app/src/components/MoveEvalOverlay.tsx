import type { ClassifyThresholds, MoveClassification } from '../analysis/types.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import type { Side } from '../game/othello.ts'
import { computeCellEvals, formatLoss } from './moveEvalOverlayLogic.ts'
import './MoveEvalOverlay.css'

export interface MoveEvalOverlayProps {
  /** 現局面の全合法手の評価(`requestAnalyzeAll`の結果)。未取得なら`null`。 */
  readonly allMoves: readonly MoveEvalJson[] | null
  /** 評価値の視点(現局面の手番側)。ラベル表示にのみ使う。 */
  readonly mover: Side
  /** 悪手分類の閾値(`analysis/thresholdSettings.ts`で永続化されるユーザー設定)。 */
  readonly thresholds: ClassifyThresholds
  /** `false`のときは何も描画しない(オーバーレイ表示OFF)。 */
  readonly visible: boolean
}

const SIDE_LABEL: Record<Side, string> = { black: '黒', white: '白' }

const SQUARES = Array.from({ length: 64 }, (_, sq) => sq)

/**
 * 盤面上の各合法手のマスに、その手を打った場合の評価(候補手中の最善手との
 * ロス量に基づく4段階の色+数値)を重ねて表示するオーバーレイ(T039)。
 *
 * `analysis/BoardOverlay.tsx`(T032)と同じ実装方式: `Board`(Canvas描画)の
 * 直上に8x8のCSS Gridを`position:absolute`で重ね、`pointer-events:none`で
 * `Board`のクリック判定を透過させる。使用側は`.board-with-move-eval-overlay`
 * (`position:relative`)のラッパーで`Board`とこのコンポーネントを包む。
 *
 * `allMoves`が`null`、または`visible`が`false`のときは何も描画しない
 * (要件1・2)。他のモードからも再利用できるよう、対局モード固有の状態には
 * 依存しない汎用的なProps設計にしてある(スコープ外注記、T041で展開予定)。
 */
export function MoveEvalOverlay({ allMoves, mover, thresholds, visible }: MoveEvalOverlayProps) {
  if (!visible || !allMoves) return null

  const cellEvals = computeCellEvals(allMoves, thresholds)
  if (cellEvals.size === 0) return null

  return (
    <div class="move-eval-overlay" aria-hidden="true">
      {SQUARES.map((sq) => {
        const cellEval = cellEvals.get(sq)
        if (!cellEval) return <div key={sq} class="move-eval-overlay__cell" />

        const label = `${SIDE_LABEL[mover]}番 ロス${cellEval.lossDiscs.toFixed(1)}石`
        return (
          <div
            key={sq}
            class={`move-eval-overlay__cell move-eval-overlay__cell--${cellEval.classification}`}
            title={label}
          >
            <span class="move-eval-overlay__value">{formatLoss(cellEval.lossDiscs)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 分類ごとの表示ラベル(将来的な凡例表示等での再利用も見込んで公開しておく)。 */
export const MOVE_EVAL_CLASSIFICATION_LABEL: Record<MoveClassification, string> = {
  best: '最善/準最善',
  inaccuracy: '緩手',
  dubious: '疑問手',
  blunder: '悪手',
}

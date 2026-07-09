import { formatDiscDiff } from '../components/EvalBadge.tsx'
import type { AttributionBreakdown } from './types.ts'
import './AttributionWaterfall.css'

export interface AttributionWaterfallProps {
  /** `attribution.ts`の`buildAttribution`が返す分解結果。 */
  readonly breakdown: AttributionBreakdown
  /** セクション見出し(省略可)。 */
  readonly title?: string
}

/**
 * 評価内訳分解(T031、`othello-trainer-design-verbalization.md` §2)を
 * 滝グラフ(waterfall)形式で表示するコンポーネント。
 *
 * 現行評価関数の3項(モビリティ・隅・確定石)それぞれの寄与を横棒で表示し、
 * 最後に合計を示す。プラス寄与は緑、マイナス寄与は赤で色分けする。
 *
 * レスポンシブ対応: `grid-template-columns`を固定remで組み、バーの
 * トラック部分のみ`1fr`で可変にすることで、375px幅でも横スクロールが
 * 発生しないようにしている(`AttributionWaterfall.css`参照)。
 */
export function AttributionWaterfall({ breakdown, title }: AttributionWaterfallProps) {
  const maxAbs = Math.max(1e-9, ...breakdown.terms.map((t) => Math.abs(t.delta)))

  return (
    <div class="attribution-waterfall">
      {title && <p class="attribution-waterfall__title">{title}</p>}
      <ul class="attribution-waterfall__list">
        {breakdown.terms.map((term) => {
          const widthPercent = (Math.abs(term.delta) / maxAbs) * 100
          const isPositive = term.delta >= 0
          return (
            <li key={term.key} class="attribution-waterfall__row">
              <span class="attribution-waterfall__label">{term.label}</span>
              <span class="attribution-waterfall__bar-track">
                <span
                  class={`attribution-waterfall__bar${
                    isPositive ? ' attribution-waterfall__bar--positive' : ' attribution-waterfall__bar--negative'
                  }`}
                  style={{ width: `${widthPercent}%` }}
                />
              </span>
              <span class="attribution-waterfall__value">{formatDiscDiff(term.delta)}</span>
            </li>
          )
        })}
      </ul>
      <p class="attribution-waterfall__total">合計: {formatDiscDiff(breakdown.total)}</p>
    </div>
  )
}

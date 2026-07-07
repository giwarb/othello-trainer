import type { EvalSource } from '../blunder/types.ts'
import './EvalBadge.css'

export interface EvalBadgeProps {
  /** 評価値(石差、手番視点)。例: `+2.4` なら手番側が2.4石有利。 */
  discDiff: number
  /** 評価値の出典(定石/中盤/終盤)。バッジの色分けに使う。 */
  source: EvalSource
  /** 悪手判定結果。`true` なら悪手マークを表示する(省略時は表示しない)。 */
  blunder?: boolean
}

const SOURCE_LABEL: Record<EvalSource, string> = {
  joseki: '定石',
  exact: '終盤(完全読み)',
  midgame: '中盤(探索)',
}

/** 石差を符号付きの読みやすい文字列("+2.4"/"-0.8"/"+0.0")に整形する。 */
export function formatDiscDiff(value: number): string {
  return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1)
}

/**
 * 評価値・評価ソース(定石/中盤/終盤、色分け)・悪手マークを表示する
 * モード共通のバッジコンポーネント(T019)。
 *
 * レスポンシブ対応: `flex-wrap` + 相対単位(em/rem)により、狭い画面幅
 * (375px程度)でも折り返しはするが文字が潰れたり画面からはみ出したり
 * しない(`EvalBadge.css` 参照)。
 */
export function EvalBadge({ discDiff, source, blunder = false }: EvalBadgeProps) {
  return (
    <span class={`eval-badge eval-badge--${source}${blunder ? ' eval-badge--blunder' : ''}`}>
      <span class="eval-badge__value">{formatDiscDiff(discDiff)}</span>
      <span class="eval-badge__source">{SOURCE_LABEL[source]}</span>
      {blunder && <span class="eval-badge__blunder-mark">悪手</span>}
    </span>
  )
}

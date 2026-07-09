import type { EvalSource } from '../blunder/types.ts'
import './EvalBadge.css'

export interface EvalBadgeProps {
  /** 評価値(石差、手番視点)。例: `+2` なら手番側が2石有利(表示は整数に丸める、T049)。 */
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

/**
 * 石差を符号付きの整数文字列("+8"/"-5"/"+0")に整形する(T049)。
 *
 * Edaxをはじめとする強豪オセロAI実装は、中盤評価も最終的な石数差らしい
 * 整数値で表示する。本アプリの評価値も内部的には浮動小数点で計算するが、
 * 表示上は`Math.round`で丸めた整数のみを見せる(内部計算・悪手判定閾値
 * には影響しない、あくまで表示フォーマットの変更)。
 *
 * 丸め後の値で符号を判定するため、`-0.4`のような微小な負値は`Math.round`で
 * `-0`になり(`-0 >= 0`はJSでは`true`)、`+0`と表示される。
 */
export function formatDiscDiff(value: number): string {
  const rounded = Math.round(value)
  return rounded >= 0 ? `+${rounded}` : `${rounded}`
}

/**
 * 評価値・評価ソース(定石/中盤/終盤、色分け)・悪手マークを表示する
 * モード共通のバッジコンポーネント(T019)。
 *
 * `source === 'joseki'`のときは`discDiff`の数値を表示しない(T046)。
 * 定石内の評価値は毎回浅いヒューリスティック探索で計算された値であり
 * 本質的にノイズが大きく、そのまま数値を出すと「定石なのに評価が
 * 無意味に暴れる」矛盾した見え方になるため、「定石」ラベルのみとする。
 *
 * レスポンシブ対応: `flex-wrap` + 相対単位(em/rem)により、狭い画面幅
 * (375px程度)でも折り返しはするが文字が潰れたり画面からはみ出したり
 * しない(`EvalBadge.css` 参照)。
 */
export function EvalBadge({ discDiff, source, blunder = false }: EvalBadgeProps) {
  return (
    <span class={`eval-badge eval-badge--${source}${blunder ? ' eval-badge--blunder' : ''}`}>
      {source !== 'joseki' && <span class="eval-badge__value">{formatDiscDiff(discDiff)}</span>}
      <span class="eval-badge__source">{SOURCE_LABEL[source]}</span>
      {blunder && <span class="eval-badge__blunder-mark">悪手</span>}
    </span>
  )
}

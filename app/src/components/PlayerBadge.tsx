import type { Side } from '../game/othello.ts'
import './PlayerBadge.css'

export interface PlayerBadgeProps {
  /** このバッジが表す色。石アイコンの色・`player-badge--black`/`--white`クラスの決定に使う。 */
  readonly side: Side
  /** 表示ラベル(「あなた」「CPU」「相手」「黒」「白」等、呼び出し側が決める)。 */
  readonly label: string
  /** この色の現在の石数。 */
  readonly count: number
  /** 現在この色の手番かどうか。`true`のときアクセント色でハイライトする(要件1)。 */
  readonly active: boolean
  /** 思考中(CPU探索中)かどうか。`true`のときスピナー+「考え中...」をバッジ内に表示する(要件1)。 */
  readonly thinking?: boolean
}

/**
 * 対局・中盤練習・詰めオセロ共通の「手番側ハイライト+石数+思考中表示」バッジ
 * (T136要件1)。
 *
 * 従来は「あなたは黒番です。手番: 黒(思考中...)」「黒: 2 / 白: 2」という
 * 素テキストで表示していた情報(どちらが自分か・今どちらの番か・石数差・
 * CPUが考え中かどうか)を、盤の直上に並べる2つのバッジに集約する。手番側は
 * `player-badge--active`クラスでアクセント色にハイライトし、`thinking`が
 * 真の場合のみバッジ内にスピナーと「考え中...」を出す(2色同時に思考中に
 * なることはないため、呼び出し側は該当する片方のバッジにだけ`thinking`を
 * 渡せばよい)。
 *
 * 石アイコン(`.player-badge__disc`)はCSSのみで描画する(コンポーネント自体は
 * どちらの色でも同じマークアップを共有し、色の違いは`side`由来のクラスで
 * 表現する)。
 */
/**
 * `side`・`label`・`count`・`active`・`thinking`から、スクリーンリーダー向けの
 * バッジ全体の要約文を組み立てる(T137追加要件5)。
 *
 * T136で対局・中盤練習・詰めオセロの手番表示を素テキストからこのバッジへ
 * 置き換えた際、対局モードは「あなたは黒番です。手番: 黒」という文言を
 * `.sr-only`で残したが、中盤練習・詰めオセロは素テキストを削除しただけで
 * 代替が無く、SR利用者向けの情報(「あなたは○番」相当)が後退していた
 * (T136 codex-review指摘・軽微5)。コンポーネント自身に`aria-label`を
 * 持たせることで、呼び出し側のJSX変更なしに3モード共通で後退を解消する。
 */
function playerBadgeAriaLabel(side: Side, label: string, count: number, active: boolean, thinking: boolean): string {
  const sideLabel = side === 'black' ? '黒' : '白'
  const parts = [`${label}(${sideLabel}番)`, `石数${count}`]
  if (active) parts.push('手番です')
  if (thinking) parts.push('考え中')
  return parts.join('、')
}

export function PlayerBadge({ side, label, count, active, thinking = false }: PlayerBadgeProps) {
  return (
    <div
      class={`player-badge player-badge--${side}${active ? ' player-badge--active' : ''}`}
      aria-current={active ? 'true' : undefined}
      aria-label={playerBadgeAriaLabel(side, label, count, active, thinking)}
    >
      <span class="player-badge__disc" aria-hidden="true" />
      <span class="player-badge__label">{label}</span>
      <span class="player-badge__count">{count}</span>
      {thinking && (
        <span class="player-badge__thinking">
          <span class="player-badge__spinner" aria-hidden="true" />
          考え中...
        </span>
      )}
    </div>
  )
}

import './EvalBar.css'

export interface EvalBarProps {
  /** 石差(手番に依らず、原則プレイヤー視点で渡すことを想定)。-16〜+16でクリップする。 */
  discDiff: number
}

const CLAMP = 16

/**
 * 評価バー(石差スケール、要件8)。
 *
 * `PracticeMode.tsx`側で「既定非表示・失敗時のみ自動表示」を制御するため、
 * 本コンポーネント自体は表示/非表示の判断を持たず、渡された値をそのまま
 * バーとして描画するだけの薄い部品にしてある。
 *
 * レスポンシブ対応: 相対単位(rem/%)のみを使い、`EvalBar.css`の
 * `@media (max-width: 400px)`で375px幅程度でも崩れないようにしてある。
 */
export function EvalBar({ discDiff }: EvalBarProps) {
  const clamped = Math.max(-CLAMP, Math.min(CLAMP, discDiff))
  const percent = ((clamped + CLAMP) / (CLAMP * 2)) * 100
  const label = discDiff >= 0 ? `+${discDiff.toFixed(1)}` : discDiff.toFixed(1)

  // 中央(50% = 互角)を起点に、優勢側へ向かって帯を伸ばす形で表示する。
  const fillLeft = Math.min(50, percent)
  const fillWidth = Math.abs(percent - 50)

  return (
    <div class="midgame-eval-bar" role="img" aria-label={`評価: ${label}石`}>
      <div class="midgame-eval-bar__track">
        <div
          class={`midgame-eval-bar__fill${discDiff >= 0 ? ' midgame-eval-bar__fill--positive' : ' midgame-eval-bar__fill--negative'}`}
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />
        <div class="midgame-eval-bar__zero" />
      </div>
      <span class="midgame-eval-bar__label">{label}</span>
    </div>
  )
}

import './ResultCelebration.css'
import type { CelebrationKind } from './resultCelebrationLogic.ts'

export interface ResultCelebrationProps {
  kind: CelebrationKind
  message: string
}

/**
 * 紙吹雪の各片の見た目(左位置%・アニメーション遅延秒・色バリエーション)。
 * `Math.random()`で毎回生成すると、演出中に親コンポーネントが再レンダー
 * されるたび(候補手評価の取得完了等)に紙吹雪の位置が変わってしまい
 * 「降り直す」ように見えてしまう。固定の配置パターンにすることで、
 * 表示中は常に同じ見た目を保つ。
 */
const CONFETTI_PIECES: ReadonlyArray<{ left: number; delay: number; hue: 0 | 1 | 2 | 3 }> = [
  { left: 4, delay: 0, hue: 0 },
  { left: 12, delay: 0.15, hue: 1 },
  { left: 20, delay: 0.05, hue: 2 },
  { left: 30, delay: 0.25, hue: 3 },
  { left: 40, delay: 0.1, hue: 0 },
  { left: 50, delay: 0.3, hue: 1 },
  { left: 58, delay: 0, hue: 2 },
  { left: 66, delay: 0.2, hue: 3 },
  { left: 74, delay: 0.1, hue: 0 },
  { left: 82, delay: 0.3, hue: 1 },
  { left: 90, delay: 0.15, hue: 2 },
  { left: 96, delay: 0.05, hue: 3 },
]

/**
 * 対局モード(`PlayMode`)終局時の勝敗演出(T067)。
 *
 * `kind`に応じてトーンを変える:
 * - `'win'`(人間の勝ち): 紙吹雪が舞う華やかな演出 + 結果テキストが弾むように登場
 * - `'lose'`(人間の負け): 勝ちほど華美にせず、静かなフェードインのみ
 * - `'draw'`: デザイントークン(`--color-accent`系)を使った中立的なフェードイン
 *
 * `prefers-reduced-motion: reduce`環境では`ResultCelebration.css`側の
 * メディアクエリで全アニメーションを無効化し、紙吹雪自体を非表示にする
 * (要件4)。紙吹雪は`aria-hidden`かつ`pointer-events: none`で、自身の矩形内
 * (`overflow: hidden`)に収まるため、下に続く操作ボタン類をブロックしない
 * (要件5)。
 */
export function ResultCelebration({ kind, message }: ResultCelebrationProps) {
  return (
    <div class={`result-celebration result-celebration--${kind}`}>
      {kind === 'win' && (
        <div class="result-celebration__confetti" aria-hidden="true">
          {CONFETTI_PIECES.map((piece, index) => (
            <span
              key={index}
              class={`result-celebration__confetti-piece result-celebration__confetti-piece--hue${piece.hue}`}
              style={{ left: `${piece.left}%`, animationDelay: `${piece.delay}s` }}
            />
          ))}
        </div>
      )}
      <p class="result-celebration__message">{message}</p>
    </div>
  )
}

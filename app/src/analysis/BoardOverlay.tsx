import type { BoardHighlights } from './motifs.ts'
import './BoardOverlay.css'

/** どのオーバーレイ種別を表示するか(要件3: チェックボックス等で切り替え)。 */
export interface OverlayVisibility {
  readonly frontier: boolean
  readonly stable: boolean
  readonly seed: boolean
  readonly dangerousCorners: boolean
}

export interface BoardOverlayProps {
  readonly highlights: BoardHighlights
  readonly visible: OverlayVisibility
}

type Category = keyof OverlayVisibility

/**
 * 1マスに複数のカテゴリが該当する場合、シンプルさを優先し最も情報価値が高いと
 * 判断した1色だけを表示する(実装者判断)。優先順位: 危険なX/C打ちマス(直接的な
 * 損失リスク) > 種石(将来のリスク) > 確定石(すでに確定した安全) > フロンティア
 * (単なる形状情報)。
 */
const PRIORITY: readonly Category[] = ['dangerousCorners', 'seed', 'stable', 'frontier']

function categoryFor(square: number, highlights: BoardHighlights, visible: OverlayVisibility): Category | null {
  for (const category of PRIORITY) {
    if (!visible[category]) continue
    if (highlights[category].includes(square)) return category
  }
  return null
}

const SQUARES = Array.from({ length: 64 }, (_, sq) => sq)

/**
 * `Board`(Canvas描画、`components/Board.tsx`)に重ねて表示する、特徴量由来の
 * マスハイライト(T032、要件3)。8x8のCSS gridで各マスに半透明の色を重ねる、
 * クリックを透過する(`pointer-events:none`)オーバーレイ。
 *
 * 使用側(`BlunderPanel.tsx`)は、このコンポーネントを`Board`の直上に
 * `position:relative`のラッパーで重ねて配置する(`BoardOverlay.css`の
 * `.board-overlay`が`position:absolute; inset:0`)。
 */
export function BoardOverlay({ highlights, visible }: BoardOverlayProps) {
  return (
    <div class="board-overlay" aria-hidden="true">
      {SQUARES.map((sq) => {
        const category = categoryFor(sq, highlights, visible)
        return <div key={sq} class={`board-overlay__cell${category ? ` board-overlay__cell--${category}` : ''}`} />
      })}
    </div>
  )
}

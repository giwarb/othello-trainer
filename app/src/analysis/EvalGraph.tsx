import type { EvalSource } from '../blunder/types.ts'
import type { MoveClassification } from './types.ts'
import './EvalGraph.css'

/** グラフ上の1点(局面)。`ply`は0(初期局面)〜`moves.length`(最終局面)。 */
export interface EvalGraphPoint {
  readonly ply: number
  /** 黒視点の評価値(石差、クリップ前)。定石区間は0(互角)に固定される(T046)。 */
  readonly value: number
  /** この点に至る直前の解析(`ply`>0の場合)が完全読みだったか。`ply === 0`では未使用。 */
  readonly isExact: boolean
  /**
   * この局面(`ply`手目時点)の評価ソース(T046)。`isExact`と同じ規約で
   * `MoveAnalysis.evalSource`をそのまま転記したもの。帯の色分け
   * (定石/中盤/終盤の3色)に使う。
   */
  readonly evalSource: EvalSource
}

/** 悪手マーカー(要件6)。`ply`はその手を打った**後**の局面(グラフ上のx位置)。 */
export interface EvalGraphMarker {
  readonly ply: number
  readonly classification: MoveClassification
  readonly reversal: boolean
}

export interface EvalGraphProps {
  readonly points: readonly EvalGraphPoint[]
  readonly markers: readonly EvalGraphMarker[]
  /** 現在選択中の局面(ハイライト表示、`AnalysisMode`のジャンプ機能と連動)。 */
  readonly currentPly?: number | null
  /** グラフ上のいずれかの局面がクリックされたときに呼ばれる。 */
  readonly onSelectPly?: (ply: number) => void
  /**
   * 悪手マーカー(?!/?/??、逆転悪手)がクリックされたときに呼ばれる(T030、
   * 悪手分析パネルを開く用途)。省略時はマーカークリックも`onSelectPly`と
   * 同じ(局面ジャンプのみ)動作になる。
   */
  readonly onMarkerClick?: (ply: number) => void
}

/** 評価値のクリップ範囲(石差)。`midgame/EvalBar.tsx`の`CLAMP`定数と同じ値を踏襲する。 */
const CLAMP = 16

const MARKER_LABEL: Record<MoveClassification, string> = {
  best: '',
  inaccuracy: '?!',
  dubious: '?',
  blunder: '??',
}

const PADDING_X = 24
const PADDING_Y = 16
const PLOT_HEIGHT = 160
const HEIGHT = PLOT_HEIGHT + PADDING_Y * 2

function clamp(v: number): number {
  return Math.max(-CLAMP, Math.min(CLAMP, v))
}

/** 帯の色分けクラス(T046: 定石/完全読み/ヒューリスティックの3区分、定石を優先)。 */
function bandClass(point: EvalGraphPoint): string {
  if (point.evalSource === 'joseki') return 'eval-graph__band--joseki'
  return point.isExact ? 'eval-graph__band--exact' : 'eval-graph__band--midgame'
}

/**
 * 評価グラフ(要件6、設計書§6.3)。
 *
 * 横軸=手数、縦軸=石差(±16クリップ、黒優勢を上)。完全読み区間(`isExact`)は
 * ヒューリスティック区間と塗り(帯の色)を変えて表示する。悪手マーカー(?!/?/??、
 * 逆転悪手は赤強調)をプロット上に表示し、クリックでその局面へジャンプできる
 * (`onSelectPly`)。
 *
 * レスポンシブ対応: SVGの`viewBox`を使い、CSS側で`width:100%; height:auto`とする
 * ことでコンテナ幅に追従する(`Board.tsx`のようなJS側のリサイズ処理は不要)。
 */
export function EvalGraph({ points, markers, currentPly = null, onSelectPly, onMarkerClick }: EvalGraphProps) {
  const maxPly = Math.max(1, points.length - 1)
  const width = Math.max(320, maxPly * 10)
  const plotWidth = width - PADDING_X * 2

  const xFor = (ply: number) => PADDING_X + (ply / maxPly) * plotWidth
  const yFor = (value: number) => PADDING_Y + (1 - (clamp(value) + CLAMP) / (CLAMP * 2)) * PLOT_HEIGHT
  const zeroY = yFor(0)

  const markerByPly = new Map(markers.map((m) => [m.ply, m]))

  return (
    <div class="eval-graph">
      <svg
        class="eval-graph__svg"
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label="評価グラフ(横軸: 手数、縦軸: 石差、黒優勢が上)"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 定石/完全読み/ヒューリスティック区間の帯(要件6、T046で定石区間を追加)。 */}
        {points.slice(0, -1).map((p, i) => {
          const next = points[i + 1]!
          const x1 = xFor(p.ply)
          const x2 = xFor(next.ply)
          // 定石区間は`value`が常に0(=zeroY)のため、通常の「線〜0石線」塗り
          // (曲線とゼロ線の間)では面積が潰れて色が見えなくなってしまう。
          // そのため定石区間だけはプロット全高の帯として描画する(T046)。
          if (bandClass(next) === 'eval-graph__band--joseki') {
            return (
              <rect
                key={`band-${p.ply}`}
                class="eval-graph__band eval-graph__band--joseki"
                x={x1}
                y={PADDING_Y}
                width={x2 - x1}
                height={PLOT_HEIGHT}
              />
            )
          }
          const y1 = yFor(p.value)
          const y2 = yFor(next.value)
          return (
            <polygon
              key={`band-${p.ply}`}
              class={`eval-graph__band ${bandClass(next)}`}
              points={`${x1},${y1} ${x2},${y2} ${x2},${zeroY} ${x1},${zeroY}`}
            />
          )
        })}

        {/* 0石(互角)の基準線。 */}
        <line class="eval-graph__zero-line" x1={PADDING_X} y1={zeroY} x2={PADDING_X + plotWidth} y2={zeroY} />

        {/* 評価値の折れ線。 */}
        <polyline
          class="eval-graph__line"
          points={points.map((p) => `${xFor(p.ply)},${yFor(p.value)}`).join(' ')}
        />

        {/* 各局面のクリック領域 + 現在位置ハイライト。 */}
        {points.map((p) => (
          <circle
            key={`pt-${p.ply}`}
            class={`eval-graph__point${p.ply === currentPly ? ' eval-graph__point--current' : ''}`}
            cx={xFor(p.ply)}
            cy={yFor(p.value)}
            r={p.ply === currentPly ? 4 : 2.5}
            onClick={() => onSelectPly?.(p.ply)}
          >
            <title>{`${p.ply}手目時点: ${p.value >= 0 ? '+' : ''}${p.value.toFixed(1)}石`}</title>
          </circle>
        ))}

        {/* 悪手マーカー(要件6): ?!/?/??、逆転悪手は赤強調。 */}
        {points.map((p) => {
          const marker = markerByPly.get(p.ply)
          if (!marker || marker.classification === 'best') return null
          return (
            <text
              key={`marker-${p.ply}`}
              class={`eval-graph__marker eval-graph__marker--${marker.classification}${marker.reversal ? ' eval-graph__marker--reversal' : ''}`}
              x={xFor(p.ply)}
              y={yFor(p.value) - 8}
              text-anchor="middle"
              onClick={() => (onMarkerClick ?? onSelectPly)?.(p.ply)}
            >
              {MARKER_LABEL[marker.classification]}
            </text>
          )
        })}
      </svg>
      <p class="eval-graph__legend">
        <span class="eval-graph__legend-item">
          <span class="eval-graph__legend-swatch eval-graph__legend-swatch--joseki" />
          序盤(定石)
        </span>
        <span class="eval-graph__legend-item">
          <span class="eval-graph__legend-swatch eval-graph__legend-swatch--exact" />
          終盤(完全読み確定)
        </span>
        <span class="eval-graph__legend-item">
          <span class="eval-graph__legend-swatch eval-graph__legend-swatch--midgame" />
          中盤(ヒューリスティック探索)
        </span>
      </p>
    </div>
  )
}

import { useState } from 'preact/hooks'
import type { EvalSource } from '../blunder/types.ts'
import { formatDiscDiff } from '../components/EvalBadge.tsx'
import type { Side } from '../game/othello.ts'
import type { MoveClassification } from './types.ts'
import './EvalGraph.css'

/**
 * グラフの点に至る直前の着手の情報(T063、カーソル追従ツールチップ用)。
 * `EvalGraphPoint.ply === 0`(初期局面)には対応する着手が無いため`undefined`になる。
 */
export interface EvalGraphPointMove {
  /** この手を打った側。 */
  readonly side: Side
  /** この手の記法("a1"〜"h8")。 */
  readonly notation: string
  /** 最善手とのロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** ロス量に基づく分類。 */
  readonly classification: MoveClassification
  /** この手で累積評価値(黒視点)の符号が入れ替わったか(逆転悪手)。 */
  readonly reversal: boolean
}

/** グラフ上の1点(局面)。`ply`は0(初期局面)〜`moves.length`(最終局面)。 */
export interface EvalGraphPoint {
  readonly ply: number
  /**
   * 黒視点の評価値(石差、クリップ前)。局面ごとに独立した探索の生値ではなく、
   * `analyzeGame`が計算する累積評価値(T056、最善手が続く区間は変化しない)。
   * 定石区間は0(互角)に固定される(T046)。
   */
  readonly value: number
  /** この点に至る直前の解析(`ply`>0の場合)が完全読みだったか。`ply === 0`では未使用。 */
  readonly isExact: boolean
  /**
   * この局面(`ply`手目時点)の評価ソース(T046)。`isExact`と同じ規約で
   * `MoveAnalysis.evalSource`をそのまま転記したもの。帯の色分け
   * (定石/中盤/終盤の3色)に使う。
   */
  readonly evalSource: EvalSource
  /**
   * この点に至る直前の着手(手番・記法・ロス・分類、T063)。ツールチップの
   * 表示用。`ply === 0`(初期局面)では着手が存在しないため`undefined`。
   */
  readonly move?: EvalGraphPointMove
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

const MARKER_LABEL: Record<MoveClassification, string> = {
  best: '',
  inaccuracy: '?!',
  dubious: '?',
  blunder: '??',
}

/** ツールチップの「分類」欄に出す文字列(`AnalysisMode.tsx`のムーブリストと同じ表記)。 */
const CLASSIFICATION_LABEL: Record<MoveClassification, string> = {
  best: '◎',
  inaccuracy: '?!',
  dubious: '?',
  blunder: '??',
}

const CLASSIFICATION_TEXT: Record<MoveClassification, string> = {
  best: '最善/準最善',
  inaccuracy: '緩手',
  dubious: '疑問手',
  blunder: '悪手',
}

const PADDING_X = 32
const PADDING_Y = 16
const PLOT_HEIGHT = 160
const HEIGHT = PLOT_HEIGHT + PADDING_Y * 2

/**
 * 縦軸の範囲候補(石差)とその目盛り間隔(T063)。理論上限は±64石(黒石・白石の
 * 最大差)だが、通常の対局では評価値の振れ幅はもっと小さいため、実際のデータの
 * 絶対値最大を包含できる最小の候補を採用する(小さな対局では軸を圧縮して見やすく、
 * 大きな悪手が連続した対局では自動的に軸を拡げて頭打ち(クリップ)にならないようにする)。
 * どの候補でも目盛りは9本(0を挟んで上下4本ずつ、`range / step === 4`)になる。
 */
const AXIS_RANGE_CANDIDATES: readonly { readonly range: number; readonly step: number }[] = [
  { range: 8, step: 2 },
  { range: 16, step: 4 },
  { range: 32, step: 8 },
  { range: 64, step: 16 },
]

function axisConfigFor(points: readonly EvalGraphPoint[]): { readonly range: number; readonly step: number } {
  const dataMax = points.reduce((max, p) => Math.max(max, Math.abs(p.value)), 0)
  return (
    AXIS_RANGE_CANDIDATES.find((c) => dataMax <= c.range) ?? AXIS_RANGE_CANDIDATES[AXIS_RANGE_CANDIDATES.length - 1]!
  )
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

/** 帯の色分けクラス(T046: 定石/完全読み/ヒューリスティックの3区分、定石を優先)。 */
function bandClass(point: EvalGraphPoint): string {
  if (point.evalSource === 'joseki') return 'eval-graph__band--joseki'
  return point.isExact ? 'eval-graph__band--exact' : 'eval-graph__band--midgame'
}

/**
 * 評価グラフ(要件6、設計書§6.3)。
 *
 * 横軸=手数、縦軸=石差(黒優勢を上)。縦軸の範囲は実際のデータの最大絶対値に
 * 応じて±8〜±64石の間で自動調整し(T063、`axisConfigFor`)、数値目盛りを表示する。
 * 完全読み区間(`isExact`)はヒューリスティック区間と塗り(帯の色)を変えて表示する。
 * 悪手マーカー(?!/?/??、逆転悪手は赤強調)をプロット上に表示し、クリックで
 * その局面へジャンプできる(`onSelectPly`)。
 *
 * グラフ上をポインター(マウス/タッチ)でホバーすると、最も近い手数の点に
 * カーソル追従のツールチップ(手数・手番・着手・評価値・ロス・分類)を表示する
 * (T063)。SVGネイティブの`<title>`は表示が遅く点上でしか反応しないため使わず、
 * `<svg>`要素全体の`onPointerMove`/`onPointerDown`でx座標から最も近い点を求め、
 * HTMLオーバーレイ(`.eval-graph__tooltip`)として描画する。
 *
 * レスポンシブ対応: SVGの`viewBox`を使い、CSS側で`width:100%; height:auto`とする
 * ことでコンテナ幅に追従する(`Board.tsx`のようなJS側のリサイズ処理は不要)。
 */
export function EvalGraph({ points, markers, currentPly = null, onSelectPly, onMarkerClick }: EvalGraphProps) {
  const [hoverPly, setHoverPly] = useState<number | null>(null)

  const maxPly = Math.max(1, points.length - 1)
  const width = Math.max(320, maxPly * 10)
  const plotWidth = width - PADDING_X * 2

  const { range, step } = axisConfigFor(points)
  const clampValue = (v: number) => Math.max(-range, Math.min(range, v))

  const xFor = (ply: number) => PADDING_X + (ply / maxPly) * plotWidth
  const yFor = (value: number) => PADDING_Y + (1 - (clampValue(value) + range) / (range * 2)) * PLOT_HEIGHT
  const zeroY = yFor(0)

  const ticks: number[] = []
  for (let t = -range; t <= range; t += step) ticks.push(t)

  const markerByPly = new Map(markers.map((m) => [m.ply, m]))

  /** ポインター位置(クライアント座標)から最も近い点を求め、ホバー状態を更新する(T063)。 */
  const updateHover = (rect: DOMRect, clientX: number) => {
    if (points.length === 0 || rect.width === 0) return
    const svgX = ((clientX - rect.left) / rect.width) * width
    let nearest = points[0]!
    let nearestDist = Math.abs(xFor(nearest.ply) - svgX)
    for (const p of points) {
      const d = Math.abs(xFor(p.ply) - svgX)
      if (d < nearestDist) {
        nearestDist = d
        nearest = p
      }
    }
    setHoverPly(nearest.ply)
  }

  const hoverPoint = hoverPly === null ? null : (points.find((p) => p.ply === hoverPly) ?? null)
  const hoverFraction = hoverPoint ? xFor(hoverPoint.ply) / width : 0
  const tooltipAlign = hoverFraction < 0.2 ? 'start' : hoverFraction > 0.8 ? 'end' : 'center'

  return (
    <div class="eval-graph">
      <div class="eval-graph__canvas">
        <svg
          class="eval-graph__svg"
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label="評価グラフ(横軸: 手数、縦軸: 石差、黒優勢が上)"
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={(event) => updateHover(event.currentTarget.getBoundingClientRect(), event.clientX)}
          onPointerDown={(event) => updateHover(event.currentTarget.getBoundingClientRect(), event.clientX)}
          onPointerLeave={() => setHoverPly(null)}
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

          {/* 縦軸の目盛り線+数値ラベル(T063)。0石線は他より強調する。 */}
          {ticks.map((t) => (
            <g key={`tick-${t}`}>
              <line
                class={`eval-graph__grid-line${t === 0 ? ' eval-graph__grid-line--zero' : ''}`}
                x1={PADDING_X}
                y1={yFor(t)}
                x2={PADDING_X + plotWidth}
                y2={yFor(t)}
              />
              <text class="eval-graph__grid-label" x={PADDING_X - 4} y={yFor(t)} dy="0.32em" text-anchor="end">
                {formatDiscDiff(t)}
              </text>
            </g>
          ))}

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
            />
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

          {/* カーソル追従のガイド線+強調点(T063、ツールチップと連動)。 */}
          {hoverPoint && (
            <>
              <line
                class="eval-graph__hover-line"
                x1={xFor(hoverPoint.ply)}
                x2={xFor(hoverPoint.ply)}
                y1={PADDING_Y}
                y2={PADDING_Y + PLOT_HEIGHT}
              />
              <circle
                class="eval-graph__hover-point"
                cx={xFor(hoverPoint.ply)}
                cy={yFor(hoverPoint.value)}
                r={5}
              />
            </>
          )}
        </svg>

        {/* カーソル追従ツールチップ(T063、HTMLオーバーレイ)。 */}
        {hoverPoint && (
          <div
            class={`eval-graph__tooltip eval-graph__tooltip--${tooltipAlign}`}
            style={{ left: `${(xFor(hoverPoint.ply) / width) * 100}%` }}
          >
            <p class="eval-graph__tooltip-title">
              {hoverPoint.ply === 0 ? '初期局面' : `${hoverPoint.ply}手目`}
            </p>
            {hoverPoint.move && (
              <p>
                {sideLabel(hoverPoint.move.side)}番 {hoverPoint.move.notation}
              </p>
            )}
            <p>評価値: {formatDiscDiff(hoverPoint.value)}石(黒視点)</p>
            {hoverPoint.move && (
              <>
                <p>ロス: {hoverPoint.move.lossDiscs > 0 ? `${formatDiscDiff(-hoverPoint.move.lossDiscs)}石` : '±0石'}</p>
                <p>
                  分類: {CLASSIFICATION_LABEL[hoverPoint.move.classification]}
                  {hoverPoint.move.classification !== 'best' && ` ${CLASSIFICATION_TEXT[hoverPoint.move.classification]}`}
                  {hoverPoint.move.reversal && '(逆転)'}
                </p>
              </>
            )}
          </div>
        )}
      </div>
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

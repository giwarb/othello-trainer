import { useEffect, useRef } from 'preact/hooks'
import type { Board as BoardState, Side } from '../game/othello.ts'
import { cellAt, legalMoves } from '../game/othello.ts'
import './Board.css'

const GRID = 8

export interface BoardProps {
  /** 現在の盤面状態。 */
  board: BoardState
  /** 現在の手番(合法手ハイライトの対象)。 */
  sideToMove: Side
  /** 直前の着手マス(印を付ける対象)。無ければ `null`/未指定。 */
  lastMove?: number | null
  /** マスがクリックされ、かつそのマスが `sideToMove` にとって合法手のときに呼ばれる。 */
  onMove?: (square: number) => void
}

/**
 * オセロ盤をCanvasで描画するコンポーネント。
 *
 * - 8x8のマス目を緑背景・グリッド線で描画する
 * - 黒/白の石を円で描画する
 * - `sideToMove` の合法手を薄い点でハイライトする
 * - `lastMove` のマスに印を付ける
 * - マスクリック時、そのマスが合法手であれば `onMove(square)` を呼ぶ(非合法手のクリックは無視する)
 * - Canvasのサイズは親要素(コンテナ)の幅に追従する
 */
export function Board({ board, sideToMove, lastMove = null, onMove }: BoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const size = canvas.width / dpr
      const cell = size / GRID

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)

      // 盤面の緑背景。
      ctx.fillStyle = '#0a6e31'
      ctx.fillRect(0, 0, size, size)

      // グリッド線。
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
      ctx.lineWidth = Math.max(size / 512, 1)
      for (let i = 0; i <= GRID; i++) {
        ctx.beginPath()
        ctx.moveTo(i * cell, 0)
        ctx.lineTo(i * cell, size)
        ctx.stroke()

        ctx.beginPath()
        ctx.moveTo(0, i * cell)
        ctx.lineTo(size, i * cell)
        ctx.stroke()
      }

      const legal = new Set(legalMoves(board, sideToMove))

      for (let square = 0; square < 64; square++) {
        const file = square % 8
        const rank0 = Math.floor(square / 8)
        const cx = file * cell + cell / 2
        const cy = rank0 * cell + cell / 2

        const occupant = cellAt(board, square)
        if (occupant === 'black') {
          drawDisc(ctx, cx, cy, cell, '#111111')
        } else if (occupant === 'white') {
          drawDisc(ctx, cx, cy, cell, '#f5f5f5')
        } else if (legal.has(square)) {
          drawLegalHint(ctx, cx, cy, cell)
        }

        if (square === lastMove) {
          drawLastMoveMark(ctx, cx, cy, cell)
        }
      }
    }

    const resize = () => {
      const size = Math.max(Math.floor(container.clientWidth), 1)
      const dpr = window.devicePixelRatio || 1
      canvas.width = size * dpr
      canvas.height = size * dpr
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      draw()
    }

    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [board, sideToMove, lastMove])

  const handleClick = (event: MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas || !onMove) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const file = Math.floor(((event.clientX - rect.left) / rect.width) * GRID)
    const rank0 = Math.floor(((event.clientY - rect.top) / rect.height) * GRID)
    if (file < 0 || file > 7 || rank0 < 0 || rank0 > 7) return

    const square = rank0 * 8 + file
    if (!legalMoves(board, sideToMove).includes(square)) return
    onMove(square)
  }

  return (
    <div ref={containerRef} class="othello-board">
      <canvas ref={canvasRef} class="othello-board__canvas" onClick={handleClick} />
    </div>
  )
}

function drawDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, cell: number, color: string) {
  ctx.beginPath()
  ctx.fillStyle = color
  ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2)
  ctx.fill()
}

function drawLegalHint(ctx: CanvasRenderingContext2D, cx: number, cy: number, cell: number) {
  ctx.beginPath()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.arc(cx, cy, cell * 0.12, 0, Math.PI * 2)
  ctx.fill()
}

function drawLastMoveMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, cell: number) {
  ctx.beginPath()
  ctx.strokeStyle = 'rgba(220, 40, 40, 0.9)'
  ctx.lineWidth = Math.max(cell / 24, 1)
  ctx.arc(cx, cy, cell * 0.08, 0, Math.PI * 2)
  ctx.stroke()
}

import { useEffect, useRef } from 'preact/hooks'
import type { Board as BoardState, Side } from '../game/othello.ts'
import { cellAt, legalMoves } from '../game/othello.ts'
import { diffBoards, type BoardDiff } from './boardDiff.ts'
import './Board.css'

const GRID = 8

const BLACK_COLOR = '#111111'
const WHITE_COLOR = '#f5f5f5'

/**
 * 石の反転/出現アニメーションの総所要時間(ms)。既存の自動進行の遅延(300ms程度)を超えない範囲に収める。
 * `export`しているのは、T067で終局時の勝敗演出をこのアニメーション完了後に
 * 表示するため(`app.tsx`の`PlayMode`参照)。演出のタイミングを同じ定数で
 * 揃えることで、値がずれた場合に一方だけ変更し忘れる事故を防ぐ。
 */
export const FLIP_ANIMATION_MS = 220

const NO_DIFF: BoardDiff = { isSingleMove: false, placed: [], flipped: [] }

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

function discColor(side: Side): string {
  return side === 'black' ? BLACK_COLOR : WHITE_COLOR
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
 * - `board` が「1手適用による通常の遷移」(`boardDiff.ts`の`diffBoards`で判定)で
 *   変化した場合、反転したマスは横に潰れて反対の色で戻る演出、新規配置マスは
 *   小さい状態から拡大する出現演出を`requestAnimationFrame`で描画する
 *   (T066)。新規対局開始・棋譜解析での局面ジャンプ等、それ以外の盤面変化では
 *   演出せず即座に最終状態を描く。`prefers-reduced-motion: reduce`環境でも
 *   演出せず即座に最終状態を描く。
 */
export function Board({ board, sideToMove, lastMove = null, onMove }: BoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 直前にコミットした(=このコンポーネントが最後に描画対象とした)盤面。
  // 初回マウント時は比較対象が無いのでnull(アニメーション無しで初期状態を描く)。
  const prevBoardRef = useRef<BoardState | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  // コンテナの実サイズ変更(ResizeObserver)が起きたとき、進行中のアニメーションを
  // 打ち切らずに「今表示すべきフレーム」を新しいキャンバスサイズで再描画できる
  // よう、最新の描画関数と進行度を保持しておく(下のリサイズ用useEffectから参照)。
  const drawFrameRef = useRef<((progress: number) => void) | null>(null)
  const progressRef = useRef(1)

  // キャンバスサイズをコンテナの実サイズに追従させる。
  //
  // ResizeObserverは`board`/`sideToMove`/`lastMove`が変わっても再生成せず、
  // マウント時に一度だけ生成する。理由: ResizeObserverは仕様上、`observe()`を
  // 呼ぶと実際のサイズ変化の有無に関わらず初回通知が非同期に必ず1回発火する。
  // 以前はこの副作用でboard更新のたびに生成し直したObserverの「保証された
  // 初回通知」を実際のコンテナサイズ変更と誤認し、進行中の反転/出現
  // アニメーションを毎回即座に打ち切ってしまうバグがあった(T066フィードバック
  // 参照)。加えて、`canvas.width`/`canvas.height`が実際に変化していない
  // 場合は何もしない(サイズ比較によるガード)ことで、万一Observerが余分な
  // 通知を発火しても安全にしている。
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const applySize = () => {
      const size = Math.max(Math.floor(container.clientWidth), 1)
      const dpr = window.devicePixelRatio || 1
      const nextWidth = size * dpr
      const nextHeight = size * dpr
      if (canvas.width === nextWidth && canvas.height === nextHeight) {
        // 実際のサイズ変化が無い通知(ResizeObserverの保証された初回通知等)。
        // 進行中のアニメーションに一切触れず、何もしない。
        return
      }
      canvas.width = nextWidth
      canvas.height = nextHeight
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      // 実際にサイズが変わった場合のみ、現在表示すべきフレームを新サイズで
      // 再描画する(アニメーションを最初からやり直したり打ち切ったりはしない)。
      drawFrameRef.current?.(progressRef.current)
    }

    applySize()
    const observer = new ResizeObserver(applySize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const prevBoard = prevBoardRef.current
    const diff = prevBoard ? diffBoards(prevBoard, board) : NO_DIFF
    prevBoardRef.current = board

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const placedSet = new Set(diff.placed)
    const flippedSet = new Set(diff.flipped)
    const shouldAnimate =
      diff.isSingleMove && !reduceMotion && (placedSet.size > 0 || flippedSet.size > 0)

    const drawFrame = (progress: number) => {
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

        if (occupant && flippedSet.has(square) && prevBoard) {
          const fromSide = cellAt(prevBoard, square) ?? occupant
          drawFlippingDisc(ctx, cx, cy, cell, fromSide, occupant, progress)
        } else if (occupant && placedSet.has(square)) {
          drawAppearingDisc(ctx, cx, cy, cell, occupant, progress)
        } else if (occupant === 'black') {
          drawDisc(ctx, cx, cy, cell, BLACK_COLOR)
        } else if (occupant === 'white') {
          drawDisc(ctx, cx, cy, cell, WHITE_COLOR)
        } else if (legal.has(square)) {
          drawLegalHint(ctx, cx, cy, cell)
        }

        if (square === lastMove) {
          drawLastMoveMark(ctx, cx, cy, cell)
        }
      }
    }

    drawFrameRef.current = drawFrame

    const cancelAnimation = () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
    cancelAnimation()

    if (!shouldAnimate) {
      progressRef.current = 1
      drawFrame(1)
      return cancelAnimation
    }

    progressRef.current = 0
    let start: number | null = null
    const step = (timestamp: number) => {
      if (start === null) start = timestamp
      const progress = Math.min((timestamp - start) / FLIP_ANIMATION_MS, 1)
      progressRef.current = progress
      drawFrame(progress)
      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(step)
      } else {
        animationFrameRef.current = null
      }
    }
    animationFrameRef.current = requestAnimationFrame(step)

    return cancelAnimation
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

/**
 * 反転アニメーション中の1マスを描画する。
 *
 * `progress`(0〜1)に対して`cos(progress * PI)`は 1 → 0 → -1 と変化する。
 * その絶対値をX方向の潰れ具合(石を横から見た状態)として使い、
 * 符号が反転するタイミング(横に潰れきった瞬間、progress=0.5)で
 * 色を旧色(`fromSide`)から新色(`toSide`)へ切り替えることで、
 * 実際のオセロの石が横に倒れて反対の色でひっくり返る見た目を再現する。
 */
function drawFlippingDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  fromSide: Side,
  toSide: Side,
  progress: number,
) {
  const raw = Math.cos(progress * Math.PI)
  // 潰れきった瞬間も石の縁がわずかに見えるよう、完全な0にはしない。
  const scaleX = Math.max(Math.abs(raw), 0.04)
  const color = raw >= 0 ? discColor(fromSide) : discColor(toSide)

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scaleX, 1)
  ctx.beginPath()
  ctx.fillStyle = color
  ctx.arc(0, 0, cell * 0.42, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 新規配置された石を、小さい状態から本来の大きさへ拡大しながら描画する(easeOutCubic)。 */
function drawAppearingDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  side: Side,
  progress: number,
) {
  const eased = 1 - Math.pow(1 - progress, 3)
  const scale = Math.max(eased, 0.001)

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  ctx.beginPath()
  ctx.fillStyle = discColor(side)
  ctx.arc(0, 0, cell * 0.42, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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

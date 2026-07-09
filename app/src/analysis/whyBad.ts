/**
 * 悪手分析パネル(T030、要件3・設計書§6.4)の「なぜ悪いか」ヒューリスティック表示。
 *
 * タスク仕様「本タスクでのスコープ縮小」に従い、機械的に判定しやすい3種類のみを
 * 実装する: 着手可能数差の推移・確定石数の変化(簡易判定)・X打ち/C打ちの検出。
 * 「偶数理論違反」は判定ロジックが複雑なため実装しない(スコープ外)。
 *
 * 純粋関数のみで構成する(盤面2つと着手だけから計算でき、エンジン呼び出しは
 * 不要。副作用なし)。
 */

import { applyMove, cellAt, legalMoves, opposite, squareToNotation, type Board, type Side } from '../game/othello.ts'

// --- 着手可能数 ---------------------------------------------------------

export interface WhyBadMobility {
  /** 着手前局面で、手を打つ側が持っていた合法手の数。 */
  readonly moverMobilityBefore: number
  /** 着手前局面で、相手が持っていた合法手の数。 */
  readonly opponentMobilityBefore: number
  /** 着手後局面で、相手が持つことになった合法手の数。 */
  readonly opponentMobilityAfter: number
  /** 着手後局面で、手を打った側が(次に手番が回ってきたときに)持つ合法手の数。 */
  readonly moverMobilityAfter: number
  /** この手によって相手の着手可能数が、手を打つ前の自分の着手可能数を上回ったか(悪化の兆候)。 */
  readonly opponentGainedMobility: boolean
}

function computeMobility(beforeBoard: Board, side: Side, afterBoard: Board): WhyBadMobility {
  const opponent = opposite(side)
  const moverMobilityBefore = legalMoves(beforeBoard, side).length
  const opponentMobilityBefore = legalMoves(beforeBoard, opponent).length
  const opponentMobilityAfter = legalMoves(afterBoard, opponent).length
  const moverMobilityAfter = legalMoves(afterBoard, side).length
  return {
    moverMobilityBefore,
    opponentMobilityBefore,
    opponentMobilityAfter,
    moverMobilityAfter,
    opponentGainedMobility: opponentMobilityAfter > moverMobilityBefore,
  }
}

// --- 確定石数(簡易判定) -------------------------------------------------

const CORNERS: readonly number[] = [0, 7, 56, 63]

/** 軸ごとの正方向ベクトル。負方向は単純にこの逆(`-dFile, -dRank`)。 */
const AXES: readonly (readonly [number, number])[] = [
  [1, 0], // 水平(行)
  [0, 1], // 垂直(列)
  [1, 1], // 斜め(\)
  [1, -1], // 斜め(/)
]

function fileRankOf(square: number): readonly [number, number] {
  return [square % 8, Math.floor(square / 8)]
}

function squareAtFileRank(file: number, rank: number): number | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null
  return rank * 8 + file
}

function neighborInDirection(square: number, dFile: number, dRank: number): number | null {
  const [file, rank] = fileRankOf(square)
  return squareAtFileRank(file + dFile, rank + dRank)
}

/** `square`を含む、盤の端から端までの1軸ぶんの全マス(自分自身を含む)。 */
function fullLineThrough(square: number, dFile: number, dRank: number): number[] {
  const line: number[] = [square]
  let cur = square
  while (true) {
    const next = neighborInDirection(cur, -dFile, -dRank)
    if (next === null) break
    line.unshift(next)
    cur = next
  }
  cur = square
  while (true) {
    const next = neighborInDirection(cur, dFile, dRank)
    if (next === null) break
    line.push(next)
    cur = next
  }
  return line
}

function isLineFull(board: Board, line: readonly number[]): boolean {
  return line.every((sq) => cellAt(board, sq) !== null)
}

/**
 * `side`の確定石(絶対にひっくり返らない石)の数を簡易判定で数える。
 *
 * アルゴリズム: 隅から固定点反復で安定集合を広げる方式(オセロプログラミングで
 * 一般的な近似手法)。ある石が1つの軸(水平・垂直・斜め2方向)について
 * 「安定」とみなされるのは、(a) その軸のライン上に空きマスが1つも無い(将来
 * 挟まれようがない)、または (b) その軸の両方向それぞれについて、盤端に
 * 到達するか、既に安定と確定した同色の石に隣接している場合。4軸すべてで
 * 安定と判定された石だけを確定石とする。
 *
 * この判定は「確実に安定である」ことの十分条件を反復的に広げていくだけなので
 * 確定石を見逃すことはあっても(過小評価)、安定でない石を確定石と誤判定する
 * ことはない(過大評価はしない)。「簡易判定」として位置づける理由。
 */
export function countStableDiscs(board: Board, side: Side): number {
  const ownSquares: number[] = []
  for (let sq = 0; sq < 64; sq++) {
    if (cellAt(board, sq) === side) ownSquares.push(sq)
  }

  const stable = new Set<number>()
  for (const c of CORNERS) {
    if (cellAt(board, c) === side) stable.add(c)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const sq of ownSquares) {
      if (stable.has(sq)) continue

      const stableOnAllAxes = AXES.every(([dFile, dRank]) => {
        const line = fullLineThrough(sq, dFile, dRank)
        if (isLineFull(board, line)) return true

        const posNeighbor = neighborInDirection(sq, dFile, dRank)
        const negNeighbor = neighborInDirection(sq, -dFile, -dRank)
        const posOk = posNeighbor === null || stable.has(posNeighbor)
        const negOk = negNeighbor === null || stable.has(negNeighbor)
        return posOk && negOk
      })

      if (stableOnAllAxes) {
        stable.add(sq)
        changed = true
      }
    }
  }

  return stable.size
}

export interface WhyBadStability {
  readonly moverStableBefore: number
  readonly moverStableAfter: number
  /** `moverStableAfter - moverStableBefore`。 */
  readonly delta: number
}

function computeStability(beforeBoard: Board, side: Side, afterBoard: Board): WhyBadStability {
  const moverStableBefore = countStableDiscs(beforeBoard, side)
  const moverStableAfter = countStableDiscs(afterBoard, side)
  return { moverStableBefore, moverStableAfter, delta: moverStableAfter - moverStableBefore }
}

// --- X打ち/C打ち検出 -----------------------------------------------------

/** X打ちマス(隅の斜め隣)-> 対応する隅マス番号。 */
const X_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [9, 0], // b2 -> a1
  [14, 7], // g2 -> h1
  [49, 56], // b7 -> a8
  [54, 63], // g7 -> h8
])

/** C打ちマス(隅の直交隣、辺上)-> 対応する隅マス番号。 */
const C_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [1, 0], // b1 -> a1
  [8, 0], // a2 -> a1
  [6, 7], // g1 -> h1
  [15, 7], // h2 -> h1
  [57, 56], // b8 -> a8
  [48, 56], // a7 -> a8
  [62, 63], // g8 -> h8
  [55, 63], // h7 -> h8
])

export interface WhyBadCornerRisk {
  readonly kind: 'x' | 'c'
  /** 対応する隅マスの記法("a1"等)。まだ空いていることが検出の条件。 */
  readonly corner: string
}

/**
 * `square`(着手前局面での着手先)がX打ち/C打ちに該当し、かつ対応する隅が
 * まだ空いているかを判定する。該当しなければ`null`。
 */
function detectCornerRisk(beforeBoard: Board, square: number): WhyBadCornerRisk | null {
  const xCorner = X_SQUARE_TO_CORNER.get(square)
  if (xCorner !== undefined && cellAt(beforeBoard, xCorner) === null) {
    return { kind: 'x', corner: squareToNotation(xCorner) }
  }
  const cCorner = C_SQUARE_TO_CORNER.get(square)
  if (cCorner !== undefined && cellAt(beforeBoard, cCorner) === null) {
    return { kind: 'c', corner: squareToNotation(cCorner) }
  }
  return null
}

// --- まとめ ---------------------------------------------------------------

export interface WhyBadResult {
  readonly mobility: WhyBadMobility
  readonly stability: WhyBadStability
  readonly cornerRisk: WhyBadCornerRisk | null
  /** 表示用に整形済みの理由テキスト(1行1項目)。 */
  readonly reasons: readonly string[]
}

/**
 * 悪手局面(`beforeBoard`、`side`が手番)で`square`に着手した理由を分析する。
 * `square`は`legalMoves(beforeBoard, side)`に含まれる合法手であることを前提とする。
 */
export function analyzeWhyBad(beforeBoard: Board, side: Side, square: number): WhyBadResult {
  const afterBoard = applyMove(beforeBoard, side, square)
  const mobility = computeMobility(beforeBoard, side, afterBoard)
  const stability = computeStability(beforeBoard, side, afterBoard)
  const cornerRisk = detectCornerRisk(beforeBoard, square)

  const reasons: string[] = []
  reasons.push(
    `着手可能数: この手の前はあなたが${mobility.moverMobilityBefore}箇所に打てましたが、` +
      `この手の後は相手が${mobility.opponentMobilityAfter}箇所に打てるようになりました。`,
  )
  if (mobility.opponentGainedMobility) {
    reasons.push('この手により相手の選択肢が広がりました(着手可能数の悪化)。')
  }
  reasons.push(
    `確定石数(簡易判定): ${stability.moverStableBefore}個 → ${stability.moverStableAfter}個` +
      `(${stability.delta >= 0 ? '+' : ''}${stability.delta})`,
  )
  if (cornerRisk) {
    reasons.push(
      `${cornerRisk.kind === 'x' ? 'X打ち' : 'C打ち'}: 隅${cornerRisk.corner}がまだ空いている状態で、` +
        `その隅に隣接するマスへ着手しています。`,
    )
  }

  return { mobility, stability, cornerRisk, reasons }
}

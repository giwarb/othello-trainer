/**
 * オセロ盤(8x8)の8対称変換(二面体群 D4)。
 *
 * マス番号の規約は `app/src/game/othello.ts` と同一:
 * `square = rank0 * 8 + file` (file: a=0..h=7, rank0: 1行目=0..8行目=7)。
 *
 * 各変換は `(file, rank0) -> (file', rank0')` の座標変換として定義し、
 * 8つの変換全てを実装する(恒等・90°/180°/270°回転・水平反転・垂直反転・
 * 主対角線反転・反対角線反転)。`normalize.ts` はこのうち4つ
 * (恒等・180°回転・主対角線反転・反対角線反転)だけを「初手をf5に正規化する
 * 変換」として使う(色を入れ替えずに済む変換だけがそれに該当するため。
 * 詳細は `normalize.ts` のコメント参照)が、本モジュール自体は8つ全てを
 * 提供する。
 */

import type { Board } from '../game/othello.ts'

export type SymmetryOp =
  | 'identity'
  | 'rot90'
  | 'rot180'
  | 'rot270'
  | 'flipH'
  | 'flipV'
  | 'flipDiag'
  | 'flipAntiDiag'

export const ALL_SYMMETRY_OPS: readonly SymmetryOp[] = [
  'identity',
  'rot90',
  'rot180',
  'rot270',
  'flipH',
  'flipV',
  'flipDiag',
  'flipAntiDiag',
]

type CoordMap = (file: number, rank0: number) => readonly [number, number]

// 各変換を (file, rank0) -> (file', rank0') の座標変換として定義する。
// 導出方法・手計算による検証は tasks/T017-joseki-dag.md の作業ログ、および
// symmetry.test.ts のコーナーマス(a1/h1/a8/h8)を使った回帰テストを参照。
//
// - identity:      恒等変換
// - rot90:         時計回り90°回転 ( a1 -> h1 -> h8 -> a8 -> a1 と巡回)
// - rot180:        180°回転 (中心対称)
// - rot270:        反時計回り90°回転 (rot90の逆変換)
// - flipH:         垂直中心線を軸にした水平反転 (列を反転。a<->h)
// - flipV:         水平中心線を軸にした垂直反転 (行を反転。1<->8)
// - flipDiag:      主対角線(a1-h8)を軸にした反転 (転置。a1,h8は不動)
// - flipAntiDiag:  反対角線(a8-h1)を軸にした反転 (h1,a8は不動)
const COORD_MAPS: Record<SymmetryOp, CoordMap> = {
  identity: (f, r) => [f, r],
  rot90: (f, r) => [7 - r, f],
  rot180: (f, r) => [7 - f, 7 - r],
  rot270: (f, r) => [r, 7 - f],
  flipH: (f, r) => [7 - f, r],
  flipV: (f, r) => [f, 7 - r],
  flipDiag: (f, r) => [r, f],
  flipAntiDiag: (f, r) => [7 - r, 7 - f],
}

const INVERSE_OP: Record<SymmetryOp, SymmetryOp> = {
  identity: 'identity',
  rot90: 'rot270',
  rot180: 'rot180',
  rot270: 'rot90',
  flipH: 'flipH',
  flipV: 'flipV',
  flipDiag: 'flipDiag',
  flipAntiDiag: 'flipAntiDiag',
}

/** 指定した変換の逆変換を返す(回転90°/270°は互いに逆。他は全て自己逆変換)。 */
export function inverseOp(op: SymmetryOp): SymmetryOp {
  return INVERSE_OP[op]
}

/** マス番号(0〜63)に変換 `op` を適用し、変換後のマス番号を返す。 */
export function transformSquare(op: SymmetryOp, square: number): number {
  const file = square % 8
  const rank0 = Math.floor(square / 8)
  const [nf, nr] = COORD_MAPS[op](file, rank0)
  return nr * 8 + nf
}

// マス番号 0..63 -> 変換後マス番号 の置換テーブルを遅延生成してキャッシュする。
const permutationCache = new Map<SymmetryOp, readonly number[]>()

function permutationTable(op: SymmetryOp): readonly number[] {
  const cached = permutationCache.get(op)
  if (cached) return cached
  const table: number[] = new Array(64)
  for (let square = 0; square < 64; square++) {
    table[square] = transformSquare(op, square)
  }
  permutationCache.set(op, table)
  return table
}

/**
 * 盤面(`black`/`white` ビットボード)全体に変換 `op` を適用し、
 * 変換後の新しい `Board` を返す(色の入れ替えは行わない。マスの並べ替えのみ)。
 */
export function transformBoard(board: Board, op: SymmetryOp): Board {
  if (op === 'identity') return board

  const table = permutationTable(op)
  let black = 0n
  let white = 0n

  for (let square = 0; square < 64; square++) {
    const bit = 1n << BigInt(square)
    if ((board.black & bit) === 0n && (board.white & bit) === 0n) continue
    const destBit = 1n << BigInt(table[square])
    if ((board.black & bit) !== 0n) black |= destBit
    if ((board.white & bit) !== 0n) white |= destBit
  }

  return { black, white }
}

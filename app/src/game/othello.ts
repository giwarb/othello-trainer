/**
 * オセロの盤面表現・合法手判定・着手適用ロジック(TypeScript独立実装)。
 *
 * # マス番号(square)の対応
 *
 * マス `<列><行>` (列は `a`〜`h`, 行は `1`〜`8`) に対して、
 * 列インデックス `file = 列文字 - 'a'` (a=0, ..., h=7)、
 * 行インデックス `rank0 = 行 - 1` (0..7) とすると、
 * マス番号 `square = rank0 * 8 + file` (0..63) にそのマスを対応させる。
 * つまり `a1` = 0、`h1` = 7、`a2` = 8、`h8` = 63。
 *
 * これは `engine/src/bitboard.rs` のビットインデックス規約と同一であり、
 * 将来Worker/WASMエンジンと連携する際に変換ロジックを共通化しやすくするため
 * 意図的に合わせてある。
 *
 * 盤面は `black` / `white` の2枚の64bit相当のビットボード(bigint)で表現する。
 * JavaScriptの64bit演算にはbigintを用いる(numberは53bitまでしか正確に表現できないため)。
 */

export type Side = 'black' | 'white'

export interface Board {
  readonly black: bigint
  readonly white: bigint
}

const MASK64 = (1n << 64n) - 1n

const FILE_A = 0x0101010101010101n
const FILE_H = 0x8080808080808080n
const NOT_FILE_A = ~FILE_A & MASK64
const NOT_FILE_H = ~FILE_H & MASK64

// 8方向それぞれの「1マス移動」をビット演算のシフトとして実装する。
// square+8 = 1行下 (南)、square-8 = 1行上 (北)、square+1 = 1列右 (東)、square-1 = 1列左 (西)。
// 東西方向を含むシフトは列の端をまたぐ「回り込み」が発生しうるため、
// シフト後に境界マスクを掛けて回り込みビットを除去する。

type ShiftFn = (x: bigint) => bigint

const shiftN: ShiftFn = (x) => x >> 8n
const shiftS: ShiftFn = (x) => (x << 8n) & MASK64
const shiftE: ShiftFn = (x) => (x << 1n) & NOT_FILE_A
const shiftW: ShiftFn = (x) => (x >> 1n) & NOT_FILE_H
const shiftNE: ShiftFn = (x) => (x >> 7n) & NOT_FILE_A
const shiftNW: ShiftFn = (x) => (x >> 9n) & NOT_FILE_H
const shiftSE: ShiftFn = (x) => (x << 9n) & NOT_FILE_A
const shiftSW: ShiftFn = (x) => (x << 7n) & NOT_FILE_H

const DIRECTIONS: readonly ShiftFn[] = [
  shiftN,
  shiftS,
  shiftE,
  shiftW,
  shiftNE,
  shiftNW,
  shiftSE,
  shiftSW,
]

/** 相手側の手番を返す。 */
export function opposite(side: Side): Side {
  return side === 'black' ? 'white' : 'black'
}

/** 標準オセロの開始局面を返す(中央4マスに黒白2つずつ)。 */
export function initialBoard(): Board {
  // d4 = square 27, e4 = square 28, d5 = square 35, e5 = square 36
  const white = (1n << 27n) | (1n << 36n)
  const black = (1n << 28n) | (1n << 35n)
  return { black, white }
}

/** 指定した手番の (自分の石, 相手の石) のビットボードを返す。 */
function sidesOf(board: Board, side: Side): [bigint, bigint] {
  return side === 'black' ? [board.black, board.white] : [board.white, board.black]
}

/** ビットマスクから、立っているビットに対応するマス番号の配列(昇順)を返す。 */
function squaresFromMask(mask: bigint): number[] {
  const result: number[] = []
  let m = mask
  while (m !== 0n) {
    const lowest = m & -m
    const square = lowest.toString(2).length - 1
    result.push(square)
    m &= m - 1n
  }
  return result
}

/** ビットボード内の立っているビット数(popcount)を返す。 */
function popcount(x: bigint): number {
  let count = 0
  let v = x
  while (v !== 0n) {
    v &= v - 1n
    count++
  }
  return count
}

/** 指定した手番の合法手を全て求め、着手可能なマスを立てたビットマスクとして返す。 */
function legalMovesMask(board: Board, side: Side): bigint {
  const [own, opp] = sidesOf(board, side)
  const empty = MASK64 & ~(board.black | board.white)
  let moves = 0n

  for (const dir of DIRECTIONS) {
    // 自分の石から見て、その方向に連続する相手の石の集合を広げていく。
    let t = dir(own) & opp
    // 8x8の盤で挟まれうる相手の石の連続は最大6個なので、5回追加シフトすれば十分。
    for (let i = 0; i < 5; i++) {
      t |= dir(t) & opp
    }
    moves |= dir(t) & empty
  }

  return moves
}

/** 指定した手番の合法手のマス番号配列(昇順)を返す。 */
export function legalMoves(board: Board, side: Side): number[] {
  return squaresFromMask(legalMovesMask(board, side))
}

/** 指定した手番に合法手が存在するかどうかを返す。 */
export function hasLegalMove(board: Board, side: Side): boolean {
  return legalMovesMask(board, side) !== 0n
}

/** 両者ともパス(合法手なし)であれば終局とみなす。 */
export function isTerminal(board: Board): boolean {
  return !hasLegalMove(board, 'black') && !hasLegalMove(board, 'white')
}

/** 指定した色の石数を返す。 */
export function countDiscs(board: Board, side: Side): number {
  return popcount(side === 'black' ? board.black : board.white)
}

/** 空きマスの数を返す。 */
export function countEmpty(board: Board): number {
  return 64 - popcount(board.black | board.white)
}

/**
 * 指定したマス(`square`)に着手した後の新しい `Board` を返す。
 *
 * `square` は `legalMoves(board, side)` に含まれる合法手であることを前提とする
 * (非合法手が渡された場合は何もひっくり返らない盤面が返る)。
 */
export function applyMove(board: Board, side: Side, square: number): Board {
  const mvBit = 1n << BigInt(square)
  const [own, opp] = sidesOf(board, side)
  let flips = 0n

  for (const dir of DIRECTIONS) {
    let captured = 0n
    let x = dir(mvBit)
    while ((x & opp) !== 0n) {
      captured |= x
      x = dir(x)
    }
    // その方向の連続が自分の石で終端していれば、挟んだ相手の石は全てひっくり返る。
    if ((x & own) !== 0n) {
      flips |= captured
    }
  }

  const newOwn = own | mvBit | flips
  const newOpp = opp & ~flips

  return side === 'black'
    ? { black: newOwn, white: newOpp }
    : { black: newOpp, white: newOwn }
}

/** 指定したマスに置かれている石の色(なければ `null`)を返す。 */
export function cellAt(board: Board, square: number): Side | null {
  const bit = 1n << BigInt(square)
  if ((board.black & bit) !== 0n) return 'black'
  if ((board.white & bit) !== 0n) return 'white'
  return null
}

/**
 * 黒石・白石のマス番号配列から `Board` を作る(テスト・デバッグ用のヘルパー)。
 * 同じマスが両方に含まれている場合は未定義動作(呼び出し側で避けること)。
 */
export function createBoard(blackSquares: readonly number[], whiteSquares: readonly number[]): Board {
  let black = 0n
  let white = 0n
  for (const sq of blackSquares) {
    black |= 1n << BigInt(sq)
  }
  for (const sq of whiteSquares) {
    white |= 1n << BigInt(sq)
  }
  return { black, white }
}

/** "d3" のような記法を対応するマス番号 (0..63) に変換する。 */
export function notationToSquare(notation: string): number {
  if (notation.length !== 2) {
    throw new RangeError(`notation must be like "d3": ${notation}`)
  }
  const file = notation.charCodeAt(0) - 'a'.charCodeAt(0)
  const rank0 = notation.charCodeAt(1) - '1'.charCodeAt(0)
  if (file < 0 || file > 7 || rank0 < 0 || rank0 > 7) {
    throw new RangeError(`notation out of range: ${notation}`)
  }
  return rank0 * 8 + file
}

/** マス番号 (0..63) を "a1"〜"h8" のような記法に変換する。 */
export function squareToNotation(square: number): string {
  const file = square % 8
  const rank0 = Math.floor(square / 8)
  return `${String.fromCharCode('a'.charCodeAt(0) + file)}${rank0 + 1}`
}

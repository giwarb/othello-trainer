/**
 * 「初手をf5に正規化する」変換の決定・盤面/局面ハッシュへの適用。
 *
 * 背景: 標準オセロの初期局面で黒が打てる手は `d3` / `c4` / `f5` / `e6` の
 * 4通りしかない(初期配置の対称性より)。実際のプレイヤーの対局はこの
 * どれから始まってもよいが、T016で集めた定石データ(`bookgen/joseki-research.json`)
 * は全ラインが `f5` 基準(`firstMoveBasis: "f5"`)で記録されているため、
 * 局面照合のために盤面を「初手がf5であった場合の見え方」に正規化する。
 *
 * ## どの対称変換を使うか
 * `symmetry.ts` は8つの変換(D4群)を提供するが、そのうち実際に使えるのは
 * 「黒石の集合を黒石の集合に、白石の集合を白石の集合に写す」変換だけである
 * (色を入れ替えてしまう変換を使うと、盤面は幾何学的に一致しても石の色が
 * 反転した非合法な局面になってしまう)。
 *
 * 初期局面(`initialBoard()`)は d4/e5 が白、e4/d5 が黒であり、これは
 * 「主対角線(a1-h8)上の2マスが白、反対角線寄りの2マスが黒」という中心対称な
 * 配置になっている。8つの変換のうち `identity` / `rot180` / `flipDiag` /
 * `flipAntiDiag` の4つは、白マスの集合・黒マスの集合をそれぞれ自分自身に
 * 写す(色を保存する)ことが手計算で確認できる。一方 `rot90` / `rot270` /
 * `flipH` / `flipV` は白マスの集合を黒マスの集合に写してしまう(色を保存
 * しない)ため使えない。
 *
 * 色を保存する4つの変換それぞれが初手のマスをどこに写すかを計算すると
 * (`(file, rank0)` 座標で計算。f5=(5,4), d3=(3,2), c4=(2,3), e6=(4,5)):
 *   - identity:     f5 -> f5 (5,4)  … 初手が既にf5ならそのまま
 *   - flipAntiDiag: d3 -> f5 ((3,2) -> (7-2,7-3) = (5,4))
 *   - rot180:       c4 -> f5 ((2,3) -> (7-2,7-3) = (5,4))
 *   - flipDiag:     e6 -> f5 ((4,5) -> (5,4))
 * となり、初手ごとに一意な変換が定まる。この対応関係は
 * `normalize.test.ts` で「初期局面から4通りの初手を打った盤面が、
 * 正規化後すべて一致する」ことを実際に `applyMove` で計算して検証している。
 */

import { transformBoard, transformSquare, inverseOp, type SymmetryOp } from './symmetry.ts'
import { notationToSquare, type Board, type Side } from '../game/othello.ts'

const F5 = notationToSquare('f5')
const D3 = notationToSquare('d3')
const C4 = notationToSquare('c4')
const E6 = notationToSquare('e6')

/** 初手のマス番号 -> それをf5に写す(色を保存する)対称変換。 */
const FIRST_MOVE_TO_OP: ReadonlyMap<number, SymmetryOp> = new Map([
  [F5, 'identity'],
  [D3, 'flipAntiDiag'],
  [C4, 'rot180'],
  [E6, 'flipDiag'],
])

/**
 * 実際に打たれた初手のマスに対応する正規化変換を返す。
 * `square` が `d3`/`c4`/`f5`/`e6` のいずれでもない場合は例外を投げる
 * (初期局面からの黒の合法手はこの4つしかないため)。
 */
export function opForFirstMove(square: number): SymmetryOp {
  const op = FIRST_MOVE_TO_OP.get(square)
  if (op === undefined) {
    throw new RangeError(
      `square ${square} is not a legal opening move (must be one of d3/c4/f5/e6)`,
    )
  }
  return op
}

/** 盤面に正規化変換 `op` を適用する(`symmetry.ts` の薄いラッパー)。 */
export function normalizeBoard(board: Board, op: SymmetryOp): Board {
  return transformBoard(board, op)
}

/** マス番号に正規化変換 `op` を適用する(`symmetry.ts` の薄いラッパー)。 */
export function normalizeSquare(square: number, op: SymmetryOp): number {
  return transformSquare(op, square)
}

/**
 * 正規化されたマス番号を、元のプレイヤー視点のマス番号に逆変換する
 * (定石DBが示す推奨手を実際の盤面向けに表示する際に使う)。
 */
export function denormalizeSquare(square: number, op: SymmetryOp): number {
  return transformSquare(inverseOp(op), square)
}

/**
 * 正規化後の盤面 + 手番から、局面を一意に表す文字列ハッシュを作る。
 * Zobristのような確率的ハッシュではなく、`black`/`white`ビットボードを
 * そのまま16進文字列化して連結するだけの、衝突しない厳密な表現。
 */
export function hashBoard(board: Board, sideToMove: Side): string {
  return `${board.black.toString(16)}_${board.white.toString(16)}_${sideToMove}`
}

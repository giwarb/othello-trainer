/**
 * 盤面自由配置エディタ(`BoardEditor.tsx`、T077)の石配置ロジック(純粋関数)。
 *
 * `PracticeMode.tsx`等の`*Logic.ts`分割と同じ理由でコンポーネント本体から
 * 分離してある: このリポジトリの単体テスト(`vitest.config.ts`)は
 * `src/**\/*.test.ts`(拡張子`.tsx`は対象外)のみを対象にしており、
 * コンポーネント本体を直接テストする仕組みが無いため、Vitestで検証したい
 * ロジックはここに純粋関数として切り出す。
 */

import type { Board, Side } from '../game/othello.ts'

/** マスに置く石の種別。`'empty'` は「消す」(空マスにする)ことを表す。 */
export type Placement = Side | 'empty'

/** 全マスが空の盤面。 */
export const EMPTY_BOARD: Board = { black: 0n, white: 0n }

/**
 * `board` の `square` マスに `placement` を適用した新しい `Board` を返す
 * (`board` 自体は変更しない)。
 *
 * 対象マスに既に何らかの石が置かれている場合は、まず取り除いてから
 * `placement` を置く(黒白両方のビットが同時に立つことはない不変条件を保つ)。
 * `placement === 'empty'` の場合は単にそのマスの石を取り除く。
 */
export function setSquare(board: Board, square: number, placement: Placement): Board {
  const bit = 1n << BigInt(square)
  const black = board.black & ~bit
  const white = board.white & ~bit

  if (placement === 'black') return { black: black | bit, white }
  if (placement === 'white') return { black, white: white | bit }
  return { black, white }
}

/**
 * `engine/src/bin/puzzlegen.rs` が出力する盤面表現(OBF形式、
 * `bench/ffo_positions.json` やEdaxの `.obf` と同じ64文字
 * `X`(黒)/`O`(白)/`-`(空)文字列。`eval_cli.rs` の `board_to_obf` と同一規約)を、
 * アプリ側の `SerializedBoard`(16進文字列、`app/src/engine/hex.ts` 参照)に
 * 変換するための、生成パイプライン専用の小さな変換ヘルパー。
 */

import { bigintToHex } from '../engine/hex.ts'
import type { SerializedBoard } from './types.ts'

/** OBF形式の64文字盤面文字列を `{black, white}` の `bigint` に変換する。 */
export function obfToBigints(obf: string): { black: bigint; white: bigint } {
  if (obf.length !== 64) {
    throw new RangeError(`obfToBigints: expected a 64-character OBF string, got length ${obf.length}`)
  }
  let black = 0n
  let white = 0n
  for (let i = 0; i < 64; i++) {
    const c = obf[i]
    if (c === 'X' || c === 'x' || c === '*') {
      black |= 1n << BigInt(i)
    } else if (c === 'O' || c === 'o') {
      white |= 1n << BigInt(i)
    }
  }
  return { black, white }
}

/** OBF形式の64文字盤面文字列を、アプリ側の16進文字列表現(`SerializedBoard`)に変換する。 */
export function obfToSerializedBoard(obf: string): SerializedBoard {
  const { black, white } = obfToBigints(obf)
  return { black: bigintToHex(black), white: bigintToHex(white) }
}

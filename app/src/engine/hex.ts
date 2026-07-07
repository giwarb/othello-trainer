// bigint <-> `0x`始まり16進文字列(64bit固定長)の相互変換ヘルパー。
// エンジンのJSONプロトコル(`engine/src/protocol.rs`)は `board.black`/`board.white` を
// `"0x"`始まりの16進数文字列として受け取るため、UIスレッド側の `bigint` 表現との
// 橋渡しに使う。

/** 64bit値を16進数で表したときの桁数(先頭ゼロ埋め用)。 */
const HEX_DIGITS = 16;

/**
 * `bigint` を `0x` プレフィックス付き・16桁ゼロ埋めの16進文字列に変換する。
 * 例: `0n` -> `"0x0000000000000000"`
 *
 * @throws {RangeError} 負の値、または64bit(16進16桁)に収まらない値を渡した場合
 */
export function bigintToHex(value: bigint): string {
  if (value < 0n) {
    throw new RangeError(`bigintToHex: negative values are not supported: ${value}`);
  }
  const hex = value.toString(16);
  if (hex.length > HEX_DIGITS) {
    throw new RangeError(`bigintToHex: value does not fit in 64 bits: ${value}`);
  }
  return `0x${hex.padStart(HEX_DIGITS, '0')}`;
}

/**
 * `0x` プレフィックス付き(またはなし)の16進文字列を `bigint` に変換する。
 * 例: `"0x0000000000000000"` -> `0n`
 */
export function hexToBigint(hex: string): bigint {
  const stripped = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (stripped.length === 0) {
    throw new RangeError(`hexToBigint: empty hex string: ${hex}`);
  }
  return BigInt(`0x${stripped}`);
}

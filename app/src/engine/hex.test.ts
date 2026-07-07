import { describe, expect, it } from 'vitest';
import { bigintToHex, hexToBigint } from './hex';

describe('bigintToHex', () => {
  it('converts 0n to a zero-padded 16-digit hex string', () => {
    expect(bigintToHex(0n)).toBe('0x0000000000000000');
  });

  it('converts the initial black bitboard value used by the engine', () => {
    // engine/src/protocol.rs のテストで使われている初期局面の値。
    expect(bigintToHex(0x0000000810000000n)).toBe('0x0000000810000000');
  });

  it('converts the maximum 64bit value without truncation', () => {
    expect(bigintToHex(0xffffffffffffffffn)).toBe('0xffffffffffffffff');
  });

  it('throws for negative values', () => {
    expect(() => bigintToHex(-1n)).toThrow(RangeError);
  });

  it('throws for values that do not fit in 64 bits', () => {
    expect(() => bigintToHex(0x1_0000000000000000n)).toThrow(RangeError);
  });
});

describe('hexToBigint', () => {
  it('converts a zero-padded hex string back to 0n', () => {
    expect(hexToBigint('0x0000000000000000')).toBe(0n);
  });

  it('converts a hex string without 0x prefix', () => {
    expect(hexToBigint('0000000810000000')).toBe(0x0000000810000000n);
  });

  it('round-trips known values through bigintToHex and hexToBigint', () => {
    const values = [0n, 1n, 0x0000000810000000n, 0x0000001008000000n, 0xffffffffffffffffn];
    for (const value of values) {
      expect(hexToBigint(bigintToHex(value))).toBe(value);
    }
  });
});

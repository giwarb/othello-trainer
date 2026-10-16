"""T205: PWV6 パターン重みの「偶奇保存ステージ平滑化」変換ツール。

T203 の調査で、pattern_v6 の 61段(空き数1刻み)独立重みテーブルの段間不連続が
同偶奇深さ間の評価値の揺れ |v(d)-v(d-2)| を Edax 比 1.4〜1.8 倍に増やしていると判明した。
重みには ±3.4石の真の手番パリティ項があるため、隣接段(s±1)ではなく同じ偶奇の段(s±2)
どうしを 1-2-1 カーネルで混ぜる:

    smooth(w)[s] = (w[s-2] + 2 w[s] + w[s+2]) / 4
    w'[s]        = (1 - alpha) w[s] + alpha smooth(w)[s]

- 端の段(s<2, s>=ns-2)は変更しない。
- 3段のいずれかが 0(学習データに一度も現れなかった状態)なら変更しない(未学習の0で薄めない)。
- scalar 特徴も同じ規則で平滑化する(--no-scalars で対象外にできる)。

使い方:
    python bench/edax-compare/t205_smooth_weights.py IN.bin OUT.bin --alpha 1.0
    python bench/edax-compare/t205_smooth_weights.py --self-test
"""

from __future__ import annotations

import argparse
import struct
import sys

import numpy as np

MAGIC = b"PWV6"


def _parse_layout(buf: bytes):
    """PWV6 のテーブル位置を返す: (ns, [(offset, nstates)], [offset_scalar])."""
    if buf[:4] != MAGIC:
        raise ValueError(f"not a PWV6 file (magic={buf[:4]!r})")
    pos = 4
    _ver, _flags, ns, _dv, ni, nc, nsc = struct.unpack_from("<7I", buf, pos)
    pos += 4 * 7 + 32
    for _ in range(ni):
        cc = buf[pos]
        pos += 3 + cc
    tables = []
    for _ in range(nc):
        pos += 1
        (nst,) = struct.unpack_from("<I", buf, pos)
        pos += 4
        tables.append((pos, nst))
        pos += ns * nst * 4
    scalars = []
    for _ in range(nsc):
        pos += 4
        scalars.append(pos)
        pos += ns * 4
    if pos != len(buf):
        raise ValueError(f"trailing bytes: parsed {pos} of {len(buf)}")
    return ns, tables, scalars


def smooth_stage_axis(a: np.ndarray, alpha: float) -> np.ndarray:
    """a: shape (ns, n) float32。段方向に偶奇保存 1-2-1 平滑化して alpha で混合する。"""
    if alpha == 0.0:
        return a.copy()
    a64 = a.astype(np.float64)
    out = a64.copy()
    ns = a.shape[0]
    for s in range(2, ns - 2):
        lo, mid, hi = a64[s - 2], a64[s], a64[s + 2]
        mask = (lo != 0) & (mid != 0) & (hi != 0)
        sm = (lo + 2.0 * mid + hi) / 4.0
        out[s] = np.where(mask, (1.0 - alpha) * mid + alpha * sm, mid)
    return out.astype(np.float32)


def smooth_weights(buf: bytes, alpha: float, scalars: bool = True) -> bytes:
    ns, tables, scalar_offsets = _parse_layout(buf)
    out = bytearray(buf)
    if alpha == 0.0:
        return bytes(out)
    for off, nst in tables:
        a = np.frombuffer(buf, dtype="<f4", count=ns * nst, offset=off).reshape(ns, nst)
        out[off : off + ns * nst * 4] = smooth_stage_axis(a, alpha).astype("<f4").tobytes()
    if scalars:
        for off in scalar_offsets:
            a = np.frombuffer(buf, dtype="<f4", count=ns, offset=off).reshape(ns, 1)
            out[off : off + ns * 4] = smooth_stage_axis(a, alpha).astype("<f4").tobytes()
    return bytes(out)


def _self_test() -> None:
    ns = 9
    # 定数列は不変
    const = np.full((ns, 3), 2.5, dtype=np.float32)
    assert np.array_equal(smooth_stage_axis(const, 1.0), const)
    # 偶奇保存: 偶数段 +1 / 奇数段 -1 の交互列は(端以外)不変
    alt = np.array([[1.0 if s % 2 == 0 else -1.0] for s in range(ns)], dtype=np.float32)
    assert np.array_equal(smooth_stage_axis(alt, 1.0), alt)
    # 期待値: s=4 にインパルス 4 → s=2,6 に 1、s=4 は 2
    imp = np.ones((ns, 1), dtype=np.float32)
    imp[4, 0] = 5.0
    got = smooth_stage_axis(imp, 1.0)[:, 0]
    exp = np.array([1, 1, 2, 1, 3, 1, 2, 1, 1], dtype=np.float32)
    assert np.allclose(got, exp), got
    # alpha=0.5 は中間
    got_half = smooth_stage_axis(imp, 0.5)[:, 0]
    assert np.allclose(got_half, (imp[:, 0] + exp) / 2), got_half
    # 0(未学習)を含む3つ組は変更しない
    z = np.ones((ns, 1), dtype=np.float32) * 3
    z[2, 0] = 0.0
    zr = smooth_stage_axis(z, 1.0)
    assert zr[4, 0] == 3.0 and zr[2, 0] == 0.0 and zr[0, 0] == 3.0
    print("self-test OK")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--alpha", type=float, default=1.0)
    ap.add_argument("--no-scalars", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        _self_test()
        return 0
    if not args.input or not args.output:
        ap.error("input and output are required")
    src = open(args.input, "rb").read()
    dst = smooth_weights(src, args.alpha, scalars=not args.no_scalars)
    if args.alpha == 0.0 and dst != src:
        raise AssertionError("alpha=0 must be bit-identical")
    open(args.output, "wb").write(dst)
    print(f"wrote {args.output} ({len(dst)} bytes, alpha={args.alpha}, scalars={not args.no_scalars})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

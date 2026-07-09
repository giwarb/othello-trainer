import { describe, expect, it } from 'vitest'
import { formatDiscDiff } from './EvalBadge.tsx'

describe('formatDiscDiff', () => {
  it('正の値は"+N"の整数形式(四捨五入)で返す', () => {
    expect(formatDiscDiff(8)).toBe('+8')
    expect(formatDiscDiff(7.6)).toBe('+8')
    expect(formatDiscDiff(7.4)).toBe('+7')
  })

  it('負の値は"-N"の整数形式(四捨五入)で返す', () => {
    expect(formatDiscDiff(-5)).toBe('-5')
    expect(formatDiscDiff(-5.6)).toBe('-6')
    expect(formatDiscDiff(-5.4)).toBe('-5')
  })

  it('0、および四捨五入して0になる微小値は"+0"を返す(-0の符号がJSの仕様で+扱いになるため)', () => {
    expect(formatDiscDiff(0)).toBe('+0')
    expect(formatDiscDiff(0.3)).toBe('+0')
    expect(formatDiscDiff(-0.3)).toBe('+0')
  })
})

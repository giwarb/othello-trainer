import { describe, expect, it } from 'vitest'
import { cpuMoveLimitForLevel, LEVELS } from './app.tsx'

describe('CPU strength presets (T085c)', () => {
  it('applies the calibrated node budget only to strong CPU moves', () => {
    expect(cpuMoveLimitForLevel('weak')).toEqual({ depth: 4, exactFromEmpties: 8 })
    expect(cpuMoveLimitForLevel('normal')).toEqual({ depth: 8, exactFromEmpties: 12 })
    expect(cpuMoveLimitForLevel('strong')).toEqual({
      depth: 12,
      timeMs: 1500,
      maxNodes: 160000,
      exactFromEmpties: 16,
    })
  })

  it('keeps strong all-moves and display analysis on the legacy limit', () => {
    expect(LEVELS.strong.limit).toEqual({ depth: 12, exactFromEmpties: 16 })
  })
})

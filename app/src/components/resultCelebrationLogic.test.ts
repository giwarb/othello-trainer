import { describe, expect, it } from 'vitest'
import { celebrationKindFor } from './resultCelebrationLogic.ts'

describe('celebrationKindFor', () => {
  it('引き分けの場合は人間側の色によらず draw を返す', () => {
    expect(celebrationKindFor('draw', 'black')).toBe('draw')
    expect(celebrationKindFor('draw', 'white')).toBe('draw')
  })

  it('人間側の色が勝った場合は win を返す', () => {
    expect(celebrationKindFor('black', 'black')).toBe('win')
    expect(celebrationKindFor('white', 'white')).toBe('win')
  })

  it('CPU側の色が勝った場合(人間側の色と不一致)は lose を返す', () => {
    expect(celebrationKindFor('white', 'black')).toBe('lose')
    expect(celebrationKindFor('black', 'white')).toBe('lose')
  })
})

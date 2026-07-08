import { describe, expect, it } from 'vitest'
import { deriveTags, deriveTagsFromMultiple } from './tags.ts'

describe('tsume/tags: deriveTags', () => {
  it('該当する事実が無ければ空配列', () => {
    expect(deriveTags({ cornerSacrificeCandidate: false, stableGain: false })).toEqual([])
  })

  it('隅の犠牲の事実があればcorner-sacrificeタグが付く', () => {
    expect(deriveTags({ cornerSacrificeCandidate: true, stableGain: false })).toEqual([
      'corner-sacrifice',
    ])
  })

  it('確定石増加の事実があればstable-gainタグが付く', () => {
    expect(deriveTags({ cornerSacrificeCandidate: false, stableGain: true })).toEqual([
      'stable-gain',
    ])
  })

  it('両方の事実があれば両方のタグが付く', () => {
    expect(deriveTags({ cornerSacrificeCandidate: true, stableGain: true })).toEqual([
      'corner-sacrifice',
      'stable-gain',
    ])
  })
})

describe('tsume/tags: deriveTagsFromMultiple', () => {
  it('複数の正解手のうちいずれか1つでも満たせばタグが付く', () => {
    const tags = deriveTagsFromMultiple([
      { cornerSacrificeCandidate: false, stableGain: false },
      { cornerSacrificeCandidate: true, stableGain: false },
    ])
    expect(tags).toEqual(['corner-sacrifice'])
  })

  it('全ての正解手が事実を満たさなければ空配列', () => {
    const tags = deriveTagsFromMultiple([
      { cornerSacrificeCandidate: false, stableGain: false },
      { cornerSacrificeCandidate: false, stableGain: false },
    ])
    expect(tags).toEqual([])
  })
})

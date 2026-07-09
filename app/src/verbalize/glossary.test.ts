import { describe, expect, it } from 'vitest'
import { MOTIF_CATALOG } from '../analysis/motifs.ts'
import { ATTRIBUTION_TAG_ID } from './reasonTags.ts'
import { findGlossaryEntry, GLOSSARY_ENTRIES } from './glossary.ts'

describe('verbalize/glossary', () => {
  it('モチーフ15種+評価内訳3種の計18項目を持つ(要件1)', () => {
    expect(GLOSSARY_ENTRIES).toHaveLength(MOTIF_CATALOG.length + 3)
    expect(GLOSSARY_ENTRIES).toHaveLength(18)
  })

  it('全項目のkeyが一意である', () => {
    const keys = GLOSSARY_ENTRIES.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('全項目が空でない定義文(2文以上目安の長さ)を持つ', () => {
    for (const entry of GLOSSARY_ENTRIES) {
      expect(entry.definition.length).toBeGreaterThan(10)
    }
  })

  it('MOTIF_CATALOGの全キーが用語集に含まれる', () => {
    for (const motif of MOTIF_CATALOG) {
      const entry = findGlossaryEntry(motif.key)
      expect(entry).toBeDefined()
      expect(entry?.kind).toBe('motif')
      expect(entry?.label).toBe(motif.label)
    }
  })

  it('ATTRIBUTION_TAG_IDの全値が用語集に含まれる', () => {
    for (const tagId of Object.values(ATTRIBUTION_TAG_ID)) {
      const entry = findGlossaryEntry(tagId)
      expect(entry).toBeDefined()
      expect(entry?.kind).toBe('attribution')
    }
  })

  it('未知のキーはundefinedを返す', () => {
    expect(findGlossaryEntry('no-such-tag')).toBeUndefined()
  })
})

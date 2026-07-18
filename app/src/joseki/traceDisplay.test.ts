import { describe, expect, it } from 'vitest'
import { formatJosekiTrace } from './traceDisplay.ts'

describe('formatJosekiTrace', () => {
  it('namesが空なら空文字列を返す', () => {
    expect(formatJosekiTrace([], 3, false)).toBe('')
  })

  it('名前1件・進行中: 「定石: 名前(N手目)」', () => {
    expect(formatJosekiTrace(['兎'], 5, false)).toBe('定石: 兎(5手目)')
  })

  it('名前複数・進行中: 先頭を代表にして「他N」を付す', () => {
    expect(formatJosekiTrace(['虎', '猫', '羊'], 2, false)).toBe('定石: 虎(他2)(2手目)')
  })

  it('離脱後: 末尾に「(離脱)」を付す(名前1件)', () => {
    expect(formatJosekiTrace(['兎'], 5, true)).toBe('定石: 兎(5手目)(離脱)')
  })

  it('離脱後: 末尾に「(離脱)」を付す(名前複数)', () => {
    expect(formatJosekiTrace(['虎', '猫'], 4, true)).toBe('定石: 虎(他1)(4手目)(離脱)')
  })

  it('進行数0でも文言を組み立てる(呼び出し側でply=0を除外する場合でも純関数自体はそのまま動く)', () => {
    expect(formatJosekiTrace(['兎'], 0, false)).toBe('定石: 兎(0手目)')
  })
})

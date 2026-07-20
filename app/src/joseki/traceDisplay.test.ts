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

  // T151: opening-book.jsonの自動命名ライン(WTHOR-####)を生でユーザーに
  // 見せない(オーケストレーター確定の設計判断)。
  describe('自動命名ライン(WTHOR-####)の扱い(T151)', () => {
    it('全て自動命名ラインのみの場合は汎用表現「頻出進行」にフォールバックする', () => {
      expect(formatJosekiTrace(['WTHOR-0001'], 5, false)).toBe('定石: 頻出進行(5手目)')
    })

    it('複数の自動命名ラインが合流していても「頻出進行」1件にまとめる(「他N」は付かない)', () => {
      expect(formatJosekiTrace(['WTHOR-0001', 'WTHOR-0002', 'WTHOR-0003'], 5, false)).toBe(
        '定石: 頻出進行(5手目)',
      )
    })

    it('命名済み定石と自動命名ラインが混在する場合は命名済みを優先し、自動命名は表示に出さない', () => {
      expect(formatJosekiTrace(['虎', 'WTHOR-0001'], 5, false)).toBe('定石: 虎(5手目)')
    })

    it('命名済み定石が複数かつ自動命名も混在する場合、「他N」のNは命名済み定石の数のみで数える', () => {
      expect(formatJosekiTrace(['虎', '猫', 'WTHOR-0001', 'WTHOR-0002'], 5, false)).toBe(
        '定石: 虎(他1)(5手目)',
      )
    })

    it('自動命名ラインのみ・離脱後は「頻出進行(N手目)(離脱)」になる', () => {
      expect(formatJosekiTrace(['WTHOR-0042'], 8, true)).toBe('定石: 頻出進行(8手目)(離脱)')
    })
  })
})

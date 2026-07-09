import { describe, expect, it } from 'vitest'
import { parseTranscript, TranscriptParseError } from './parseTranscript.ts'

describe('analysis/parseTranscript', () => {
  it('区切りなしの連結記法をパースできる', () => {
    expect(parseTranscript('f5d6c3d3c4')).toEqual(['f5', 'd6', 'c3', 'd3', 'c4'])
  })

  it('大文字/小文字混在を許容する(小文字に正規化される)', () => {
    expect(parseTranscript('F5D6C3')).toEqual(['f5', 'd6', 'c3'])
    expect(parseTranscript('f5D6c3')).toEqual(['f5', 'd6', 'c3'])
  })

  it('空白・カンマ・セミコロン・ハイフン混在の区切り文字を許容する', () => {
    expect(parseTranscript('F5 D6, C3; D3-C4')).toEqual(['f5', 'd6', 'c3', 'd3', 'c4'])
  })

  it('連続する区切り文字も許容する', () => {
    expect(parseTranscript('f5   d6,,,c3')).toEqual(['f5', 'd6', 'c3'])
  })

  it('前後の空白を許容する', () => {
    expect(parseTranscript('  f5 d6  ')).toEqual(['f5', 'd6'])
  })

  it('空文字列はTranscriptParseErrorを投げる', () => {
    expect(() => parseTranscript('')).toThrow(TranscriptParseError)
    expect(() => parseTranscript('   ')).toThrow(TranscriptParseError)
  })

  it('文字数が奇数(2文字ずつに区切れない)場合はTranscriptParseErrorを投げる', () => {
    expect(() => parseTranscript('f5d')).toThrow(TranscriptParseError)
  })

  it('列がa〜hの範囲外の場合はTranscriptParseErrorを投げる', () => {
    expect(() => parseTranscript('i5')).toThrow(TranscriptParseError)
    expect(() => parseTranscript('z5')).toThrow(TranscriptParseError)
  })

  it('行が1〜8の範囲外の場合はTranscriptParseErrorを投げる', () => {
    expect(() => parseTranscript('f9')).toThrow(TranscriptParseError)
    expect(() => parseTranscript('f0')).toThrow(TranscriptParseError)
  })

  it('数字が2つ連続するなど無関係な文字を含む場合はTranscriptParseErrorを投げる', () => {
    expect(() => parseTranscript('f5 99')).toThrow(TranscriptParseError)
  })

  it('エラーメッセージに問題箇所の手数を含む', () => {
    try {
      parseTranscript('f5d6z9')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptParseError)
      expect((error as Error).message).toContain('3手目')
    }
  })
})

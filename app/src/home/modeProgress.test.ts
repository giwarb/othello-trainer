/**
 * T137要件4のテスト: ホーム画面のモードカード実績行の文言組み立て(純粋関数)。
 */
import { describe, expect, it } from 'vitest'
import { formatJosekiProgress, formatMidgameProgress, formatTsumeProgress } from './modeProgress.ts'

describe('home/modeProgress', () => {
  describe('formatJosekiProgress', () => {
    it('due件数をそのまま埋め込む', () => {
      expect(formatJosekiProgress(3)).toBe('今日の復習3本')
    })

    it('0件でも表示できる(空状態)', () => {
      expect(formatJosekiProgress(0)).toBe('今日の復習0本')
    })
  })

  describe('formatMidgameProgress', () => {
    it('クリア数/総数の形式で表示する(T137 redo#1: 「クリア」と数値の間にスペースを入れて他画面と統一)', () => {
      expect(formatMidgameProgress(42, 111)).toBe('クリア 42/111')
    })

    it('未クリア(0件)でも表示できる(空状態)', () => {
      expect(formatMidgameProgress(0, 111)).toBe('クリア 0/111')
    })
  })

  describe('formatTsumeProgress', () => {
    it('todayCleared=trueなら「今日の1問済み」を含む', () => {
      expect(formatTsumeProgress(10, 182, true)).toBe('クリア 10/182・今日の1問済み')
    })

    it('todayCleared=falseなら「今日の1問未挑戦」を含む', () => {
      expect(formatTsumeProgress(10, 182, false)).toBe('クリア 10/182・今日の1問未挑戦')
    })

    it('0件でも表示できる(空状態)', () => {
      expect(formatTsumeProgress(0, 182, false)).toBe('クリア 0/182・今日の1問未挑戦')
    })
  })
})

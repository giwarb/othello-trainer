import { describe, expect, it } from 'vitest'
import {
  computeDueLines,
  dueSummaryHeadline,
  previewDueLineNames,
  selectPracticeTargetLine,
} from './dueLines.ts'
import type { JosekiSrsState } from './srs.ts'
import type { JosekiLine } from './types.ts'

function line(id: string): JosekiLine {
  return { id, name: id, aliases: [], moveSeq: [], depth: 1, popularity: undefined }
}

function srsState(lineId: string, dueDate: string): JosekiSrsState {
  return { lineId, ease: 2.5, interval: 1, streak: 1, fails: 0, dueDate, lastReviewedAt: null }
}

describe('computeDueLines', () => {
  it('SRS状態が無いライン(未挑戦)は常にdue扱いになる', () => {
    const lines = [line('虎'), line('バラ')]
    const due = computeDueLines(lines, [], new Date(2026, 6, 18))
    expect(due.map((l) => l.id).sort()).toEqual(['バラ', '虎'])
  })

  it('dueDateが本日以前のラインだけがdueになる', () => {
    const lines = [line('虎'), line('バラ'), line('猫')]
    const states = [
      srsState('虎', '2026-07-17'), // 過去=due
      srsState('バラ', '2026-07-18'), // 本日=due
      srsState('猫', '2026-07-19'), // 未来=due外
    ]
    const due = computeDueLines(lines, states, new Date(2026, 6, 18))
    expect(due.map((l) => l.id).sort()).toEqual(['バラ', '虎'])
  })

  it('全ラインがdue外なら空配列を返す', () => {
    const lines = [line('虎')]
    const states = [srsState('虎', '2099-01-01')]
    const due = computeDueLines(lines, states, new Date(2026, 6, 18))
    expect(due).toEqual([])
  })
})

describe('previewDueLineNames', () => {
  it('件数がlimit以下なら全件shownでremaining=0', () => {
    const lines = [line('虎'), line('バラ')]
    const preview = previewDueLineNames(lines, 10)
    expect(preview.shown).toEqual(['虎', 'バラ'])
    expect(preview.remaining).toBe(0)
  })

  it('件数がlimitを超えたら先頭limit件+残り件数(他n本)になる', () => {
    const lines = Array.from({ length: 13 }, (_, i) => line(`line${i}`))
    const preview = previewDueLineNames(lines, 10)
    expect(preview.shown).toHaveLength(10)
    expect(preview.shown).toEqual(lines.slice(0, 10).map((l) => l.name))
    expect(preview.remaining).toBe(3)
  })

  it('0件なら空配列・remaining=0', () => {
    const preview = previewDueLineNames([], 10)
    expect(preview.shown).toEqual([])
    expect(preview.remaining).toBe(0)
  })
})

describe('selectPracticeTargetLine', () => {
  const allLines = [line('虎'), line('バラ'), line('猫')]

  it('dueOnly=falseかつdueが1件以上: dueラインのみから選び、フォールバックしない', () => {
    const dueLines = [line('虎'), line('バラ')]
    const result = selectPracticeTargetLine(allLines, dueLines, false, () => 1)
    expect(result.target?.id).toBe('バラ')
    expect(result.usedFallback).toBe(false)
  })

  it('dueOnly=falseかつdueが0件: allLines全体から選び、フォールバック扱いにはしない', () => {
    const result = selectPracticeTargetLine(allLines, [], false, () => 2)
    expect(result.target?.id).toBe('猫')
    expect(result.usedFallback).toBe(false)
  })

  it('dueOnly=trueかつdueが1件以上: dueラインのみに限定される(要件3)', () => {
    const dueLines = [line('猫')]
    const result = selectPracticeTargetLine(allLines, dueLines, true, () => 0)
    expect(result.target?.id).toBe('猫')
    expect(result.usedFallback).toBe(false)
  })

  it('dueOnly=trueかつdueが0件: allLines全体にフォールバックし、usedFallback=trueを返す(要件3)', () => {
    const result = selectPracticeTargetLine(allLines, [], true, () => 0)
    expect(result.target?.id).toBe('虎')
    expect(result.usedFallback).toBe(true)
  })

  it('プールが空(allLinesも空)ならtarget=null', () => {
    const result = selectPracticeTargetLine([], [], true, () => 0)
    expect(result.target).toBeNull()
    expect(result.usedFallback).toBe(true)
  })
})

describe('dueSummaryHeadline', () => {
  it('due件数が1件以上なら件数付きの文言を返す', () => {
    expect(dueSummaryHeadline(3, false)).toBe('今日の復習: 3本')
    expect(dueSummaryHeadline(1, true)).toBe('今日の復習: 1本')
  })

  it('due0件・完了直後でなければ「今日の復習はありません」', () => {
    expect(dueSummaryHeadline(0, false)).toBe('今日の復習はありません')
  })

  it('due0件・完了直後なら「今日の復習完了!」(要件4)', () => {
    expect(dueSummaryHeadline(0, true)).toBe('今日の復習完了!')
  })
})

import { describe, expect, it } from 'vitest'
import {
  loadStageProgress,
  MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
  recordStageAttempt,
  saveStageProgress,
  stageStarCount,
  stageStatus,
  stageStatusForMode,
  type StageProgress,
  type StorageLike,
} from './stageProgress.ts'

/** 実際の`localStorage`の代わりに使う、`Map`ベースのフェイク実装(`tsume/stageProgress.test.ts`と同じ手法)。 */
class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

const STAGE = 'stage-key-1'

describe('loadStageProgress / saveStageProgress', () => {
  it('未保存の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('保存した内容を正しく読み戻せる(往復)', () => {
    const storage = new FakeStorage()
    const progress: StageProgress = {
      [STAGE]: {
        strict: {
          firstClearedAt: '2026-07-17T00:00:00.000Z',
          lastClearedAt: '2026-07-17T00:00:00.000Z',
          clearCount: 1,
          failCount: 0,
          lastAttemptAt: '2026-07-17T00:00:00.000Z',
          lastResult: 'clear',
        },
      },
    }
    saveStageProgress(storage, progress)
    expect(loadStageProgress(storage)).toEqual(progress)
  })

  it('壊れたJSONが保存されていた場合は例外を投げず空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, '{ this is not valid json')
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('形が不正な値(配列・エントリの型違反)の場合は空のレコードを返す', () => {
    const storage = new FakeStorage()

    storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadStageProgress(storage)).toEqual({})

    storage.setItem(
      MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
      JSON.stringify({ [STAGE]: { strict: { clearCount: 'not-a-number' } } }),
    )
    expect(loadStageProgress(storage)).toEqual({})

    storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(null))
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('未知の判定モード名がキーに含まれる場合は空のレコードを返す', () => {
    const storage = new FakeStorage()
    storage.setItem(
      MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
      JSON.stringify({
        [STAGE]: {
          'not-a-real-mode': {
            firstClearedAt: null,
            lastClearedAt: null,
            clearCount: 0,
            failCount: 1,
            lastAttemptAt: '2026-07-17T00:00:00.000Z',
            lastResult: 'fail',
          },
        },
      }),
    )
    expect(loadStageProgress(storage)).toEqual({})
  })

  /**
   * T117 redo #1(codex-review指摘b)を最初から反映: 日時は`Date.parse`可否
   * ではなく`Date.toISOString()`形式の厳密な検証にする。
   */
  describe('日時フィールドの厳密なISO 8601形式検証', () => {
    function entryWith(overrides: Record<string, unknown>) {
      return {
        firstClearedAt: '2026-07-17T00:00:00.000Z',
        lastClearedAt: '2026-07-17T00:00:00.000Z',
        clearCount: 1,
        failCount: 0,
        lastAttemptAt: '2026-07-17T00:00:00.000Z',
        lastResult: 'clear',
        ...overrides,
      }
    }

    it('Date.parseなら通ってしまう非ISO形式("2026/07/17")は不正として空のレコードを返す', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({ [STAGE]: { strict: entryWith({ lastAttemptAt: '2026/07/17' }) } }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('タイムゾーンオフセット付き("+09:00")はtoISOString()形式ではないため不正', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({ [STAGE]: { strict: entryWith({ lastAttemptAt: '2026-07-17T09:00:00.000+09:00' }) } }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('ミリ秒が省略された形式("2026-07-17T00:00:00Z")は不正', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({ [STAGE]: { strict: entryWith({ lastAttemptAt: '2026-07-17T00:00:00Z' }) } }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('暦として存在しない日付("2026-02-30T00:00:00.000Z")は往復チェックで弾かれる', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({ [STAGE]: { strict: entryWith({ lastAttemptAt: '2026-02-30T00:00:00.000Z' }) } }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('正しいtoISOString()形式はそのまま有効値として読み戻せる', () => {
      const storage = new FakeStorage()
      const entry = entryWith({})
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify({ [STAGE]: { strict: entry } }))
      expect(loadStageProgress(storage)).toEqual({ [STAGE]: { strict: entry } })
    })
  })

  /** T117 redo #1(codex-review指摘b)を最初から反映: フィールド相関の整合チェック。 */
  describe('フィールド相関の整合チェック', () => {
    function entryWith(overrides: Record<string, unknown>) {
      return {
        firstClearedAt: null,
        lastClearedAt: null,
        clearCount: 0,
        failCount: 1,
        lastAttemptAt: '2026-07-17T00:00:00.000Z',
        lastResult: 'fail',
        ...overrides,
      }
    }

    it('clearCount===0なのにfirstClearedAtが設定されている場合は不正', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({
          [STAGE]: { strict: entryWith({ firstClearedAt: '2026-07-17T00:00:00.000Z' }) },
        }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('clearCount===0なのにlastClearedAtが設定されている場合は不正', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({
          [STAGE]: { strict: entryWith({ lastClearedAt: '2026-07-17T00:00:00.000Z' }) },
        }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('clearCount>0なのにfirstClearedAt/lastClearedAtが両方nullの場合は不正', () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({
          [STAGE]: { strict: entryWith({ clearCount: 1, lastResult: 'clear' }) },
        }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it("lastResult==='clear'なのにclearCount===0の場合は不正", () => {
      const storage = new FakeStorage()
      storage.setItem(
        MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
        JSON.stringify({
          [STAGE]: { strict: entryWith({ lastResult: 'clear' }) },
        }),
      )
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('整合性の取れた正常なクリア済みエントリは有効値として読み戻せる', () => {
      const storage = new FakeStorage()
      const entry = entryWith({
        firstClearedAt: '2026-07-17T00:00:00.000Z',
        lastClearedAt: '2026-07-17T00:00:00.000Z',
        clearCount: 1,
        lastResult: 'clear',
      })
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify({ [STAGE]: { strict: entry } }))
      expect(loadStageProgress(storage)).toEqual({ [STAGE]: { strict: entry } })
    })
  })
})

describe('recordStageAttempt', () => {
  it('新規ステージ×モードへの初回クリアで、クリア日時・クリア回数が正しく設定される', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'clear', '2026-07-17T00:00:00.000Z')

    expect(progress[STAGE]?.strict).toEqual({
      firstClearedAt: '2026-07-17T00:00:00.000Z',
      lastClearedAt: '2026-07-17T00:00:00.000Z',
      clearCount: 1,
      failCount: 0,
      lastAttemptAt: '2026-07-17T00:00:00.000Z',
      lastResult: 'clear',
    })
    expect(loadStageProgress(storage)).toEqual(progress)
  })

  it('新規ステージ×モードへの初回失敗で、クリア日時はnullのまま失敗回数のみ増える', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'standard', 'fail', '2026-07-17T00:00:00.000Z')

    expect(progress[STAGE]?.standard).toEqual({
      firstClearedAt: null,
      lastClearedAt: null,
      clearCount: 0,
      failCount: 1,
      lastAttemptAt: '2026-07-17T00:00:00.000Z',
      lastResult: 'fail',
    })
  })

  it('同一ステージでも判定モードごとに記録が独立している(要件3の核心)', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, STAGE, 'strict', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, STAGE, 'standard', 'fail', '2026-07-17T00:01:00.000Z')

    expect(progress[STAGE]?.strict?.clearCount).toBe(1)
    expect(progress[STAGE]?.standard?.clearCount).toBe(0)
    expect(progress[STAGE]?.standard?.failCount).toBe(1)
    // noReversalは未挑戦のまま。
    expect(progress[STAGE]?.noReversal).toBeUndefined()
  })

  it('firstClearedAtは初回クリア時刻のまま保持され、lastClearedAtは直近のクリア時刻に更新される', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, STAGE, 'strict', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'clear', '2026-07-18T00:00:00.000Z')

    expect(progress[STAGE]?.strict).toEqual({
      firstClearedAt: '2026-07-17T00:00:00.000Z',
      lastClearedAt: '2026-07-18T00:00:00.000Z',
      clearCount: 2,
      failCount: 0,
      lastAttemptAt: '2026-07-18T00:00:00.000Z',
      lastResult: 'clear',
    })
  })

  it('別のステージキーの記録は互いに独立している', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'stage-a', 'strict', 'clear', '2026-07-17T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'stage-b', 'strict', 'fail', '2026-07-17T00:01:00.000Z')

    expect(progress['stage-a']?.strict?.clearCount).toBe(1)
    expect(progress['stage-b']?.strict?.failCount).toBe(1)
  })
})

describe('stageStarCount', () => {
  it('記録が無ければ0', () => {
    expect(stageStarCount({}, STAGE)).toBe(0)
  })

  it('1つの判定モードでクリアすれば★1つ', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'clear')
    expect(stageStarCount(progress, STAGE)).toBe(1)
  })

  it('全ての判定モード(strict/standard/noReversal)でクリアすれば★3つ(満点)', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, STAGE, 'strict', 'clear')
    recordStageAttempt(storage, STAGE, 'standard', 'clear')
    const progress = recordStageAttempt(storage, STAGE, 'noReversal', 'clear')
    expect(stageStarCount(progress, STAGE)).toBe(3)
  })

  it('判定モードを変えて同じステージをクリアすると★が増える(要件3の実地確認)', () => {
    const storage = new FakeStorage()
    let progress = recordStageAttempt(storage, STAGE, 'strict', 'clear')
    expect(stageStarCount(progress, STAGE)).toBe(1)
    progress = recordStageAttempt(storage, STAGE, 'standard', 'clear')
    expect(stageStarCount(progress, STAGE)).toBe(2)
  })

  it('失敗のみ(クリア無し)の判定モードは★にカウントされない', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, STAGE, 'strict', 'clear')
    const progress = recordStageAttempt(storage, STAGE, 'standard', 'fail')
    expect(stageStarCount(progress, STAGE)).toBe(1)
  })
})

describe('stageStatus', () => {
  it('記録が無いステージはunattempted', () => {
    expect(stageStatus({}, STAGE)).toBe('unattempted')
  })

  it('失敗記録のみ(★0)ならattempted', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'fail')
    expect(stageStatus(progress, STAGE)).toBe('attempted')
  })

  it('★1つ以上あればcleared', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'clear')
    expect(stageStatus(progress, STAGE)).toBe('cleared')
  })

  it('現存しないステージキーのレコードがあってもエラーにならない(要件6: 未知ID無視)', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, 'stage-removed-by-rebuild', 'strict', 'clear', '2026-07-01T00:00:00.000Z')
    const progress = recordStageAttempt(storage, 'stage-current', 'strict', 'clear', '2026-07-17T00:00:00.000Z')

    expect(() => stageStatus(progress, 'stage-removed-by-rebuild')).not.toThrow()
    expect(stageStatus(progress, 'stage-removed-by-rebuild')).toBe('cleared')
    expect(stageStatus(progress, 'stage-current')).toBe('cleared')
    expect(stageStatus(progress, 'stage-totally-unknown')).toBe('unattempted')
  })
})

describe('stageStatusForMode', () => {
  it('記録が無いモードはunattempted', () => {
    const storage = new FakeStorage()
    const progress = recordStageAttempt(storage, STAGE, 'strict', 'clear')
    expect(stageStatusForMode(progress, STAGE, 'standard')).toBe('unattempted')
  })

  it('クリア済みのモードはcleared、他のモードには影響しない', () => {
    const storage = new FakeStorage()
    recordStageAttempt(storage, STAGE, 'strict', 'clear')
    const progress = recordStageAttempt(storage, STAGE, 'standard', 'fail')
    expect(stageStatusForMode(progress, STAGE, 'strict')).toBe('cleared')
    expect(stageStatusForMode(progress, STAGE, 'standard')).toBe('attempted')
    expect(stageStatusForMode(progress, STAGE, 'noReversal')).toBe('unattempted')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadStageProgress,
  MIDGAME_STAGE_PROGRESS_STORAGE_KEY,
  MIDGAME_STAGE_STARS_MIGRATED_KEY,
  MIDGAME_STAGE_STARS_STORAGE_KEY,
  recordStageAttempt,
  stageBestStars,
  stageFailCount,
  stageStatus,
  type StageProgress,
} from './stageProgress.ts'

/** テスト用の最小限`StorageLike`実装(`localStorage`と同じ振る舞い)。 */
function makeStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; dump(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    dump: () => Object.fromEntries(map),
  }
}

describe('T141: stageProgress(★制の挑戦記録)', () => {
  let storage: ReturnType<typeof makeStorage>

  beforeEach(() => {
    storage = makeStorage()
  })

  it('未保存の状態では空の記録を返す', () => {
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('recordStageAttemptで新規エントリが作られ、以後loadStageProgressで読み戻せる', () => {
    const now = '2026-07-19T00:00:00.000Z'
    const progress = recordStageAttempt(storage, 'stage-1', 2, now)
    expect(progress['stage-1']).toEqual({
      bestStars: 2,
      attempts: 1,
      failCount: 0,
      lastResultStars: 2,
      lastAttemptAt: now,
      firstClearedAt: now,
    })
    expect(loadStageProgress(storage)).toEqual(progress)
  })

  it('bestStarsは単調非減少(後から低い★で挑戦してもbestStarsは下がらない)', () => {
    const t1 = '2026-07-19T00:00:00.000Z'
    const t2 = '2026-07-19T01:00:00.000Z'
    recordStageAttempt(storage, 'stage-1', 3, t1)
    const progress = recordStageAttempt(storage, 'stage-1', 1, t2)
    expect(progress['stage-1']?.bestStars).toBe(3)
    expect(progress['stage-1']?.lastResultStars).toBe(1)
    expect(progress['stage-1']?.attempts).toBe(2)
  })

  it('failCountは★0の挑戦回数だけ加算される', () => {
    recordStageAttempt(storage, 'stage-1', 0)
    recordStageAttempt(storage, 'stage-1', 0)
    const progress = recordStageAttempt(storage, 'stage-1', 2)
    expect(progress['stage-1']?.failCount).toBe(2)
    expect(progress['stage-1']?.attempts).toBe(3)
    expect(progress['stage-1']?.bestStars).toBe(2)
  })

  it('firstClearedAtは最初に★1以上を獲得した日時のまま以後変わらない', () => {
    const t1 = '2026-07-19T00:00:00.000Z'
    const t2 = '2026-07-19T01:00:00.000Z'
    recordStageAttempt(storage, 'stage-1', 1, t1)
    const progress = recordStageAttempt(storage, 'stage-1', 3, t2)
    expect(progress['stage-1']?.firstClearedAt).toBe(t1)
  })

  it('stageStatus: 記録なしはunattempted、bestStars0はattempted、bestStars>=1はcleared', () => {
    recordStageAttempt(storage, 'stage-fail', 0)
    recordStageAttempt(storage, 'stage-clear', 1)
    const progress = loadStageProgress(storage)
    expect(stageStatus(progress, 'stage-none')).toBe('unattempted')
    expect(stageStatus(progress, 'stage-fail')).toBe('attempted')
    expect(stageStatus(progress, 'stage-clear')).toBe('cleared')
  })

  it('stageBestStars/stageFailCountは記録が無ければ0を返す', () => {
    const progress = loadStageProgress(storage)
    expect(stageBestStars(progress, 'unknown')).toBe(0)
    expect(stageFailCount(progress, 'unknown')).toBe(0)
  })

  it('壊れたJSONは空の記録として扱う(例外を投げない)', () => {
    storage.setItem(MIDGAME_STAGE_STARS_STORAGE_KEY, '{not json')
    storage.setItem(MIDGAME_STAGE_STARS_MIGRATED_KEY, '1')
    expect(loadStageProgress(storage)).toEqual({})
  })

  it('形が不正な記録(bestStarsが範囲外)は空の記録として扱う', () => {
    storage.setItem(
      MIDGAME_STAGE_STARS_STORAGE_KEY,
      JSON.stringify({ 'stage-1': { bestStars: 9, attempts: 1, failCount: 0, lastResultStars: 1, lastAttemptAt: '2026-07-19T00:00:00.000Z', firstClearedAt: null } }),
    )
    storage.setItem(MIDGAME_STAGE_STARS_MIGRATED_KEY, '1')
    expect(loadStageProgress(storage)).toEqual({})
  })

  describe('旧記録(判定モード別)からの移行(要件5)', () => {
    const NOW = '2026-07-19T00:00:00.000Z'

    function legacyProgress() {
      return {
        'stage-cleared-strict': {
          strict: { firstClearedAt: NOW, lastClearedAt: NOW, clearCount: 1, failCount: 0, lastAttemptAt: NOW, lastResult: 'clear' },
        },
        'stage-cleared-standard-only': {
          strict: { firstClearedAt: null, lastClearedAt: null, clearCount: 0, failCount: 3, lastAttemptAt: NOW, lastResult: 'fail' },
          standard: { firstClearedAt: NOW, lastClearedAt: NOW, clearCount: 2, failCount: 0, lastAttemptAt: NOW, lastResult: 'clear' },
        },
        'stage-failed-only': {
          strict: { firstClearedAt: null, lastClearedAt: null, clearCount: 0, failCount: 5, lastAttemptAt: NOW, lastResult: 'fail' },
        },
      }
    }

    it('旧記録でいずれかのモードのクリアがあるステージはbestStars=1としてシードされ、旧データは変更されない', () => {
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(legacyProgress()))
      const legacyRawBefore = storage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)

      const progress = loadStageProgress(storage)
      expect(progress['stage-cleared-strict']?.bestStars).toBe(1)
      expect(progress['stage-cleared-standard-only']?.bestStars).toBe(1)
      // 失敗のみ(クリアなし)のステージはシードされない。
      expect(progress['stage-failed-only']).toBeUndefined()

      // 旧データは一切変更されていない。
      expect(storage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)).toBe(legacyRawBefore)
    })

    it('移行は一度だけ実行される(移行後にbestStarsを下げるような旧データの変化があっても再シードしない)', () => {
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(legacyProgress()))
      loadStageProgress(storage) // 1回目: 移行が走る

      // ユーザーが実際にプレイして新記録が更新された、という状況をシミュレートする。
      recordStageAttempt(storage, 'stage-cleared-strict', 3)

      // 旧記録は変わっていなくても、2回目の読み込みでは再シードされない
      // (再シードされるとbestStarsが3から1に巻き戻ってしまう)。
      const progress2 = loadStageProgress(storage)
      expect(progress2['stage-cleared-strict']?.bestStars).toBe(3)
    })

    it('旧記録が存在しない場合は移行が何もせず、新記録は空のまま', () => {
      const progress = loadStageProgress(storage)
      expect(progress).toEqual({})
      expect(storage.getItem(MIDGAME_STAGE_STARS_MIGRATED_KEY)).not.toBeNull()
    })

    it('旧記録が壊れたJSONの場合でも例外を投げず、移行を空扱いで完了させる', () => {
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, '{not json')
      expect(() => loadStageProgress(storage)).not.toThrow()
      expect(loadStageProgress(storage)).toEqual({})
    })

    it('新記録に既にエントリがあるステージは移行で上書きしない(防御的、通常は起こらない状況)', () => {
      // 移行前に新キーへ直接、新記録を書き込んでおく(通常のAPI経由では発生しないが、
      // 移行ロジックの防御性を確認する)。
      const preset: StageProgress = {
        'stage-cleared-strict': {
          bestStars: 3,
          attempts: 5,
          failCount: 0,
          lastResultStars: 3,
          lastAttemptAt: NOW,
          firstClearedAt: NOW,
        },
      }
      storage.setItem(MIDGAME_STAGE_STARS_STORAGE_KEY, JSON.stringify(preset))
      storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(legacyProgress()))

      const progress = loadStageProgress(storage)
      expect(progress['stage-cleared-strict']?.bestStars).toBe(3)
      expect(progress['stage-cleared-strict']?.attempts).toBe(5)
    })
  })
})

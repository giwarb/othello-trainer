import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAllAttempts, getAttemptsForPosition, saveAttempt } from './attemptsStore.ts'
import type { VerbalizeAttemptRecord } from './types.ts'

// vitestの実行環境は`node`のため実ブラウザのIndexedDBは存在しない。`midgame/pool.test.ts`
// と同じ手法で、テストごとに新規の`IDBFactory`(`fake-indexeddb`)を明示的に渡す。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

function makeRecord(id: string, overrides: Partial<VerbalizeAttemptRecord> = {}): VerbalizeAttemptRecord {
  return {
    id,
    positionKey: 'pos-1',
    sideToMove: 'black',
    chosenMove: 'c4',
    chosenTags: ['attr-mobility'],
    freeText: '相手の手を狭めたいので選びました',
    caseKind: 'correctBoth',
    createdAt: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('verbalize/attemptsStore (IndexedDB挑戦記録+自由記述の永続化)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('初期状態ではgetAllAttemptsは空配列を返す', async () => {
    expect(await getAllAttempts(factory)).toEqual([])
  })

  it('saveAttemptで保存した記録をgetAllAttemptsで読み戻せる(自由記述を含む)', async () => {
    const record = makeRecord('v-1', { freeText: '隅を強く意識した一手' })
    await saveAttempt(record, factory)

    const all = await getAllAttempts(factory)
    expect(all).toEqual([record])
  })

  it('同じidで保存すると上書きされる', async () => {
    await saveAttempt(makeRecord('v-1', { freeText: '最初のメモ' }), factory)
    await saveAttempt(makeRecord('v-1', { freeText: '書き直したメモ' }), factory)

    const all = await getAllAttempts(factory)
    expect(all.length).toBe(1)
    expect(all[0]?.freeText).toBe('書き直したメモ')
  })

  it('getAttemptsForPositionは同じpositionKeyの記録だけを新しい順に返す', async () => {
    await saveAttempt(
      makeRecord('v-1', { positionKey: 'pos-a', freeText: '1回目', createdAt: '2026-07-01T00:00:00.000Z' }),
      factory,
    )
    await saveAttempt(
      makeRecord('v-2', { positionKey: 'pos-a', freeText: '2回目', createdAt: '2026-07-05T00:00:00.000Z' }),
      factory,
    )
    await saveAttempt(
      makeRecord('v-3', { positionKey: 'pos-b', freeText: '別局面', createdAt: '2026-07-03T00:00:00.000Z' }),
      factory,
    )

    const forA = await getAttemptsForPosition('pos-a', factory)
    expect(forA.map((r) => r.freeText)).toEqual(['2回目', '1回目'])

    const forB = await getAttemptsForPosition('pos-b', factory)
    expect(forB.map((r) => r.freeText)).toEqual(['別局面'])

    const forNone = await getAttemptsForPosition('pos-none', factory)
    expect(forNone).toEqual([])
  })

  it('別のfactoryインスタンス間ではデータが分離される(テストの独立性確認)', async () => {
    await saveAttempt(makeRecord('v-1'), factory)

    const otherFactory = freshFactory()
    expect(await getAllAttempts(otherFactory)).toEqual([])
  })
})

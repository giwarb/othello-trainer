import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAllSrsStates, getSrsState, putSrsState } from './db.ts'
import { createInitialSrsState, nextSrsState } from './srs.ts'

// vitestの実行環境は `node` のため、実ブラウザのIndexedDBは存在しない。`db.ts` の各関数は
// `IDBFactory` を引数として受け取れるようになっているので、`fake-indexeddb` が提供する
// スタンドアロンな `IDBFactory` 実装をテストごとに新規生成して明示的に渡す(グローバルを
// ポリフィルする `fake-indexeddb/auto` は使わない。テストごとにDBを分離するため)。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

describe('joseki/db (IndexedDB永続化)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('未保存のラインは getSrsState が undefined を返す', async () => {
    const state = await getSrsState('虎', factory)
    expect(state).toBeUndefined()
  })

  it('putSrsStateで保存した状態をgetSrsStateで読み戻せる', async () => {
    const state = createInitialSrsState('虎', new Date(2026, 6, 7))
    await putSrsState(state, factory)

    const loaded = await getSrsState('虎', factory)
    expect(loaded).toEqual(state)
  })

  it('putSrsStateで同じlineIdを2回保存すると上書きされる', async () => {
    const first = createInitialSrsState('虎', new Date(2026, 6, 7))
    await putSrsState(first, factory)

    const second = nextSrsState(first, '虎', 'success', new Date(2026, 6, 8))
    await putSrsState(second, factory)

    const loaded = await getSrsState('虎', factory)
    expect(loaded).toEqual(second)
    expect(loaded?.interval).toBe(second.interval)
  })

  it('getAllSrsStatesは保存済みの全ラインの状態を返す', async () => {
    const tora = createInitialSrsState('虎', new Date(2026, 6, 7))
    const rose = createInitialSrsState('バラ', new Date(2026, 6, 7))
    await putSrsState(tora, factory)
    await putSrsState(rose, factory)

    const all = await getAllSrsStates(factory)
    expect(all.map((s) => s.lineId).sort()).toEqual(['バラ', '虎'])
  })

  it('別のfactoryインスタンス間ではデータが分離される(テストの独立性確認)', async () => {
    await putSrsState(createInitialSrsState('虎', new Date(2026, 6, 7)), factory)

    const otherFactory = freshFactory()
    const all = await getAllSrsStates(otherFactory)
    expect(all).toEqual([])
  })
})

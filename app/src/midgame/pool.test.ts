import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { addPoolEntry, getAllPoolEntries, removePoolEntry } from './pool.ts'
import type { MidgamePoolEntry } from './types.ts'

// vitestの実行環境は `node` のため、実ブラウザのIndexedDBは存在しない。`pool.ts` の
// 各関数は `IDBFactory` を引数として受け取れるようになっているので、`fake-indexeddb` が
// 提供するスタンドアロンな `IDBFactory` 実装をテストごとに新規生成して明示的に渡す
// (`joseki/db.test.ts` と同じ手法)。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

function makeEntry(id: string, overrides: Partial<MidgamePoolEntry> = {}): MidgamePoolEntry {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    turn: 'black',
    source: 'blunder-review',
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('midgame/pool (IndexedDB出題プール永続化)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('初期状態ではgetAllPoolEntriesは空配列を返す', async () => {
    const all = await getAllPoolEntries(factory)
    expect(all).toEqual([])
  })

  it('addPoolEntryで追加したレコードをgetAllPoolEntriesで読み戻せる', async () => {
    const entry = makeEntry('midgame-1')
    await addPoolEntry(entry, factory)

    const all = await getAllPoolEntries(factory)
    expect(all).toEqual([entry])
  })

  it('同じidで追加すると上書きされる(重複登録されない)', async () => {
    await addPoolEntry(makeEntry('midgame-1', { source: 'blunder-review' }), factory)
    await addPoolEntry(makeEntry('midgame-1', { source: 'updated' }), factory)

    const all = await getAllPoolEntries(factory)
    expect(all.length).toBe(1)
    expect(all[0]?.source).toBe('updated')
  })

  it('複数レコードをまとめて読み込める', async () => {
    await addPoolEntry(makeEntry('midgame-1'), factory)
    await addPoolEntry(makeEntry('midgame-2', { turn: 'white' }), factory)

    const all = await getAllPoolEntries(factory)
    expect(all.map((e) => e.id).sort()).toEqual(['midgame-1', 'midgame-2'])
  })

  it('removePoolEntryで指定したレコードだけ削除できる', async () => {
    await addPoolEntry(makeEntry('midgame-1'), factory)
    await addPoolEntry(makeEntry('midgame-2'), factory)

    await removePoolEntry('midgame-1', factory)

    const all = await getAllPoolEntries(factory)
    expect(all.map((e) => e.id)).toEqual(['midgame-2'])
  })

  it('別のfactoryインスタンス間ではデータが分離される(テストの独立性確認)', async () => {
    await addPoolEntry(makeEntry('midgame-1'), factory)

    const otherFactory = freshFactory()
    const all = await getAllPoolEntries(otherFactory)
    expect(all).toEqual([])
  })
})

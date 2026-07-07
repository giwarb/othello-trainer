import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { addPoolEntry, getAllPoolEntries } from '../midgame/pool.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import { getAllSrsStates, getSrsState, putSrsState } from '../joseki/db.ts'
import { createInitialSrsState } from '../joseki/srs.ts'
import { APP_DB_VERSION, JOSEKI_SRS_STORE, MIDGAME_POOL_STORE, openAppDb } from './appDb.ts'

/**
 * `joseki/db.ts`(定石練習モードのSRS状態)と`midgame/pool.ts`(中盤練習モードの
 * 出題プール)が同じIndexedDBデータベース(`othello-trainer`)を正しく共存できる
 * ことを検証する(T021 reviewer指摘のmust 2の回帰テスト)。
 *
 * 修正前は`joseki/db.ts`がバージョン1、`midgame/pool.ts`がバージョン2を
 * それぞれ独自に定義しており、`midgame/pool.ts`側の関数を先に呼ぶとDBが
 * バージョン2に上がってしまい、以後`joseki/db.ts`側のバージョン1での
 * `open()`が`VersionError`で失敗する回帰バグがあった(reviewerが
 * `fake-indexeddb`で再現)。本テストはその具体的な再現手順(中盤練習で
 * 出題プールに登録 → 定石練習のSRS状態を読み書き)を直接検証する。
 */
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

function makePoolEntry(id: string): MidgamePoolEntry {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    turn: 'black',
    source: 'blunder-review',
    createdAt: '2026-07-08T00:00:00.000Z',
  }
}

describe('db/appDb (joseki/db.ts と midgame/pool.ts の共存)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('openAppDbは両方のストア(josekiSRS/midgamePool)を作成し、DBバージョンはAPP_DB_VERSIONになる', async () => {
    const db = await openAppDb(factory)
    try {
      expect(db.version).toBe(APP_DB_VERSION)
      expect(db.objectStoreNames.contains(JOSEKI_SRS_STORE)).toBe(true)
      expect(db.objectStoreNames.contains(MIDGAME_POOL_STORE)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('中盤練習(pool.ts)を先に使っても、その後の定石練習(joseki/db.ts)のSRS読み書きがVersionErrorにならず成功する(reviewerが発見した回帰の再現手順)', async () => {
    // 1. 中盤練習モードで失敗し、出題プールに1件登録する(この時点でDBが作成される)。
    await addPoolEntry(makePoolEntry('midgame-1'), factory)
    const pool = await getAllPoolEntries(factory)
    expect(pool.map((e) => e.id)).toEqual(['midgame-1'])

    // 2. 続けて定石練習モードでクリアし、SRS状態を保存・取得する。
    //    修正前はここで`joseki/db.ts`側の`open(name, 1)`がVersionErrorで失敗していた。
    const state = createInitialSrsState('虎', new Date(2026, 6, 8))
    await putSrsState(state, factory)
    const loaded = await getSrsState('虎', factory)
    expect(loaded).toEqual(state)

    const all = await getAllSrsStates(factory)
    expect(all.map((s) => s.lineId)).toEqual(['虎'])
  })

  it('逆順(定石練習を先に使ってから中盤練習)でも両方が正常に動作する', async () => {
    const state = createInitialSrsState('猫', new Date(2026, 6, 8))
    await putSrsState(state, factory)

    await addPoolEntry(makePoolEntry('midgame-2'), factory)
    const pool = await getAllPoolEntries(factory)
    expect(pool.map((e) => e.id)).toEqual(['midgame-2'])

    const loaded = await getSrsState('猫', factory)
    expect(loaded).toEqual(state)
  })

  it('互いのストアのデータは独立している(josekiSRSとmidgamePoolが混在しない)', async () => {
    await addPoolEntry(makePoolEntry('midgame-3'), factory)
    await putSrsState(createInitialSrsState('虎', new Date(2026, 6, 8)), factory)

    const pool = await getAllPoolEntries(factory)
    const srsStates = await getAllSrsStates(factory)
    expect(pool.length).toBe(1)
    expect(srsStates.length).toBe(1)
  })
})

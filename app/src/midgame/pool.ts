/**
 * 中盤練習モードの出題プール(失敗した開始局面の自動収集、要件7)をIndexedDBに
 * 永続化する(T021)。
 *
 * `joseki/db.ts`(T020)と同じDB(`othello-trainer`)内に新規ストア`midgamePool`を
 * 追加する形にする(タスク仕様「T020の`josekiSRS`と同じDB内に新ストアを追加する
 * 形でよい」参照)。`joseki/db.ts`はバージョン1で`josekiSRS`ストアのみを作成して
 * いるため、本モジュールはより新しいバージョン(`MIDGAME_DB_VERSION = 2`)でDBを
 * 開く。IndexedDBの仕様上、あるバージョンで一度でも`open`されたDBは、以後それより
 * 低いバージョン指定での`open`でも(アップグレード扱いにならず)問題なく開けるため、
 * `joseki/db.ts`側のバージョン定数(1)を変更する必要はない。
 *
 * また、`onupgradeneeded`内では`josekiSRS`ストアの存在も確認して無ければ作成する
 * (`joseki/db.ts`のインポートで定数を共有し、ストア定義がずれないようにする)。
 * これは、ブラウザにまだ`othello-trainer`DBが一度も作られていない状態で、
 * 本モジュールの関数が`joseki/db.ts`側より先に呼ばれた場合でも、
 * `josekiSRS`ストアが欠けたままにならないようにするための防御。
 */

import { JOSEKI_DB_NAME, JOSEKI_SRS_STORE } from '../joseki/db.ts'
import type { MidgamePoolEntry } from './types.ts'

export const MIDGAME_DB_VERSION = 2
export const MIDGAME_POOL_STORE = 'midgamePool'

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(JOSEKI_DB_NAME, MIDGAME_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(JOSEKI_SRS_STORE)) {
        db.createObjectStore(JOSEKI_SRS_STORE, { keyPath: 'lineId' })
      }
      if (!db.objectStoreNames.contains(MIDGAME_POOL_STORE)) {
        db.createObjectStore(MIDGAME_POOL_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDBのオープンに失敗しました'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDBの操作に失敗しました'))
  })
}

/** 出題プールに1件追加する(同じ`id`が既にあれば上書き)。 */
export async function addPoolEntry(
  entry: MidgamePoolEntry,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(MIDGAME_POOL_STORE, 'readwrite')
    const store = tx.objectStore(MIDGAME_POOL_STORE)
    await requestToPromise(store.put(entry))
  } finally {
    db.close()
  }
}

/** 出題プールの全レコードを読み込む。 */
export async function getAllPoolEntries(
  factory: IDBFactory = defaultIndexedDb(),
): Promise<MidgamePoolEntry[]> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(MIDGAME_POOL_STORE, 'readonly')
    const store = tx.objectStore(MIDGAME_POOL_STORE)
    const result = await requestToPromise<MidgamePoolEntry[]>(store.getAll())
    return result
  } finally {
    db.close()
  }
}

/** 出題プールから1件削除する。 */
export async function removePoolEntry(
  id: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(MIDGAME_POOL_STORE, 'readwrite')
    const store = tx.objectStore(MIDGAME_POOL_STORE)
    await requestToPromise(store.delete(id))
  } finally {
    db.close()
  }
}

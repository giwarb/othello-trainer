/**
 * 中盤練習モードの出題プール(失敗した開始局面の自動収集、要件7)をIndexedDBに
 * 永続化する(T021)。
 *
 * `joseki/db.ts`(T020)と同じDB(`othello-trainer`)内に新規ストア`midgamePool`を
 * 追加する(タスク仕様「T020の`josekiSRS`と同じDB内に新ストアを追加する形でよい」参照)。
 *
 * DB名・バージョン番号・ストア作成ロジックは `db/appDb.ts` に一元化されている
 * (T021 reviewer指摘のmust 2対応: 以前は本ファイルが独自にバージョン2を定義し、
 * `joseki/db.ts`が独自にバージョン1を定義していた。IndexedDBの仕様上、
 * 「現在のDBバージョンより低い番号でopen()するとVersionErrorになる」ため、
 * 中盤練習モードを1回でも使うとDBがバージョン2に上がり、以後`joseki/db.ts`側の
 * バージョン1での`open()`(定石練習のSRS記録)がすべて失敗する回帰バグがあった
 * ——旧実装のコメントにあった「低いバージョンでも問題なく開ける」は誤り。
 * この修正でDB名・バージョン・全ストアの作成ロジックを`db/appDb.ts`に一元化し、
 * 本ファイル・`joseki/db.ts`のどちらが先に呼ばれても同じバージョンで正しく
 * 共存できるようにした。詳細は`db/appDb.ts`のコメント参照)。
 */

import { MIDGAME_POOL_STORE, openAppDb, requestToPromise } from '../db/appDb.ts'
import type { MidgamePoolEntry } from './types.ts'

export { MIDGAME_POOL_STORE }

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/** 出題プールに1件追加する(同じ`id`が既にあれば上書き)。 */
export async function addPoolEntry(
  entry: MidgamePoolEntry,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openAppDb(factory)
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
  const db = await openAppDb(factory)
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
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(MIDGAME_POOL_STORE, 'readwrite')
    const store = tx.objectStore(MIDGAME_POOL_STORE)
    await requestToPromise(store.delete(id))
  } finally {
    db.close()
  }
}

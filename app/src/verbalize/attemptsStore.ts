/**
 * T035「言語化トレーニングモード」の挑戦記録+自由記述の永続化(要件6)。
 *
 * DB名・バージョン番号・ストア作成ロジックは`db/appDb.ts`に一元管理されている
 * (T021 reviewer指摘のmust 2対応を踏襲。本ファイルは独自のバージョン定数を
 * 一切持たず、`openAppDb`だけを使う。`midgame/pool.ts`・`tsume/stats.ts`と同じ方針)。
 */

import { openAppDb, requestToPromise, VERBALIZE_ATTEMPTS_STORE } from '../db/appDb.ts'
import type { VerbalizeAttemptRecord } from './types.ts'

export { VERBALIZE_ATTEMPTS_STORE }

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/** 1回の挑戦記録(選んだ手・理由タグ・自由記述・採点結果)を保存する(同じ`id`があれば上書き)。 */
export async function saveAttempt(
  record: VerbalizeAttemptRecord,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(VERBALIZE_ATTEMPTS_STORE, 'readwrite')
    const store = tx.objectStore(VERBALIZE_ATTEMPTS_STORE)
    await requestToPromise(store.put(record))
  } finally {
    db.close()
  }
}

/** 保存済みの全挑戦記録を読み込む。 */
export async function getAllAttempts(
  factory: IDBFactory = defaultIndexedDb(),
): Promise<VerbalizeAttemptRecord[]> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(VERBALIZE_ATTEMPTS_STORE, 'readonly')
    const store = tx.objectStore(VERBALIZE_ATTEMPTS_STORE)
    const result = await requestToPromise<VerbalizeAttemptRecord[]>(store.getAll())
    return result
  } finally {
    db.close()
  }
}

/**
 * `positionKey`が一致する過去の挑戦記録を、新しい順(`createdAt`降順)に返す
 * (要件6: 同じ局面に再挑戦した際に過去の自分の記述と並べて表示する)。
 *
 * IndexedDBにインデックスを追加せず、`getAllAttempts`してJS側でフィルタする
 * (`tsume/stats.ts`の`getAllAttempts`と同じ、このアプリの規模ではインデックス
 * 無しで十分という既存の方針を踏襲)。
 */
export async function getAttemptsForPosition(
  positionKey: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<VerbalizeAttemptRecord[]> {
  const all = await getAllAttempts(factory)
  return all
    .filter((record) => record.positionKey === positionKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * 定石練習モードのSRS状態(`JosekiSrsState`)をIndexedDBに永続化する(T020)。
 *
 * `localStorage`(`blunder/storage.ts`)と異なりIndexedDBを使うのは、
 * ライン数(35件)分のレコードを持つコレクションをキーで読み書きする
 * 用途に自然に合うため。ストア名は `josekiSRS`、キーは `JosekiSrsState.lineId`。
 *
 * 単体テストでは `fake-indexeddb` を使い実際の `indexedDB` グローバルを
 * 差し替える(vitestの実行環境は `node` のため、`indexedDB` はテスト側で
 * 明示的に用意する必要がある。`db.test.ts` 参照)。本番では
 * `window.indexedDB` をそのまま使う(引数省略時の既定値)。
 */

import { nextSrsState, type JosekiSrsState } from './srs.ts'

export const JOSEKI_DB_NAME = 'othello-trainer'
export const JOSEKI_DB_VERSION = 1
export const JOSEKI_SRS_STORE = 'josekiSRS'

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(JOSEKI_DB_NAME, JOSEKI_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(JOSEKI_SRS_STORE)) {
        db.createObjectStore(JOSEKI_SRS_STORE, { keyPath: 'lineId' })
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

/** 指定した1ラインのSRS状態を読み込む。未保存であれば `undefined`。 */
export async function getSrsState(
  lineId: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<JosekiSrsState | undefined> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(JOSEKI_SRS_STORE, 'readonly')
    const store = tx.objectStore(JOSEKI_SRS_STORE)
    const result = await requestToPromise<JosekiSrsState | undefined>(store.get(lineId))
    return result
  } finally {
    db.close()
  }
}

/** 保存済みの全ラインのSRS状態を読み込む(未出題のラインは含まれない)。 */
export async function getAllSrsStates(
  factory: IDBFactory = defaultIndexedDb(),
): Promise<JosekiSrsState[]> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(JOSEKI_SRS_STORE, 'readonly')
    const store = tx.objectStore(JOSEKI_SRS_STORE)
    const result = await requestToPromise<JosekiSrsState[]>(store.getAll())
    return result
  } finally {
    db.close()
  }
}

/** 1ラインのSRS状態を保存(新規作成または上書き)する。 */
export async function putSrsState(
  state: JosekiSrsState,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openDb(factory)
  try {
    const tx = db.transaction(JOSEKI_SRS_STORE, 'readwrite')
    const store = tx.objectStore(JOSEKI_SRS_STORE)
    await requestToPromise(store.put(state))
  } finally {
    db.close()
  }
}

/**
 * 複数のラインID(定石練習モードの1セッションで通過した複数の`isLeaf`ノードの名前など)
 * について、まとめてSRS結果(成功/失敗)を記録する(やり直し1回目の要件7)。
 *
 * 1本の長い定石を最後まで辿ったセッションは、途中で通過した短いラインの終端も
 * クリアしたことになる(`practiceSession.ts` の `advanceClearState` 参照)ため、
 * それらすべてについて個別にSRS状態を読み込み・更新・保存する。
 * 1件の読み書きが失敗しても他のラインの記録は続行し、エラーはログに出すだけに留める
 * (SRS記録の失敗でユーザーの練習セッション自体が失敗扱いになることを避けるため)。
 */
export async function recordSrsResults(
  lineIds: readonly string[],
  result: 'success' | 'fail',
  now: Date = new Date(),
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  for (const lineId of lineIds) {
    try {
      const prev = (await getSrsState(lineId, factory)) ?? null
      const next = nextSrsState(prev, lineId, result, now)
      await putSrsState(next, factory)
    } catch (error) {
      console.error(`SRS状態の更新に失敗しました(line=${lineId})`, error)
    }
  }
}

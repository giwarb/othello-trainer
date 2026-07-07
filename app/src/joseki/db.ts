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
 *
 * DB名・バージョン番号・ストア作成ロジックは `db/appDb.ts` に一元化されている
 * (T021 reviewer指摘のmust 2対応: 以前は本ファイルが独自にバージョン1を
 * 定義しており、`midgame/pool.ts`が独自にバージョン2を定義していたため、
 * 中盤練習モードを使うとDBがバージョン2に上がり、以後本ファイルのバージョン1
 * での`open()`が`VersionError`で失敗する回帰バグがあった。詳細は`db/appDb.ts`
 * のコメント参照)。
 */

import { JOSEKI_SRS_STORE, openAppDb, requestToPromise } from '../db/appDb.ts'
import { nextSrsState, type JosekiSrsState } from './srs.ts'

// 後方互換のため、既存の呼び出し元(`midgame/pool.ts`等)がこれまでどおり
// `joseki/db.ts`からDB名・ストア名を参照できるよう再エクスポートする
// (実体は`db/appDb.ts`に一元化済み)。
export { APP_DB_NAME as JOSEKI_DB_NAME } from '../db/appDb.ts'
export { JOSEKI_SRS_STORE }

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/** 指定した1ラインのSRS状態を読み込む。未保存であれば `undefined`。 */
export async function getSrsState(
  lineId: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<JosekiSrsState | undefined> {
  const db = await openAppDb(factory)
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
  const db = await openAppDb(factory)
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
  const db = await openAppDb(factory)
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

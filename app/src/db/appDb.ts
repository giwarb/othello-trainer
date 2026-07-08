/**
 * アプリ全体で共有するIndexedDBのデータベース名・バージョン・スキーマ定義。
 *
 * # 背景(T021 reviewer指摘のmust 2対応)
 *
 * `joseki/db.ts`(T020、`josekiSRS`ストア)と`midgame/pool.ts`(T021、`midgamePool`
 * ストア)は同一のIndexedDBデータベース(`othello-trainer`)内に別々のオブジェクト
 * ストアを持つ。以前の実装では両モジュールがそれぞれ独自にバージョン番号
 * (`josekiSRS`側は1、`midgamePool`側は2)を定義して`open()`していたが、これは
 * IndexedDBの仕様(あるバージョンで一度でも作成されたデータベースを、それより
 * **低い**バージョン番号で`open()`すると`VersionError`になる)に反する誤った設計
 * だった。中盤練習モードを1回でも使うとDBがバージョン2に上がり、以後
 * `joseki/db.ts`側のバージョン1での`open()`(定石練習のSRS記録)がすべて失敗する、
 * という実際の回帰バグを引き起こしていた(reviewerが`fake-indexeddb`で再現)。
 *
 * この種のバグを構造的に防ぐため、DB名・バージョン番号・全ストアの作成ロジックを
 * 本モジュールに一元化する。`joseki/db.ts`・`midgame/pool.ts`はいずれも本モジュールの
 * `openAppDb`だけを使い、独自にバージョン番号を定義しない。**新しいオブジェクトストアを
 * 追加する場合は、必ず本モジュールにストア名の定数を追加し、`upgrade()`内に作成処理を
 * 追加した上で`APP_DB_VERSION`を1つ上げること**(スキーマ定義の一元管理を崩さないこと)。
 */

export const APP_DB_NAME = 'othello-trainer'

/**
 * 現在のスキーマバージョン。
 * - v1: `josekiSRS`ストア(T020)
 * - v2: `midgamePool`ストア追加(T021)
 * - v3: `tsumeAttempts`ストア追加(T028)
 */
export const APP_DB_VERSION = 3

/** 定石練習モード(T020)のSRS状態ストア。キーは`JosekiSrsState.lineId`。 */
export const JOSEKI_SRS_STORE = 'josekiSRS'

/** 中盤練習モード(T021)の出題プールストア。キーは`MidgamePoolEntry.id`。 */
export const MIDGAME_POOL_STORE = 'midgamePool'

/** 詰めオセロプレイモード(T028)の挑戦履歴ストア。キーは`PuzzleAttemptRecord.id`。 */
export const TSUME_ATTEMPTS_STORE = 'tsumeAttempts'

/** `APP_DB_VERSION`時点で存在すべき全ストアを作成する(既存なら何もしない)。 */
function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(JOSEKI_SRS_STORE)) {
    db.createObjectStore(JOSEKI_SRS_STORE, { keyPath: 'lineId' })
  }
  if (!db.objectStoreNames.contains(MIDGAME_POOL_STORE)) {
    db.createObjectStore(MIDGAME_POOL_STORE, { keyPath: 'id' })
  }
  if (!db.objectStoreNames.contains(TSUME_ATTEMPTS_STORE)) {
    db.createObjectStore(TSUME_ATTEMPTS_STORE, { keyPath: 'id' })
  }
}

/**
 * `othello-trainer`データベースを共通のバージョン(`APP_DB_VERSION`)で開く。
 * `joseki/db.ts`・`midgame/pool.ts`のいずれから最初に呼ばれても、この関数の
 * `upgrade()`が全ストアをまとめて作成するため、呼び出し順に依存せず正しく
 * 動作する。
 */
export function openAppDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(APP_DB_NAME, APP_DB_VERSION)

    request.onupgradeneeded = () => {
      upgrade(request.result)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDBのオープンに失敗しました'))
  })
}

/** `IDBRequest`をPromise化する共通ヘルパー。 */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDBの操作に失敗しました'))
  })
}

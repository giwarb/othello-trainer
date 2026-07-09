/**
 * 棋譜解析結果のIndexedDBキャッシュ(T029、要件5)。
 *
 * 局面ハッシュ(`joseki/normalize.ts`の`hashBoard`、T017)をキーの一部にして、
 * 同一局面(かつ同一の探索条件)の再解析を避ける。
 *
 * DB名・バージョン番号・ストア作成ロジックは`db/appDb.ts`に一元化されている
 * (T021 reviewer指摘のmust 2対応。過去にモジュールごとに独自のバージョン番号を
 * 定義してIndexedDBが壊れた回帰バグがあったため、本ファイルは独自のバージョン
 * 定数を持たず、`db/appDb.ts`の`openAppDb`だけを使う)。
 */

import { ANALYSIS_CACHE_STORE, openAppDb, requestToPromise } from '../db/appDb.ts'
import type { MoveEvalJson } from '../engine/types.ts'

/** `analysisCache`ストアの1レコード。キーは`cacheKey()`が作る文字列。 */
export interface CachedPositionAnalysis {
  readonly key: string
  readonly moves: MoveEvalJson[]
}

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/**
 * キャッシュキーを作る。`limitTag`は探索条件(depth/exactFromEmptiesなど)を表す
 * 短い文字列で、異なる探索条件で解析した結果が混同されないようにする
 * (`analyzeGame.ts`の`LIMIT_TAG`参照)。
 */
export function cacheKey(positionHash: string, limitTag: string): string {
  return `${positionHash}|${limitTag}`
}

/** キャッシュ済みの解析結果(現局面の全合法手評価)を読み込む。無ければ`undefined`。 */
export async function getCachedAnalysis(
  key: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<MoveEvalJson[] | undefined> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readonly')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    const result = await requestToPromise<CachedPositionAnalysis | undefined>(store.get(key))
    return result?.moves
  } finally {
    db.close()
  }
}

/** 解析結果(現局面の全合法手評価)をキャッシュに保存する(同じキーがあれば上書き)。 */
export async function putCachedAnalysis(
  key: string,
  moves: readonly MoveEvalJson[],
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readwrite')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    const record: CachedPositionAnalysis = { key, moves: [...moves] }
    await requestToPromise(store.put(record))
  } finally {
    db.close()
  }
}

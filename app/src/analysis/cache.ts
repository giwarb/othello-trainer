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
 *
 * # エンジン・評価アルゴリズムのバージョニング(T060)
 *
 * ユーザー報告: 「一度盤面評価すると、ブラウザでキャッシュする仕組みがあるようで、
 * 新しくデプロイしても結果が変わらなかったりする」。以前の`cacheKey()`は
 * `positionHash + limitTag`のみをキーにしており、エンジン・評価アルゴリズムの
 * バージョンを一切考慮していなかった。そのため評価アルゴリズムを変更して
 * デプロイしても、以前に同じ局面を解析したことがあれば古いキャッシュが
 * ヒットし続け、新しい(修正後の)評価が使われないバグがあった。
 *
 * これを解消するため、`cacheKey()`に`ANALYSIS_ENGINE_VERSION`(手動管理の
 * バージョン定数)を含める。**エンジン(`engine`クレート)・評価アルゴリズム・
 * パターン評価の重みファイル(`pattern_v2.bin`等)に影響する変更を行うたびに、
 * この定数を1つ上げること**。値を上げると`cacheKey()`が返す文字列が変わり、
 * 以前保存されたレコードとキーが一致しなくなるため、古いキャッシュは
 * 自動的に「無視」される(削除はしないが二度とヒットしない。古いレコードは
 * IndexedDB容量を消費し続けるが実害はなく、ユーザーは手動クリアボタン
 * (`AnalysisMode.tsx`の`clearAnalysisCache`呼び出し)でも一括削除できる)。
 *
 * 本バージョニングの仕組み自体の導入(キー形式に`|v${N}`を追加したこと)により、
 * このタスク以前に保存されていた(バージョンサフィックスの無い)キャッシュは
 * 形式が変わったことで自動的に無効化される。
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
 * エンジン・評価アルゴリズムのバージョン(T060)。`cacheKey()`に含まれる。
 * 評価結果に影響しうる変更(探索アルゴリズム・評価関数・パターン重みファイル
 * 等)をデプロイするたびに、このファイルの本定数を1つ上げること。上げると
 * 以前のキャッシュキーと一致しなくなり、古い解析結果は再解析される。
 */
export const ANALYSIS_ENGINE_VERSION = 1

/**
 * キャッシュキーを作る。`limitTag`は探索条件(depth/exactFromEmptiesなど)を表す
 * 短い文字列で、異なる探索条件で解析した結果が混同されないようにする
 * (`analyzeGame.ts`の`LIMIT_TAG`参照)。`ANALYSIS_ENGINE_VERSION`(上記)も
 * キーに含め、評価アルゴリズムのバージョンが変わった場合に古いキャッシュが
 * 誤ってヒットしないようにする(T060)。
 */
export function cacheKey(positionHash: string, limitTag: string): string {
  return `${positionHash}|${limitTag}|v${ANALYSIS_ENGINE_VERSION}`
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

/**
 * 解析結果キャッシュ(`analysisCache`ストア)を全件削除する(T060要件2)。
 * `AnalysisMode.tsx`の手動クリアボタンから呼ばれる。バージョニング
 * (`ANALYSIS_ENGINE_VERSION`)は本来デプロイのたびに古いキャッシュを自動的に
 * 無効化する仕組みだが、ユーザーが任意のタイミングで確実にクリアできる手段も
 * 用意しておく(要件2)。
 */
export async function clearAnalysisCache(factory: IDBFactory = defaultIndexedDb()): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readwrite')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    await requestToPromise(store.clear())
  } finally {
    db.close()
  }
}

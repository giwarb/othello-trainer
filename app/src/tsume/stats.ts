/**
 * 詰めオセロプレイモードの成績記録(T028、要件5)。
 *
 * 設計書§5.3「成績: 正答率・平均時間・タグ別弱点を記録し、弱点タグを優先出題する」を
 * 実装する。1回の挑戦(1問を提示してから正誤が確定するまで)を `PuzzleAttemptRecord`
 * として IndexedDB(`db/appDb.ts` の `tsumeAttempts` ストア)に永続化し、そこから
 * 正答率・平均時間・タグ別正答率を集計する純粋関数、および弱点タグを優先する
 * 簡易な重み付き抽選関数を提供する(タスク仕様「やらないこと」により、出題プールの
 * 高度な弱点優先ロジックは対象外。ここでは「正答率が低いタグを含む問題ほど選ばれやすい」
 * 程度の簡易な重み付けに留める)。
 *
 * DB名・バージョン番号・ストア作成ロジックは `db/appDb.ts` に一元化されている
 * (`joseki/db.ts`・`midgame/pool.ts` と同じ方針。詳細はそれらのコメント参照)。
 */

import { openAppDb, requestToPromise, TSUME_ATTEMPTS_STORE } from '../db/appDb.ts'
import type { Puzzle, PuzzleTag } from './types.ts'

export { TSUME_ATTEMPTS_STORE }

/** 1回の挑戦(問題提示 → 正誤確定)の記録。 */
export interface PuzzleAttemptRecord {
  /** 一意なID(ストアのキー)。 */
  readonly id: string
  readonly puzzleId: string
  /** 最善結果を維持したまま(=一度も悪手を打たずに)解ききれたかどうか。 */
  readonly correct: boolean
  /** 問題提示から正誤確定までの経過時間(ミリ秒)。 */
  readonly elapsedMs: number
  /** 挑戦した問題が持つ手筋タグ(タグ別正答率の集計に使う)。 */
  readonly tags: readonly PuzzleTag[]
  readonly createdAt: string
}

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/** 1件の挑戦記録を保存する(同じ`id`が既にあれば上書き)。 */
export async function recordAttempt(
  record: PuzzleAttemptRecord,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(TSUME_ATTEMPTS_STORE, 'readwrite')
    const store = tx.objectStore(TSUME_ATTEMPTS_STORE)
    await requestToPromise(store.put(record))
  } finally {
    db.close()
  }
}

/** 保存済みの全挑戦記録を読み込む。 */
export async function getAllAttempts(
  factory: IDBFactory = defaultIndexedDb(),
): Promise<PuzzleAttemptRecord[]> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(TSUME_ATTEMPTS_STORE, 'readonly')
    const store = tx.objectStore(TSUME_ATTEMPTS_STORE)
    const result = await requestToPromise<PuzzleAttemptRecord[]>(store.getAll())
    return result
  } finally {
    db.close()
  }
}

/** 全体の成績サマリ(要件5)。挑戦記録が1件もなければ全て `null`/`0`。 */
export interface OverallStats {
  readonly attempts: number
  readonly correct: number
  /** 正答率(0〜1)。挑戦記録が無ければ `null`。 */
  readonly accuracy: number | null
  /** 平均時間(ミリ秒)。挑戦記録が無ければ `null`。 */
  readonly averageElapsedMs: number | null
}

/** `records` から全体の正答率・平均時間を集計する純粋関数。 */
export function computeOverallStats(records: readonly PuzzleAttemptRecord[]): OverallStats {
  if (records.length === 0) {
    return { attempts: 0, correct: 0, accuracy: null, averageElapsedMs: null }
  }
  const correct = records.filter((r) => r.correct).length
  const totalElapsedMs = records.reduce((sum, r) => sum + r.elapsedMs, 0)
  return {
    attempts: records.length,
    correct,
    accuracy: correct / records.length,
    averageElapsedMs: totalElapsedMs / records.length,
  }
}

/**
 * `records` からタグ別の正答率を集計する純粋関数。
 * 1回の挑戦につき、その問題が持つ全タグに1回ずつカウントする(要件5「タグ別正答率」)。
 * 挑戦記録が無いタグは含まれない(呼び出し側は `?? 1`(未挑戦は正答率100%扱い)で
 * 補完することを想定。`puzzleWeight` 参照)。
 */
export function computeTagAccuracy(records: readonly PuzzleAttemptRecord[]): Map<PuzzleTag, number> {
  const counts = new Map<PuzzleTag, { attempts: number; correct: number }>()
  for (const record of records) {
    for (const tag of record.tags) {
      const cur = counts.get(tag) ?? { attempts: 0, correct: 0 }
      cur.attempts += 1
      if (record.correct) cur.correct += 1
      counts.set(tag, cur)
    }
  }
  const result = new Map<PuzzleTag, number>()
  for (const [tag, { attempts, correct }] of counts) {
    result.set(tag, attempts > 0 ? correct / attempts : 1)
  }
  return result
}

/** 重み付き抽選での最小重み(万一 `avgAccuracy` が1を超えるような異常値でも0や負値にならないための安全弁)。 */
const MIN_WEIGHT = 0.1

/**
 * 1問の出題重みを求める(要件5「弱点タグを優先的に出題する簡易ロジック」)。
 * タグを持たない問題(タグ判定が難しく未分類のもの)は基準重み `1` とする。
 * タグを持つ問題は `2 - 平均正答率` を重みとする: 平均正答率100%(未挑戦のタグを
 * 含む。`tagAccuracy` に無いタグは正答率100%扱い)なら基準重み `1` と同じになり、
 * 平均正答率が下がるほど重みが増えて(最大で2倍)優先的に選ばれやすくなる。
 */
export function puzzleWeight(puzzle: Puzzle, tagAccuracy: ReadonlyMap<PuzzleTag, number>): number {
  if (puzzle.tags.length === 0) return 1
  const avgAccuracy =
    puzzle.tags.reduce((sum, tag) => sum + (tagAccuracy.get(tag) ?? 1), 0) / puzzle.tags.length
  return Math.max(MIN_WEIGHT, 2 - avgAccuracy)
}

/**
 * `pool` から、弱点タグ(正答率が低いタグ)を含む問題ほど選ばれやすい重み付き抽選で
 * 1問選ぶ(要件5)。全問の重みが等しければ一様ランダムと同じ挙動になる。
 *
 * @throws {RangeError} `pool` が空配列の場合。
 */
export function pickWeightedPuzzle(
  pool: readonly Puzzle[],
  tagAccuracy: ReadonlyMap<PuzzleTag, number>,
  random: () => number = Math.random,
): Puzzle {
  if (pool.length === 0) {
    throw new RangeError('pickWeightedPuzzle: pool is empty')
  }
  const weights = pool.map((p) => puzzleWeight(p, tagAccuracy))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = random() * total
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i]!
    if (r <= 0) return pool[i]!
  }
  return pool[pool.length - 1]!
}

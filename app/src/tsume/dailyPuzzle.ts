/**
 * 詰めオセロ「今日の1問」を選ぶ(T028、要件6)。
 *
 * 日付シードから決定的に1問を選ぶロジック自体は T027 の `daily.ts`
 * (`dailyPuzzle`/`hashDateString`)に実装済みのため、本モジュールはそれに
 * 「今日の日付文字列を作る」処理を足しただけの薄いラッパー(T027の成果物
 * `daily.ts` はそのまま再利用し、変更しない)。
 */

import { dailyPuzzle } from './daily.ts'
import type { Puzzle } from './types.ts'

/**
 * `now` のローカル日付から `"YYYY-MM-DD"` 形式の文字列を作る。
 * `dailyPuzzle`/`hashDateString` の入力はただの文字列の一意性・決定性だけが
 * 要件のため、タイムゾーンを問わずローカル日付をそのまま使う。
 */
export function todaysDateString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = `${now.getMonth() + 1}`.padStart(2, '0')
  const d = `${now.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * `pool`(`app/public/puzzles.json` の全問題)から、今日の1問を決定的に選ぶ。
 * 同じ日付・同じプールであれば、アプリを開くたびに常に同じ問題が選ばれる。
 *
 * @throws {RangeError} `pool` が空配列の場合(`daily.ts` の `dailyPuzzle` 参照)。
 */
export function todaysPuzzle(pool: readonly Puzzle[], now: Date = new Date()): Puzzle {
  return dailyPuzzle(todaysDateString(now), pool)
}

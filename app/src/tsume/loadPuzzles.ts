/**
 * `public/puzzles.json`(T027で生成済みの `PuzzleFile`)をfetchして
 * 問題プール(`Puzzle[]`)として読み込む(T028)。
 *
 * `joseki/lookup.ts` の `loadJosekiDb` と同じ方針: 初回のみfetchし、
 * 以降は同じ `Promise` をキャッシュして返す(複数コンポーネントから
 * 呼ばれてもfetchは1回だけ発生する)。
 */

import type { PuzzleFile } from './types.ts'

let cachedPuzzles: Promise<PuzzleFile> | null = null

/**
 * `public/puzzles.json` をfetchして `PuzzleFile` として読み込む。
 *
 * `fetchImpl`/`basePath` はテスト用の差し替え口(本番はグローバルの `fetch` と
 * Viteが注入する `import.meta.env.BASE_URL` をそのまま使う。GitHub Pagesの
 * サブパス配信 `vite.config.ts` 参照)。
 */
export function loadPuzzles(
  fetchImpl: typeof fetch = fetch,
  basePath: string = import.meta.env.BASE_URL,
): Promise<PuzzleFile> {
  if (!cachedPuzzles) {
    cachedPuzzles = fetchImpl(`${basePath}puzzles.json`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`failed to fetch puzzles.json: ${res.status}`)
        }
        return res.json()
      })
      .then((data) => data as PuzzleFile)
      .catch((error: unknown) => {
        // 失敗時は次回呼び出しで再fetchできるよう、キャッシュに失敗した
        // Promiseを残さない。
        cachedPuzzles = null
        throw error instanceof Error ? error : new Error(String(error))
      })
  }
  return cachedPuzzles
}

/** テスト専用: `loadPuzzles` のキャッシュをリセットする。 */
export function resetPuzzlesCacheForTest(): void {
  cachedPuzzles = null
}

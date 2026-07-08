#!/usr/bin/env node
// T027: 詰めオセロ問題データ生成パイプラインのエントリポイント。
//
// 実行: リポジトリルートから
//   `node --experimental-strip-types puzzlegen/generate.ts`
// (`app/src/joseki/generate.ts` と同じ方針で、tsx/ts-node 等の追加依存を
// 増やさないため `node --experimental-strip-types` で直接実行する。
// `cargo` がPATHに通っている必要がある)。
//
// パイプライン全体の流れ(設計書§5.2、タスク仕様の「本タスクでのスコープ縮小」参照):
//   1. `engine/src/bin/puzzlegen.rs candidates` を空きマス数の階層ごとに呼び出し、
//      自己対戦で候補局面(空き6〜20)を集める。
//   2. `engine/src/bin/puzzlegen.rs evaluate` で全候補の全合法手を完全読みする
//      (候補1件ごとにタイムアウトガード付き。詳しくは同ファイル冒頭のコメント参照)。
//   3. `app/src/tsume/assemble.ts` の `assemblePuzzles` で、唯一解性フィルタ・
//      明確さフィルタ・難易度スコアリング・タグ付けを行う。
//   4. `app/public/puzzles.json` に書き出す。
//
// 空きマス数が大きい(19〜20)候補ほど完全読みのコストが跳ね上がるため、
// 階層(tier)ごとに集める候補数を減らしている(下記 `TIERS` 参照。
// 作業ログに実測時間を記載する)。

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assemblePuzzles } from '../app/src/tsume/assemble.ts'
import type { RawPuzzleGenCandidate } from '../app/src/tsume/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const outputPath = path.resolve(repoRoot, 'app/public/puzzles.json')

/**
 * 空きマス数の階層ごとの、`candidates`(空きマス数1値あたり)の目標収集数。
 * 空きが多いほど後段の完全読みが高コストになるため、階層が上がるほど
 * 目標数を減らしている(実測(本タスクの作業ログ参照)では空き18〜20は
 * 1候補あたり数十秒〜、稀にタイムアウト(90秒)する程度に重い)。
 */
const TIERS: ReadonlyArray<{ minEmpties: number; maxEmpties: number; targetPerEmpties: number }> = [
  { minEmpties: 6, maxEmpties: 14, targetPerEmpties: 30 },
  { minEmpties: 15, maxEmpties: 17, targetPerEmpties: 18 },
  { minEmpties: 18, maxEmpties: 20, targetPerEmpties: 8 },
]

const SEED = 20260709
const PER_CANDIDATE_TIMEOUT_SECS = 90
const OVERALL_TIMEOUT_SECS = 3600
const WORKERS = 12

function runPuzzlegenBin(subArgs: string[], stdin?: string): string {
  const result = spawnSync('cargo', ['run', '--release', '--bin', 'puzzlegen', '--', ...subArgs], {
    cwd: repoRoot,
    input: stdin,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 512,
    stdio: ['pipe', 'pipe', 'inherit'], // stderr(進捗ログ)はそのままコンソールに流す
  })
  if (result.status !== 0) {
    throw new Error(`puzzlegen ${subArgs[0]} failed with exit code ${result.status}`)
  }
  return result.stdout
}

function main(): void {
  const overallStart = Date.now()

  // --- 1. 候補局面生成(階層ごと) ---
  const allCandidates: Array<{ id: string; board: string; sideToMove: string; empties: number }> = []
  for (const tier of TIERS) {
    const tierStart = Date.now()
    const stdout = runPuzzlegenBin([
      'candidates',
      '--min-empties',
      String(tier.minEmpties),
      '--max-empties',
      String(tier.maxEmpties),
      '--target-per-empties',
      String(tier.targetPerEmpties),
      '--seed',
      String(SEED + tier.minEmpties),
    ])
    const parsed = JSON.parse(stdout) as typeof allCandidates
    allCandidates.push(...parsed)
    console.log(
      `[puzzlegen:generate] tier empties=${tier.minEmpties}-${tier.maxEmpties}: ${parsed.length} candidates in ${Date.now() - tierStart}ms`,
    )
  }
  // idの重複を避けるため、階層をまたいで通し番号に振り直す。
  const renumbered = allCandidates.map((c, i) => ({ ...c, id: `tsume-${i + 1}` }))
  console.log(
    `[puzzlegen:generate] total candidates: ${renumbered.length} (${Date.now() - overallStart}ms elapsed)`,
  )

  // --- 2. 完全読み評価 ---
  const evaluateStart = Date.now()
  const evalStdout = runPuzzlegenBin(
    [
      'evaluate',
      '--per-candidate-timeout-secs',
      String(PER_CANDIDATE_TIMEOUT_SECS),
      '--overall-timeout-secs',
      String(OVERALL_TIMEOUT_SECS),
      '--workers',
      String(WORKERS),
    ],
    JSON.stringify(renumbered),
  )
  const rawCandidates = JSON.parse(evalStdout) as RawPuzzleGenCandidate[]
  console.log(
    `[puzzlegen:generate] evaluated ${rawCandidates.length} of ${renumbered.length} candidates in ${Date.now() - evaluateStart}ms`,
  )

  // --- 3. フィルタ・難易度スコアリング・タグ付け ---
  const { puzzles, stats } = assemblePuzzles(rawCandidates)

  // --- 4. 出力 ---
  const output = {
    generatedAt: new Date().toISOString(),
    puzzles,
  }
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8')

  const byDifficulty = new Map<number, number>()
  for (const p of puzzles) {
    byDifficulty.set(p.difficulty, (byDifficulty.get(p.difficulty) ?? 0) + 1)
  }
  const byEmpties = new Map<number, number>()
  for (const p of puzzles) {
    byEmpties.set(p.empties, (byEmpties.get(p.empties) ?? 0) + 1)
  }

  console.log('--- summary ---')
  console.log(`generated candidates (requested): ${renumbered.length}`)
  console.log(`evaluated (not timed out): ${rawCandidates.length}`)
  console.log(`accepted puzzles: ${stats.acceptedCount}`)
  console.log(`rejected (uniqueness): ${stats.rejectedUniqueness}`)
  console.log(`rejected (clarity): ${stats.rejectedClarity}`)
  console.log(
    `pass rate (accepted / evaluated): ${((stats.acceptedCount / Math.max(1, rawCandidates.length)) * 100).toFixed(1)}%`,
  )
  console.log(`difficulty distribution: ${JSON.stringify(Object.fromEntries([...byDifficulty.entries()].sort()))}`)
  console.log(`empties distribution: ${JSON.stringify(Object.fromEntries([...byEmpties.entries()].sort((a, b) => a[0] - b[0])))}`)
  console.log(`total elapsed: ${Date.now() - overallStart}ms`)
  console.log(`output: ${outputPath}`)
}

main()

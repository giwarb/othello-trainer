#!/usr/bin/env node
// T151(拡張ブック生成 フェーズ2/2、ステージ3+4): `bookgen/opening-book-eval-input.json`
// (ステージ1、`generateOpeningBookEvalInput.ts`)+
// `bookgen/opening-book-eval-checkpoint.json`(ステージ2、
// `bench/edax-compare/eval_opening_book.py`のEdax level16評価結果)から、
// 悪手(ロス2石以上)を除外し、頻度比例で重み付けした対局専用の拡張定石ブックを
// `app/public/opening-book.json` に、除外手の警告レポートを
// `bookgen/opening-book-warnings.json` に書き出す。
//
// 実行: `npm run openingBook:build`(`app/package.json`参照、ステージ1・2が
// 事前に完了している必要がある)。`node --experimental-strip-types` で
// 直接実行する(`src/joseki/generate.ts` と同じ方針)。
//
// `bookgen/joseki-research.json`+`bookgen/wthor-lines.json`からDAGを
// 再構築する(ステージ1と同じ決定的な処理、入力ファイルが変わらない限り
// 同じ`db`になる)。ノードキーの整合性は`opening-book-eval-input.json`の
// `requests[]`(ノードキー・着手・positionKey)を突き合わせて検証する。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJosekiDb, serializeJosekiDb } from './buildDb.ts'
import { buildOpeningBookDb, type ExcludedBookMove } from './buildOpeningBook.ts'
import { collectMoveEvalRequests, type MoveEvalRequest } from './openingBookPositions.ts'
import type { RawJosekiFile } from './types.ts'

const LOSS_THRESHOLD = 2

interface EvalInputFile {
  readonly generatedAt: string
  readonly sourceLines: { readonly research: number; readonly wthor: number }
  readonly totalNodes: number
  readonly totalMoveRequests: number
  readonly uniquePositions: number
  readonly requests: readonly MoveEvalRequest[]
  readonly positions: readonly { readonly key: string; readonly board: string; readonly side: string }[]
}

interface EvalCheckpointFile {
  readonly meta: {
    readonly edaxLevel?: number
    readonly nTasks?: number
    readonly edaxExe?: string
    readonly edaxSha256?: string
    readonly startedAt?: string
    readonly updatedAt?: string
    readonly completedPositions?: number
    readonly totalPositions?: number
  }
  readonly results: Record<string, { readonly discDiff: number; readonly depth: number }>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const researchPath = path.resolve(__dirname, '../../../bookgen/joseki-research.json')
const wthorPath = path.resolve(__dirname, '../../../bookgen/wthor-lines.json')
const evalInputPath = path.resolve(__dirname, '../../../bookgen/opening-book-eval-input.json')
const checkpointPath = path.resolve(__dirname, '../../../bookgen/opening-book-eval-checkpoint.json')
const outputBookPath = path.resolve(__dirname, '../../public/opening-book.json')
const outputWarningsPath = path.resolve(__dirname, '../../../bookgen/opening-book-warnings.json')

const research = JSON.parse(readFileSync(researchPath, 'utf-8')) as RawJosekiFile
const wthor = JSON.parse(readFileSync(wthorPath, 'utf-8')) as RawJosekiFile
const rawLines = [...research.lines, ...wthor.lines]
const db = buildJosekiDb(rawLines)

const evalInput = JSON.parse(readFileSync(evalInputPath, 'utf-8')) as EvalInputFile
const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as EvalCheckpointFile

// ステージ1で再構築したdbと、eval-input.jsonが記録しているノード数・
// requests数が一致することを確認する(joseki-research.json/wthor-lines.jsonが
// ステージ1実行後に変更されていないかのガード)。
if (db.nodes.size !== evalInput.totalNodes) {
  throw new Error(
    `node count mismatch: rebuilt db has ${db.nodes.size} nodes but ${evalInputPath} recorded ` +
      `${evalInput.totalNodes} (bookgen/*.json may have changed since "npm run openingBook:collect" was last run; ` +
      're-run it before "npm run openingBook:build")',
  )
}

const { requests, positions } = collectMoveEvalRequests(db)
if (requests.length !== evalInput.requests.length || positions.length !== evalInput.positions.length) {
  throw new Error(
    `move request count mismatch: rebuilt (${requests.length} requests, ${positions.length} positions) vs ` +
      `${evalInputPath} (${evalInput.requests.length} requests, ${evalInput.positions.length} positions)`,
  )
}

const missingPositions = positions.filter((p) => checkpoint.results[p.key] === undefined)
if (missingPositions.length > 0) {
  throw new Error(
    `${missingPositions.length} of ${positions.length} positions have no Edax eval result in ${checkpointPath}. ` +
      `Run 'python bench/edax-compare/eval_opening_book.py' to completion first ` +
      `(first missing key: ${missingPositions[0].key}).`,
  )
}

const positionResults = new Map<string, number>(
  positions.map((p) => [p.key, checkpoint.results[p.key].discDiff]),
)

const { db: openingBookDb, excluded } = buildOpeningBookDb(db, requests, positionResults, LOSS_THRESHOLD)

writeFileSync(outputBookPath, `${JSON.stringify(serializeJosekiDb(openingBookDb), null, 2)}\n`, 'utf-8')

const namedExcluded = excluded.filter((e) => e.namedOrigin)
const sortedExcluded: readonly ExcludedBookMove[] = [...excluded].sort((a, b) => b.loss - a.loss)

interface OpeningBookWarningsReport {
  readonly $schemaNote: string
  readonly generatedAt: string
  readonly lossThreshold: number
  readonly edaxMeta: {
    readonly level: number | undefined
    readonly nTasks: number | undefined
    readonly edaxExe: string | undefined
    readonly edaxSha256: string | undefined
  }
  readonly totalNodesBeforeFilter: number
  readonly totalNodesAfterFilter: number
  readonly prunedUnreachableNodes: number
  readonly excludedMoveCount: number
  readonly excludedNamedOriginCount: number
  readonly excluded: readonly ExcludedBookMove[]
}

const warnings: OpeningBookWarningsReport = {
  $schemaNote:
    'T151: 対局専用拡張ブック(app/public/opening-book.json)のビルド時に除外された' +
    `bookMove一覧(その局面の全合法手中の最善値に対しロス${LOSS_THRESHOLD}石以上のもの)。` +
    'namedOrigin=trueは、除外された手を含むノードが手作業の命名済み定石' +
    '(bookgen/joseki-research.json由来)を1つ以上経由することを示す。',
  generatedAt: new Date().toISOString(),
  lossThreshold: LOSS_THRESHOLD,
  edaxMeta: {
    level: checkpoint.meta.edaxLevel,
    nTasks: checkpoint.meta.nTasks,
    edaxExe: checkpoint.meta.edaxExe,
    edaxSha256: checkpoint.meta.edaxSha256,
  },
  totalNodesBeforeFilter: db.nodes.size,
  totalNodesAfterFilter: openingBookDb.nodes.size,
  prunedUnreachableNodes: db.nodes.size - openingBookDb.nodes.size,
  excludedMoveCount: excluded.length,
  excludedNamedOriginCount: namedExcluded.length,
  excluded: sortedExcluded,
}

writeFileSync(outputWarningsPath, `${JSON.stringify(warnings, null, 2)}\n`, 'utf-8')

console.log(
  `[openingBook:build] ${db.nodes.size} nodes -> ${openingBookDb.nodes.size} nodes after filter+prune ` +
    `(pruned ${db.nodes.size - openingBookDb.nodes.size}), excluded ${excluded.length} bookMoves ` +
    `(${namedExcluded.length} from named lines) -> ${outputBookPath}, ${outputWarningsPath}`,
)

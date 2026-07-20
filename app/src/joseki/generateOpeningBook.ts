#!/usr/bin/env node
// T151(拡張ブック生成 フェーズ2/2、ステージ3+4): `bookgen/opening-book-eval-input.json`
// (ステージ1、`generateOpeningBookEvalInput.ts`)+
// `bookgen/opening-book-eval-checkpoint.json`(ステージ2、
// `bench/edax-compare/eval_opening_book.py`のEdax level16評価結果)から、
// 悪手(ロス2石以上)のうち自動抽出(WTHOR)ラインのみに乗る手を除外し
// (命名済みライン(`bookgen/joseki-research.json`由来112ライン)の実際の手順に
// 含まれる手はlossに関わらず除外しない、v2、2026-07-20仕様更新)、頻度比例で
// 重み付けした対局専用の拡張定石ブックを `app/public/opening-book.json` に、
// 高loss手(除外されたか保護され生存したかを問わない)の警告レポートを
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
import {
  buildOpeningBookDb,
  checkNamedLineSurvival,
  collectNamedLineMoveKeys,
  type HighLossBookMove,
} from './buildOpeningBook.ts'
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

// v2: 命名済みライン(joseki-research.json由来)の実際の手順に含まれる(ノード,着手)は
// lossに関わらず除外しない。
const protectedMoveKeys = collectNamedLineMoveKeys(research.lines)

const { db: openingBookDb, flagged } = buildOpeningBookDb(
  db,
  requests,
  positionResults,
  LOSS_THRESHOLD,
  protectedMoveKeys,
)

writeFileSync(outputBookPath, `${JSON.stringify(serializeJosekiDb(openingBookDb), null, 2)}\n`, 'utf-8')

const excludedFromBook = flagged.filter((f) => f.excludedFromBook)
const keptDespiteHighLoss = flagged.filter((f) => !f.excludedFromBook)
const sortedFlagged: readonly HighLossBookMove[] = [...flagged].sort((a, b) => b.loss - a.loss)

const namedLineSurvival = checkNamedLineSurvival(research.lines, openingBookDb)
const fullySurvivedLines = namedLineSurvival.filter((r) => r.fullySurvived)
const notFullySurvivedLines = namedLineSurvival.filter((r) => !r.fullySurvived)

if (notFullySurvivedLines.length > 0) {
  // v2のポリシー(命名済みラインの手は除外しない)が正しく機能していれば
  // これは理論上発生しないはずだが、実装バグの検出のためビルドを失敗させる
  // (2026-07-20のオーケストレーター指摘: 命名済み112/112ラインの全生存を保証する)。
  throw new Error(
    `${notFullySurvivedLines.length} named line(s) did not fully survive filtering: ` +
      notFullySurvivedLines.map((r) => `${r.name} (${r.survivedMoves}/${r.totalMoves})`).join(', '),
  )
}

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
  readonly flaggedMoveCount: number
  readonly excludedFromBookCount: number
  readonly keptDespiteHighLossCount: number
  readonly namedLines: {
    readonly total: number
    readonly fullySurvived: number
  }
  readonly flagged: readonly HighLossBookMove[]
}

const warnings: OpeningBookWarningsReport = {
  $schemaNote:
    'T151 v2(2026-07-20仕様更新): 対局専用拡張ブック(app/public/opening-book.json)のビルド時に' +
    `loss(その局面の全合法手中の最善値との差)が${LOSS_THRESHOLD}石以上だったbookMove一覧。` +
    'protectedByNamedLine=trueは、この(ノード,着手)が命名済みライン(bookgen/joseki-research.json由来' +
    '112ライン)の実際の手順に含まれることを示し、その場合lossに関わらずexcludedFromBook=falseのまま' +
    '(除外されず)opening-book.jsonに残る。excludedFromBook=trueは自動抽出(WTHOR)ラインのみに乗る手が' +
    '実際に除外されたことを示す。namedOriginは「このノードに命名済みラインが合流している」ゆるい目印で、' +
    'protectedByNamedLineほど厳密ではない(そのノードの別の手が命名済みラインの手、という場合もtrueになる)。',
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
  flaggedMoveCount: flagged.length,
  excludedFromBookCount: excludedFromBook.length,
  keptDespiteHighLossCount: keptDespiteHighLoss.length,
  namedLines: {
    total: namedLineSurvival.length,
    fullySurvived: fullySurvivedLines.length,
  },
  flagged: sortedFlagged,
}

writeFileSync(outputWarningsPath, `${JSON.stringify(warnings, null, 2)}\n`, 'utf-8')

console.log(
  `[openingBook:build] ${db.nodes.size} nodes -> ${openingBookDb.nodes.size} nodes after filter+prune ` +
    `(pruned ${db.nodes.size - openingBookDb.nodes.size}), flagged ${flagged.length} high-loss bookMoves ` +
    `(excluded ${excludedFromBook.length}, kept despite high loss ${keptDespiteHighLoss.length}), ` +
    `named lines fully survived ${fullySurvivedLines.length}/${namedLineSurvival.length} ` +
    `-> ${outputBookPath}, ${outputWarningsPath}`,
)

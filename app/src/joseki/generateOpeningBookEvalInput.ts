#!/usr/bin/env node
// T151(拡張ブック生成 フェーズ2/2、ステージ1): `bookgen/joseki-research.json`
// (112ライン)+`bookgen/wthor-lines.json`(251ライン、T150)を`buildJosekiDb`で
// 統合DAG化し、全ノード・全合法手についてのEdax評価依頼を
// `bookgen/opening-book-eval-input.json` に書き出す。
//
// 実行: `npm run openingBook:collect`(`app/package.json`参照)。
// 出力は次のステージ(`bench/edax-compare/eval_opening_book.py`、Edax評価+
// チェックポイント)の入力になる。`node --experimental-strip-types` で
// 直接実行する(`src/joseki/generate.ts` と同じ方針)。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJosekiDb } from './buildDb.ts'
import { collectMoveEvalRequests } from './openingBookPositions.ts'
import type { RawJosekiFile } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const researchPath = path.resolve(__dirname, '../../../bookgen/joseki-research.json')
const wthorPath = path.resolve(__dirname, '../../../bookgen/wthor-lines.json')
const outputPath = path.resolve(__dirname, '../../../bookgen/opening-book-eval-input.json')

const research = JSON.parse(readFileSync(researchPath, 'utf-8')) as RawJosekiFile
const wthor = JSON.parse(readFileSync(wthorPath, 'utf-8')) as RawJosekiFile

const rawLines = [...research.lines, ...wthor.lines]
const db = buildJosekiDb(rawLines)
const { requests, positions } = collectMoveEvalRequests(db)

const output = {
  $schemaNote:
    'T151: 拡張定石ブック(joseki-research.json+wthor-lines.json統合DAG)の全ノード' +
    '・全合法手についてのEdax評価依頼。requests[]がノード×合法手の全件、' +
    'positions[]がEdaxに実際に投げる着手後局面(positionKeyで重複排除済み)。' +
    'bench/edax-compare/eval_opening_book.py が positions[] を読み評価する。',
  generatedAt: new Date().toISOString(),
  sourceLines: { research: research.lines.length, wthor: wthor.lines.length },
  totalNodes: db.nodes.size,
  totalMoveRequests: requests.length,
  uniquePositions: positions.length,
  requests,
  positions,
}

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8')

console.log(
  `[openingBook:collect] ${rawLines.length} lines (research=${research.lines.length}, wthor=${wthor.lines.length}) ` +
    `-> ${db.nodes.size} nodes -> ${requests.length} move requests -> ${positions.length} unique positions -> ${outputPath}`,
)

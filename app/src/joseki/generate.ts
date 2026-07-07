#!/usr/bin/env node
// `bookgen/joseki-research.json` を読み込み、`buildJosekiDb` でDAGを構築して
// `app/public/joseki.json` に書き出すビルドスクリプト。
//
// 実行: `npm run joseki:build` (`app/package.json` 参照)。
// `node --experimental-strip-types` で直接実行する(tsx/ts-node 等の追加
// 依存を増やさないため。`app/src/engine/build-wasm.mjs` と同様、実行時の
// カレントディレクトリに依存せずパスを解決する)。
//
// 出力(`app/public/joseki.json`)はアプリが `fetch('/joseki.json')` で
// 読み込む成果物であり、`bookgen/joseki-research.json` が更新されたら
// このスクリプトを再実行して再生成する(自動生成物だが、後続タスクが
// すぐ使えるようリポジトリにコミットしておく)。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJosekiDb, serializeJosekiDb } from './buildDb.ts'
import type { RawJosekiFile } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const inputPath = path.resolve(__dirname, '../../../bookgen/joseki-research.json')
const outputPath = path.resolve(__dirname, '../../public/joseki.json')

const raw = JSON.parse(readFileSync(inputPath, 'utf-8')) as RawJosekiFile
const db = buildJosekiDb(raw.lines)
const serialized = serializeJosekiDb(db)

writeFileSync(outputPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf-8')

console.log(
  `[joseki:build] ${raw.lines.length} lines -> ${db.nodes.size} nodes -> ${outputPath}`,
)

import { readFile } from 'node:fs/promises'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const wasm = await readFile(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })

const request = JSON.stringify({
  id: 1,
  cmd: 'analyze',
  board: {
    black: '0x0000000810000000',
    white: '0x0000001008000000',
    turn: 'black',
  },
  limit: { depth: 20, timeMs: 1500, maxNodes: 2048, exactFromEmpties: 10 },
})

const first = JSON.parse(new Engine().analyze(request))
const second = JSON.parse(new Engine().analyze(request))

if (first.error || second.error || first.pv[0] !== second.pv[0] || first.score.type !== second.score.type || first.score.discDiff !== second.score.discDiff) {
  throw new Error(`node-budget WASM determinism check failed: ${JSON.stringify({ first, second })}`)
}

console.log(`[wasm-test] deterministic node-budget result: ${first.pv[0]} (${first.score.discDiff})`)

import { readFile } from 'node:fs/promises'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const wasm = await readFile(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
const weights = await readFile(new URL('../public/pattern_v3.bin', import.meta.url))

const request = JSON.stringify({
  id: 1,
  cmd: 'analyze',
  board: {
    black: '0x1030100004080000',
    white: '0x0000241C18100000',
    turn: 'black',
  },
  limit: { depth: 12, timeMs: 1500, maxNodes: 160000, exactFromEmpties: 16 },
})

const unrelatedRequest = JSON.stringify({
  id: 2,
  cmd: 'analyze',
  board: {
    black: '0x0000000810000000',
    white: '0x0000001008000000',
    turn: 'black',
  },
  limit: { depth: 6, timeMs: 100, exactFromEmpties: 10 },
  allMoves: true,
})

const engine = new Engine()
engine.load_pattern_weights(weights)

const first = JSON.parse(engine.analyze(request))
const second = JSON.parse(engine.analyze(request))
const unrelated = JSON.parse(engine.analyze(unrelatedRequest))
const afterUnrelated = JSON.parse(engine.analyze(request))

function deterministicFields(response) {
  return {
    move: response.pv?.[0],
    score: response.score,
    depth: response.depth,
    nodes: response.nodes,
  }
}

const expected = JSON.stringify(deterministicFields(first))
if (
  first.error
  || second.error
  || unrelated.error
  || afterUnrelated.error
  || JSON.stringify(deterministicFields(second)) !== expected
  || JSON.stringify(deterministicFields(afterUnrelated)) !== expected
) {
  throw new Error(`node-budget WASM determinism check failed: ${JSON.stringify({ first, second, unrelated, afterUnrelated })}`)
}

console.log(`[wasm-test] deterministic node-budget result: ${first.pv[0]} (${first.score.discDiff}), depth ${first.depth}, nodes ${first.nodes}`)

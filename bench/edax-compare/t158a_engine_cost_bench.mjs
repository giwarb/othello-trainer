// T158a WASM cost benchmark. Requires a release wasm-pack build and two model paths.
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Engine, initSync } from '../../app/src/engine/pkg/engine.js'

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath) {
  throw new Error('usage: node t158a_engine_cost_bench.mjs BASELINE_PWV3 ZERO_PWV4')
}

const wasm = await readFile(new URL('../../app/src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
const baselineBytes = await readFile(baselinePath)
const candidateBytes = await readFile(candidatePath)
const repetitions = 7

function engineWith(bytes) {
  const engine = new Engine()
  engine.load_pattern_weights(bytes)
  return engine
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

function summary(base, candidate) {
  return {
    baselineMedianMs: median(base),
    baselineRangeMs: [Math.min(...base), Math.max(...base)],
    candidateMedianMs: median(candidate),
    candidateRangeMs: [Math.min(...candidate), Math.max(...candidate)],
    ratio: median(base) / median(candidate),
    baselineRawMs: base,
    candidateRawMs: candidate,
  }
}

function deterministicFields(response) {
  return {
    move: response.pv?.[0] ?? null,
    score: response.score,
    depth: response.depth,
    nodes: response.nodes,
    pv: response.pv,
    nodeLimitHit: response.nodeLimitHit,
    timedOut: response.timedOut,
  }
}

const board = {
  black: '0x1030100004080000',
  white: '0x0000241C18100000',
  turn: 'black',
}
const fixedRequest = JSON.stringify({
  id: 1,
  cmd: 'analyze',
  board,
  limit: { depth: 9, exactFromEmpties: 0 },
})
const productionRequest = JSON.stringify({
  id: 2,
  cmd: 'analyze',
  board,
  limit: { depth: 12, timeMs: 1500, maxNodes: 160000, exactFromEmpties: 16 },
})

function evalOnce(bytes) {
  const engine = engineWith(bytes)
  try {
    const result = JSON.parse(engine.benchmark_pattern_eval(50_000))
    return Number(BigInt(result.elapsedNs)) / 1e6
  } finally {
    engine.free()
  }
}

function searchOnce(bytes, request) {
  const engine = engineWith(bytes)
  try {
    const start = performance.now()
    const response = JSON.parse(engine.analyze(request))
    const elapsed = performance.now() - start
    if (response.error) throw new Error(response.error)
    return { elapsed, response }
  } finally {
    engine.free()
  }
}

// Warm-up both code paths before measurements.
evalOnce(baselineBytes)
evalOnce(candidateBytes)
searchOnce(baselineBytes, fixedRequest)
searchOnce(candidateBytes, fixedRequest)

const microBase = []
const microCandidate = []
const fixedBase = []
const fixedCandidate = []
const productionBase = []
const productionCandidate = []
let fixedReference
let productionReference

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  const order = repetition % 2 === 0
    ? [[baselineBytes, 'base'], [candidateBytes, 'candidate']]
    : [[candidateBytes, 'candidate'], [baselineBytes, 'base']]
  const round = {}
  for (const [bytes, label] of order) {
    const micro = evalOnce(bytes)
    const fixed = searchOnce(bytes, fixedRequest)
    const production = searchOnce(bytes, productionRequest)
    round[label] = { micro, fixed, production }
  }
  const baseFixed = deterministicFields(round.base.fixed.response)
  const candidateFixed = deterministicFields(round.candidate.fixed.response)
  if (JSON.stringify(baseFixed) !== JSON.stringify(candidateFixed)) {
    throw new Error(`zero-feature fixed-depth mismatch: ${JSON.stringify({ baseFixed, candidateFixed })}`)
  }
  fixedReference ??= baseFixed
  if (JSON.stringify(fixedReference) !== JSON.stringify(baseFixed)) {
    throw new Error('fixed-depth result is not deterministic across fresh engines')
  }
  const baseProduction = deterministicFields(round.base.production.response)
  const candidateProduction = deterministicFields(round.candidate.production.response)
  if (JSON.stringify(baseProduction) !== JSON.stringify(candidateProduction)) {
    throw new Error(`zero-feature production mismatch: ${JSON.stringify({ baseProduction, candidateProduction })}`)
  }
  productionReference ??= baseProduction
  microBase.push(round.base.micro)
  microCandidate.push(round.candidate.micro)
  fixedBase.push(round.base.fixed.elapsed)
  fixedCandidate.push(round.candidate.fixed.elapsed)
  productionBase.push(round.base.production.elapsed)
  productionCandidate.push(round.candidate.production.elapsed)
  console.error(`[t158a wasm] repetition=${repetition + 1} complete`)
}

const expectedFixed = { move: 'd6', score: { type: 'midgame', discDiff: 11.09 }, depth: 9, nodes: 183318 }
for (const [key, value] of Object.entries(expectedFixed)) {
  if (JSON.stringify(fixedReference[key]) !== JSON.stringify(value)) {
    throw new Error(`native/WASM fixture mismatch for ${key}: ${JSON.stringify(fixedReference[key])}`)
  }
}

console.log(JSON.stringify({
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  repetitions,
  micro: { evaluations: 150000, ...summary(microBase, microCandidate) },
  fixedDepth: { result: fixedReference, ...summary(fixedBase, fixedCandidate) },
  production160k: { result: productionReference, ...summary(productionBase, productionCandidate) },
}, null, 2))

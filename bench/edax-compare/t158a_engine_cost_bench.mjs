// T158a stratified WASM cost benchmark. Requires a release wasm-pack build.
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Engine, initSync } from '../../app/src/engine/pkg/engine.js'

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath) throw new Error('expected baseline and candidate paths')
const wasm = await readFile(new URL('../../app/src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
const baselineBytes = await readFile(baselinePath)
const candidateBytes = await readFile(candidatePath)
const positions = JSON.parse(await readFile(
  new URL('./t158a_engine_cost_positions.json', import.meta.url), 'utf8'))
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
    baselineMedianMs: median(base), baselineRangeMs: [Math.min(...base), Math.max(...base)],
    candidateMedianMs: median(candidate), candidateRangeMs: [Math.min(...candidate), Math.max(...candidate)],
    ratio: median(base) / median(candidate), baselineRawMs: base, candidateRawMs: candidate,
  }
}

function deterministicFields(response) {
  return {
    move: response.pv?.[0] ?? null, score: response.score, depth: response.depth,
    nodes: response.nodes, pv: response.pv, nodeLimitHit: response.nodeLimitHit,
    timedOut: response.timedOut,
  }
}

function request(position, production) {
  return JSON.stringify({
    id: production ? 2 : 1,
    cmd: 'analyze',
    board: { black: position.black, white: position.white, turn: position.turn },
    limit: production
      ? { depth: 12, timeMs: 1500, maxNodes: 160000, exactFromEmpties: 16 }
      : { depth: 9, exactFromEmpties: 0 },
  })
}

function evalOnce(bytes) {
  const engine = engineWith(bytes)
  try {
    const result = JSON.parse(engine.benchmark_pattern_eval(50000))
    return Number(BigInt(result.elapsedNs)) / 1e6
  } finally { engine.free() }
}

function searchOnce(bytes, requestJson) {
  const engine = engineWith(bytes)
  try {
    const start = performance.now()
    const response = JSON.parse(engine.analyze(requestJson))
    const elapsed = performance.now() - start
    if (response.error) throw new Error(response.error)
    return { elapsed, response }
  } finally { engine.free() }
}

function runModel(bytes) {
  return {
    micro: evalOnce(bytes),
    fixed: positions.map(position => searchOnce(bytes, request(position, false))),
    production: positions.map(position => searchOnce(bytes, request(position, true))),
  }
}

function sameResult(reference, current, label) {
  if (JSON.stringify(reference) !== JSON.stringify(current)) {
    throw new Error(`${label} is not deterministic: ${JSON.stringify({ reference, current })}`)
  }
}

runModel(baselineBytes)
runModel(candidateBytes)
const microBase = []
const microCandidate = []
const fixedBase = positions.map(() => [])
const fixedCandidate = positions.map(() => [])
const productionBase = positions.map(() => [])
const productionCandidate = positions.map(() => [])
let fixedReference
let productionReference

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  let baseRun
  let candidateRun
  if (repetition % 2 === 0) {
    baseRun = runModel(baselineBytes)
    candidateRun = runModel(candidateBytes)
  } else {
    candidateRun = runModel(candidateBytes)
    baseRun = runModel(baselineBytes)
  }
  const currentFixed = []
  const currentProduction = []
  for (let i = 0; i < positions.length; i += 1) {
    const baseFixed = deterministicFields(baseRun.fixed[i].response)
    const candidateFixed = deterministicFields(candidateRun.fixed[i].response)
    sameResult(baseFixed, candidateFixed, `fixed ${positions[i].id}`)
    const baseProduction = deterministicFields(baseRun.production[i].response)
    const candidateProduction = deterministicFields(candidateRun.production[i].response)
    sameResult(baseProduction, candidateProduction, `production ${positions[i].id}`)
    currentFixed.push(baseFixed)
    currentProduction.push(baseProduction)
    fixedBase[i].push(baseRun.fixed[i].elapsed)
    fixedCandidate[i].push(candidateRun.fixed[i].elapsed)
    productionBase[i].push(baseRun.production[i].elapsed)
    productionCandidate[i].push(candidateRun.production[i].elapsed)
  }
  if (fixedReference) sameResult(fixedReference, currentFixed, 'fixed corpus')
  else fixedReference = currentFixed
  if (productionReference) sameResult(productionReference, currentProduction, 'production corpus')
  else productionReference = currentProduction
  microBase.push(baseRun.micro)
  microCandidate.push(candidateRun.micro)
  console.error(`[t158a wasm] repetition=${repetition + 1} complete`)
}

function aggregate(matrix, indices) {
  return Array.from({ length: repetitions }, (_, repetition) =>
    indices.reduce((total, i) => total + matrix[i][repetition], 0))
}

const all = positions.map((_, i) => i)
const buckets = ['45-52', '37-44', '29-36', '21-28'].map(bucket => {
  const indices = positions.flatMap((position, i) => position.bucket === bucket ? [i] : [])
  const fixedBaseBucket = aggregate(fixedBase, indices)
  const fixedCandidateBucket = aggregate(fixedCandidate, indices)
  const productionBaseBucket = aggregate(productionBase, indices)
  const productionCandidateBucket = aggregate(productionCandidate, indices)
  return {
    bucket,
    fixedDepth: summary(fixedBaseBucket, fixedCandidateBucket),
    production160k: summary(productionBaseBucket, productionCandidateBucket),
    dominantLimits: indices.map(i => productionReference[i].timedOut
      ? 'time' : productionReference[i].nodes >= 160000 ? 'nodes' : 'depth'),
  }
})

const fixtures = positions.map((position, i) => ({
  id: position.id, bucket: position.bucket,
  fixedDepth: fixedReference[i], production160k: productionReference[i],
}))

console.log(JSON.stringify({
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  repetitions,
  micro: { evaluations: 150000, ...summary(microBase, microCandidate) },
  fixedDepthAggregate: summary(aggregate(fixedBase, all), aggregate(fixedCandidate, all)),
  production160kAggregate: summary(
    aggregate(productionBase, all), aggregate(productionCandidate, all)),
  buckets,
  fixtures,
}, null, 2))

// T167要件2/7: WASMビルド経由でPWV6(pattern_v5.bin)が読めてscalar特徴が
// 有効になることの確認、および数局面でのネイティブ評価との一致確認
// (取り違え防止)。T158a/T163のWASM検証・`test-node-budget-wasm.mjs`の前例に倣う。
import { readFile } from 'node:fs/promises'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const wasm = await readFile(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
const weights = await readFile(new URL('../public/pattern_v5.bin', import.meta.url))

// マジックバイトの確認(PWV6であること、取り違え防止の第一段階)。
const magic = Buffer.from(weights.slice(0, 4)).toString('ascii')
if (magic !== 'PWV6') {
  throw new Error(`expected PWV6 magic bytes, got ${magic}`)
}

const engine = new Engine()
engine.load_pattern_weights(weights)

// (2) scalar特徴が有効であることの確認(benchmark_pattern_evalが報告する
// scalarFeaturesPresent/scalarFeaturesEnabled、T158a由来のAPI)。
const bench = JSON.parse(engine.benchmark_pattern_eval(1))
if (bench.scalarFeaturesPresent !== true || bench.scalarFeaturesEnabled !== true) {
  throw new Error(`expected scalar features present+enabled, got ${JSON.stringify(bench)}`)
}
console.log(`[pattern_v5 wasm check] magic=${magic} scalarFeaturesPresent=${bench.scalarFeaturesPresent} scalarFeaturesEnabled=${bench.scalarFeaturesEnabled}`)

// (7) 数局面でネイティブ評価と一致することの確認(depth=0, exactFromEmpties=0
// の静的評価のみ。native側はeval_cliで同じ局面・同じ重みを評価し、
// discDiffが完全一致することを比較する。比較は別スクリプト
// `compare-pattern-v5-native.mjs` 相当の手順で行うため、ここでは
// WASM側の値をJSON出力するだけに留める)。
// 既存の確立済みフィクスチャを再利用する(自作の局面を新規に作らない):
// initial/midgame-a/midgame-bは`engine/src/lib.rs`の`benchmark_pattern_eval`と
// 同じ3局面、real-game-*は`bench/edax-compare/t158a_engine_cost_positions.json`
// (T158a、実対局由来のmpc calibration局面)からそのまま採った2局面。
const positions = [
  { id: 'initial', black: '0x0000000810000000', white: '0x0000001008000000', turn: 'black' },
  { id: 'midgame-a', black: '0x0000081c34200000', white: '0x00001020081c0000', turn: 'black' },
  { id: 'midgame-b', black: '0x1030100004080000', white: '0x0000241c18100000', turn: 'white' },
  { id: 'real-game-45-52', black: '0x001418107c100000', white: '0x0000206c00200000', turn: 'white' },
  { id: 'real-game-37-44', black: '0x0000007e34580000', white: '0x00083c010a060000', turn: 'black' },
]

const results = positions.map((position) => {
  const request = JSON.stringify({
    id: 1,
    cmd: 'analyze',
    board: { black: position.black, white: position.white, turn: position.turn },
    limit: { depth: 0, exactFromEmpties: 0 },
  })
  const response = JSON.parse(engine.analyze(request))
  if (response.error) {
    throw new Error(`analyze error for ${position.id}: ${response.error}`)
  }
  return { id: position.id, ...position, discDiff: response.score.discDiff }
})

console.log(JSON.stringify({ magic, scalarFeaturesPresent: bench.scalarFeaturesPresent, scalarFeaturesEnabled: bench.scalarFeaturesEnabled, checksumBits: bench.checksumBits, results }, null, 2))
engine.free()

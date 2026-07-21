// T171要件2/7: WASMビルド経由でPWV6(pattern_v6.bin、D1候補=V3+corner5x2、
// 46インスタンス/11クラス)が読めてscalar特徴が有効になることの確認、
// および数局面でのネイティブ評価との一致確認(取り違え防止)。
// T158a/T163/T167のWASM検証・`test-node-budget-wasm.mjs`の前例に倣う。
//
// T167時点の`test-pattern-v5-wasm.mjs`からリネーム・更新(v5→v6配線に伴う
// 本番追従)。v5はcorner5x2を含まないV3+B3スカラー(38インスタンス)形式
// だったため、マジックバイト確認だけでは「新しいパターン形状(corner5x2)が
// 正しく読み込まれた」ことまでは確認できていなかった。本バージョンでは
// ヘッダーの生バイトを直接パースしてインスタンス数・クラス数・scalar特徴数
// も検証し、期待どおりの形状(46/11/2)であることを確認する
// (`engine/src/pattern_eval.rs`の`to_bytes_scalar_extended`が書き出す
// ヘッダーレイアウト: magic(4)+version(4)+reserved(4)+num_stages(4)+
// stage_empty_divisor(4)+instances(4)+classes(4)+scalarFeatureCount(4)+
// schema_hash(32)+...。engine側を変更せず読むだけなので、engine/srcには
// 手を入れていない)。
import { readFile } from 'node:fs/promises'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const wasm = await readFile(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
const weights = await readFile(new URL('../public/pattern_v6.bin', import.meta.url))

// マジックバイトの確認(PWV6であること、取り違え防止の第一段階)。
const magic = Buffer.from(weights.slice(0, 4)).toString('ascii')
if (magic !== 'PWV6') {
  throw new Error(`expected PWV6 magic bytes, got ${magic}`)
}

// ヘッダーの生バイトからインスタンス数・クラス数・scalar特徴数を直接読む
// (engineのAPIを介さない独立した確認。D1候補は46インスタンス/11クラス/
// scalar特徴2個のはず)。
const instances = weights.readUInt32LE(20)
const classes = weights.readUInt32LE(24)
const scalarFeatureCount = weights.readUInt32LE(28)
const EXPECTED_INSTANCES = 46
const EXPECTED_CLASSES = 11
const EXPECTED_SCALAR_FEATURE_COUNT = 2
if (
  instances !== EXPECTED_INSTANCES ||
  classes !== EXPECTED_CLASSES ||
  scalarFeatureCount !== EXPECTED_SCALAR_FEATURE_COUNT
) {
  throw new Error(
    `expected instances=${EXPECTED_INSTANCES} classes=${EXPECTED_CLASSES} ` +
      `scalarFeatureCount=${EXPECTED_SCALAR_FEATURE_COUNT} (D1=V3+corner5x2 shape), got ` +
      `instances=${instances} classes=${classes} scalarFeatureCount=${scalarFeatureCount}`,
  )
}

const engine = new Engine()
engine.load_pattern_weights(weights)

// (2) scalar特徴が有効であることの確認(benchmark_pattern_evalが報告する
// scalarFeaturesPresent/scalarFeaturesEnabled、T158a由来のAPI)。
const bench = JSON.parse(engine.benchmark_pattern_eval(1))
if (bench.scalarFeaturesPresent !== true || bench.scalarFeaturesEnabled !== true) {
  throw new Error(`expected scalar features present+enabled, got ${JSON.stringify(bench)}`)
}
console.log(
  `[pattern_v6 wasm check] magic=${magic} instances=${instances} classes=${classes} ` +
    `scalarFeatureCount=${scalarFeatureCount} scalarFeaturesPresent=${bench.scalarFeaturesPresent} ` +
    `scalarFeaturesEnabled=${bench.scalarFeaturesEnabled}`,
)

// (7) 数局面でネイティブ評価と一致することの確認(depth=0, exactFromEmpties=0
// の静的評価のみ)。既存の確立済みフィクスチャを再利用する(自作の局面を
// 新規に作らない): initial/midgame-a/midgame-bは`engine/src/lib.rs`の
// `benchmark_pattern_eval`と同じ3局面、real-game-*は
// `bench/edax-compare/t158a_engine_cost_positions.json`(T158a、実対局由来の
// mpc calibration局面)からそのまま採った2局面。
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

console.log(JSON.stringify({ magic, instances, classes, scalarFeatureCount, scalarFeaturesPresent: bench.scalarFeaturesPresent, scalarFeaturesEnabled: bench.scalarFeaturesEnabled, checksumBits: bench.checksumBits, results }, null, 2))
engine.free()

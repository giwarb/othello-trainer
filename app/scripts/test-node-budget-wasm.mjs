import { readFile } from 'node:fs/promises'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const wasm = await readFile(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url))
initSync({ module: wasm })
// T170(T167レビュー中1): 本番配線がpattern_v4.bin→pattern_v5.bin(T167)に
// 切り替わったのに、このビルドゲートは旧v4を参照したままだった
// (=本番構成を検証していないゲートになっていた)。現本番pattern_v5.binを
// 参照するよう更新した。本スクリプトは固定goldenを持たず(`first`自身を
// 基準に`second`/`afterUnrelated`との一致を見る自己参照的な決定性チェック)、
// 重みファイルの中身が変わっても再取得すべき外部golden値は無い
// (作業ログ参照)。
//
// T171: 本番配線がpattern_v5.bin→pattern_v6.bin(D1候補、T168/T169/T171)に
// 切り替わったため、本ゲートも本番追従でv6を参照するよう更新した。上記の
// 「固定goldenを持たない自己参照的な決定性チェック」という設計はそのまま
// なので、今回もgoldenの再取得は不要(理由はT170と同じ)。
const weights = await readFile(new URL('../public/pattern_v6.bin', import.meta.url))

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

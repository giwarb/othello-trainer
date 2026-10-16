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
//
// T205: 本番配線がpattern_v6.bin→pattern_v7.binに切り替わったため本番追従。
// 決定性チェックは自己参照のまま。問題86の開始局面の最善手の期待値だけは
// 重み依存の固定値なので、v7での値(e1。Edax 4.6 depth14 無選択でも最善手e1)
// に更新した。
const weights = await readFile(new URL('../public/pattern_v7.bin', import.meta.url))

const MIDGAME_LIMIT = { depth: 10, timeMs: 10_000, maxNodes: 2_400_000, exactFromEmpties: 24 }
const PROBLEM_86_START = {
  black: 0x0000040c0c2c0000n,
  white: 0x0008303030101800n,
}

function squareOf(notation) {
  return (Number(notation[1]) - 1) * 8 + notation.charCodeAt(0) - 97
}

function applyMove(board, side, notation) {
  const square = squareOf(notation)
  const row = Math.floor(square / 8)
  const col = square % 8
  const mine = side === 'black' ? board.black : board.white
  const theirs = side === 'black' ? board.white : board.black
  let flips = 0n
  for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
    let r = row + dr
    let c = col + dc
    let captured = 0n
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && (theirs & (1n << BigInt(r * 8 + c))) !== 0n) {
      captured |= 1n << BigInt(r * 8 + c)
      r += dr
      c += dc
    }
    if (captured !== 0n && r >= 0 && r < 8 && c >= 0 && c < 8 && (mine & (1n << BigInt(r * 8 + c))) !== 0n) {
      flips |= captured
    }
  }
  if (flips === 0n) throw new Error(`illegal move ${notation}`)
  const placed = 1n << BigInt(square)
  const nextMine = mine | placed | flips
  const nextTheirs = theirs & ~flips
  return side === 'black'
    ? { black: nextMine, white: nextTheirs }
    : { black: nextTheirs, white: nextMine }
}

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

const allMovesRequest = JSON.stringify({
  id: 3,
  cmd: 'analyze',
  board: {
    black: '0x0000000810000000',
    white: '0x0000001008000000',
    turn: 'black',
  },
  limit: { depth: 12, timeMs: 10_000, maxNodes: 40_000, exactFromEmpties: 16 },
  allMoves: true,
})

const allMovesMoreTimeRequest = JSON.stringify({
  id: 4,
  cmd: 'analyze',
  board: {
    black: '0x0000000810000000',
    white: '0x0000001008000000',
    turn: 'black',
  },
  limit: { depth: 12, timeMs: 20_000, maxNodes: 40_000, exactFromEmpties: 16 },
  allMoves: true,
})

const engine = new Engine()
engine.load_pattern_weights(weights)

const first = JSON.parse(engine.analyze(request))
const second = JSON.parse(engine.analyze(request))
const unrelated = JSON.parse(engine.analyze(unrelatedRequest))
const afterUnrelated = JSON.parse(engine.analyze(request))
const allMovesFirst = JSON.parse(engine.analyze(allMovesRequest))
const allMovesSecond = JSON.parse(engine.analyze(allMovesRequest))
const allMovesAfterUnrelated = JSON.parse(engine.analyze(allMovesMoreTimeRequest))

function deterministicFields(response) {
  return {
    move: response.pv?.[0],
    score: response.score,
    depth: response.depth,
    nodes: response.nodes,
  }
}

function deterministicAllMovesFields(response) {
  return {
    moves: response.moves,
    pv: response.pv,
    score: response.score,
    depth: response.depth,
  }
}

function analyzeAll(engine, board, side, id) {
  return JSON.parse(engine.analyze(JSON.stringify({
    id,
    cmd: 'analyze',
    board: {
      black: `0x${board.black.toString(16)}`,
      white: `0x${board.white.toString(16)}`,
      turn: side,
    },
    limit: MIDGAME_LIMIT,
    allMoves: true,
  })))
}

function runProblem86Attempt(engine, playerMoves, firstId) {
  let board = PROBLEM_86_START
  let currentRoot = analyzeAll(engine, board, 'black', firstId)
  if (currentRoot.error || currentRoot.moves?.[0]?.move !== 'e1') {
    throw new Error(`problem 86 start analysis failed: ${JSON.stringify(currentRoot)}`)
  }
  const startEval = currentRoot.moves[0].discDiff
  const graph = [startEval]
  const replies = []
  let allBest = true
  let id = firstId + 1
  // playerMovesのnullは「その局面の最善手」(重みが変わっても合法手であり続ける)。
  // 2026-10-16: 中盤練習はプレイヤーの3手目で終了する(相手の3回目の応手なし)。
  // 終了評価Bは3手目の着手評価値で、グラフの最終点と同じ値。
  let endEval = startEval
  for (const [index, plannedMove] of playerMoves.entries()) {
    const playerMove = plannedMove ?? currentRoot.moves[0].move
    const played = currentRoot.moves.find((move) => move.move === playerMove)
    if (!played) throw new Error(`problem 86 planned move is illegal: ${playerMove}`)
    graph.push(played.discDiff)
    allBest &&= played.score === currentRoot.moves[0].score
    board = applyMove(board, 'black', playerMove)
    if (index === playerMoves.length - 1) {
      endEval = played.discDiff
      break
    }

    const opponent = analyzeAll(engine, board, 'white', id++)
    const reply = opponent.moves?.[0]?.move
    if (!reply) throw new Error(`problem 86 reply analysis failed: ${JSON.stringify(opponent)}`)
    replies.push(reply)
    board = applyMove(board, 'white', reply)
    currentRoot = analyzeAll(engine, board, 'black', id++)
    graph.push(currentRoot.moves[0].discDiff)
  }
  const loss = Math.max(0, startEval - endEval)
  const stars = allBest ? 3 : loss < 1 ? 2 : loss < 5 ? 1 : 0
  return { startEval, endEval, graph, replies, stars }
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

const allMovesExpected = JSON.stringify(deterministicAllMovesFields(allMovesFirst))
if (
  allMovesFirst.error
  || allMovesSecond.error
  || allMovesAfterUnrelated.error
  || JSON.stringify(deterministicAllMovesFields(allMovesSecond)) !== allMovesExpected
  || JSON.stringify(deterministicAllMovesFields(allMovesAfterUnrelated)) !== allMovesExpected
) {
  throw new Error(
    `allMoves node-budget WASM determinism check failed: ${JSON.stringify({ allMovesFirst, allMovesSecond, allMovesAfterUnrelated })}`,
  )
}

const problem86First = runProblem86Attempt(engine, [null, null, null], 100)
const problem86Second = runProblem86Attempt(engine, [null, null, null], 200)
const problem86Alternate = runProblem86Attempt(engine, ['g6', null, null], 300)
if (
  JSON.stringify(problem86Second) !== JSON.stringify(problem86First)
  || problem86First.graph[0] !== problem86First.startEval
  || problem86First.graph.at(-1) !== problem86First.endEval
  || problem86Alternate.graph[0] !== problem86Alternate.startEval
  || problem86Alternate.graph.at(-1) !== problem86Alternate.endEval
) {
  throw new Error(
    `problem 86 consistency check failed: ${JSON.stringify({ problem86First, problem86Second, problem86Alternate })}`,
  )
}

console.log(`[wasm-test] deterministic node-budget result: ${first.pv[0]} (${first.score.discDiff}), depth ${first.depth}, nodes ${first.nodes}`)
console.log(
  `[wasm-test] deterministic allMoves node-budget result: ${allMovesFirst.pv[0]} (${allMovesFirst.score.discDiff}), ${allMovesFirst.moves.length} moves`,
)
console.log(`[wasm-test] problem 86 best x3: ${JSON.stringify(problem86First)}`)
console.log(`[wasm-test] problem 86 g6/best/best: ${JSON.stringify(problem86Alternate)}`)

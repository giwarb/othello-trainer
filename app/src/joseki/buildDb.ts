/**
 * `bookgen/joseki-research.json`(T016、35件の名前付き定石ライン)から
 * 定石DB(`JosekiDb`、局面ハッシュをキーにしたDAG)を構築する。
 *
 * 各ラインについて、初手から順に着手を適用しながら盤面を進め、
 * (a) 初手のマスから正規化変換を決定して全着手をf5基準に正規化し、
 * (b) 各局面(適用前)を正規化済みハッシュでDAGのノードとして登録し、
 * (c) そのノードの `bookMoves` に「次の一手」を追加する(複数ラインが
 *     同じ局面を経由する場合はここで合流し、複数の候補手が集まる)。
 *
 * 初期局面(`initialBoard()`)は `identity`/`rot180`/`flipDiag`/`flipAntiDiag`
 * のいずれの変換でも不動点になる(中心対称な配置のため)。したがって
 * 「初手を正規化してから初期局面に対して順に適用していく」のと
 * 「先に初期局面を正規化してから適用していく」は同じ結果になり、
 * 常に `initialBoard()` から正規化済み着手列をシミュレートするだけでよい
 * (`normalize.ts` のコメント参照)。
 */

import { applyMove, initialBoard, notationToSquare, opposite, type Side } from '../game/othello.ts'
import { opForFirstMove, hashBoard } from './normalize.ts'
import { transformSquare } from './symmetry.ts'
import type {
  JosekiBookMove,
  JosekiDb,
  JosekiLine,
  JosekiNode,
  RawJosekiLine,
  SerializedJosekiDb,
} from './types.ts'

/** `bookgen/joseki-research.json` の `lines[]` から `JosekiDb` を構築する。 */
export function buildJosekiDb(rawLines: readonly RawJosekiLine[]): JosekiDb {
  const nodes = new Map<string, JosekiNode>()
  const lines: JosekiLine[] = []

  for (const raw of rawLines) {
    const originalSquares = raw.moves.map(notationToSquare)
    if (originalSquares.length === 0) {
      throw new RangeError(`joseki line "${raw.name}" has no moves`)
    }

    const op = opForFirstMove(originalSquares[0])
    const normalizedSquares = originalSquares.map((sq) => transformSquare(op, sq))

    lines.push({
      id: raw.name,
      name: raw.name,
      aliases: raw.aliases ?? [],
      moveSeq: normalizedSquares,
      depth: raw.depth,
      popularity: undefined,
    })

    let board = initialBoard()
    let side: Side = 'black'

    for (const move of normalizedSquares) {
      const node = getOrCreateNode(nodes, hashBoard(board, side))
      addName(node, raw.name)
      addBookMove(node, move)

      board = applyMove(board, side, move)
      side = opposite(side)
    }

    // このラインの最終局面を isLeaf=true としてマークする。他のより長い
    // ラインが同じ局面を通過点として経由している場合、そちらの line の
    // 処理で既に bookMoves が付いていることもあるが、isLeaf は「この
    // ラインにとっての終端であるか」を表すのでフラグはそのまま true にする。
    const leafNode = getOrCreateNode(nodes, hashBoard(board, side))
    addName(leafNode, raw.name)
    leafNode.isLeaf = true
  }

  assignEqualWeights(nodes)

  return { nodes, lines }
}

function getOrCreateNode(nodes: Map<string, JosekiNode>, key: string): JosekiNode {
  const existing = nodes.get(key)
  if (existing) return existing
  const created: JosekiNode = { bookMoves: [], nonBookEval: null, names: [], isLeaf: false }
  nodes.set(key, created)
  return created
}

function addName(node: JosekiNode, name: string): void {
  if (!node.names.includes(name)) node.names.push(name)
}

function addBookMove(node: JosekiNode, move: number): void {
  if (node.bookMoves.some((bm) => bm.move === move)) return
  const bookMove: JosekiBookMove = { move, weight: 0, eval: null }
  node.bookMoves.push(bookMove)
}

/**
 * T016のデータには着手頻度(出現数)の情報が無いため、同一局面から分岐する
 * bookMovesは暫定的に均等重みとする(例: 選択肢が2つなら各0.5)。
 * 将来WTHOR等の高段者局データが使えるようになったら実頻度で再計算する想定
 * (`tasks/T017-joseki-dag.md` 要件4参照)。
 */
function assignEqualWeights(nodes: ReadonlyMap<string, JosekiNode>): void {
  for (const node of nodes.values()) {
    if (node.bookMoves.length === 0) continue
    const weight = 1 / node.bookMoves.length
    for (const bookMove of node.bookMoves) {
      bookMove.weight = weight
    }
  }
}

/** `JosekiDb.nodes`(Map)をJSONにそのまま保存できるプレーンオブジェクトに変換する。 */
export function serializeJosekiDb(db: JosekiDb): SerializedJosekiDb {
  return { nodes: Object.fromEntries(db.nodes), lines: db.lines }
}

/** `serializeJosekiDb` の逆変換。 */
export function deserializeJosekiDb(serialized: SerializedJosekiDb): JosekiDb {
  return { nodes: new Map(Object.entries(serialized.nodes)), lines: serialized.lines }
}

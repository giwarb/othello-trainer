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
 * T150: `RawJosekiLine.gameCount`(WTHOR頻出ライン抽出、`bookgen/wthor-lines.json`)
 * が設定されているラインでは、そのラインが通過する各分岐(局面→手)に
 * `gameCount`を積算し(`JosekiBookMove.frequencyCount`)、ノードの全分岐が
 * 頻度データを持つ場合は頻度比例の重みを計算する(`assignWeights`参照)。
 * `gameCount`を持たないライン(T016由来の手作業データ)だけで構成される
 * ノードでは、これまでどおり均等重みのままになる(既定挙動不変)。
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
      popularity: raw.gameCount,
    })

    let board = initialBoard()
    let side: Side = 'black'

    for (const move of normalizedSquares) {
      const node = getOrCreateNode(nodes, hashBoard(board, side))
      addName(node, raw.name)
      addBookMove(node, move, raw.gameCount)

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

  assignWeights(nodes)

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

/**
 * ノード(局面)に分岐候補手 `move` を追加する。既に同じ手が登録済みなら
 * 追加しない(複数ラインが同じ分岐を共有する場合の重複防止)。
 *
 * T150: `gameCount`(呼び出し元のラインが持つ`RawJosekiLine.gameCount`)が
 * 渡された場合、その分岐(局面→手)の`frequencyCount`に加算する。同じ
 * (ノード,手)の組を複数のラインが経由する場合はここで積算される。
 * `gameCount`が`undefined`のライン(T016由来の手作業データ)は
 * `frequencyCount`に触れない(既存の手がまだ頻度データを持っていなければ
 * `undefined`のまま = 頻度データが無いことを表す)。
 */
function addBookMove(node: JosekiNode, move: number, gameCount: number | undefined): void {
  let bookMove = node.bookMoves.find((bm) => bm.move === move)
  if (!bookMove) {
    bookMove = { move, weight: 0, eval: null }
    node.bookMoves.push(bookMove)
  }
  if (gameCount !== undefined) {
    bookMove.frequencyCount = (bookMove.frequencyCount ?? 0) + gameCount
  }
}

/**
 * 各ノードのbookMovesに重みを割り当てる。
 *
 * ノード内の全bookMovesが`frequencyCount`(出現局数の合計、T150で追加)を
 * 持ち、かつその合計が0より大きい場合は、頻度比例の重みを計算する
 * (`weight = frequencyCount / 合計`)。それ以外(T016由来の手作業データの
 * ように`frequencyCount`が無い手が1つでも混ざる場合を含む)は、これまで
 * どおり均等重みにする(例: 選択肢が2つなら各0.5)。T016のみのデータ
 * (`bookgen/joseki-research.json`)は`gameCount`を持たないため、常に
 * この均等重み分岐を通り既定挙動は変わらない
 * (`tasks/T017-joseki-dag.md` 要件4、`tasks/T150-book-line-extraction.md` 参照)。
 */
function assignWeights(nodes: ReadonlyMap<string, JosekiNode>): void {
  for (const node of nodes.values()) {
    if (node.bookMoves.length === 0) continue

    const hasFullFrequencyData = node.bookMoves.every(
      (bm) => bm.frequencyCount !== undefined && bm.frequencyCount > 0,
    )
    if (hasFullFrequencyData) {
      const total = node.bookMoves.reduce((sum, bm) => sum + bm.frequencyCount!, 0)
      for (const bookMove of node.bookMoves) {
        bookMove.weight = bookMove.frequencyCount! / total
      }
      continue
    }

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

/**
 * 悪手分析パネル(T030、要件2・設計書§6.4)の「フリー分岐探索」用ツリー構造。
 *
 * 悪手局面(ルート)から、実際に盤を操作して試した変化をツリーとして記録する。
 * ノード=局面、子=そこから試した手。永続化はしない(タスク仕様「やらないこと」
 * によりセッション内のみ)ため、単純な不変(immutable)データ構造として実装する
 * (Reactの状態として素直に扱えるように、更新は常に新しい`BranchTree`を返す)。
 *
 * パス(手番側に合法手が無い)は`midgame/resolveMover.ts`の`resolveMover`で
 * 自動的に処理する(`analyzeGame.ts`・`PracticeMode.tsx`と同じ方針)。
 */

import { applyMove, legalMoves, notationToSquare, opposite, type Board, type Side } from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'

export interface BranchNode {
  readonly id: string
  readonly board: Board
  /** この局面で本来手番となるはずの側(パス自動処理前。`currentMover`で実際の手番を解決する)。 */
  readonly side: Side
  /** 親ノードからこの局面に至った手("a1"〜"h8"記法)。ルートは`null`。 */
  readonly moveFromParent: string | null
  readonly parentId: string | null
  readonly childIds: readonly string[]
  /** この局面の即時評価(取得済みなら)。手番側視点の石差。 */
  readonly evalDiscDiff?: number
  readonly evalType?: 'midgame' | 'exact'
}

export interface BranchTree {
  readonly nodes: Readonly<Record<string, BranchNode>>
  readonly rootId: string
  readonly currentId: string
}

const ROOT_ID = 'root'

/** 悪手局面(`board`・`side`)をルートとする新しいツリーを作る。 */
export function createBranchTree(board: Board, side: Side): BranchTree {
  const root: BranchNode = {
    id: ROOT_ID,
    board,
    side,
    moveFromParent: null,
    parentId: null,
    childIds: [],
  }
  return { nodes: { [ROOT_ID]: root }, rootId: ROOT_ID, currentId: ROOT_ID }
}

/** 現在選択中のノードを返す。 */
export function currentNode(tree: BranchTree): BranchNode {
  const node = tree.nodes[tree.currentId]
  if (!node) {
    throw new Error(`branchTree: currentId "${tree.currentId}" に対応するノードがありません`)
  }
  return node
}

/**
 * 現在のノードで実際に手番を持つ側(パス自動処理後)。
 * 両者とも合法手が無い(終局)場合は`null`。
 */
export function currentMover(tree: BranchTree): Side | null {
  const node = currentNode(tree)
  return resolveMover(node.board, node.side)
}

/**
 * 現在のノードから`move`を試し、その子ノードに移動した新しいツリーを返す。
 * 同じ`move`を既に試したことがあれば(子ノードが既にあれば)、新規作成せず
 * そのノードに移動するだけ(重複ノードを作らない)。
 *
 * @throws {Error} 現在のノードが終局している、または`move`が合法手でない場合。
 */
export function addBranchMove(tree: BranchTree, move: string): BranchTree {
  const current = currentNode(tree)
  const existingChildId = current.childIds.find((id) => tree.nodes[id]?.moveFromParent === move)
  if (existingChildId) {
    return { ...tree, currentId: existingChildId }
  }

  const mover = resolveMover(current.board, current.side)
  if (mover === null) {
    throw new Error('branchTree: この局面はすでに終局しています(合法手がありません)')
  }
  const square = notationToSquare(move)
  if (!legalMoves(current.board, mover).includes(square)) {
    throw new Error(`branchTree: "${move}" はこの局面の合法手ではありません`)
  }

  const board = applyMove(current.board, mover, square)
  const side = opposite(mover)
  const newId = `${current.id}::${move}`
  const newNode: BranchNode = {
    id: newId,
    board,
    side,
    moveFromParent: move,
    parentId: current.id,
    childIds: [],
  }

  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [current.id]: { ...current, childIds: [...current.childIds, newId] },
      [newId]: newNode,
    },
    currentId: newId,
  }
}

/** 指定したノードIDへ移動する(ツリー上のノードをクリックして局面を行き来する操作)。 */
export function goToNode(tree: BranchTree, nodeId: string): BranchTree {
  if (!tree.nodes[nodeId]) {
    throw new Error(`branchTree: ノードID "${nodeId}" は存在しません`)
  }
  return { ...tree, currentId: nodeId }
}

/** ルート(悪手局面、本譜の分岐点)へ戻る(「本譜に戻る」ボタン)。 */
export function goToRoot(tree: BranchTree): BranchTree {
  return { ...tree, currentId: tree.rootId }
}

/** 指定したノードに即時評価を付与した新しいツリーを返す(試し手を打つたびに評価を表示する用)。 */
export function setNodeEval(
  tree: BranchTree,
  nodeId: string,
  evalDiscDiff: number,
  evalType: 'midgame' | 'exact',
): BranchTree {
  const node = tree.nodes[nodeId]
  if (!node) {
    throw new Error(`branchTree: ノードID "${nodeId}" は存在しません`)
  }
  return {
    ...tree,
    nodes: { ...tree.nodes, [nodeId]: { ...node, evalDiscDiff, evalType } },
  }
}

import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare } from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import {
  addBranchMove,
  createBranchTree,
  currentMover,
  currentNode,
  goToNode,
  goToRoot,
  setNodeEval,
} from './branchTree.ts'

describe('analysis/branchTree', () => {
  const board0 = initialBoard()

  it('createBranchTreeはルートノードのみを持つツリーを作る', () => {
    const tree = createBranchTree(board0, 'black')
    expect(tree.currentId).toBe(tree.rootId)
    const root = currentNode(tree)
    expect(root.board).toEqual(board0)
    expect(root.side).toBe('black')
    expect(root.parentId).toBeNull()
    expect(root.moveFromParent).toBeNull()
    expect(root.childIds).toEqual([])
  })

  it('addBranchMoveで子ノードを追加し、currentIdがそこに移動する', () => {
    const tree0 = createBranchTree(board0, 'black')
    const tree1 = addBranchMove(tree0, 'f5')

    expect(tree1.currentId).not.toBe(tree1.rootId)
    const node = currentNode(tree1)
    expect(node.board).toEqual(applyMove(board0, 'black', notationToSquare('f5')))
    expect(node.side).toBe('white')
    expect(node.parentId).toBe(tree1.rootId)
    expect(node.moveFromParent).toBe('f5')

    const root = tree1.nodes[tree1.rootId]!
    expect(root.childIds).toEqual([node.id])
  })

  it('同じ手を2回addBranchMoveしても子ノードは重複しない(既存ノードに移動するだけ)', () => {
    const tree0 = createBranchTree(board0, 'black')
    const tree1 = addBranchMove(tree0, 'f5')
    const backToRoot = goToRoot(tree1)
    const tree2 = addBranchMove(backToRoot, 'f5')

    expect(tree2.currentId).toBe(tree1.currentId)
    expect(tree2.nodes[tree2.rootId]!.childIds).toEqual([tree1.currentId])
  })

  it('合法手でない手を渡すとエラーを投げる', () => {
    const tree0 = createBranchTree(board0, 'black')
    expect(() => addBranchMove(tree0, 'a1')).toThrow()
  })

  it('異なる手をそれぞれaddBranchMoveすると別々の子ノードになる(分岐)', () => {
    const tree0 = createBranchTree(board0, 'black')
    const treeF5 = addBranchMove(tree0, 'f5')
    const treeD3 = addBranchMove(goToRoot(treeF5), 'd3')

    expect(treeF5.currentId).not.toBe(treeD3.currentId)
    const root = treeD3.nodes[treeD3.rootId]!
    expect([...root.childIds].sort()).toEqual([treeF5.currentId, treeD3.currentId].sort())
  })

  it('goToNode/goToRootでノード間を行き来できる', () => {
    const tree0 = createBranchTree(board0, 'black')
    const tree1 = addBranchMove(tree0, 'f5')
    const backToRoot = goToRoot(tree1)
    expect(backToRoot.currentId).toBe(tree1.rootId)

    const backToChild = goToNode(backToRoot, tree1.currentId)
    expect(backToChild.currentId).toBe(tree1.currentId)
  })

  it('goToNodeに存在しないIDを渡すとエラーを投げる', () => {
    const tree0 = createBranchTree(board0, 'black')
    expect(() => goToNode(tree0, 'no-such-node')).toThrow()
  })

  it('currentMoverはresolveMoverの結果と一致する(パス自動処理のwiring検証)', () => {
    const tree0 = createBranchTree(board0, 'black')
    expect(currentMover(tree0)).toBe(resolveMover(board0, 'black'))
  })

  it('setNodeEvalでノードに評価値を付与できる(不変データ構造として元のツリーは変更されない)', () => {
    const tree0 = createBranchTree(board0, 'black')
    const tree1 = addBranchMove(tree0, 'f5')
    const tree2 = setNodeEval(tree1, tree1.currentId, 2.5, 'midgame')

    expect(currentNode(tree2).evalDiscDiff).toBe(2.5)
    expect(currentNode(tree2).evalType).toBe('midgame')
    expect(currentNode(tree1).evalDiscDiff).toBeUndefined()
  })

  it('setNodeEvalに存在しないIDを渡すとエラーを投げる', () => {
    const tree0 = createBranchTree(board0, 'black')
    expect(() => setNodeEval(tree0, 'no-such-node', 1, 'exact')).toThrow()
  })
})

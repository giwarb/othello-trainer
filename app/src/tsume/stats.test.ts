import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeOverallStats,
  computeTagAccuracy,
  getAllAttempts,
  pickWeightedPuzzle,
  puzzleWeight,
  recordAttempt,
  type PuzzleAttemptRecord,
} from './stats.ts'
import type { Puzzle, PuzzleTag } from './types.ts'

// vitestの実行環境は `node` のため、実ブラウザのIndexedDBは存在しない。`stats.ts` の
// 各関数は `IDBFactory` を引数として受け取れるようになっているので、`fake-indexeddb` が
// 提供するスタンドアロンな `IDBFactory` 実装をテストごとに新規生成して明示的に渡す
// (`midgame/pool.test.ts` と同じ手法)。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

function makeRecord(id: string, overrides: Partial<PuzzleAttemptRecord> = {}): PuzzleAttemptRecord {
  return {
    id,
    puzzleId: 'tsume-1',
    correct: true,
    elapsedMs: 5000,
    tags: [],
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

function makePuzzle(id: string, tags: Puzzle['tags'] = []): Puzzle {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    sideToMove: 'black',
    empties: 10,
    correctMoves: ['d3'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty: 1,
    difficultyRawScore: 0,
    tags,
  }
}

describe('tsume/stats: IndexedDB永続化(recordAttempt/getAllAttempts)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('初期状態ではgetAllAttemptsは空配列を返す', async () => {
    expect(await getAllAttempts(factory)).toEqual([])
  })

  it('recordAttemptで記録した挑戦をgetAllAttemptsで読み戻せる', async () => {
    const record = makeRecord('a1')
    await recordAttempt(record, factory)

    expect(await getAllAttempts(factory)).toEqual([record])
  })

  it('同じidで記録すると上書きされる', async () => {
    await recordAttempt(makeRecord('a1', { correct: true }), factory)
    await recordAttempt(makeRecord('a1', { correct: false }), factory)

    const all = await getAllAttempts(factory)
    expect(all.length).toBe(1)
    expect(all[0]?.correct).toBe(false)
  })

  it('複数レコードをまとめて読み込める', async () => {
    await recordAttempt(makeRecord('a1'), factory)
    await recordAttempt(makeRecord('a2', { correct: false }), factory)

    const all = await getAllAttempts(factory)
    expect(all.map((r) => r.id).sort()).toEqual(['a1', 'a2'])
  })
})

describe('tsume/stats: computeOverallStats', () => {
  it('記録が無ければattempts=0、accuracy/averageElapsedMsはnullを返す', () => {
    const stats = computeOverallStats([])
    expect(stats).toEqual({ attempts: 0, correct: 0, accuracy: null, averageElapsedMs: null })
  })

  it('正答率・平均時間を正しく集計する', () => {
    const records = [
      makeRecord('a1', { correct: true, elapsedMs: 4000 }),
      makeRecord('a2', { correct: false, elapsedMs: 8000 }),
      makeRecord('a3', { correct: true, elapsedMs: 6000 }),
    ]
    const stats = computeOverallStats(records)

    expect(stats.attempts).toBe(3)
    expect(stats.correct).toBe(2)
    expect(stats.accuracy).toBeCloseTo(2 / 3)
    expect(stats.averageElapsedMs).toBeCloseTo(6000)
  })
})

describe('tsume/stats: computeTagAccuracy', () => {
  it('タグごとに正答率を集計する', () => {
    const records = [
      makeRecord('a1', { correct: true, tags: ['stable-gain'] }),
      makeRecord('a2', { correct: false, tags: ['stable-gain'] }),
      makeRecord('a3', { correct: true, tags: ['corner-sacrifice'] }),
    ]
    const accuracy = computeTagAccuracy(records)

    expect(accuracy.get('stable-gain')).toBeCloseTo(0.5)
    expect(accuracy.get('corner-sacrifice')).toBeCloseTo(1)
  })

  it('1回の挑戦が複数タグを持つ場合、両方のタグにカウントされる', () => {
    const records = [makeRecord('a1', { correct: false, tags: ['stable-gain', 'corner-sacrifice'] })]
    const accuracy = computeTagAccuracy(records)

    expect(accuracy.get('stable-gain')).toBe(0)
    expect(accuracy.get('corner-sacrifice')).toBe(0)
  })

  it('挑戦記録が無ければ空のMapを返す', () => {
    expect(computeTagAccuracy([]).size).toBe(0)
  })
})

describe('tsume/stats: puzzleWeight / pickWeightedPuzzle', () => {
  it('タグを持たない問題の重みは常に1', () => {
    const puzzle = makePuzzle('p1', [])
    expect(puzzleWeight(puzzle, new Map())).toBe(1)
  })

  it('正答率が低いタグを持つ問題ほど重みが大きくなる', () => {
    const weak = makePuzzle('weak', ['stable-gain'])
    const strong = makePuzzle('strong', ['corner-sacrifice'])
    const accuracy = new Map<PuzzleTag, number>([
      ['stable-gain', 0.2],
      ['corner-sacrifice', 0.9],
    ])

    expect(puzzleWeight(weak, accuracy)).toBeGreaterThan(puzzleWeight(strong, accuracy))
  })

  it('未挑戦のタグ(accuracyに無い)は正答率100%扱いになる', () => {
    const puzzle = makePuzzle('p1', ['stable-gain'])
    expect(puzzleWeight(puzzle, new Map())).toBeCloseTo(puzzleWeight(makePuzzle('p2', []), new Map()), 1)
  })

  it('pickWeightedPuzzleはpoolの中から1問を返す', () => {
    const pool = [makePuzzle('p1'), makePuzzle('p2'), makePuzzle('p3')]
    const picked = pickWeightedPuzzle(pool, new Map())
    expect(pool.map((p) => p.id)).toContain(picked.id)
  })

  it('pickWeightedPuzzleは弱点タグを含む問題を優先的に選ぶ(乱数を固定した決定性テスト)', () => {
    const weak = makePuzzle('weak', ['stable-gain'])
    const strong = makePuzzle('strong', ['corner-sacrifice'])
    const accuracy = new Map<PuzzleTag, number>([
      ['stable-gain', 0.0],
      ['corner-sacrifice', 1.0],
    ])
    // weightの合計に対する比率を計算し、weak側の区間に収まる乱数を渡す。
    const weakWeight = puzzleWeight(weak, accuracy)
    const strongWeight = puzzleWeight(strong, accuracy)
    const total = weakWeight + strongWeight

    const pickedWeak = pickWeightedPuzzle([weak, strong], accuracy, () => 0)
    expect(pickedWeak.id).toBe('weak')

    const pickedStrong = pickWeightedPuzzle([weak, strong], accuracy, () => (weakWeight + 0.001) / total)
    expect(pickedStrong.id).toBe('strong')
  })

  it('poolが空配列の場合はRangeErrorを投げる', () => {
    expect(() => pickWeightedPuzzle([], new Map())).toThrow(RangeError)
  })
})

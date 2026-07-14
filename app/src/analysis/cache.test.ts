import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import {
  ANALYSIS_ENGINE_VERSION,
  analysisLimitTag,
  cacheKey,
  clearAnalysisCache,
  getCachedAnalysis,
  putCachedAnalysis,
} from './cache.ts'

// vitestの実行環境は`node`のため、実ブラウザのIndexedDBは存在しない。`midgame/pool.test.ts`
// と同じ手法で`fake-indexeddb`のスタンドアロン`IDBFactory`をテストごとに新規生成する。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

function makeMoves(): MoveEvalJson[] {
  return [
    { move: 'f5', score: 200, discDiff: 2.0, type: 'midgame' },
    { move: 'd6', score: 100, discDiff: 1.0, type: 'midgame' },
  ]
}

describe('analysis/cache (IndexedDB解析結果キャッシュ)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('cacheKeyは局面ハッシュと探索条件タグとエンジンバージョンを連結した文字列を作る(T060)', () => {
    expect(cacheKey('abc_def_black', 'd18-e22')).toBe(`abc_def_black|d18-e22|v${ANALYSIS_ENGINE_VERSION}`)
  })

  it('探索条件タグはmaxNodesを含み、異なるノード予算を別キャッシュにする(T085c)', () => {
    const base = { depth: 12, timeMs: 1500, exactFromEmpties: 16 }
    expect(analysisLimitTag(base)).toBe('d12-e16-nnone')
    expect(analysisLimitTag({ ...base, maxNodes: 160000 })).toBe('d12-e16-n160000')
    expect(analysisLimitTag({ ...base, maxNodes: 200000 })).not.toBe(
      analysisLimitTag({ ...base, maxNodes: 160000 }),
    )
  })

  it('未キャッシュの局面はundefinedを返す', async () => {
    const result = await getCachedAnalysis('nonexistent', factory)
    expect(result).toBeUndefined()
  })

  it('putCachedAnalysisで書き込んだ結果をgetCachedAnalysisで読み戻せる', async () => {
    const moves = makeMoves()
    await putCachedAnalysis('key-1', moves, factory)

    const result = await getCachedAnalysis('key-1', factory)
    expect(result).toEqual(moves)
  })

  it('同じキーで書き込むと上書きされる', async () => {
    await putCachedAnalysis('key-1', makeMoves(), factory)
    const updated: MoveEvalJson[] = [{ move: 'c4', score: 50, discDiff: 0.5, type: 'exact' }]
    await putCachedAnalysis('key-1', updated, factory)

    const result = await getCachedAnalysis('key-1', factory)
    expect(result).toEqual(updated)
  })

  it('異なるキーのレコードは互いに独立している', async () => {
    await putCachedAnalysis('key-1', makeMoves(), factory)
    const other = await getCachedAnalysis('key-2', factory)
    expect(other).toBeUndefined()
  })

  it('別のfactoryインスタンス間ではデータが分離される(テストの独立性確認)', async () => {
    await putCachedAnalysis('key-1', makeMoves(), factory)
    const otherFactory = freshFactory()
    const result = await getCachedAnalysis('key-1', otherFactory)
    expect(result).toBeUndefined()
  })

  it('異なるエンジンバージョンで作ったキーは異なる文字列になり、旧バージョンのキャッシュがヒットしなくなる(T060要件1)', () => {
    const oldKey = 'abc_def_black|d18-e22'
    const newKey = cacheKey('abc_def_black', 'd18-e22')
    expect(newKey).not.toBe(oldKey)
  })

  it('clearAnalysisCacheでキャッシュを全件削除できる(T060要件2・3)', async () => {
    await putCachedAnalysis('key-1', makeMoves(), factory)
    await putCachedAnalysis('key-2', makeMoves(), factory)

    await clearAnalysisCache(factory)

    expect(await getCachedAnalysis('key-1', factory)).toBeUndefined()
    expect(await getCachedAnalysis('key-2', factory)).toBeUndefined()
  })

  it('clearAnalysisCache後もputCachedAnalysis/getCachedAnalysisが正常に動作する(T060要件3)', async () => {
    await putCachedAnalysis('key-1', makeMoves(), factory)
    await clearAnalysisCache(factory)

    const moves = makeMoves()
    await putCachedAnalysis('key-1', moves, factory)
    const result = await getCachedAnalysis('key-1', factory)
    expect(result).toEqual(moves)
  })
})

import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAllSrsStates, getSrsState, putSrsState, recordSrsResults } from './db.ts'
import { createInitialSrsState, nextSrsState } from './srs.ts'

// vitestの実行環境は `node` のため、実ブラウザのIndexedDBは存在しない。`db.ts` の各関数は
// `IDBFactory` を引数として受け取れるようになっているので、`fake-indexeddb` が提供する
// スタンドアロンな `IDBFactory` 実装をテストごとに新規生成して明示的に渡す(グローバルを
// ポリフィルする `fake-indexeddb/auto` は使わない。テストごとにDBを分離するため)。
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

describe('joseki/db (IndexedDB永続化)', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = freshFactory()
  })

  it('未保存のラインは getSrsState が undefined を返す', async () => {
    const state = await getSrsState('虎', factory)
    expect(state).toBeUndefined()
  })

  it('putSrsStateで保存した状態をgetSrsStateで読み戻せる', async () => {
    const state = createInitialSrsState('虎', new Date(2026, 6, 7))
    await putSrsState(state, factory)

    const loaded = await getSrsState('虎', factory)
    expect(loaded).toEqual(state)
  })

  it('putSrsStateで同じlineIdを2回保存すると上書きされる', async () => {
    const first = createInitialSrsState('虎', new Date(2026, 6, 7))
    await putSrsState(first, factory)

    const second = nextSrsState(first, '虎', 'success', new Date(2026, 6, 8))
    await putSrsState(second, factory)

    const loaded = await getSrsState('虎', factory)
    expect(loaded).toEqual(second)
    expect(loaded?.interval).toBe(second.interval)
  })

  it('getAllSrsStatesは保存済みの全ラインの状態を返す', async () => {
    const tora = createInitialSrsState('虎', new Date(2026, 6, 7))
    const rose = createInitialSrsState('バラ', new Date(2026, 6, 7))
    await putSrsState(tora, factory)
    await putSrsState(rose, factory)

    const all = await getAllSrsStates(factory)
    expect(all.map((s) => s.lineId).sort()).toEqual(['バラ', '虎'])
  })

  it('別のfactoryインスタンス間ではデータが分離される(テストの独立性確認)', async () => {
    await putSrsState(createInitialSrsState('虎', new Date(2026, 6, 7)), factory)

    const otherFactory = freshFactory()
    const all = await getAllSrsStates(otherFactory)
    expect(all).toEqual([])
  })

  describe('recordSrsResults(複数ライン名の一括記録、やり直し1回目の要件7)', () => {
    it('複数のlineIdについて、それぞれ独立にSRS状態が新規作成・記録される', async () => {
      // 1本の長い定石を最後まで辿ったセッションでは、途中で通過した短いラインの終端も
      // 合わせて「クリア」扱いになる(practiceSession.tsのadvanceClearState参照)。
      const now = new Date(2026, 6, 7)
      await recordSrsResults(['縦取り', '虎', '猫'], 'success', now, factory)

      const all = await getAllSrsStates(factory)
      expect(all.map((s) => s.lineId).sort()).toEqual(['猫', '縦取り', '虎'].sort())
      for (const state of all) {
        expect(state.streak).toBe(1)
        expect(state.interval).toBeGreaterThan(0)
      }
    })

    it('既存のSRS状態がある場合は、それぞれのlineIdの直前の状態を引き継いで更新する', async () => {
      const day1 = new Date(2026, 6, 1)
      await putSrsState(createInitialSrsState('虎', day1), factory)
      // '猫' は未挑戦のまま(putSrsStateしない)。

      const day2 = new Date(2026, 6, 10)
      await recordSrsResults(['虎', '猫'], 'success', day2, factory)

      const tora = await getSrsState('虎', factory)
      const neko = await getSrsState('猫', factory)
      // '虎' は既存状態(streak=0)からの2回目の成功なのでstreak=1、intervalは初回成功の1日から伸びる。
      expect(tora?.streak).toBe(1)
      expect(tora?.interval).toBeGreaterThan(0)
      // '猫' は初回成功(新規作成からの1回目)。
      expect(neko?.streak).toBe(1)
    })

    it('失敗(fail)を記録すると、各lineIdのintervalが1日にリセットされfailsが加算される', async () => {
      const now = new Date(2026, 6, 7)
      await recordSrsResults(['出題対象ライン'], 'fail', now, factory)

      const state = await getSrsState('出題対象ライン', factory)
      expect(state?.interval).toBe(1)
      expect(state?.fails).toBe(1)
      expect(state?.streak).toBe(0)
    })

    it('空配列を渡した場合は何も書き込まない', async () => {
      await recordSrsResults([], 'success', new Date(2026, 6, 7), factory)
      const all = await getAllSrsStates(factory)
      expect(all).toEqual([])
    })
  })
})

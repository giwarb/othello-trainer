// @vitest-environment jsdom
/**
 * T134: 対局モードでの石返しアニメーション直列化の回帰テスト。
 *
 * ユーザー指示(2026-07-18午後): 「こちらが返した後すぐ返されてよくわからなくなる。
 * 返すアニメーションが終わった後、次のアニメーションして」への対応として、
 * `app.tsx`の`PlayMode`に「実際に見せる」状態(`displayGame`)と、それを直列化する
 * `displaySequencerRef`(`game/displayQueue.ts`)を導入した。
 *
 * `game/displayQueue.test.ts`が直列化キューそのものの純粋なロジック
 * (アイドル中は即座反映・保留中は待つ・複数連打しても重ならない・resetは
 * 待ちなしで即反映)を決定的に検証しているため、本テストでは実際の
 * `<App/>`(対局モード)を通した統合シナリオに絞る:
 *
 * 1. 人間の着手(d3)は即座に盤面へ反映される。
 * 2. CPUの応手(定石ブックによる即時解決)は`game`としてはすぐ確定するが、
 *    `<Board>`への反映は`FLIP_ANIMATION_MS + DISPLAY_GAP_MS`が経過するまで
 *    行われない(直列化)。
 * 3. その待ち時間が経過すると反映され、「思考中」表示も正しく解除される
 *    (T115: 定石ブック即時応手は「思考中」解除漏れの実績があるため、
 *    直列化を入れてもハングしないことを確認する)。
 *
 * `Board`はcanvas描画のためモックが必須(他のapp.playmode.*.test.tsxと同じ方針)。
 * ただし本テストは`<Board>`に渡される`sideToMove`/`lastMove` props自体を
 * 検証したいため、単純なクリックボタンだけでなくそれらをdata属性で
 * 露出するスタブにする。`FLIP_ANIMATION_MS`/`DISPLAY_GAP_MS`は実際の値に近い
 * 非ゼロ値をモックし、`vi.useFakeTimers()` + `advanceTimersByTimeAsync`で
 * 決定的に時間を進める。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import { applyMove, initialBoard, legalMoves, notationToSquare } from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

const D3 = notationToSquare('d3')
const E3 = notationToSquare('e3')

// 実際の値と桁数を揃えつつテストを高速に保つため、FLIP_ANIMATION_MSは20、
// DISPLAY_GAP_MSは30とする(本番は220/250)。合計50msを`vi.advanceTimersByTimeAsync`
// で進めて検証する。
const TEST_FLIP_ANIMATION_MS = 20
const TEST_DISPLAY_GAP_MS = 30

vi.mock('./components/Board.tsx', () => ({
  // `<Board>`に渡された`sideToMove`/`lastMove`をdata属性として露出する。
  // これにより「CPUの応手がまだ画面に反映されていないか」を
  // props経由で直接検証できる(表示テキストの目視に頼らない)。
  Board: ({
    sideToMove,
    lastMove,
    onMove,
  }: {
    sideToMove: string
    lastMove: number | null
    onMove?: (square: number) => void
  }) => (
    <div data-testid="board-stub" data-side-to-move={sideToMove} data-last-move={lastMove ?? 'null'}>
      <button type="button" data-testid="stub-board-play-d3" onClick={() => onMove?.(D3)}>
        play d3
      </button>
    </div>
  ),
  FLIP_ANIMATION_MS: TEST_FLIP_ANIMATION_MS,
  DISPLAY_GAP_MS: TEST_DISPLAY_GAP_MS,
}))

vi.mock('./engine/sharedClient.ts', () => {
  const analyzeResponse: AnalyzeResponseMessage = {
    id: 0,
    final: true,
    depth: 1,
    pv: ['a1'],
    score: { type: 'midgame', discDiff: 0 },
    nodes: 0,
    nps: 0,
  }
  return {
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: () => Promise.resolve<MoveEvalJson[]>([]),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  lookupJosekiNode: () => null,
}))

vi.mock('./joseki/selectCpuBookMove.ts', () => ({
  // 常にE3を返す(定石ブックがヒットして即時応手できる状況を固定的に再現する、
  // `app.playmode.test.tsx`(T115)と同じ方針)。
  selectCpuBookMove: () => E3,
}))

/** マイクロタスク(Promiseチェーン)だけを、実タイマーを進めずに数ラウンド分flushする。 */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('T134: 対局モードでの石返しアニメーション直列化', () => {
  it('sanity: d3(黒)の後、e3(白)は実際に合法手である(モックの前提を裏取りする)', () => {
    const boardAfterD3 = applyMove(initialBoard(), 'black', D3)
    expect(legalMoves(boardAfterD3, 'white')).toContain(E3)
  })

  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it(
    '自分の着手は即座に反映され、CPUの書籍応手はFLIP_ANIMATION_MS+DISPLAY_GAP_MS経過後に反映される' +
      '(直前は反映されない)。「思考中」もその後正しく解除される(T115回帰: ハングしない)',
    async () => {
      vi.useFakeTimers()
      try {
        const { App } = await import('./app.tsx')

        await act(async () => {
          render(<App />, container)
        })

        const playCard = Array.from(container.querySelectorAll<HTMLButtonElement>('.title-screen__card')).find(
          (btn) => btn.textContent?.includes('対局'),
        )
        expect(playCard).toBeDefined()
        await act(async () => {
          playCard?.click()
        })
        // 定石DBの読み込み完了(josekiDbReady)を待つ(Promiseのみ、実タイマー不要)。
        await flushMicrotasks()

        // 黒番(人間)としてd3に着手する。
        const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
        expect(boardStub).not.toBeNull()
        await act(async () => {
          boardStub?.click()
        })

        // 自分の着手(d3)は即座に反映される(表示側もアイドルだったため待ちなし)。
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(D3),
        )
        expect(container.querySelector('.status')?.textContent).toContain('思考中')

        // CPU(白)の書籍応手を、`game`(内部状態)としては解決させる
        // (Promiseチェーンをflushするだけで、実タイマーはまだ進めない)。
        await flushMicrotasks()

        // 直列化の要件: `game`としてはCPUの応手(e3)が確定していても、
        // まだ`FLIP_ANIMATION_MS + DISPLAY_GAP_MS`が経過していないので、
        // 盤面(`displayGame`由来のprops)にはまだd3のまま反映されていないはず。
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(D3),
        )

        // 直前(FLIP_ANIMATION_MS+DISPLAY_GAP_MSの1ms手前)まで進めてもまだ反映されない。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TEST_FLIP_ANIMATION_MS + TEST_DISPLAY_GAP_MS - 1)
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(D3),
        )

        // 残り1ms分を進めると、CPUの応手(e3)が反映される。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1)
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(E3),
        )

        // 「思考中」表示も正しく解除されており、人間の手番に戻っている
        // (T115の回帰: 定石ブックの即時応手経路でハングしていないことの確認)。
        const status = container.querySelector('.status')
        expect(status?.textContent).not.toContain('思考中')
        expect(status?.textContent).toContain('手番: 黒')
      } finally {
        vi.useRealTimers()
      }
    },
  )
})

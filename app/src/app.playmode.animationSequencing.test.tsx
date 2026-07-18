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
 *
 * T134 redo#1(表示ラグ窓内クリックの入力整合バグ、
 * `tasks/review/T134-animation-claude-review.md`指摘): `<Board>`のクリック
 * ガードはpropsで渡す`displayGame`(表示中の局面)基準、`app.tsx`の
 * `handleMove`の従来のガードは`game`(内部の最新局面)基準で、両者が別の
 * 局面を指す窓(CPUの応手が`game`としては確定済みだが`displayGame`に
 * まだ反映されていない直列化の待ち時間、最大`FLIP_ANIMATION_MS +
 * DISPLAY_GAP_MS`)があった。この窓の間に「表示中の旧局面でCPU色に合法
 * かつ 内部の新局面で人間に合法」なマスをクリックすると、両ガードを
 * 通過してユーザーがまだ見ていない局面への着手が確定してしまっていた。
 * `handleMove`冒頭に`displayGame !== game`(表示が追いついていない)ガードを
 * 追加して修正した。下の該当テストでは、実物のBoardの合法手ガードを
 * 経由せず(他のテストと同じくBoardはスタブのため)`onMove`を直接呼んで
 * `handleMove`自身のガードを検証する。
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

// `<Board>`の最新の`onMove`コールバックを退避しておく(モジュールスコープ変数)。
// redo#1のテストでは、実物のBoard自身の合法手ガードを経由せず(他のテストと
// 同じくBoardはスタブのため)、`handleMove`自身の`displayGame !== game`ガードを
// 任意のマスで直接検証したい。`stub-board-play-d3`ボタンはd3固定のため、
// 任意のマスをクリックしたのと同じ効果を得るにはこの直接呼び出しが必要。
let latestOnMove: ((square: number) => void) | undefined

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
  }) => {
    latestOnMove = onMove
    return (
      <div data-testid="board-stub" data-side-to-move={sideToMove} data-last-move={lastMove ?? 'null'}>
        <button type="button" data-testid="stub-board-play-d3" onClick={() => onMove?.(D3)}>
          play d3
        </button>
      </div>
    )
  },
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
    latestOnMove = undefined
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

  it(
    '表示ラグ窓内(CPUの応手がgameとしては確定済みだがdisplayGameに未反映)のクリックは無視され、' +
      '追いついた後の着手は通常どおり反映される(T134 redo#1回帰)',
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
        await act(async () => {
          playCard?.click()
        })
        await flushMicrotasks()

        // 黒番(人間)としてd3に着手する(即座に反映される)。
        const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
        await act(async () => {
          boardStub?.click()
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(D3),
        )

        // CPU(白)の書籍応手(e3)を`game`としては解決させる(表示はまだ追いつかない)。
        await flushMicrotasks()
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(D3),
        )

        // この時点で`game`は既に「黒(人間)の手番・盤面はd3+e3適用後」だが、
        // `displayGame`はまだd3のまま(表示ラグ窓)。実際に黒に合法な次のマスを
        // (モックの前提を裏取りしつつ)計算し、ラグ窓内でクリックを試みる。
        const boardAfterD3E3 = applyMove(applyMove(initialBoard(), 'black', D3), 'white', E3)
        const nextBlackLegal = legalMoves(boardAfterD3E3, 'black')
        expect(nextBlackLegal.length).toBeGreaterThan(0)
        const laggedClickSquare = nextBlackLegal[0]

        await act(async () => {
          latestOnMove?.(laggedClickSquare)
        })
        await flushMicrotasks()

        // CPUの応手(e3)自体の反映(1回目のクールダウン)までは進める。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TEST_FLIP_ANIMATION_MS + TEST_DISPLAY_GAP_MS)
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(E3),
        )

        // さらにもう1周期分(次のクールダウン)進めても、ラグ窓内クリックが
        // キューに紛れ込んで自動的に反映される、ということが起きていないことを
        // 確認する(バグがあれば、ここで`laggedClickSquare`が勝手に反映されてしまう)。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TEST_FLIP_ANIMATION_MS + TEST_DISPLAY_GAP_MS)
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(E3),
        )
        expect(container.querySelector('.status')?.textContent).not.toContain('思考中')
        expect(container.querySelector('.status')?.textContent).toContain('手番: 黒')

        // 表示が追いついた(アイドルに戻った)後、同じマスへの着手は通常どおり
        // 即座に反映される(ガードが正当なクリックまで阻害していないことの確認)。
        await act(async () => {
          latestOnMove?.(laggedClickSquare)
        })
        expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
          String(laggedClickSquare),
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('2人対戦モードでは、表示が追いついたタイミングでの通常の連続クリックが阻害されない(T134 redo#1回帰)', async () => {
    vi.useFakeTimers()
    try {
      const { App } = await import('./app.tsx')

      await act(async () => {
        render(<App />, container)
      })

      const playCard = Array.from(container.querySelectorAll<HTMLButtonElement>('.title-screen__card')).find((btn) =>
        btn.textContent?.includes('対局'),
      )
      await act(async () => {
        playCard?.click()
      })
      await flushMicrotasks()

      const vsHumanButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === '2人対戦で開始',
      )
      expect(vsHumanButton).toBeDefined()
      await act(async () => {
        vsHumanButton?.click()
      })
      await flushMicrotasks()

      // 1手目: 黒がd3に着手する(即座に反映される、2人対戦にCPUは存在しない)。
      const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
      await act(async () => {
        boardStub?.click()
      })
      expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
        String(D3),
      )

      // 表示側のクールダウンが明けるのを待つ(通常のプレイでは着手間にこの程度の
      // 間があるのが自然。displayGameとgameが再び一致し、アイドルへ戻る)。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEST_FLIP_ANIMATION_MS + TEST_DISPLAY_GAP_MS)
      })

      // 2手目: 白の番。合法な次のマスを実ロジックで計算してクリックする。
      // `displayGame !== game`ガードが2人対戦の通常操作まで誤って阻害しないことの確認。
      const boardAfterD3 = applyMove(initialBoard(), 'black', D3)
      const whiteLegal = legalMoves(boardAfterD3, 'white')
      expect(whiteLegal.length).toBeGreaterThan(0)
      const secondSquare = whiteLegal[0]

      await act(async () => {
        latestOnMove?.(secondSquare)
      })
      expect(container.querySelector('[data-testid="board-stub"]')?.getAttribute('data-last-move')).toBe(
        String(secondSquare),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

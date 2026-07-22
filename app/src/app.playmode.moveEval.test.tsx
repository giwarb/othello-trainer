// @vitest-environment jsdom
/**
 * T197: 対局モード(CPU対戦)の「打った手の評価値」記録・評価バーの統合テスト。
 *
 * カバーする受け入れ基準:
 * - (a) CPUが応手するまでは評価バーが中立(「まだ相手の手がありません」)。
 * - (a)(b) CPUが探索で応手した場合、その評価値(`response.score`、CPU視点)が
 *   `moveEvalHistory`へ記録され、評価バーに「あなた視点へ反転」した値が
 *   キャプション付きで表示される。同時に「打った手の評価値」折れ線グラフの
 *   点数が増える(人間の手+CPUの手で2点、初期局面ぶんと合わせて3点)。
 * - (b) CPUが定石ブック手で応手した場合(探索していない)、評価バーは数値の
 *   代わりに「定石」を表示する。
 *
 * `requestCpuMove`(`game/gameLoop.ts`)は実物を使い、`requestAnalyze`の
 * モック応答(`score`)がそのまま`app.tsx`のCPU着手effectへ配線されることを
 * 実際の`<App/>`を通して検証する(単体レベルの符号変換・データ構造自体は
 * `components/moveEvalTimeline.test.ts`・`game/gameLoop.test.ts`で別途担保済み)。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・盤面の
 * canvas描画(`Board`)は、このリポジトリのvitest環境では動かせないためモックに
 * 差し替える(`app.playmode.undo.test.tsx`と同じ方針)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import { legalMoves, squareToNotation, type Board as BoardState, type Side } from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

/** `true`にすると、CPUの応手を「現局面で合法などれかの手」のブック手として即時確定させる(探索なし)。既定は`false`(探索フォールバック)。 */
let useCpuBookMove = false
/** CPUの探索応手(`requestAnalyze`)が返す評価値(CPU視点)。テストごとに差し替える。 */
let cpuScore: { discDiff: number; type: 'midgame' | 'exact' } = { discDiff: 0, type: 'midgame' }

vi.mock('./components/Board.tsx', () => ({
  Board: ({ board, sideToMove, onMove }: { board: BoardState; sideToMove: Side; onMove?: (square: number) => void }) => (
    <div data-testid="stub-board">
      {legalMoves(board, sideToMove).map((sq) => (
        <button
          key={sq}
          type="button"
          data-testid={`stub-board-play-${squareToNotation(sq)}`}
          onClick={() => onMove?.(sq)}
        >
          play {squareToNotation(sq)}
        </button>
      ))}
    </div>
  ),
  FLIP_ANIMATION_MS: 0,
  DISPLAY_GAP_MS: 0,
}))

/** すべての合法手を評価値0(mover視点)で並べる(このテストの関心事はCPUのscore配線のみ)。 */
function movesForBoard(board: BoardState, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((sq) => ({ move: squareToNotation(sq), score: 0, discDiff: 0, type: 'midgame' as const }))
}

vi.mock('./engine/sharedClient.ts', () => {
  return {
    getSharedEngineClient: () => ({
      requestAnalyze: (board: BoardState, side: Side) => {
        const first = legalMoves(board, side)[0]
        const pv = first === undefined ? [] : [squareToNotation(first)]
        return Promise.resolve<AnalyzeResponseMessage>({
          id: 0,
          final: true,
          depth: 1,
          pv,
          score: cpuScore,
          nodes: 0,
          nps: 0,
        })
      },
      requestAnalyzeAll: (board: BoardState, side: Side) => Promise.resolve(movesForBoard(board, side)),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/selectCpuBookMove.ts', () => ({
  selectCpuBookMove: (_db: JosekiDb, board: BoardState, side: Side) =>
    useCpuBookMove ? (legalMoves(board, side)[0] ?? null) : null,
}))

vi.mock('./joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  loadOpeningBookDb: () => Promise.resolve({} as JosekiDb),
  // このテストでは人間の着手の定石判定は関心事ではないため、常にDB外(null)にする。
  lookupJosekiNode: () => null,
}))

async function flushAsyncEffects(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T197: 対局モード(CPU対戦)の評価バー・折れ線グラフ', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    useCpuBookMove = false
    cpuScore = { discDiff: 0, type: 'midgame' }
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  async function renderAndStartCpuGame(): Promise<void> {
    const { App } = await import('./app.tsx')

    await act(async () => {
      render(<App />, container)
    })

    const playCard = Array.from(container.querySelectorAll<HTMLButtonElement>('.title-screen__card')).find((btn) =>
      btn.textContent?.includes('対局'),
    )
    expect(playCard).toBeDefined()
    await act(async () => {
      playCard?.click()
    })
    await flushAsyncEffects()

    const blackButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '黒番で開始',
    )
    expect(blackButton).toBeDefined()
    await act(async () => {
      blackButton?.click()
    })
    await flushAsyncEffects()
  }

  it('CPUがまだ応手していない間、評価バーは中立(「まだ相手の手がありません」)', async () => {
    await renderAndStartCpuGame()

    expect(container.querySelector('.play-eval-bar__caption')?.textContent).toBe(
      '相手の直前の手の評価(あなた視点、+ならあなた有利)',
    )
    expect(container.querySelector('.play-eval-bar__note')?.textContent).toBe('まだ相手の手がありません')
    expect(container.querySelector('.midgame-eval-bar__label')).toBeNull()
    // まだ1手も打たれていないのでグラフも表示されない。
    expect(container.querySelector('.play-eval-graph')).toBeNull()
  })

  it('CPUが探索で応手すると、評価値(response.score)があなた視点へ反転してバーに表示され、グラフの点が増える', async () => {
    // CPU(白)は自分視点で-5(=黒が5石有利)と評価した、という想定。
    cpuScore = { discDiff: -5, type: 'midgame' }
    await renderAndStartCpuGame()

    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid^="stub-board-play-"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects()

    // あなた(黒)視点へ反転: -(-5) = +5。
    expect(container.querySelector('.midgame-eval-bar__label')?.textContent).toBe('+5')
    expect(container.querySelector('.play-eval-bar__note')).toBeNull()

    // 折れ線グラフ: 初期局面(ply0)+人間の手(ply1)+CPUの手(ply2)の3点。
    const points = container.querySelectorAll('.eval-graph__point')
    expect(points.length).toBe(3)
  })

  it('CPUが定石ブック手で応手すると(探索していない)、評価バーは数値の代わりに「定石」を表示する', async () => {
    useCpuBookMove = true
    await renderAndStartCpuGame()

    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid^="stub-board-play-"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.play-eval-bar__note')?.textContent).toBe('定石')
    expect(container.querySelector('.midgame-eval-bar__label')).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * T132: 対局モードの「この対局を棋譜解析で振り返る」ボタンから
 * 棋譜解析モードへの遷移をテストする(受け入れ基準: 遷移のコンポーネントテスト)。
 *
 * 実際のオセロは終局(`phase: 'over'`)まで最短でも多数の着手を要し、UIクリックで
 * 現実的な終局を再現するのは非実用的なため、その関心事(`game/gameLoop.ts`の
 * `playMove`が実際に正しく終局判定するか)は`gameLoop.test.ts`が別途担保している。
 * 本テストでは`playMove`だけを「1手打つと即座に終局する」決定的な振る舞いに
 * 差し替え、本タスクで実際に書いた統合コード(着手履歴の記録・ボタンの表示条件・
 * `App`を経由したモード遷移・`AnalysisMode`側の自動解析開始)だけを検証する。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・
 * 盤面のcanvas描画(`Board`)はこのリポジトリのvitest環境では動かせないため、
 * `app.playmode.test.tsx`(T115)と同じ方針でモックに差し替える。
 * 棋譜解析側のIndexedDBキャッシュ(`analysis/cache.ts`)は`fake-indexeddb/auto`で
 * グローバルの`indexedDB`を差し替えて実物を動かす(`tsume/PlayMode.test.tsx`と同じ方針)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import type { GameState } from './game/gameLoop.ts'
import { notationToSquare } from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

// 対局モードのスタブ盤面が常にこのマスへ着手する(d3、実在の合法初手)。
const D3 = notationToSquare('d3')

vi.mock('./components/Board.tsx', () => ({
  // 実物はcanvasに描画するが、jsdomはcanvas 2D描画に対応していないため、
  // クリックでd3(square=D3)に着手できるだけの最小スタブに差し替える(T115と同じ方針)。
  Board: ({ onMove }: { onMove?: (square: number) => void }) => (
    <button type="button" data-testid="stub-board-play-d3" onClick={() => onMove?.(D3)}>
      play d3
    </button>
  ),
  FLIP_ANIMATION_MS: 0,
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
  // 対局モードの評価表示(evaluateHumanMove・候補手オーバーレイ)と棋譜解析
  // (analyzeGame)の両方から呼ばれるが、いずれも'd3'を含む1手ぶんの評価があれば
  // 十分なため、引数によらず同じ固定応答を返す。
  const allMoves: MoveEvalJson[] = [{ move: 'd3', score: 0, discDiff: 0, type: 'midgame' }]
  return {
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: () => Promise.resolve(allMoves),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/lookup.ts', () => ({
  // 中身は使われない(定石DAGの中身に依存しないテストのため)。
  // ロード完了→`josekiDbReady`をtrueにする経路だけ再現できればよい。
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  lookupJosekiNode: () => null,
}))

// `playMove`だけを「1手打つと即座に終局する」決定的な振る舞いに差し替える
// (ファイル先頭コメント参照)。`createGame`/`createGameFromPosition`/
// `requestCpuMove`等それ以外は実物のまま使う(`importOriginal`、
// `tsume/PlayMode.stageProgressTiming.test.tsx`と同じ方針)。
vi.mock('./game/gameLoop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./game/gameLoop.ts')>()
  return {
    ...actual,
    playMove: (state: GameState, square: number): GameState => {
      if (state.phase === 'over') return state
      return {
        ...state,
        lastMove: square,
        phase: 'over',
        passMessage: null,
        result: 'black',
      }
    },
  }
})

/** `flushAsyncEffects`(T115由来): Promiseチェーン越しのstate更新を数ラウンド分待つ。 */
async function flushAsyncEffects(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T132: 対局終了後の「この対局を棋譜解析で振り返る」導線', () => {
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
  })

  it('ボタン押下でAnalysisModeに棋譜が渡り、解析が自動的に開始される', async () => {
    const { App } = await import('./app.tsx')

    await act(async () => {
      render(<App />, container)
    })

    // タイトル画面から「対局」モードへ遷移する。
    const playCard = Array.from(container.querySelectorAll<HTMLButtonElement>('.title-screen__card')).find((btn) =>
      btn.textContent?.includes('対局'),
    )
    expect(playCard).toBeDefined()
    await act(async () => {
      playCard?.click()
    })
    await flushAsyncEffects()

    // 2人対戦(標準初期局面・黒番)で開始する。
    const vsHumanButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '2人対戦で開始',
    )
    expect(vsHumanButton).toBeDefined()
    await act(async () => {
      vsHumanButton?.click()
    })
    await flushAsyncEffects()

    // まだ対局中なので「振り返る」ボタンは出ていない。
    expect(
      Array.from(container.querySelectorAll('button')).some((btn) =>
        btn.textContent?.includes('この対局を棋譜解析で振り返る'),
      ),
    ).toBe(false)

    // d3に着手する(モック済みplayMoveにより、この1手で即座に終局する)。
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.status')?.textContent).toContain('対局終了')

    const reviewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('この対局を棋譜解析で振り返る'),
    )
    expect(reviewButton).toBeDefined()

    await act(async () => {
      reviewButton?.click()
    })
    await flushAsyncEffects()

    // 棋譜解析モードへ切り替わっている。
    const analysisTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.mode-nav__tab')).find(
      (btn) => btn.textContent === '棋譜解析',
    )
    expect(analysisTab?.getAttribute('aria-current')).toBe('page')

    // 'd3'の解析が自動的に開始され、完了している(手入力・手動並べを経由していない)。
    expect(container.textContent).toContain('解析完了: 1手')
    const movelistCells = Array.from(container.querySelectorAll('td'))
    expect(movelistCells.some((td) => td.textContent === 'd3')).toBe(true)
  })
})

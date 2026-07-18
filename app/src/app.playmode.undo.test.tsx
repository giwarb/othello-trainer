// @vitest-environment jsdom
/**
 * T140: 対局モードの「1手戻る」(研究用)の統合テスト。
 *
 * ユーザー指示(2026-07-19朝)「対局では研究もしたいので、1手戻るの機能もつけて
 * ほしい」への対応。`moveHistory`(T132)を正として初期局面から履歴prefixを
 * リプレイする実装方針(`game/gameHistory.ts`の`computeUndoLength`/`replayMoves`、
 * 純粋関数としてのユニットテストは`game/gameHistory.test.ts`側で担保済み)を、
 * 実際の`<App/>`(対局モード)を通した統合シナリオで検証する。
 *
 * カバーする受け入れ基準:
 * - CPU戦で4手(human, cpu, human, cpu)進めてundo → 1手目直後(2手目=CPU応手まで)の
 *   自分の手番に戻る。undo後に「振り返る」で得られる棋譜がundo後の履歴と一致する
 *   (moveHistoryの整合性)。
 * - CPUが思考中(応手が未解決)でもundoでき、その場合は自分の直前の手のみ取り消され、
 *   後から遅れて解決したCPU応手は適用されない(対局世代ガード)。
 * - 2人対戦は1ply戻す。undo後に定石トレース表示が正しく再計算される(離脱後の
 *   「(離脱)」表示がundoで解消され、再度アクティブな表示に戻る)。
 * - 履歴が空なら非活性。
 * - 終局後(投了含む)でもundoできる。
 * - 盤面自由配置(非標準初期局面)の対局ではボタン自体を出さない。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・盤面の
 * canvas描画(`Board`)は、このリポジトリのvitest環境では動かせないためモックに
 * 差し替える(既存の`app.playmode.*.test.tsx`と同じ方針)。`Board`のスタブは
 * 固定のマス番号ではなく、実物の`legalMoves`を使って現局面の合法手ぶんだけ
 * ボタンを描画する(`app.playmode.evalDisplay.test.tsx`と同じ方針)。
 *
 * CPUの応手は「現局面の合法手のうち`legalMoves`が返す先頭のマス」を選ぶよう
 * `requestAnalyze`をモックし、人間側の操作も同じ「先頭の合法手ボタンをクリック」に
 * 揃えることで、両者が常に同じ規則で決定的に進むようにする(具体的な記法を
 * ハードコードせず、実ロジック(`applyMove`/`legalMoves`)で追跡できるようにする)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import {
  applyMove,
  countDiscs,
  initialBoard,
  legalMoves,
  notationToSquare,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from './game/othello.ts'
import type { JosekiDb, JosekiNode } from './joseki/types.ts'

/** 初期局面からの着手数(黒+白の石数-4)。`app.tsx`の`josekiTrace`エフェクトと同じ定義。 */
function plyOf(board: BoardState): number {
  return countDiscs(board, 'black') + countDiscs(board, 'white') - 4
}

vi.mock('./components/Board.tsx', () => ({
  Board: ({
    board,
    sideToMove,
    lastMove,
    onMove,
  }: {
    board: BoardState
    sideToMove: Side
    lastMove: number | null
    onMove?: (square: number) => void
  }) => (
    <div data-testid="stub-board" data-side-to-move={sideToMove} data-last-move={lastMove ?? 'null'}>
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

// T140: CPU応手の解決タイミングを手動で制御したいテスト(思考中undo)専用に、
// `deferNextAnalyze`をtrueにした状態で`requestAnalyze`を呼ぶと、即座には解決せず
// `pendingAnalyzeResolve`にresolve関数を退避するだけのPromiseを返す。他のテストは
// 通常どおり即座に解決する(「現局面の合法手の先頭」を選ぶ)。
let deferNextAnalyze = false
let pendingAnalyzeResolve: ((response: AnalyzeResponseMessage) => void) | null = null

function movesForBoard(board: BoardState, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((sq) => ({
    move: squareToNotation(sq),
    score: 0,
    discDiff: 0,
    type: 'midgame' as const,
  }))
}

vi.mock('./engine/sharedClient.ts', () => {
  return {
    getSharedEngineClient: () => ({
      requestAnalyze: (board: BoardState, side: Side) => {
        if (deferNextAnalyze) {
          deferNextAnalyze = false
          return new Promise<AnalyzeResponseMessage>((resolve) => {
            pendingAnalyzeResolve = resolve
          })
        }
        const first = legalMoves(board, side)[0]
        const pv = first === undefined ? [] : [squareToNotation(first)]
        return Promise.resolve<AnalyzeResponseMessage>({
          id: 0,
          final: true,
          depth: 1,
          pv,
          score: { type: 'midgame', discDiff: 0 },
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
  // 定石ブックは既定でONだが、常にnullを返し、必ず上のrequestAnalyzeモック
  // (先頭の合法手を選ぶ)経由でCPUの応手を確定させる(`app.playmode.cpuHistory.test.tsx`
  // と同じ方針)。
  selectCpuBookMove: () => null,
}))

vi.mock('./joseki/lookup.ts', () => {
  const F5 = notationToSquare('f5')
  return {
    loadJosekiDb: () => Promise.resolve({} as JosekiDb),
    // `app.playmode.evalDisplay.test.tsx`(T138)と同じ方針: ply=0はf5だけが
    // ブック手、ply=1(黒がf5を打った直後の白番)は「兎」ラインの途中とみなし
    // 白の合法手すべてを継続候補として返す。それ以外(ply>=2)はDB外(null)。
    lookupJosekiNode: (_db: JosekiDb, board: BoardState, side: Side, _firstMoveSquare: number) => {
      const ply = plyOf(board)
      if (ply === 0) {
        return { node: {} as JosekiNode, isLeaf: false, names: ['ダミー'], bookMoves: [{ move: F5, weight: 1 }] }
      }
      if (ply === 1) {
        const moves = legalMoves(board, side)
        return {
          node: {} as JosekiNode,
          isLeaf: false,
          names: ['兎'],
          bookMoves: moves.map((move) => ({ move, weight: 1 / moves.length })),
        }
      }
      return null
    },
  }
})

/** Promiseチェーン越しのstate更新を数ラウンド分待つ(`app.playmode.test.tsx`(T115)と同じ方針)。 */
async function flushAsyncEffects(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function findButtonByText(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) => btn.textContent === text)
}

/**
 * 現局面の合法手のうち`legalMoves`が返す先頭のマスに着手するボタンをクリックし、
 * 実際にクリックしたマス(数値)を返す(`legalMoves`の内部順序に依存しないよう、
 * 呼び出し側はこの戻り値を使って期待局面を計算する)。
 */
async function clickFirstLegalMove(container: HTMLDivElement): Promise<number> {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid^="stub-board-play-"]')
  expect(btn).not.toBeNull()
  const testId = btn?.getAttribute('data-testid') ?? ''
  const notation = testId.replace('stub-board-play-', '')
  const square = notationToSquare(notation)
  await act(async () => {
    btn?.click()
  })
  return square
}

function boardStubLastMove(container: HTMLDivElement): string | null {
  const value = container.querySelector('[data-testid="stub-board"]')?.getAttribute('data-last-move') ?? null
  return value === 'null' ? null : value
}

function statusText(container: HTMLDivElement): string {
  return container.querySelector('.status')?.textContent ?? ''
}

async function startBlackGame(container: HTMLDivElement): Promise<void> {
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
  await flushAsyncEffects()

  const blackButton = findButtonByText(container, '黒番で開始')
  expect(blackButton).toBeDefined()
  await act(async () => {
    blackButton?.click()
  })
  await flushAsyncEffects()
}

async function startVsHumanGame(container: HTMLDivElement): Promise<void> {
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
  await flushAsyncEffects()

  const vsHumanButton = findButtonByText(container, '2人対戦で開始')
  expect(vsHumanButton).toBeDefined()
  await act(async () => {
    vsHumanButton?.click()
  })
  await flushAsyncEffects()
}

describe('T140: 対局モード「1手戻る」', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    deferNextAnalyze = false
    pendingAnalyzeResolve = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('sanity: f5(黒)は初期局面で実際に合法手である(joseki lookupモックの前提を裏取りする)', () => {
    expect(legalMoves(initialBoard(), 'black')).toContain(notationToSquare('f5'))
  })

  it('履歴が空の間は非活性(disabled)で表示される', async () => {
    await startBlackGame(container)

    const undoButton = findButtonByText(container, '1手戻る')
    expect(undoButton).toBeDefined()
    expect(undoButton?.disabled).toBe(true)
  })

  it('盤面自由配置(非標準初期局面、次の手番=白)の対局ではボタン自体を表示しない', async () => {
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
    await flushAsyncEffects()

    const editorButton = findButtonByText(container, '盤面を自由に配置して開始')
    expect(editorButton).toBeDefined()
    await act(async () => {
      editorButton?.click()
    })

    // 「次の手番」を白に切り替える(盤面はそのままでも`isStandardStartPosition`は
    // 手番が黒でなければfalseになる)。
    const whiteRadio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(
      (input) => input.name === 'board-editor-side-to-move' && input.closest('label')?.textContent?.trim() === '白',
    )
    expect(whiteRadio).toBeDefined()
    await act(async () => {
      whiteRadio?.click()
    })

    const startFromEditorButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (btn) => btn.textContent === '黒番で開始',
    )
    // セットアップカードの「新規対局」行とエディタ行の両方に同名ボタンがあるため、
    // 後半(エディタ行)のものを使う。
    const editorStartButton = startFromEditorButton[startFromEditorButton.length - 1]
    expect(editorStartButton).toBeDefined()
    await act(async () => {
      editorStartButton?.click()
    })
    await flushAsyncEffects()

    expect(findButtonByText(container, '1手戻る')).toBeUndefined()
  })

  it(
    'CPU戦: 4手(human, cpu, human, cpu)進めてundo → 1手目直後(2手目のCPU応手まで)の' +
      '自分の手番に戻る。undo後に「振り返る」で得られる棋譜がundo後の履歴と一致する',
    async () => {
      await startBlackGame(container)

      // 1手目(黒・人間): 先頭の合法手(実際にクリックしたマスを追跡する)。
      const humanMove1 = await clickFirstLegalMove(container)
      await flushAsyncEffects() // CPU(白)の応手(2手目)が解決する

      const board1 = applyMove(initialBoard(), 'black', humanMove1)
      const cpuMove2 = legalMoves(board1, 'white')[0]!
      expect(boardStubLastMove(container)).toBe(String(cpuMove2))

      const board2 = applyMove(board1, 'white', cpuMove2)

      // 3手目(黒・人間)。
      await clickFirstLegalMove(container)
      await flushAsyncEffects() // CPU(白)の応手(4手目)が解決する

      const humanMove3 = legalMoves(board2, 'black')[0]!
      const board3 = applyMove(board2, 'black', humanMove3)
      const cpuMove4 = legalMoves(board3, 'white')[0]!
      expect(boardStubLastMove(container)).toBe(String(cpuMove4))
      expect(statusText(container)).toContain('手番: 黒')
      expect(statusText(container)).not.toContain('思考中')

      // 1手戻る: 3・4手目(自分の直前の手+CPUの応手)が取り消され、2手目
      // (1手目直後のCPU応手)までの局面・自分の手番に戻る。
      const undoButton = findButtonByText(container, '1手戻る')
      expect(undoButton?.disabled).toBe(false)
      await act(async () => {
        undoButton?.click()
      })

      expect(boardStubLastMove(container)).toBe(String(cpuMove2))
      expect(container.querySelector('[data-testid="stub-board"]')?.getAttribute('data-side-to-move')).toBe('black')
      expect(statusText(container)).toContain('手番: 黒')
      expect(statusText(container)).not.toContain('思考中')
      expect(statusText(container)).not.toContain('対局終了')

      // moveHistoryの整合性: 投了して「振り返る」から棋譜解析へ渡し、
      // undo後の履歴(1手目・CPUの応手2手のみ)がそのまま引き継がれていることを確認する。
      const resignButton = findButtonByText(container, '投了')
      expect(resignButton).toBeDefined()
      await act(async () => {
        resignButton?.click()
      })

      const reviewButton = findButtonByText(container, 'この対局を棋譜解析で振り返る')
      expect(reviewButton).toBeDefined()
      await act(async () => {
        reviewButton?.click()
      })
      await flushAsyncEffects()

      const analysisTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.mode-nav__tab')).find(
        (btn) => btn.textContent === '棋譜解析',
      )
      expect(analysisTab?.getAttribute('aria-current')).toBe('page')

      // undo前は4手だったが、undo後の履歴(2手: 1手目とCPUの応手)だけが引き継がれる。
      expect(container.textContent).toContain('解析完了: 2手')
      const movelistCells = Array.from(container.querySelectorAll('td')).map((td) => td.textContent)
      expect(movelistCells).toContain(squareToNotation(humanMove1))
      expect(movelistCells).toContain(squareToNotation(cpuMove2))
      expect(movelistCells).not.toContain(squareToNotation(humanMove3))
      expect(movelistCells).not.toContain(squareToNotation(cpuMove4))
    },
  )

  it(
    'CPUが思考中(応手未解決)でもundoできる(自分の直前の手のみ取り消し)。' +
      '後から遅れて解決したCPU応手は対局世代ガードにより適用されない',
    async () => {
      await startBlackGame(container)

      deferNextAnalyze = true
      const humanMove1 = await clickFirstLegalMove(container) // 1手目(黒・人間)
      await flushAsyncEffects()

      // CPUがまだ応手していない(pendingAnalyzeResolveが退避されている=思考中)。
      expect(pendingAnalyzeResolve).not.toBeNull()
      expect(boardStubLastMove(container)).toBe(String(humanMove1))
      expect(statusText(container)).toContain('思考中')

      const undoButton = findButtonByText(container, '1手戻る')
      expect(undoButton?.disabled).toBe(false)
      await act(async () => {
        undoButton?.click()
      })

      // 自分の直前の手(1手目)のみが取り消され、初期局面・履歴なしに戻る。
      expect(boardStubLastMove(container)).toBeNull()
      expect(statusText(container)).toContain('手番: 黒')
      expect(statusText(container)).not.toContain('思考中')
      expect(findButtonByText(container, '1手戻る')?.disabled).toBe(true)

      // 遅れてCPUの応手(任意の合法手)が解決しても、対局世代が
      // 食い違うため適用されない(盤面・履歴とも初期局面のまま)。
      const staleReply = legalMoves(applyMove(initialBoard(), 'black', humanMove1), 'white')[0]!
      await act(async () => {
        pendingAnalyzeResolve?.({
          id: 0,
          final: true,
          depth: 1,
          pv: [squareToNotation(staleReply)],
          score: { type: 'midgame', discDiff: 0 },
          nodes: 0,
          nps: 0,
        })
      })
      await flushAsyncEffects()

      expect(boardStubLastMove(container)).toBeNull()
      expect(statusText(container)).toContain('手番: 黒')
      expect(statusText(container)).not.toContain('思考中')
      expect(statusText(container)).not.toContain('対局終了')
      expect(findButtonByText(container, '1手戻る')?.disabled).toBe(true)
    },
  )

  it('2人対戦は1ply戻す。undo後、定石トレース表示が正しく再計算される(離脱後の表示がundoで解消される)', async () => {
    await startVsHumanGame(container)

    const f5Button = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-f5"]')
    expect(f5Button).not.toBeNull()
    await act(async () => {
      f5Button?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.joseki-trace')?.textContent).toBe('定石: 兎(1手目)')

    // 白が応手する(先頭の合法手、モック上はすべて定石の継続扱い)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()

    // ply=2は定石DB外(モック上null)のため離脱扱いになる。
    expect(container.querySelector('.joseki-trace')?.textContent).toBe('定石: 兎(1手目)(離脱)')

    const undoButton = findButtonByText(container, '1手戻る')
    expect(undoButton?.disabled).toBe(false)
    await act(async () => {
      undoButton?.click()
    })
    await flushAsyncEffects()

    // 1ply戻ったのでply=1(黒がf5を打った直後の白番)に戻り、定石トレースは
    // 「(離脱)」が外れ、再びアクティブな表示に戻る(undo後の再計算の整合性)。
    expect(boardStubLastMove(container)).toBe(String(notationToSquare('f5')))
    expect(container.querySelector('.joseki-trace')?.textContent).toBe('定石: 兎(1手目)')
  })

  it('終局後(投了)でもundoできる', async () => {
    await startBlackGame(container)

    await clickFirstLegalMove(container) // 1手目(黒・人間)
    await flushAsyncEffects() // CPU(白)の応手が解決する

    const resignButton = findButtonByText(container, '投了')
    expect(resignButton).toBeDefined()
    await act(async () => {
      resignButton?.click()
    })
    expect(statusText(container)).toContain('対局終了')

    const undoButton = findButtonByText(container, '1手戻る')
    expect(undoButton).toBeDefined()
    expect(undoButton?.disabled).toBe(false)
    await act(async () => {
      undoButton?.click()
    })

    // 人間+CPUの応手ペア(1手目+その応手)がまとめて取り消され、初期局面・
    // 対局続行中の状態に戻る(終局状態が解消される)。
    expect(boardStubLastMove(container)).toBeNull()
    expect(statusText(container)).not.toContain('対局終了')
    expect(statusText(container)).toContain('手番: 黒')
    expect(findButtonByText(container, '1手戻る')?.disabled).toBe(true)
  })
})

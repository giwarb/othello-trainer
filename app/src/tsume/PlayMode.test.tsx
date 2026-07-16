// @vitest-environment jsdom
/**
 * T118: 詰めオセロ、終局時に最終盤面を残したまま結果を表示する不具合の回帰テスト。
 *
 * 原因(タスクファイル`tasks/T118-tsume-result-board.md`のexplorer調査より):
 * `ClearResultInfo`に`board`フィールドが無く、クリア結果セクションのJSXに
 * `<Board>`が描画されなかった。加えて、相手の手番で終局する経路(相手の着手を
 * 処理する`useEffect`)・人間の手番で終局する経路(`handlePlayerMove`)の
 * どちらも、最終手を適用した`nextSession`を`setSession`せずに`finishClear`へ
 * 直行しており、そもそも画面上の盤面stateが最終手適用後の状態に更新されて
 * いなかった。
 *
 * 修正: `ClearResultInfo`に最終盤面(`board`・`sideToMove`・`lastMove`)を持たせ、
 * `finishClear`がその情報を`resultInfo`にそのまま渡すようにした上で、クリア
 * 結果セクションに`<Board>`を追加した。
 *
 * 本テストは、相手番終局・人間番終局の両方の経路で、実際に結果画面へ渡される
 * `<Board>`のprops(盤面・最終手)が「最終手適用後」の状態になっていることを、
 * 実際のオセロ盤面ロジック(`game/othello.ts`、モックしない)を使って検証する。
 *
 * WASM Worker(`getSharedEngineClient`)・盤面のcanvas描画(`Board`、jsdomはcanvas
 * 2D描画に対応していない)・問題プールのfetch(`loadPuzzles`)はモックする
 * (`app/src/app.playmode.test.tsx`と同じ方針)。IndexedDBへの成績記録
 * (`tsume/stats.ts`)は`fake-indexeddb/auto`でグローバルの`indexedDB`を
 * ポリフィルし、実際のコードパスをそのまま実行する。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bigintToHex } from '../engine/hex.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { createBoard, notationToSquare, type Board as BoardState, type Side } from '../game/othello.ts'
import type { Puzzle, PuzzleFile } from './types.ts'

/** 直近にモックの`<Board>`へ渡された主要propsのスナップショット。 */
interface CapturedBoardProps {
  readonly board: BoardState
  readonly sideToMove: Side
  readonly lastMove: number | null
  readonly hasOnMove: boolean
}

let lastBoardProps: CapturedBoardProps | null = null
/** 次に盤面スタブがクリックされたときに`onMove`へ渡すマス(未設定なら無視)。 */
let clickSquare: number | null = null

vi.mock('../components/Board.tsx', () => ({
  Board: (props: {
    board: BoardState
    sideToMove: Side
    lastMove?: number | null
    onMove?: (square: number) => void
  }) => {
    lastBoardProps = {
      board: props.board,
      sideToMove: props.sideToMove,
      lastMove: props.lastMove ?? null,
      hasOnMove: props.onMove !== undefined,
    }
    return (
      <button
        type="button"
        data-testid="stub-board"
        onClick={() => {
          if (clickSquare !== null) props.onMove?.(clickSquare)
        }}
      >
        board
      </button>
    )
  },
}))

/** `side`ごとに`requestAnalyzeAll`が返す`MoveEvalJson[]`(テストごとに設定する)。 */
let analyzeAllResponses: { black: MoveEvalJson[]; white: MoveEvalJson[] } = { black: [], white: [] }

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (_board: unknown, side: Side) =>
      Promise.resolve(side === 'black' ? analyzeAllResponses.black : analyzeAllResponses.white),
    requestAnalyze: () => Promise.reject(new Error('T118テストでは使用しない')),
    terminate: () => {},
  }),
}))

let currentPuzzle: Puzzle | null = null

vi.mock('./loadPuzzles.ts', () => ({
  loadPuzzles: () =>
    Promise.resolve<PuzzleFile>({
      generatedAt: '2026-07-17T00:00:00.000Z',
      puzzles: currentPuzzle ? [currentPuzzle] : [],
    }),
}))

function makePuzzle(board: BoardState, sideToMove: Side, correctMoves: readonly string[]): Puzzle {
  return {
    id: 'T118-test-puzzle',
    board: { black: bigintToHex(board.black), white: bigintToHex(board.white) },
    sideToMove,
    empties: 60,
    correctMoves,
    bestDiscDiff: 64,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty: 1,
    difficultyRawScore: 0,
    tags: [],
  }
}

/** `act()`でラップしつつ`ms`ミリ秒(実時間)待つ。オセロ側の`setTimeout`(相手の着手演出等)を実際に経過させるために使う。 */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/** マイクロタスク・短い`setTimeout(0)`チェーン越しのstate更新を数ラウンド分待つ(`app.playmode.test.tsx`と同じ手法)。 */
async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T118: 詰めオセロ、終局時の最終盤面の保持', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    lastBoardProps = null
    clickSquare = null
    currentPuzzle = null
    analyzeAllResponses = { black: [], white: [] }
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  /** 設定画面から「ランダムに出題」で出題を開始する(プールは常に1問なので決定的)。 */
  async function startRandomPuzzle(): Promise<void> {
    const { PlayMode } = await import('./PlayMode.tsx')
    await act(async () => {
      render(<PlayMode />, container)
    })
    await flushAsyncEffects()

    const randomButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('ランダムに出題'),
    )
    expect(randomButton).toBeDefined()
    await act(async () => {
      randomButton?.click()
    })
    await flushAsyncEffects()
  }

  it('人間の着手で終局する場合、結果画面に最終手適用後の盤面が残る', async () => {
    // 盤面: d4(空、黒の唯一の合法手) - e4(白) - f4(黒)。
    // 黒がd4に着手するとe4が黒に返り、盤上の石はd4・e4・f4の黒のみになる
    // (白石が0枚になるため、双方合法手なしで即座に終局する = 人間の着手で
    // 終局する経路)。
    const d4 = notationToSquare('d4')
    const e4 = notationToSquare('e4')
    const f4 = notationToSquare('f4')
    const board = createBoard([f4], [e4])
    currentPuzzle = makePuzzle(board, 'black', ['d4'])
    analyzeAllResponses = {
      black: [{ move: 'd4', score: 6400, discDiff: 64, type: 'exact' }],
      white: [],
    }

    await startRandomPuzzle()

    clickSquare = d4
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.tsume-result--clear')).not.toBeNull()
    expect(lastBoardProps).not.toBeNull()
    // 結果画面の盤面はクリック不可(onMoveが渡されない)。
    expect(lastBoardProps?.hasOnMove).toBe(false)
    expect(lastBoardProps?.lastMove).toBe(d4)
    expect(lastBoardProps?.board.white).toBe(0n)
    expect(lastBoardProps?.board.black).toBe((1n << BigInt(d4)) | (1n << BigInt(e4)) | (1n << BigInt(f4)))
  })

  it('相手(エンジン)の着手で終局する場合、結果画面に相手の最終手適用後の盤面が残る', async () => {
    // 2つの独立した局所領域を持つ盤面:
    // - 領域A(黒の着手用): c4(空) - d4(白) - e4(黒)。黒がc4に着手するとd4が
    //   黒に返る。
    // - 領域B(白の着手用、黒の着手後に解決): e8(空) - f8(黒) - g8(白)。
    //   白がe8に着手するとf8が白に返る。
    // 白の着手が終わった時点で、盤上の黒石(c4,d4,e4)と白石(e8,f8,g8)は互いに
    // 隣接しておらず、双方とも合法手を持たないため、白の着手(相手の応手)で
    // 終局する。
    const c4 = notationToSquare('c4')
    const d4 = notationToSquare('d4')
    const e4 = notationToSquare('e4')
    const e8 = notationToSquare('e8')
    const f8 = notationToSquare('f8')
    const g8 = notationToSquare('g8')
    const board = createBoard([e4, f8], [d4, g8])
    currentPuzzle = makePuzzle(board, 'black', ['c4'])
    analyzeAllResponses = {
      black: [{ move: 'c4', score: 6400, discDiff: 64, type: 'exact' }],
      white: [{ move: 'e8', score: 6400, discDiff: 64, type: 'exact' }],
    }

    await startRandomPuzzle()

    clickSquare = c4
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects()

    // ここでは黒の着手(c4)だけが適用され、白(相手)の応手はまだ演出待ち
    // (`OPPONENT_MOVE_DELAY_MS`)で確定していないはず。
    expect(container.querySelector('.tsume-result--clear')).toBeNull()

    // 相手の着手演出の遅延(350ms)を実時間で経過させてから解決を待つ。
    await wait(500)
    await flushAsyncEffects()

    expect(container.querySelector('.tsume-result--clear')).not.toBeNull()
    expect(lastBoardProps).not.toBeNull()
    expect(lastBoardProps?.hasOnMove).toBe(false)
    expect(lastBoardProps?.lastMove).toBe(e8)
    expect(lastBoardProps?.board.black).toBe((1n << BigInt(c4)) | (1n << BigInt(d4)) | (1n << BigInt(e4)))
    // f8はもともと黒だったが、白のe8着手で挟まれて白に返る。
    expect(lastBoardProps?.board.white).toBe((1n << BigInt(e8)) | (1n << BigInt(f8)) | (1n << BigInt(g8)))
  })
})

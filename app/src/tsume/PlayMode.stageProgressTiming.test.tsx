// @vitest-environment jsdom
/**
 * T117 redo #1回帰テスト: `localStorage`のステージ挑戦記録は、IndexedDB
 * (`tsume/stats.ts`の`recordAttempt`)の完了を待たずに、挑戦結果確定と
 * 同期的に書き込まれることを固定する。
 *
 * 原因(codex-review指摘、`tasks/review/T117-tsume-stage-select-codex-review.md`
 * (a)節・重大): 修正前は`PlayMode.tsx`の`saveAttempt`内で`recordAttempt`/
 * `getAllAttempts`(IndexedDB)を`await`した**後**に`recordStageAttempt`
 * (`localStorage`書き込み)を呼んでいたため、以下のレースが成立していた:
 * 1. クリア/失敗が確定 → 2. 結果画面が表示される → 3. IndexedDB保存が進行中
 * → 4. ユーザーが直後にリロード/離脱 → 5. `localStorage`への記録が
 * 書かれないまま失われる。これは要件3「出題経路を問わず挑戦結果を記録」と
 * 受け入れ基準「リロードしても記録が残っている」を通常操作で破りうる不具合
 * だった。
 *
 * 修正: `finishClear`/`finishFail`は、最初の`await`(IndexedDB保存)より前に
 * `recordStageProgressNow`(`localStorage.setItem`は同期API)を呼ぶように
 * 変更した(`PlayMode.tsx`参照)。
 *
 * 検証方法: `tsume/stats.ts`の`recordAttempt`を「意図的に解決しない
 * `Promise`」に差し替え、IndexedDB保存が未解決(pending)のままでも
 * `localStorage`に記録が書き込まれていることを確認する。これにより
 * 「IndexedDB保存が完了するまでlocalStorage記録が書かれない」という
 * 退行を機械的に検出できる(修正前のコードに対して本テストを実行すると、
 * `recordAttempt`が解決しない限り`localStorage`が更新されないため失敗する)。
 *
 * モック方針は`app/src/tsume/PlayMode.test.tsx`(T118)と同じ
 * (Board/engine/loadPuzzlesをスタブ化、実際の`game/othello.ts`ロジックで
 * 盤面を構成する)。IndexedDBは`fake-indexeddb`を使わず`./stats.ts`自体を
 * モックする(解決タイミングを完全に制御する必要があるため)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bigintToHex } from '../engine/hex.ts'
import type { MoveEvalJson } from '../engine/types.ts'
import { createBoard, notationToSquare, type Board as BoardState, type Side } from '../game/othello.ts'
import { TSUME_STAGE_PROGRESS_STORAGE_KEY } from './stageProgress.ts'
import type { Puzzle, PuzzleFile } from './types.ts'

/** 次に盤面スタブがクリックされたときに`onMove`へ渡すマス(未設定なら無視)。 */
let clickSquare: number | null = null

vi.mock('../components/Board.tsx', () => ({
  Board: (props: { onMove?: (square: number) => void }) => (
    <button
      type="button"
      data-testid="stub-board"
      onClick={() => {
        if (clickSquare !== null) props.onMove?.(clickSquare)
      }}
    >
      board
    </button>
  ),
}))

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (_board: unknown, _side: Side) =>
      Promise.resolve<MoveEvalJson[]>([{ move: 'd4', score: 6400, discDiff: 64, type: 'exact' }]),
    requestAnalyze: () => Promise.reject(new Error('T117 redoテストでは使用しない')),
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

/**
 * IndexedDB保存(`recordAttempt`)を意図的に解決させないための手動resolver
 * (本回帰テストの要)。`computeOverallStats`/`computeTagAccuracy`/
 * `pickWeightedPuzzle`等の純粋関数は`importOriginal`で実物をそのまま使う。
 */
let pendingRecordAttemptResolvers: Array<() => void> = []

vi.mock('./stats.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stats.ts')>()
  return {
    ...actual,
    recordAttempt: () =>
      new Promise<void>((resolve) => {
        pendingRecordAttemptResolvers.push(resolve)
      }),
    getAllAttempts: () => Promise.resolve([]),
  }
})

function makePuzzle(board: BoardState, sideToMove: Side, correctMoves: readonly string[]): Puzzle {
  return {
    id: 'T117-timing-test-puzzle',
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

/** マイクロタスク・短い`setTimeout(0)`チェーン越しのstate更新を数ラウンド分待つ(`PlayMode.test.tsx`と同じ手法)。 */
async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T117 redo #1: ステージ挑戦記録はIndexedDB保存の完了を待たずlocalStorageへ書かれる', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    clickSquare = null
    currentPuzzle = null
    pendingRecordAttemptResolvers = []
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    // 未解決のまま残った`recordAttempt`のPromiseを解決し、後続のstate更新
    // (setAttempts等)がアンマウント後に発生しないよう先に片付けてから
    // アンマウントする。
    pendingRecordAttemptResolvers.forEach((resolve) => resolve())
    pendingRecordAttemptResolvers = []
    await flushAsyncEffects(3)
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('IndexedDB保存(recordAttempt)が未解決のままでも、着手直後にlocalStorageのステージ記録が書き込まれている', async () => {
    // 盤面: d4(空、黒の唯一の合法手) - e4(白) - f4(黒)。黒がd4に着手すると
    // e4が黒に返り、白石が0枚になって即座に終局する(`PlayMode.test.tsx`の
    // 「人間の着手で終局する」ケースと同じ構成、T118参照)。
    const d4 = notationToSquare('d4')
    const e4 = notationToSquare('e4')
    const f4 = notationToSquare('f4')
    const board = createBoard([f4], [e4])
    currentPuzzle = makePuzzle(board, 'black', ['d4'])

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

    // 着手前: localStorageにはまだステージ記録が無い。
    expect(localStorage.getItem(TSUME_STAGE_PROGRESS_STORAGE_KEY)).toBeNull()

    clickSquare = d4
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects(3)

    // 前提確認: この時点でIndexedDB保存(recordAttempt)はまだ意図的に未解決。
    expect(pendingRecordAttemptResolvers.length).toBeGreaterThan(0)

    // 本題: IndexedDB保存が未完了のままでも、localStorageには既にステージ
    // 挑戦記録が書き込まれているはず(recordStageProgressNowが最初のawaitより
    // 前で同期的に実行されるため)。
    const raw = localStorage.getItem(TSUME_STAGE_PROGRESS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed: unknown = JSON.parse(raw!)
    expect(parsed).toMatchObject({
      'T117-timing-test-puzzle': {
        clearCount: 1,
        failCount: 0,
        lastResult: 'clear',
      },
    })

    // 結果画面自体も(IndexedDB未完了のまま)既に表示されている
    // (`finishClear`は`setPhase('result')`もIndexedDB awaitより前に行うため)。
    expect(container.querySelector('.tsume-result--clear')).not.toBeNull()
  })

  it('不正解(fail)でIndexedDB保存が未解決のままでも、localStorageにfailCountが記録される', async () => {
    // 2つの独立した局所領域を持つ盤面:
    // - 領域A: d4(空) - e4(白) - f4(黒)。黒がd4に着手するとe4が返る
    //   (requestAnalyzeAllのモックが常に返す「最善手はd4」と一致する手)。
    // - 領域B: a1(黒) - b1(白) - c1(空)。黒がc1に着手するとb1が返る
    //   (合法手ではあるが、モックの`allMoves`には含まれないため
    //   `judgePuzzleMove`が不正解と判定する)。
    const c1 = notationToSquare('c1')
    const a1 = notationToSquare('a1')
    const b1 = notationToSquare('b1')
    const e4 = notationToSquare('e4')
    const f4 = notationToSquare('f4')
    const board = createBoard([f4, a1], [e4, b1])
    currentPuzzle = makePuzzle(board, 'black', ['d4'])

    const { PlayMode } = await import('./PlayMode.tsx')
    await act(async () => {
      render(<PlayMode />, container)
    })
    await flushAsyncEffects()

    const randomButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('ランダムに出題'),
    )
    await act(async () => {
      randomButton?.click()
    })
    await flushAsyncEffects()

    // c1は盤面上の合法手ではあるが、requestAnalyzeAllのモックはc1を返さない
    // (=judgePuzzleMoveが`allMoves`にc1を見つけられず不正解と判定する)。
    clickSquare = c1
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')
    await act(async () => {
      boardStub?.click()
    })
    await flushAsyncEffects(3)

    expect(pendingRecordAttemptResolvers.length).toBeGreaterThan(0)

    const raw = localStorage.getItem(TSUME_STAGE_PROGRESS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed: unknown = JSON.parse(raw!)
    expect(parsed).toMatchObject({
      'T117-timing-test-puzzle': {
        clearCount: 0,
        failCount: 1,
        lastResult: 'fail',
      },
    })
    expect(container.querySelector('.tsume-result--fail')).not.toBeNull()
  })
})

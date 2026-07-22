// @vitest-environment jsdom
/**
 * T197 redo#1(重大指摘の再発防止テスト)。
 *
 * 対局モードの`evaluateHumanMove`(`app.tsx`)は非同期(`requestAnalyzeAll`の
 * `await`)であり、その解決前に`undoMove`/`prepareNewGame`が
 * `moveEvalHistory`を切り詰め・リセットすると、世代ガードが無い場合
 * (redo前のバグ)、遅れて解決したこの関数が古い`historyIndex`(既に
 * 切り詰められた配列の長さより大きい)へ書き込み、配列に穴(`undefined`要素)を
 * 作ってしまう。`buildEvalGraphPoints`(`components/moveEvalTimeline.ts`)は
 * 無条件に`entry.side`等へアクセスするため、この穴を読むと`TypeError`になり、
 * `app.tsx`にErrorBoundaryが無いため白画面クラッシュに至る。
 *
 * 修正(`gameGenerationRef`世代ガード、`app.tsx`の`evaluateHumanMove`/
 * `prepareNewGame`参照)後は、遅延解決が古い世代と判明した時点で
 * `upsertMoveEval`自体を呼ばずに早期returnするため、配列に穴ができず、
 * クラッシュもしない。本テストはその2つの経路(アンドゥ連打・新規対局)を
 * 実際の`<App/>`を通して検証する。
 *
 * `requestAnalyzeAll`(=`evaluateHumanMove`が呼ぶもの)だけを狙って遅延させる
 * ため、`deferNextAnalyzeAll`を一発ものの(1回だけ効く)フラグにする
 * (`app.playmode.undo.test.tsx`の`deferNextAnalyze`(CPU側`requestAnalyze`用)と
 * 同じ考え方)。CPUの応手(`requestAnalyze`)・候補手評価オーバーレイ用の
 * `requestAnalyzeAll`呼び出しは即座に解決させ、対象の1回だけを保留する。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoveEvalJson } from './engine/types.ts'
import {
  legalMoves,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

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

/** 現局面の全合法手を評価値0(mover視点)で並べる(このテストの関心事は競合検知のみ)。 */
function movesForBoard(board: BoardState, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((sq) => ({ move: squareToNotation(sq), score: 0, discDiff: 0, type: 'midgame' as const }))
}

/** `requestAnalyzeAll`(=`evaluateHumanMove`/候補手評価オーバーレイが呼ぶもの)を
 * 次の1回だけ保留にしたいときに`true`にする。保留中の解決関数は
 * `pendingAnalyzeAllResolve`に退避される(一発ものの`deferNextAnalyze`と同じ方針、
 * `app.playmode.undo.test.tsx`参照)。 */
let deferNextAnalyzeAll = false
let pendingAnalyzeAllResolve: (() => void) | null = null

vi.mock('./engine/sharedClient.ts', () => {
  return {
    getSharedEngineClient: () => ({
      // CPUの応手(`requestAnalyze`)は常に現局面の先頭の合法手を即座に返す
      // (`app.playmode.undo.test.tsx`と同じ決定的な方針)。
      requestAnalyze: (board: BoardState, side: Side) => {
        const first = legalMoves(board, side)[0]
        const pv = first === undefined ? [] : [squareToNotation(first)]
        return Promise.resolve({
          id: 0,
          final: true,
          depth: 1,
          pv,
          score: { type: 'midgame' as const, discDiff: 0 },
          nodes: 0,
          nps: 0,
        })
      },
      requestAnalyzeAll: (board: BoardState, side: Side) => {
        if (deferNextAnalyzeAll) {
          deferNextAnalyzeAll = false
          return new Promise<MoveEvalJson[]>((resolve) => {
            // 呼び出し時点の`board`/`side`をクロージャで保持し、後から
            // `pendingAnalyzeAllResolve()`で解決する(呼び出し元=
            // `evaluateHumanMove`の着手前局面に対応する、もっともらしい応答)。
            pendingAnalyzeAllResolve = () => resolve(movesForBoard(board, side))
          })
        }
        return Promise.resolve(movesForBoard(board, side))
      },
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/selectCpuBookMove.ts', () => ({
  selectCpuBookMove: () => null,
}))

vi.mock('./joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  loadOpeningBookDb: () => Promise.resolve({} as JosekiDb),
  lookupJosekiNode: () => null,
}))

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

/** 現局面の合法手のうち先頭のマスに着手する(決定的な進行、`undo.test.tsx`と同じ方針)。 */
async function clickFirstLegalMove(container: HTMLDivElement): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid^="stub-board-play-"]')
  expect(btn).not.toBeNull()
  await act(async () => {
    btn?.click()
  })
}

function boardStubLastMove(container: HTMLDivElement): string | null {
  // このファイルのBoardスタブは`lastMove`を描画しないため、代わりに`.status`
  // (sr-only、手番テキスト)と`.eval-graph__point`の個数で状態を確認する。
  return container.querySelector('[data-testid="stub-board"]')?.textContent ?? null
}

async function startBlackCpuGame(container: HTMLDivElement): Promise<void> {
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

describe('T197 redo#1: evaluateHumanMoveの遅延解決とundo/新規対局の競合(再発防止)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    deferNextAnalyzeAll = false
    pendingAnalyzeAllResolve = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('着手直後のアンドゥ連打→evaluateHumanMoveの遅延解決が古い世代のまま届いても、moveEvalHistoryに穴・混入ができずクラッシュしない', async () => {
    await startBlackCpuGame(container)

    // 1・2手目(黒・CPU)は通常どおり即座に解決させる(historyIndex 0,1)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()
    // 3・4手目(黒・CPU)も同様(historyIndex 2,3)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()

    // 5手目(黒、historyIndex=4)の`evaluateHumanMove`だけを遅延させる。
    deferNextAnalyzeAll = true
    await clickFirstLegalMove(container)
    expect(pendingAnalyzeAllResolve).not.toBeNull() // 遅延が実際に捕捉されたことの裏取り。
    // CPUの応手(historyIndex=5)は`requestAnalyze`経由(遅延対象外)なので、
    // ここで即座に解決させておく(moveEvalHistoryが[e0,e1,e2,e3,pending-e4,e5]になる)。
    await flushAsyncEffects()

    // アンドゥ連打(2回): CPU対戦は「自分の直前の手+CPUの応手」を1回で戻すため、
    // 2回のアンドゥでhistoryIndex 2〜5(4件)が切り詰められ、moveEvalHistoryは
    // 長さ2([e0,e1])まで縮む。この時点でindex=4への書き込みは配列に大きな
        // 穴を作りうる状態になる(世代ガードが無ければ)。
    const undoButton = findButtonByText(container, '1手戻る')
    expect(undoButton?.disabled).toBe(false)
    await act(async () => {
      undoButton?.click()
    })
    await act(async () => {
      findButtonByText(container, '1手戻る')?.click()
    })

    // ここで遅延していた5手目の評価取得(historyIndex=4、既に無効化された世代)
    // を今さら解決させる。世代ガードが効いていれば何も起きない(クラッシュしない)。
    await act(async () => {
      pendingAnalyzeAllResolve?.()
    })
    await flushAsyncEffects()

    // もう1手打つ(historyIndex=2)。これによりPreactが`moveEvalHistory`state
    // の最新の実体を用いて次のプレースホルダーを書き込むため、直前の遅延
    // 解決が世代ガードをすり抜けて書き込まれていた場合、この書き込みが
    // 汚染された(穴のある/インデックスの狂った)配列の上に行われることになり、
    // 以降のレンダーで矛盾が露呈する(世代ガードが効いていれば、ここで
    // 使われる`moveEvalHistory`はアンドゥ後の正しい長さ2のままのはず)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()

    // クラッシュしていない(白画面になっていない)ことの確認: 通常のUI要素が
    // 引き続き描画されている。
    expect(container.querySelector('.play-eval-bar__caption')?.textContent).toBe(
      '相手の直前の手の評価(あなた視点、+ならあなた有利)',
    )
    expect(boardStubLastMove(container)).not.toBeNull()

    // moveEvalHistoryに穴・混入が無いこと: アンドゥ2回後に残る2手(historyIndex
    // 0,1)+今打った1手(historyIndex=2)+そのCPU応手(historyIndex=3)の計4手
    // ぶんなので、グラフの点はply0+4手=5個になるはず。世代ガードが効いて
    // いなければ、切り詰め後に古い(historyIndex=4由来の)評価値が紛れ込み、
    // 点の数や並びが狂う(穴があれば例外でこの行自体に到達しない)。
    expect(container.querySelectorAll('.eval-graph__point').length).toBe(5)
  })

  it('着手直後に新規対局を開始→evaluateHumanMoveの遅延解決が古い世代のまま届いても、新しい対局のmoveEvalHistoryが汚染されない', async () => {
    await startBlackCpuGame(container)

    // 1・2手目(黒・CPU)は通常どおり即座に解決させる(historyIndex 0,1)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()

    // 3手目(黒、historyIndex=2)の`evaluateHumanMove`を遅延させる。
    deferNextAnalyzeAll = true
    await clickFirstLegalMove(container)
    expect(pendingAnalyzeAllResolve).not.toBeNull()

    // 「新規対局」でセットアップ画面へ戻り、再度「黒番で開始」する
    // (`prepareNewGame`が世代をインクリメントし`moveEvalHistory`を`[]`に戻す)。
    const returnButton = findButtonByText(container, '新規対局')
    expect(returnButton).toBeDefined()
    await act(async () => {
      returnButton?.click()
    })
    const blackButtonAgain = findButtonByText(container, '黒番で開始')
    expect(blackButtonAgain).toBeDefined()
    await act(async () => {
      blackButtonAgain?.click()
    })
    await flushAsyncEffects()

    // 前の対局の遅延していた評価取得(historyIndex=2)を今さら解決させる。
    // 世代ガードが効いていれば新しい対局の状態には一切影響しない。
    await act(async () => {
      pendingAnalyzeAllResolve?.()
    })
    await flushAsyncEffects()

    // 新しい対局でもう1手打つ(historyIndex=0)。これによりPreactが
    // `moveEvalHistory`stateの最新の実体を用いて次のプレースホルダーを
    // 書き込むため、直前の(前の対局由来の)遅延解決が世代ガードをすり抜けて
    // 書き込まれていた場合、この書き込みが汚染された(前の対局のhistoryIndex=2
    // 由来のply3の値を含む)配列の上に行われることになり、以降のレンダーで
    // 矛盾が露呈する(前の対局の1手目はindex0を使うため、新しい対局の
    // 1手目もindex0を使ってしまうと同じ位置を上書きして汚染が隠れてしまう。
    // 前の対局の遅延対象を3手目=index2にしているのはそのため)。
    await clickFirstLegalMove(container)
    await flushAsyncEffects()

    // クラッシュしていないこと+新しい対局が前の対局の手を引き継いでいない
    // ことを確認する。世代ガードが効いていれば、新しい対局のグラフは
    // 「ply0+今打った1手+CPU応手1手」の3点のみ(前の対局のhistoryIndex=2由来の
    // 評価値(ply3)が紛れ込んでいれば、点の数がズレる、または配列に穴が
    // できて例外が発生しこの行に到達しない)。
    expect(container.querySelector('.play-eval-bar__caption')?.textContent).toBe(
      '相手の直前の手の評価(あなた視点、+ならあなた有利)',
    )
    expect(container.querySelectorAll('.eval-graph__point').length).toBe(3)
  })
})

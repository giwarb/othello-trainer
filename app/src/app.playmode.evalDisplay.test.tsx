// @vitest-environment jsdom
/**
 * T138: 評価値表示の新仕様(定石ブックcap・常時表示・盤面評価=合法手評価の
 * 最大値)+定石トレース表示の統合テスト。
 *
 * ユーザー報告(初手の4合法手が「0, 0, -1, -1」と表示される)を受け、表示の
 * 考え方を「最善手からのロス量」から「評価値そのもの(定石ブックcap適用後)」へ
 * 作り替えた。本テストはUI配線(`app.tsx`が`applyBookCap`/`computeBoardEvalScore`/
 * `formatJosekiTrace`を正しく呼び出しているか)を検証する(純粋関数自体の
 * 全分岐は`components/moveEvalOverlayLogic.test.ts`・`joseki/traceDisplay.test.ts`で
 * 別途担保済み)。
 *
 * 2人対戦モード(`vsHuman`)で検証する: CPU着手(`selectCpuBookMove`・
 * `requestCpuMove`)を一切経由しないため、`app.playmode.test.tsx`(T115)のような
 * CPU応手のモックが不要でテストを単純化できる。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・盤面の
 * canvas描画(`Board`)は、このリポジトリのvitest環境では動かせないためモックに
 * 差し替える(既存の`app.playmode.*.test.tsx`と同じ方針)。`Board`のスタブは
 * 固定のマス番号ではなく、実物の`legalMoves`を使って現局面の合法手ぶんだけ
 * ボタンを描画する(対局が進むたびに合法手が変わるため)。
 *
 * `lookupJosekiNode`は局面の手数(ply、初期局面からの着手数)だけを見る単純な
 * フェイクにする: ply=0(初期局面)は定石DBの全ライン相当(仕様上app.tsx側は
 * ply=0を追跡対象外にする)、ply=1(黒がf5を打った直後の白番)は「兎」ラインの
 * 途中(合法手すべてを継続候補=bookMovesとして返す)、ply>=2はDB外(null)。
 * これにより「初手はブック内(cap適用)→f5で定石を維持→次の応手で定石を
 * 外れる」という流れを、実際のロジックのみで再現できる。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import {
  countDiscs,
  legalMoves,
  notationToSquare,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from './game/othello.ts'

const F5 = notationToSquare('f5')
import type { JosekiDb, JosekiNode } from './joseki/types.ts'

/** 初期局面からの着手数(黒+白の石数-4)。`app.tsx`の`josekiTrace`エフェクトと同じ定義。 */
function plyOf(board: BoardState): number {
  return countDiscs(board, 'black') + countDiscs(board, 'white') - 4
}

vi.mock('./components/Board.tsx', () => ({
  // 実物はcanvasに描画するが、jsdomはcanvas 2D描画に対応していないため、
  // 現局面の合法手ぶんだけ着手ボタンを描画する最小スタブに差し替える
  // (`data-testid="stub-board-play-<記法>"`)。
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

  // 現局面の合法手それぞれに、局面の手数(ply)に応じた決め打ちの評価値
  // (discDiff、mover視点石差)を割り当てる。実エンジンは一切使わない。
  //
  // - ply=0(初期局面): すべて0以上の値(0,1,2,3...)にする。定石ブックcap
  //   (f5がブック手)により、正の値はすべて0に丸められるはずなので、
  //   「4合法手すべて0表示になる」ことがcap経由であることを検証できる
  //   (仮にcapが効いていなければ0以外の値も出てしまうはずの状況を作る)。
  // - ply=2(白の応手後、黒番。定石DBには無い局面): 負の値も混ぜる
  //   (-1,0,1,2...)。この局面はブックcap対象外(bookSquaresが空)になる
  //   はずなので、cap無しの素の値がそのまま出ることを検証できる。
  // - それ以外(ply=1等): 0以上の適当な値。
  function movesForBoard(board: BoardState, side: Side): MoveEvalJson[] {
    const ply = plyOf(board)
    return legalMoves(board, side).map((sq, i) => {
      const discDiff = ply === 2 ? i - 1 : i
      return { move: squareToNotation(sq), score: discDiff * 100, discDiff, type: 'midgame' as const }
    })
  }

  return {
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: (board: BoardState, side: Side) => Promise.resolve(movesForBoard(board, side)),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/lookup.ts', () => {
  return {
    loadJosekiDb: () => Promise.resolve({} as JosekiDb),
    // T151: 対局モードは`loadOpeningBookDb`(拡張ブック)を参照する。
    loadOpeningBookDb: () => Promise.resolve({} as JosekiDb),
    lookupJosekiNode: (_db: JosekiDb, board: BoardState, side: Side, _firstMoveSquare: number) => {
      const ply = plyOf(board)
      if (ply === 0) {
        // 初期局面: 実際の定石DB(`lookup.test.ts`参照)と同様、f5だけが
        // ブック手として見つかる状態を模す(names自体は本テストの対象外の
        // ため中身は使わない、ダミーの1件)。
        return {
          node: {} as JosekiNode,
          isLeaf: false,
          names: ['ダミー'],
          bookMoves: [{ move: F5, weight: 1 }],
        }
      }
      if (ply === 1) {
        // 黒がf5を打った直後の白番: 「兎」ラインの途中とみなし、白の合法手
        // すべてを定石の継続候補(bookMoves)として返す(どれを打っても
        // ply=1の「在庫内」判定になるようにテストを単純化する)。
        const moves = legalMoves(board, side)
        return {
          node: {} as JosekiNode,
          isLeaf: false,
          names: ['兎'],
          bookMoves: moves.map((move) => ({ move, weight: 1 / moves.length })),
        }
      }
      // ply=0は仕様上app.tsx側が追跡対象外にする(全112ライン一致で無意味に
      // なるため)。ply>=2はDB外(定石を外れた/指し終えた)を模す。
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

/** `.move-eval-overlay__value`の表示文字列(例: "+2"/"-1"/"0")を数値に変換する。 */
function parseEvalValue(text: string): number {
  return Number(text.replace('+', ''))
}

describe('T138: 評価値表示の新仕様(定石cap・常時表示・盤面評価)+定石トレース表示', () => {
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

  async function renderAndStartVsHumanGame(): Promise<void> {
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

    const vsHumanButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '2人対戦で開始',
    )
    expect(vsHumanButton).toBeDefined()
    await act(async () => {
      vsHumanButton?.click()
    })
    await flushAsyncEffects()
  }

  it('候補手評価・現在の評価値のチェックボックスが撤去され、localStorageの保存値がfalseでも常時表示される', async () => {
    // T138要件5: 旧チェックの保存キーにfalseを仕込んでおく(既存ユーザーの
    // 保存済み設定を模す)。新仕様ではこれらのキー自体を読まなくなるため、
    // 表示に影響しないはず。
    localStorage.setItem('othello-trainer:moveEvalOverlay', JSON.stringify(false))
    localStorage.setItem('othello-trainer:playEvalBar', JSON.stringify(false))

    await renderAndStartVsHumanGame()

    // チェックボックス自体が撤去されている。
    const checkboxLabels = Array.from(container.querySelectorAll('label')).map((label) => label.textContent)
    expect(checkboxLabels.some((text) => text?.includes('候補手評価を表示'))).toBe(false)
    expect(checkboxLabels.some((text) => text?.includes('現在の評価値を表示'))).toBe(false)

    // localStorageがfalseでも、初期局面の候補手評価オーバーレイと評価値バーが
    // 両方とも表示されている(常時表示、要件5)。
    expect(container.querySelectorAll('.move-eval-overlay__value').length).toBeGreaterThan(0)
    expect(container.querySelector('.play-eval-bar')).not.toBeNull()
  })

  it('初手局面: 4合法手すべて定石ブックcapにより"0"表示になり、盤面評価値バーも0になる', async () => {
    await renderAndStartVsHumanGame()

    const values = Array.from(container.querySelectorAll('.move-eval-overlay__value')).map((el) => el.textContent)
    // 初期局面の合法手は4つ(d3/c4/f5/e6)。
    expect(values.length).toBe(4)
    expect(values.every((text) => text === '0')).toBe(true)

    // 盤面評価値(評価バー)も定石内(仕様2)により0になる
    // (`EvalBar`の表示ラベルは`formatDiscDiff`により符号付きで"+0"になる)。
    const barLabel = container.querySelector('.midgame-eval-bar__label')?.textContent
    expect(barLabel).toBe('+0')
  })

  it('定石トレースが表示され、ブックを離脱すると「(離脱)」が付く。離脱後は候補手評価に素の値(負の値含む)が出て、評価値バーはanalyzeAll最大値と一致する', async () => {
    await renderAndStartVsHumanGame()

    // まだ1手も指していない間は(ply=0はapp.tsx側が追跡対象外にするため)
    // 定石トレースは表示されない。
    expect(container.querySelector('.joseki-trace')).toBeNull()

    // 黒がf5(定石内の手)に着手する。
    const f5Button = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-f5"]')
    expect(f5Button).not.toBeNull()
    await act(async () => {
      f5Button?.click()
    })
    await flushAsyncEffects()

    // 白番になり、定石トレースが「定石: 兎(1手目)」として表示される(離脱前)。
    const traceAfterF5 = container.querySelector('.joseki-trace')
    expect(traceAfterF5).not.toBeNull()
    expect(traceAfterF5?.textContent).toBe('定石: 兎(1手目)')

    // 白が(どの合法手でもよい、モック上はすべて定石の継続扱い)応手する。
    const whiteButton = container.querySelector<HTMLButtonElement>('[data-testid^="stub-board-play-"]')
    expect(whiteButton).not.toBeNull()
    await act(async () => {
      whiteButton?.click()
    })
    await flushAsyncEffects()

    // 黒番に戻り、この局面(ply=2)は定石DB外(モック上null)なので、定石を
    // 離脱したとみなされ、直前に一致していた「兎(1手目)」を保持したまま
    // 「(離脱)」が付く。
    const traceAfterLeave = container.querySelector('.joseki-trace')
    expect(traceAfterLeave).not.toBeNull()
    expect(traceAfterLeave?.textContent).toBe('定石: 兎(1手目)(離脱)')

    // 離脱後の候補手評価は素の値(cap無し)が出る: モック上ply=2はi-1
    // (…,-1,0,1,2,…)を割り当てているため、負の値を含むはず。
    const cellValues = Array.from(container.querySelectorAll('.move-eval-overlay__value')).map((el) =>
      parseEvalValue(el.textContent ?? '0'),
    )
    expect(cellValues.length).toBeGreaterThan(0)
    expect(cellValues.some((v) => v < 0)).toBe(true)
    expect(cellValues.every((v) => v === 0)).toBe(false)

    // 評価値バー(盤面評価値)は、候補手評価(analyzeAllの結果)の最大値と一致する
    // (T138仕様1・「値の整合が構造的に保証される」)。表示は黒視点(vsHumanは
    // 黒基準)で、黒番なのでそのままの符号のはず。
    const maxCellValue = Math.max(...cellValues)
    const barLabel = container.querySelector('.midgame-eval-bar__label')?.textContent
    expect(barLabel).not.toBeUndefined()
    expect(parseEvalValue(barLabel ?? '')).toBe(maxCellValue)
  })
})

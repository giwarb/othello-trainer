// @vitest-environment jsdom
/**
 * T133 追加要件2(T132コードレビュー中(b)指摘、
 * tasks/review/T130-T132-learning-features-claude-review.md「中(b)」参照):
 *
 * 既存の`app.playmode.review.test.tsx`(T132)は2人対戦モードのみを検証しており、
 * CPU着手effect経由(`app.tsx`の`requestCpuMove`呼び出し)での`moveHistory`記録には
 * 自動テストがなかった。コードレビュー上は`appendPlayedMove`の呼び出し位置から
 * 問題ないと判断された(観点(4))が、作業ログの実機確認の記述も両義的だった。
 *
 * 本テストはCPU対戦(黒番人間・白番CPU)で人間がd3に着手し、CPU(白)がその応手
 * (e3、`selectCpuBookMove`を`null`固定にしてエンジン探索フォールバック経由で
 * 決定させる)を実際に打った直後に対局を終局させ、「この対局を棋譜解析で振り返る」
 * ボタンから遷移した棋譜解析モードで人間・CPU双方の着手(d3・e3)が正しく
 * 引き継がれていることを確認する。
 *
 * `requestCpuMove`は実物(`importOriginal`)をそのまま使い、CPUの応手が実際に
 * 成立した直後にだけ`phase`を`'over'`へ上書きする薄いラッパーに差し替える
 * (実際のオセロは2手では終局しないため、テスト用に強制する)。盤面・`lastMove`
 * の計算自体は実ロジック(`actual.requestCpuMove`が内部で呼ぶ実物の`playMove`)の
 * 結果をそのまま使うため、記録される棋譜(`d3e3`)は実在する合法な着手列になり、
 * 棋譜解析側の実物の`replayGame`でも正しく再生できる。
 *
 * 注意: `playMove`自体をこのファイルでモックしても`requestCpuMove`経由の着手には
 * 反映されない(`gameLoop.ts`内部の`requestCpuMove`はモジュール内のローカル参照で
 * `playMove`を呼ぶため、`vi.mock`による差し替えは及ばない)。そのため
 * `requestCpuMove`自体をラップしてCPUの着手成立を検知する。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・
 * 書籍応手選択(`selectCpuBookMove`)・盤面のcanvas描画(`Board`)は、このリポジトリの
 * vitest環境では動かせないためモックに差し替える(`app.playmode.test.tsx`(T115)・
 * `app.playmode.review.test.tsx`(T132)と同じ方針)。棋譜解析側のIndexedDB
 * キャッシュ(`analysis/cache.ts`)は`fake-indexeddb/auto`でグローバルの
 * `indexedDB`を差し替えて実物を動かす(`app.playmode.review.test.tsx`と同じ方針)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import { applyMove, initialBoard, legalMoves, notationToSquare } from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

// d3(黒の初手)とe3(白の応手として使う固定値)。e3が実際に合法手であることは
// 下の sanity テストで検証する。
const D3 = notationToSquare('d3')
const E3 = notationToSquare('e3')

vi.mock('./components/Board.tsx', () => ({
  // 実物はcanvasに描画するが、jsdomはcanvas 2D描画に対応していないため、
  // クリックでd3(square=D3)に着手できるだけの最小スタブに差し替える。
  Board: ({ onMove }: { onMove?: (square: number) => void }) => (
    <button type="button" data-testid="stub-board-play-d3" onClick={() => onMove?.(D3)}>
      play d3
    </button>
  ),
  FLIP_ANIMATION_MS: 0,
  // T134: 自分の着手→アニメ完了+間 の後にCPUの応手を表示する直列化の「間」。
  // 実時間で待つとテストが遅く不安定になるため0にする(詳細は
  // `app/src/game/displayQueue.ts`・`app.playmode.test.tsx`のコメント参照)。
  DISPLAY_GAP_MS: 0,
}))

vi.mock('./engine/sharedClient.ts', () => {
  const analyzeResponse: AnalyzeResponseMessage = {
    id: 0,
    final: true,
    depth: 1,
    pv: ['e3'],
    score: { type: 'midgame', discDiff: 0 },
    nodes: 0,
    nps: 0,
  }
  const allMoves: MoveEvalJson[] = [{ move: 'd3', score: 0, discDiff: 0, type: 'midgame' }]
  return {
    // CPU着手effect(`requestCpuMove`経由)の探索応答は常にe3を返す(定石ブックは
    // `selectCpuBookMove`のモックでnull固定にし、必ずこの経路を通す)。
    // 対局モードの評価表示・棋譜解析の両方から呼ばれるが、いずれも1手ぶんの
    // 評価があれば十分なため、引数によらず同じ固定応答を返す。
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: () => Promise.resolve(allMoves),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/lookup.ts', () => ({
  // 中身は使われない(`selectCpuBookMove`もモックするため)。
  // ロード完了→`josekiDbReady`をtrueにする経路だけ再現できればよい。
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  // T151: 対局モードは`loadOpeningBookDb`(拡張ブック)を参照する。
  loadOpeningBookDb: () => Promise.resolve({} as JosekiDb),
  lookupJosekiNode: () => null,
}))

vi.mock('./joseki/selectCpuBookMove.ts', () => ({
  // 定石ブックは既定でONだが、書籍応手の中身はこのテストの関心事ではないため
  // 常にnullを返し、エンジン探索フォールバック(上のrequestAnalyzeモック、
  // 'e3'固定)経由でCPUの応手を確定させる。
  selectCpuBookMove: () => null,
}))

vi.mock('./game/gameLoop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./game/gameLoop.ts')>()
  return {
    ...actual,
    // T197: `requestCpuMove`の戻り値は`{state, evalScore}`(以前は`GameState`単体)。
    requestCpuMove: async (...args: Parameters<typeof actual.requestCpuMove>) => {
      const state = args[0]
      const result = await actual.requestCpuMove(...args)
      if (result.state.lastMove === state.lastMove) return result // 非合法・パス等(このテストでは発生しない想定)
      // CPU(白)の応手が実際に成立した直後に対局を終局させる(実際のオセロは
      // 2手では終局しないため、テスト用に強制する)。
      return {
        ...result,
        state: { ...result.state, phase: 'over' as const, passMessage: null, result: 'black' as const },
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

describe('T133: CPU対戦での着手履歴記録(T132コードレビュー中(b)指摘の回帰テスト)', () => {
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
  })

  it('CPU(白)の応手も含めて着手履歴が正しく記録され、棋譜解析へ引き継がれる', async () => {
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

    // CPU対戦(黒番人間)で開始する。
    const blackButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '黒番で開始',
    )
    expect(blackButton).toBeDefined()
    await act(async () => {
      blackButton?.click()
    })
    await flushAsyncEffects()

    // まだ対局中なので「振り返る」ボタンは出ていない。
    expect(
      Array.from(container.querySelectorAll('button')).some((btn) =>
        btn.textContent?.includes('この対局を棋譜解析で振り返る'),
      ),
    ).toBe(false)

    // d3に着手する(黒・人間)。
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })
    // CPU(白)の応手(e3)がCPU着手effect経由で解決し、対局が終局するまで待つ。
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

    // 人間(d3)・CPU(e3)双方の着手が棋譜解析に引き継がれ、解析が完了している
    // (CPU着手effect経由の記録が漏れていれば、ここは'd3'の1手だけになる)。
    expect(container.textContent).toContain('解析完了: 2手')
    const movelistCells = Array.from(container.querySelectorAll('td')).map((td) => td.textContent)
    expect(movelistCells).toContain('d3')
    expect(movelistCells).toContain('e3')
  })
})

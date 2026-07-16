// @vitest-environment jsdom
/**
 * T115: 定石ブックON時、CPUが書籍応手を返した直後に「(思考中...)」表示が
 * 解除されなくなる不具合の回帰テスト。
 *
 * 原因: 対局モード(`PlayMode`、`app.tsx`)のCPU着手用`useEffect`は
 * `firstMoveSquare`(人間の初手を記録するstate)を依存配列に含んでいた。
 * 定石ブックの応手は`engine.requestAnalyze`を経由せずほぼ即時に解決する
 * (`game/gameLoop.ts`の`requestCpuMove`参照)ため、「初手を記録するための
 * 別のuseEffect」が`firstMoveSquare`をセットして再レンダーを起こすタイミングと
 * 競合し、CPU着手effectが同一ターン(同一の人間の着手)に対して二重に発火した
 * (`selectCpuBookMove`が同一局面に2回呼ばれる)。二重発火した2つのeffect
 * インスタンスは互いの`cancelled`クリーンアップフラグを踏みつけ合い、実機の
 * ブラウザでは(Promiseのmicrotaskとpassive effectのスケジューリングの
 * 相対順序次第で)どちらの`.finally()`も`setThinking(false)`を実行できない
 * まま終わることがあった(詳細はtasks/T115-book-on-thinking-hang.mdの作業ログ、
 * および本ファイルのdevログ調査で確認したイベント順序を参照)。
 *
 * 修正: `firstMoveSquare`を`useRef`化してCPU着手effectの依存配列から外し、
 * さらに`game.phase !== 'cpu'`になったら必ず`thinking`をfalseに戻す
 * 安全網effectを追加した。
 *
 * テストの狙い: `thinking`表示が消えるタイミング自体はPromiseのmicrotaskと
 * `preact/test-utils`の`act()`(効果の同期flush)の相互作用に左右され、
 * jsdom環境では実ブラウザの競合を確実には再現できない(このテストの
 * 「思考中」表示チェックは、実は修正前のコードでも`act()`の同期flushにより
 * 偶然パスしてしまうことを確認済み)。そのため、本テストの実質的な回帰検出は
 * **根本原因である二重発火そのもの**を直接検証する
 * `expect(selectCpuBookMoveCalls.length).toBe(1)` によって行う
 * (修正前のコードに対して実行すると2が返り、このアサーションで失敗することを
 * 確認済み)。「思考中」表示のチェックは期待する最終状態の仕様として残す。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・
 * ランダム重み付け選択(`selectCpuBookMove`)・盤面のcanvas描画(`Board`)は
 * このリポジトリのvitest環境(node、canvas未対応)では動かせないため、
 * すべてモックに差し替える(盤面の合法手判定など純粋ロジックはモックしない)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import { applyMove, initialBoard, legalMoves, notationToSquare } from './game/othello.ts'
import type { JosekiDb } from './joseki/types.ts'

// d3(黒の初手)とe3(白の書籍応手として使う固定値)のマス番号。
// 実際の合法手判定(`legalMoves`)で妥当性を検証する(下の`beforeEach`前のit参照)。
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
    // 定石ヒットで探索自体は使われない想定だが、evalBar等から呼ばれても
    // ハングしないよう即解決するダミーを返す。
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: () => Promise.resolve<MoveEvalJson[]>([]),
      terminate: () => {},
    }),
  }
})

vi.mock('./joseki/lookup.ts', () => ({
  // 中身は使われない(`selectCpuBookMove`もモックするため)。
  // ロード完了→`josekiDbReady`をtrueにする経路だけ再現できればよい。
  loadJosekiDb: () => Promise.resolve({} as JosekiDb),
  lookupJosekiNode: () => null,
}))

// CPU着手effectが同一の人間の着手に対して何回発火したかを数える
// (根本原因の直接検証、上のファイル先頭コメント参照)。
const selectCpuBookMoveCalls: number[] = []
vi.mock('./joseki/selectCpuBookMove.ts', () => ({
  // 常にE3を返す(=定石ブックがヒットして即時応手できる状況を固定的に再現する)。
  selectCpuBookMove: () => {
    selectCpuBookMoveCalls.push(selectCpuBookMoveCalls.length)
    return E3
  },
}))

/** `finish()`未満の1回の`act`では拾いきれない、Promiseチェーン越しの
 * state更新(`requestCpuMove`の`.then/.finally`等)を数ラウンド分待つ。 */
async function flushAsyncEffects(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T115: 定石ブックON時のCPU書籍応手と「思考中」表示', () => {
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

  it('書籍応手の適用後、「思考中」表示が解除される(定石ブックは既定でON)', async () => {
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

    // 定石DBの読み込み完了(josekiDbReady)を待つ。
    await flushAsyncEffects()

    // 定石ブックは既定でONのはず(loadOpeningBookEnabledのデフォルト値、T093)。
    const bookCheckbox = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).find(
      (cb) => cb.closest('label')?.textContent?.includes('定石ブック'),
    )
    expect(bookCheckbox?.checked).toBe(true)

    // 黒番(人間)としてd3に着手する。
    const boardStub = container.querySelector<HTMLButtonElement>('[data-testid="stub-board-play-d3"]')
    expect(boardStub).not.toBeNull()
    await act(async () => {
      boardStub?.click()
    })

    // CPU(白)の書籍応手が解決し、`thinking`がfalseへ戻るまで待つ。
    await flushAsyncEffects()

    const status = container.querySelector('.status')
    expect(status?.textContent).not.toContain('思考中')
    // 黒(人間)の手番に戻っている(白の書籍応手が実際に適用された)ことも確認する。
    expect(status?.textContent).toContain('手番: 黒')

    // 本テストの主眼(回帰検出の要): CPU着手effectは、このd3という
    // 1回の人間の着手に対して1回だけ発火すべき。修正前は`firstMoveSquare`が
    // stateだったため2回発火していた(ファイル先頭コメント参照)。
    expect(selectCpuBookMoveCalls.length).toBe(1)
  })
})

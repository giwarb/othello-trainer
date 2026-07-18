// @vitest-environment jsdom
/**
 * T136要件2のコンポーネントテスト: 対局モードの状態分離(セットアップ/対局中/
 * 終局後)。
 *
 * オーケストレーターの実機UXレビュー(2026-07-18)により、対局モードは
 * 「開始オプションが対局中も常設」されており対局中の主役であるべき盤が
 * セットアップUIと同居していた。本テストは:
 * 1. 対局開始前はセットアップカード(開始ボタン群・CPU強さ・オプション)だけが
 *    表示され、盤面エリア(プレイヤーバッジ・盤)は表示されないこと。
 * 2. 開始ボタンを押すとセットアップカードが隠れ、盤面エリアが表示されること。
 *    悪手判定設定・表示オプションの折りたたみ(`<details>`)は既定で閉じている
 *    こと。
 * 3. 投了すると即座に終局し、結果(勝敗演出)が表示されること。「新規対局」を
 *    押すとセットアップカードへ戻ること。
 * を検証する。
 *
 * WASM Worker(`getSharedEngineClient`)・定石DBのfetch(`loadJosekiDb`)・
 * 盤面のcanvas描画(`Board`)は、このリポジトリのvitest環境では動かせないため
 * モックに差し替える(他の`app.playmode.*.test.tsx`と同じ方針)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from './engine/types.ts'
import type { JosekiDb } from './joseki/types.ts'

vi.mock('./components/Board.tsx', () => ({
  Board: ({ onMove }: { onMove?: (square: number) => void }) => (
    <button type="button" data-testid="stub-board" onClick={() => onMove?.(0)}>
      board
    </button>
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

/** Promiseチェーン越しのstate更新・`setTimeout(0)`を数ラウンド分待つ(他ファイルと同じ方針)。 */
async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function openPlayMode(container: HTMLDivElement): Promise<void> {
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
}

function findButton(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) => btn.textContent === text)
}

describe('T136要件2: 対局モードの状態分離', () => {
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

  it('対局開始前はセットアップカードのみ表示され、盤面エリア(バッジ・盤)は表示されない', async () => {
    await openPlayMode(container)

    expect(findButton(container, '黒番で開始')).toBeDefined()
    expect(findButton(container, '白番で開始')).toBeDefined()
    expect(findButton(container, 'ランダムで開始')).toBeDefined()
    expect(findButton(container, '2人対戦で開始')).toBeDefined()

    expect(container.querySelector('.player-badges')).toBeNull()
    expect(container.querySelector('[data-testid="stub-board"]')).toBeNull()
  })

  it('開始ボタンを押すとセットアップカードが隠れ、盤面エリアが表示される。設定の折りたたみは既定で閉じている', async () => {
    await openPlayMode(container)

    await act(async () => {
      findButton(container, '2人対戦で開始')?.click()
    })
    await flushAsyncEffects()

    // セットアップカードの開始ボタン群は非表示になる。
    expect(findButton(container, '黒番で開始')).toBeUndefined()
    expect(findButton(container, '2人対戦で開始')).toBeUndefined()

    // 盤面エリア(プレイヤーバッジ2枚+盤)が表示される。
    const badges = container.querySelectorAll('.player-badge')
    expect(badges.length).toBe(2)
    expect(container.querySelector('[data-testid="stub-board"]')).not.toBeNull()

    // 悪手判定設定・表示オプションの折りたたみは既定で閉じている(要件2)。
    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.hasAttribute('open')).toBe(false)
  })

  it('投了すると即座に終局して勝敗演出が表示され、「新規対局」でセットアップカードへ戻る', async () => {
    await openPlayMode(container)

    await act(async () => {
      findButton(container, '黒番で開始')?.click()
    })
    await flushAsyncEffects()

    const resignButton = findButton(container, '投了')
    expect(resignButton).toBeDefined()
    await act(async () => {
      resignButton?.click()
    })
    await flushAsyncEffects()

    // 終局後: 白(CPU)の勝ちの演出が表示される(投了は人間側の負けとして確定する)。
    expect(container.textContent).toContain('白の勝ちです。')
    // 終局後は投了ボタンが消える。
    expect(findButton(container, '投了')).toBeUndefined()

    const newGameButton = findButton(container, '新規対局')
    expect(newGameButton).toBeDefined()
    await act(async () => {
      newGameButton?.click()
    })

    // セットアップカードへ戻る。
    expect(findButton(container, '黒番で開始')).toBeDefined()
    expect(container.querySelector('.player-badges')).toBeNull()
  })

  // T137追加要件4(T136 codex-review指摘・軽微4): 2人対戦モード(`vsHuman`)には
  // 「あなた」という単一視点が無いため投了ボタン自体を出さない(`app.tsx`の
  // `!game.vsHuman && displayGame.phase !== 'over'`ガード)。CPU対戦の投了フローの
  // テストはあるが、2人対戦で投了ボタンが最初から出ないことを固定する専用テストが
  // 無かったため追加する。
  it('2人対戦モードでは対局中も投了ボタンが表示されない', async () => {
    await openPlayMode(container)

    await act(async () => {
      findButton(container, '2人対戦で開始')?.click()
    })
    await flushAsyncEffects()

    // 盤面エリアには遷移している(対局中)が、投了ボタンは存在しない。
    expect(container.querySelector('[data-testid="stub-board"]')).not.toBeNull()
    expect(findButton(container, '投了')).toBeUndefined()

    // 一手打った後(手番が変わった後)も引き続き投了ボタンは出ない。
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')?.click()
    })
    await flushAsyncEffects()
    expect(findButton(container, '投了')).toBeUndefined()
  })
})

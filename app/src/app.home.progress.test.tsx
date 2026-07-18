// @vitest-environment jsdom
/**
 * T137要件4のコンポーネントテスト: ホーム画面のモードカードに進捗の実績行
 * (定石「今日の復習n本」・中盤練習「クリアx/111」・詰めオセロ「クリアx/182・
 * 今日の1問」)が表示されること。
 *
 * 既存の各モードの集計ロジック(T131のdueLines・T119/T117のstageProgress・
 * T028のdailyPuzzle)をそのまま再利用するだけで新規スキーマは追加していないため、
 * 本テストもそれらの実装(モックしない)をそのまま通す。IndexedDB
 * (定石SRS状態)は`fake-indexeddb/auto`でポリフィルする。WASM Worker
 * (`getSharedEngineClient`)・盤面canvas描画(`Board`)は他の`app.playmode.*`
 * テストと同じ方針でモックする(ホーム画面自体はこれらを描画しないが、
 * `app.tsx`モジュールの他モードが依存しているため)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJosekiDb } from './joseki/buildDb.ts'
import type { RawJosekiLine } from './joseki/types.ts'
import { buildMidgameStagePool } from './midgame/stagePool.ts'
import { recordStageAttempt as recordMidgameStageAttempt } from './midgame/stageProgress.ts'
import { todaysPuzzle } from './tsume/dailyPuzzle.ts'
import { recordStageAttempt as recordTsumeStageAttempt } from './tsume/stageProgress.ts'
import type { Puzzle, PuzzleFile } from './tsume/types.ts'

vi.mock('./components/Board.tsx', () => ({
  Board: () => <button type="button" data-testid="stub-board" />,
  FLIP_ANIMATION_MS: 0,
  DISPLAY_GAP_MS: 0,
}))

vi.mock('./engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyze: () => Promise.reject(new Error('ホーム進捗テストでは使用しない')),
    requestAnalyzeAll: () => Promise.resolve([]),
    terminate: () => {},
  }),
}))

// 2ラインの定石DB(due計算・中盤ステージ集計の両方に使う、`buildMidgameStagePool`が
// これを終端局面2件として列挙する想定)。
const LINES: RawJosekiLine[] = [
  { name: 'ライン1', aliases: [], moves: ['f5', 'f6'], firstMoveBasis: 'f5', depth: 2 },
  { name: 'ライン2', aliases: [], moves: ['f5', 'd6'], firstMoveBasis: 'f5', depth: 2 },
]
const JOSEKI_DB = buildJosekiDb(LINES)

vi.mock('./joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(JOSEKI_DB),
  lookupJosekiNode: () => null,
}))

function makePuzzle(id: string, difficulty: Puzzle['difficulty']): Puzzle {
  return {
    id,
    board: { black: '0x0000000810000000', white: '0x0000001008000000' },
    sideToMove: 'black',
    empties: 60,
    correctMoves: ['f5'],
    bestDiscDiff: 4,
    outcome: 'win',
    clarityMargin: 4,
    moves: [],
    difficulty,
    difficultyRawScore: 0,
    tags: [],
  }
}

const TSUME_PUZZLES: Puzzle[] = [makePuzzle('tsume-1', 1), makePuzzle('tsume-2', 2), makePuzzle('tsume-3', 3)]

vi.mock('./tsume/loadPuzzles.ts', () => ({
  loadPuzzles: () =>
    Promise.resolve<PuzzleFile>({ generatedAt: '2026-07-18T00:00:00.000Z', puzzles: TSUME_PUZZLES }),
}))

/** Promiseチェーン越しのstate更新・`setTimeout(0)`を数ラウンド分待つ(他ファイルと同じ方針)。 */
async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function cardProgressText(container: HTMLDivElement, label: string): string | undefined {
  const card = Array.from(container.querySelectorAll<HTMLButtonElement>('.title-screen__card')).find((btn) =>
    btn.querySelector('.title-screen__card-label')?.textContent === label,
  )
  return card?.querySelector('.title-screen__card-progress')?.textContent ?? undefined
}

describe('T137要件4: ホーム画面のモードカード進捗行', () => {
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

  it('起動直後(未取得)は進捗行が無く、データが揃うと定石・中盤・詰めの実績行が表示される', async () => {
    const { App } = await import('./app.tsx')
    await act(async () => {
      render(<App />, container)
    })

    // 起動直後(非同期取得が終わる前)は進捗行自体が無い(空状態、要件4)。
    expect(container.querySelector('.title-screen__card-progress')).toBeNull()

    await flushAsyncEffects()

    // 定石: 記録0件(SRS状態なし)なので2ライン全てdue扱い。
    expect(cardProgressText(container, '定石練習')).toBe('今日の復習2本')
    // 中盤練習: 2ステージ・記録なしなのでクリア0件。
    expect(cardProgressText(container, '中盤練習')).toBe('クリア0/2')
    // 詰めオセロ: 3問・記録なしなのでクリア0件、今日の1問も未挑戦。
    expect(cardProgressText(container, '詰めオセロ')).toBe('クリア0/3・今日の1問未挑戦')
  })

  it('クリア記録があれば実績行の分子・今日の1問の状態に反映される', async () => {
    // 中盤: 実際のstagePool(buildMidgameStagePoolがJOSEKI_DBから求める2ステージ)の
    // うち1件を判定モード'standard'でクリア済みにする。
    const stagePool = buildMidgameStagePool(JOSEKI_DB)
    expect(stagePool.length).toBe(2)
    recordMidgameStageAttempt(localStorage, stagePool[0]!.key, 'standard', 'clear')

    // 詰め: 実際に選ばれる「今日の1問」をクリア済みとして記録する(日付依存で
    // 対象が変わらないよう、`todaysPuzzle`で実際に選ばれる問題のIDを使う)。
    const today = todaysPuzzle(TSUME_PUZZLES)
    recordTsumeStageAttempt(localStorage, today.id, 'clear')

    const { App } = await import('./app.tsx')
    await act(async () => {
      render(<App />, container)
    })
    await flushAsyncEffects()

    expect(cardProgressText(container, '中盤練習')).toBe('クリア1/2')
    expect(cardProgressText(container, '詰めオセロ')).toBe('クリア1/3・今日の1問済み')
  })
})

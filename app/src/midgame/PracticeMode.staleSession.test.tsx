// @vitest-environment jsdom
/**
 * T119 redo #1回帰テスト: 終盤判定(`checkEnd`)の非同期処理が進行中に画面を
 * 離れた(「やめる」→設定画面へ戻る)後、古い判定が完了しても
 * ステージ挑戦記録・結果画面遷移・★付与を行わないことを固定する。
 *
 * 原因(codex-review指摘、`tasks/review/T119-midgame-stage-select-codex-review.md`
 * (b)1節): `checkEnd`(完全読みの`requestAnalyzeAll`)は非同期だが、
 * セッションIDやキャンセル判定が無かった。判定中でも「やめる」ボタンは
 * 利用でき、`backToSettings`も進行中の判定を無効化しないため、判定中に
 * 設定画面へ戻った後で古い`checkEnd`が完了すると、退出済みステージの
 * clear/failを記録し、`phase`を結果画面へ戻し、★まで付与してしまう
 * 不具合があった。
 *
 * 修正: `sessionGenerationRef`(コンポーネント内のセッション世代カウンタ)を
 * 導入し、`resetSessionTo`/`backToSettings`/`goToStageSelect`でインクリメント。
 * `checkEnd`・`handleModeFailure`・`handlePlayerMove`は非同期処理の`await`前に
 * 世代を捕まえ、`await`から戻った時点で`sessionGenerationRef.current`と
 * 一致する場合のみ結果確定・記録を行う(`PracticeMode.tsx`参照)。
 *
 * 検証方法: `getEngine().requestAnalyzeAll`を「意図的に解決しないPromise」に
 * 差し替え、ステージ開始直後(`resetSessionTo`が同期的に呼ぶ`checkEnd`が
 * 完全読みの`await`で止まっている間)に「やめる」を押して設定画面へ戻り、
 * その後で`requestAnalyzeAll`を(クリア相当の評価値で)解決させる。この時点で
 * `localStorage`にステージ記録が書き込まれておらず、画面も結果画面へ遷移
 * していないことを確認する(修正前のコードに対して実行すると、
 * `localStorage`に記録が書き込まれ結果画面に遷移してしまうことを確認済み)。
 *
 * モック方針は`app/src/tsume/PlayMode.test.tsx`(T118)・
 * `app/src/tsume/PlayMode.stageProgressTiming.test.tsx`(T117 redo #1)と同じ
 * (Board/engineをスタブ化、実際の`game/othello.ts`ロジックで盤面を構成する)。
 * 定石DBは`buildJosekiDb`に、初期局面から36手打って空きマス24(クリア/失敗
 * 判定が発動する閾値)に到達する決定的な合法手列を1ライン与えて構築する
 * (パスが起きない手順を事前にスクリプトで確認済み)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_STAGE_PROGRESS_STORAGE_KEY } from './stageProgress.ts'

vi.mock('../components/Board.tsx', () => ({
  Board: () => <button type="button" data-testid="stub-board">board</button>,
}))

/**
 * 初期局面から空きマス24(`PracticeMode.tsx`の`checkEnd`が完全読み判定を
 * 開始する閾値)まで、パスを起こさずに進む決定的な36手(黒から交互)。
 * scratchpadで`game/othello.ts`を直接実行して事前に検証済み(黒の合法手
 * 12個、`resolveMover`は`null`にならない)。
 */
const MOVE_SEQUENCE_TO_24_EMPTIES = [
  'f5', 'f4', 'c3', 'c4', 'd3', 'f6', 'b3', 'd6', 'g4', 'c2', 'e2', 'h4',
  'f3', 'e3', 'f7', 'g3', 'c1', 'b4', 'e6', 'd2', 'g2', 'g6', 'b2', 'g8',
  'g5', 'a3', 'd7', 'a1', 'g7', 'd8', 'c7', 'f2', 'c6', 'b8', 'e7', 'h8',
]

const SYNTHETIC_LINE: RawJosekiLine = {
  name: 'テスト用ライン',
  aliases: [],
  moves: MOVE_SEQUENCE_TO_24_EMPTIES,
  firstMoveBasis: 'f5',
  depth: MOVE_SEQUENCE_TO_24_EMPTIES.length,
}

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(buildJosekiDb([SYNTHETIC_LINE])),
  lookupJosekiNode: () => null,
}))

/** `requestAnalyzeAll`を意図的に解決しないPromiseに差し替えるための手動resolver群。 */
let pendingResolvers: Array<(value: MoveEvalJson[]) => void> = []

function resolveAllPending(value: MoveEvalJson[]): void {
  const resolvers = pendingResolvers
  pendingResolvers = []
  resolvers.forEach((resolve) => resolve(value))
}

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: () =>
      new Promise<MoveEvalJson[]>((resolve) => {
        pendingResolvers.push(resolve)
      }),
    requestAnalyze: () => Promise.reject(new Error('T119 redo #1テストでは使用しない')),
    requestFeatureSet: () => Promise.reject(new Error('T119 redo #1テストでは使用しない')),
    requestEvalTerms: () => Promise.reject(new Error('T119 redo #1テストでは使用しない')),
    terminate: () => {},
  }),
}))

/** マイクロタスク・短い`setTimeout(0)`チェーン越しのstate更新を数ラウンド分待つ(既存テストと同じ手法)。 */
async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T119 redo #1: 終盤判定中に離脱した後、古い判定完了が記録・結果遷移を行わない', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    pendingResolvers = []
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    // 未解決のまま残ったPromiseを解決してから片付ける。
    resolveAllPending([])
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('ステージ開始直後の完全読み判定中に「やめる」で離脱すると、後から判定が解決してもlocalStorage記録も結果画面遷移も起きない', async () => {
    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    // ステージ一覧を開き、唯一のステージ(テスト用ライン)を選んで開始する。
    const stageListButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('ステージ一覧'),
    )
    expect(stageListButton).toBeDefined()
    await act(async () => {
      stageListButton?.click()
    })
    await flushAsyncEffects()

    const stageCell = container.querySelector<HTMLButtonElement>('.midgame-stage-grid__cell')
    expect(stageCell).not.toBeNull()
    await act(async () => {
      stageCell?.click()
    })
    await flushAsyncEffects()

    // この時点で`resetSessionTo`が同期的に呼んだ`checkEnd`が
    // `requestAnalyzeAll`のawaitで止まっているはず(完全読み判定中)。
    expect(pendingResolvers.length).toBeGreaterThan(0)
    expect(container.querySelector('.midgame-practice')).not.toBeNull()

    // 判定中に「やめる」を押して設定画面へ戻る(離脱)。
    const quitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'やめる',
    )
    expect(quitButton).toBeDefined()
    await act(async () => {
      quitButton?.click()
    })
    await flushAsyncEffects()

    expect(container.textContent).toContain('中盤練習モード: 条件を選んで開始してください')
    expect(localStorage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)).toBeNull()

    // 離脱後に、古い判定(クリア相当の評価値)を解決させる。
    await act(async () => {
      resolveAllPending([{ move: 'a1', score: 1000, discDiff: 10, type: 'exact' }])
    })
    await flushAsyncEffects()

    // 本題: 古い判定が完了しても、localStorageへの記録は書き込まれない。
    expect(localStorage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)).toBeNull()
    // 結果画面(クリア表示)にも遷移しない。設定画面に留まったまま。
    expect(container.querySelector('.midgame-result')).toBeNull()
    expect(container.querySelector('.midgame-result--clear')).toBeNull()
    expect(container.textContent).toContain('中盤練習モード: 条件を選んで開始してください')
  })
})

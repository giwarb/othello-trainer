// @vitest-environment jsdom
/**
 * T131: 定石練習モードのSRS復習キュー見える化の統合テスト。
 *
 * `PracticeMode.tsx`の色選択画面(colorSelect)に「今日の復習: n本」表示・
 * 「復習を始める」ボタン(due限定出題)・0件フォールバックの旨表示・
 * 「今日の復習完了!」の達成表示(要件1・3・4)を、実際のコードパス
 * (`dueLines.ts`・`db.ts`・`srs.ts`)を通して検証する。
 *
 * `dueLines.ts`の純粋関数(`computeDueLines`/`previewDueLineNames`/
 * `selectPracticeTargetLine`/`dueSummaryHeadline`)自体の詳細な分岐は
 * `dueLines.test.ts`でユニットテスト済みなので、ここではUIへの結線
 * (実際にIndexedDBを読み書きしながら画面表示が切り替わること)を確認する。
 *
 * モック方針は`../midgame/PracticeMode.clearBlunderGate.test.tsx`(T128)と同じ
 * (Board/engineをスタブ化)。定石DBは`buildJosekiDb`に「初手f5のみ・depth1」の
 * 1本だけの合成ラインを与えて構築する(黒番でf5を1手打つだけで
 * `bookMoves`が真に空になりクリアするため、対局シミュレーションを最小化できる。
 * `buildDb.ts`のロジック上、1手ラインの終端ノードは`bookMoves`が空になることを
 * 確認済み)。
 *
 * IndexedDBへのSRS記録(`joseki/db.ts`)は`fake-indexeddb/auto`でグローバルの
 * `indexedDB`をポリフィルし、実際のコードパスをそのまま実行する
 * (`tsume/PlayMode.test.tsx`と同じ方針)。テストごとに`IDBFactory`を
 * 差し替えてデータを分離する。
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJosekiDb } from './buildDb.ts'
import { putSrsState } from './db.ts'
import type { JosekiSrsState } from './srs.ts'
import type { RawJosekiLine } from './types.ts'

vi.mock('../components/Board.tsx', () => {
  function sq(notation: string): number {
    const file = notation.charCodeAt(0) - 97
    const rank0 = notation.charCodeAt(1) - 49
    return rank0 * 8 + file
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Board: (props: any) => (
      <div data-testid="stub-board">
        <button type="button" data-testid="move-f5" onClick={() => props.onMove?.(sq('f5'))}>
          f5
        </button>
      </div>
    ),
  }
})

const LINE_NAME = 'テスト用一手ライン'

const SYNTHETIC_LINE: RawJosekiLine = {
  name: LINE_NAME,
  aliases: [],
  moves: ['f5'],
  firstMoveBasis: 'f5',
  depth: 1,
}

// `lookupJosekiNode` 自体は純粋関数(`JosekiDb`を引数に取るだけ)なので実装をそのまま
// 使い、`loadJosekiDb`だけをテスト用の合成DBに差し替える。
vi.mock('./lookup.ts', async () => {
  const actual = await vi.importActual<typeof import('./lookup.ts')>('./lookup.ts')
  return {
    ...actual,
    loadJosekiDb: () => Promise.resolve(buildJosekiDb([SYNTHETIC_LINE])),
  }
})

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: () => Promise.reject(new Error('T131テストでは使用しない(全手が定石内)')),
    requestAnalyze: () => Promise.reject(new Error('T131テストでは使用しない')),
    requestFeatureSet: () => Promise.reject(new Error('T131テストでは使用しない')),
    requestEvalTerms: () => Promise.reject(new Error('T131テストでは使用しない')),
    terminate: () => {},
  }),
}))

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T131: 定石練習モードのSRS復習キュー見える化', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    // fake-indexeddb/autoでグローバルに設定された`indexedDB`を、テストごとに
    // 新規の`IDBFactory`で差し替えてデータを分離する(`db.test.ts`と同じ方針)。
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    // `startPractice('random', ...)`の色決定(`pickRandomSide`)を黒番に固定する。
    // ラインは1本・bookMoveも1つ(重み1)しか無いため、出題対象ライン選択・
    // 相手着手選択への影響は無い(常に一意に決まる)。人間=黒番に固定することで、
    // f5クリックが人間の着手として即座に処理され、相手の自動着手タイマー
    // (`OPPONENT_MOVE_DELAY_MS`)を待たずに済む。
    vi.spyOn(Math, 'random').mockReturnValue(0)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('未挑戦のラインはdue扱いで「今日の復習: 1本」が表示され、復習を始めて完走するとdueが0になり「今日の復習完了!」が表示される(要件1・4)', async () => {
    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    // 要件1: 未挑戦ライン(SRS状態なし)は常にdueなので「今日の復習: 1本」。
    expect(container.textContent).toContain('今日の復習: 1本')

    // 要件2: due一覧をdetailsで開くとライン名が見える。
    const summary = Array.from(container.querySelectorAll('summary')).find((el) =>
      el.textContent?.includes('復習対象のラインを見る'),
    )
    expect(summary).toBeDefined()
    expect(container.textContent).toContain(LINE_NAME)

    // 要件3: 「復習を始める」ボタンで練習を開始する。
    const reviewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '復習を始める',
    )
    expect(reviewButton).toBeDefined()
    await act(async () => {
      reviewButton?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.joseki-practice')).not.toBeNull()
    // dueが1件以上あったので、フォールバック表示は出ない。
    expect(container.textContent).not.toContain('本日の復習はないため')

    // 唯一の合法手f5を打つ(1手ラインなので即クリアするはず)。
    const f5Button = container.querySelector<HTMLButtonElement>('[data-testid="move-f5"]')
    expect(f5Button).not.toBeNull()
    await act(async () => {
      f5Button?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.joseki-result--clear')).not.toBeNull()

    // 「もう一度」で色選択画面に戻る。
    const againButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'もう一度',
    )
    expect(againButton).toBeDefined()
    await act(async () => {
      againButton?.click()
    })
    await flushAsyncEffects()

    // 要件4: 復習を使い切ったので、「今日の復習はありません」ではなく
    // 「今日の復習完了!」が表示される。
    expect(container.textContent).toContain('今日の復習完了!')
    expect(container.textContent).not.toContain('今日の復習: ')
  })

  it('dueが0件のときは「今日の復習はありません」を表示し、「復習を始める」は通常出題にフォールバックしその旨を表示する(要件1・3)', async () => {
    // 唯一のラインを、遠い未来がdueDateになるよう事前にIndexedDBへ記録しておく
    // (`isDue`はdueDateが本日以前かどうかで判定するため、未来日付ならdue外になる)。
    const notDueState: JosekiSrsState = {
      lineId: LINE_NAME,
      ease: 2.5,
      interval: 30,
      streak: 3,
      fails: 0,
      dueDate: '2099-01-01',
      lastReviewedAt: new Date().toISOString(),
    }
    await putSrsState(notDueState)

    const { PracticeMode } = await import('./PracticeMode.tsx')
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    expect(container.textContent).toContain('今日の復習はありません')
    expect(container.textContent).not.toContain('今日の復習完了!')
    // due0件なのでdue一覧のdetailsは出ない。
    expect(
      Array.from(container.querySelectorAll('summary')).some((el) =>
        el.textContent?.includes('復習対象のラインを見る'),
      ),
    ).toBe(false)

    const reviewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === '復習を始める',
    )
    expect(reviewButton).toBeDefined()
    await act(async () => {
      reviewButton?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.joseki-practice')).not.toBeNull()
    expect(container.textContent).toContain('本日の復習はないため、通常の出題です。')
  })
})

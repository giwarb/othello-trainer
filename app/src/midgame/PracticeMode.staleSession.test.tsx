// @vitest-environment jsdom
/**
 * T119 redo #1回帰テスト(T141で新フロー向けに改訂): セッション終了判定
 * (`checkSessionEnd`)の非同期処理が進行中に画面を離れた(「やめる」→
 * ステージ一覧へ戻る)後、古い判定が完了してもステージ挑戦記録・結果画面遷移を
 * 行わないことを固定する。
 *
 * 原因(codex-review指摘、`tasks/review/T119-midgame-stage-select-codex-review.md`
 * (b)1節): 終局判定(完全読み相当の`requestAnalyzeAll`)は非同期だが、
 * セッションIDやキャンセル判定が無かった。判定中でも「やめる」ボタンは
 * 利用でき、離脱操作も進行中の判定を無効化しないため、判定中にステージ一覧へ
 * 戻った後で古い判定が完了すると、退出済みステージのclear/failを記録し、
 * `phase`を結果画面へ戻してしまう不具合があった。
 *
 * 修正: `sessionGenerationRef`(コンポーネント内のセッション世代カウンタ)を
 * 導入し、`startStagePractice`/`goToStageSelect`でインクリメント。
 * `checkSessionEnd`・`handlePlayerMove`は非同期処理の`await`前に世代を捕まえ、
 * `await`から戻った時点で`sessionGenerationRef.current`と一致する場合のみ
 * 結果確定・記録を行う(`PracticeMode.tsx`参照)。T141はこの仕組みをそのまま
 * 踏襲しており、本回帰テストも有効。
 *
 * T141での検証方法の変更: `checkSessionEnd`が`requestAnalyzeAll`(完全読み相当)を
 * 呼ぶのは「3往復(プレイヤー3手+相手3応手)完了時」だけになった(旧: 空き24以下の
 * 毎手)。そのため本テストは、まず3往復を実際に(モックした決定的な最善応手で)
 * 完走させて7回目のエンジン呼び出し(3往復完了後の最終評価)だけを意図的に
 * 解決しないPromiseにし、その状態で「やめる」を押して離脱、その後に解決させても
 * ステージ記録・結果画面遷移が起きないことを確認する。
 *
 * プレイヤー・相手の双方とも「その局面の`legalMoves`の先頭」を常に選ぶよう
 * エンジン応答(discDiffは全手0で並べる、`pickOpponentMove('best')`はタイの場合
 * 安定ソートで先頭を保つ)・Board挙動を揃えることで、6手ぶんの進行を決定的に
 * 実行する(実際の合法手判定は`game/othello.ts`をそのまま使う、モックしない)。
 *
 * `OPPONENT_MOVE_DELAY_MS`(350ms)ぶんの実待ちが3回発生するため、本テストは
 * 実時間で数秒かかる(フェイクタイマーは使わず、実`setTimeout`を繰り返し
 * `flushAsyncEffects`で待つ、既存テストと同じ手法をラウンド数・待ち時間だけ
 * 増やして流用)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoveEvalJson } from '../engine/types.ts'
import { legalMoves, squareToNotation, type Board, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_STAGE_STARS_STORAGE_KEY } from './stageProgress.ts'

/** 常に「現在の局面の合法手の先頭」を選んでクリックするだけのBoardスタブ(プレイヤー操作用)。 */
vi.mock('../components/Board.tsx', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Board: (props: any) => {
    const board = props.board as Board
    const sideToMove = props.sideToMove as Side
    const moves = legalMoves(board, sideToMove)
    const first = moves[0]
    return (
      <button
        type="button"
        data-testid="stub-board"
        onClick={() => {
          if (first !== undefined) props.onMove?.(first)
        }}
      >
        board
      </button>
    )
  },
}))

const SYNTHETIC_LINE: RawJosekiLine = {
  name: 'テスト用ライン',
  aliases: [],
  moves: ['f5'],
  firstMoveBasis: 'f5',
  depth: 1,
}

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(buildJosekiDb([SYNTHETIC_LINE])),
  lookupJosekiNode: () => null,
}))

/** `requestAnalyzeAll`呼び出し回数(局面ごとに1回だけ呼ばれる設計、`PracticeMode.tsx`の`getAnalyzedMoves`キャッシュ参照)。 */
let engineCallCount = 0
/** この回数を超えた呼び出しは、意図的に解決しないPromiseを返す(3往復完了後の最終評価だけを止める)。 */
let holdAfterCallCount = Infinity
let pendingResolvers: Array<(value: MoveEvalJson[]) => void> = []

function resolveAllPending(value: MoveEvalJson[]): void {
  const resolvers = pendingResolvers
  pendingResolvers = []
  resolvers.forEach((resolve) => resolve(value))
}

/** 全合法手を評価値0で並べる(全手「同点最善」扱いにし、先頭手が一貫して選ばれるようにする)。 */
function neutralMoves(board: Board, side: Side): MoveEvalJson[] {
  return legalMoves(board, side).map((square) => ({ move: squareToNotation(square), score: 0, discDiff: 0, type: 'midgame' }))
}

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: (board: Board, side: Side): Promise<MoveEvalJson[]> => {
      engineCallCount += 1
      if (engineCallCount > holdAfterCallCount) {
        return new Promise<MoveEvalJson[]>((resolve) => {
          pendingResolvers.push(resolve)
        })
      }
      return Promise.resolve(neutralMoves(board, side))
    },
    requestAnalyze: () => Promise.reject(new Error('T119 redo #1テストでは使用しない')),
    requestFeatureSet: () => Promise.reject(new Error('T119 redo #1テストでは使用しない(全手同点最善のためパターン検出には到達しない)')),
    requestEvalTerms: () => Promise.reject(new Error('T119 redo #1テストでは使用しない')),
    terminate: () => {},
  }),
}))

/** マイクロタスク+短い実`setTimeout`チェーン越しのstate更新・`OPPONENT_MOVE_DELAY_MS`(350ms)待ちをカバーする(既存テストと同じ手法、待ち時間だけ延長)。 */
async function flushAsyncEffects(rounds = 20, delayMs = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    })
  }
}

function clickBoard(container: HTMLDivElement): void {
  const board = container.querySelector<HTMLButtonElement>('[data-testid="stub-board"]')
  expect(board).not.toBeNull()
  board?.click()
}

describe('T119 redo #1(T141改訂): 3往復完了後の最終評価判定中に離脱した後、古い判定完了が記録・結果遷移を行わない', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    engineCallCount = 0
    holdAfterCallCount = Infinity
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

  it(
    '3往復完了後の最終評価中に「やめる」で離脱すると、後から判定が解決してもlocalStorage記録も結果画面遷移も起きない',
    async () => {
      const { PracticeMode } = await import('./PracticeMode.tsx')
      await act(async () => {
        render(<PracticeMode />, container)
      })
      await flushAsyncEffects()

      const stageCell = container.querySelector<HTMLButtonElement>('.midgame-stage-grid__cell')
      expect(stageCell).not.toBeNull()
      await act(async () => {
        stageCell?.click()
      })
      await flushAsyncEffects()
      expect(container.querySelector('.midgame-practice')).not.toBeNull()

      // ステージ開始〜3往復完了までのエンジン呼び出しは、局面ごとに1回だけ
      // (`getAnalyzedMoves`キャッシュ)発生する: プレイヤー3手ぶんのオーバーレイ
      // 取得3回+相手3応手ぶんの取得3回=6回。7回目(3往復完了後の最終評価)
      // だけを以後保留させる(呼び出し順序はコード上決定的、テスト冒頭コメント参照)。
      holdAfterCallCount = 6

      // 3往復ぶん、常に(先頭の合法手を選ぶ)クリックを行う。プレイヤーの
      // クリック後、相手の応手(モック内で決定的に先頭手を選ぶ)が
      // `OPPONENT_MOVE_DELAY_MS`後に反映されるのを待つ。
      for (let round = 0; round < 3; round += 1) {
        await act(async () => {
          clickBoard(container)
        })
        await flushAsyncEffects()
      }

      // この時点で最終評価の`requestAnalyzeAll`がawaitで止まっているはず。
      expect(pendingResolvers.length).toBeGreaterThan(0)
      expect(container.querySelector('.midgame-result')).toBeNull()

      // 判定中に「やめる」を押してステージ一覧へ戻る(離脱)。
      const quitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (btn) => btn.textContent === 'やめる',
      )
      expect(quitButton).toBeDefined()
      await act(async () => {
        quitButton?.click()
      })
      await flushAsyncEffects()

      expect(container.querySelector('.midgame-stage-select')).not.toBeNull()
      expect(localStorage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)).toBeNull()

      // 離脱後に、古い判定(クリア相当の評価値)を解決させる。
      await act(async () => {
        resolveAllPending([{ move: 'a1', score: 1000, discDiff: 10, type: 'exact' }])
      })
      await flushAsyncEffects()

      // 本題: 古い判定が完了しても、localStorageへの記録は書き込まれない。
      expect(localStorage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)).toBeNull()
      // 結果画面にも遷移しない。ステージ一覧に留まったまま。
      expect(container.querySelector('.midgame-result')).toBeNull()
      expect(container.querySelector('.midgame-stage-select')).not.toBeNull()
    },
    15000,
  )
})

import { useEffect, useState } from 'preact/hooks'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { formatDiscDiff } from '../components/EvalBadge.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import { PlayerBadge } from '../components/PlayerBadge.tsx'
import type { EngineClient } from '../engine/client.ts'
import { hexToBigint } from '../engine/hex.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  countDiscs,
  hasLegalMove,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { loadMoveEvalOverlayEnabled, saveMoveEvalOverlayEnabled } from '../settings/moveEvalOverlaySettings.ts'
import {
  loadReviewFilter,
  matchesReviewFilter,
  REVIEW_FILTER_OPTIONS,
  saveReviewFilter,
  TSUME_REVIEW_FILTER_STORAGE_KEY,
  type ReviewFilter,
} from '../settings/reviewFilter.ts'
import { todaysPuzzle } from './dailyPuzzle.ts'
import { computeDifficultyStats } from './difficultyStats.ts'
import { judgePuzzleMove } from './judgePuzzleMove.ts'
import { loadPuzzles } from './loadPuzzles.ts'
import {
  loadStageProgress,
  recordStageAttempt,
  stageStatus,
  type StageProgress,
} from './stageProgress.ts'
import {
  computeOverallStats,
  computeTagAccuracy,
  getAllAttempts,
  pickWeightedPuzzle,
  recordAttempt,
  type PuzzleAttemptRecord,
} from './stats.ts'
import type { DifficultyLevel, Puzzle, PuzzleOutcome, PuzzleTag } from './types.ts'
import './PlayMode.css'

/** 相手(エンジン)が着手するまでの見せかけの「考慮時間」(ミリ秒、他モードと同じ演出)。 */
const OPPONENT_MOVE_DELAY_MS = 350

/** `'stageSelect'`はステージ一覧画面(T117要件1)。 */
type Phase = 'settings' | 'stageSelect' | 'playing' | 'result'

/**
 * 出題の選び方(要件1・6、T117で`'stage'`を追加)。
 * `'stage'`はステージ一覧から番号を指定して選ぶ経路(`stageIndex`が`pool`内の
 * 0-indexedな位置、要件1「配列順の通し番号(1〜182)」の内部表現)。
 */
type SelectionKind = 'difficulty' | 'random' | 'daily' | 'stage'

interface Selection {
  readonly kind: SelectionKind
  readonly level?: DifficultyLevel
  /** `kind === 'stage'`のときのみ使う、`pool`内の0-indexedな位置。 */
  readonly stageIndex?: number
}

interface Session {
  readonly puzzle: Puzzle
  readonly board: BoardState
  readonly sideToMove: Side
  /** プレイヤーが担当する色。常に出題局面の手番側(`puzzle.sideToMove`)。 */
  readonly humanSide: Side
  readonly lastMove: number | null
  /** 問題呈示時刻(平均時間計測用、要件5)。 */
  readonly presentedAt: number
}

interface ClearResultInfo {
  readonly kind: 'clear'
  readonly puzzle: Puzzle
  /** 終局時(最終手適用後)の盤面(T118: 結果画面でも最終盤面を表示し続けるため)。 */
  readonly board: BoardState
  readonly sideToMove: Side
  /** 終局を成立させた最終手のマス(相手の最終手・人間の最終手のいずれもありうる)。 */
  readonly lastMove: number | null
}

interface FailResultInfo {
  readonly kind: 'fail'
  readonly puzzle: Puzzle
  readonly board: BoardState
  readonly sideToMove: Side
  readonly playedMove: string
  readonly playedSquare: number
  /** 失敗時UI用: 着手前局面の全合法手の結果一覧(要件4)。 */
  readonly allMoves: readonly MoveEvalJson[]
  readonly bestMove: string | null
}

type ResultInfo = ClearResultInfo | FailResultInfo

const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = [1, 2, 3, 4, 5]

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

function outcomeLabel(outcome: PuzzleOutcome): string {
  if (outcome === 'win') return '勝ち'
  if (outcome === 'loss') return '負けを最小化'
  return '引き分け'
}

/**
 * 問題(`puzzle`)を完全読みするための探索条件を返す(要件2)。
 * `exactFromEmpties` を問題の空きマス数(`puzzle.empties`、出題局面時点で最大)以上に
 * 設定しておけば、この問題を最後まで解き進める間ずっと(空きマス数は単調減少するため)
 * 完全読みが使われる(`engine/src/search.rs` の「空きマス数 <= exactFromEmpties なら
 * 直ちに完全読み」という規約に基づく判断。詳細は `judgePuzzleMove.ts` のコメント参照)。
 */
function puzzleAnalyzeLimit(puzzle: Puzzle): AnalyzeLimit {
  return { depth: puzzle.empties, exactFromEmpties: puzzle.empties }
}

/**
 * `selection` と現在の成績(`tagAccuracy`)から `pool` の中から1問選ぶ(要件1・5・6)。
 * `kind === 'stage'`(T117)は重み付き抽選を経由せず、`stageIndex`が指す問題を
 * そのまま返す(ステージ一覧は「この番号の問題を選ぶ」という決定的な操作)。
 *
 * @throws {RangeError} `kind === 'stage'`で`stageIndex`が`pool`の範囲外の場合。
 */
function pickPuzzle(
  selection: Selection,
  pool: readonly Puzzle[],
  tagAccuracy: ReadonlyMap<PuzzleTag, number>,
): Puzzle {
  if (selection.kind === 'daily') {
    return todaysPuzzle(pool)
  }
  if (selection.kind === 'stage') {
    const puzzle = selection.stageIndex !== undefined ? pool[selection.stageIndex] : undefined
    if (!puzzle) {
      throw new RangeError(`pickPuzzle: stageIndex out of range: ${selection.stageIndex}`)
    }
    return puzzle
  }
  const filtered =
    selection.kind === 'difficulty' ? pool.filter((p) => p.difficulty === selection.level) : pool
  const usable = filtered.length > 0 ? filtered : pool
  return pickWeightedPuzzle(usable, tagAccuracy)
}

/**
 * 詰めオセロプレイモード(T028)。
 *
 * 設計書 `othello-trainer-design.md` §5「詰めオセロ」のうち§5.3「プレイ仕様」の実装。
 * 1. 難易度(5段階)・ランダム・デイリーのいずれかで1問選んで出題する。
 * 2. プレイヤーが着手するたび `requestAnalyzeAll`(完全読み)→ `judgePuzzleMove` で
 *    最善結果を維持しているか判定する。
 * 3. 相手(エンジン)の着手は、着手前局面の全合法手完全読みのうち評価値最大の手
 *    (=相手にとっての最善手=プレイヤーの得を最小化する「最も粘る手」)を選ぶ。
 * 4. 最初に最善結果を維持できなかった着手で即座に失敗とし、全合法手の結果一覧を表示する。
 * 5. 成績(正答率・平均時間・タグ別正答率)をIndexedDBに記録し、次回出題の重み付けに使う。
 * 6. デイリー問題(日付シードで決定的に選ぶ1問)を選べる。
 *
 * レスポンシブ対応: 375px幅程度でも崩れないよう `PlayMode.css` で
 * ボタン群・結果一覧を `flex-wrap` させ、狭幅では縦積みにする。
 */
export function PlayMode() {
  const [pool, setPool] = useState<Puzzle[] | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)

  const [attempts, setAttempts] = useState<PuzzleAttemptRecord[]>([])

  const [phase, setPhase] = useState<Phase>('settings')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [lastSelection, setLastSelection] = useState<Selection | null>(null)

  const [session, setSession] = useState<Session | null>(null)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null)

  const [opponentThinking, setOpponentThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  /** 直前の自分の着手が最善結果を維持できていたことを示す一時的なフィードバック(要件2)。 */
  const [lastMoveCorrect, setLastMoveCorrect] = useState(false)

  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  /** ステージ一覧のクリア済みマーク表示用(T117要件1・3)。`localStorage`から起動時に1回読み込む。 */
  const [stageProgress, setStageProgress] = useState<StageProgress>(() => loadStageProgress(localStorage))
  /** ステージ一覧の復習フィルタ(T130要件1・3)。`localStorage`から起動時に1回読み込む。 */
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(() =>
    loadReviewFilter(localStorage, TSUME_REVIEW_FILTER_STORAGE_KEY),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)

  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  // 問題プール(public/puzzles.json)はコンポーネントのライフタイム中1回だけ読み込む
  // (loadPuzzles自体もモジュール内でキャッシュしているため、実際のfetchは1回)。
  useEffect(() => {
    let cancelled = false
    loadPuzzles()
      .then((file) => {
        if (!cancelled) setPool([...file.puzzles])
      })
      .catch((error: unknown) => {
        console.error('問題プールの読み込みに失敗しました', error)
        if (!cancelled) setPoolError('問題データの読み込みに失敗しました。ページを再読み込みしてください。')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 既存の成績記録を起動時に1回読み込む(設定画面の成績表示・出題重み付けの初期値用)。
  useEffect(() => {
    let cancelled = false
    getAllAttempts()
      .then((records) => {
        if (!cancelled) setAttempts(records)
      })
      .catch((error: unknown) => {
        console.error('成績の読み込みに失敗しました', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function startSession(puzzle: Puzzle): void {
    const board: BoardState = {
      black: hexToBigint(puzzle.board.black),
      white: hexToBigint(puzzle.board.white),
    }
    // 出題データが正しければ`puzzle.sideToMove`に合法手が無いことは無いはずだが、
    // 他の遷移箇所(`handlePlayerMove`・相手の着手)と同じ`resolveMover`ベースの
    // 解決を通しておく(T055、`resolveMover`が`null`=終局を返すことは無い前提の
    // データなのでフォールバックは`puzzle.sideToMove`のままでよい)。
    const sideToMove = resolveMover(board, puzzle.sideToMove) ?? puzzle.sideToMove
    setSession({
      puzzle,
      board,
      sideToMove,
      humanSide: puzzle.sideToMove,
      lastMove: null,
      presentedAt: Date.now(),
    })
    setResultInfo(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setLastMoveCorrect(false)
    setPhase('playing')
  }

  /**
   * `localStorage`のステージ挑戦記録(T117要件3)を**同期的に**更新する
   * (redo #1: codex-review指摘の必須修正)。
   *
   * 以前は`saveAttempt`内でIndexedDBの`recordAttempt`/`getAllAttempts`を
   * `await`した**後**にこの記録を行っていたため、結果画面表示直後に
   * ユーザーがページをリロード・離脱したり、IndexedDBの処理が遅延・停止
   * したりすると、`localStorage`への記録が書かれないまま失われるレースが
   * あった(受け入れ基準「リロードしても記録が残っている」を通常操作で
   * 破りうる不具合)。`localStorage.setItem`自体は同期APIなので、
   * `finishClear`/`finishFail`の**最初のawaitより前**(結果画面への遷移
   * `setPhase('result')`より前)でこの関数を呼び、挑戦結果確定と同じ
   * イベントループティック内で書き込みを完了させる。
   *
   * 出題経路(ステージ一覧・難易度別・ランダム・デイリー)を問わず、
   * `Puzzle.id`が同じであれば常に更新する(将来の復習モードで取りこぼさない
   * ため、要件3)。
   */
  function recordStageProgressNow(s: Session, correct: boolean): void {
    try {
      const nextProgress = recordStageAttempt(localStorage, s.puzzle.id, correct ? 'clear' : 'fail')
      setStageProgress(nextProgress)
    } catch (error) {
      console.error('ステージ挑戦記録の保存に失敗しました', error)
    }
  }

  /** 挑戦結果(正誤・経過時間・タグ)をIndexedDBに記録し、成績state(`attempts`)を更新する(要件5)。 */
  async function saveAttempt(s: Session, correct: boolean): Promise<void> {
    const record: PuzzleAttemptRecord = {
      id: `tsume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      puzzleId: s.puzzle.id,
      correct,
      elapsedMs: Date.now() - s.presentedAt,
      tags: s.puzzle.tags,
      createdAt: new Date().toISOString(),
    }
    try {
      await recordAttempt(record)
      const all = await getAllAttempts()
      setAttempts(all)
    } catch (error) {
      console.error('成績の記録に失敗しました', error)
    }
  }

  /**
   * `s`(呼び出し側が着手適用済みの最終`Session`を渡す)の時点の盤面・最終手を
   * `ClearResultInfo`にそのまま持たせる(T118)。以前は`puzzle`しか保持しておらず、
   * 相手番・人間番いずれの終局経路でも最終手適用後の盤面が結果画面に表示されない
   * 不具合があった(`session.board`自体は着手適用済みの`s`を経由して`setSession`
   * されないまま結果表示に遷移していたため画面上に残らなかった)。
   */
  async function finishClear(s: Session): Promise<void> {
    recordStageProgressNow(s, true)
    setPhase('result')
    setResultInfo({ kind: 'clear', puzzle: s.puzzle, board: s.board, sideToMove: s.sideToMove, lastMove: s.lastMove })
    await saveAttempt(s, true)
  }

  async function finishFail(
    s: Session,
    playedSquare: number,
    playedMove: string,
    allMoves: readonly MoveEvalJson[],
    bestMove: string | null,
  ): Promise<void> {
    recordStageProgressNow(s, false)
    setPhase('result')
    setResultInfo({
      kind: 'fail',
      puzzle: s.puzzle,
      board: s.board,
      sideToMove: s.sideToMove,
      playedMove,
      playedSquare,
      allMoves,
      bestMove,
    })
    await saveAttempt(s, false)
  }

  /**
   * 着手適用直後に、実際に手番を持つ側を同期的に解決する(T055、
   * `game/gameLoop.ts`の`afterMove`・`midgame/PracticeMode.tsx`と同じパターン)。
   *
   * 以前は着手適用(`setSession`)とパス解決・終局判定が別々のuseEffectに
   * 分かれていたため、パスが発生した直後の1レンダーだけ`session.sideToMove`が
   * 「本来ならパスして手番が変わらないはずの側」のまま描画されてしまい、
   * それを見ている盤面評価オーバーレイ取得用のuseEffect(`session.sideToMove
   * !== session.humanSide`を見て判定する)が一瞬だけ誤った判定をして
   * `setOverlayMoves(null)`を呼ぶ→直後に正しい手番へ訂正されて再取得、という
   * ちらつきが発生していた。着手適用と同じ関数呼び出しの中でパス・終局まで
   * 解決することで、この中間状態を無くす。両者とも合法手が無ければ`null`
   * (真の終局)を返すので、呼び出し側は`null`の場合`finishClear`を呼ぶこと。
   */
  function resolveNextSideToMove(board: BoardState, sideAfterMove: Side): Side | null {
    return resolveMover(board, sideAfterMove)
  }

  // 相手(エンジン)の手番になったら、「最も粘る手」(相手にとっての最善手)を
  // 完全読みで選んで自動着手する(要件3)。
  useEffect(() => {
    if (phase !== 'playing' || !session) return
    const s = session
    if (s.sideToMove === s.humanSide) return
    if (!hasLegalMove(s.board, s.sideToMove)) return

    let cancelled = false
    setOpponentThinking(true)

    async function run(): Promise<void> {
      try {
        const limit = puzzleAnalyzeLimit(s.puzzle)
        const allMoves = await getEngine().requestAnalyzeAll(s.board, s.sideToMove, limit)
        if (cancelled || allMoves.length === 0) return
        const mostResistant = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))

        await new Promise((resolve) => setTimeout(resolve, OPPONENT_MOVE_DELAY_MS))
        if (cancelled) return

        const square = notationToSquare(mostResistant.move)
        const board = applyMove(s.board, s.sideToMove, square)
        const nextSession = { ...s, board, lastMove: square }
        const nextSide = resolveNextSideToMove(board, opposite(s.sideToMove))
        if (nextSide === null) {
          await finishClear(nextSession)
          return
        }
        setSession({ ...nextSession, sideToMove: nextSide })
      } catch (error) {
        console.error('相手の着手取得に失敗しました', error)
      } finally {
        if (!cancelled) setOpponentThinking(false)
      }
    }
    void run()

    return () => {
      cancelled = true
      setOpponentThinking(false)
    }
    // eslint-disable-next-line
  }, [phase, session])

  // 盤面セル評価オーバーレイ(T039をT042で展開)。出題中(人間の手番)になった時点で、
  // 表示ONの場合のみ現局面(着手前)の全合法手の完全読み結果をまとめて取得する。
  // 詰めオセロは完全読み判定のため、これをONにすると事実上正解手が見えてしまうが、
  // ユーザーが明示的にトグルをONにした場合のみなので許容する(タスク仕様参照)。
  // 判定中(`analyzing`)は重複リクエストを避けるため取得しない(要件5)。
  useEffect(() => {
    if (
      phase !== 'playing' ||
      !session ||
      session.sideToMove !== session.humanSide ||
      !moveEvalOverlayEnabled ||
      analyzing
    ) {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    const limit = puzzleAnalyzeLimit(session.puzzle)
    getEngine()
      .requestAnalyzeAll(session.board, session.sideToMove, limit)
      .then((moves) => {
        if (!cancelled) setOverlayMoves(moves)
      })
      .catch((error: unknown) => {
        console.error('候補手評価オーバーレイの取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [phase, session, moveEvalOverlayEnabled, analyzing])

  /** オーバーレイ表示ON/OFFを切り替え、`localStorage`へ永続化する(T039・T042、他モードと共有)。 */
  function handleToggleMoveEvalOverlay(enabled: boolean): void {
    setMoveEvalOverlayEnabled(enabled)
    saveMoveEvalOverlayEnabled(localStorage, enabled)
  }

  /**
   * プレイヤーがボードをクリックしたときの処理(要件2・4)。
   * `analyzing`(前回の判定が完了する前)であれば無視する(連打防止、`midgame/PracticeMode.tsx`と同じ方針)。
   */
  async function handlePlayerMove(square: number): Promise<void> {
    if (phase !== 'playing' || !session || analyzing) return
    const s = session
    if (s.sideToMove !== s.humanSide) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    setAnalyzing(true)
    setLastMoveCorrect(false)
    try {
      const limit = puzzleAnalyzeLimit(s.puzzle)
      const allMoves = await getEngine().requestAnalyzeAll(s.board, s.sideToMove, limit)
      const playedNotation = squareToNotation(square)
      const judgement = judgePuzzleMove(allMoves, playedNotation)

      if (!judgement.correct) {
        await finishFail(s, square, playedNotation, allMoves, judgement.bestMove)
        return
      }

      setLastMoveCorrect(true)
      const board = applyMove(s.board, s.sideToMove, square)
      const nextSession = { ...s, board, lastMove: square }
      const nextSide = resolveNextSideToMove(board, opposite(s.sideToMove))
      if (nextSide === null) {
        await finishClear(nextSession)
        return
      }
      setSession({ ...nextSession, sideToMove: nextSide })
    } catch (error) {
      console.error('着手判定のための解析に失敗しました', error)
    } finally {
      setAnalyzing(false)
    }
  }

  /** 設定画面での出題選択(要件1・6): 難易度・ランダム・デイリーのいずれかで1問選んで開始する。 */
  async function startPractice(selection: Selection): Promise<void> {
    if (!pool || pool.length === 0) return
    setStarting(true)
    setStartError(null)
    try {
      const tagAccuracy = computeTagAccuracy(attempts)
      const puzzle = pickPuzzle(selection, pool, tagAccuracy)
      setLastSelection(selection)
      startSession(puzzle)
    } catch (error) {
      console.error('問題の選択に失敗しました', error)
      setStartError('問題の選択に失敗しました。もう一度お試しください。')
    } finally {
      setStarting(false)
    }
  }

  /**
   * 結果画面の「次の問題」ボタン(要件5)。
   * ステージ経由(T117要件4)の場合は、`pool`内で次の番号のステージへ進む
   * (最終ステージなら次が無いのでステージ一覧へ戻る)。それ以外(難易度別・
   * ランダム・デイリー)は従来どおり直前と同じ選び方で次の1問を選ぶ。
   */
  async function nextPuzzle(): Promise<void> {
    if (!lastSelection) {
      backToSettings()
      return
    }
    if (lastSelection.kind === 'stage') {
      const nextIndex = (lastSelection.stageIndex ?? -1) + 1
      if (pool && nextIndex < pool.length) {
        await startPractice({ kind: 'stage', stageIndex: nextIndex })
        return
      }
      goToStageSelect()
      return
    }
    await startPractice(lastSelection)
  }

  function backToSettings(): void {
    setPhase('settings')
    setSession(null)
    setResultInfo(null)
    setOpponentThinking(false)
    setAnalyzing(false)
  }

  /**
   * ステージ一覧画面を開く(要件1)。設定画面の「ステージ一覧」ボタン、および
   * 結果画面の「ステージ一覧へ戻る」ボタン(T117要件4、ステージ経由のときのみ
   * 表示)の両方から呼ばれる。
   */
  function goToStageSelect(): void {
    setPhase('stageSelect')
    setSession(null)
    setResultInfo(null)
    setOpponentThinking(false)
    setAnalyzing(false)
  }

  /** ステージ一覧の復習フィルタ選択を変更し、`localStorage`へ永続化する(T130要件3)。 */
  function handleReviewFilterChange(filter: ReviewFilter): void {
    setReviewFilter(filter)
    saveReviewFilter(localStorage, TSUME_REVIEW_FILTER_STORAGE_KEY, filter)
  }

  const overallStats = computeOverallStats(attempts)
  const tagAccuracy = computeTagAccuracy(attempts)

  /**
   * ステージ一覧を復習フィルタで絞り込んだもの(T130要件1)。`pool`内での
   * 元の`index`は`startPractice({kind:'stage', stageIndex})`・「次の問題」の
   * 通し番号ロジック(`nextPuzzle`)が`pool`そのものを前提にしているため、
   * 絞り込み後も保持しておく。
   */
  const filteredStageEntries = (pool ?? [])
    .map((puzzle, index) => ({ puzzle, index }))
    .filter(({ puzzle }) =>
      matchesReviewFilter(stageStatus(stageProgress, puzzle.id), stageProgress[puzzle.id]?.failCount ?? 0, reviewFilter),
    )

  // T137要件2: 「難易度で選ぶ」カードに出す空きマス数帯+クリア数(要件2、
  // `difficultyStats.ts`参照)。
  const difficultyStats = computeDifficultyStats(pool ?? [], stageProgress, DIFFICULTY_LEVELS)

  // T137要件3: ステージ一覧ヘッダの「クリア x/182」サマリ+進捗バー用。
  const clearedStageCount = (pool ?? []).filter((puzzle) => stageStatus(stageProgress, puzzle.id) === 'cleared').length
  const totalStageCount = pool?.length ?? 0

  return (
    <div class="tsume-practice-mode">
      {poolError && <p class="notice notice--error">{poolError}</p>}
      {startError && <p class="notice notice--error">{startError}</p>}

      {phase === 'settings' && (
        <section class="tsume-settings">
          <p>詰めオセロ: 出題方法を選んでください</p>

          <div class="tsume-stats-summary">
            {overallStats.attempts === 0 ? (
              <p>まだ挑戦記録がありません。</p>
            ) : (
              <p>
                これまでの正答率: {((overallStats.accuracy ?? 0) * 100).toFixed(0)}%(
                {overallStats.correct}/{overallStats.attempts}問) / 平均時間:{' '}
                {((overallStats.averageElapsedMs ?? 0) / 1000).toFixed(1)}秒
              </p>
            )}
            {tagAccuracy.size > 0 && (
              <ul class="tsume-stats-summary__tags">
                {Array.from(tagAccuracy.entries()).map(([tag, accuracy]) => (
                  <li key={tag}>
                    {tag}: {(accuracy * 100).toFixed(0)}%
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* T137要件2: 灰色ボタン5連を「難易度n(空きm〜kマス)+クリア x/y」の
              カードに刷新する(T136 UXレビュー「同一見た目のボタン5連で選ぶ
              手がかりがない」対応)。空きマス数帯は事前に固定された対応表が
              無いため、実際にロード済みのプールから求める(`difficultyStats.ts`)。 */}
          <fieldset class="tsume-settings__group">
            <legend>難易度で選ぶ</legend>
            <div class="tsume-difficulty-cards">
              {difficultyStats.map(({ level, total, cleared, minEmpties, maxEmpties }) => (
                <button
                  type="button"
                  key={level}
                  class="tsume-difficulty-card"
                  disabled={!pool || starting}
                  onClick={() => void startPractice({ kind: 'difficulty', level })}
                >
                  <span class="tsume-difficulty-card__level">難易度{level}</span>
                  {total > 0 ? (
                    <>
                      <span class="tsume-difficulty-card__range">
                        空き{minEmpties}〜{maxEmpties}マス
                      </span>
                      <span class="tsume-difficulty-card__clear">
                        クリア {cleared}/{total}
                      </span>
                    </>
                  ) : (
                    <span class="tsume-difficulty-card__range">問題なし</span>
                  )}
                </button>
              ))}
            </div>
          </fieldset>

          <div class="tsume-settings__buttons">
            <button
              type="button"
              disabled={!pool || starting}
              onClick={() => void startPractice({ kind: 'random' })}
            >
              ランダムに出題
            </button>
            {/* T135 redo#1: 「1画面にprimaryは原則1個」の規律により、この設定画面では
                デイリー問題のみをprimaryにする(難易度1〜5・ランダム・ステージ一覧は
                同格の選択肢としてsecondaryのまま)。 */}
            <button
              type="button"
              class="btn-primary"
              disabled={!pool || starting}
              onClick={() => void startPractice({ kind: 'daily' })}
            >
              今日の1問(デイリー)
            </button>
          </div>

          <div class="tsume-settings__buttons">
            <button type="button" disabled={!pool || starting} onClick={goToStageSelect}>
              ステージ一覧
            </button>
          </div>

          {!pool && !poolError && <p class="notice">問題データを読み込み中...</p>}
        </section>
      )}

      {phase === 'stageSelect' && (
        <section class="tsume-stage-select">
          <p>ステージ一覧: 挑戦したい問題を選んでください(全{pool?.length ?? 0}問)</p>

          {/* T137要件3: 「クリア x/182」サマリ+進捗バー(midgame版と同じ方針)。 */}
          {pool && (
            <div class="tsume-stage-select__summary">
              <p class="tsume-stage-select__summary-text">
                クリア {clearedStageCount}/{totalStageCount}
              </p>
              <div
                class="tsume-stage-select__progress-bar"
                role="progressbar"
                aria-valuenow={clearedStageCount}
                aria-valuemin={0}
                aria-valuemax={totalStageCount}
                aria-label="ステージクリア進捗"
              >
                <div
                  class="tsume-stage-select__progress-fill"
                  style={{ width: `${totalStageCount > 0 ? (clearedStageCount / totalStageCount) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <p class="tsume-stage-select__legend">
            <span class="tsume-stage-legend__mark tsume-stage-legend__mark--cleared">■</span>
            クリア済み
            <span class="tsume-stage-legend__mark tsume-stage-legend__mark--attempted">■</span>
            挑戦済み未クリア
            <span class="tsume-stage-legend__mark tsume-stage-legend__mark--unattempted">■</span>
            未挑戦
          </p>

          <div class="tsume-stage-select__filters" role="group" aria-label="復習フィルタ">
            {REVIEW_FILTER_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                class={`tsume-stage-select__filter-button${
                  reviewFilter === option.value ? ' tsume-stage-select__filter-button--active' : ''
                }`}
                aria-pressed={reviewFilter === option.value}
                onClick={() => handleReviewFilterChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {filteredStageEntries.length === 0 ? (
            <p class="tsume-stage-select__empty">条件に一致する問題がありません。</p>
          ) : (
            <div class="tsume-stage-grid">
              {filteredStageEntries.map(({ puzzle, index }) => {
                const status = stageStatus(stageProgress, puzzle.id)
                return (
                  <button
                    type="button"
                    key={puzzle.id}
                    class={`tsume-stage-grid__cell tsume-stage-grid__cell--${status}`}
                    disabled={starting}
                    onClick={() => void startPractice({ kind: 'stage', stageIndex: index })}
                    title={`第${index + 1}問(難易度${puzzle.difficulty})${status === 'cleared' ? ' クリア済み' : status === 'attempted' ? ' 挑戦済み未クリア' : ' 未挑戦'}`}
                  >
                    <span class="tsume-stage-grid__number">{index + 1}</span>
                    <span class="tsume-stage-grid__difficulty">D{puzzle.difficulty}</span>
                    {status === 'cleared' && (
                      <span class="tsume-stage-grid__check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <button type="button" class="tsume-practice__quit" onClick={backToSettings}>
            設定に戻る
          </button>
        </section>
      )}

      {phase === 'playing' && session && (
        <section class="tsume-practice">
          {/* T136要件1: 「手番: 黒(相手考慮中...)」という素テキストを、盤の直上の
              2バッジ(手番側ハイライト+石数+思考中表示)に置き換える。 */}
          <div class="player-badges">
            <PlayerBadge
              side="black"
              label={session.humanSide === 'black' ? 'あなた' : '相手'}
              count={countDiscs(session.board, 'black')}
              active={session.sideToMove === 'black'}
              thinking={opponentThinking && session.humanSide !== 'black'}
            />
            <PlayerBadge
              side="white"
              label={session.humanSide === 'white' ? 'あなた' : '相手'}
              count={countDiscs(session.board, 'white')}
              active={session.sideToMove === 'white'}
              thinking={opponentThinking && session.humanSide !== 'white'}
            />
          </div>

          {/* T136要件4・6: お題カード化。「○番、最善で+44(この局面、勝てるか?)」と
              「難易度○ / 空き○マス」を、盤直上の1カードにまとめる(以前は盤から
              離れた上部に浮いていた)。カードと盤を1つのdiv
              (`.tsume-practice__board-col`)にまとめているのは、横置き2カラム
              (`app.css`の`.play-board-area`と同じ考え方の右カラム単独スクロール、
              T136要件6)で「カード+盤」をまとめて左カラムに配置するため。 */}
          <div class="tsume-practice__board-col">
            <div class="tsume-prompt-card">
              <p class="tsume-prompt-card__goal">
                {sideLabel(session.puzzle.sideToMove)}番、最善で{formatDiscDiff(session.puzzle.bestDiscDiff)}
                (この局面、勝てるか?)
              </p>
              <p class="tsume-prompt-card__meta">
                難易度{session.puzzle.difficulty} / 空き{session.puzzle.empties}マス
              </p>
            </div>

            <div class="board-container board-with-move-eval-overlay">
              <Board
                board={session.board}
                sideToMove={session.sideToMove}
                lastMove={session.lastMove}
                onMove={(square) => void handlePlayerMove(square)}
              />
              <MoveEvalOverlay
                allMoves={overlayMoves}
                mover={session.sideToMove}
                thresholds={classifyThresholds}
                visible={moveEvalOverlayEnabled}
              />
            </div>
          </div>

          <div class="tsume-practice__side">
            {analyzing && <p class="notice">判定中...</p>}
            {lastMoveCorrect && <p class="tsume-practice__feedback">✓ 正解(最善を維持しています)</p>}

            <label class="move-eval-overlay-toggle">
              <input
                type="checkbox"
                checked={moveEvalOverlayEnabled}
                onChange={(event) => handleToggleMoveEvalOverlay((event.target as HTMLInputElement).checked)}
              />
              候補手評価を表示
            </label>

            <button type="button" class="tsume-practice__quit" onClick={backToSettings}>
              やめる
            </button>
          </div>
        </section>
      )}

      {phase === 'result' && resultInfo?.kind === 'clear' && (
        <section class="tsume-result tsume-result--clear">
          <h2>正解!</h2>
          <p>
            最善を維持したまま解ききりました(目標: {formatDiscDiff(resultInfo.puzzle.bestDiscDiff)}、
            {outcomeLabel(resultInfo.puzzle.outcome)})。
          </p>

          <div class="board-container tsume-result__board">
            <Board board={resultInfo.board} sideToMove={resultInfo.sideToMove} lastMove={resultInfo.lastMove} />
          </div>

          <div class="tsume-result__buttons">
            <button type="button" class="btn-primary" disabled={starting} onClick={() => void nextPuzzle()}>
              次の問題
            </button>
            {lastSelection?.kind === 'stage' && (
              <button type="button" onClick={goToStageSelect}>
                ステージ一覧へ戻る
              </button>
            )}
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}

      {phase === 'result' && resultInfo?.kind === 'fail' && (
        <section class="tsume-result tsume-result--fail">
          <h2>不正解</h2>
          <p>
            あなたの手: {resultInfo.playedMove}
            {resultInfo.bestMove && ` / 正解手: ${resultInfo.bestMove}`}
          </p>

          <div class="board-container tsume-result__board">
            <Board board={resultInfo.board} sideToMove={resultInfo.sideToMove} lastMove={resultInfo.playedSquare} />
          </div>

          <table class="tsume-result__moves">
            <caption>全合法手の結果(石差、大きいほど良い)</caption>
            <thead>
              <tr>
                <th>マス</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {[...resultInfo.allMoves]
                .sort((a, b) => b.discDiff - a.discDiff)
                .map((m) => (
                  <tr
                    key={m.move}
                    class={
                      m.move === resultInfo.playedMove
                        ? 'tsume-result__moves-row--played'
                        : m.move === resultInfo.bestMove
                          ? 'tsume-result__moves-row--best'
                          : ''
                    }
                  >
                    <td>{m.move}</td>
                    <td>{formatDiscDiff(m.discDiff)}</td>
                  </tr>
                ))}
            </tbody>
          </table>

          <div class="tsume-result__buttons">
            <button type="button" class="btn-primary" disabled={starting} onClick={() => void nextPuzzle()}>
              次の問題
            </button>
            {lastSelection?.kind === 'stage' && (
              <button type="button" onClick={goToStageSelect}>
                ステージ一覧へ戻る
              </button>
            )}
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

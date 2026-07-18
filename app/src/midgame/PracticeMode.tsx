import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { formatDiscDiff } from '../components/EvalBadge.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import { PlayerBadge } from '../components/PlayerBadge.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { bigintToHex } from '../engine/hex.ts'
import {
  applyMove,
  countDiscs,
  countEmpty,
  hasLegalMove,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { loadJosekiDb } from '../joseki/lookup.ts'
import type { JosekiDb } from '../joseki/types.ts'
import { loadMoveEvalOverlayEnabled, saveMoveEvalOverlayEnabled } from '../settings/moveEvalOverlaySettings.ts'
import {
  loadReviewFilter,
  matchesReviewFilter,
  MIDGAME_REVIEW_FILTER_STORAGE_KEY,
  REVIEW_FILTER_OPTIONS,
  saveReviewFilter,
  type ReviewFilter,
} from '../settings/reviewFilter.ts'
import { ClearBlunderCompare } from './ClearBlunderCompare.tsx'
import {
  CLEAR_BLUNDER_PATTERN_LABELS,
  detectAllClearBlunderPatterns,
  detectClearBlunderPatterns,
  type ClearBlunderPattern,
  type ClearBlunderPatternId,
} from './clearBlunder.ts'
import { EvalBar } from './EvalBar.tsx'
import { generateSelfPlayPosition, pickJosekiEndPosition, type StartPosition } from './generateStart.ts'
import { judgeMidgameMove, type EvalSign, type JudgeMidgameMoveResult, type JudgeMidgameReasonKind } from './judgeMidgameMove.ts'
import { loadJudgeMode, saveJudgeMode } from './judgeModeStorage.ts'
import { pickOpponentMove } from './pickOpponentMove.ts'
import { addPoolEntry } from './pool.ts'
import {
  loadPatternStats,
  recordPatternFailures,
  resetPatternStats,
  topPatternStats,
  type PatternStats,
} from './patternStats.ts'
import { resolveMover, resolveNextSideOrFallback } from './resolveMover.ts'
import { buildMidgameStagePool, type MidgameStage } from './stagePool.ts'
import {
  loadStageProgress,
  recordStageAttempt,
  stageStarCount,
  stageStatus,
  stageStatusForMode,
  type StageProgress,
} from './stageProgress.ts'
import type { JudgeMode, OpponentStrength, StartPositionSource } from './types.ts'
import './PracticeMode.css'

/**
 * 中盤練習モードのエンジン解析に使う探索条件(要件3: depth目安16、時間予算1秒程度)。
 * `exactFromEmpties: 24` により、空きマスが24以下になった局面では自動的に完全読みに
 * 切り替わる(要件6。エンジン側が実際の空きマス数と比較して判断するため、
 * この定数を対局中ずっと使い続けるだけでよい)。
 *
 * `timeMs`について(T076): 当初 `300`(0.3秒)だったが、ユーザー報告
 * (合法手数が多い局面で、実際に打った明らかに良い手が「失敗」、悪手が
 * 「正解手」と誤判定される)の調査により、`engine/src/search.rs`の
 * `search_all_moves_with_eval`が候補手ごとに時間予算を公平に分け合うよう
 * 修正された後も、`300`ms全体では合法手数が多い局面(12箇所等)で1手あたり
 * 数十msしか確保できず、深さ不足による誤ったランキングが残ることが実測で
 * 確認された(作業ログ参照)。要件3が許容する「1回の評価が数秒以内」の
 * 範囲に収まる`1000`(1秒)に引き上げ、実測で誤判定が解消することを確認した。
 */
const MIDGAME_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 1000, exactFromEmpties: 24 }

/** 相手が着手するまでの見せかけの「考慮時間」(ミリ秒、`joseki/PracticeMode.tsx`と同じ演出)。 */
const OPPONENT_MOVE_DELAY_MS = 350

/** クリア条件: 手番に依らずプレイヤー視点の石差がこの値以上ならクリア(要件6)。 */
const CLEAR_MARGIN = 2

/** `'stageSelect'`はステージ一覧画面(T119要件2)。 */
type Phase = 'settings' | 'stageSelect' | 'generating' | 'playing' | 'result'

interface SessionState {
  readonly board: BoardState
  readonly sideToMove: Side
  /** プレイヤーが担当する色。開始局面の手番側をそのままプレイヤーとする。 */
  readonly humanSide: Side
  readonly lastMove: number | null
  /** 逆転禁止モード用に持ち回す、直近の非ゼロ評価符号。 */
  readonly previousSign: EvalSign
  /**
   * この局面がステージ一覧経由で開始された場合、そのステージの安定キー
   * (`stagePool.ts`の`MidgameStage.key`)。ランダム練習(定石終端ランダム・
   * 自己対局ランダム)経由なら`null`(要件4「ステージ経由でないランダム練習は
   * 記録対象外」)。
   *
   * `activeStage`(コンポーネントstate)と役割が重なるように見えるが、
   * こちらは`SessionState`の一部として`checkEnd`/`finishByFinalScore`/
   * `handleModeFailure`に**値渡し**されるため、`recordStageAttemptNow`の
   * 呼び出しが「呼び出し時点で最新のstate」に依存しない(T117 redo #1で
   * 判明したのと同種の、非同期処理中のstate古さ問題を最初から避ける設計)。
   */
  readonly stageKey: string | null
}

interface ComparePv {
  readonly yourContinuation: readonly string[]
  readonly correctContinuation: readonly string[] | null
}

interface ClearResultInfo {
  readonly kind: 'clear'
  readonly margin: number
}

interface FailResultInfo {
  readonly kind: 'fail'
  readonly reasonKind: JudgeMidgameReasonKind | 'insufficientMargin'
  readonly playedMove?: string
  readonly playedSquare?: number
  readonly lossDiscs?: number
  readonly bestMove?: string | null
  readonly bestSquare?: number | null
  readonly margin?: number
  readonly preMoveBoard?: BoardState
  readonly preMoveSide?: Side
  readonly comparePv: ComparePv | null
  /**
   * T128: 判定モードによる失敗(`handleModeFailure`)で検出された明確な悪化
   * パターン(要件1・3)。`null`は「特徴量取得に失敗した」等のフォールバック、
   * または`checkEnd`/`finishByFinalScore`由来の失敗(特定の1手に起因しない、
   * `preMoveBoard`等が無いケース)で使われる。ゲート自体が「パターン0件=合格
   * 扱い」なので、この配列が存在する場合は常に1件以上を含む。
   */
  readonly clearBlunderPatterns?: readonly ClearBlunderPattern[] | null
}

type ResultInfo = ClearResultInfo | FailResultInfo

const JUDGE_MODE_OPTIONS: readonly { value: JudgeMode; label: string }[] = [
  { value: 'strict', label: '厳格(最善手のみ正解)' },
  { value: 'standard', label: '標準(石差ロス1.0以内は正解)' },
  { value: 'noReversal', label: '逆転禁止(優勢/劣勢が入れ替わったら失敗)' },
]

const OPPONENT_STRENGTH_OPTIONS: readonly { value: OpponentStrength; label: string }[] = [
  { value: 'top3Random', label: '上位3手ランダム' },
  { value: 'best', label: '最善' },
]

const START_SOURCE_OPTIONS: readonly { value: StartPositionSource; label: string }[] = [
  { value: 'josekiEnd', label: '定石終端からランダム' },
  { value: 'selfPlayRandom', label: 'ランダム自己対局局面' },
]

const REASON_LABEL: Record<JudgeMidgameReasonKind | 'insufficientMargin', string> = {
  ok: '正解',
  notBest: '最善手ではありませんでした',
  lossExceeded: '最善手からのロスが大きすぎました',
  reversed: '評価の優勢/劣勢が入れ替わりました',
  noLegalMoves: '合法手がありませんでした',
  moveNotFound: '着手の評価が見つかりませんでした',
  insufficientMargin: '優勢(+2石以上)を維持できませんでした',
}

function formatContinuation(moves: readonly string[]): string {
  return moves.length > 0 ? moves.join(' → ') : '(進行なし)'
}

/**
 * 中盤練習モード(T021)。
 *
 * 設計書 `othello-trainer-design.md` §4「中盤練習モード」の実装(タスク仕様の
 * スコープ縮小を適用。詳細は `tasks/T021-midgame-practice-mode.md` 参照):
 * 1. 判定モード・相手の強さ・開始局面ソースを選択して開始する。
 * 2. 開始局面の手番側をそのままプレイヤーが担当する(色選択は行わない)。
 * 3. プレイヤーが着手するたび `requestAnalyzeAll` → `judgeMidgameMove` で判定する。
 * 4. 相手の着手は `pickOpponentMove` で選ぶ。
 * 5. 空き24以下で自動的に完全読みへ切り替わり(`MIDGAME_ANALYZE_LIMIT`)、
 *    プレイヤー視点の評価が+2石以上ならクリア、そうでなければ失敗とする。
 * 6. 失敗時は出題プール(IndexedDB `midgamePool`)に開始局面を自動登録する。
 *
 * レスポンシブ対応: 375px幅程度でも崩れないよう `PracticeMode.css` で
 * ボタン群・結果表示を `flex-wrap` させ、狭幅では縦積みにする。
 */
export function PracticeMode() {
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [josekiDbError, setJosekiDbError] = useState<string | null>(null)

  const [judgeMode, setJudgeMode] = useState<JudgeMode>(() => loadJudgeMode(localStorage))
  const [opponentStrength, setOpponentStrength] = useState<OpponentStrength>('top3Random')
  const [startSource, setStartSource] = useState<StartPositionSource>('josekiEnd')

  const [phase, setPhase] = useState<Phase>('settings')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const [startInfo, setStartInfo] = useState<StartPosition | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null)

  // --- ステージ一覧(T119) ---
  /** 定石DBが読み込まれ次第、決定的な順序で1回だけ列挙する(`josekiDb`が変わらない限り再計算しない)。 */
  const stagePool = useMemo<MidgameStage[] | null>(
    () => (josekiDb ? buildMidgameStagePool(josekiDb) : null),
    [josekiDb],
  )
  /** ステージ挑戦記録(判定モード別、要件3)。起動時に`localStorage`から1回読み込む。 */
  const [stageProgress, setStageProgress] = useState<StageProgress>(() => loadStageProgress(localStorage))
  /**
   * ステージ一覧の復習フィルタ(T130要件1・3)。`localStorage`から起動時に1回
   * 読み込む。判定は現在選択中の判定モード(`judgeMode`)の記録で行う(要件2)。
   */
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(() =>
    loadReviewFilter(localStorage, MIDGAME_REVIEW_FILTER_STORAGE_KEY),
  )
  /** 現在の(または直前の)セッションが開始されたステージ。ランダム練習中は`null`。 */
  const [activeStage, setActiveStage] = useState<MidgameStage | null>(null)
  /** 直前のクリアで新たに★を獲得した(このステージ×判定モードの初クリア)場合`true`(要件5)。 */
  const [justEarnedStar, setJustEarnedStar] = useState(false)

  // --- 苦手パターン統計(T129) ---
  /** 明確な悪化パターンの失敗回数(要件1)。起動時に`localStorage`から1回読み込む。 */
  const [patternStats, setPatternStats] = useState<PatternStats>(() => loadPatternStats(localStorage))
  /** 「記録をリセット」ボタンの確認ステップ中かどうか(要件3、`window.confirm`に頼らないインライン確認)。 */
  const [confirmingPatternStatsReset, setConfirmingPatternStatsReset] = useState(false)

  const [showEvalBar, setShowEvalBar] = useState(false)
  const [evalBarValue, setEvalBarValue] = useState<number | null>(null)

  const [opponentThinking, setOpponentThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  /**
   * 空き24以下になり完全読みで終局判定を確定させている間`true`(T055)。
   * `checkEnd`のエンジン問い合わせは非同期のため、これが無いと「まだ打てそうな
   * 盤面が見えているのに、次の瞬間いきなり結果画面に切り替わる」という唐突な
   * 体感になる(T021で明記済みの「+2石以上を瞬間的な閾値到達で判定する」簡略化
   * 自体は意図的な設計のため変更しないが、遷移前にひと呼吸置く表示を挟む)。
   */
  const [finalizing, setFinalizing] = useState(false)

  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)

  /**
   * 候補手評価オーバーレイ表示用と着手後の判定用とで、同じ着手前局面に対して
   * 別々に`requestAnalyzeAll`を呼ぶと、探索が壁時計ベースの時間予算配分
   * (`engine/src/search.rs`の`fair_share_time_ms`)であるため、僅差の候補手の
   * 順位が実行タイミングの揺らぎで変動しうる(T076の作業ログで実測済みの
   * 既知のnon-determinism)。これにより「オーバーレイが示した最善手を打った
   * のに判定は失敗」という矛盾した体験が発生した(T078のユーザー報告)。
   * この`ref`は着手前局面(`board`の参照同一性で識別。`session`更新のたびに
   * `applyMove`等で新しいオブジェクトが生成されるため、同一局面である間は
   * 参照が変わらない)に対する`requestAnalyzeAll`の結果(Promise)を1つだけ
   * 保持し、オーバーレイ表示用のeffectと`handlePlayerMove`の判定の両方が
   * この同一のPromiseを共有することで、表示と判定が原理的に同じデータ
   * ソースになることを保証する(要件1・2)。
   */
  const analyzedMovesRef = useRef<{
    readonly board: BoardState
    readonly side: Side
    readonly promise: Promise<MoveEvalJson[]>
  } | null>(null)

  /**
   * セッション世代カウンタ(T119 redo #1: codex-review指摘(b)1)。
   *
   * `checkEnd`(完全読みの`requestAnalyzeAll`)・`handleModeFailure`
   * (比較PV取得の`requestAnalyze`)はいずれも非同期処理を挟んでから
   * `setPhase('result')`・`setResultInfo`・ステージ挑戦記録
   * (`recordStageAttemptNow`)を行う。この非同期処理が進行中に「やめる」
   * (`backToSettings`)やステージ一覧へ戻る(`goToStageSelect`)、あるいは
   * 新しいセッション開始(`resetSessionTo`)でユーザーが画面を離れると、
   * 古い(既に離脱済みの)判定が完了した時点でそのまま結果確定・記録・★付与
   * まで実行してしまい、無関係な画面状態やステージの進捗を書き換えてしまう
   * 不具合があった(元々は`loadFailExplanation`用の世代カウンタと同種の
   * 問題だったが、こちらは`localStorage`の永続データにも波及するため深刻)。
   *
   * `resetSessionTo`(新しいセッション開始)・`backToSettings`・
   * `goToStageSelect`(いずれもセッションからの離脱・切り替え)でこの値を
   * インクリメントする。非同期処理を開始する側(`checkEnd`・
   * `handlePlayerMove`・相手着手の`useEffect`)は開始時点の値を`generation`
   * として捕まえ、`await`から戻ってきた際に`sessionGenerationRef.current`と
   * 一致するか(=まだ同じセッションが有効か)を確認してから結果確定・記録の
   * 副作用を実行する。
   */
  const sessionGenerationRef = useRef(0)

  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  /**
   * 着手前局面(`board`・`side`)に対する全合法手評価を取得する(T078)。
   * `analyzedMovesRef`に同一局面(参照同一性)・同一手番のキャッシュがあれば
   * エンジンには再度問い合わせず、そのPromiseをそのまま返す。オーバーレイ
   * 表示用のeffectと`handlePlayerMove`の判定処理の両方がこの関数を通して
   * 同じ結果を参照するため、「表示された最善手を打ったのに判定は別の結果」
   * という不整合が原理的に起こらなくなる。
   */
  function getAnalyzedMoves(board: BoardState, side: Side): Promise<MoveEvalJson[]> {
    const cached = analyzedMovesRef.current
    if (cached && cached.board === board && cached.side === side) {
      return cached.promise
    }
    const promise = getEngine().requestAnalyzeAll(board, side, MIDGAME_ANALYZE_LIMIT)
    analyzedMovesRef.current = { board, side, promise }
    return promise
  }

  // 定石DB(public/joseki.json)を読み込む。`loadJosekiDb`はモジュール内でキャッシュ
  // しているため、他モード(対局・定石練習)と併用しても実際のfetchは1回だけ発生する。
  useEffect(() => {
    let cancelled = false
    loadJosekiDb()
      .then((db) => {
        if (!cancelled) setJosekiDb(db)
      })
      .catch((error: unknown) => {
        console.error('定石DBの読み込みに失敗しました', error)
        if (!cancelled) setJosekiDbError('定石DBの読み込みに失敗しました。ページを再読み込みしてください。')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * ステージ挑戦記録(要件3・4)を**同期的に**更新する(T117 redo #1の教訓を
   * 最初から反映: IndexedDB書き込み(`registerFailure`)や結果画面表示より
   * 前、いずれの`await`よりも前に呼ぶこと)。`stageKey`が`null`(ステージ経由
   * でないランダム練習)なら何もしない(要件4)。
   *
   * 戻り値: このクリアで新たに★を獲得したか(このステージ×現在の判定モードの
   * 初クリアだったか、要件5「★獲得!」表示に使う)。`kind === 'fail'`のときは
   * 常に`false`。
   */
  function recordStageAttemptNow(stageKey: string | null, kind: 'clear' | 'fail'): boolean {
    if (!stageKey) return false
    try {
      // stateの`stageProgress`(前回レンダー時点のスナップショット)ではなく
      // `localStorage`から直接読み直す。`checkEnd`等は`session`に格納された
      // `stageKey`を経由するため実害は薄いが、「初クリア判定」は正確性が
      // 重要なため、より確実な情報源(永続化ストレージそのもの)を使う。
      const before = loadStageProgress(localStorage)[stageKey]?.[judgeMode]
      const alreadyCleared = (before?.clearCount ?? 0) > 0
      const nextProgress = recordStageAttempt(localStorage, stageKey, judgeMode, kind)
      setStageProgress(nextProgress)
      return kind === 'clear' && !alreadyCleared
    } catch (error) {
      console.error('ステージ挑戦記録の保存に失敗しました', error)
      return false
    }
  }

  /**
   * 苦手パターン統計(要件1)を**同期的に**更新する。`recordStageAttemptNow`と
   * 同じ理由(T117教訓)で、呼び出し側は非同期処理より前(かつ
   * `sessionGenerationRef`の世代ガード通過が確認できているタイミング)で呼ぶ
   * こと。`patternIds`が空(=明確な悪化パターンが検出されなかった、ゲートで
   * 合格扱いになった手)の場合は何もしない(要件1「ゲートで合格扱いになった
   * 手は記録しない」)。
   */
  function recordPatternFailuresNow(patternIds: readonly ClearBlunderPatternId[]): void {
    if (patternIds.length === 0) return
    try {
      const next = recordPatternFailures(localStorage, patternIds)
      setPatternStats(next)
    } catch (error) {
      console.error('苦手パターン統計の保存に失敗しました', error)
    }
  }

  /** 苦手パターン統計の「記録をリセット」を確定する(要件3)。 */
  function handleResetPatternStats(): void {
    try {
      setPatternStats(resetPatternStats(localStorage))
    } catch (error) {
      console.error('苦手パターン統計のリセットに失敗しました', error)
    }
    setConfirmingPatternStatsReset(false)
  }

  /**
   * 終了判定(要件6)。
   * - `resolveMover`で実際に手番を持つ側を解決する。`sideToMove`に合法手が無くても
   *   相手側に合法手があれば単なるパスであり真の終局ではない(`game/gameLoop.ts`の
   *   `afterMove`と同じ規則。reviewer指摘のmust 1: 以前は`sideToMove`側の合法手なし
   *   =即終局と誤判定しており、終盤(空き24以下は`exactFromEmpties`により毎手この
   *   関数を通る)でパスが起きるたびに誤って「失敗」を確定してしまい、クリアまで
   *   到達できなくなっていた)。両者とも合法手が無い場合のみ真の終局として確定する。
   * - 実際の手番側に空きマスが24以下なら、`requestAnalyzeAll`(完全読み)で
   *   プレイヤー視点の評価を求め、+2石以上ならクリア、そうでなければ失敗とする。
   * - それ以外(まだ空き24超)は何もしない(`false`を返す)。
   * 戻り値は「この呼び出しでゲームが終了したか」。
   *
   * `stageKey`(T119): このセッションがステージ一覧経由なら対応する安定キー、
   * そうでなければ`null`(`session.stageKey`をそのまま渡す。要件4)。
   *
   * `generation`(T119 redo #1): 呼び出し元が`sessionGenerationRef.current`を
   * 捕まえて渡す。`requestAnalyzeAll`の`await`から戻った時点でこの値が
   * `sessionGenerationRef.current`と一致しなければ、その間にセッションが
   * 切り替わった(離脱・新規開始)とみなし、結果確定・記録を一切行わずに
   * 抜ける(codex-review指摘(b)1)。
   */
  async function checkEnd(
    board: BoardState,
    sideToMove: Side,
    humanSide: Side,
    stageKey: string | null,
    generation: number,
  ): Promise<boolean> {
    const mover = resolveMover(board, sideToMove)
    if (mover === null) {
      finishByFinalScore(board, humanSide, stageKey, generation)
      return true
    }
    if (countEmpty(board) > 24) return false

    // ここから先は完全読みでクリア/失敗を確定させる(体感上は「唐突」になりやすい
    // 区間なので、確定作業中であることをUIに表示する。要件2参照)。
    setFinalizing(true)
    try {
      const allMoves = await getEngine().requestAnalyzeAll(board, mover, MIDGAME_ANALYZE_LIMIT)
      if (sessionGenerationRef.current !== generation) {
        // このawait中にセッションが切り替わった(要件4系の副作用は行わない)。
        return false
      }
      if (allMoves.length === 0) {
        // `resolveMover`が`mover`に合法手ありと判定したにもかかわらず`allMoves`が
        // 空、という通常は起こらないはずの不整合に対する防御的フォールバック。
        finishByFinalScore(board, humanSide, stageKey, generation)
        return true
      }
      const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
      const humanEval = mover === humanSide ? best.discDiff : -best.discDiff
      setEvalBarValue(humanEval)

      if (humanEval >= CLEAR_MARGIN) {
        const earnedStar = recordStageAttemptNow(stageKey, 'clear')
        setJustEarnedStar(earnedStar)
        setShowEvalBar(false)
        setPhase('result')
        setResultInfo({ kind: 'clear', margin: humanEval })
        return true
      }

      recordStageAttemptNow(stageKey, 'fail')
      setJustEarnedStar(false)
      setShowEvalBar(true)
      setPhase('result')
      setResultInfo({
        kind: 'fail',
        reasonKind: humanEval < 0 ? 'reversed' : 'insufficientMargin',
        margin: humanEval,
        comparePv: null,
      })
      await registerFailure()
      return true
    } catch (error) {
      console.error('終盤判定のための解析に失敗しました', error)
      return false
    } finally {
      // クリア/失敗いずれの場合も`phase`は既に`'result'`へ遷移済みなのでこの
      // フラグは表示に影響しないが、解析エラーで対局が続行するケース(catch節)
      // のために確実にリセットしておく。
      setFinalizing(false)
    }
  }

  /**
   * `generation`(T119 redo #1): `checkEnd`から呼ばれる場合(`await`後の
   * 分岐)・`checkEnd`自体の冒頭(`mover === null`、同期的な呼び出し)の
   * いずれの経路でも、`sessionGenerationRef.current`と一致する場合のみ
   * 結果を確定する。呼び出し元がその時点で既に古い場合(セッションが
   * 切り替わった後に呼ばれた場合)はここで弾く(codex-review指摘(b)1)。
   */
  function finishByFinalScore(board: BoardState, humanSide: Side, stageKey: string | null, generation: number): void {
    if (sessionGenerationRef.current !== generation) return
    const humanDiscs = countDiscs(board, humanSide)
    const oppDiscs = countDiscs(board, opposite(humanSide))
    const margin = humanDiscs - oppDiscs
    setEvalBarValue(margin)
    if (margin >= CLEAR_MARGIN) {
      const earnedStar = recordStageAttemptNow(stageKey, 'clear')
      setJustEarnedStar(earnedStar)
      setShowEvalBar(false)
      setPhase('result')
      setResultInfo({ kind: 'clear', margin })
    } else {
      recordStageAttemptNow(stageKey, 'fail')
      setJustEarnedStar(false)
      setShowEvalBar(true)
      setPhase('result')
      setResultInfo({
        kind: 'fail',
        reasonKind: margin < 0 ? 'reversed' : 'insufficientMargin',
        margin,
        comparePv: null,
      })
      void registerFailure()
    }
  }

  /** 失敗した開始局面を出題プール(IndexedDB)に登録する(要件7)。 */
  async function registerFailure(): Promise<void> {
    if (!startInfo) return
    try {
      await addPoolEntry({
        id: `midgame-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        board: { black: bigintToHex(startInfo.board.black), white: bigintToHex(startInfo.board.white) },
        turn: startInfo.sideToMove,
        source: 'blunder-review',
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error('出題プールへの登録に失敗しました', error)
    }
  }

  // 相手(エンジン)の手番になったら、`pickOpponentMove`で着手を選んで適用する。
  useEffect(() => {
    if (phase !== 'playing' || !session) return
    const s = session
    if (s.sideToMove === s.humanSide) return
    if (!hasLegalMove(s.board, s.sideToMove)) return

    let cancelled = false
    setOpponentThinking(true)

    async function run(): Promise<void> {
      try {
        const allMoves = await getEngine().requestAnalyzeAll(s.board, s.sideToMove, MIDGAME_ANALYZE_LIMIT)
        if (cancelled) return
        const moveNotation = pickOpponentMove(allMoves, opponentStrength)
        await new Promise((resolve) => setTimeout(resolve, OPPONENT_MOVE_DELAY_MS))
        if (cancelled || moveNotation === null) return

        const square = notationToSquare(moveNotation)
        const board = applyMove(s.board, s.sideToMove, square)
        const nextSide = resolveNextSideOrFallback(board, opposite(s.sideToMove))
        setSession({ ...s, board, sideToMove: nextSide, lastMove: square })
        // この時点で`cancelled`がfalseということは、離脱・切り替えはまだ
        // 起きていない=`sessionGenerationRef.current`は現在有効な世代
        // (T119 redo #1)。`checkEnd`内部の`await`中に離脱された場合は
        // `checkEnd`自身の世代チェックで弾かれる。
        await checkEnd(board, nextSide, s.humanSide, s.stageKey, sessionGenerationRef.current)
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
  }, [phase, session, opponentStrength])

  // 盤面セル評価オーバーレイ(T039をT042で展開)。人間の手番になった時点で、表示の
  // ON/OFFに関わらず現局面(着手前)の全合法手の評価をまとめて取得する(T078)。
  // オーバーレイ表示のON/OFFで取得自体を切り替えていた以前の実装では、着手後の
  // 判定(`handlePlayerMove`)が別途もう一度`requestAnalyzeAll`を呼んでおり、
  // 探索の壁時計ベースの時間予算配分による僅差のノイズで両者の結果が食い違う
  // ことがあった。ここでは常に`getAnalyzedMoves`(内部で`analyzedMovesRef`に
  // キャッシュ)を通して取得し、判定側もこの結果をそのまま再利用することで、
  // 表示と判定のデータソースを1本化する(要件1〜3)。表示するかどうかは
  // `MoveEvalOverlay`の`visible`propで制御する(取得自体は常に行う)。
  useEffect(() => {
    if (phase !== 'playing' || !session || session.sideToMove !== session.humanSide) {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    getAnalyzedMoves(session.board, session.sideToMove)
      .then((moves) => {
        if (!cancelled) setOverlayMoves(moves)
      })
      .catch((error: unknown) => {
        console.error('候補手評価の取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [phase, session])

  /** オーバーレイ表示ON/OFFを切り替え、`localStorage`へ永続化する(T039・T042、他モードと共有)。 */
  function handleToggleMoveEvalOverlay(enabled: boolean): void {
    setMoveEvalOverlayEnabled(enabled)
    saveMoveEvalOverlayEnabled(localStorage, enabled)
  }

  /**
   * 判定モードによる失敗(要件4・8)。比較PVを取得して結果画面に表示する。
   * この関数は必ず失敗確定を意味する(呼び出し元がゲート
   * (`detectClearBlunderPatterns`、要件2)を通過させた場合のみ呼ばれる)ため、
   * ステージ挑戦記録は関数の**先頭**(比較PV取得の`await`より前、呼び出し元が
   * 直前に検証した`generation`がまだ有効な同期的タイミング)で行う
   * (T117 redo #1の教訓)。
   *
   * `clearBlunderPatterns`(T128要件3): 呼び出し元(`handlePlayerMove`)が
   * ゲート判定のために既に取得済みの`detectClearBlunderPatterns`の結果
   * (1件以上)をそのまま結果画面の表示用に渡す。特徴量取得に失敗した場合の
   * フォールバック経路では`null`。
   *
   * `allDetectedPatternIds`(T129要件1): 呼び出し元が`detectAllClearBlunderPatterns`
   * (表示上限による切り詰め前の全件)から取り出したパターンID一覧。
   * 苦手パターン統計への加算はこちらを使う(`clearBlunderPatterns`は表示用に
   * 最大2件へ切り詰められているため統計には使わない)。既定値`[]`
   * (呼び出し元がゲートを経由しない失敗経路、またはフォールバック経路)では
   * `recordPatternFailuresNow`が何もしない。
   *
   * `generation`(T119 redo #1): 比較PV取得の`await`を挟んだ後、
   * `setPhase('result')`等を確定する前に`sessionGenerationRef.current`と
   * 突き合わせ、その間に離脱・切り替えがあれば結果画面への遷移を行わない
   * (codex-review指摘(b)1)。
   */
  async function handleModeFailure(
    s: SessionState,
    square: number,
    playedNotation: string,
    judgement: JudgeMidgameMoveResult,
    generation: number,
    clearBlunderPatterns: readonly ClearBlunderPattern[] | null,
    allDetectedPatternIds: readonly ClearBlunderPatternId[] = [],
  ): Promise<void> {
    recordStageAttemptNow(s.stageKey, 'fail')
    recordPatternFailuresNow(allDetectedPatternIds)
    setJustEarnedStar(false)
    const opponentSide = opposite(s.sideToMove)
    const boardAfterPlayed = applyMove(s.board, s.sideToMove, square)
    let comparePv: ComparePv | null = null
    let bestSquare: number | null = null

    try {
      const playedResp = await getEngine().requestAnalyze(boardAfterPlayed, opponentSide, MIDGAME_ANALYZE_LIMIT)
      let correctContinuation: readonly string[] | null = null

      if (judgement.bestMove) {
        bestSquare = notationToSquare(judgement.bestMove)
        const boardAfterBest = applyMove(s.board, s.sideToMove, bestSquare)
        const bestResp = await getEngine().requestAnalyze(boardAfterBest, opponentSide, MIDGAME_ANALYZE_LIMIT)
        correctContinuation = [judgement.bestMove, ...bestResp.pv]
      }

      comparePv = {
        yourContinuation: [playedNotation, ...playedResp.pv],
        correctContinuation,
      }
    } catch (error) {
      console.error('比較PV取得のための解析に失敗しました', error)
    }

    if (sessionGenerationRef.current !== generation) return // T119 redo #1: 離脱済みなら結果画面へ遷移しない

    setEvalBarValue(judgement.playedDiscDiff ?? judgement.bestDiscDiff ?? 0)
    setShowEvalBar(true)
    setPhase('result')
    setResultInfo({
      kind: 'fail',
      reasonKind: judgement.reasonKind,
      playedMove: playedNotation,
      playedSquare: square,
      lossDiscs: judgement.lossDiscs,
      bestMove: judgement.bestMove,
      bestSquare,
      preMoveBoard: s.board,
      preMoveSide: s.sideToMove,
      comparePv,
      clearBlunderPatterns,
    })
    await registerFailure()
  }

  /**
   * 着手を確定して次に進む(要件3・4の「正解」経路と、T128要件2「ゲート通過
   * (明確な悪化パターンが1件も無い)」経路の両方で使う共通処理)。着手を
   * 適用してセッションを更新し、`checkEnd`で終局判定まで行う。
   */
  async function applyMoveAndContinue(s: SessionState, square: number, nextSign: EvalSign, generation: number): Promise<void> {
    const board = applyMove(s.board, s.sideToMove, square)
    const nextSide = resolveNextSideOrFallback(board, opposite(s.sideToMove))
    setSession({
      board,
      sideToMove: nextSide,
      humanSide: s.humanSide,
      lastMove: square,
      previousSign: nextSign,
      stageKey: s.stageKey,
    })
    await checkEnd(board, nextSide, s.humanSide, s.stageKey, generation)
  }

  /**
   * 人間がボードをクリックしたときの処理(要件3・4)。
   *
   * `analyzing`(前回のクリックの判定が完了する前)であれば無視する。連打・
   * ダブルクリックによって`requestAnalyzeAll`が同じ着手前局面に対して複数回
   * 同時発行され、それぞれが古い`session`を元に`setSession`/`checkEnd`を
   * 呼んでしまう(状態の競合・多重更新)のを防ぐための再入防止ガード。
   *
   * 判定用の全合法手評価は`getAnalyzedMoves`経由で取得する(T078)。人間の
   * 手番になった時点でオーバーレイ用に既にリクエスト済み(・多くの場合は
   * 着手までの間に解決済み)のPromiseがあればそれをそのまま再利用し、判定の
   * ためだけに同じ局面をもう一度エンジンに問い合わせることはしない。これに
   * より、オーバーレイ表示と判定の評価データが常に同一のエンジン呼び出し
   * 結果に基づくことが保証され、両者が矛盾することがなくなる。
   *
   * T128要件2(明確な悪化パターン判定のゲート): `judgeMidgameMove`が不合格と
   * 判定した場合でも、即座に`handleModeFailure`を呼ばず、まず両手
   * (実際の手・最善手)の`requestFeatureSet`を取得して
   * `detectClearBlunderPatterns`にかける。明確な悪化パターンが1件も検出
   * されなければ「深読みしないと説明できない微差」とみなし、合格と同じ経路
   * (`applyMoveAndContinue`)で対局を続行する(ユーザー裁定)。特徴量取得
   * 自体に失敗した場合は、従来どおり評価値のみで不合格として扱う
   * (フォールバック、`clearBlunderPatterns: null`)。
   */
  async function handlePlayerMove(square: number): Promise<void> {
    if (phase !== 'playing' || !session || analyzing) return
    const s = session
    if (s.sideToMove !== s.humanSide) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    // T119 redo #1: この時点(`getAnalyzedMoves`のawait前)での世代を捕まえ、
    // await後に一致するか確認してから結果確定・記録を行う(codex-review指摘(b)1)。
    const generation = sessionGenerationRef.current
    setAnalyzing(true)
    try {
      const allMoves = await getAnalyzedMoves(s.board, s.sideToMove)
      if (sessionGenerationRef.current !== generation) return // 離脱済み
      const playedNotation = squareToNotation(square)
      const judgement = judgeMidgameMove({
        mode: judgeMode,
        allMoves,
        playedMove: playedNotation,
        previousSign: s.previousSign,
      })

      if (!judgement.correct) {
        if (judgement.bestMove) {
          const bestSquare = notationToSquare(judgement.bestMove)
          try {
            const [playedFeatureResp, bestFeatureResp] = await Promise.all([
              getEngine().requestFeatureSet(s.board, s.sideToMove, playedNotation),
              getEngine().requestFeatureSet(s.board, s.sideToMove, judgement.bestMove),
            ])
            if (sessionGenerationRef.current !== generation) return // 離脱済み
            const clearBlunderInput = {
              preMoveBoard: s.board,
              preMoveSide: s.sideToMove,
              playedSquare: square,
              bestSquare,
              playedFeatures: playedFeatureResp.features,
              bestFeatures: bestFeatureResp.features,
            }
            const patterns = detectClearBlunderPatterns(clearBlunderInput)
            if (patterns === null) {
              // 明確な悪化パターンが無い → 合格扱い(要件2、ユーザー裁定)。
              // T129要件1: ゲートで合格扱いになった手は苦手パターン統計にも記録しない。
              await applyMoveAndContinue(s, square, judgement.nextSign, generation)
              return
            }
            // T129要件1: 表示は`patterns`(最大2件)に留めるが、統計には検出全件のIDを渡す。
            const allDetectedPatternIds = detectAllClearBlunderPatterns(clearBlunderInput).map((p) => p.id)
            await handleModeFailure(s, square, playedNotation, judgement, generation, patterns, allDetectedPatternIds)
            return
          } catch (error) {
            console.error('明確な悪化パターン判定用の特徴量取得に失敗しました', error)
            // T128b(codex-review指摘・中1、tasks/review/T128-clear-blunder-claude-review.md):
            // Promise.allのawaitがreject後に戻った時点でも、他のawait後の分岐と同様に
            // 世代チェックを行う。これが無いと、requestFeatureSet待ちの間にユーザーが
            // 離脱(backToSettings等)していた場合、離脱済みセッションのfail記録が
            // localStorageに書き込まれてしまう(T119で対処したのと同型のstale書き込み)。
            if (sessionGenerationRef.current !== generation) return // 離脱済み
            // フォールバック: ゲートを適用できないため、従来どおり評価値のみで不合格とする。
            await handleModeFailure(s, square, playedNotation, judgement, generation, null)
            return
          }
        }
        await handleModeFailure(s, square, playedNotation, judgement, generation, null)
        return
      }

      await applyMoveAndContinue(s, square, judgement.nextSign, generation)
    } catch (error) {
      console.error('着手判定のための解析に失敗しました', error)
    } finally {
      setAnalyzing(false)
    }
  }

  /**
   * 開始局面をセットする。開始局面自体が(通常は起こらないはずだが)既に手番側に
   * 合法手が無い局面である可能性に備え、他の遷移箇所と同様に`resolveNextSideOrFallback`
   * で実際の手番側を解決してから`session`に反映し、`checkEnd`で終局判定まで行う
   * (T055、対局・詰めオセロ各モードと同じく「着手/開始適用と終局判定を同期させる」
   * 方針を開始時にも適用する)。
   *
   * `stage`(T119要件4): ステージ一覧経由の開始なら対応する`MidgameStage`を渡す。
   * `activeStage`(表示用state)と`session.stageKey`(記録処理が実際に読む値)の
   * 両方をここで同時に設定するため、両者が食い違うことはない。
   *
   * T119 redo #1: 新しいセッションを開始するたびに`sessionGenerationRef`を
   * インクリメントする。これにより、直前のセッションで進行中だった
   * 非同期の判定(`checkEnd`・`handleModeFailure`)が後から完了しても、
   * 古い世代とみなされて結果確定・記録を行わなくなる(codex-review指摘(b)1)。
   */
  function resetSessionTo(start: StartPosition, stage: MidgameStage | null = null): void {
    sessionGenerationRef.current += 1
    const generation = sessionGenerationRef.current
    setStartInfo(start)
    setActiveStage(stage)
    setJustEarnedStar(false)
    const sideToMove = resolveNextSideOrFallback(start.board, start.sideToMove)
    setSession({
      board: start.board,
      sideToMove,
      humanSide: start.sideToMove,
      lastMove: null,
      previousSign: 0,
      stageKey: stage?.key ?? null,
    })
    setResultInfo(null)
    setShowEvalBar(false)
    setEvalBarValue(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
    setPhase('playing')
    void checkEnd(start.board, sideToMove, start.sideToMove, stage?.key ?? null, generation)
  }

  /**
   * 設定画面で「開始」を押したときの処理(要件1・2、ランダム練習)。
   * ステージ経由でない(=要件4「ランダム練習は記録対象外」)ため、
   * `resetSessionTo`に`stage`を渡さない(既定の`null`のまま)。
   */
  async function startPractice(): Promise<void> {
    if (!josekiDb) return
    setStarting(true)
    setStartError(null)
    setPhase('generating')
    try {
      const start =
        startSource === 'josekiEnd' ? pickJosekiEndPosition(josekiDb) : await generateSelfPlayPosition(getEngine())
      resetSessionTo(start)
    } catch (error) {
      console.error('開始局面の生成に失敗しました', error)
      setStartError('開始局面の生成に失敗しました。もう一度お試しください。')
      setPhase('settings')
    } finally {
      setStarting(false)
    }
  }

  /** ステージ一覧のセルをクリックしたときの処理(T119要件2)。 */
  function startStagePractice(stage: MidgameStage): void {
    setStartError(null)
    resetSessionTo({ board: stage.board, sideToMove: stage.sideToMove }, stage)
  }

  /** 結果画面の「ここからやり直す」ボタン(要件8): 同じ開始局面から再挑戦する。ステージ経由なら`activeStage`を引き継ぐ。 */
  function retryFromStart(): void {
    if (!startInfo) return
    resetSessionTo(startInfo, activeStage)
  }

  /**
   * T119 redo #1: セッションから離脱するので`sessionGenerationRef`を
   * インクリメントする(`resetSessionTo`と同じ理由、codex-review指摘(b)1)。
   */
  function backToSettings(): void {
    sessionGenerationRef.current += 1
    setPhase('settings')
    setSession(null)
    setStartInfo(null)
    setResultInfo(null)
    setShowEvalBar(false)
    setEvalBarValue(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
    setActiveStage(null)
  }

  /**
   * ステージ一覧画面を開く(T119要件2)。設定画面・結果画面の両方から呼ばれる。
   * T119 redo #1: `backToSettings`と同じ理由でセッション世代をインクリメントする。
   */
  function goToStageSelect(): void {
    sessionGenerationRef.current += 1
    setPhase('stageSelect')
    setSession(null)
    setStartInfo(null)
    setResultInfo(null)
    setShowEvalBar(false)
    setEvalBarValue(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
  }

  /**
   * 結果画面の「次のステージへ」ボタン(T119要件5)。`stagePool`内で
   * `activeStage`の次の番号のステージへ進む(最終ステージ、または
   * `stagePool`未読み込みならステージ一覧へ戻る)。
   */
  function nextStage(): void {
    if (!activeStage || !stagePool) {
      goToStageSelect()
      return
    }
    const currentIndex = stagePool.findIndex((stage) => stage.key === activeStage.key)
    const next = currentIndex >= 0 ? stagePool[currentIndex + 1] : undefined
    if (next) {
      startStagePractice(next)
      return
    }
    goToStageSelect()
  }

  /** 判定モードのラジオボタン変更(要件2): 状態を更新し`localStorage`へ永続化する。 */
  function handleJudgeModeChange(mode: JudgeMode): void {
    setJudgeMode(mode)
    saveJudgeMode(localStorage, mode)
  }

  /** ステージ一覧の復習フィルタ選択を変更し、`localStorage`へ永続化する(T130要件3)。 */
  function handleReviewFilterChange(filter: ReviewFilter): void {
    setReviewFilter(filter)
    saveReviewFilter(localStorage, MIDGAME_REVIEW_FILTER_STORAGE_KEY, filter)
  }

  /**
   * T128: 失敗画面で「あなたの手のあと」「最善手のあと」を対比表示するための
   * 派生値(要件3)。判定モードによる失敗(`handleModeFailure`が`preMoveBoard`/
   * `preMoveSide`/`playedSquare`/`bestSquare`/`clearBlunderPatterns`を設定した
   * ケース)でのみ算出する。終盤の最終石差不足による失敗
   * (`checkEnd`/`finishByFinalScore`、特定の1手に起因しない)や、特徴量取得に
   * 失敗したフォールバック経路では`clearBlunderPatterns`が無い/`null`のため
   * `null`のままになる。
   */
  const clearBlunderCompareInfo =
    resultInfo?.kind === 'fail' &&
    resultInfo.preMoveBoard &&
    resultInfo.preMoveSide &&
    resultInfo.playedSquare !== undefined &&
    resultInfo.bestSquare !== undefined &&
    resultInfo.bestSquare !== null &&
    resultInfo.clearBlunderPatterns &&
    resultInfo.clearBlunderPatterns.length > 0
      ? {
          opponentSide: opposite(resultInfo.preMoveSide),
          boardAfterPlayed: applyMove(resultInfo.preMoveBoard, resultInfo.preMoveSide, resultInfo.playedSquare),
          boardAfterBest: applyMove(resultInfo.preMoveBoard, resultInfo.preMoveSide, resultInfo.bestSquare),
          playedSquare: resultInfo.playedSquare,
          bestSquare: resultInfo.bestSquare,
          patterns: resultInfo.clearBlunderPatterns,
        }
      : null

  // 苦手パターン統計(T129要件2): failCount降順で最大5件。
  const topPatternRows = topPatternStats(patternStats)

  /**
   * ステージ一覧を復習フィルタで絞り込んだもの(T130要件1)。要件2により、
   * 判定は現在選択中の判定モード(`judgeMode`)ごとの記録
   * (`stageStatusForMode`・`stageProgress[stage.key]?.[judgeMode]`)で行う
   * (グリッドの★表示自体は従来どおり全判定モード横断、`stageStarCount`のまま)。
   */
  const filteredStagePool = (stagePool ?? []).filter((stage) =>
    matchesReviewFilter(
      stageStatusForMode(stageProgress, stage.key, judgeMode),
      stageProgress[stage.key]?.[judgeMode]?.failCount ?? 0,
      reviewFilter,
    ),
  )

  return (
    <div class="midgame-practice-mode">
      {josekiDbError && <p class="notice notice--error">{josekiDbError}</p>}
      {startError && <p class="notice notice--error">{startError}</p>}

      {phase === 'settings' && (
        <section class="midgame-settings">
          <p>中盤練習モード: 条件を選んで開始してください</p>

          <div class="midgame-pattern-stats">
            <h3 class="midgame-pattern-stats__title">苦手パターン</h3>
            {topPatternRows.length === 0 ? (
              <p>まだ記録がありません。</p>
            ) : (
              <ul class="midgame-pattern-stats__list">
                {topPatternRows.map((row) => (
                  <li key={row.id}>
                    {CLEAR_BLUNDER_PATTERN_LABELS[row.id]}: {row.failCount}回
                  </li>
                ))}
              </ul>
            )}
            {topPatternRows.length > 0 &&
              (confirmingPatternStatsReset ? (
                <p class="midgame-pattern-stats__confirm">
                  本当にリセットしますか?
                  <button type="button" class="btn-primary" onClick={handleResetPatternStats}>
                    はい
                  </button>
                  <button type="button" onClick={() => setConfirmingPatternStatsReset(false)}>
                    いいえ
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  class="midgame-pattern-stats__reset"
                  onClick={() => setConfirmingPatternStatsReset(true)}
                >
                  記録をリセット
                </button>
              ))}
          </div>

          <fieldset class="midgame-settings__group">
            <legend>判定モード</legend>
            {JUDGE_MODE_OPTIONS.map(({ value, label }) => (
              <label class="midgame-settings__option" key={value}>
                <input
                  type="radio"
                  name="midgame-judge-mode"
                  value={value}
                  checked={judgeMode === value}
                  onChange={() => handleJudgeModeChange(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset class="midgame-settings__group">
            <legend>相手の強さ</legend>
            {OPPONENT_STRENGTH_OPTIONS.map(({ value, label }) => (
              <label class="midgame-settings__option" key={value}>
                <input
                  type="radio"
                  name="midgame-opponent-strength"
                  value={value}
                  checked={opponentStrength === value}
                  onChange={() => setOpponentStrength(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset class="midgame-settings__group">
            <legend>開始局面ソース</legend>
            {START_SOURCE_OPTIONS.map(({ value, label }) => (
              <label class="midgame-settings__option" key={value}>
                <input
                  type="radio"
                  name="midgame-start-source"
                  value={value}
                  checked={startSource === value}
                  onChange={() => setStartSource(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <div class="midgame-settings__buttons">
            <button type="button" class="btn-primary" disabled={!josekiDb || starting} onClick={() => void startPractice()}>
              開始
            </button>
            <button type="button" disabled={!stagePool || starting} onClick={goToStageSelect}>
              ステージ一覧
            </button>
          </div>
          {!josekiDb && !josekiDbError && <p class="notice">定石DBを読み込み中...</p>}
        </section>
      )}

      {phase === 'stageSelect' && (
        <section class="midgame-stage-select">
          <p>ステージ一覧: 挑戦したいステージを選んでください(全{stagePool?.length ?? 0}問)</p>
          <p class="midgame-stage-select__mode">
            現在の判定モード: {JUDGE_MODE_OPTIONS.find((o) => o.value === judgeMode)?.label ?? judgeMode}
            (「設定に戻る」から変更できます。判定モードごとに★は別々に記録されます)
          </p>
          <p class="midgame-stage-select__legend">
            <span class="midgame-stage-legend__mark midgame-stage-legend__mark--cleared">■</span>
            ★1つ以上(いずれかの判定モードでクリア済み)
            <span class="midgame-stage-legend__mark midgame-stage-legend__mark--attempted">■</span>
            挑戦済み未クリア
            <span class="midgame-stage-legend__mark midgame-stage-legend__mark--unattempted">■</span>
            未挑戦
          </p>

          <div class="midgame-stage-select__filters" role="group" aria-label="復習フィルタ">
            {REVIEW_FILTER_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                class={`midgame-stage-select__filter-button${
                  reviewFilter === option.value ? ' midgame-stage-select__filter-button--active' : ''
                }`}
                aria-pressed={reviewFilter === option.value}
                onClick={() => handleReviewFilterChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {filteredStagePool.length === 0 ? (
            <p class="midgame-stage-select__empty">条件に一致するステージがありません。</p>
          ) : (
            <div class="midgame-stage-grid">
              {filteredStagePool.map((stage) => {
                const status = stageStatus(stageProgress, stage.key)
                const stars = stageStarCount(stageProgress, stage.key)
                const primaryName = stage.josekiNames[0] ?? '(名称未設定)'
                const nameLabel =
                  stage.josekiNames.length > 1 ? `${primaryName} 他${stage.josekiNames.length - 1}件` : primaryName
                return (
                  <button
                    type="button"
                    key={stage.key}
                    class={`midgame-stage-grid__cell midgame-stage-grid__cell--${status}`}
                    disabled={starting}
                    onClick={() => startStagePractice(stage)}
                    title={`第${stage.stageNumber}問: ${nameLabel}(★${stars}/${JUDGE_MODE_OPTIONS.length})`}
                  >
                    <span class="midgame-stage-grid__number">{stage.stageNumber}</span>
                    <span class="midgame-stage-grid__name">{primaryName}</span>
                    <span class="midgame-stage-grid__stars" aria-hidden="true">
                      {'★'.repeat(stars)}
                      {'☆'.repeat(Math.max(0, JUDGE_MODE_OPTIONS.length - stars))}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <button type="button" class="midgame-practice__quit" onClick={backToSettings}>
            設定に戻る
          </button>
        </section>
      )}

      {phase === 'generating' && (
        <section class="midgame-generating">
          <p>開始局面を生成中...</p>
        </section>
      )}

      {phase === 'playing' && session && (
        <section class="midgame-practice">
          {/* T136要件1: 「あなたは黒番です。手番: 黒」という素テキストを、盤の直上の
              2バッジ(手番側ハイライト+石数+思考中表示)に置き換える。「相手考慮中」は
              CPU(相手)側のバッジの思考中表示に統合する。 */}
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

          <div class="midgame-practice__side">
            {analyzing && <p class="notice">判定中...</p>}

            {finalizing && (
              <p class="notice midgame-finalizing">終盤の完全読みで結果を確定しています…</p>
            )}

            {showEvalBar && evalBarValue !== null && <EvalBar discDiff={evalBarValue} />}

            <label class="move-eval-overlay-toggle">
              <input
                type="checkbox"
                checked={moveEvalOverlayEnabled}
                onChange={(event) => handleToggleMoveEvalOverlay((event.target as HTMLInputElement).checked)}
              />
              候補手評価を表示
            </label>

            <button type="button" class="midgame-practice__quit" onClick={backToSettings}>
              やめる
            </button>
          </div>
        </section>
      )}

      {phase === 'result' && resultInfo?.kind === 'clear' && (
        <section class="midgame-result midgame-result--clear">
          <h2>クリア!</h2>
          <p>石差 {formatDiscDiff(resultInfo.margin)} で優勢を確定できました。</p>
          {justEarnedStar && <p class="midgame-result__star-earned">★ 新しい★を獲得しました!</p>}
          <div class="midgame-result__buttons">
            <button type="button" class="btn-primary" onClick={retryFromStart}>
              もう一度(同じ局面)
            </button>
            {activeStage && (
              <>
                <button type="button" class="btn-primary" onClick={nextStage}>
                  次のステージへ
                </button>
                <button type="button" onClick={goToStageSelect}>
                  ステージ一覧へ戻る
                </button>
              </>
            )}
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}

      {phase === 'result' && resultInfo?.kind === 'fail' && (
        <section class="midgame-result midgame-result--fail">
          <h2>失敗</h2>
          <p>{REASON_LABEL[resultInfo.reasonKind]}</p>

          {resultInfo.playedMove && (
            <p>
              あなたの手: {resultInfo.playedMove}
              {resultInfo.lossDiscs !== undefined && `(ロス${Math.round(resultInfo.lossDiscs)}石)`}
            </p>
          )}
          {resultInfo.bestMove && <p>正解手: {resultInfo.bestMove}</p>}
          {resultInfo.margin !== undefined && <p>最終石差: {formatDiscDiff(resultInfo.margin)}</p>}

          {resultInfo.comparePv && (
            <div class="midgame-result__compare-pv">
              <p>あなたの手 → 相手の最善進行: {formatContinuation(resultInfo.comparePv.yourContinuation)}</p>
              {resultInfo.comparePv.correctContinuation && (
                <p>正解手 → 進行: {formatContinuation(resultInfo.comparePv.correctContinuation)}</p>
              )}
            </div>
          )}

          {/*
            T128要件3: 「あなたの手のあと」「最善手のあと」(いずれも相手番)の
            盤面2枚を対比表示し、明確な悪化パターンを平易な日本語で説明する
            (旧: 着手前局面1枚+正解手ハイライト+「なぜ悪いか」+モチーフ検出
            タグ+評価内訳waterfall+回収点。waterfall・回収点は本番評価
            (パターン評価v3)ではなく実質未使用の旧3項ヒューリスティックで
            計算されており数値の信頼性に構造的問題があったため撤去した
            (T127調査で確定、タスク仕様のスコープ外指定どおり)。
          */}
          {clearBlunderCompareInfo && (
            <ClearBlunderCompare
              opponentSide={clearBlunderCompareInfo.opponentSide}
              boardAfterPlayed={clearBlunderCompareInfo.boardAfterPlayed}
              boardAfterBest={clearBlunderCompareInfo.boardAfterBest}
              playedSquare={clearBlunderCompareInfo.playedSquare}
              bestSquare={clearBlunderCompareInfo.bestSquare}
              patterns={clearBlunderCompareInfo.patterns}
            />
          )}

          <div class="midgame-result__buttons">
            <button type="button" class="btn-primary" onClick={retryFromStart}>
              ここからやり直す
            </button>
            {activeStage && (
              <>
                <button type="button" class="btn-primary" onClick={nextStage}>
                  次のステージへ
                </button>
                <button type="button" onClick={goToStageSelect}>
                  ステージ一覧へ戻る
                </button>
              </>
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

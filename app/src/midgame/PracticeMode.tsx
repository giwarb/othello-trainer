import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EvalGraph } from '../analysis/EvalGraph.tsx'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { formatDiscDiff } from '../components/EvalBadge.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import {
  buildEvalGraphPoints,
  lastMoveEvalBarStateFor,
  type PlayedMoveEval,
} from '../components/moveEvalTimeline.ts'
import { PlayerBadge } from '../components/PlayerBadge.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { bigintToHex } from '../engine/hex.ts'
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
import { loadJosekiDb } from '../joseki/lookup.ts'
import type { JosekiDb } from '../joseki/types.ts'
import {
  loadMidgameMoveEvalOverlayEnabled,
  saveMidgameMoveEvalOverlayEnabled,
} from '../settings/moveEvalOverlaySettings.ts'
import {
  loadReviewFilter,
  matchesReviewFilter,
  MIDGAME_REVIEW_FILTER_STORAGE_KEY,
  REVIEW_FILTER_OPTIONS,
  saveReviewFilter,
  type ReviewFilter,
} from '../settings/reviewFilter.ts'
import {
  CLEAR_BLUNDER_PATTERN_LABELS,
  detectAllClearBlunderPatterns,
  detectClearBlunderPatterns,
  type ClearBlunderPattern,
  type ClearBlunderPatternId,
} from './clearBlunder.ts'
import { EvalBar } from './EvalBar.tsx'
import {
  loadPatternStats,
  recordPatternFailures,
  resetPatternStats,
  topPatternStats,
  type PatternStats,
} from './patternStats.ts'
import { pickOpponentMove } from './pickOpponentMove.ts'
import { addPoolEntry } from './pool.ts'
import { resolveMover, resolveNextSideOrFallback } from './resolveMover.ts'
import { buildMidgameStagePool, type MidgameStage } from './stagePool.ts'
import {
  loadStageProgress,
  recordStageAttempt,
  stageBestStars,
  stageFailCount,
  stageStatus,
  type StageProgress,
} from './stageProgress.ts'
import { computeStageStars, isBestMove, type Stars } from './stageStarJudge.ts'
import { TwoPlyCompare } from './TwoPlyCompare.tsx'
import { computeTwoPlyCompare, type TwoPlyCompareResult } from './twoPlyCompare.ts'
import './PracticeMode.css'

/**
 * 中盤練習モードのエンジン解析に使う探索条件(T141要件: 表示・判定・応手で
 * 同一設定を使う。旧`judgeMidgameMove`時代からの値をそのまま引き継ぐ、
 * `timeMs`引き上げの経緯は旧`tasks/T076-*.md`参照)。
 */
const MIDGAME_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 1000, exactFromEmpties: 24 }

/** 相手が着手するまでの見せかけの「考慮時間」(ミリ秒、`joseki/PracticeMode.tsx`と同じ演出)。 */
const OPPONENT_MOVE_DELAY_MS = 350

/** 1ステージの往復回数(要件2「3回応手しあう」)。 */
const ROUNDS_PER_STAGE = 3

/** 苦手パターン検出・記録を行う損失の下限(石差、要件8「損失1石以上」)。 */
const PATTERN_DETECTION_LOSS_THRESHOLD = 1

type Phase = 'stageSelect' | 'playing' | 'result'

/** プレイヤーの1手ぶんの結果(要件4・7)。 */
interface MoveOutcome {
  readonly playedMove: string
  readonly playedSquare: number
  readonly bestMove: string
  readonly bestSquare: number
  /** 最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** この手自身の評価値(石差、プレイヤー視点。T197: 「打った手の評価値」グラフ・バー用)。 */
  readonly playedDiscDiff: number
  readonly isBest: boolean
  /** この手を打つ前の局面(1手先対比・苦手パターン検出に使う)。 */
  readonly preMoveBoard: BoardState
  readonly preMoveSide: Side
  /**
   * 1手先対比表示用に検出された明確な悪化パターン(要件7・8、最大2件)。
   * 損失が`PATTERN_DETECTION_LOSS_THRESHOLD`未満、検出不能、特徴量取得失敗の
   * いずれかの場合は`null`。
   */
  readonly clearBlunderPatterns: readonly ClearBlunderPattern[] | null
}

interface SessionState {
  readonly board: BoardState
  readonly sideToMove: Side
  /** プレイヤーが担当する色。ステージの手番側をそのままプレイヤーとする。 */
  readonly humanSide: Side
  readonly lastMove: number | null
  readonly stageKey: string
  /** セッション開始時点の局面(出題プール登録・やり直しに使う、着手適用では変化しない)。 */
  readonly startBoard: BoardState
  /** プレイヤーが完了した着手の結果(0〜3件、順序どおり)。 */
  readonly moveOutcomes: readonly MoveOutcome[]
  /**
   * 「打った手の評価値」の時系列記録(T197、プレイヤー+相手の全手、ply1始まり)。
   * `EvalGraph`用の折れ線・評価バー(「前回の相手の手の評価値」)の両方をこの
   * 配列から導出する(`moveEvalTimeline.ts`参照)。
   */
  readonly moveEvalHistory: readonly PlayedMoveEval[]
}

interface ResultInfo {
  readonly stars: Stars
  readonly startEval: number
  readonly endEval: number
  readonly moveOutcomes: readonly MoveOutcome[]
  /** 損失が最大だった手のインデックス(`moveOutcomes`内)。1手も打てなかった場合は`null`。 */
  readonly worstMoveIndex: number | null
  /** このクリアで自己ベスト(`bestStars`)が更新されたか。 */
  readonly justImprovedBest: boolean
  /** 「打った手の評価値」の時系列記録(T197、結果画面の折れ線グラフ用)。 */
  readonly moveEvalHistory: readonly PlayedMoveEval[]
}

/**
 * T195: 悪手(損失`PATTERN_DETECTION_LOSS_THRESHOLD`石以上)を打った直後、相手の
 * 自動応手を保留して2手先2盤面比較を見せている間の状態。
 *
 * 「保留」は`nextSession`(=通常ならこの場で`setSession`していたはずの値)を
 * 確定させずに持っておくことで実現する。「続ける」(`handleContinueAfterCompare`)
 * が押されるまで`session`は着手前のまま変化しないため、相手の自動応手
 * `useEffect`(`session.sideToMove !== humanSide`で発火)は自然に発火しない。
 */
interface PendingBlunderCompare {
  /** この比較がどのセッション世代のものか(離脱後の古い結果適用を防ぐ、既存の世代ガードと同じ考え方)。 */
  readonly generation: number
  readonly preMoveBoard: BoardState
  readonly preMoveSide: Side
  readonly playedSquare: number
  readonly bestSquare: number
  readonly playedMove: string
  readonly bestMove: string
  readonly lossDiscs: number
  readonly patterns: readonly ClearBlunderPattern[] | null
  /** 「続ける」が押されたときに確定させる、着手適用後のセッション状態。 */
  readonly nextSession: SessionState
  /** `computeTwoPlyCompare`の結果。取得完了まで`null`(ローディング表示)。 */
  readonly compare: TwoPlyCompareResult | null
}

/** 復習フィルタの中盤練習向け表示ラベル(要件6)。値・絞り込みロジックは共有の`reviewFilter.ts`をそのまま使い、表示文言だけをこのモード向けに上書きする。 */
const MIDGAME_FILTER_LABELS: Readonly<Record<ReviewFilter, string>> = {
  all: 'すべて',
  unattempted: '未挑戦',
  hasFailure: '失敗あり',
  uncleared: '未クリア(★0)',
  cleared: 'クリア済み(★1+)',
}

/**
 * 中盤練習モード「ステージクリア型」(T141)。
 *
 * ユーザー指示(2026-07-19朝)により、モード・相手の強さ・開始局面ソースの
 * 選択画面を廃止し、111ステージの一覧から選ぶだけの構成へ全面改訂した。
 * 1ステージにつき: プレイヤーが3手打ち、そのたびに相手(エンジン)が最善応手を
 * 返す(3往復)。評価バーは対局モード(T138)と同じ部品で常時表示する。候補手
 * 評価オーバーレイは既定ONで表示するが、「候補手評価を表示」トグル(T142)で
 * OFFにでき、その場合も判定(★算出)・相手応手はオーバーレイ非表示と無関係に
 * 裏で正常に動作する(表示だけの切り替え、要件2)。3往復後(または途中終局時)の
 * 評価値ロスに応じて★0〜3を判定する(`stageStarJudge.ts`)。詳細は
 * `tasks/T141-midgame-stage-stars.md`・`tasks/T142-midgame-eval-toggle.md`参照。
 *
 * 旧実装(T021〜T130)の判定モード(厳格/標準/逆転禁止)・相手の強さ選択・
 * 開始局面ソース選択・毎手ごとの合否判定(ゲート)は廃止した。`judgeMidgameMove.ts`
 * 自体は言語化トレーニングモード(`verbalize/PracticeMode.tsx`)が引き続き使うため
 * 削除しない。
 */
export function PracticeMode() {
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [josekiDbError, setJosekiDbError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('stageSelect')
  const [session, setSession] = useState<SessionState | null>(null)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)

  /** T195: 悪手直後の2手先2盤面比較(相手の自動応手を保留中)。無ければ`null`(通常のプレイ画面)。 */
  const [pendingCompare, setPendingCompare] = useState<PendingBlunderCompare | null>(null)
  /** T195: 結果画面の最悪手についての2手先2盤面比較(`worstMoveCompareInfo`が非nullの間、非同期に計算する)。 */
  const [worstMoveCompare, setWorstMoveCompare] = useState<TwoPlyCompareResult | null>(null)

  /** 定石DBが読み込まれ次第、決定的な順序で1回だけ列挙する(`josekiDb`が変わらない限り再計算しない)。 */
  const stagePool = useMemo<MidgameStage[] | null>(
    () => (josekiDb ? buildMidgameStagePool(josekiDb) : null),
    [josekiDb],
  )
  /** ステージ挑戦記録(★制、T141)。起動時に`localStorage`から1回読み込む。 */
  const [stageProgress, setStageProgress] = useState<StageProgress>(() => loadStageProgress(localStorage))
  /** ステージ一覧の復習フィルタ(T130)。`localStorage`から起動時に1回読み込む。 */
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(() =>
    loadReviewFilter(localStorage, MIDGAME_REVIEW_FILTER_STORAGE_KEY),
  )
  /** 現在の(または直前の)セッションが開始されたステージ。 */
  const [activeStage, setActiveStage] = useState<MidgameStage | null>(null)

  // --- 苦手パターン統計(T129) ---
  const [patternStats, setPatternStats] = useState<PatternStats>(() => loadPatternStats(localStorage))
  const [confirmingPatternStatsReset, setConfirmingPatternStatsReset] = useState(false)

  const [opponentThinking, setOpponentThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  /** 3往復完了後、完全読み相当の最終評価で結果を確定させている間`true`(T055の`finalizing`を踏襲)。 */
  const [finalizing, setFinalizing] = useState(false)

  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)
  /**
   * 候補手評価オーバーレイの表示ON/OFF(T142)。既定ON(要件1)。
   * 判定(★算出)・相手応手・評価バーはこのON/OFFと無関係に常時動作する
   * (要件2、`overlayMoves`・評価バー(`session.moveEvalHistory`由来)はこの
   * stateと独立して更新され続ける)。
   */
  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMidgameMoveEvalOverlayEnabled(localStorage),
  )

  /** セッション開始時点(1手目を打つ前)の評価値、プレイヤー視点(★判定の基準、要件4)。 */
  const startEvalRef = useRef<number | null>(null)

  /**
   * 着手前局面に対する`requestAnalyzeAll`結果をキャッシュする(T078踏襲)。
   * 表示(オーバーレイ・評価バー)・判定(★算出)・セッション終了判定のいずれも
   * このキャッシュ経由でエンジンを呼ぶことで、同一局面への重複問い合わせを避け、
   * 「表示と判定が別々の探索結果を参照して食い違う」ことを防ぐ(要件4「表示と
   * 同じanalyzeAll結果を使い、二重計算しない」)。
   */
  const analyzedMovesRef = useRef<{
    readonly board: BoardState
    readonly side: Side
    readonly promise: Promise<MoveEvalJson[]>
  } | null>(null)

  /**
   * セッション世代カウンタ(T119 redo #1の教訓をT141でも踏襲)。
   * `startStagePractice`・`goToStageSelect`でインクリメントし、非同期処理
   * (`checkSessionEnd`・`handlePlayerMove`・相手の着手)は開始時点の値を捕まえて
   * `await`から戻った際に一致するか確認してから結果確定・記録を行う。
   */
  const sessionGenerationRef = useRef(0)

  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  function getAnalyzedMoves(board: BoardState, side: Side): Promise<MoveEvalJson[]> {
    const cached = analyzedMovesRef.current
    if (cached && cached.board === board && cached.side === side) {
      return cached.promise
    }
    const promise = getEngine().requestAnalyzeAll(board, side, MIDGAME_ANALYZE_LIMIT)
    analyzedMovesRef.current = { board, side, promise }
    return promise
  }

  /**
   * T195: 2手先2盤面比較(`twoPlyCompare.ts`)専用の`requestAnalyzeAll`呼び出し。
   * `getAnalyzedMoves`(表示・判定・応手が参照する一元化されたキャッシュ)とは
   * 意図的に分離する(比較用の局面はライブセッションの局面と異なるため、
   * 同じキャッシュに混ぜると無関係な局面のキャッシュを上書きしてしまう)。
   * 1回の比較で最大4回まで(要件6)、呼び出し元(`loadTwoPlyCompare`)が
   * `pendingCompare`/`worstMoveCompare`のstateに結果を保持することで、
   * 同じ手の再表示による再計算を避ける。
   */
  function requestAnalyzeAllForCompare(board: BoardState, side: Side): Promise<MoveEvalJson[]> {
    return getEngine().requestAnalyzeAll(board, side, MIDGAME_ANALYZE_LIMIT)
  }

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

  /** ステージ挑戦記録を同期的に更新する(T117教訓、非同期処理より前に呼ぶこと)。 */
  function recordStageAttemptNow(stageKey: string, stars: Stars): void {
    try {
      const next = recordStageAttempt(localStorage, stageKey, stars)
      setStageProgress(next)
    } catch (error) {
      console.error('ステージ挑戦記録の保存に失敗しました', error)
    }
  }

  /** 苦手パターン統計を同期的に更新する(要件8)。`patternIds`が空なら何もしない。 */
  function recordPatternFailuresNow(patternIds: readonly ClearBlunderPatternId[]): void {
    if (patternIds.length === 0) return
    try {
      const next = recordPatternFailures(localStorage, patternIds)
      setPatternStats(next)
    } catch (error) {
      console.error('苦手パターン統計の保存に失敗しました', error)
    }
  }

  function handleResetPatternStats(): void {
    try {
      setPatternStats(resetPatternStats(localStorage))
    } catch (error) {
      console.error('苦手パターン統計のリセットに失敗しました', error)
    }
    setConfirmingPatternStatsReset(false)
  }

  /** 失敗した(★0)ステージの開始局面を出題プール(IndexedDB)に登録する。 */
  async function registerFailureToPool(s: SessionState): Promise<void> {
    try {
      await addPoolEntry({
        id: `midgame-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        board: { black: bigintToHex(s.startBoard.black), white: bigintToHex(s.startBoard.white) },
        turn: s.humanSide,
        source: 'blunder-review',
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error('出題プールへの登録に失敗しました', error)
    }
  }

  /**
   * 損失が最大だった手のインデックスを返す(要件7「最も損失が大きかった手」)。
   * 同点なら先に打った手を優先する。1手も打てなかった場合は`null`。
   */
  function findWorstMoveIndex(moveOutcomes: readonly MoveOutcome[]): number | null {
    if (moveOutcomes.length === 0) return null
    let worst = 0
    for (let i = 1; i < moveOutcomes.length; i += 1) {
      if (moveOutcomes[i]!.lossDiscs > moveOutcomes[worst]!.lossDiscs) worst = i
    }
    return worst
  }

  /** セッションを★判定して結果画面へ遷移させる(要件4)。 */
  function finalizeSession(s: SessionState, endEval: number, generation: number): void {
    if (sessionGenerationRef.current !== generation) return

    const startEval = startEvalRef.current ?? endEval
    const stars = computeStageStars({
      startEval,
      endEval,
      moveOutcomes: s.moveOutcomes.map((m) => ({ lossDiscs: m.lossDiscs, isBest: m.isBest })),
    })

    const previousBestStars = stageBestStars(loadStageProgress(localStorage), s.stageKey)
    recordStageAttemptNow(s.stageKey, stars)

    setResultInfo({
      stars,
      startEval,
      endEval,
      moveOutcomes: s.moveOutcomes,
      worstMoveIndex: findWorstMoveIndex(s.moveOutcomes),
      justImprovedBest: stars > previousBestStars,
      moveEvalHistory: s.moveEvalHistory,
    })
    setPhase('result')

    if (stars === 0) void registerFailureToPool(s)
  }

  function finalizeByFinalScore(board: BoardState, s: SessionState, generation: number): void {
    if (sessionGenerationRef.current !== generation) return
    const humanDiscs = countDiscs(board, s.humanSide)
    const oppDiscs = countDiscs(board, opposite(s.humanSide))
    finalizeSession(s, humanDiscs - oppDiscs, generation)
  }

  /**
   * 着手適用のたびに呼ぶセッション終了判定(要件2「途中で終局・打てる手なし等の
   * 場合はその時点で終了」・要件4)。
   * - 真の終局(`resolveMover`が`null`)なら、そのまま石差で★判定を確定する
   *   (ラウンド数に関わらず即座に)。
   * - まだ3往復(プレイヤー3手)に達していなければ何もしない(継続)。
   * - 3往復に達し、かつ手番がプレイヤー側に戻っていれば、`getAnalyzedMoves`
   *   (表示用と共有のキャッシュ)で終了時評価値を求めて★判定を確定する。
   * 戻り値は「この呼び出しでセッションが終了したか」。
   */
  async function checkSessionEnd(board: BoardState, sideToMove: Side, s: SessionState, generation: number): Promise<boolean> {
    const mover = resolveMover(board, sideToMove)
    if (mover === null) {
      finalizeByFinalScore(board, s, generation)
      return true
    }
    if (s.moveOutcomes.length < ROUNDS_PER_STAGE) return false
    if (mover !== s.humanSide) return false // 相手がパスして手番が戻っていない等(通常到達しない防御的分岐)

    setFinalizing(true)
    try {
      const allMoves = await getAnalyzedMoves(board, mover)
      if (sessionGenerationRef.current !== generation) return false
      if (allMoves.length === 0) {
        finalizeByFinalScore(board, s, generation)
        return true
      }
      const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
      // mover === s.humanSide なので discDiff はそのままプレイヤー視点。
      finalizeSession(s, best.discDiff, generation)
      return true
    } catch (error) {
      console.error('セッション終了判定のための解析に失敗しました', error)
      return false
    } finally {
      setFinalizing(false)
    }
  }

  // 相手(エンジン)の手番になったら、最善応手を選んで適用する(要件2「相手は最善応手を返す」)。
  useEffect(() => {
    if (phase !== 'playing' || !session) return
    const s = session
    if (s.sideToMove === s.humanSide) return
    if (!hasLegalMove(s.board, s.sideToMove)) return

    let cancelled = false
    setOpponentThinking(true)

    async function run(): Promise<void> {
      try {
        const allMoves = await getAnalyzedMoves(s.board, s.sideToMove)
        if (cancelled) return
        const moveNotation = pickOpponentMove(allMoves, 'best')
        await new Promise((resolve) => setTimeout(resolve, OPPONENT_MOVE_DELAY_MS))
        if (cancelled || moveNotation === null) return

        const square = notationToSquare(moveNotation)
        const board = applyMove(s.board, s.sideToMove, square)
        const nextSide = resolveNextSideOrFallback(board, opposite(s.sideToMove))
        // T197: 相手応手の評価値記録。表示・判定と共有の`getAnalyzedMoves`結果
        // (`allMoves`)から選んだ手のdiscDiffを引くだけで、追加のエンジン呼び出しは
        // 発生しない。
        const playedEval = allMoves.find((m) => m.move === moveNotation)
        const evalEntry: PlayedMoveEval = {
          ply: s.moveEvalHistory.length + 1,
          notation: moveNotation,
          side: s.sideToMove,
          discDiff: playedEval?.discDiff ?? null,
          source: playedEval?.type ?? 'midgame',
          isExact: playedEval?.type === 'exact',
        }
        const nextSession: SessionState = {
          ...s,
          board,
          sideToMove: nextSide,
          lastMove: square,
          moveEvalHistory: [...s.moveEvalHistory, evalEntry],
        }
        setSession(nextSession)
        await checkSessionEnd(board, nextSide, nextSession, sessionGenerationRef.current)
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

  // 候補手評価オーバーレイ用のデータ取得。`moveEvalOverlayEnabled`(T142)がOFFでも
  // ここでの取得自体は止めない(判定(★算出)がこの`getAnalyzedMoves`キャッシュに
  // 依存するため、表示だけを`MoveEvalOverlay`側の`visible`で止める)。プレイヤーの
  // 手番になった時点で現局面(着手前)の全合法手評価をまとめて取得する(T078踏襲)。
  //
  // T197: 評価バーはここでの取得結果(現局面の盤面評価)には依存しない
  // (`session.moveEvalHistory`由来の「前回の相手の手の評価値」に置き換えたため)。
  useEffect(() => {
    if (phase !== 'playing' || !session || session.sideToMove !== session.humanSide) {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    const s = session
    getAnalyzedMoves(s.board, s.sideToMove)
      .then((moves) => {
        if (cancelled) return
        setOverlayMoves(moves)
      })
      .catch((error: unknown) => {
        console.error('候補手評価の取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [phase, session])

  /**
   * 人間がボードをクリックしたときの処理(要件2・4)。
   *
   * 旧実装(T021〜T128)にあった「毎手ごとの合否判定→不合格ならただちに
   * セッション終了」というゲートは廃止した。T141では常に3手まで打ち切り、
   * 各手の評価値ロス・最善手一致は`MoveOutcome`として蓄積するだけで、
   * セッションの継続可否は`checkSessionEnd`(終局・往復数)だけが決める。
   */
  async function handlePlayerMove(square: number): Promise<void> {
    if (phase !== 'playing' || !session || analyzing) return
    const s = session
    if (s.sideToMove !== s.humanSide) return
    if (s.moveOutcomes.length >= ROUNDS_PER_STAGE) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    const generation = sessionGenerationRef.current
    setAnalyzing(true)
    try {
      const allMoves = await getAnalyzedMoves(s.board, s.sideToMove)
      if (sessionGenerationRef.current !== generation) return

      const playedNotation = squareToNotation(square)
      const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
      const played = allMoves.find((m) => m.move === playedNotation)
      const playedDiscDiff = played?.discDiff ?? best.discDiff
      const lossDiscs = Math.max(0, best.discDiff - playedDiscDiff)
      const isBest = isBestMove(lossDiscs)
      const bestSquare = notationToSquare(best.move)

      if (s.moveOutcomes.length === 0) {
        startEvalRef.current = best.discDiff
      }

      let clearBlunderPatterns: readonly ClearBlunderPattern[] | null = null
      if (!isBest && lossDiscs >= PATTERN_DETECTION_LOSS_THRESHOLD) {
        try {
          const [playedFeatureResp, bestFeatureResp] = await Promise.all([
            getEngine().requestFeatureSet(s.board, s.sideToMove, playedNotation),
            getEngine().requestFeatureSet(s.board, s.sideToMove, best.move),
          ])
          if (sessionGenerationRef.current !== generation) return
          const clearBlunderInput = {
            preMoveBoard: s.board,
            preMoveSide: s.sideToMove,
            playedSquare: square,
            bestSquare,
            playedFeatures: playedFeatureResp.features,
            bestFeatures: bestFeatureResp.features,
          }
          clearBlunderPatterns = detectClearBlunderPatterns(clearBlunderInput)
          // 要件8: 表示は`clearBlunderPatterns`(最大2件)、統計には検出全件のIDを使う(T129と同じ方針)。
          const allDetectedPatternIds = detectAllClearBlunderPatterns(clearBlunderInput).map((p) => p.id)
          recordPatternFailuresNow(allDetectedPatternIds)
        } catch (error) {
          console.error('明確な悪化パターン判定用の特徴量取得に失敗しました', error)
          if (sessionGenerationRef.current !== generation) return
          clearBlunderPatterns = null
        }
      }

      const outcome: MoveOutcome = {
        playedMove: playedNotation,
        playedSquare: square,
        bestMove: best.move,
        bestSquare,
        lossDiscs,
        playedDiscDiff,
        isBest,
        preMoveBoard: s.board,
        preMoveSide: s.sideToMove,
        clearBlunderPatterns,
      }

      // T197: プレイヤーの着手の評価値記録。表示・判定と共有の`allMoves`
      // (`getAnalyzedMoves`結果)から求めた`playedDiscDiff`をそのまま使うだけで、
      // 追加のエンジン呼び出しは発生しない。
      const evalEntry: PlayedMoveEval = {
        ply: s.moveEvalHistory.length + 1,
        notation: playedNotation,
        side: s.sideToMove,
        discDiff: playedDiscDiff,
        source: played?.type ?? best.type,
        isExact: (played?.type ?? best.type) === 'exact',
      }

      const board = applyMove(s.board, s.sideToMove, square)
      const nextSide = resolveNextSideOrFallback(board, opposite(s.sideToMove))
      const nextSession: SessionState = {
        ...s,
        board,
        sideToMove: nextSide,
        lastMove: square,
        moveOutcomes: [...s.moveOutcomes, outcome],
        moveEvalHistory: [...s.moveEvalHistory, evalEntry],
      }

      // T195要件1: 悪手(損失`PATTERN_DETECTION_LOSS_THRESHOLD`石以上)なら、
      // ここで`setSession`せずに2手先2盤面比較を表示し、相手の自動応手を保留する。
      // `session`が着手前のまま変わらないため、相手の自動応手`useEffect`
      // (`session.sideToMove !== humanSide`で発火)はまだ発火しない
      // (「続ける」を押した時点で`handleContinueAfterCompare`が`setSession`する)。
      if (!isBest && lossDiscs >= PATTERN_DETECTION_LOSS_THRESHOLD) {
        setPendingCompare({
          generation,
          preMoveBoard: s.board,
          preMoveSide: s.sideToMove,
          playedSquare: square,
          bestSquare,
          playedMove: playedNotation,
          bestMove: best.move,
          lossDiscs,
          patterns: clearBlunderPatterns,
          nextSession,
          compare: null,
        })
        void loadTwoPlyCompare(generation, s.board, s.sideToMove, square, bestSquare, (result) => {
          setPendingCompare((prev) => (prev && prev.generation === generation ? { ...prev, compare: result } : prev))
        })
        return
      }

      setSession(nextSession)
      await checkSessionEnd(board, nextSide, nextSession, generation)
    } catch (error) {
      console.error('着手判定のための解析に失敗しました', error)
    } finally {
      setAnalyzing(false)
    }
  }

  /**
   * T195: `computeTwoPlyCompare`を呼び、離脱していなければ`onResult`で結果を反映する
   * (`pendingCompare`・`worstMoveCompare`の両方から共通で使う世代ガード付きヘルパー)。
   */
  async function loadTwoPlyCompare(
    generation: number,
    preMoveBoard: BoardState,
    preMoveSide: Side,
    playedSquare: number,
    bestSquare: number,
    onResult: (result: TwoPlyCompareResult) => void,
  ): Promise<void> {
    try {
      const result = await computeTwoPlyCompare(
        preMoveBoard,
        preMoveSide,
        playedSquare,
        bestSquare,
        requestAnalyzeAllForCompare,
      )
      if (sessionGenerationRef.current !== generation) return
      onResult(result)
    } catch (error) {
      console.error('2手先2盤面比較の計算に失敗しました', error)
    }
  }

  /** T195: 悪手直後の2手先2盤面比較を閉じ、保留していた相手の自動応手・セッション継続判定を再開する。 */
  function handleContinueAfterCompare(): void {
    const pending = pendingCompare
    if (!pending) return
    setPendingCompare(null)
    if (sessionGenerationRef.current !== pending.generation) return
    setSession(pending.nextSession)
    void checkSessionEnd(pending.nextSession.board, pending.nextSession.sideToMove, pending.nextSession, pending.generation)
  }

  /** ステージ一覧のセルをクリックしたときの処理(要件2)。 */
  function startStagePractice(stage: MidgameStage): void {
    setStageError(null)
    sessionGenerationRef.current += 1
    const generation = sessionGenerationRef.current
    startEvalRef.current = null
    setActiveStage(stage)
    const sideToMove = resolveNextSideOrFallback(stage.board, stage.sideToMove)
    const initialSession: SessionState = {
      board: stage.board,
      sideToMove,
      humanSide: stage.sideToMove,
      lastMove: null,
      stageKey: stage.key,
      startBoard: stage.board,
      moveOutcomes: [],
      moveEvalHistory: [],
    }
    setSession(initialSession)
    setResultInfo(null)
    setOverlayMoves(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
    setPendingCompare(null)
    setWorstMoveCompare(null)
    setPhase('playing')
    void checkSessionEnd(stage.board, sideToMove, initialSession, generation)
  }

  /** 結果画面の「もう一度」(要件7): 同じステージへ再挑戦する。 */
  function retryFromStart(): void {
    if (!activeStage) return
    startStagePractice(activeStage)
  }

  /** ステージ一覧へ戻る(結果画面・プレイ中の両方から呼ばれる)。セッションから離脱するので世代をインクリメントする。 */
  function goToStageSelect(): void {
    sessionGenerationRef.current += 1
    startEvalRef.current = null
    setPhase('stageSelect')
    setSession(null)
    setActiveStage(null)
    setResultInfo(null)
    setOverlayMoves(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
    setPendingCompare(null)
    setWorstMoveCompare(null)
  }

  /** 結果画面の「次のステージへ」(要件7): `stagePool`内で`activeStage`の次の番号のステージへ進む。 */
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

  function handleReviewFilterChange(filter: ReviewFilter): void {
    setReviewFilter(filter)
    saveReviewFilter(localStorage, MIDGAME_REVIEW_FILTER_STORAGE_KEY, filter)
  }

  /** 候補手評価オーバーレイの表示ON/OFFを切り替える(T142要件1)。表示だけの切り替えで判定・応手には影響しない。 */
  function handleToggleMoveEvalOverlay(enabled: boolean): void {
    setMoveEvalOverlayEnabled(enabled)
    saveMidgameMoveEvalOverlayEnabled(localStorage, enabled)
  }

  /**
   * T195: 結果画面の2手先2盤面比較表示用の派生値(要件5「結果画面の最悪手表示も
   * 同コンポーネントに置き換える」)。表示条件は損失`PATTERN_DETECTION_LOSS_THRESHOLD`
   * 石以上(即時フィードバックと同じ閾値、要件1)であり、`clearBlunderPatterns`の
   * 検出有無は問わない(パターンは検出できた場合の補足行としてのみ使う、
   * `clearBlunderPatterns`の検出・`patternStats`への記録自体は現状のまま)。
   */
  const worstMoveCompareInfo = (() => {
    if (!resultInfo || resultInfo.worstMoveIndex === null) return null
    const worst = resultInfo.moveOutcomes[resultInfo.worstMoveIndex]
    if (!worst || worst.lossDiscs < PATTERN_DETECTION_LOSS_THRESHOLD) return null
    return {
      preMoveBoard: worst.preMoveBoard,
      preMoveSide: worst.preMoveSide,
      playedSquare: worst.playedSquare,
      bestSquare: worst.bestSquare,
      playedMove: worst.playedMove,
      bestMove: worst.bestMove,
      lossDiscs: worst.lossDiscs,
      patterns: worst.clearBlunderPatterns,
    }
  })()

  // T195: `worstMoveCompareInfo`が変わるたび(結果画面に入った・別の挑戦の結果に
  // 差し替わった)に2手先2盤面比較を計算し直す。表示対象が無ければ(または
  // 結果画面を離れたら)`null`に戻す。
  useEffect(() => {
    if (phase !== 'result' || !worstMoveCompareInfo) {
      setWorstMoveCompare(null)
      return
    }
    let cancelled = false
    setWorstMoveCompare(null)
    const generation = sessionGenerationRef.current
    void loadTwoPlyCompare(
      generation,
      worstMoveCompareInfo.preMoveBoard,
      worstMoveCompareInfo.preMoveSide,
      worstMoveCompareInfo.playedSquare,
      worstMoveCompareInfo.bestSquare,
      (result) => {
        if (!cancelled) setWorstMoveCompare(result)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [phase, resultInfo])

  // 苦手パターン統計(T129要件2): failCount降順で最大5件。
  const topPatternRows = topPatternStats(patternStats)

  /** ステージ一覧を復習フィルタで絞り込んだもの(要件6)。 */
  const filteredStagePool = (stagePool ?? []).filter((stage) =>
    matchesReviewFilter(stageStatus(stageProgress, stage.key), stageFailCount(stageProgress, stage.key), reviewFilter),
  )

  // 「クリア x/N」サマリ+進捗バー(要件5: bestStars>=1が「クリア」)。
  const clearedStageCount = (stagePool ?? []).filter((stage) => stageStatus(stageProgress, stage.key) === 'cleared').length
  const totalStageCount = stagePool?.length ?? 0

  // T197: 評価バー=「前回の相手の手の評価値」(相手視点→あなた視点へ反転)。
  // まだ相手が応手していなければ`{kind: 'none'}`(中立表示)。
  const moveEvalBarState = session
    ? lastMoveEvalBarStateFor(session.moveEvalHistory, opposite(session.humanSide))
    : ({ kind: 'none' } as const)
  const moveEvalBarDisplayValue = moveEvalBarState.kind === 'value' ? -moveEvalBarState.discDiff : null
  // T197: 「打った手の評価値」折れ線グラフ(黒視点・定石帯0固定のT046規約、
  // `EvalGraph`を再利用)。プレイ画面・結果画面の両方に表示する。
  const evalGraphPoints = session ? buildEvalGraphPoints(session.moveEvalHistory) : []
  const resultEvalGraphPoints = resultInfo ? buildEvalGraphPoints(resultInfo.moveEvalHistory) : []

  return (
    <div class="midgame-practice-mode">
      {josekiDbError && <p class="notice notice--error">{josekiDbError}</p>}
      {stageError && <p class="notice notice--error">{stageError}</p>}

      {phase === 'stageSelect' && (
        <section class="midgame-stage-select">
          <p>中盤練習: ステージを選んでください(全{stagePool?.length ?? 0}問)</p>

          <div class="midgame-pattern-stats">
            <h3 class="midgame-pattern-stats__title">苦手パターン</h3>
            {topPatternRows.length === 0 ? (
              <p class="midgame-pattern-stats__empty">
                <span class="midgame-pattern-stats__empty-icon" aria-hidden="true">
                  📊
                </span>
                失敗するとここに苦手パターンが貯まります
              </p>
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

          {stagePool && (
            <div class="midgame-stage-select__summary">
              <p class="midgame-stage-select__summary-text">
                クリア {clearedStageCount}/{totalStageCount}
              </p>
              <div
                class="midgame-stage-select__progress-bar"
                role="progressbar"
                aria-valuenow={clearedStageCount}
                aria-valuemin={0}
                aria-valuemax={totalStageCount}
                aria-label="ステージクリア進捗"
              >
                <div
                  class="midgame-stage-select__progress-fill"
                  style={{ width: `${totalStageCount > 0 ? (clearedStageCount / totalStageCount) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <p class="midgame-stage-select__legend">
            <span class="midgame-stage-legend__mark midgame-stage-legend__mark--cleared">■</span>
            ★1つ以上
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
                {MIDGAME_FILTER_LABELS[option.value]}
              </button>
            ))}
          </div>

          {filteredStagePool.length === 0 ? (
            <p class="midgame-stage-select__empty">条件に一致するステージがありません。</p>
          ) : (
            <div class="midgame-stage-grid">
              {filteredStagePool.map((stage) => {
                const status = stageStatus(stageProgress, stage.key)
                const stars = stageBestStars(stageProgress, stage.key)
                const primaryName = stage.josekiNames[0] ?? '(名称未設定)'
                const nameLabel =
                  stage.josekiNames.length > 1 ? `${primaryName} 他${stage.josekiNames.length - 1}件` : primaryName
                return (
                  <button
                    type="button"
                    key={stage.key}
                    class={`midgame-stage-grid__cell midgame-stage-grid__cell--${status}`}
                    onClick={() => startStagePractice(stage)}
                    title={`第${stage.stageNumber}問: ${nameLabel}(★${stars}/3)`}
                  >
                    <span class="midgame-stage-grid__number">{stage.stageNumber}</span>
                    <span class="midgame-stage-grid__name">{primaryName}</span>
                    <span class="midgame-stage-grid__stars" aria-hidden="true">
                      {'★'.repeat(stars)}
                      {'☆'.repeat(Math.max(0, 3 - stars))}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {!josekiDb && !josekiDbError && <p class="notice">定石DBを読み込み中...</p>}
        </section>
      )}

      {phase === 'playing' && session && (
        <section class="midgame-practice">
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

          <p class="midgame-practice__round">
            {(pendingCompare ? pendingCompare.nextSession.moveOutcomes.length : session.moveOutcomes.length)}/{ROUNDS_PER_STAGE}手
          </p>

          {pendingCompare ? (
            // T195要件1: 悪手を打った直後、相手の自動応手を保留して2手先2盤面比較を表示する。
            <div class="midgame-practice__blunder-compare">
              <p class="midgame-practice__blunder-heading">
                最善ではありません(最善より約{Math.round(pendingCompare.lossDiscs)}石損)
              </p>
              {pendingCompare.compare ? (
                <TwoPlyCompare
                  mover={pendingCompare.preMoveSide}
                  playedMoveNotation={pendingCompare.playedMove}
                  bestMoveNotation={pendingCompare.bestMove}
                  compare={pendingCompare.compare}
                  lossDiscs={pendingCompare.lossDiscs}
                  thresholds={classifyThresholds}
                  patterns={pendingCompare.patterns}
                  onContinue={handleContinueAfterCompare}
                />
              ) : (
                <p class="notice">比較を計算しています…</p>
              )}
              <button type="button" class="midgame-practice__quit" onClick={goToStageSelect}>
                やめる
              </button>
            </div>
          ) : (
            <>
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
                {finalizing && <p class="notice midgame-finalizing">結果を確定しています…</p>}

                {/* T197: 「現在の盤面評価」から「前回の相手の手の評価値」表示へ変更。
                    まだ相手が応手していない(1手目を打つ前)は中立の控えめ表示にする。 */}
                <div class="midgame-eval-bar-panel">
                  <p class="midgame-eval-bar-panel__caption">相手の直前の手の評価(あなた視点、+ならあなた有利)</p>
                  {moveEvalBarState.kind === 'value' && <EvalBar discDiff={moveEvalBarDisplayValue!} />}
                  {moveEvalBarState.kind === 'joseki' && <p class="midgame-eval-bar-panel__note">定石</p>}
                  {moveEvalBarState.kind === 'none' && <p class="midgame-eval-bar-panel__note">まだ相手の手がありません</p>}
                </div>

                {/* T197: 「打った手の評価値」折れ線グラフ(`EvalGraph`を再利用)。 */}
                {session.moveEvalHistory.length > 0 && (
                  <div class="midgame-eval-graph">
                    <EvalGraph points={evalGraphPoints} markers={[]} />
                  </div>
                )}

                <label class="move-eval-overlay-toggle">
                  <input
                    type="checkbox"
                    checked={moveEvalOverlayEnabled}
                    onChange={(event) => handleToggleMoveEvalOverlay((event.target as HTMLInputElement).checked)}
                  />
                  候補手評価を表示
                </label>

                <button type="button" class="midgame-practice__quit" onClick={goToStageSelect}>
                  やめる
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {phase === 'result' && resultInfo && (
        <section class={`midgame-result${resultInfo.stars > 0 ? ' midgame-result--clear' : ' midgame-result--fail'}`}>
          <h2>{resultInfo.stars > 0 ? 'クリア!' : 'クリア失敗'}</h2>
          <p class="midgame-result__stars" aria-hidden="true">
            {'★'.repeat(resultInfo.stars)}
            {'☆'.repeat(3 - resultInfo.stars)}
          </p>
          {resultInfo.justImprovedBest && <p class="midgame-result__star-earned">自己ベストを更新しました!</p>}
          <p>
            評価値 {formatDiscDiff(resultInfo.startEval)} → {formatDiscDiff(resultInfo.endEval)}
            (損失{Math.round(Math.max(0, resultInfo.startEval - resultInfo.endEval))}石)
          </p>

          {resultInfo.moveOutcomes.length > 0 && (
            <ol class="midgame-result__moves">
              {resultInfo.moveOutcomes.map((move, index) => (
                <li key={index} class={move.isBest ? 'midgame-result__move--best' : undefined}>
                  {index + 1}手目: あなたの手 {move.playedMove}
                  {move.isBest ? '(最善手)' : ` / 最善手 ${move.bestMove}(ロス${Math.round(move.lossDiscs)}石)`}
                </li>
              ))}
            </ol>
          )}

          {/* T197: 「打った手の評価値」折れ線グラフ(結果画面、`EvalGraph`を再利用)。 */}
          {resultInfo.moveEvalHistory.length > 0 && (
            <div class="midgame-eval-graph">
              <EvalGraph points={resultEvalGraphPoints} markers={[]} />
            </div>
          )}

          {worstMoveCompareInfo &&
            (worstMoveCompare ? (
              <TwoPlyCompare
                mover={worstMoveCompareInfo.preMoveSide}
                playedMoveNotation={worstMoveCompareInfo.playedMove}
                bestMoveNotation={worstMoveCompareInfo.bestMove}
                compare={worstMoveCompare}
                lossDiscs={worstMoveCompareInfo.lossDiscs}
                thresholds={classifyThresholds}
                patterns={worstMoveCompareInfo.patterns}
              />
            ) : (
              <p class="notice">最も損失が大きかった手の比較を計算しています…</p>
            ))}

          <div class="midgame-result__buttons">
            <button type="button" class="btn-primary" onClick={retryFromStart}>
              もう一度
            </button>
            <button type="button" class="btn-primary" onClick={nextStage}>
              次のステージへ
            </button>
            <button type="button" onClick={goToStageSelect}>
              ステージ一覧へ戻る
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

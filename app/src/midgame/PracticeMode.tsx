import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { AttributionWaterfall } from '../analysis/AttributionWaterfall.tsx'
import { buildAttribution, replayContinuationSteps } from '../analysis/attribution.ts'
import { BoardOverlay } from '../analysis/BoardOverlay.tsx'
import '../analysis/BlunderPanel.css'
import {
  computeBoardHighlights,
  detectMotifs,
  motifHighlightSquares,
  MOTIF_KIND_LABEL,
  type BoardHighlights,
  type MotifContext,
  type MotifDefinition,
} from '../analysis/motifs.ts'
import { buildRefutationResult, type RefutationResult } from '../analysis/refutation.ts'
import { RefutationView } from '../analysis/RefutationView.tsx'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { AttributionBreakdown, ClassifyThresholds, EvalTerms, FeatureSet } from '../analysis/types.ts'
import { analyzeWhyBad, computeStableSquares, type WhyBadResult } from '../analysis/whyBad.ts'
import { Board } from '../components/Board.tsx'
import { formatDiscDiff } from '../components/EvalBadge.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
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
import { EvalBar } from './EvalBar.tsx'
import { generateSelfPlayPosition, pickJosekiEndPosition, type StartPosition } from './generateStart.ts'
import { judgeMidgameMove, type EvalSign, type JudgeMidgameMoveResult, type JudgeMidgameReasonKind } from './judgeMidgameMove.ts'
import { loadJudgeMode, saveJudgeMode } from './judgeModeStorage.ts'
import { pickOpponentMove } from './pickOpponentMove.ts'
import { addPoolEntry } from './pool.ts'
import { resolveMover, resolveNextSideOrFallback } from './resolveMover.ts'
import { buildMidgameStagePool, type MidgameStage } from './stagePool.ts'
import {
  loadStageProgress,
  recordStageAttempt,
  stageStarCount,
  stageStatus,
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

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
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
  /** 現在の(または直前の)セッションが開始されたステージ。ランダム練習中は`null`。 */
  const [activeStage, setActiveStage] = useState<MidgameStage | null>(null)
  /** 直前のクリアで新たに★を獲得した(このステージ×判定モードの初クリア)場合`true`(要件5)。 */
  const [justEarnedStar, setJustEarnedStar] = useState(false)

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

  // --- 失敗時の説明UI(T072、`analysis/BlunderPanel.tsx`と同等のロジックを再利用) ---
  // 特徴量層(モチーフ検出用)・評価内訳waterfall・反証層(回収点)は、判定モードに
  // よる失敗(`handleModeFailure`、`resultInfo.preMoveBoard`等が揃っているケース)
  // でのみ計算する。終盤の最終石差不足による失敗(`checkEnd`/`finishByFinalScore`、
  // 特定の1手に起因しない)では対象の着手が無いため、これらは`null`のままになる
  // (要件5、描画側で`resultInfo.playedSquare !== undefined`等をガードに使う)。
  const [failFeatureSet, setFailFeatureSet] = useState<FeatureSet | null>(null)
  const [failFeatureSetError, setFailFeatureSetError] = useState<string | null>(null)
  const [failAttribution, setFailAttribution] = useState<AttributionBreakdown | null>(null)
  const [failAttributionError, setFailAttributionError] = useState<string | null>(null)
  const [failRefutation, setFailRefutation] = useState<RefutationResult | null>(null)
  const [failRefutationError, setFailRefutationError] = useState<string | null>(null)
  /** クリックしたモチーフタグのキー(要件4: もう一度クリック、または他のモチーフをクリックで切り替え)。 */
  const [activeMotifKey, setActiveMotifKey] = useState<string | null>(null)
  /** `activeMotifKey`に対応する盤面ハイライトマス集合(`BoardOverlay`の`emphasizedSquares`に渡す)。 */
  const [motifHighlight, setMotifHighlight] = useState<readonly number[] | null>(null)
  /**
   * `loadFailExplanation`の非同期応答が、その後の「やり直し」等で状態がリセット
   * された後に古い結果を上書きしてしまわないようにするための世代カウンタ
   * (他の箇所の`cancelled`フラグと同じ目的だが、`handleModeFailure`は
   * `useEffect`ではなくイベントハンドラから呼ばれるため、`ref`で代用する)。
   */
  const failRequestIdRef = useRef(0)

  /** 失敗時の説明UI用の状態を初期化する(新しい試行の開始時、要件2〜4)。 */
  function resetFailExplanation(): void {
    failRequestIdRef.current += 1
    setFailFeatureSet(null)
    setFailFeatureSetError(null)
    setFailAttribution(null)
    setFailAttributionError(null)
    setFailRefutation(null)
    setFailRefutationError(null)
    setActiveMotifKey(null)
    setMotifHighlight(null)
  }

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
   */
  async function checkEnd(
    board: BoardState,
    sideToMove: Side,
    humanSide: Side,
    stageKey: string | null,
  ): Promise<boolean> {
    const mover = resolveMover(board, sideToMove)
    if (mover === null) {
      finishByFinalScore(board, humanSide, stageKey)
      return true
    }
    if (countEmpty(board) > 24) return false

    // ここから先は完全読みでクリア/失敗を確定させる(体感上は「唐突」になりやすい
    // 区間なので、確定作業中であることをUIに表示する。要件2参照)。
    setFinalizing(true)
    try {
      const allMoves = await getEngine().requestAnalyzeAll(board, mover, MIDGAME_ANALYZE_LIMIT)
      if (allMoves.length === 0) {
        // `resolveMover`が`mover`に合法手ありと判定したにもかかわらず`allMoves`が
        // 空、という通常は起こらないはずの不整合に対する防御的フォールバック。
        finishByFinalScore(board, humanSide, stageKey)
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

  function finishByFinalScore(board: BoardState, humanSide: Side, stageKey: string | null): void {
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
        await checkEnd(board, nextSide, s.humanSide, s.stageKey)
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
   * 失敗時の説明UI(要件3)用の追加データを取得する。
   *
   * `analysis/BlunderPanel.tsx`の悪手分析パネルと同じロジックをそのまま再利用する
   * (`detectMotifs`・`computeBoardHighlights`・`buildAttribution`・
   * `buildRefutationResult`はいずれも純粋関数、`requestFeatureSet`/`requestEvalTerms`
   * はエンジン呼び出しの取得方法までBlunderPanel.tsxと同一)。結果画面の表示自体
   * (`setPhase('result')`・`setResultInfo`)は`handleModeFailure`側で先に済ませておき、
   * 本関数はその後ろから発火する追加の非同期読み込みとして扱う(BlunderPanel.tsxの
   * マウント時`useEffect`に相当する処理を、ここでは「失敗が確定した直後」に1回だけ
   * 呼び出す形に置き換えたもの)。
   */
  async function loadFailExplanation(
    preMoveBoard: BoardState,
    preMoveSide: Side,
    playedNotation: string,
    bestMove: string | null,
    yourContinuation: readonly string[],
    correctContinuation: readonly string[] | null,
    requestId: number,
  ): Promise<void> {
    try {
      const featureSetResp = await getEngine().requestFeatureSet(preMoveBoard, preMoveSide, playedNotation)
      if (failRequestIdRef.current !== requestId) return
      setFailFeatureSet(featureSetResp.features)
    } catch (error) {
      console.error('モチーフ検出用の特徴量取得に失敗しました', error)
      if (failRequestIdRef.current === requestId) setFailFeatureSetError('モチーフ検出用の特徴量取得に失敗しました。')
    }

    if (!bestMove || !correctContinuation) return

    try {
      const playedBoards = replayContinuationSteps(preMoveBoard, preMoveSide, yourContinuation)
      const bestBoards = replayContinuationSteps(preMoveBoard, preMoveSide, correctContinuation)
      const fetchTermsSequence = (boards: readonly BoardState[]): Promise<EvalTerms[]> =>
        Promise.all(boards.map((board) => getEngine().requestEvalTerms(board, preMoveSide)))
      const [playedTermsSequence, bestTermsSequence] = await Promise.all([
        fetchTermsSequence(playedBoards),
        fetchTermsSequence(bestBoards),
      ])
      if (failRequestIdRef.current !== requestId) return

      setFailAttribution(
        buildAttribution(
          playedTermsSequence[playedTermsSequence.length - 1]!,
          bestTermsSequence[bestTermsSequence.length - 1]!,
          preMoveSide,
        ),
      )
      setFailRefutation(
        buildRefutationResult(
          preMoveBoard,
          preMoveSide,
          yourContinuation,
          correctContinuation,
          playedTermsSequence,
          bestTermsSequence,
          preMoveSide,
        ),
      )
    } catch (error) {
      console.error('評価内訳分解・反証層の計算に失敗しました', error)
      if (failRequestIdRef.current === requestId) {
        setFailAttributionError('評価内訳の取得に失敗しました。')
        setFailRefutationError('回収点の検出に失敗しました。')
      }
    }
  }

  /**
   * 判定モードによる失敗(要件4・8)。比較PVを取得して結果画面に表示する。
   * この関数は必ず失敗確定を意味する(呼び出し元の`judgement.correct === false`
   * のときのみ呼ばれる)ため、ステージ挑戦記録は関数の**先頭**(比較PV取得の
   * `await`より前)で同期的に行う(T117 redo #1の教訓)。
   */
  async function handleModeFailure(
    s: SessionState,
    square: number,
    playedNotation: string,
    judgement: JudgeMidgameMoveResult,
  ): Promise<void> {
    recordStageAttemptNow(s.stageKey, 'fail')
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

    setEvalBarValue(judgement.playedDiscDiff ?? judgement.bestDiscDiff ?? 0)
    setShowEvalBar(true)
    setPhase('result')
    resetFailExplanation()
    const requestId = failRequestIdRef.current
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
    })
    await registerFailure()
    void loadFailExplanation(
      s.board,
      s.sideToMove,
      playedNotation,
      judgement.bestMove,
      comparePv?.yourContinuation ?? [playedNotation],
      comparePv?.correctContinuation ?? null,
      requestId,
    )
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
   */
  async function handlePlayerMove(square: number): Promise<void> {
    if (phase !== 'playing' || !session || analyzing) return
    const s = session
    if (s.sideToMove !== s.humanSide) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    setAnalyzing(true)
    try {
      const allMoves = await getAnalyzedMoves(s.board, s.sideToMove)
      const playedNotation = squareToNotation(square)
      const judgement = judgeMidgameMove({
        mode: judgeMode,
        allMoves,
        playedMove: playedNotation,
        previousSign: s.previousSign,
      })

      if (!judgement.correct) {
        await handleModeFailure(s, square, playedNotation, judgement)
        return
      }

      const board = applyMove(s.board, s.sideToMove, square)
      const nextSide = resolveNextSideOrFallback(board, opposite(s.sideToMove))
      setSession({
        board,
        sideToMove: nextSide,
        humanSide: s.humanSide,
        lastMove: square,
        previousSign: judgement.nextSign,
        stageKey: s.stageKey,
      })
      await checkEnd(board, nextSide, s.humanSide, s.stageKey)
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
   */
  function resetSessionTo(start: StartPosition, stage: MidgameStage | null = null): void {
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
    resetFailExplanation()
    setPhase('playing')
    void checkEnd(start.board, sideToMove, start.sideToMove, stage?.key ?? null)
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

  function backToSettings(): void {
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
    resetFailExplanation()
  }

  /** ステージ一覧画面を開く(T119要件2)。設定画面・結果画面の両方から呼ばれる。 */
  function goToStageSelect(): void {
    setPhase('stageSelect')
    setSession(null)
    setStartInfo(null)
    setResultInfo(null)
    setShowEvalBar(false)
    setEvalBarValue(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setFinalizing(false)
    resetFailExplanation()
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

  /** モチーフタグのクリック(要件4): クリックでON、同じタグの再クリックでOFF。 */
  function handleMotifClick(key: string, ctx: MotifContext): void {
    if (activeMotifKey === key) {
      setActiveMotifKey(null)
      setMotifHighlight(null)
      return
    }
    setActiveMotifKey(key)
    setMotifHighlight(motifHighlightSquares(key, ctx))
  }

  // 失敗時の説明UI(要件3〜5)。判定モードによる失敗(`handleModeFailure`が
  // `preMoveBoard`/`preMoveSide`/`playedSquare`を設定したケース)でのみ算出する。
  const failMove =
    resultInfo?.kind === 'fail' && resultInfo.preMoveBoard && resultInfo.preMoveSide && resultInfo.playedSquare !== undefined
      ? { board: resultInfo.preMoveBoard, side: resultInfo.preMoveSide, square: resultInfo.playedSquare }
      : null

  const failMotifContext: MotifContext | null =
    failMove && failFeatureSet
      ? { beforeBoard: failMove.board, side: failMove.side, square: failMove.square, features: failFeatureSet }
      : null
  const failMotifs: MotifDefinition[] = failMotifContext ? detectMotifs(failMotifContext) : []
  const failBoardHighlights: BoardHighlights | null = failMotifContext
    ? computeBoardHighlights(failMotifContext, computeStableSquares)
    : null
  const failWhyBad: WhyBadResult | null = failMove ? analyzeWhyBad(failMove.board, failMove.side, failMove.square) : null

  return (
    <div class="midgame-practice-mode">
      {josekiDbError && <p class="notice notice--error">{josekiDbError}</p>}
      {startError && <p class="notice notice--error">{startError}</p>}

      {phase === 'settings' && (
        <section class="midgame-settings">
          <p>中盤練習モード: 条件を選んで開始してください</p>

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
            <button type="button" disabled={!josekiDb || starting} onClick={() => void startPractice()}>
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

          <div class="midgame-stage-grid">
            {stagePool?.map((stage) => {
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
          <p class="status">
            あなたは{sideLabel(session.humanSide)}番です。 手番: {sideLabel(session.sideToMove)}
            {opponentThinking ? '(相手考慮中...)' : ''}
            {analyzing ? '(判定中...)' : ''}
          </p>

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
          <button type="button" class="midgame-practice__quit" onClick={backToSettings}>
            やめる
          </button>
        </section>
      )}

      {phase === 'result' && resultInfo?.kind === 'clear' && (
        <section class="midgame-result midgame-result--clear">
          <h2>クリア!</h2>
          <p>石差 {formatDiscDiff(resultInfo.margin)} で優勢を確定できました。</p>
          {justEarnedStar && <p class="midgame-result__star-earned">★ 新しい★を獲得しました!</p>}
          <div class="midgame-result__buttons">
            <button type="button" onClick={retryFromStart}>
              もう一度(同じ局面)
            </button>
            {activeStage && (
              <>
                <button type="button" onClick={nextStage}>
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

          {resultInfo.preMoveBoard && resultInfo.preMoveSide && (
            <div class="board-container midgame-result__board">
              <Board
                board={resultInfo.preMoveBoard}
                sideToMove={resultInfo.preMoveSide}
                lastMove={resultInfo.playedSquare ?? null}
              />
              {resultInfo.bestSquare !== null &&
                resultInfo.bestSquare !== undefined &&
                resultInfo.bestSquare !== resultInfo.playedSquare && (
                  <div class="midgame-highlight-overlay">
                    <div
                      class="midgame-highlight-overlay__cell"
                      style={{
                        left: `${((resultInfo.bestSquare % 8) / 8) * 100}%`,
                        top: `${(Math.floor(resultInfo.bestSquare / 8) / 8) * 100}%`,
                      }}
                    />
                  </div>
                )}
              {failBoardHighlights && (
                <BoardOverlay
                  highlights={failBoardHighlights}
                  visible={{ frontier: false, stable: false, seed: false, dangerousCorners: false }}
                  emphasizedSquares={motifHighlight ?? undefined}
                />
              )}
            </div>
          )}

          {resultInfo.comparePv && (
            <div class="midgame-result__compare-pv">
              <p>あなたの手 → 相手の最善進行: {formatContinuation(resultInfo.comparePv.yourContinuation)}</p>
              {resultInfo.comparePv.correctContinuation && (
                <p>正解手 → 進行: {formatContinuation(resultInfo.comparePv.correctContinuation)}</p>
              )}
            </div>
          )}

          {failMove && (
            <div class="blunder-panel__section midgame-result__explanation">
              <h3>なぜ悪いか</h3>
              {failWhyBad && (
                <ul class="blunder-panel__why-bad">
                  {failWhyBad.reasons.map((reason, i) => (
                    <li key={i}>{reason.text}</li>
                  ))}
                </ul>
              )}

              <h3>モチーフ検出タグ</h3>
              {failFeatureSetError && <p class="notice notice--error">{failFeatureSetError}</p>}
              {!failFeatureSet && !failFeatureSetError && <p class="notice">モチーフを検出中...</p>}
              {failFeatureSet && failMotifs.length === 0 && <p class="notice">該当するモチーフは検出されませんでした。</p>}
              {failMotifs.length > 0 && (
                <>
                  <p class="notice blunder-panel__highlight-hint">
                    タグをクリックすると、該当する形が上の盤面上でハイライトされます(もう一度クリックすると解除されます)。
                  </p>
                  <ul class="blunder-panel__motifs">
                    {failMotifs.map((motif) => (
                      <li key={motif.key}>
                        <button
                          type="button"
                          class={`motif-badge motif-badge--${motif.kind} motif-badge--button${
                            activeMotifKey === motif.key ? ' motif-badge--active' : ''
                          }`}
                          aria-pressed={activeMotifKey === motif.key}
                          onClick={() => failMotifContext && handleMotifClick(motif.key, failMotifContext)}
                        >
                          {motif.label}
                          <span class="motif-badge__kind">({MOTIF_KIND_LABEL[motif.kind]})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {resultInfo.bestMove && (
                <>
                  <h3>評価内訳(実際の手 vs 正解手の進行)</h3>
                  {!failAttribution && !failAttributionError && <p class="notice">評価内訳を計算中...</p>}
                  {failAttributionError && <p class="notice notice--error">{failAttributionError}</p>}
                  {failAttribution && (
                    <AttributionWaterfall
                      breakdown={failAttribution}
                      title={`${sideLabel(failMove.side)}番から見た評価差の内訳(石差)`}
                    />
                  )}

                  <h3>反証層: 回収点(寄与が急変した手)</h3>
                  {!failRefutation && !failRefutationError && <p class="notice">回収点を検出中...</p>}
                  {failRefutationError && <p class="notice notice--error">{failRefutationError}</p>}
                  {failRefutation && <RefutationView refutation={failRefutation} />}
                </>
              )}
            </div>
          )}

          <div class="midgame-result__buttons">
            <button type="button" onClick={retryFromStart}>
              ここからやり直す
            </button>
            {activeStage && (
              <>
                <button type="button" onClick={nextStage}>
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

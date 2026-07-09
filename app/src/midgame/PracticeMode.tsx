import { useEffect, useRef, useState } from 'preact/hooks'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import { EngineClient } from '../engine/client.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import { bigintToHex } from '../engine/hex.ts'
import {
  applyMove,
  countDiscs,
  countEmpty,
  hasLegalMove,
  isTerminal,
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
import { pickOpponentMove } from './pickOpponentMove.ts'
import { addPoolEntry } from './pool.ts'
import { resolveMover } from './resolveMover.ts'
import type { JudgeMode, OpponentStrength, StartPositionSource } from './types.ts'
import './PracticeMode.css'

/**
 * 中盤練習モードのエンジン解析に使う探索条件(要件3: depth目安16、時間予算0.3秒程度)。
 * `exactFromEmpties: 24` により、空きマスが24以下になった局面では自動的に完全読みに
 * 切り替わる(要件6。エンジン側が実際の空きマス数と比較して判断するため、
 * この定数を対局中ずっと使い続けるだけでよい)。
 */
const MIDGAME_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 300, exactFromEmpties: 24 }

/** 相手が着手するまでの見せかけの「考慮時間」(ミリ秒、`joseki/PracticeMode.tsx`と同じ演出)。 */
const OPPONENT_MOVE_DELAY_MS = 350

/** クリア条件: 手番に依らずプレイヤー視点の石差がこの値以上ならクリア(要件6)。 */
const CLEAR_MARGIN = 2

type Phase = 'settings' | 'generating' | 'playing' | 'result'

interface SessionState {
  readonly board: BoardState
  readonly sideToMove: Side
  /** プレイヤーが担当する色。開始局面の手番側をそのままプレイヤーとする。 */
  readonly humanSide: Side
  readonly lastMove: number | null
  /** 逆転禁止モード用に持ち回す、直近の非ゼロ評価符号。 */
  readonly previousSign: EvalSign
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

  const [judgeMode, setJudgeMode] = useState<JudgeMode>('standard')
  const [opponentStrength, setOpponentStrength] = useState<OpponentStrength>('top3Random')
  const [startSource, setStartSource] = useState<StartPositionSource>('josekiEnd')

  const [phase, setPhase] = useState<Phase>('settings')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const [startInfo, setStartInfo] = useState<StartPosition | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null)

  const [showEvalBar, setShowEvalBar] = useState(false)
  const [evalBarValue, setEvalBarValue] = useState<number | null>(null)

  const [opponentThinking, setOpponentThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)

  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)

  const engineRef = useRef<EngineClient | null>(null)

  function getEngine(): EngineClient {
    if (!engineRef.current) {
      engineRef.current = new EngineClient()
    }
    return engineRef.current
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

  // Workerはコンポーネントのライフタイム中1つだけ生成し、アンマウント時に終了する。
  useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      engineRef.current = null
    }
  }, [])

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
   */
  async function checkEnd(board: BoardState, sideToMove: Side, humanSide: Side): Promise<boolean> {
    const mover = resolveMover(board, sideToMove)
    if (mover === null) {
      finishByFinalScore(board, humanSide)
      return true
    }
    if (countEmpty(board) > 24) return false

    try {
      const allMoves = await getEngine().requestAnalyzeAll(board, mover, MIDGAME_ANALYZE_LIMIT)
      if (allMoves.length === 0) {
        // `resolveMover`が`mover`に合法手ありと判定したにもかかわらず`allMoves`が
        // 空、という通常は起こらないはずの不整合に対する防御的フォールバック。
        finishByFinalScore(board, humanSide)
        return true
      }
      const best = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
      const humanEval = mover === humanSide ? best.discDiff : -best.discDiff
      setEvalBarValue(humanEval)

      if (humanEval >= CLEAR_MARGIN) {
        setShowEvalBar(false)
        setPhase('result')
        setResultInfo({ kind: 'clear', margin: humanEval })
        return true
      }

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
    }
  }

  function finishByFinalScore(board: BoardState, humanSide: Side): void {
    const humanDiscs = countDiscs(board, humanSide)
    const oppDiscs = countDiscs(board, opposite(humanSide))
    const margin = humanDiscs - oppDiscs
    setEvalBarValue(margin)
    setPhase('result')
    if (margin >= CLEAR_MARGIN) {
      setShowEvalBar(false)
      setResultInfo({ kind: 'clear', margin })
    } else {
      setShowEvalBar(true)
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

  // 終局・パスの自動処理: 手番側に合法手が無ければ手番を交代するだけ、
  // 両者とも合法手が無ければ終了判定を行う。人間・相手どちらの手番でも共通に扱う。
  useEffect(() => {
    if (phase !== 'playing' || !session) return
    const s = session

    if (isTerminal(s.board)) {
      void checkEnd(s.board, s.sideToMove, s.humanSide)
      return
    }
    if (!hasLegalMove(s.board, s.sideToMove)) {
      setSession({ ...s, sideToMove: opposite(s.sideToMove) })
    }
    // eslint-disable-next-line
  }, [phase, session])

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
        const nextSide = opposite(s.sideToMove)
        setSession({ ...s, board, sideToMove: nextSide, lastMove: square })
        await checkEnd(board, nextSide, s.humanSide)
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

  // 盤面セル評価オーバーレイ(T039をT042で展開)。人間の手番になった時点で、表示ONの
  // 場合のみ現局面(着手前)の全合法手の評価をまとめて取得する。判定中(`analyzing`、
  // `handlePlayerMove`が別途`requestAnalyzeAll`を呼んでいる最中)は重複リクエストを
  // 避けるため取得しない(要件5、388行目付近の二重クリック防止ガードと同じ配慮)。
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
    getEngine()
      .requestAnalyzeAll(session.board, session.sideToMove, MIDGAME_ANALYZE_LIMIT)
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

  /** 判定モードによる失敗(要件4・8)。比較PVを取得して結果画面に表示する。 */
  async function handleModeFailure(
    s: SessionState,
    square: number,
    playedNotation: string,
    judgement: JudgeMidgameMoveResult,
  ): Promise<void> {
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
  }

  /**
   * 人間がボードをクリックしたときの処理(要件3・4)。
   *
   * `analyzing`(前回のクリックの判定が完了する前)であれば無視する。連打・
   * ダブルクリックによって`requestAnalyzeAll`が同じ着手前局面に対して複数回
   * 同時発行され、それぞれが古い`session`を元に`setSession`/`checkEnd`を
   * 呼んでしまう(状態の競合・多重更新)のを防ぐための再入防止ガード。
   */
  async function handlePlayerMove(square: number): Promise<void> {
    if (phase !== 'playing' || !session || analyzing) return
    const s = session
    if (s.sideToMove !== s.humanSide) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    setAnalyzing(true)
    try {
      const allMoves = await getEngine().requestAnalyzeAll(s.board, s.sideToMove, MIDGAME_ANALYZE_LIMIT)
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
      const nextSide = opposite(s.sideToMove)
      setSession({
        board,
        sideToMove: nextSide,
        humanSide: s.humanSide,
        lastMove: square,
        previousSign: judgement.nextSign,
      })
      await checkEnd(board, nextSide, s.humanSide)
    } catch (error) {
      console.error('着手判定のための解析に失敗しました', error)
    } finally {
      setAnalyzing(false)
    }
  }

  function resetSessionTo(start: StartPosition): void {
    setStartInfo(start)
    setSession({
      board: start.board,
      sideToMove: start.sideToMove,
      humanSide: start.sideToMove,
      lastMove: null,
      previousSign: 0,
    })
    setResultInfo(null)
    setShowEvalBar(false)
    setEvalBarValue(null)
    setOpponentThinking(false)
    setAnalyzing(false)
    setPhase('playing')
  }

  /** 設定画面で「開始」を押したときの処理(要件1・2)。 */
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

  /** 結果画面の「ここからやり直す」ボタン(要件8): 同じ開始局面から再挑戦する。 */
  function retryFromStart(): void {
    if (!startInfo) return
    resetSessionTo(startInfo)
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
  }

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
                  onChange={() => setJudgeMode(value)}
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

          <button type="button" disabled={!josekiDb || starting} onClick={() => void startPractice()}>
            開始
          </button>
          {!josekiDb && !josekiDbError && <p class="notice">定石DBを読み込み中...</p>}
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
          <p>石差 {resultInfo.margin >= 0 ? `+${resultInfo.margin.toFixed(1)}` : resultInfo.margin.toFixed(1)} で優勢を確定できました。</p>
          <div class="midgame-result__buttons">
            <button type="button" onClick={retryFromStart}>
              もう一度(同じ局面)
            </button>
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
              {resultInfo.lossDiscs !== undefined && `(ロス${resultInfo.lossDiscs.toFixed(1)}石)`}
            </p>
          )}
          {resultInfo.bestMove && <p>正解手: {resultInfo.bestMove}</p>}
          {resultInfo.margin !== undefined && <p>最終石差: {resultInfo.margin.toFixed(1)}</p>}

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

          <div class="midgame-result__buttons">
            <button type="button" onClick={retryFromStart}>
              ここからやり直す
            </button>
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

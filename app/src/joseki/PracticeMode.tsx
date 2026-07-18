import { useEffect, useRef, useState } from 'preact/hooks'
import { loadClassifyThresholds } from '../analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { loadMoveEvalOverlayEnabled, saveMoveEvalOverlayEnabled } from '../settings/moveEvalOverlaySettings.ts'
import { getAllSrsStates, recordSrsResults } from './db.ts'
import { computeDueLines, dueSummaryHeadline, previewDueLineNames, selectPracticeTargetLine } from './dueLines.ts'
import { judgeMove } from './judgeMove.ts'
import { loadJosekiDb, lookupJosekiNode, type JosekiBookMoveView } from './lookup.ts'
import { pickBookMove, preferMovesTowardTarget } from './pickBookMove.ts'
import { advanceClearState } from './practiceSession.ts'
import type { JosekiDb, JosekiLine } from './types.ts'
import './PracticeMode.css'

/** 定石練習モードのエンジン解析に使う探索条件(固定。難易度選択は本タスクのスコープ外)。 */
const ANALYZE_LIMIT: AnalyzeLimit = { depth: 8, exactFromEmpties: 12 }

/** 相手(定石DB側)が着手するまでの見せかけの「考慮時間」(ミリ秒)。UI上の間の演出用。 */
const OPPONENT_MOVE_DELAY_MS = 350

type Phase = 'colorSelect' | 'playing' | 'clear' | 'gameOver'

interface PracticeState {
  readonly board: BoardState
  readonly sideToMove: Side
  readonly humanSide: Side
  /** 対局で実際に指された初手のマス(まだ黒が着手していなければ `null`)。 */
  readonly firstMoveSquare: number | null
  readonly lastMove: number | null
  readonly moveHistory: readonly number[]
  /**
   * セッション開始からここまでに通過した`isLeaf`ノードの定石名の和集合(重複除去)。
   * T017のDB設計上、短いラインの終端が長いラインの通過点を兼ねることがあるため、
   * `isLeaf`到達は即クリアではなく「通過記録」として蓄積し、`bookMoves`が真に空に
   * なった時点で初めてクリアとする(`practiceSession.ts` 参照)。
   */
  readonly clearedLineNames: readonly string[]
  /**
   * 「復習を始める」ボタン(due限定出題)で開始したが、当時dueが0件だったため
   * 通常出題(全ライン)にフォールバックしたセッションかどうか(要件3のSRS
   * 見える化・T131)。`playing`画面でその旨を表示するために使う。
   */
  readonly reviewFallback: boolean
}

interface ClearResultInfo {
  readonly kind: 'clear'
  /** セッション中に通過した全`isLeaf`ノードの定石名の和集合(補足表示用)。 */
  readonly names: readonly string[]
  /**
   * セッションを実際に終わらせた最終ノード(`bookMoves`が真に空だったノード)の定石名。
   * クリア画面で主役として表示する(T026)。
   */
  readonly finalNodeNames: readonly string[]
  readonly moveHistory: readonly number[]
}

interface GameOverResultInfo {
  readonly kind: 'gameOver'
  readonly reasonKind: 'offBookClose' | 'blunder'
  readonly playedSquare: number
  readonly lossDiscs: number
  readonly bestMove: string | null
  readonly playedDiscDiff: number | null
  readonly correctMoves: readonly JosekiBookMoveView[]
  readonly moveHistory: readonly number[]
  /**
   * 定石外の一手を打つ**直前の局面**での`lookupJosekiNode(...).names`
   * (=そこまで合流していた、まだ一致しうる可能性があった定石ライン名一覧)。
   * クリア画面(T026)と異なり「唯一の到達ライン」という概念が無いため、
   * フラットな一覧としてそのまま表示する(T075)。
   */
  readonly matchedLineNames: readonly string[]
}

type ResultInfo = ClearResultInfo | GameOverResultInfo

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

function pickRandomSide(): Side {
  return Math.random() < 0.5 ? 'black' : 'white'
}

function formatSquares(squares: readonly number[]): string {
  return squares.map(squareToNotation).join(' ')
}

function formatBookMoves(moves: readonly JosekiBookMoveView[]): string {
  return moves.map((m) => squareToNotation(m.move)).join(', ')
}

/**
 * クリア画面の主役表示用に、最終ノードの定石名を整形する。
 * 1つの終端局面に複数の定石が合流している場合は「あるいは」で並べ、
 * それらが同じ最終局面を共有していることが伝わるようにする(T026 要件2・4)。
 */
function formatFinalNodeNames(names: readonly string[]): string {
  return names.join(' あるいは ')
}

/**
 * ゲームオーバー画面で、定石外の一手を打つ直前まで一致していた定石ライン名の
 * 一覧を「フラットな一覧」として整形する(T075)。
 * クリア画面(`formatFinalNodeNames`)と違い「唯一の到達ライン」という概念が無いため、
 * 主役/補足の区別を付けず、単純に列挙する。
 */
function formatMatchedLineNames(names: readonly string[]): string {
  return names.join('・')
}

/**
 * 定石練習モード(T020)。
 *
 * 設計書 `othello-trainer-design.md` §2.6「定石練習モード」(オセロクエスト式)の実装:
 * 1. 色選択(黒/白/ランダム)
 * 2. 相手は現局面の定石DBの `bookMoves` から重み比例のランダム抽選で着手
 *    (出題対象ラインがまだ辿れる候補があれば優先する)
 * 3. プレイヤーが `bookMoves` に無い手を打つと、`requestAnalyzeAll` の結果を元に
 *    「定石外・惜しい」か「悪手」かを判定してゲームオーバー
 * 4. 定石DBノードが `isLeaf` に達しても `bookMoves` が非空ならセッション継続(通過した
 *    定石名は蓄積する)。`bookMoves` が真に空になった時点で初めてクリア
 *    (T017のDB設計上、短いラインの終端が長いラインの通過点を兼ねるケースがあるため。
 *    `practiceSession.ts` 参照)
 * 5. クリア/ゲームオーバーの結果をSRS(間隔反復)としてIndexedDBに記録する
 *    (クリア時は通過した全ライン名、ゲームオーバー時は出題対象ライン)
 *
 * レスポンシブ対応: 375px幅程度でも崩れないよう `PracticeMode.css` でボタン群・
 * 結果表示を `flex-wrap` させ、狭幅では縦積みにする。
 */
export function PracticeMode() {
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [josekiDbError, setJosekiDbError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('colorSelect')
  const [state, setState] = useState<PracticeState | null>(null)
  const [targetLineId, setTargetLineId] = useState<string | null>(null)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null)
  const [opponentThinking, setOpponentThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)
  // SRS復習キューの見える化(T131)。`null`はまだ読み込めていない(due件数不明)ことを表す。
  const [dueLines, setDueLines] = useState<JosekiLine[] | null>(null)
  // 直前に「復習を始める」(due限定)セッションを終えて戻ってきた結果、dueが0件に
  // なったかどうか(要件4)。true の間は「今日の復習はありません」の代わりに
  // 「今日の復習完了!」を表示する。
  const [justCompletedReview, setJustCompletedReview] = useState(false)
  // 直近に開始したセッションが「復習を始める」ボタン由来(かつ実際にdueから出題できた、
  // フォールバックではない)かどうかを、再レンダーを起こさず追跡するためのref。
  // colorSelect画面に戻ったタイミングでdueを再計算する effect が参照する。
  const dueOnlySessionActiveRef = useRef(false)
  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  // 定石DB(public/joseki.json)を読み込む。`loadJosekiDb` はモジュール内でキャッシュ
  // しているため、対局モード(App)と両方から呼ばれても実際のfetchは1回だけ発生する。
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

  // SRS復習キューの見える化(T131要件1・4)。色選択画面(colorSelect)に居る間に
  // 定石DBが読み込まれたら、または(練習を1回終えて)colorSelect画面に戻ってきたら、
  // IndexedDBのSRS状態を読み直してdueラインを再計算する。直前のセッションが
  // 「復習を始める」由来(due限定・フォールバックではない)で、その結果dueが0件に
  // なっていれば「今日の復習完了!」を出す(要件4)。
  useEffect(() => {
    if (!josekiDb || phase !== 'colorSelect') return
    let cancelled = false
    void (async () => {
      const due = await refreshDueLines(josekiDb)
      if (cancelled) return
      if (dueOnlySessionActiveRef.current && due.length === 0) {
        setJustCompletedReview(true)
      } else if (due.length > 0) {
        setJustCompletedReview(false)
      }
      dueOnlySessionActiveRef.current = false
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [josekiDb, phase])

  /** IndexedDBのSRS状態を読み込み、`dueLines`を再計算して`state`に反映する。 */
  async function refreshDueLines(db: JosekiDb): Promise<JosekiLine[]> {
    try {
      const allStates = await getAllSrsStates()
      const due = computeDueLines(db.lines, allStates)
      setDueLines(due)
      return due
    } catch (error) {
      console.error('SRS復習キューの読み込みに失敗しました', error)
      setDueLines(null)
      return []
    }
  }

  // 相手(定石DB側)の手番になったら、bookMovesからweight比例のランダム抽選で着手する。
  useEffect(() => {
    if (phase !== 'playing' || !state || !josekiDb) return
    if (state.sideToMove === state.humanSide) return

    const firstMove = state.firstMoveSquare
    if (firstMove === null) {
      // 人間が黒番の場合、相手の手番はfirstMoveSquareが確定した後にしか来ないはずなので
      // 通常到達しない防御的分岐。
      return
    }

    const lookupResult = lookupJosekiNode(josekiDb, state.board, state.sideToMove, firstMove)
    if (!lookupResult || lookupResult.bookMoves.length === 0) {
      console.error('定石練習: 相手の手番のはずですが、定石DBに候補手が見つかりません', state)
      return
    }

    // 出題対象ライン(targetLineId)がまだ辿れる候補があれば、そちらを優先する(要件5、必須ではないが対応)。
    // 該当が無ければ preferMovesTowardTarget が元の bookMoves をそのまま返すのでランダム抽選は変わらない。
    const candidateMoves = targetLineId
      ? preferMovesTowardTarget(lookupResult.bookMoves, (move) => {
          const simulatedBoard = applyMove(state.board, state.sideToMove, move)
          const simulatedSide = opposite(state.sideToMove)
          const simulatedLookup = lookupJosekiNode(josekiDb, simulatedBoard, simulatedSide, firstMove)
          return simulatedLookup?.names.includes(targetLineId) ?? false
        })
      : lookupResult.bookMoves

    let cancelled = false
    setOpponentThinking(true)
    const timer = setTimeout(() => {
      if (cancelled) return
      const square = pickBookMove(candidateMoves)
      advance(square)
      setOpponentThinking(false)
    }, OPPONENT_MOVE_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setOpponentThinking(false)
    }
    // eslint-disable-next-line
  }, [phase, state, josekiDb])

  // 盤面セル評価オーバーレイ(T039をT042で展開)。人間の手番になった時点で、表示ONの
  // 場合のみ現局面(着手前)の全合法手の評価をまとめて取得する。判定中(`analyzing`、
  // `handleHumanClick`が別途`requestAnalyzeAll`を呼んでいる最中)は重複リクエストを
  // 避けるため取得しない(要件5)。相手の手番・判定中はオーバーレイをクリアする。
  useEffect(() => {
    if (phase !== 'playing' || !state || state.sideToMove !== state.humanSide || !moveEvalOverlayEnabled || analyzing) {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    getEngine()
      .requestAnalyzeAll(state.board, state.sideToMove, ANALYZE_LIMIT)
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
  }, [phase, state, moveEvalOverlayEnabled, analyzing])

  /** オーバーレイ表示ON/OFFを切り替え、`localStorage`へ永続化する(T039・T042、他モードと共有)。 */
  function handleToggleMoveEvalOverlay(enabled: boolean): void {
    setMoveEvalOverlayEnabled(enabled)
    saveMoveEvalOverlayEnabled(localStorage, enabled)
  }

  /**
   * `square` に着手して局面を進める(定石内であることが確定した手にのみ使う)。
   *
   * 着手後の局面が `isLeaf` でも、`bookMoves` が非空であれば「短いラインの終端」と
   * 「長いラインの通過点」を兼ねているだけなのでセッションは継続し、通過した定石名を
   * 蓄積するだけに留める。`bookMoves` が真に空になった(その先に定石データが無い、
   * 本当の終端に達した)時点で初めてクリア扱いにし、蓄積した全ライン名についてSRSに
   * 正解を記録する(`practiceSession.ts` の `advanceClearState` 参照)。
   */
  function advance(square: number): void {
    if (!state || !josekiDb) return

    const board = applyMove(state.board, state.sideToMove, square)
    const nextSide = opposite(state.sideToMove)
    const nextFirstMove = state.firstMoveSquare ?? square
    const moveHistory = [...state.moveHistory, square]

    const lookup = lookupJosekiNode(josekiDb, board, nextSide, nextFirstMove)
    const { clearedLineNames, ended, finalNodeNames } = advanceClearState(state.clearedLineNames, lookup)

    setState({
      board,
      sideToMove: nextSide,
      humanSide: state.humanSide,
      firstMoveSquare: nextFirstMove,
      lastMove: square,
      moveHistory,
      clearedLineNames,
      reviewFallback: state.reviewFallback,
    })

    if (ended) {
      setPhase('clear')
      setResultInfo({ kind: 'clear', names: clearedLineNames, finalNodeNames, moveHistory })
      void recordSrsResults(clearedLineNames, 'success')
    }
  }

  /** 人間がボードをクリックしたときの処理。定石内なら続行、定石外なら判定してゲームオーバー。 */
  async function handleHumanClick(square: number): Promise<void> {
    if (phase !== 'playing' || !state || !josekiDb) return
    if (state.sideToMove !== state.humanSide) return
    if (!legalMoves(state.board, state.sideToMove).includes(square)) return

    const firstMove = state.firstMoveSquare ?? square
    const lookupResult = lookupJosekiNode(josekiDb, state.board, state.sideToMove, firstMove)
    const bookMoves = lookupResult?.bookMoves ?? []

    if (bookMoves.some((bm) => bm.move === square)) {
      advance(square)
      return
    }

    setAnalyzing(true)
    try {
      const allMoves = await getEngine().requestAnalyzeAll(state.board, state.sideToMove, ANALYZE_LIMIT)
      const judgement = judgeMove(bookMoves, square, allMoves)
      if (judgement.kind !== 'inBook') {
        setPhase('gameOver')
        setResultInfo({
          kind: 'gameOver',
          reasonKind: judgement.kind,
          playedSquare: square,
          lossDiscs: judgement.lossDiscs,
          bestMove: judgement.bestMove,
          playedDiscDiff: judgement.playedDiscDiff,
          correctMoves: judgement.correctMoves,
          moveHistory: state.moveHistory,
          matchedLineNames: lookupResult?.names ?? [],
        })
        if (targetLineId) void recordSrsResults([targetLineId], 'fail')
      }
    } catch (error) {
      console.error('定石外判定のための解析に失敗しました', error)
    } finally {
      setAnalyzing(false)
    }
  }

  /**
   * 色選択後、練習を開始する。IndexedDBのSRS状態を参照し「本日出題すべき」ラインの中から
   * ランダムに1つを選ぶ(要件6)。該当が無ければ全ラインからランダムに選ぶ。
   * 選んだライン(`targetLineId`)は、ゲームオーバー時のSRS記録先として使うほか、
   * 相手の着手選択でそのラインを優先するバイアスにも使う(要件5)。
   *
   * `options.dueOnly`が真の場合(「復習を始める」ボタン、T131要件3)は、
   * `selectPracticeTargetLine`でdueラインのみに限定して選ぶ。dueが0件だった
   * 場合は全ライン(`josekiDb.lines`)にフォールバックし、そのセッションの
   * `reviewFallback`を真にして「playing」画面でその旨を表示する。
   */
  async function startPractice(choice: Side | 'random', options?: { dueOnly?: boolean }): Promise<void> {
    if (!josekiDb) return
    const dueOnly = options?.dueOnly ?? false
    const humanSide = choice === 'random' ? pickRandomSide() : choice

    let target = josekiDb.lines[Math.floor(Math.random() * josekiDb.lines.length)] ?? null
    let reviewFallback = false
    try {
      const allStates = await getAllSrsStates()
      const due = computeDueLines(josekiDb.lines, allStates)
      setDueLines(due)
      const selected = selectPracticeTargetLine(josekiDb.lines, due, dueOnly)
      target = selected.target ?? target
      reviewFallback = selected.usedFallback
      dueOnlySessionActiveRef.current = dueOnly && !selected.usedFallback
    } catch (error) {
      console.error('SRS状態の読み込みに失敗しました。出題ラインはランダムに選びます', error)
      dueOnlySessionActiveRef.current = false
    }
    setTargetLineId(target?.id ?? null)
    setJustCompletedReview(false)

    setState({
      board: initialBoard(),
      sideToMove: 'black',
      humanSide,
      firstMoveSquare: humanSide === 'black' ? null : notationToSquare('f5'),
      lastMove: null,
      moveHistory: [],
      clearedLineNames: [],
      reviewFallback,
    })
    setResultInfo(null)
    setPhase('playing')
  }

  function backToColorSelect(): void {
    setPhase('colorSelect')
    setState(null)
    setResultInfo(null)
    setOpponentThinking(false)
    setAnalyzing(false)
  }

  return (
    <div class="joseki-practice-mode">
      {josekiDbError && <p class="notice notice--error">{josekiDbError}</p>}

      {phase === 'colorSelect' && (
        <section class="joseki-color-select">
          <p>定石練習モード: 手番の色を選んでください</p>
          {dueLines !== null && (
            <div class="joseki-due-summary">
              <p class="joseki-due-summary__headline">{dueSummaryHeadline(dueLines.length, justCompletedReview)}</p>
              {dueLines.length > 0 &&
                (() => {
                  const { shown, remaining } = previewDueLineNames(dueLines)
                  return (
                    <details class="joseki-due-summary__list">
                      <summary>復習対象のラインを見る({dueLines.length}件)</summary>
                      <ul>
                        {shown.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                      {remaining > 0 && <p class="joseki-due-summary__remaining">他{remaining}本</p>}
                    </details>
                  )
                })()}
              <button
                type="button"
                class="joseki-due-summary__review-button btn-primary"
                disabled={!josekiDb}
                onClick={() => void startPractice('random', { dueOnly: true })}
              >
                復習を始める
              </button>
            </div>
          )}
          <div class="joseki-color-select__buttons">
            <button type="button" class="btn-primary" disabled={!josekiDb} onClick={() => void startPractice('black')}>
              黒番で開始
            </button>
            <button type="button" class="btn-primary" disabled={!josekiDb} onClick={() => void startPractice('white')}>
              白番で開始
            </button>
            <button type="button" class="btn-primary" disabled={!josekiDb} onClick={() => void startPractice('random')}>
              ランダムで開始
            </button>
          </div>
          {!josekiDb && !josekiDbError && <p class="notice">定石DBを読み込み中...</p>}
        </section>
      )}

      {phase === 'playing' && state && (
        <section class="joseki-practice">
          <p class="status">
            あなたは{sideLabel(state.humanSide)}番です。 手番: {sideLabel(state.sideToMove)}
            {opponentThinking ? '(相手考慮中...)' : ''}
            {analyzing ? '(判定中...)' : ''}
          </p>
          {state.reviewFallback && (
            <p class="notice joseki-practice__review-fallback">
              本日の復習はないため、通常の出題です。
            </p>
          )}
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
              board={state.board}
              sideToMove={state.sideToMove}
              lastMove={state.lastMove}
              onMove={(square) => void handleHumanClick(square)}
            />
            <MoveEvalOverlay
              allMoves={overlayMoves}
              mover={state.sideToMove}
              thresholds={classifyThresholds}
              visible={moveEvalOverlayEnabled}
            />
          </div>
          <button type="button" class="joseki-practice__quit" onClick={backToColorSelect}>
            やめる
          </button>
        </section>
      )}

      {phase === 'clear' && resultInfo?.kind === 'clear' && (
        <section class="joseki-result joseki-result--clear">
          <h2>クリア!</h2>
          {/*
            主役表示: セッションを実際に終わらせた最終ノード(finalNodeNames)。
            通常は真の終端に達しているので必ず1件以上入っているが、lookupがnullになる
            防御的ケースのみ空配列になり得るため、その場合は通過した全ライン名(names)に
            フォールバックする(T026)。
          */}
          <p class="joseki-result__final">
            到達した定石:{' '}
            <strong>
              {formatFinalNodeNames(
                resultInfo.finalNodeNames.length > 0 ? resultInfo.finalNodeNames : resultInfo.names,
              )}
            </strong>
            {' '}をクリアしました!
          </p>
          {(() => {
            const finalSet = new Set(resultInfo.finalNodeNames)
            const passedOnly = resultInfo.names.filter((name) => !finalSet.has(name))
            if (passedOnly.length === 0) return null
            return (
              <details class="joseki-result__passed">
                <summary>この過程で経由した定石({passedOnly.length}件)</summary>
                <p>{passedOnly.join('・')}</p>
              </details>
            )
          })()}
          <p class="joseki-result__moves">手順: {formatSquares(resultInfo.moveHistory)}</p>
          <button type="button" class="btn-primary" onClick={backToColorSelect}>
            もう一度
          </button>
        </section>
      )}

      {phase === 'gameOver' && resultInfo?.kind === 'gameOver' && (
        <section class="joseki-result joseki-result--gameover">
          <h2>ゲームオーバー</h2>
          <p>
            {squareToNotation(resultInfo.playedSquare)} は
            {resultInfo.reasonKind === 'offBookClose' ? '定石外(惜しい)でした。' : '悪手でした。'}
          </p>
          {/*
            あなたの実際の進行(定石外だった最後の一手を含む、要件1)。定石外の一手が
            分かるよう強調表示する。
          */}
          <p class="joseki-result__moves">
            手順:{' '}
            {resultInfo.moveHistory.length > 0 && `${formatSquares(resultInfo.moveHistory)} `}
            <strong class="joseki-result__off-book-move">
              {squareToNotation(resultInfo.playedSquare)}
            </strong>
          </p>
          {/*
            そこまで(定石外の一手を打つ直前まで)一致していた定石ライン名の一覧
            (要件2)。クリア画面と違い「唯一の到達ライン」という概念が無いため、
            主役/補足の区別を付けずフラットに列挙する(T075)。1件も無ければ
            その旨を表示する(要件3)。
          */}
          <div class="joseki-result__matched-lines">
            {resultInfo.matchedLineNames.length > 0 ? (
              <p>
                {formatSquares(resultInfo.moveHistory) || '(初手)'} まで一致していた定石(
                {resultInfo.matchedLineNames.length}件): {formatMatchedLineNames(resultInfo.matchedLineNames)}
              </p>
            ) : (
              <p>一致していた定石はありませんでした。</p>
            )}
          </div>
          {resultInfo.correctMoves.length > 0 && (
            <p>正解手: {formatBookMoves(resultInfo.correctMoves)}</p>
          )}
          {resultInfo.bestMove && resultInfo.playedDiscDiff !== null && (
            <p class="joseki-result__reason">
              最善手 {resultInfo.bestMove} に対し、あなたの手 {squareToNotation(resultInfo.playedSquare)} は
              ロス{Math.round(resultInfo.lossDiscs)}石でした。
            </p>
          )}
          <button type="button" class="btn-primary" onClick={backToColorSelect}>
            もう一度
          </button>
        </section>
      )}
    </div>
  )
}

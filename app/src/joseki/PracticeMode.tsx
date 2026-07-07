import { useEffect, useRef, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { EngineClient } from '../engine/client.ts'
import type { AnalyzeLimit } from '../engine/types.ts'
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
import { getAllSrsStates, recordSrsResults } from './db.ts'
import { judgeMove } from './judgeMove.ts'
import { loadJosekiDb, lookupJosekiNode, type JosekiBookMoveView } from './lookup.ts'
import { pickBookMove, preferMovesTowardTarget } from './pickBookMove.ts'
import { advanceClearState } from './practiceSession.ts'
import { isDue } from './srs.ts'
import type { JosekiDb } from './types.ts'
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
}

interface ClearResultInfo {
  readonly kind: 'clear'
  readonly names: readonly string[]
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
  const engineRef = useRef<EngineClient | null>(null)

  function getEngine(): EngineClient {
    if (!engineRef.current) {
      engineRef.current = new EngineClient()
    }
    return engineRef.current
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

  // Workerはコンポーネントのライフタイム中1つだけ生成し、アンマウント時に終了する。
  useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      engineRef.current = null
    }
  }, [])

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
    const { clearedLineNames, ended } = advanceClearState(state.clearedLineNames, lookup)

    setState({
      board,
      sideToMove: nextSide,
      humanSide: state.humanSide,
      firstMoveSquare: nextFirstMove,
      lastMove: square,
      moveHistory,
      clearedLineNames,
    })

    if (ended) {
      setPhase('clear')
      setResultInfo({ kind: 'clear', names: clearedLineNames, moveHistory })
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
   */
  async function startPractice(choice: Side | 'random'): Promise<void> {
    if (!josekiDb) return
    const humanSide = choice === 'random' ? pickRandomSide() : choice

    let target = josekiDb.lines[Math.floor(Math.random() * josekiDb.lines.length)] ?? null
    try {
      const allStates = await getAllSrsStates()
      const stateMap = new Map(allStates.map((s) => [s.lineId, s]))
      const now = new Date()
      const dueLines = josekiDb.lines.filter((line) => isDue(stateMap.get(line.id), now))
      const pool = dueLines.length > 0 ? dueLines : josekiDb.lines
      target = pool[Math.floor(Math.random() * pool.length)] ?? target
    } catch (error) {
      console.error('SRS状態の読み込みに失敗しました。出題ラインはランダムに選びます', error)
    }
    setTargetLineId(target?.id ?? null)

    setState({
      board: initialBoard(),
      sideToMove: 'black',
      humanSide,
      firstMoveSquare: humanSide === 'black' ? null : notationToSquare('f5'),
      lastMove: null,
      moveHistory: [],
      clearedLineNames: [],
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
          <div class="joseki-color-select__buttons">
            <button type="button" disabled={!josekiDb} onClick={() => void startPractice('black')}>
              黒番で開始
            </button>
            <button type="button" disabled={!josekiDb} onClick={() => void startPractice('white')}>
              白番で開始
            </button>
            <button type="button" disabled={!josekiDb} onClick={() => void startPractice('random')}>
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
          <div class="board-container">
            <Board
              board={state.board}
              sideToMove={state.sideToMove}
              lastMove={state.lastMove}
              onMove={(square) => void handleHumanClick(square)}
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
          <p>
            <strong>{resultInfo.names.join('・')}</strong> を最後まで打てました。
          </p>
          <p class="joseki-result__moves">手順: {formatSquares(resultInfo.moveHistory)}</p>
          <button type="button" onClick={backToColorSelect}>
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
          {resultInfo.correctMoves.length > 0 && (
            <p>正解手: {formatBookMoves(resultInfo.correctMoves)}</p>
          )}
          {resultInfo.bestMove && resultInfo.playedDiscDiff !== null && (
            <p class="joseki-result__reason">
              最善手 {resultInfo.bestMove} に対し、あなたの手 {squareToNotation(resultInfo.playedSquare)} は
              ロス{resultInfo.lossDiscs.toFixed(1)}石でした。
            </p>
          )}
          <p class="joseki-result__moves">手順: {formatSquares(resultInfo.moveHistory)}</p>
          <button type="button" onClick={backToColorSelect}>
            もう一度
          </button>
        </section>
      )}
    </div>
  )
}

import { useEffect, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { BoardEditor, type BoardEditorResult } from '../components/BoardEditor.tsx'
import { EvalBadge, formatDiscDiff } from '../components/EvalBadge.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import {
  applyMove,
  countDiscs,
  initialBoard,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { loadJosekiDb } from '../joseki/lookup.ts'
import type { JosekiDb } from '../joseki/types.ts'
import { analyzeGame, replayGame, TranscriptReplayError, type StartPosition } from './analyzeGame.ts'
import { BlunderPanel } from './BlunderPanel.tsx'
import { clearAnalysisCache } from './cache.ts'
import { EvalGraph, type EvalGraphMarker, type EvalGraphPoint, type EvalGraphPointMove } from './EvalGraph.tsx'
import { parseTranscript, TranscriptParseError } from './parseTranscript.ts'
import { loadClassifyThresholds, saveClassifyThresholds } from './thresholdSettings.ts'
import type { AnalyzeGameProgress, ClassifyThresholds, MoveAnalysis, MoveClassification } from './types.ts'
import './AnalysisMode.css'

type Phase = 'input' | 'analyzing' | 'result'
type InputTab = 'transcript' | 'manual' | 'custom'

interface BoardTrackEntry {
  readonly board: BoardState
  readonly side: Side
  readonly lastMove: number | null
}

const CLASSIFICATION_LABEL: Record<MoveClassification, string> = {
  best: '◎',
  inaccuracy: '?!',
  dubious: '?',
  blunder: '??',
}

const CLASSIFICATION_TEXT: Record<MoveClassification, string> = {
  best: '最善/準最善',
  inaccuracy: '緩手',
  dubious: '疑問手',
  blunder: '悪手',
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

/**
 * ムーブリストの「評価」列に表示する値(T056)。`analyzeGame`が計算した
 * 累積評価値(`blackAdvantageAfter`、黒視点)を、その手を打った側(`side`)
 * から見た石差に変換する(`EvalBadge`の`discDiff`は手番視点の規約のため)。
 * 局面ごとに独立した探索の生値(`playedDiscDiff`)ではなく累積値を使うことで、
 * 最善手を打った手では表示が変化しないようにする。
 */
function movelistEvalDiscDiff(m: MoveAnalysis): number {
  return m.side === 'black' ? m.blackAdvantageAfter : -m.blackAdvantageAfter
}

/** `EvalGraphPoint.move`(T063、ツールチップ用)を1手ぶんの解析結果から作る。 */
function graphPointMove(m: MoveAnalysis): EvalGraphPointMove {
  return {
    side: m.side,
    notation: m.move,
    lossDiscs: m.lossDiscs,
    classification: m.classification,
    reversal: m.reversal,
  }
}

/**
 * `MoveAnalysis[]`(要件3〜5)から評価グラフ用の点列を作る(要件6)。
 *
 * T056: `blackAdvantageBefore`/`blackAdvantageAfter`は`analyzeGame`が
 * 先頭から`lossDiscs`を積み上げて計算する累積評価値(黒視点)であり、
 * 局面ごとに独立した探索の生値ではない。最善手が続く区間はそのまま平ら
 * (値が変化しない)になる。
 *
 * T046: 定石内の手(`evalSource === 'joseki'`)は上記累積評価値としては
 * 常に変化しない(定石内はロス0のため)が、念のため`value`を明示的に
 * 0(互角)へ固定しておく(定石区間に入る前に既に非0の累積値へ動いていた
 * 場合でも、定石区間の帯は常にフラット表示にするための防御)。
 *
 * T063: `ply`(>0)の点には、その局面に至る直前の着手(`results[ply - 1]`)の
 * 情報を`move`として付与する(グラフのカーソル追従ツールチップ用)。
 * `ply === 0`(初期局面)には対応する着手が無いため`move`は付与しない。
 */
function buildGraphPoints(results: readonly MoveAnalysis[]): EvalGraphPoint[] {
  if (results.length === 0) return []
  const valueFor = (m: MoveAnalysis, raw: number) => (m.evalSource === 'joseki' ? 0 : raw)
  const points: EvalGraphPoint[] = [
    {
      ply: 0,
      value: valueFor(results[0]!, results[0]!.blackAdvantageBefore),
      isExact: results[0]!.isExact,
      evalSource: results[0]!.evalSource,
    },
  ]
  for (let i = 1; i < results.length; i++) {
    points.push({
      ply: i,
      value: valueFor(results[i]!, results[i]!.blackAdvantageBefore),
      isExact: results[i]!.isExact,
      evalSource: results[i]!.evalSource,
      move: graphPointMove(results[i - 1]!),
    })
  }
  const last = results[results.length - 1]!
  points.push({
    ply: results.length,
    value: valueFor(last, last.blackAdvantageAfter),
    isExact: last.isExact,
    evalSource: last.evalSource,
    move: graphPointMove(last),
  })
  return points
}

/** 悪手マーカー(要件6): 分類が◎以外、または逆転が起きた手をグラフ上のx位置(手の直後)にマークする。 */
function buildGraphMarkers(results: readonly MoveAnalysis[]): EvalGraphMarker[] {
  return results.filter(isBlunderMarker).map((m) => ({ ply: m.ply + 1, classification: m.classification, reversal: m.reversal }))
}

/** T030の悪手分析パネルを開ける対象か(分類が◎以外、または逆転が起きた手)。 */
function isBlunderMarker(m: MoveAnalysis): boolean {
  return m.classification !== 'best' || m.reversal
}

/** 各局面(ply 0〜moves.length)の盤面・手番・直前手を作る(盤面ジャンプ表示用)。 */
function buildBoardTrack(results: readonly MoveAnalysis[]): BoardTrackEntry[] {
  if (results.length === 0) return []
  const track: BoardTrackEntry[] = [{ board: results[0]!.board, side: results[0]!.side, lastMove: null }]
  for (let i = 1; i < results.length; i++) {
    track.push({
      board: results[i]!.board,
      side: results[i]!.side,
      lastMove: notationToSquare(results[i - 1]!.move),
    })
  }
  const last = results[results.length - 1]!
  const lastSquare = notationToSquare(last.move)
  track.push({
    board: applyMove(last.board, last.side, lastSquare),
    side: opposite(last.side),
    lastMove: lastSquare,
  })
  return track
}

/**
 * 棋譜解析モード(T029)。
 *
 * 設計書 `othello-trainer-design.md` §6のうち§6.1「入力」・§6.2「解析パイプライン」・
 * §6.3「評価グラフUI」の実装。悪手分析パネル(比較PV等)はT030のスコープ。
 *
 * 1. 標準トランスクリプトのテキスト入力、盤面クリックによる手動並べ、または
 *    盤面自由配置エディタ(`BoardEditor`、T079)で任意の開始局面を作ってからの
 *    手動並べで棋譜を入力する(要件1・2)。
 * 2. `analyzeGame`(終局側から解析、要件3)で全手を解析し、進捗を表示する。
 * 3. 評価グラフ(`EvalGraph`)・ムーブリストを表示し、クリックで該当局面へ
 *    ジャンプできる(要件6)。
 *
 * レスポンシブ対応: `AnalysisMode.css`で375px幅程度でも崩れないよう
 * `flex-wrap`・縦積みレイアウトを使う。
 *
 * T132: 対局モード(`app.tsx`のPlayMode)の「この対局を棋譜解析で振り返る」
 * ボタンからの受け口として、`initialTranscript`(標準トランスクリプト文字列)を
 * 任意で受け取る。指定された場合、マウント時に「テキストで入力」タブへ
 * プリフィルした上で自動的に解析を開始する(要件2)。呼び出し元(`App`)は
 * このpropを1回きりの遷移トリガーとして扱う想定のため、消費し終えたら
 * `onInitialTranscriptConsumed`を呼んで呼び出し元の保持値をクリアしてもらう
 * (`AnalysisMode`自体が再マウントされるまで同じ値で再度自動解析が走らないように
 * するための呼び出し元との取り決め。詳細は`app.tsx`の`pendingReviewTranscript`
 * 参照)。
 */
export interface AnalysisModeProps {
  readonly initialTranscript?: string | null
  readonly onInitialTranscriptConsumed?: () => void
}

export function AnalysisMode({ initialTranscript, onInitialTranscriptConsumed }: AnalysisModeProps = {}) {
  const [phase, setPhase] = useState<Phase>('input')
  const [inputTab, setInputTab] = useState<InputTab>('transcript')
  const [transcriptText, setTranscriptText] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const [manualMoves, setManualMoves] = useState<string[]>([])

  // T079: 「盤面を自由配置」タブ。`BoardEditor`(T077で新設)で任意の開始局面
  // (石の配置・手番)を組み立て(`customEditorBoard`/`customEditorSideToMove`)、
  // 「この局面から開始」で確定させると`customStart`が確定し、以後は「盤面で並べる」
  // タブと同じ要領で合法手クリックにより着手を積み上げる(`customMoves`)。
  const [customEditorBoard, setCustomEditorBoard] = useState<BoardState>(() => initialBoard())
  const [customEditorSideToMove, setCustomEditorSideToMove] = useState<Side>('black')
  const [customStart, setCustomStart] = useState<StartPosition | null>(null)
  const [customMoves, setCustomMoves] = useState<string[]>([])

  const [thresholds, setThresholds] = useState<ClassifyThresholds>(() =>
    loadClassifyThresholds(window.localStorage),
  )

  const [progress, setProgress] = useState<AnalyzeGameProgress | null>(null)
  const [results, setResults] = useState<MoveAnalysis[] | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selectedPly, setSelectedPly] = useState(0)

  /** T030: 悪手分析パネルを開いている対象の`ply`(未オープンなら`null`)。 */
  const [openBlunderPly, setOpenBlunderPly] = useState<number | null>(null)

  // T038: 定石DBを読み込んでおき、`analyzeGame`に渡す(定石内の手の悪手誤判定除外)。
  // ロードに失敗しても`josekiDb`は`null`のままとなり、`analyzeGame`側が
  // フォールバック(定石照会スキップ、従来通りの評価)する(要件3)。
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)

  // T060: 解析結果キャッシュ(IndexedDB)の手動クリアボタンの状態。
  // 「デプロイしても古いキャッシュが返ってくる」というユーザー報告への対応として、
  // `cache.ts`側でエンジンバージョンによる自動無効化(要件1)も実装済みだが、
  // ユーザーがいつでも確実にクリアできる手段も用意する(要件2)。
  const [cacheClearStatus, setCacheClearStatus] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')

  async function handleClearCache(): Promise<void> {
    setCacheClearStatus('clearing')
    try {
      await clearAnalysisCache()
      setCacheClearStatus('done')
    } catch (error) {
      console.error('解析キャッシュのクリアに失敗しました', error)
      setCacheClearStatus('error')
    }
  }

  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  useEffect(() => {
    let cancelled = false
    loadJosekiDb()
      .then((db) => {
        if (!cancelled) setJosekiDb(db)
      })
      .catch((error: unknown) => {
        console.error('定石DBの読み込みに失敗しました(定石内の手の判定なしで解析を続行します)', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function updateThresholds(partial: Partial<ClassifyThresholds>): void {
    const next = { ...thresholds, ...partial }
    setThresholds(next)
    saveClassifyThresholds(window.localStorage, next)
  }

  const manualReplay = (() => {
    try {
      return { positions: replayGame(manualMoves), error: null as string | null }
    } catch (error) {
      return { positions: null, error: error instanceof Error ? error.message : String(error) }
    }
  })()

  // T079: 「盤面を自由配置」タブ。開始局面が未確定(`customStart === null`)の間は
  // 再生不要のため`null`のまま(エディタ操作中はまだ着手を積み上げられない)。
  const customReplay = (() => {
    if (!customStart) return { positions: null, error: null as string | null }
    try {
      return { positions: replayGame(customMoves, customStart), error: null as string | null }
    } catch (error) {
      return { positions: null, error: error instanceof Error ? error.message : String(error) }
    }
  })()

  async function startAnalysis(moves: readonly string[], start?: StartPosition): Promise<void> {
    setInputError(null)
    setPhase('analyzing')
    setProgress({ done: 0, total: moves.length, justAnalyzedPly: moves.length - 1 })
    const startedAt = performance.now()
    try {
      const analyzed = await analyzeGame(getEngine(), moves, {
        thresholds,
        onProgress: setProgress,
        josekiDb,
        start,
      })
      setElapsedMs(performance.now() - startedAt)
      setResults(analyzed)
      setSelectedPly(analyzed.length)
      setPhase('result')
    } catch (error) {
      console.error('棋譜解析に失敗しました', error)
      const message =
        error instanceof TranscriptReplayError || error instanceof TranscriptParseError
          ? error.message
          : '棋譜の解析に失敗しました。もう一度お試しください。'
      setInputError(message)
      setPhase('input')
    }
  }

  function handleTranscriptSubmit(): void {
    try {
      const moves = parseTranscript(transcriptText)
      void startAnalysis(moves)
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error))
    }
  }

  // T132: 対局モードからの「この対局を振り返る」導線。`initialTranscript`が
  // 渡された場合、「テキストで入力」タブへプリフィルした上で自動的に解析を
  // 開始する(`handleTranscriptSubmit`と同じ経路)。依存配列を`[initialTranscript]`
  // のみにしているのは、`initialTranscript`が新しい値になった時だけ発火させる
  // ためで、`onInitialTranscriptConsumed`(呼び出し元が毎レンダー新しい関数を
  // 渡しうる)を含めると意図せず再発火してしまう。
  useEffect(() => {
    if (!initialTranscript) return
    setTranscriptText(initialTranscript)
    setInputTab('transcript')
    try {
      const moves = parseTranscript(initialTranscript)
      void startAnalysis(moves)
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error))
    }
    onInitialTranscriptConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTranscript])

  function handleManualMove(square: number): void {
    if (!manualReplay.positions) return
    const cur = manualReplay.positions[manualReplay.positions.length - 1]!
    if (cur.mover === null) return
    setManualMoves((prev) => [...prev, squareToNotation(square)])
  }

  function undoManualMove(): void {
    setManualMoves((prev) => prev.slice(0, -1))
  }

  function resetManualMoves(): void {
    setManualMoves([])
  }

  /** T079: 「盤面を自由配置」タブのエディタ操作(マスクリック・手番選択・リセット)。 */
  function handleCustomEditorChange(next: BoardEditorResult): void {
    setCustomEditorBoard(next.board)
    setCustomEditorSideToMove(next.sideToMove)
  }

  /** T079: エディタで組み立てた局面を開始局面として確定し、着手の積み上げに移る。 */
  function confirmCustomStart(): void {
    setCustomStart({ board: customEditorBoard, sideToMove: customEditorSideToMove })
    setCustomMoves([])
  }

  /** T079: 開始局面の編集に戻る(積み上げた着手は破棄する)。 */
  function editCustomStart(): void {
    setCustomStart(null)
    setCustomMoves([])
  }

  function handleCustomMove(square: number): void {
    if (!customReplay.positions) return
    const cur = customReplay.positions[customReplay.positions.length - 1]!
    if (cur.mover === null) return
    setCustomMoves((prev) => [...prev, squareToNotation(square)])
  }

  function undoCustomMove(): void {
    setCustomMoves((prev) => prev.slice(0, -1))
  }

  function resetCustomMoves(): void {
    setCustomMoves([])
  }

  function backToInput(): void {
    setPhase('input')
    setResults(null)
    setProgress(null)
    setElapsedMs(null)
    setSelectedPly(0)
  }

  const graphPoints = results ? buildGraphPoints(results) : []
  const graphMarkers = results ? buildGraphMarkers(results) : []
  const boardTrack = results ? buildBoardTrack(results) : []
  const currentBoard = boardTrack[selectedPly] ?? null

  const manualBoard = manualReplay.positions?.[manualReplay.positions.length - 1] ?? null
  const customBoard = customReplay.positions?.[customReplay.positions.length - 1] ?? null

  return (
    <div class="analysis-mode">
      {phase === 'input' && (
        <section class="analysis-input">
          <p>棋譜解析: 対局の棋譜を入力してください</p>

          <nav class="analysis-input__tabs" aria-label="入力方法">
            <button
              type="button"
              class={`analysis-input__tab${inputTab === 'transcript' ? ' analysis-input__tab--active' : ''}`}
              onClick={() => setInputTab('transcript')}
            >
              テキストで入力
            </button>
            <button
              type="button"
              class={`analysis-input__tab${inputTab === 'manual' ? ' analysis-input__tab--active' : ''}`}
              onClick={() => setInputTab('manual')}
            >
              盤面で並べる
            </button>
            <button
              type="button"
              class={`analysis-input__tab${inputTab === 'custom' ? ' analysis-input__tab--active' : ''}`}
              onClick={() => setInputTab('custom')}
            >
              盤面を自由配置
            </button>
          </nav>

          {inputTab === 'transcript' && (
            <div class="analysis-input__transcript">
              <textarea
                class="analysis-input__textarea"
                placeholder="例: f5d6c3d3c4 または F5 D6, C3; D3-C4"
                value={transcriptText}
                onInput={(event) => setTranscriptText((event.target as HTMLTextAreaElement).value)}
                rows={4}
              />
              <button type="button" onClick={handleTranscriptSubmit} disabled={transcriptText.trim().length === 0}>
                解析開始
              </button>
            </div>
          )}

          {inputTab === 'manual' && (
            <div class="analysis-input__manual">
              {manualBoard && (
                <>
                  <p class="status">
                    手番: {manualBoard.mover ? sideLabel(manualBoard.mover) : '終局'}({manualMoves.length}手)
                  </p>
                  <div class="board-container">
                    <Board
                      board={manualBoard.board}
                      sideToMove={manualBoard.mover ?? 'black'}
                      onMove={handleManualMove}
                    />
                  </div>
                </>
              )}
              <div class="analysis-input__manual-buttons">
                <button type="button" onClick={undoManualMove} disabled={manualMoves.length === 0}>
                  1手戻す
                </button>
                <button type="button" onClick={resetManualMoves} disabled={manualMoves.length === 0}>
                  リセット
                </button>
                <button
                  type="button"
                  onClick={() => void startAnalysis(manualMoves)}
                  disabled={manualMoves.length === 0}
                >
                  解析開始
                </button>
              </div>
            </div>
          )}

          {inputTab === 'custom' && (
            <div class="analysis-input__custom">
              {!customStart ? (
                <>
                  <p class="status">開始局面を自由に配置し、次の手番を選んでから「この局面から開始」を押してください。</p>
                  <BoardEditor
                    board={customEditorBoard}
                    sideToMove={customEditorSideToMove}
                    onChange={handleCustomEditorChange}
                  />
                  <div class="analysis-input__custom-buttons">
                    <button type="button" onClick={confirmCustomStart}>
                      この局面から開始
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {customBoard && (
                    <>
                      <p class="status">
                        手番: {customBoard.mover ? sideLabel(customBoard.mover) : '終局'}({customMoves.length}手)
                      </p>
                      <div class="board-container">
                        <Board
                          board={customBoard.board}
                          sideToMove={customBoard.mover ?? 'black'}
                          onMove={handleCustomMove}
                        />
                      </div>
                    </>
                  )}
                  <div class="analysis-input__custom-buttons">
                    <button type="button" onClick={undoCustomMove} disabled={customMoves.length === 0}>
                      1手戻す
                    </button>
                    <button type="button" onClick={resetCustomMoves} disabled={customMoves.length === 0}>
                      リセット
                    </button>
                    <button type="button" onClick={editCustomStart}>
                      開始局面を編集し直す
                    </button>
                    <button
                      type="button"
                      onClick={() => void startAnalysis(customMoves, customStart)}
                      disabled={customMoves.length === 0}
                    >
                      解析開始
                    </button>
                  </div>
                </>
              )}
              {customReplay.error && <p class="notice notice--error">{customReplay.error}</p>}
            </div>
          )}

          {inputError && <p class="notice notice--error">{inputError}</p>}

          <fieldset class="analysis-settings">
            <legend>悪手判定の閾値(石差)</legend>
            <label class="analysis-settings__threshold">
              緩手(?!)
              <input
                type="number"
                step="0.1"
                min="0"
                value={thresholds.inaccuracy}
                onInput={(event) => {
                  const raw = Number((event.target as HTMLInputElement).value)
                  if (Number.isFinite(raw)) updateThresholds({ inaccuracy: raw })
                }}
              />
            </label>
            <label class="analysis-settings__threshold">
              疑問手(?)
              <input
                type="number"
                step="0.1"
                min="0"
                value={thresholds.dubious}
                onInput={(event) => {
                  const raw = Number((event.target as HTMLInputElement).value)
                  if (Number.isFinite(raw)) updateThresholds({ dubious: raw })
                }}
              />
            </label>
            <label class="analysis-settings__threshold">
              悪手(??)
              <input
                type="number"
                step="0.1"
                min="0"
                value={thresholds.blunder}
                onInput={(event) => {
                  const raw = Number((event.target as HTMLInputElement).value)
                  if (Number.isFinite(raw)) updateThresholds({ blunder: raw })
                }}
              />
            </label>
          </fieldset>

          <div class="analysis-cache-clear">
            <button
              type="button"
              onClick={() => void handleClearCache()}
              disabled={cacheClearStatus === 'clearing'}
            >
              解析キャッシュをクリア
            </button>
            <p class="analysis-cache-clear__hint">
              エンジンの更新後も評価結果が変わらない場合など、キャッシュされた解析結果をすべて削除して次回から再解析させます。
            </p>
            {cacheClearStatus === 'done' && (
              <p class="analysis-cache-clear__success">解析キャッシュをクリアしました。</p>
            )}
            {cacheClearStatus === 'error' && (
              <p class="notice notice--error">解析キャッシュのクリアに失敗しました。もう一度お試しください。</p>
            )}
          </div>
        </section>
      )}

      {phase === 'analyzing' && (
        <section class="analysis-progress">
          <p>解析中... {progress ? `${progress.done}/${progress.total}手` : ''}</p>
          {progress && (
            <>
              <progress class="analysis-progress__bar" value={progress.done} max={progress.total} />
              <p class="analysis-progress__detail">
                終局側から解析しています(現在: {progress.justAnalyzedPly + 1}手目を解析完了)
              </p>
            </>
          )}
        </section>
      )}

      {phase === 'result' && results && (
        <section class="analysis-result">
          <div class="analysis-result__header">
            <p>
              解析完了: {results.length}手
              {elapsedMs !== null && `(解析時間: ${(elapsedMs / 1000).toFixed(2)}秒)`}
            </p>
            <button type="button" onClick={backToInput}>
              別の棋譜を解析する
            </button>
          </div>

          <EvalGraph
            points={graphPoints}
            markers={graphMarkers}
            currentPly={selectedPly}
            onSelectPly={setSelectedPly}
            onMarkerClick={(ply) => {
              setSelectedPly(ply)
              const m = results[ply - 1]
              if (m && isBlunderMarker(m)) setOpenBlunderPly(m.ply)
            }}
          />

          {currentBoard && (
            <div class="analysis-result__board-area">
              <div class="board-container analysis-result__board">
                <Board board={currentBoard.board} sideToMove={currentBoard.side} lastMove={currentBoard.lastMove} />
              </div>
              <p class="status">
                {selectedPly}手目時点 / 黒
                {countDiscs(currentBoard.board, 'black')}
                ・白
                {countDiscs(currentBoard.board, 'white')}
              </p>
            </div>
          )}

          <div class="analysis-result__movelist-wrap">
            <table class="analysis-result__movelist">
              <caption>ムーブリスト(クリックでその局面へジャンプ)</caption>
              <thead>
                <tr>
                  <th>手数</th>
                  <th>手番</th>
                  <th>着手</th>
                  <th>評価</th>
                  <th>ロス</th>
                  <th>分類</th>
                </tr>
              </thead>
              <tbody>
                {results.map((m) => (
                  <tr
                    key={m.ply}
                    class={`analysis-result__movelist-row${
                      m.ply + 1 === selectedPly ? ' analysis-result__movelist-row--current' : ''
                    }${m.reversal ? ' analysis-result__movelist-row--reversal' : ''}`}
                    onClick={() => setSelectedPly(m.ply + 1)}
                  >
                    <td>{m.ply + 1}</td>
                    <td>{sideLabel(m.side)}</td>
                    <td>{m.move}</td>
                    <td>
                      <EvalBadge discDiff={movelistEvalDiscDiff(m)} source={m.evalSource} />
                    </td>
                    <td>{m.lossDiscs > 0 ? formatDiscDiff(-m.lossDiscs) : '±0'}</td>
                    <td>
                      {isBlunderMarker(m) ? (
                        <button
                          type="button"
                          class="analysis-result__movelist-blunder-button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setOpenBlunderPly(m.ply)
                          }}
                        >
                          {CLASSIFICATION_LABEL[m.classification]}
                          {m.classification !== 'best' && ` ${CLASSIFICATION_TEXT[m.classification]}`}
                          {m.reversal && ' (逆転)'}
                        </button>
                      ) : (
                        CLASSIFICATION_LABEL[m.classification]
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {openBlunderPly !== null && results[openBlunderPly] && (
            <BlunderPanel
              key={openBlunderPly}
              moveAnalysis={results[openBlunderPly]!}
              gameMoves={results.map((m) => m.move)}
              engine={getEngine()}
              onClose={() => setOpenBlunderPly(null)}
            />
          )}
        </section>
      )}
    </div>
  )
}

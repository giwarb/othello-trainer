import { useEffect, useRef, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { EvalBadge, formatDiscDiff } from '../components/EvalBadge.tsx'
import { EngineClient } from '../engine/client.ts'
import {
  applyMove,
  countDiscs,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { analyzeGame, replayGame, TranscriptReplayError } from './analyzeGame.ts'
import { BlunderPanel } from './BlunderPanel.tsx'
import { EvalGraph, type EvalGraphMarker, type EvalGraphPoint } from './EvalGraph.tsx'
import { parseTranscript, TranscriptParseError } from './parseTranscript.ts'
import { loadClassifyThresholds, saveClassifyThresholds } from './thresholdSettings.ts'
import type { AnalyzeGameProgress, ClassifyThresholds, MoveAnalysis, MoveClassification } from './types.ts'
import { buildGameSummaryInput } from '../llm/buildStructuredInput.ts'
import { CommentaryView } from '../llm/CommentaryView.tsx'
import { buildGameSummaryUserMessage, GAME_SUMMARY_SYSTEM_PROMPT } from '../llm/prompt.ts'
import { LlmSettings } from '../llm/LlmSettings.tsx'
import './AnalysisMode.css'

type Phase = 'input' | 'analyzing' | 'result'
type InputTab = 'transcript' | 'manual'

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

/** `MoveAnalysis[]`(要件3〜5)から評価グラフ用の点列を作る(要件6)。 */
function buildGraphPoints(results: readonly MoveAnalysis[]): EvalGraphPoint[] {
  if (results.length === 0) return []
  const points: EvalGraphPoint[] = [
    { ply: 0, value: results[0]!.blackAdvantageBefore, isExact: results[0]!.isExact },
  ]
  for (let i = 1; i < results.length; i++) {
    points.push({ ply: i, value: results[i]!.blackAdvantageBefore, isExact: results[i]!.isExact })
  }
  const last = results[results.length - 1]!
  points.push({ ply: results.length, value: last.blackAdvantageAfter, isExact: last.isExact })
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
 * 1. 標準トランスクリプトのテキスト入力、または盤面クリックによる手動並べで
 *    棋譜を入力する(要件1・2)。
 * 2. `analyzeGame`(終局側から解析、要件3)で全手を解析し、進捗を表示する。
 * 3. 評価グラフ(`EvalGraph`)・ムーブリストを表示し、クリックで該当局面へ
 *    ジャンプできる(要件6)。
 *
 * レスポンシブ対応: `AnalysisMode.css`で375px幅程度でも崩れないよう
 * `flex-wrap`・縦積みレイアウトを使う。
 */
export function AnalysisMode() {
  const [phase, setPhase] = useState<Phase>('input')
  const [inputTab, setInputTab] = useState<InputTab>('transcript')
  const [transcriptText, setTranscriptText] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const [manualMoves, setManualMoves] = useState<string[]>([])

  const [thresholds, setThresholds] = useState<ClassifyThresholds>(() =>
    loadClassifyThresholds(window.localStorage),
  )

  const [progress, setProgress] = useState<AnalyzeGameProgress | null>(null)
  const [results, setResults] = useState<MoveAnalysis[] | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selectedPly, setSelectedPly] = useState(0)

  /** T030: 悪手分析パネルを開いている対象の`ply`(未オープンなら`null`)。 */
  const [openBlunderPly, setOpenBlunderPly] = useState<number | null>(null)

  const engineRef = useRef<EngineClient | null>(null)

  function getEngine(): EngineClient {
    if (!engineRef.current) {
      engineRef.current = new EngineClient()
    }
    return engineRef.current
  }

  useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      engineRef.current = null
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

  async function startAnalysis(moves: readonly string[]): Promise<void> {
    setInputError(null)
    setPhase('analyzing')
    setProgress({ done: 0, total: moves.length, justAnalyzedPly: moves.length - 1 })
    const startedAt = performance.now()
    try {
      const analyzed = await analyzeGame(getEngine(), moves, {
        thresholds,
        onProgress: setProgress,
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

          <LlmSettings />
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

          <section class="analysis-result__game-summary">
            <h3>AI感想戦(任意)</h3>
            <CommentaryView
              buttonLabel="AI感想戦を生成"
              systemPrompt={GAME_SUMMARY_SYSTEM_PROMPT}
              userMessage={buildGameSummaryUserMessage(buildGameSummaryInput(results))}
            />
          </section>

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
                      <EvalBadge discDiff={m.playedDiscDiff} source={m.isExact ? 'exact' : 'midgame'} />
                    </td>
                    <td>{m.lossDiscs > 0 ? formatDiscDiff(-m.lossDiscs) : '±0.0'}</td>
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

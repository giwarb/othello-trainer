import { useEffect, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { EvalBadge, formatDiscDiff } from '../components/EvalBadge.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import type { EngineClient } from '../engine/client.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  hasLegalMove,
  isTerminal,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { loadMoveEvalOverlayEnabled, saveMoveEvalOverlayEnabled } from '../settings/moveEvalOverlaySettings.ts'
import { judgePuzzleMove } from '../tsume/judgePuzzleMove.ts'
import type { Puzzle } from '../tsume/types.ts'
import { ANALYZE_LIMIT } from './analyzeGame.ts'
import { AttributionWaterfall } from './AttributionWaterfall.tsx'
import { buildAttribution, replayContinuationSteps } from './attribution.ts'
import { BoardOverlay, type OverlayVisibility } from './BoardOverlay.tsx'
import './BoardOverlay.css'
import {
  addBranchMove,
  createBranchTree,
  currentMover,
  currentNode,
  goToNode,
  goToRoot,
  setNodeEval,
  type BranchTree,
} from './branchTree.ts'
import { buildComparePv, type ComparePvResult } from './comparePv.ts'
import { computeBoardHighlights, detectMotifs, type BoardHighlights, type MotifDefinition } from './motifs.ts'
import { buildRefutationResult, type RefutationResult } from './refutation.ts'
import { RefutationView } from './RefutationView.tsx'
import { buildInstantTsumePuzzle, sendToMidgamePractice } from './sendToPractice.ts'
import { loadClassifyThresholds } from './thresholdSettings.ts'
import type { AttributionBreakdown, ClassifyThresholds, EvalTerms, FeatureSet, MoveAnalysis } from './types.ts'
import { analyzeWhyBad, computeStableSquares } from './whyBad.ts'
import { GlossaryPopover } from '../verbalize/GlossaryPopover.tsx'
import './BlunderPanel.css'

const MOTIF_KIND_LABEL: Record<MotifDefinition['kind'], string> = {
  good: '良い手',
  bad: '悪い手',
  trap: '罠',
}

const OVERLAY_TOGGLES: readonly { key: keyof OverlayVisibility; label: string }[] = [
  { key: 'frontier', label: 'フロンティア石' },
  { key: 'stable', label: '確定石' },
  { key: 'seed', label: '種石' },
  { key: 'dangerousCorners', label: '危険なX/C打ちマス' },
]

/** 相手(エンジン)の着手までの見せかけの「考慮時間」(ミリ秒、他モードと同じ演出)。 */
const OPPONENT_MOVE_DELAY_MS = 300

export interface BlunderPanelProps {
  /** 分析対象の悪手(T029の`analyzeGame`が返した1手ぶんの解析結果)。 */
  readonly moveAnalysis: MoveAnalysis
  /** 対局全体の着手列(比較PVの「本譜の以後の進行」に使う)。 */
  readonly gameMoves: readonly string[]
  readonly engine: EngineClient
  readonly onClose: () => void
}

interface TsumeSession {
  readonly board: BoardState
  readonly sideToMove: Side
  readonly humanSide: Side
  /** 出題時点の空きマス数。完全読みの閾値(`exactFromEmpties`)に使い続ける(`tsume/PlayMode.tsx`と同じ方針)。 */
  readonly puzzleEmpties: number
  readonly lastMove: number | null
}

type TsumePhase = 'idle' | 'checking' | 'rejected' | 'playing' | 'solved' | 'failed'

function tsumeLimit(session: TsumeSession): AnalyzeLimit {
  return { depth: session.puzzleEmpties, exactFromEmpties: session.puzzleEmpties }
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

/** 分岐ツリーを再帰的に描画する(要件2)。 */
function BranchTreeView({
  tree,
  nodeId,
  onSelect,
}: {
  readonly tree: BranchTree
  readonly nodeId: string
  readonly onSelect: (nodeId: string) => void
}) {
  const node = tree.nodes[nodeId]
  if (!node) return null
  const isCurrent = tree.currentId === nodeId
  return (
    <li>
      <button
        type="button"
        class={`blunder-panel__branch-node${isCurrent ? ' blunder-panel__branch-node--current' : ''}`}
        onClick={() => onSelect(nodeId)}
      >
        <span>{node.moveFromParent ?? '(局面)'}</span>
        {node.evalDiscDiff !== undefined && (
          <EvalBadge discDiff={node.evalDiscDiff} source={node.evalType === 'exact' ? 'exact' : 'midgame'} />
        )}
      </button>
      {node.childIds.length > 0 && (
        <ul class="blunder-panel__branch-children">
          {node.childIds.map((childId) => (
            <BranchTreeView key={childId} tree={tree} nodeId={childId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * 悪手分析パネル(T030、設計書§6.4)。
 *
 * T029の棋譜解析モードで悪手マーカーをタップすると開く。以下4つを1画面にまとめる:
 * 1. 比較PV(`comparePv.ts`): 実際の進行 vs 最善進行を並走表示。
 * 2. フリー分岐探索(`branchTree.ts`): 悪手局面から任意の変化を試し、都度即時評価を表示する。
 * 3. ヒューリスティック理由表示(`whyBad.ts`): 着手可能数・確定石数・X打ち/C打ちを機械的に注記。
 * 4. 練習送り(`sendToPractice.ts`): 中盤練習の出題プール登録、詰めオセロ即席判定+その場でのプレイ。
 *
 * レスポンシブ対応: 375px幅でも崩れないよう`BlunderPanel.css`でセクションを
 * 縦積みにし、分岐ツリーは横スクロール可能なコンテナに収める。
 */
export function BlunderPanel({ moveAnalysis, gameMoves, engine, onClose }: BlunderPanelProps) {
  const whyBad = analyzeWhyBad(moveAnalysis.board, moveAnalysis.side, notationToSquare(moveAnalysis.move))

  // --- モチーフ検出タグ + 盤面オーバーレイ(T032) -----------------------------
  // T031の特徴量層(`engine/src/explain.rs`の`featureSet`コマンド)を取得し、
  // `motifs.ts`のモチーフ検出+盤面オーバーレイ用マス集合の算出に使う。
  const [featureSet, setFeatureSet] = useState<FeatureSet | null>(null)
  const [featureSetError, setFeatureSetError] = useState<string | null>(null)
  const [overlayVisible, setOverlayVisible] = useState<OverlayVisibility>({
    frontier: false,
    stable: false,
    seed: false,
    dangerousCorners: false,
  })
  /** T036要件2: モチーフバッジから用語集詳細への1タップ導線。 */
  const [glossaryPopoverTagId, setGlossaryPopoverTagId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFeatureSet(null)
    setFeatureSetError(null)

    engine
      .requestFeatureSet(moveAnalysis.board, moveAnalysis.side, moveAnalysis.move)
      .then((resp) => {
        if (!cancelled) setFeatureSet(resp.features)
      })
      .catch((error: unknown) => {
        console.error('特徴量の取得に失敗しました', error)
        if (!cancelled) setFeatureSetError('モチーフ検出用の特徴量取得に失敗しました。')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [])

  const motifContext = featureSet
    ? {
        beforeBoard: moveAnalysis.board,
        side: moveAnalysis.side,
        square: notationToSquare(moveAnalysis.move),
        features: featureSet,
      }
    : null
  const motifs: MotifDefinition[] = motifContext ? detectMotifs(motifContext) : []
  const boardHighlights: BoardHighlights | null = motifContext
    ? computeBoardHighlights(motifContext, computeStableSquares)
    : null

  // --- 比較PV(要件1) -----------------------------------------------------
  const [comparePv, setComparePv] = useState<ComparePvResult | null>(null)
  const [comparePvLoading, setComparePvLoading] = useState(true)
  const [comparePvError, setComparePvError] = useState<string | null>(null)

  // --- 評価内訳分解(要件4、T031) -------------------------------------------
  // 比較PVの末端局面(実際の進行の末端 vs 最善進行の末端)間の評価差を、
  // 現行評価関数の3項(モビリティ・隅・確定石)に分解して表示する。
  const [attribution, setAttribution] = useState<AttributionBreakdown | null>(null)
  const [attributionError, setAttributionError] = useState<string | null>(null)

  // --- 反証層(要件1〜4、T033) ----------------------------------------------
  // 比較PVの各手ごとの評価内訳分解(T031の`buildAttribution`をPV中間局面にも
  // 適用したもの)から、寄与が急変した手(回収点)を検出する(`refutation.ts`)。
  const [refutation, setRefutation] = useState<RefutationResult | null>(null)
  const [refutationError, setRefutationError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setComparePvLoading(true)
    setComparePvError(null)

    async function run(): Promise<void> {
      try {
        const bestSquare = notationToSquare(moveAnalysis.bestMove)
        const afterBestBoard = applyMove(moveAnalysis.board, moveAnalysis.side, bestSquare)
        const bestMover = resolveMover(afterBestBoard, opposite(moveAnalysis.side))
        let bestPv: string[] = []
        if (bestMover !== null) {
          const resp = await engine.requestAnalyze(afterBestBoard, bestMover, ANALYZE_LIMIT)
          bestPv = resp.pv
        }
        if (cancelled) return
        const pvResult = buildComparePv(gameMoves, moveAnalysis.ply, moveAnalysis.bestMove, bestPv)
        setComparePv(pvResult)

        // 比較PVの各手ごとの局面(開始局面含む)を複製し、それぞれの評価内訳
        // (`EvalTerms`)を取得する(要件5: PV中間局面でも分解する。T033はさらに
        // 隣接局面同士の差分から回収点を検出する)。末端同士の比較(`attribution`、
        // 既存のT031表示)は、この系列の最後の要素から導出することで、
        // 同じ局面に対するエンジン呼び出しの重複を避ける。
        try {
          const playedBoards = replayContinuationSteps(
            moveAnalysis.board,
            moveAnalysis.side,
            pvResult.playedContinuation,
          )
          const bestBoards = replayContinuationSteps(moveAnalysis.board, moveAnalysis.side, pvResult.bestContinuation)
          const fetchTermsSequence = (boards: readonly BoardState[]): Promise<EvalTerms[]> =>
            Promise.all(boards.map((board) => engine.requestEvalTerms(board, moveAnalysis.side)))
          const [playedTermsSequence, bestTermsSequence] = await Promise.all([
            fetchTermsSequence(playedBoards),
            fetchTermsSequence(bestBoards),
          ])
          if (cancelled) return

          setAttribution(
            buildAttribution(
              playedTermsSequence[playedTermsSequence.length - 1]!,
              bestTermsSequence[bestTermsSequence.length - 1]!,
              moveAnalysis.side,
            ),
          )
          setRefutation(
            buildRefutationResult(
              moveAnalysis.board,
              moveAnalysis.side,
              pvResult.playedContinuation,
              pvResult.bestContinuation,
              playedTermsSequence,
              bestTermsSequence,
              moveAnalysis.side,
            ),
          )
        } catch (error) {
          console.error('評価内訳分解・反証層の計算に失敗しました', error)
          if (!cancelled) {
            setAttributionError('評価内訳の取得に失敗しました。')
            setRefutationError('回収点の検出に失敗しました。')
          }
        }
      } catch (error) {
        console.error('比較PV取得のための解析に失敗しました', error)
        if (!cancelled) setComparePvError('比較PVの取得に失敗しました。')
      } finally {
        if (!cancelled) setComparePvLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // moveAnalysis/gameMoves/engineはこのパネルインスタンスの生存期間中不変
    // (`AnalysisMode.tsx`側で`key`にplyを使い、別の悪手を選ぶと再マウントされる)。
    // eslint-disable-next-line
  }, [])

  // --- フリー分岐探索(要件2) ----------------------------------------------
  const [branchTree, setBranchTree] = useState<BranchTree>(() =>
    createBranchTree(moveAnalysis.board, moveAnalysis.side),
  )
  const [branchBusy, setBranchBusy] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  // 盤面セル評価オーバーレイ(T039をT042で展開)。フリー分岐探索の現局面(手番側が
  // 存在する場合のみ)の全合法手評価をまとめて取得する。他の悪手分析パネル内の
  // 盤面(着手前局面の表示・詰めオセロ即席判定の盤面)は非対象(タスク仕様のスコープ外)。
  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [branchOverlayMoves, setBranchOverlayMoves] = useState<MoveEvalJson[] | null>(null)

  useEffect(() => {
    const mover = currentMover(branchTree)
    const node = currentNode(branchTree)
    if (!moveEvalOverlayEnabled || mover === null || branchBusy) {
      setBranchOverlayMoves(null)
      return
    }

    let cancelled = false
    engine
      .requestAnalyzeAll(node.board, mover, ANALYZE_LIMIT)
      .then((moves) => {
        if (!cancelled) setBranchOverlayMoves(moves)
      })
      .catch((error: unknown) => {
        console.error('候補手評価オーバーレイの取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [branchTree, moveEvalOverlayEnabled, branchBusy])

  /** オーバーレイ表示ON/OFFを切り替え、`localStorage`へ永続化する(T039・T042、他モードと共有)。 */
  function handleToggleMoveEvalOverlay(enabled: boolean): void {
    setMoveEvalOverlayEnabled(enabled)
    saveMoveEvalOverlayEnabled(localStorage, enabled)
  }

  async function handleBranchMove(square: number): Promise<void> {
    if (branchBusy) return
    const mover = currentMover(branchTree)
    const node = currentNode(branchTree)
    if (mover === null || !legalMoves(node.board, mover).includes(square)) return

    const move = squareToNotation(square)
    let nextTree: BranchTree
    try {
      nextTree = addBranchMove(branchTree, move)
    } catch (error) {
      console.error('分岐の追加に失敗しました', error)
      setBranchError('この手は打てませんでした。')
      return
    }
    setBranchTree(nextTree)
    setBranchError(null)

    const newNodeId = nextTree.currentId
    const nextMover = currentMover(nextTree)
    if (nextMover === null) return

    setBranchBusy(true)
    try {
      const resp = await engine.requestAnalyze(nextTree.nodes[newNodeId]!.board, nextMover, ANALYZE_LIMIT)
      setBranchTree((prev) =>
        prev.nodes[newNodeId] ? setNodeEval(prev, newNodeId, resp.score.discDiff, resp.score.type) : prev,
      )
    } catch (error) {
      console.error('分岐局面の評価取得に失敗しました', error)
    } finally {
      setBranchBusy(false)
    }
  }

  const branchNode = currentNode(branchTree)
  const branchMover = currentMover(branchTree)
  const branchLastMove = branchNode.moveFromParent ? notationToSquare(branchNode.moveFromParent) : null

  // --- 練習送り(要件4) ----------------------------------------------------
  const [sendingToMidgame, setSendingToMidgame] = useState(false)
  const [midgameSentMessage, setMidgameSentMessage] = useState<string | null>(null)

  async function handleSendToMidgame(): Promise<void> {
    setSendingToMidgame(true)
    try {
      await sendToMidgamePractice(moveAnalysis.board, moveAnalysis.side)
      setMidgameSentMessage('中盤練習の出題プールに登録しました。')
    } catch (error) {
      console.error('中盤練習への送りに失敗しました', error)
      setMidgameSentMessage('登録に失敗しました。もう一度お試しください。')
    } finally {
      setSendingToMidgame(false)
    }
  }

  const [tsumePhase, setTsumePhase] = useState<TsumePhase>('idle')
  const [tsumeRejectReason, setTsumeRejectReason] = useState<string | null>(null)
  const [tsumePuzzle, setTsumePuzzle] = useState<Puzzle | null>(null)
  const [tsumeSession, setTsumeSession] = useState<TsumeSession | null>(null)
  const [tsumeResult, setTsumeResult] = useState<{ playedMove: string; bestMove: string | null } | null>(null)
  const [tsumeOpponentThinking, setTsumeOpponentThinking] = useState(false)
  const [tsumeAnalyzing, setTsumeAnalyzing] = useState(false)

  async function startTsumeCheck(): Promise<void> {
    setTsumePhase('checking')
    setTsumeRejectReason(null)
    try {
      const result = await buildInstantTsumePuzzle(engine, moveAnalysis.board, moveAnalysis.side)
      if (!result.accepted) {
        setTsumePhase('rejected')
        setTsumeRejectReason(result.reason)
        return
      }
      setTsumePuzzle(result.puzzle)
      setTsumeSession({
        board: moveAnalysis.board,
        sideToMove: result.puzzle.sideToMove,
        humanSide: result.puzzle.sideToMove,
        puzzleEmpties: result.puzzle.empties,
        lastMove: null,
      })
      setTsumePhase('playing')
    } catch (error) {
      console.error('詰めオセロ即席判定に失敗しました', error)
      setTsumePhase('rejected')
      setTsumeRejectReason('判定中にエラーが発生しました。もう一度お試しください。')
    }
  }

  // 終局・パスの自動処理(`tsume/PlayMode.tsx`と同じ方針)。
  useEffect(() => {
    if (tsumePhase !== 'playing' || !tsumeSession) return
    const s = tsumeSession
    if (isTerminal(s.board)) {
      setTsumePhase('solved')
      return
    }
    if (!hasLegalMove(s.board, s.sideToMove)) {
      setTsumeSession({ ...s, sideToMove: opposite(s.sideToMove) })
    }
    // eslint-disable-next-line
  }, [tsumePhase, tsumeSession])

  // 相手(エンジン)の手番: 「最も粘る手」(相手にとっての最善手)を完全読みで選んで自動着手する。
  useEffect(() => {
    if (tsumePhase !== 'playing' || !tsumeSession) return
    const s = tsumeSession
    if (s.sideToMove === s.humanSide) return
    if (!hasLegalMove(s.board, s.sideToMove)) return

    let cancelled = false
    setTsumeOpponentThinking(true)

    async function run(): Promise<void> {
      try {
        const allMoves = await engine.requestAnalyzeAll(s.board, s.sideToMove, tsumeLimit(s))
        if (cancelled || allMoves.length === 0) return
        const mostResistant = allMoves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
        await new Promise((resolve) => setTimeout(resolve, OPPONENT_MOVE_DELAY_MS))
        if (cancelled) return
        const square = notationToSquare(mostResistant.move)
        const board = applyMove(s.board, s.sideToMove, square)
        setTsumeSession({ ...s, board, sideToMove: opposite(s.sideToMove), lastMove: square })
      } catch (error) {
        console.error('相手の着手取得に失敗しました', error)
      } finally {
        if (!cancelled) setTsumeOpponentThinking(false)
      }
    }
    void run()
    return () => {
      cancelled = true
      setTsumeOpponentThinking(false)
    }
    // eslint-disable-next-line
  }, [tsumePhase, tsumeSession])

  async function handleTsumeMove(square: number): Promise<void> {
    if (tsumePhase !== 'playing' || !tsumeSession || tsumeAnalyzing) return
    const s = tsumeSession
    if (s.sideToMove !== s.humanSide) return
    if (!legalMoves(s.board, s.sideToMove).includes(square)) return

    setTsumeAnalyzing(true)
    try {
      const allMoves = await engine.requestAnalyzeAll(s.board, s.sideToMove, tsumeLimit(s))
      const playedNotation = squareToNotation(square)
      const judgement = judgePuzzleMove(allMoves, playedNotation)
      if (!judgement.correct) {
        setTsumeResult({ playedMove: playedNotation, bestMove: judgement.bestMove })
        setTsumePhase('failed')
        return
      }
      const board = applyMove(s.board, s.sideToMove, square)
      setTsumeSession({ ...s, board, sideToMove: opposite(s.sideToMove), lastMove: square })
    } catch (error) {
      console.error('着手判定のための解析に失敗しました', error)
    } finally {
      setTsumeAnalyzing(false)
    }
  }

  return (
    <div class="blunder-panel-overlay" role="presentation" onClick={onClose}>
      <div
        class="blunder-panel"
        role="dialog"
        aria-modal="true"
        aria-label="悪手分析"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="blunder-panel__header">
          <h2>
            悪手分析: {moveAnalysis.ply + 1}手目({sideLabel(moveAnalysis.side)}番 {moveAnalysis.move})
          </h2>
          <button type="button" class="blunder-panel__close" onClick={onClose}>
            閉じる
          </button>
        </div>

        <section class="blunder-panel__section">
          <h3>着手前の局面</h3>
          <div class="board-container blunder-panel__board board-with-overlay">
            <Board board={moveAnalysis.board} sideToMove={moveAnalysis.side} />
            {boardHighlights && <BoardOverlay highlights={boardHighlights} visible={overlayVisible} />}
          </div>
          <p class="status">
            実際の手: {moveAnalysis.move}{' '}
            <EvalBadge discDiff={moveAnalysis.playedDiscDiff} source={moveAnalysis.evalSource} />
          </p>
          <p class="status">
            最善手: {moveAnalysis.bestMove}{' '}
            <EvalBadge discDiff={moveAnalysis.bestDiscDiff} source={moveAnalysis.evalSource} />
          </p>
          <p class="status">ロス: {Math.round(moveAnalysis.lossDiscs)}石</p>

          {featureSetError && <p class="notice notice--error">{featureSetError}</p>}
          {!featureSet && !featureSetError && <p class="notice">モチーフ・盤面オーバーレイを計算中...</p>}

          {motifs.length > 0 && (
            <ul class="blunder-panel__motifs">
              {motifs.map((motif) => (
                <li key={motif.key}>
                  <button
                    type="button"
                    class={`motif-badge motif-badge--${motif.kind} motif-badge--button`}
                    onClick={() => setGlossaryPopoverTagId(motif.key)}
                  >
                    {motif.label}
                    <span class="motif-badge__kind">({MOTIF_KIND_LABEL[motif.kind]})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {boardHighlights && (
            <div class="board-overlay-controls">
              {OVERLAY_TOGGLES.map(({ key, label }) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={overlayVisible[key]}
                    onChange={(event) =>
                      setOverlayVisible((prev) => ({
                        ...prev,
                        [key]: (event.target as HTMLInputElement).checked,
                      }))
                    }
                  />
                  <span class={`board-overlay-controls__swatch board-overlay-controls__swatch--${key}`} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </section>

        <section class="blunder-panel__section">
          <h3>比較PV(実際の進行 vs 最善進行)</h3>
          {comparePvLoading && <p class="notice">最善進行を計算中...</p>}
          {comparePvError && <p class="notice notice--error">{comparePvError}</p>}
          {comparePv && (
            <div class="blunder-panel__compare-pv">
              <p>
                <span class="blunder-panel__compare-pv-label">実際:</span>{' '}
                {comparePv.playedContinuation.map((m, i) => (
                  <span
                    key={`played-${i}`}
                    class={`blunder-panel__compare-pv-move${comparePv.diverges[i] ? ' blunder-panel__compare-pv-move--diverge' : ''}`}
                  >
                    {m}
                  </span>
                ))}
              </p>
              <p>
                <span class="blunder-panel__compare-pv-label">最善:</span>{' '}
                {comparePv.bestContinuation.map((m, i) => (
                  <span
                    key={`best-${i}`}
                    class={`blunder-panel__compare-pv-move${comparePv.diverges[i] ? ' blunder-panel__compare-pv-move--diverge' : ''}`}
                  >
                    {m}
                  </span>
                ))}
              </p>
            </div>
          )}
        </section>

        <section class="blunder-panel__section">
          <h3>評価内訳(実際の進行 vs 最善進行の末端局面)</h3>
          {!attribution && !attributionError && <p class="notice">評価内訳を計算中...</p>}
          {attributionError && <p class="notice notice--error">{attributionError}</p>}
          {attribution && (
            <AttributionWaterfall
              breakdown={attribution}
              title={`${sideLabel(moveAnalysis.side)}番から見た評価差の内訳(石差)`}
            />
          )}
        </section>

        <section class="blunder-panel__section">
          <h3>反証層: 回収点(寄与が急変した手)</h3>
          {!refutation && !refutationError && <p class="notice">回収点を検出中...</p>}
          {refutationError && <p class="notice notice--error">{refutationError}</p>}
          {refutation && <RefutationView refutation={refutation} />}
        </section>

        <section class="blunder-panel__section">
          <h3>なぜ悪いか</h3>
          <ul class="blunder-panel__why-bad">
            {whyBad.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </section>

        <section class="blunder-panel__section">
          <h3>フリー分岐探索</h3>
          <p class="status">
            手番: {branchMover ? sideLabel(branchMover) : '終局'}
            {branchBusy ? '(評価取得中...)' : ''}
          </p>
          <label class="move-eval-overlay-toggle">
            <input
              type="checkbox"
              checked={moveEvalOverlayEnabled}
              onChange={(event) => handleToggleMoveEvalOverlay((event.target as HTMLInputElement).checked)}
            />
            候補手評価を表示
          </label>
          {branchError && <p class="notice notice--error">{branchError}</p>}
          <div class="blunder-panel__branch-area">
            <div class="board-container blunder-panel__board board-with-move-eval-overlay">
              <Board
                board={branchNode.board}
                sideToMove={branchMover ?? branchNode.side}
                lastMove={branchLastMove}
                onMove={(square) => void handleBranchMove(square)}
              />
              <MoveEvalOverlay
                allMoves={branchOverlayMoves}
                mover={branchMover ?? branchNode.side}
                thresholds={classifyThresholds}
                visible={moveEvalOverlayEnabled}
              />
            </div>
            <div class="blunder-panel__branch-tree-wrap">
              <ul class="blunder-panel__branch-tree">
                <BranchTreeView
                  tree={branchTree}
                  nodeId={branchTree.rootId}
                  onSelect={(nodeId) => setBranchTree(goToNode(branchTree, nodeId))}
                />
              </ul>
            </div>
          </div>
          <button type="button" onClick={() => setBranchTree(goToRoot(branchTree))}>
            本譜に戻る
          </button>
        </section>

        <section class="blunder-panel__section">
          <h3>練習送り</h3>
          <div class="blunder-panel__practice-buttons">
            <button type="button" disabled={sendingToMidgame} onClick={() => void handleSendToMidgame()}>
              中盤練習に送る
            </button>
            <button
              type="button"
              disabled={tsumePhase === 'checking'}
              onClick={() => void startTsumeCheck()}
            >
              詰めオセロとして解いてみる
            </button>
          </div>
          {midgameSentMessage && <p class="notice">{midgameSentMessage}</p>}

          {tsumePhase === 'checking' && <p class="notice">判定中...</p>}
          {tsumePhase === 'rejected' && tsumeRejectReason && <p class="notice notice--error">{tsumeRejectReason}</p>}

          {tsumePhase === 'playing' && tsumeSession && tsumePuzzle && (
            <div class="blunder-panel__tsume">
              <p class="status">
                {sideLabel(tsumePuzzle.sideToMove)}番、最善で{formatDiscDiff(tsumePuzzle.bestDiscDiff)}
                (空き{tsumePuzzle.empties}マス)
              </p>
              <p class="status">
                手番: {sideLabel(tsumeSession.sideToMove)}
                {tsumeOpponentThinking ? '(相手考慮中...)' : ''}
                {tsumeAnalyzing ? '(判定中...)' : ''}
              </p>
              <div class="board-container blunder-panel__board">
                <Board
                  board={tsumeSession.board}
                  sideToMove={tsumeSession.sideToMove}
                  lastMove={tsumeSession.lastMove}
                  onMove={(square) => void handleTsumeMove(square)}
                />
              </div>
            </div>
          )}

          {tsumePhase === 'solved' && <p class="notice">正解! 最善を維持したまま解ききりました。</p>}

          {tsumePhase === 'failed' && tsumeResult && (
            <p class="notice notice--error">
              不正解。あなたの手: {tsumeResult.playedMove}
              {tsumeResult.bestMove && ` / 正解手: ${tsumeResult.bestMove}`}
            </p>
          )}
        </section>

        {glossaryPopoverTagId && (
          <GlossaryPopover
            tagId={glossaryPopoverTagId}
            engine={engine}
            onClose={() => setGlossaryPopoverTagId(null)}
          />
        )}
      </div>
    </div>
  )
}

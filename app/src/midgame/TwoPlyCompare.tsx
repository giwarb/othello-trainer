/**
 * T195/T198: 中盤練習「悪手直後の5盤面比較」フィードバックの表示コンポーネント。
 *
 * 5盤面を表示する:
 * 1. 元局面(悪手を打つ前、自分の番)
 * 2. 1手先・実際の手(相手の番)
 * 3. 1手先・最善手(相手の番)
 * 4. 2手先・実際の手(相手の最善応手後、自分の番)
 * 5. 2手先・最善手(相手の最善応手後、自分の番)
 *
 * レイアウトは上段に元局面、下段に左列(実際の手: 1手先→2手先)・
 * 右列(最善手: 1手先→2手先)を並べる(T198要件2)。各盤面には、その局面の
 * 手番側の全合法手評価(`MoveEvalOverlay`)を重ねる(元局面=自分、
 * 1手先=相手、2手先=自分)。
 *
 * 着手位置の明示(T198要件4、T199で文字バッジ→色ドットに変更): `Board`組み込みの
 * `lastMove`(赤いリング印、その盤面での直近の着手)に加え、`MoveMarkerOverlay`
 * (本ファイル内、`MoveEvalOverlay`/`analysis/BoardOverlay`と同じ8x8 CSS Gridの
 * 重ね方式)で青(自分)/赤(相手)の小さな色ドットを着手マスの中心(石の中心)に
 * 重ねて表示する。着手マスは(合法手オーバーレイが数値を表示する)まだ打たれて
 * いないマスとは常に別集合なので、`MoveEvalOverlay`とドットが同じマスに重なって
 * 表示が競合することはない(盤面上の石が置かれたマスにだけドットを置くため)。
 *
 * T199(ユーザーフィードバック): 旧「自分」「相手」の文字バッジは盤面が小さい
 * (特にモバイル・横置き)と文字が潰れて読めなかった。文字を廃止し、石より
 * 十分小さい色ドット+白黒二重の縁取り(黒石・白石どちらの上でも視認できる)に
 * 変更した。色だけでは意味が伝わらないため、比較表示内に1箇所だけ凡例
 * (`MoveMarkerLegend`)を表示する(パネルごとには置かない)。
 *
 * 純粋props設計(T196の棋譜解析モードから再利用するため、`PracticeMode`固有の
 * stateには一切依存しない。計算(`twoPlyCompare.ts`)・表示(本ファイル)を
 * 分離してあるのも同じ理由)。元局面の自分の合法手評価(`originalMoves`)は
 * 呼び出し元が既存のキャッシュ(中盤練習)または追加1回の`requestAnalyzeAll`
 * (棋譜解析)で用意し、propsとして渡す(T198要件1)。
 */
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import type { MoveEvalJson } from '../engine/types.ts'
import { opposite, type Board as BoardState, type Side } from '../game/othello.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'
import {
  formatOpponentLegalCountHeader,
  formatOpponentPassNote,
  formatOriginalLegalCountHeader,
  formatSelfLegalCountHeader,
  formatTwoPlyCompareLossMessage,
  formatTwoPlyCompareMainMessage,
  twoPlyCompareSupplementalMessages,
  type TwoPlyBranchResult,
  type TwoPlyCompareResult,
} from './twoPlyCompare.ts'
import './TwoPlyCompare.css'

/** 着手マスに重ねる色ドット1件分(`MoveMarkerOverlay`参照、T199で文字ラベルを廃止)。 */
interface MoveMarker {
  readonly square: number
  readonly kind: 'own' | 'opponent'
}

const ALL_SQUARES = Array.from({ length: 64 }, (_, sq) => sq)

/**
 * 着手マスに青(自分)/赤(相手)の色ドットを石の中心に重ねる(T198要件4、T199で
 * 文字バッジから変更)。`MoveEvalOverlay`/`analysis/BoardOverlay`と同じ
 * 8x8 CSS Grid重ね方式。色の意味は比較表示内1箇所の`MoveMarkerLegend`で示す。
 */
function MoveMarkerOverlay({ markers }: { readonly markers: readonly MoveMarker[] }) {
  if (markers.length === 0) return null
  const bySquare = new Map(markers.map((m) => [m.square, m] as const))
  return (
    <div class="two-ply-compare__move-markers" aria-hidden="true">
      {ALL_SQUARES.map((sq) => {
        const marker = bySquare.get(sq)
        return (
          <div key={sq} class="two-ply-compare__move-markers__cell">
            {marker && <span class={`two-ply-compare__move-markers__dot two-ply-compare__move-markers__dot--${marker.kind}`} />}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 色ドットの意味を示す凡例(T199要件1)。比較表示内に1箇所だけ表示する
 * (パネルごとには置かない)。ドット自体は装飾なので`aria-hidden`にするが、
 * ラベル文字列は通常どおり読み上げ対象にする。
 */
function MoveMarkerLegend() {
  return (
    <div class="two-ply-compare__legend">
      <span class="two-ply-compare__legend-item">
        <span class="two-ply-compare__legend-dot two-ply-compare__legend-dot--own" aria-hidden="true" />
        自分の手
      </span>
      <span class="two-ply-compare__legend-item">
        <span class="two-ply-compare__legend-dot two-ply-compare__legend-dot--opponent" aria-hidden="true" />
        相手の手
      </span>
    </div>
  )
}

interface BoardPanelProps {
  readonly label: string
  readonly header: string
  readonly note?: string | null
  readonly board: BoardState
  readonly mover: Side
  readonly moves: readonly MoveEvalJson[] | null
  readonly lastMoveSquare: number | null
  readonly markers: readonly MoveMarker[]
  readonly thresholds: ClassifyThresholds
}

function BoardPanel({ label, header, note, board, mover, moves, lastMoveSquare, markers, thresholds }: BoardPanelProps) {
  return (
    <div class="two-ply-compare__board-col">
      <p class="two-ply-compare__board-label">{label}</p>
      <p class="two-ply-compare__board-header">{header}</p>
      {note && <p class="two-ply-compare__board-note">{note}</p>}
      <div class="board-container two-ply-compare__board board-with-move-eval-overlay">
        <Board board={board} sideToMove={mover} lastMove={lastMoveSquare} />
        <MoveEvalOverlay allMoves={moves} mover={mover} thresholds={thresholds} visible={true} />
        <MoveMarkerOverlay markers={markers} />
      </div>
    </div>
  )
}

export interface TwoPlyCompareProps {
  /** 自分(比較対象の手を打った側)の手番。元局面・2手先2盤面の`MoveEvalOverlay`の視点として使う。 */
  readonly mover: Side
  /** 悪手を打つ前の局面(元局面パネル用、T198要件1)。 */
  readonly preMoveBoard: BoardState
  /** 元局面における自分(`mover`)の全合法手評価。未取得なら`null`(呼び出し元がpropsで渡す、T198要件1)。 */
  readonly originalMoves: readonly MoveEvalJson[] | null
  /** 実際に打った手の記法("a1"〜"h8")。 */
  readonly playedMoveNotation: string
  /** 最善手の記法。 */
  readonly bestMoveNotation: string
  /** `twoPlyCompare.ts`の計算結果。 */
  readonly compare: TwoPlyCompareResult
  /** 損失(石差、0以上)。損失1行の表示に使う。 */
  readonly lossDiscs: number
  readonly thresholds: ClassifyThresholds
  /** 検出済みの明確な悪化パターン(最大2件、補足行として表示。無ければ`null`/省略)。 */
  readonly patterns?: readonly ClearBlunderPattern[] | null
  /**
   * 指定時のみ「続ける」ボタンを表示する(即時フィードバック用途)。
   * 結果画面での静的な最悪手表示では省略する(要件5)。
   */
  readonly onContinue?: () => void
}

/** 1手先パネル(相手番)の`BoardPanel`propsを組み立てる(実際の手/最善手で共通)。 */
function onePlyPanelProps(
  branchLabel: string,
  ownMoveNotation: string,
  branch: TwoPlyBranchResult,
  opponentSide: Side,
  thresholds: ClassifyThresholds,
): BoardPanelProps {
  return {
    label: `${branchLabel}(${ownMoveNotation}): 1手先(相手番)`,
    header: formatOpponentLegalCountHeader(branch),
    board: branch.board1Ply,
    mover: opponentSide,
    moves: branch.opponentMoves,
    lastMoveSquare: branch.ownSquare,
    markers: [{ square: branch.ownSquare, kind: 'own' }],
    thresholds,
  }
}

/** 2手先パネル(自分の番)の`BoardPanel`propsを組み立てる(実際の手/最善手で共通)。 */
function twoPlyPanelProps(
  branchLabel: string,
  branch: TwoPlyBranchResult,
  mover: Side,
  thresholds: ClassifyThresholds,
): BoardPanelProps {
  const markers: MoveMarker[] = [{ square: branch.ownSquare, kind: 'own' }]
  if (branch.opponentSquare !== null) {
    markers.push({ square: branch.opponentSquare, kind: 'opponent' })
  }
  return {
    label: `${branchLabel}: 2手先(あなたの番)`,
    header: formatSelfLegalCountHeader(branch),
    note: formatOpponentPassNote(branch),
    board: branch.board,
    mover,
    moves: branch.kind === 'ok' ? branch.selfMoves : null,
    lastMoveSquare: branch.opponentSquare ?? branch.ownSquare,
    markers,
    thresholds,
  }
}

export function TwoPlyCompare({
  mover,
  preMoveBoard,
  originalMoves,
  playedMoveNotation,
  bestMoveNotation,
  compare,
  lossDiscs,
  thresholds,
  patterns,
  onContinue,
}: TwoPlyCompareProps) {
  const supplemental = twoPlyCompareSupplementalMessages(patterns)
  const opponentSide = opposite(mover)

  return (
    <div class="two-ply-compare">
      <MoveMarkerLegend />
      <div class="two-ply-compare__original">
        <BoardPanel
          label="元局面"
          header={formatOriginalLegalCountHeader(originalMoves)}
          board={preMoveBoard}
          mover={mover}
          moves={originalMoves}
          lastMoveSquare={null}
          markers={[]}
          thresholds={thresholds}
        />
      </div>
      <div class="two-ply-compare__columns">
        <div class="two-ply-compare__column">
          <BoardPanel {...onePlyPanelProps('実際に打った手', playedMoveNotation, compare.played, opponentSide, thresholds)} />
          <BoardPanel {...twoPlyPanelProps('実際に打った手', compare.played, mover, thresholds)} />
        </div>
        <div class="two-ply-compare__column">
          <BoardPanel {...onePlyPanelProps('最善手', bestMoveNotation, compare.best, opponentSide, thresholds)} />
          <BoardPanel {...twoPlyPanelProps('最善手', compare.best, mover, thresholds)} />
        </div>
      </div>
      <div class="two-ply-compare__messages">
        <p>{formatTwoPlyCompareMainMessage(compare)}</p>
        <p>{formatTwoPlyCompareLossMessage(lossDiscs)}</p>
        {supplemental.length > 0 && (
          <ul class="two-ply-compare__patterns">
            {supplemental.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </div>
      {onContinue && (
        <button type="button" class="btn-primary two-ply-compare__continue" onClick={onContinue}>
          続ける
        </button>
      )}
    </div>
  )
}

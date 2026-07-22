/**
 * T195: 中盤練習「悪手直後の2手先2盤面比較」フィードバックの表示コンポーネント。
 *
 * 「実際に打った手+相手の最善応手」(左)と「最善手+相手の最善応手」(右)の
 * 2手ぶんを進めた盤面を並べ、各盤面に(a)相手の最終応手のマーカー
 * (b)自分の各合法手の評価値(`MoveEvalOverlay`)を重ねて表示する。
 *
 * 最終手のマーカーは`analysis/BoardOverlay.tsx`の`emphasizedSquares`ではなく
 * `Board`組み込みの`lastMove`(赤いリング印)を使う(タスク仕様の「BoardOverlay
 * または最終手マーカー」の後者を採用した実装者判断)。理由: `Board`+
 * `MoveEvalOverlay`の組み合わせは`PracticeMode.tsx`のプレイ画面
 * (`.board-with-move-eval-overlay`)で既に前例があるのに対し、
 * `BoardOverlay`+`MoveEvalOverlay`の同時重ね(2枚の絶対配置オーバーレイ)は
 * 前例が無く、z-index・ラベル帯オフセットの検証コストが増える。1手目
 * (打った手/最善手)・2手目(相手応手)のどちらも盤上のマスとしては見えており、
 * どちらのマスかはヘッダ文言(`formatTwoPlyBranchHeader`)で明記されるため、
 * リングは直近(2手目、または相手パス時は1手目)にだけ付ければ要件を満たせる。
 *
 * 純粋props設計(T196の棋譜解析モードから再利用するため、`PracticeMode`固有の
 * stateには一切依存しない。計算(`twoPlyCompare.ts`)・表示(本ファイル)を
 * 分離してあるのも同じ理由)。
 */
import type { ClassifyThresholds } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import { MoveEvalOverlay } from '../components/MoveEvalOverlay.tsx'
import type { Side } from '../game/othello.ts'
import type { ClearBlunderPattern } from './clearBlunder.ts'
import {
  formatTwoPlyBranchHeader,
  formatTwoPlyCompareLossMessage,
  formatTwoPlyCompareMainMessage,
  twoPlyCompareSupplementalMessages,
  type TwoPlyBranchResult,
  type TwoPlyCompareResult,
} from './twoPlyCompare.ts'
import './TwoPlyCompare.css'

interface TwoPlyCompareBoardProps {
  readonly label: string
  readonly ownMoveNotation: string
  readonly branch: TwoPlyBranchResult
  readonly mover: Side
  readonly thresholds: ClassifyThresholds
}

function TwoPlyCompareBoard({ label, ownMoveNotation, branch, mover, thresholds }: TwoPlyCompareBoardProps) {
  // 直近の着手(相手応手があればそれ、相手パスならこちらの着手そのもの)にリングを付ける。
  const lastMoveSquare = branch.opponentSquare ?? branch.ownSquare

  return (
    <div class="two-ply-compare__board-col">
      <p class="two-ply-compare__board-label">{label}</p>
      <p class="two-ply-compare__board-header">{formatTwoPlyBranchHeader(ownMoveNotation, branch)}</p>
      <div class="board-container two-ply-compare__board board-with-move-eval-overlay">
        <Board board={branch.board} sideToMove={mover} lastMove={lastMoveSquare} />
        {branch.kind === 'ok' && (
          <MoveEvalOverlay allMoves={branch.selfMoves} mover={mover} thresholds={thresholds} visible={true} />
        )}
      </div>
    </div>
  )
}

export interface TwoPlyCompareProps {
  /** 自分(比較対象の手を打った側)の手番。両盤面の`MoveEvalOverlay`の視点として使う。 */
  readonly mover: Side
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

export function TwoPlyCompare({
  mover,
  playedMoveNotation,
  bestMoveNotation,
  compare,
  lossDiscs,
  thresholds,
  patterns,
  onContinue,
}: TwoPlyCompareProps) {
  const supplemental = twoPlyCompareSupplementalMessages(patterns)

  return (
    <div class="two-ply-compare">
      <div class="two-ply-compare__boards">
        <TwoPlyCompareBoard
          label="実際に打った手"
          ownMoveNotation={playedMoveNotation}
          branch={compare.played}
          mover={mover}
          thresholds={thresholds}
        />
        <TwoPlyCompareBoard
          label="最善手"
          ownMoveNotation={bestMoveNotation}
          branch={compare.best}
          mover={mover}
          thresholds={thresholds}
        />
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

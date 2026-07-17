/**
 * T128: 中盤練習モード失敗画面の「1手先対比」表示(要件3)。
 *
 * `clearBlunder.ts`の`detectClearBlunderPatterns`が検出した明確な悪化パターン
 * (`patterns`、1〜2件、呼び出し元で既に空でないことを保証済み)を、
 * 「あなたの手のあと」「最善手のあと」(いずれも相手番)の盤面2枚を並べて
 * 表示することで説明する。各盤面には該当パターンのハイライト(相手の合法手
 * マス・問題のX/Cマス・隅・確定石マス等、`ClearBlunderPattern`が既に計算済み)
 * を`analysis/BoardOverlay.tsx`の`emphasizedSquares`で重ねる(`visible`は
 * 全カテゴリfalseにして、既存の4カテゴリ配色ではなく強調色1本に統一する。
 * `midgame/PracticeMode.tsx`が旧`motifHighlight`表示で使っていたのと同じ
 * 使い方)。
 *
 * モバイル(375px程度)でのレイアウトは`PracticeMode.css`の
 * `.clear-blunder-compare__boards`が`flex-wrap`+メディアクエリで縦積みに
 * 切り替える。
 */
import type { ClearBlunderPattern } from './clearBlunder.ts'
import { BoardOverlay, type OverlayVisibility } from '../analysis/BoardOverlay.tsx'
import type { BoardHighlights } from '../analysis/motifs.ts'
import { Board } from '../components/Board.tsx'
import type { Board as BoardState, Side } from '../game/othello.ts'

export interface ClearBlunderCompareProps {
  /** 2枚とも相手番の局面であることを表す(合法手ハイライトの対象)。 */
  readonly opponentSide: Side
  readonly boardAfterPlayed: BoardState
  readonly boardAfterBest: BoardState
  readonly playedSquare: number
  readonly bestSquare: number
  /** 空でないことを呼び出し元が保証する(`detectClearBlunderPatterns`が`null`を返した場合はこのコンポーネント自体を描画しない)。 */
  readonly patterns: readonly ClearBlunderPattern[]
}

/** `BoardOverlay`は`highlights`(4カテゴリ)を必須で受け取るが、本コンポーネントは`emphasizedSquares`だけを使うため空で渡す。 */
const EMPTY_HIGHLIGHTS: BoardHighlights = { frontier: [], stable: [], seed: [], dangerousCorners: [] }
/** 同上の理由で4カテゴリの表示は全てOFFにする。 */
const NO_CATEGORY_VISIBLE: OverlayVisibility = { frontier: false, stable: false, seed: false, dangerousCorners: false }

function uniqueSquares(squareLists: readonly (readonly number[])[]): number[] {
  return [...new Set(squareLists.flat())]
}

export function ClearBlunderCompare({
  opponentSide,
  boardAfterPlayed,
  boardAfterBest,
  playedSquare,
  bestSquare,
  patterns,
}: ClearBlunderCompareProps) {
  const playedHighlightSquares = uniqueSquares(patterns.map((p) => p.playedHighlightSquares))
  const bestHighlightSquares = uniqueSquares(patterns.map((p) => p.bestHighlightSquares))

  return (
    <div class="clear-blunder-compare">
      <div class="clear-blunder-compare__boards">
        <div class="clear-blunder-compare__board-col">
          <p class="clear-blunder-compare__board-label">あなたの手のあと</p>
          <div class="board-container clear-blunder-compare__board">
            <Board board={boardAfterPlayed} sideToMove={opponentSide} lastMove={playedSquare} />
            <BoardOverlay
              highlights={EMPTY_HIGHLIGHTS}
              visible={NO_CATEGORY_VISIBLE}
              emphasizedSquares={playedHighlightSquares}
            />
          </div>
        </div>
        <div class="clear-blunder-compare__board-col">
          <p class="clear-blunder-compare__board-label">最善手のあと</p>
          <div class="board-container clear-blunder-compare__board">
            <Board board={boardAfterBest} sideToMove={opponentSide} lastMove={bestSquare} />
            <BoardOverlay
              highlights={EMPTY_HIGHLIGHTS}
              visible={NO_CATEGORY_VISIBLE}
              emphasizedSquares={bestHighlightSquares}
            />
          </div>
        </div>
      </div>
      <ul class="clear-blunder-compare__messages">
        {patterns.map((pattern) => (
          <li key={pattern.id}>{pattern.message}</li>
        ))}
      </ul>
    </div>
  )
}

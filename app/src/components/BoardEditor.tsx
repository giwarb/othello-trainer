import { useState } from 'preact/hooks'
import { cellAt, initialBoard, squareToNotation, type Board, type Side } from '../game/othello.ts'
import { EMPTY_BOARD, setSquare, type Placement } from './boardEditorLogic.ts'
import './BoardEditor.css'

const GRID = 8
const SQUARES = Array.from({ length: GRID * GRID }, (_, i) => i)

export interface BoardEditorResult {
  board: Board
  sideToMove: Side
}

export interface BoardEditorProps {
  /** 編集中の盤面(制御コンポーネント。状態は呼び出し側`PlayMode`が保持する)。 */
  board: Board
  /** 開始時の手番として選択されている色。 */
  sideToMove: Side
  /** マスクリック・手番選択・リセット操作のたびに新しい値で呼ばれる。 */
  onChange: (next: BoardEditorResult) => void
}

const PLACEMENT_OPTIONS: readonly { value: Placement; label: string }[] = [
  { value: 'black', label: '黒を置く' },
  { value: 'white', label: '白を置く' },
  { value: 'empty', label: '消す' },
]

/**
 * 盤面自由配置エディタ(T077)。
 *
 * 既存の`Board`コンポーネント(`components/Board.tsx`)はCanvas描画+「現在の手番に
 * とって合法なマスのみクリック発火」という対局用の設計であり、任意の配置・手番を
 * 自由に設定する用途には使えないため、本コンポーネントは新規実装のシンプルな
 * HTML(CSS Grid + ボタン要素)で構成する(Canvasの反転/出現アニメーション等、
 * 対局中の演出はここでは不要なため意図的に持ち込まない)。
 *
 * - 「置く石」(黒/白/消す)をラジオボタンで選び、盤面のマスをクリックすると
 *   選択中の種別がそのマスに置かれる(何か置かれていれば置き換える)。
 * - 「次の手番」で開始時の手番を黒/白から選べる。
 * - 「初期配置に戻す」「全て消す」で盤面を一括リセットできる。
 * - 状態は持たず(`placement`という選択中の道具のみローカルstate)、`board`/
 *   `sideToMove`は呼び出し側が保持する制御コンポーネントとして実装する。
 *
 * レスポンシブ対応: グリッドは`display: grid`+相対単位のみで組んであり、
 * 375px幅程度でも`BoardEditor.css`の`@media (max-width: 400px)`でパレット・
 * ツールボタンが折り返すため操作に支障はない(要件6)。
 */
export function BoardEditor({ board, sideToMove, onChange }: BoardEditorProps) {
  const [placement, setPlacement] = useState<Placement>('black')

  function handleCellClick(square: number) {
    onChange({ board: setSquare(board, square, placement), sideToMove })
  }

  function handleSideToMoveChange(next: Side) {
    onChange({ board, sideToMove: next })
  }

  function handleReset() {
    onChange({ board: initialBoard(), sideToMove: 'black' })
  }

  function handleClearAll() {
    onChange({ board: EMPTY_BOARD, sideToMove })
  }

  return (
    <div class="board-editor">
      <fieldset class="board-editor__palette">
        <legend>置く石</legend>
        {PLACEMENT_OPTIONS.map(({ value, label }) => (
          <label class="board-editor__option" key={value}>
            <input
              type="radio"
              name="board-editor-placement"
              value={value}
              checked={placement === value}
              onChange={() => setPlacement(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <div class="board-editor__grid-container">
        <div class="board-editor__grid" role="grid" aria-label="盤面自由配置エディタ">
          {SQUARES.map((square) => {
            const occupant = cellAt(board, square)
            return (
              <button
                type="button"
                key={square}
                class={`board-editor__cell${occupant ? ` board-editor__cell--${occupant}` : ''}`}
                aria-label={`${squareToNotation(square)}${occupant ? `(${occupant === 'black' ? '黒' : '白'})` : ''}`}
                onClick={() => handleCellClick(square)}
              >
                <span class="board-editor__disc" />
              </button>
            )
          })}
        </div>
      </div>

      <fieldset class="board-editor__side-to-move">
        <legend>次の手番</legend>
        <label class="board-editor__option">
          <input
            type="radio"
            name="board-editor-side-to-move"
            checked={sideToMove === 'black'}
            onChange={() => handleSideToMoveChange('black')}
          />
          黒
        </label>
        <label class="board-editor__option">
          <input
            type="radio"
            name="board-editor-side-to-move"
            checked={sideToMove === 'white'}
            onChange={() => handleSideToMoveChange('white')}
          />
          白
        </label>
      </fieldset>

      <div class="board-editor__tools">
        <button type="button" onClick={handleReset}>
          初期配置に戻す
        </button>
        <button type="button" onClick={handleClearAll}>
          全て消す
        </button>
      </div>
    </div>
  )
}

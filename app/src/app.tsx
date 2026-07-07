import { useEffect, useRef, useState } from 'preact/hooks'
import './app.css'
import { Board } from './components/Board.tsx'
import { EngineClient } from './engine/client.ts'
import type { AnalyzeLimit } from './engine/types.ts'
import { createGame, playMove, requestCpuMove, type GameState } from './game/gameLoop.ts'
import { countDiscs, type Side } from './game/othello.ts'

/** CPUの強さプリセット(§2.10の簡易版: 3段階)。 */
type LevelKey = 'weak' | 'normal' | 'strong'

const LEVELS: Record<LevelKey, { label: string; limit: AnalyzeLimit }> = {
  weak: { label: '弱い (depth4)', limit: { depth: 4, exactFromEmpties: 8 } },
  normal: { label: '普通 (depth8)', limit: { depth: 8, exactFromEmpties: 12 } },
  strong: { label: '強い (depth12)', limit: { depth: 12, exactFromEmpties: 16 } },
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

function pickRandomSide(): Side {
  return Math.random() < 0.5 ? 'black' : 'white'
}

export function App() {
  const [level, setLevel] = useState<LevelKey>('normal')
  const [game, setGame] = useState<GameState>(() => createGame('black'))
  const [thinking, setThinking] = useState(false)
  const engineRef = useRef<EngineClient | null>(null)

  function getEngine(): EngineClient {
    if (!engineRef.current) {
      engineRef.current = new EngineClient()
    }
    return engineRef.current
  }

  // Workerはコンポーネントのライフタイム中1つだけ生成し、アンマウント時に終了する。
  useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      engineRef.current = null
    }
  }, [])

  // CPUの手番になったら、エンジンに問い合わせて着手を適用する。
  useEffect(() => {
    if (game.phase !== 'cpu') return

    let cancelled = false
    setThinking(true)

    requestCpuMove(game, getEngine(), LEVELS[level].limit)
      .then((next) => {
        if (!cancelled) {
          setGame(next)
        }
      })
      .catch((error: unknown) => {
        console.error('CPUの着手取得に失敗しました', error)
      })
      .finally(() => {
        if (!cancelled) {
          setThinking(false)
        }
      })

    return () => {
      cancelled = true
    }
    // eslint disabled equivalent: levelはCPU思考開始時点の値を使えばよく、
    // 依存配列にはgameとlevelの両方を含めておく(強さ変更は次の着手から反映される)。
  }, [game, level])

  function handleMove(square: number) {
    if (game.phase !== 'human') return
    setGame((prev) => playMove(prev, square))
  }

  function startNewGame(choice: Side | 'random') {
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    setThinking(false)
    setGame(createGame(humanSide))
  }

  const blackCount = countDiscs(game.board, 'black')
  const whiteCount = countDiscs(game.board, 'white')

  return (
    <main>
      <h1>オセロトレーナー</h1>

      <section class="controls">
        <div class="controls__row">
          <span>新規対局:</span>
          <button type="button" onClick={() => startNewGame('black')}>
            黒番で開始
          </button>
          <button type="button" onClick={() => startNewGame('white')}>
            白番で開始
          </button>
          <button type="button" onClick={() => startNewGame('random')}>
            ランダムで開始
          </button>
        </div>

        <div class="controls__row">
          <label>
            CPUの強さ:{' '}
            <select
              value={level}
              onChange={(event) => setLevel((event.target as HTMLSelectElement).value as LevelKey)}
            >
              {Object.entries(LEVELS).map(([key, { label }]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <p class="status">
        あなたは{sideLabel(game.humanSide)}番です。
        {game.phase === 'over'
          ? ' 対局終了。'
          : ` 手番: ${sideLabel(game.sideToMove)}${thinking ? '(思考中...)' : ''}`}
      </p>

      {game.passMessage && <p class="notice">{game.passMessage}</p>}

      <div class="board-container">
        <Board board={game.board} sideToMove={game.sideToMove} lastMove={game.lastMove} onMove={handleMove} />
      </div>

      <p class="score">
        黒: {blackCount} / 白: {whiteCount}
      </p>

      {game.phase === 'over' && (
        <p class="result">
          {game.result === 'draw' ? '引き分けです。' : `${sideLabel(game.result as Side)}の勝ちです。`}
        </p>
      )}
    </main>
  )
}

import { useEffect, useRef, useState } from 'preact/hooks'
import './app.css'
import { AnalysisMode } from './analysis/AnalysisMode.tsx'
import { BlunderSettings } from './blunder/BlunderSettings.tsx'
import { isBlunder } from './blunder/isBlunder.ts'
import { DEFAULT_BLUNDER_CONFIG, type BlunderConfig, type EvalSource } from './blunder/types.ts'
import { EvalBadge, formatDiscDiff } from './components/EvalBadge.tsx'
import { Board } from './components/Board.tsx'
import { EngineClient } from './engine/client.ts'
import type { AnalyzeLimit } from './engine/types.ts'
import { createGame, playMove, requestCpuMove, type GameState } from './game/gameLoop.ts'
import { countDiscs, squareToNotation, type Board as BoardState, type Side } from './game/othello.ts'
import { loadJosekiDb, lookupJosekiNode } from './joseki/lookup.ts'
import { PracticeMode } from './joseki/PracticeMode.tsx'
import type { JosekiDb } from './joseki/types.ts'
import { PracticeMode as MidgamePracticeMode } from './midgame/PracticeMode.tsx'
import { PlayMode as TsumePlayMode } from './tsume/PlayMode.tsx'

/**
 * アプリ全体のモード(T020: 対局/定石練習、T021: 中盤練習、T028: 詰めオセロ、
 * T029: 棋譜解析の切り替え)。
 */
type AppMode = 'play' | 'joseki' | 'midgame' | 'tsume' | 'analysis'

const MODE_LABEL: Record<AppMode, string> = {
  play: '対局',
  joseki: '定石練習',
  midgame: '中盤練習',
  tsume: '詰めオセロ',
  analysis: '棋譜解析',
}

/**
 * アプリのルートコンポーネント。「対局」「定石練習」「中盤練習」「詰めオセロ」(T028)
 * 「棋譜解析」(T029)モードを切り替えるだけのシンプルなナビゲーション(タブ)を持つ
 * (要件7・9)。ルーティングライブラリは使わず、ローカルstateで表示するモードを切り替える。
 *
 * レスポンシブ対応: タブは `flex-wrap` するため375px幅でも崩れない
 * (`app.css` の `.mode-nav` 参照)。
 */
export function App() {
  const [mode, setMode] = useState<AppMode>('play')

  return (
    <main>
      <h1>オセロトレーナー</h1>

      <nav class="mode-nav" aria-label="モード切り替え">
        {(Object.keys(MODE_LABEL) as AppMode[]).map((key) => (
          <button
            type="button"
            key={key}
            class={`mode-nav__tab${mode === key ? ' mode-nav__tab--active' : ''}`}
            aria-current={mode === key ? 'page' : undefined}
            onClick={() => setMode(key)}
          >
            {MODE_LABEL[key]}
          </button>
        ))}
      </nav>

      {mode === 'play' && <PlayMode />}
      {mode === 'joseki' && <PracticeMode />}
      {mode === 'midgame' && <MidgamePracticeMode />}
      {mode === 'tsume' && <TsumePlayMode />}
      {mode === 'analysis' && <AnalysisMode />}
    </main>
  )
}

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

/** 直近の人間の着手についての評価表示情報(T019)。CPUの着手には表示しない。 */
interface EvalInfo {
  discDiff: number
  source: EvalSource
  blunder: boolean
  /** 悪手だった場合の簡易理由テキスト(悪手でなければ `null`)。 */
  reason: string | null
}

/** 対局モード本体(T013/T019)。名称のみ `PlayMode` にリネームし、ロジックは変更していない。 */
function PlayMode() {
  const [level, setLevel] = useState<LevelKey>('normal')
  const [game, setGame] = useState<GameState>(() => createGame('black'))
  const [thinking, setThinking] = useState(false)
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [firstMoveSquare, setFirstMoveSquare] = useState<number | null>(null)
  const [blunderConfig, setBlunderConfig] = useState<BlunderConfig>(DEFAULT_BLUNDER_CONFIG)
  const [evalInfo, setEvalInfo] = useState<EvalInfo | null>(null)
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

  // 定石DB(public/joseki.json)はコンポーネントのライフタイム中1回だけ読み込む
  // (loadJosekiDb自体もモジュール内でキャッシュしているため、複数コンポーネントから
  // 呼ばれても実際のfetchは1回)。
  useEffect(() => {
    let cancelled = false
    loadJosekiDb()
      .then((db) => {
        if (!cancelled) setJosekiDb(db)
      })
      .catch((error: unknown) => {
        console.error('定石DBの読み込みに失敗しました', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // その対局で実際に指された初手(黒の最初の着手)を記録する。定石DBの
  // ルックアップは「初手をf5とみなす」正規化を前提にしており、その変換を
  // 決めるには実際の初手が必要(app/src/joseki/lookup.ts参照)。人間・CPU
  // どちらが初手を指した場合でも(白番を選んで開始した場合はCPUが先に
  // 黒番で指す)、対局中の最初の着手を捉えられるよう`game`全体を見る。
  useEffect(() => {
    if (firstMoveSquare === null && game.lastMove !== null) {
      setFirstMoveSquare(game.lastMove)
    }
  }, [game, firstMoveSquare])

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

  /**
   * 着手前の局面(`preBoard`/`preSide`)を対象に `requestAnalyzeAll` を呼び、
   * 評価ソース(定石/中盤/終盤)・悪手判定結果を求めて `evalInfo` に反映する。
   * 人間の着手直後にのみ呼ぶ(CPUの着手には表示不要、要件5)。
   */
  async function evaluateHumanMove(
    preBoard: BoardState,
    preSide: Side,
    playedSquare: number,
    firstMove: number,
  ): Promise<void> {
    const playedNotation = squareToNotation(playedSquare)
    try {
      const moves = await getEngine().requestAnalyzeAll(preBoard, preSide, LEVELS[level].limit)
      const playedEval = moves.find((m) => m.move === playedNotation)
      if (!playedEval) return

      const judgement = isBlunder(moves, playedNotation, blunderConfig)
      const bestEval = moves.find((m) => m.move === judgement.bestMove)

      const josekiHit = josekiDb ? lookupJosekiNode(josekiDb, preBoard, preSide, firstMove) : null
      const source: EvalSource = josekiHit && !josekiHit.isLeaf ? 'joseki' : playedEval.type

      const reason =
        judgement.blunder && bestEval
          ? `最善手 ${judgement.bestMove}(${formatDiscDiff(bestEval.discDiff)})に対し、あなたの手 ${playedNotation} は${formatDiscDiff(
              playedEval.discDiff,
            )}(ロス${judgement.lossDiscs.toFixed(1)}石、順位${judgement.rank}位)でした`
          : null

      setEvalInfo({ discDiff: playedEval.discDiff, source, blunder: judgement.blunder, reason })
    } catch (error) {
      console.error('着手の評価取得に失敗しました', error)
    }
  }

  function handleMove(square: number) {
    if (game.phase !== 'human') return

    const preBoard = game.board
    const preSide = game.sideToMove
    // まだ対局の初手が記録されていなければ、この着手自体が初手である
    // (人間が黒番で開始した場合。firstMoveSquare の記録用useEffectがまだ
    // 反映されていないタイミングでも、正しい定石ルックアップができるように
    // ここで直接フォールバックする)。
    const firstMove = firstMoveSquare ?? square

    setGame((prev) => playMove(prev, square))
    void evaluateHumanMove(preBoard, preSide, square, firstMove)
  }

  function startNewGame(choice: Side | 'random') {
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    setThinking(false)
    setFirstMoveSquare(null)
    setEvalInfo(null)
    setGame(createGame(humanSide))
  }

  const blackCount = countDiscs(game.board, 'black')
  const whiteCount = countDiscs(game.board, 'white')

  return (
    <>
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

      {evalInfo && (
        <section class="eval-info">
          <EvalBadge discDiff={evalInfo.discDiff} source={evalInfo.source} blunder={evalInfo.blunder} />
          {evalInfo.reason && <p class="eval-info__reason">{evalInfo.reason}</p>}
        </section>
      )}

      <p class="score">
        黒: {blackCount} / 白: {whiteCount}
      </p>

      {game.phase === 'over' && (
        <p class="result">
          {game.result === 'draw' ? '引き分けです。' : `${sideLabel(game.result as Side)}の勝ちです。`}
        </p>
      )}

      <section class="settings">
        <BlunderSettings onChange={setBlunderConfig} />
      </section>
    </>
  )
}

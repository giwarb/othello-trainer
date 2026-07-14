import { useEffect, useState } from 'preact/hooks'
import './app.css'
import { AnalysisMode } from './analysis/AnalysisMode.tsx'
import { loadClassifyThresholds } from './analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from './analysis/types.ts'
import { BlunderSettings } from './blunder/BlunderSettings.tsx'
import { isBlunder } from './blunder/isBlunder.ts'
import { DEFAULT_BLUNDER_CONFIG, type BlunderConfig, type EvalSource } from './blunder/types.ts'
import { BoardEditor, type BoardEditorResult } from './components/BoardEditor.tsx'
import { EvalBadge, formatDiscDiff } from './components/EvalBadge.tsx'
import { Board, FLIP_ANIMATION_MS } from './components/Board.tsx'
import { MoveEvalOverlay } from './components/MoveEvalOverlay.tsx'
import { ResultCelebration } from './components/ResultCelebration.tsx'
import { celebrationKindFor, type CelebrationKind } from './components/resultCelebrationLogic.ts'
import type { EngineClient } from './engine/client.ts'
import { getSharedEngineClient } from './engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from './engine/types.ts'
import { createGame, createGameFromPosition, playMove, requestCpuMove, type GameState } from './game/gameLoop.ts'
import { countDiscs, initialBoard, squareToNotation, type Board as BoardState, type Side } from './game/othello.ts'
import { loadJosekiDb, lookupJosekiNode } from './joseki/lookup.ts'
import { PracticeMode } from './joseki/PracticeMode.tsx'
import type { JosekiDb } from './joseki/types.ts'
import { EvalBar } from './midgame/EvalBar.tsx'
import { PracticeMode as MidgamePracticeMode } from './midgame/PracticeMode.tsx'
import { loadEvalBarEnabled, saveEvalBarEnabled } from './settings/evalBarSettings.ts'
import { loadMoveEvalOverlayEnabled, saveMoveEvalOverlayEnabled } from './settings/moveEvalOverlaySettings.ts'
import { TitleScreen } from './TitleScreen.tsx'
import { PlayMode as TsumePlayMode } from './tsume/PlayMode.tsx'
import { VerbalizeMode } from './verbalize/VerbalizeMode.tsx'

/**
 * アプリ全体のモード(T020: 対局/定石練習、T021: 中盤練習、T028: 詰めオセロ、
 * T029: 棋譜解析、T035: 言語化トレーニングの切り替え)。
 */
type AppMode = 'play' | 'joseki' | 'midgame' | 'tsume' | 'analysis' | 'verbalize'

const MODE_LABEL: Record<AppMode, string> = {
  play: '対局',
  joseki: '定石練習',
  midgame: '中盤練習',
  tsume: '詰めオセロ',
  analysis: '棋譜解析',
  verbalize: '言語化トレーニング',
}

/** タイトル画面のモードカードに表示する一言説明(T065)。 */
const MODE_DESCRIPTION: Record<AppMode, string> = {
  play: 'CPU相手に対局し、着手ごとの評価値を見ながら実戦感覚を養う',
  joseki: '定石DBに沿った出題で、序盤の定石を反復練習する',
  midgame: '中盤の局面から最善手を探し、評価値の読み方を鍛える',
  tsume: '終盤の詰み問題を解き、正確な読み切り力を鍛える',
  analysis: '自分の棋譜を解析し、悪手とその理由を振り返る',
  verbalize: '用語集・概念レッスンで、手の良し悪しを言葉で説明する力を鍛える',
}

// 言語化トレーニング(verbalize)はユーザー要望(2026-07-12、T074)によりナビゲーションから
// 一時的に非表示にする。`VerbalizeMode`本体・`app/src/verbalize/`配下・IndexedDBスキーマは
// 将来の復活に備えて削除せず残す(下の`mode === 'verbalize' && <VerbalizeMode />`分岐も同様)。
const NAV_VISIBLE_MODES = (Object.keys(MODE_LABEL) as AppMode[]).filter((key) => key !== 'verbalize')

const MODE_CARDS = NAV_VISIBLE_MODES.map((key) => ({
  key,
  label: MODE_LABEL[key],
  description: MODE_DESCRIPTION[key],
}))

/**
 * アプリのルートコンポーネント。起動直後は`TitleScreen`(T065)を表示し、
 * モードカードを選ぶと「対局」「定石練習」「中盤練習」「詰めオセロ」(T028)
 * 「棋譜解析」(T029)「言語化トレーニング」(T035)モードへ遷移する。モード表示中は
 * `mode-nav`タブでモード間を切り替えでき、タブ内のホームボタンでタイトル画面に
 * 戻れる(要件7・9、T035要件8、T065要件3・4)。ルーティングライブラリは使わず、
 * ローカルstate(`mode === null`がタイトル画面)で表示を切り替える。
 *
 * レスポンシブ対応: タブは `flex-wrap` するため375px幅でも崩れない
 * (`app.css` の `.mode-nav` 参照)。タイトル画面のモードカードも
 * 375px幅では1列に積み上がる(`TitleScreen.css` 参照)。
 */
export function App() {
  const [mode, setMode] = useState<AppMode | null>(null)

  if (mode === null) {
    return (
      <main class="home-main">
        <TitleScreen cards={MODE_CARDS} onSelect={(key) => setMode(key as AppMode)} />
      </main>
    )
  }

  return (
    <main>
      <h1>オセロトレーナー</h1>

      <nav class="mode-nav" aria-label="モード切り替え">
        <button
          type="button"
          class="mode-nav__home"
          aria-label="タイトル画面に戻る"
          onClick={() => setMode(null)}
        >
          ホーム
        </button>
        {NAV_VISIBLE_MODES.map((key) => (
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
      {mode === 'verbalize' && <VerbalizeMode />}
    </main>
  )
}

/** CPUの強さプリセット(§2.10の簡易版: 3段階)。 */
type LevelKey = 'weak' | 'normal' | 'strong'

interface LevelPreset {
  readonly label: string
  /** 解析・全合法手比較など、従来経路で使う探索条件。 */
  readonly limit: AnalyzeLimit
  /** CPU着手のsingle-root探索だけに使う探索条件。省略時は`limit`と同じ。 */
  readonly cpuLimit?: AnalyzeLimit
}

export const LEVELS: Record<LevelKey, LevelPreset> = {
  weak: { label: '弱い (depth4)', limit: { depth: 4, exactFromEmpties: 8 } },
  normal: { label: '普通 (depth8)', limit: { depth: 8, exactFromEmpties: 12 } },
  strong: {
    label: '強い (depth12)',
    limit: { depth: 12, exactFromEmpties: 16 },
    cpuLimit: { depth: 12, timeMs: 1500, maxNodes: 160000, exactFromEmpties: 16 },
  },
}

export function cpuMoveLimitForLevel(level: LevelKey): AnalyzeLimit {
  return LEVELS[level].cpuLimit ?? LEVELS[level].limit
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

function pickRandomSide(): Side {
  return Math.random() < 0.5 ? 'black' : 'white'
}

/**
 * `lookupJosekiNode`を安全に呼び出す(T077)。
 *
 * `lookupJosekiNode`が内部で使う`opForFirstMove`は「標準初期局面から黒が
 * d3/c4/f5/e6のいずれかを打った」という前提が崩れると`RangeError`を投げる
 * (`joseki/normalize.ts`参照)。T077で追加した2人対戦モード(白から始まる等)・
 * 盤面自由配置からの対局はこの前提を満たさないことがあるため、そのまま
 * `lookupJosekiNode`を呼ぶと`evaluateHumanMove`全体が例外で中断し、
 * 悪手判定・評価値表示(要件5)まで巻き込んで欠落してしまう。この関数は
 * その例外を「定石の対象外(定石ヒットなし)」として握りつぶし、
 * `evaluateHumanMove`の残りの処理(悪手判定・評価値表示)を継続させる。
 */
function safeLookupJosekiNode(
  db: JosekiDb | null,
  board: BoardState,
  sideToMove: Side,
  firstMoveSquare: number,
): ReturnType<typeof lookupJosekiNode> {
  if (!db) return null
  try {
    return lookupJosekiNode(db, board, sideToMove, firstMoveSquare)
  } catch {
    return null
  }
}

/** 直近の人間の着手についての評価表示情報(T019)。CPUの着手には表示しない。 */
interface EvalInfo {
  discDiff: number
  source: EvalSource
  blunder: boolean
  /** 悪手だった場合の簡易理由テキスト(悪手でなければ `null`)。 */
  reason: string | null
}

/**
 * 対局モード本体(T013/T019)。
 *
 * T077で以下を追加した:
 * - 2人対戦モード(`GameState.vsHuman`)。CPU応手が発生せず、双方の手番で
 *   人間のクリックによる着手を受け付ける(要件1)。
 * - 現在の評価値バー(`midgame/EvalBar.tsx`を転用)の表示切替(要件2・3)。
 * - 盤面自由配置エディタ(`BoardEditor`)からの対局開始(要件4・5)。
 */
function PlayMode() {
  const [level, setLevel] = useState<LevelKey>('normal')
  const [game, setGame] = useState<GameState>(() => createGame('black'))
  const [thinking, setThinking] = useState(false)
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [firstMoveSquare, setFirstMoveSquare] = useState<number | null>(null)
  const [blunderConfig, setBlunderConfig] = useState<BlunderConfig>(DEFAULT_BLUNDER_CONFIG)
  const [evalInfo, setEvalInfo] = useState<EvalInfo | null>(null)
  const [moveEvalOverlayEnabled, setMoveEvalOverlayEnabled] = useState<boolean>(() =>
    loadMoveEvalOverlayEnabled(localStorage),
  )
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)
  // 終局時の勝敗演出(T067)の表示可否。`game.phase === 'over'`になった瞬間
  // ではなく`FLIP_ANIMATION_MS`後にtrueにすることで、Board.tsx側の最後の
  // 一手の反転アニメーションが終わってから演出を表示する(要件3)。
  const [celebrationVisible, setCelebrationVisible] = useState(false)

  // 現在の評価値バー(T077要件2・3)。`localStorage`にON/OFFを永続化し、
  // ONの間は着手のたびに現局面(直前の着手後)をエンジンに問い合わせる。
  const [evalBarEnabled, setEvalBarEnabled] = useState<boolean>(() => loadEvalBarEnabled(localStorage))
  const [evalBarValue, setEvalBarValue] = useState<number | null>(null)

  // 盤面自由配置(T077要件4)。エディタ表示中は通常の対局盤を隠し、
  // 編集中の盤面・手番をこの2つのstateに保持する(`BoardEditor`は制御コンポーネント)。
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorBoard, setEditorBoard] = useState<BoardState>(() => initialBoard())
  const [editorSideToMove, setEditorSideToMove] = useState<Side>('black')
  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  // モードコンポーネントをまたいで使い回すことで、モード切替のたびに
  // WASM再初期化・pattern_v2.binの再fetchが発生するコールドスタートを避ける。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

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

    requestCpuMove(game, getEngine(), cpuMoveLimitForLevel(level))
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

  // 盤面セル評価オーバーレイ(T039)。人間の手番になった時点で、表示ONの場合のみ
  // 現局面(着手前)の全合法手の評価をまとめて取得する。`evaluateHumanMove`
  // (人間の着手*後*にその1手だけを評価するもの)とは目的・タイミングが異なるため
  // 状態を分けている(将来的に1回のリクエストへ統合する余地はあるが、本タスクの
  // スコープ外・作業ログ参照)。CPUの手番中は取得せず、直前(人間手番時)の結果を
  // クリアする。
  useEffect(() => {
    if (game.phase !== 'human' || !moveEvalOverlayEnabled) {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    getEngine()
      .requestAnalyzeAll(game.board, game.sideToMove, LEVELS[level].limit)
      .then((moves) => {
        if (!cancelled) setOverlayMoves(moves)
      })
      .catch((error: unknown) => {
        console.error('候補手評価オーバーレイの取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint disabled equivalent: CPU思考エフェクトと同様、levelは取得開始時点の値でよい。
  }, [game, moveEvalOverlayEnabled, level])

  // 現在の評価値バー(T077要件2・3)。表示ONの間、`game`が変わるたび
  // (人間・CPU・2人対戦いずれの着手後も、また新規対局開始時も)直前の着手後の
  // 局面をエンジンに問い合わせて更新する。表示の基準色(`perspectiveSide`)は
  // 2人対戦モードでは黒固定、CPU対戦では人間の担当色とする(`humanSide`基準の
  // 「+なら自分が有利」という既存の`evalInfo`/中盤練習モードの表示規約に合わせる)。
  // 終局後(`phase === 'over'`)はエンジンに合法手が無い局面を問い合わせて
  // エラーになるのを避けるため、石差をそのまま使う。
  useEffect(() => {
    if (!evalBarEnabled) {
      setEvalBarValue(null)
      return
    }

    const perspectiveSide: Side = game.vsHuman ? 'black' : game.humanSide

    if (game.phase === 'over') {
      const black = countDiscs(game.board, 'black')
      const white = countDiscs(game.board, 'white')
      setEvalBarValue(perspectiveSide === 'black' ? black - white : white - black)
      return
    }

    let cancelled = false
    getEngine()
      .requestAnalyze(game.board, game.sideToMove, LEVELS[level].limit)
      .then((response) => {
        if (cancelled) return
        const value =
          game.sideToMove === perspectiveSide ? response.score.discDiff : -response.score.discDiff
        setEvalBarValue(value)
      })
      .catch((error: unknown) => {
        console.error('現在の評価値の取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint disabled equivalent: 他のエフェクトと同様、levelは取得開始時点の値でよい。
  }, [game, evalBarEnabled, level])

  // 対局が終了したら、Board.tsxの最後の一手の反転アニメーション
  // (FLIP_ANIMATION_MS)が終わるタイミングで勝敗演出を表示する(T067要件3)。
  // `game.phase`のみを依存配列にしているのは、evalInfo/overlayMoves等の
  // 更新のたびに再スケジュールされないようにするため(それらは`game.phase`と
  // 無関係に変化しうる)。
  useEffect(() => {
    if (game.phase !== 'over') {
      setCelebrationVisible(false)
      return
    }
    setCelebrationVisible(false)
    const timer = window.setTimeout(() => setCelebrationVisible(true), FLIP_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [game.phase])

  /** オーバーレイ表示ON/OFFを切り替え、`localStorage`へ永続化する(T039、要件4)。 */
  function handleToggleMoveEvalOverlay(enabled: boolean) {
    setMoveEvalOverlayEnabled(enabled)
    saveMoveEvalOverlayEnabled(localStorage, enabled)
  }

  /** 評価値バー表示ON/OFFを切り替え、`localStorage`へ永続化する(T077要件2)。 */
  function handleToggleEvalBar(enabled: boolean) {
    setEvalBarEnabled(enabled)
    saveEvalBarEnabled(localStorage, enabled)
  }

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

      const josekiHit = safeLookupJosekiNode(josekiDb, preBoard, preSide, firstMove)
      const source: EvalSource = josekiHit && !josekiHit.isLeaf ? 'joseki' : playedEval.type

      const reason =
        judgement.blunder && bestEval
          ? `最善手 ${judgement.bestMove}(${formatDiscDiff(bestEval.discDiff)})に対し、あなたの手 ${playedNotation} は${formatDiscDiff(
              playedEval.discDiff,
            )}(ロス${Math.round(judgement.lossDiscs)}石、順位${judgement.rank}位)でした`
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

  /** 新しい対局に切り替える直前の共通リセット処理(表示中の直前対局の情報をクリアする)。 */
  function prepareNewGame() {
    setThinking(false)
    setFirstMoveSquare(null)
    setEvalInfo(null)
    setEditorOpen(false)
  }

  function startNewGame(choice: Side | 'random') {
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    prepareNewGame()
    setGame(createGame(humanSide))
  }

  /** 2人対戦モード(T077要件1)で、標準の初期局面から開始する。 */
  function startVsHumanGame() {
    prepareNewGame()
    setGame(createGame('black', { vsHuman: true }))
  }

  /** 「盤面を自由に配置して開始」導線(T077要件4)。編集用の盤面を標準初期局面にリセットして開く。 */
  function openEditor() {
    setEditorBoard(initialBoard())
    setEditorSideToMove('black')
    setEditorOpen(true)
  }

  function closeEditor() {
    setEditorOpen(false)
  }

  function handleEditorChange(next: BoardEditorResult) {
    setEditorBoard(next.board)
    setEditorSideToMove(next.sideToMove)
  }

  /**
   * 盤面自由配置エディタで組み立てた局面(`editorBoard`/`editorSideToMove`)から
   * 対局を開始する(T077要件4・5)。CPU対戦(色・強さ選択)・2人対戦のいずれでも
   * 開始できるよう、`choice`に`'vsHuman'`も受け付ける。
   */
  function startFromEditor(choice: Side | 'random' | 'vsHuman') {
    prepareNewGame()
    if (choice === 'vsHuman') {
      setGame(createGameFromPosition(editorBoard, editorSideToMove, 'black', { vsHuman: true }))
      return
    }
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    setGame(createGameFromPosition(editorBoard, editorSideToMove, humanSide))
  }

  /**
   * 終局時の勝敗演出の種別(T077)。CPU対戦は既存の`celebrationKindFor`
   * (`humanSide`視点の勝ち/負け/引き分け)をそのまま使うが、2人対戦モードには
   * 「あなた」という単一の視点が無く勝ち負けの主観が無いため、常に落ち着いた
   * トーン(`'draw'`と同じ演出)を使う(引き分け以外でも紙吹雪等の片方だけが
   * 勝つ演出にしない)。
   */
  function celebrationKindForGame(state: GameState): CelebrationKind {
    if (!state.result) return 'draw'
    if (state.vsHuman) return 'draw'
    return celebrationKindFor(state.result, state.humanSide)
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
          <button type="button" onClick={startVsHumanGame}>
            2人対戦で開始
          </button>
          <button type="button" onClick={openEditor}>
            盤面を自由に配置して開始
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

        <div class="controls__row">
          <label class="move-eval-overlay-toggle">
            <input
              type="checkbox"
              checked={moveEvalOverlayEnabled}
              onChange={(event) => handleToggleMoveEvalOverlay((event.target as HTMLInputElement).checked)}
            />
            候補手評価を表示
          </label>
          <label class="eval-bar-toggle">
            <input
              type="checkbox"
              checked={evalBarEnabled}
              onChange={(event) => handleToggleEvalBar((event.target as HTMLInputElement).checked)}
            />
            現在の評価値を表示
          </label>
        </div>
      </section>

      {editorOpen && (
        <section class="board-editor-panel">
          <p class="notice">盤面を自由に配置し、次の手番を選んでから開始方法を選んでください。</p>
          <BoardEditor board={editorBoard} sideToMove={editorSideToMove} onChange={handleEditorChange} />
          <div class="controls__row board-editor-panel__actions">
            <span>この局面から開始:</span>
            <button type="button" onClick={() => startFromEditor('black')}>
              黒番で開始
            </button>
            <button type="button" onClick={() => startFromEditor('white')}>
              白番で開始
            </button>
            <button type="button" onClick={() => startFromEditor('random')}>
              ランダムで開始
            </button>
            <button type="button" onClick={() => startFromEditor('vsHuman')}>
              2人対戦で開始
            </button>
            <button type="button" onClick={closeEditor}>
              キャンセル
            </button>
          </div>
        </section>
      )}

      {!editorOpen && (
        <>
          <p class="status">
            {game.vsHuman ? '2人対戦モードです。' : `あなたは${sideLabel(game.humanSide)}番です。`}
            {game.phase === 'over'
              ? ' 対局終了。'
              : ` 手番: ${sideLabel(game.sideToMove)}${thinking ? '(思考中...)' : ''}`}
          </p>

          {game.passMessage && <p class="notice">{game.passMessage}</p>}

          {evalBarEnabled && evalBarValue !== null && (
            <div class="play-eval-bar">
              <p class="play-eval-bar__caption">
                現在の評価値({sideLabel(game.vsHuman ? 'black' : game.humanSide)}視点、+なら有利)
              </p>
              <EvalBar discDiff={evalBarValue} />
            </div>
          )}

          <div class="board-container board-with-move-eval-overlay">
            <Board board={game.board} sideToMove={game.sideToMove} lastMove={game.lastMove} onMove={handleMove} />
            <MoveEvalOverlay
              allMoves={overlayMoves}
              mover={game.sideToMove}
              thresholds={classifyThresholds}
              visible={moveEvalOverlayEnabled}
            />
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

          {game.phase === 'over' && celebrationVisible && game.result && (
            <ResultCelebration
              kind={celebrationKindForGame(game)}
              message={game.result === 'draw' ? '引き分けです。' : `${sideLabel(game.result)}の勝ちです。`}
            />
          )}
        </>
      )}

      <section class="settings">
        <BlunderSettings onChange={setBlunderConfig} />
      </section>
    </>
  )
}

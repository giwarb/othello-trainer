import { useEffect, useRef, useState } from 'preact/hooks'
import './app.css'
import { AnalysisMode } from './analysis/AnalysisMode.tsx'
import { EvalGraph } from './analysis/EvalGraph.tsx'
import { loadClassifyThresholds } from './analysis/thresholdSettings.ts'
import type { ClassifyThresholds } from './analysis/types.ts'
import { BlunderSettings } from './blunder/BlunderSettings.tsx'
import { isBlunder } from './blunder/isBlunder.ts'
import { DEFAULT_BLUNDER_CONFIG, type BlunderConfig, type EvalSource } from './blunder/types.ts'
import { BoardEditor, type BoardEditorResult } from './components/BoardEditor.tsx'
import { EvalBadge, formatDiscDiff } from './components/EvalBadge.tsx'
import { Board, DISPLAY_GAP_MS, FLIP_ANIMATION_MS } from './components/Board.tsx'
import { MoveEvalOverlay } from './components/MoveEvalOverlay.tsx'
import {
  buildEvalGraphPoints,
  lastMoveEvalBarState,
  lastMoveEvalBarStateFor,
  type PlayedMoveEval,
} from './components/moveEvalTimeline.ts'
import { PlayerBadge } from './components/PlayerBadge.tsx'
import { ResultCelebration } from './components/ResultCelebration.tsx'
import { celebrationKindFor, type CelebrationKind } from './components/resultCelebrationLogic.ts'
import type { EngineClient } from './engine/client.ts'
import { getSharedEngineClient } from './engine/sharedClient.ts'
import type { AnalyzeLimit, MoveEvalJson } from './engine/types.ts'
import { createDisplaySequencer, type DisplaySequencer } from './game/displayQueue.ts'
import {
  appendPlayedMove,
  computeUndoLength,
  isStandardStartPosition,
  movesToTranscript,
  replayMoves,
} from './game/gameHistory.ts'
import { createGame, createGameFromPosition, playMove, requestCpuMove, type GameState } from './game/gameLoop.ts'
import {
  countDiscs,
  countEmpty,
  initialBoard,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board as BoardState,
  type Side,
} from './game/othello.ts'
import { formatJosekiProgress, formatMidgameProgress, formatTsumeProgress } from './home/modeProgress.ts'
import { getAllSrsStates } from './joseki/db.ts'
import { computeDueLines } from './joseki/dueLines.ts'
import { loadJosekiDb, loadOpeningBookDb, lookupJosekiNode } from './joseki/lookup.ts'
import { PracticeMode } from './joseki/PracticeMode.tsx'
import { selectCpuBookMove } from './joseki/selectCpuBookMove.ts'
import { formatJosekiTrace } from './joseki/traceDisplay.ts'
import type { JosekiDb } from './joseki/types.ts'
import { EvalBar } from './midgame/EvalBar.tsx'
import { PracticeMode as MidgamePracticeMode } from './midgame/PracticeMode.tsx'
import { buildMidgameStagePool } from './midgame/stagePool.ts'
import {
  loadStageProgress as loadMidgameStageProgress,
  stageStatus as midgameStageStatus,
} from './midgame/stageProgress.ts'
import { loadOpeningBookEnabled, saveOpeningBookEnabled } from './settings/openingBookSettings.ts'
import { TitleScreen } from './TitleScreen.tsx'
import { todaysPuzzle } from './tsume/dailyPuzzle.ts'
import { loadPuzzles } from './tsume/loadPuzzles.ts'
import { PlayMode as TsumePlayMode } from './tsume/PlayMode.tsx'
import {
  loadStageProgress as loadTsumeStageProgress,
  stageStatus as tsumeStageStatus,
} from './tsume/stageProgress.ts'
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

  // T132: 対局モードの「この対局を振り返る」ボタンから棋譜解析モードへ渡す
  // 標準トランスクリプト文字列。モード間の受け渡しはURLやDBを経由せず、
  // このAppコンポーネントのstateを経由するだけでよい(タスク要件2)。
  // `AnalysisMode`側が消費し終えたら`onInitialTranscriptConsumed`でnullに戻し、
  // 同じ値で二度自動解析が走らないようにする(`AnalysisMode.tsx`のコメント参照)。
  const [pendingReviewTranscript, setPendingReviewTranscript] = useState<string | null>(null)

  function handleReviewGame(transcript: string): void {
    setPendingReviewTranscript(transcript)
    setMode('analysis')
  }

  // T137要件4: ホームのモードカードに進捗の実績行(定石「今日の復習n本」・
  // 詰め「クリアx/182・今日の1問」・中盤「クリアx/111」)を出す。既存の各モードの
  // 集計ロジック(T131のdueLines・T117/T119のstageProgress・T028のdailyPuzzle)を
  // そのまま再利用するだけで、新規のIndexedDB/localStorageスキーマは追加しない。
  // 3モードは互いに独立な非同期取得のため、1つが失敗しても他の表示に影響しない
  // よう個別にtry/catchする(要件4「取得失敗時は表示しない」)。
  //
  // T137 redo#1 中2: 当初はマウント時1回だけの取得だったため、中盤・詰めで
  // クリアしてホームへ戻っても実績行が古いまま(リロードするまで更新されない)
  // という不整合があった。`mode`を依存配列に含め、`mode === null`(ホーム画面へ
  // 戻った)たびに再取得する。`loadJosekiDb`/`loadPuzzles`はモジュール内で
  // Promiseをキャッシュしているため、ホームへ戻るたびに実際のfetchが増える
  // ことはなく(2回目以降はキャッシュ済みPromiseを再利用)、増えるのは
  // `localStorage`/IndexedDBの読み直しのみ(軽量)。
  const [modeProgress, setModeProgress] = useState<Partial<Record<AppMode, string>>>({})

  useEffect(() => {
    if (mode !== null) return
    let cancelled = false

    void (async () => {
      try {
        const db = await loadJosekiDb()
        const states = await getAllSrsStates()
        const due = computeDueLines(db.lines, states)
        if (!cancelled) {
          setModeProgress((prev) => ({ ...prev, joseki: formatJosekiProgress(due.length) }))
        }
      } catch (error) {
        console.error('ホーム進捗(定石)の取得に失敗しました', error)
      }
    })()

    void (async () => {
      try {
        const db = await loadJosekiDb()
        const stagePool = buildMidgameStagePool(db)
        const progress = loadMidgameStageProgress(localStorage)
        const cleared = stagePool.filter((stage) => midgameStageStatus(progress, stage.key) === 'cleared').length
        if (!cancelled) {
          setModeProgress((prev) => ({ ...prev, midgame: formatMidgameProgress(cleared, stagePool.length) }))
        }
      } catch (error) {
        console.error('ホーム進捗(中盤練習)の取得に失敗しました', error)
      }
    })()

    void (async () => {
      try {
        const file = await loadPuzzles()
        const pool = file.puzzles
        const progress = loadTsumeStageProgress(localStorage)
        const cleared = pool.filter((puzzle) => tsumeStageStatus(progress, puzzle.id) === 'cleared').length
        const today = todaysPuzzle(pool)
        const todayCleared = tsumeStageStatus(progress, today.id) === 'cleared'
        if (!cancelled) {
          setModeProgress((prev) => ({ ...prev, tsume: formatTsumeProgress(cleared, pool.length, todayCleared) }))
        }
      } catch (error) {
        console.error('ホーム進捗(詰めオセロ)の取得に失敗しました', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [mode])

  if (mode === null) {
    const cards = MODE_CARDS.map((card) => ({ ...card, progress: modeProgress[card.key as AppMode] }))
    return (
      <main class="home-main">
        <TitleScreen cards={cards} onSelect={(key) => setMode(key as AppMode)} />
      </main>
    )
  }

  return (
    <>
      {/* T135: 全モード共通の1行スティッキーヘッダ。旧`<h1>オセロトレーナー</h1>`
          (約90px)+2行折返しのナビピルを、ホームボタン・横スクロール可能な
          1行のモード切り替えタブに置き換える。`<main>`の兄弟要素にすることで
          `main`の左右パディングの影響を受けず画面幅いっぱいに張り出す
          (`app.css`の`.app-header`コメント参照)。
          T135 redo#1(オーケストレーターのビジュアルQA): 現在地はタブの
          アクティブ状態(`.mode-nav__tab--active`)だけで示す。以前は
          テキストラベル(`.app-header__title`)でも同じモード名を出しており、
          「対局 [対局]」のように二重表示になっていたため削除した。 */}
      <header class="app-header">
        <button
          type="button"
          class="app-header__home"
          aria-label="タイトル画面に戻る"
          onClick={() => setMode(null)}
        >
          ホーム
        </button>
        <nav class="mode-nav" aria-label="モード切り替え">
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
      </header>

      <main>
        {mode === 'play' && <PlayMode onReviewGame={handleReviewGame} />}
        {mode === 'joseki' && <PracticeMode />}
        {mode === 'midgame' && <MidgamePracticeMode />}
        {mode === 'tsume' && <TsumePlayMode />}
        {mode === 'analysis' && (
          <AnalysisMode
            initialTranscript={pendingReviewTranscript}
            onInitialTranscriptConsumed={() => setPendingReviewTranscript(null)}
          />
        )}
        {mode === 'verbalize' && <VerbalizeMode />}
      </main>
    </>
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
    // T107(exactポリシー再校正): maxNodes/exactFromEmpties/timeMsは校正グリッド
    // (quota{25,40,50,60,75}% x exactFromEmpties{16,18,20,22,24} x
    // maxNodes{160000,240000,320000,480000})でも現行値(160000/16/1500)が
    // 最良(oracle regret最小)のまま据え置かれ、変更不要と判定した
    // (詳細: engine/src/search.rsのEXACT_QUOTA_PERCENTコメント、
    // tasks/T107-exact-policy-recalibration.mdの作業ログ)。quota自体は
    // このAnalyzeLimitには露出しておらず、engine側のEXACT_QUOTA_PERCENT
    // 定数(40%→60%へ更新)でのみ変更される。
    cpuLimit: { depth: 12, timeMs: 1500, maxNodes: 160000, exactFromEmpties: 16 },
  },
}

// T116(対局CPU「強い」の終盤完全読み分離、ユーザー裁定2026-07-16夜):
// 中盤探索と完全読みはノード単価が全く違う(中盤は評価関数計算込みで重く、
// 完全読みは軽く毎秒500万ノード級)のに、従来は`cpuLimit`の単一予算
// (160kノード)を両方で共有しており、実時間ではタダ同然の完全読みが
// 「高い予算超過」扱いされ空き14までしか読み切れていなかった。空き20以下は
// maxNodes/timeMsを一切課さず、`search.rs`の`max_nodes.is_none() &&
// empties <= exact_from_empties`分岐(ルート直接exact、クオータ機構も
// wall time保険も一切発火しない)に完全に委ねる。
//
// 閾値は空き20固定(T107校正のP75実測: 空き20=1,855万ノード≒数秒、
// 空き21=1.3億ノード≒数十秒。`tasks/T107-exact-policy-recalibration.md`
// 作業ログ参照)。
export const ENDGAME_UNLIMITED_EMPTIES_THRESHOLD = 20

// `exactFromEmpties`を盤面の実際の空き数(呼び出しごとに変動)ではなく
// この固定閾値にしているのは、対局中Engineインスタンス(TT)を使い回す際、
// `exactFromEmpties`が前回の呼び出しと異なると置換表全体がクリアされる
// 仕様(`search.rs`のTTスケール混同防止コメント参照)があるため。空き20
// 以下の間、着手のたびに違う値を渡すと毎回TTがクリアされて完全読みの
// 高速化余地を捨ててしまうので、この区間では常に同じ値を使い続ける。
// `depth`はこの経路(ルート直接exact)では反復深化に入る前に返るため
// 参照されないが、プロトコル上必須フィールドのため同じ値を入れておく。
const ENDGAME_UNLIMITED_LIMIT: AnalyzeLimit = {
  depth: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
  exactFromEmpties: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
}

export function cpuMoveLimitForLevel(level: LevelKey, board: BoardState): AnalyzeLimit {
  if (level === 'strong' && countEmpty(board) <= ENDGAME_UNLIMITED_EMPTIES_THRESHOLD) {
    return ENDGAME_UNLIMITED_LIMIT
  }
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

/** `PlayMode`のprops(T132)。 */
interface PlayModeProps {
  /** 終局後「この対局を振り返る」ボタンが押されたときに、棋譜文字列を渡して呼ばれる。 */
  onReviewGame: (transcript: string) => void
}

/**
 * 対局モード本体(T013/T019)。
 *
 * T077で以下を追加した:
 * - 2人対戦モード(`GameState.vsHuman`)。CPU応手が発生せず、双方の手番で
 *   人間のクリックによる着手を受け付ける(要件1)。
 * - 現在の評価値バー(`midgame/EvalBar.tsx`を転用)の表示切替(要件2・3)。
 * - 盤面自由配置エディタ(`BoardEditor`)からの対局開始(要件4・5)。
 *
 * T132で以下を追加した:
 * - 実際に打たれた着手を`moveHistory`に積み上げ(`gameHistory.ts`の
 *   `appendPlayedMove`、パスは記録しない)、終局後に棋譜解析モードへ
 *   ワンタップで遷移できる「この対局を振り返る」ボタン(要件1・2・3)。
 * - 開始局面が標準初期局面かどうかを`standardStart`で追跡し、盤面自由配置
 *   エディタから非標準局面で開始した対局ではボタンを表示しない(要件4)。
 */
function PlayMode({ onReviewGame }: PlayModeProps) {
  // T136要件2: 対局モードの状態分離(セットアップ/対局中/終局後)。`false`の間は
  // セットアップカード(開始ボタン群・CPU強さ・オプション)だけを表示し、盤面
  // エリアは隠す。開始ボタン(`startNewGame`/`startVsHumanGame`/`startFromEditor`)
  // を押すと`true`になり、盤面エリア(バッジ+盤+最小コントロール)に切り替わる。
  // `game`自体はモード表示中ずっと存在する(初期値は黒番の対局)ため、`started`は
  // 「セットアップUIを表示するかどうか」だけを制御する独立したUI状態にしてある。
  const [started, setStarted] = useState(false)
  const [level, setLevel] = useState<LevelKey>('normal')
  const [game, setGame] = useState<GameState>(() => createGame('black'))
  // `<Board>`・手番表示・スコア等、盤面まわりの「実際に見せる」状態(T134)。
  // `game`(内部の対局状態)は着手が確定し次第すぐ更新するが、こちらは
  // `displaySequencerRef`経由でしか更新しない。自分の着手は(アイドル中なら)
  // 即座に反映され、CPUの応手は直前の反転アニメーションが終わって短い間を
  // 置いてから反映される(要件: 自分の返しアニメーション完了→CPUの着手を見せる)。
  // 初期値は`game`と同じ(対局開始直後はアニメーション待ちが無いため即座に一致する)。
  const [displayGame, setDisplayGame] = useState<GameState>(() => game)
  // `displaySequencerRef`はコンポーネントのライフタイム中1つのインスタンスを使い回す
  // (`useRef`の遅延初期化イディオム)。`setDisplayGame`はPreactが安定した参照を
  // 保証するため、`onApply`としてクロージャに一度だけ捕まえてよい。
  const displaySequencerRef = useRef<DisplaySequencer<GameState> | null>(null)
  if (displaySequencerRef.current === null) {
    displaySequencerRef.current = createDisplaySequencer<GameState>(
      (state) => setDisplayGame(state),
      FLIP_ANIMATION_MS + DISPLAY_GAP_MS,
    )
  }
  const [thinking, setThinking] = useState(false)
  const [josekiDb, setJosekiDb] = useState<JosekiDb | null>(null)
  const [josekiDbReady, setJosekiDbReady] = useState(false)
  // 対局中に実際に指された初手(定石DBルックアップの正規化基準、T093)。
  // レンダー結果に影響しない値であり、`useState`にすると「セットするたびに
  // 再レンダー→CPU着手effectの依存配列変化で再実行」という副作用が生じる
  // (T115: 定石ブックONの初手直後、この再実行が書籍応手の即時解決と競合し、
  // 「思考中」表示が解除されなくなる不具合の原因だった)。値の変化そのものを
  // 検知して再描画する必要はないため`useRef`で保持する。
  const firstMoveSquareRef = useRef<number | null>(null)
  // 対局の「世代」ID(T140: 1手戻る)。`undoMove`を実行するたびインクリメントする。
  // CPU着手effect(下の`useEffect`)は自身が開始した時点の世代を`generation`として
  // 閉じ込め、`requestCpuMove`の解決時に現在の世代と照合する。undo実行中に
  // 進行中だったCPU応手が(世代が変わった後に)遅れて解決しても、その結果を
  // 適用しない安全網になる(T115/T119の教訓により、新規effectは増やさず
  // 既存のCPU着手effectに追加する。effect自身の`cancelled`クロージャ変数も
  // `game`の変化による通常のeffect再実行で同様に機能するが、二重の安全網とする)。
  const gameGenerationRef = useRef(0)
  // 実際に打たれた着手の記法列(T132)。パスは含まない(`gameHistory.ts`の
  // `appendPlayedMove`参照)。終局後「この対局を振り返る」ボタンの棋譜文字列の
  // 元データになる。表示に使う(ボタンの活性・非表示判定)ため`useState`にする。
  const [moveHistory, setMoveHistory] = useState<string[]>([])
  // 現在の対局が標準初期局面(黒番)から始まったかどうか(T132要件4)。
  // 盤面自由配置エディタから開始した対局のうち、実際には標準局面のまま
  // 開始した場合は`true`になる(`gameHistory.ts`の`isStandardStartPosition`)。
  const [standardStart, setStandardStart] = useState(true)
  const [openingBookEnabled, setOpeningBookEnabled] = useState<boolean>(() =>
    loadOpeningBookEnabled(localStorage),
  )
  const [blunderConfig, setBlunderConfig] = useState<BlunderConfig>(DEFAULT_BLUNDER_CONFIG)
  const [evalInfo, setEvalInfo] = useState<EvalInfo | null>(null)
  const [classifyThresholds] = useState<ClassifyThresholds>(() => loadClassifyThresholds(localStorage))
  const [overlayMoves, setOverlayMoves] = useState<MoveEvalJson[] | null>(null)
  // T138: 合法手のうち定石ブックに登録されている手のマス集合(空なら
  // ブックcapなし)。`overlayMoves`と同じ`requestAnalyzeAll`エフェクトで
  // 一緒に求める(下の候補手評価+評価値バーの統合エフェクト参照)。
  const [overlayBookSquares, setOverlayBookSquares] = useState<ReadonlySet<number>>(() => new Set())
  // 終局時の勝敗演出(T067)の表示可否。`game.phase === 'over'`になった瞬間
  // ではなく`FLIP_ANIMATION_MS`後にtrueにすることで、Board.tsx側の最後の
  // 一手の反転アニメーションが終わってから演出を表示する(要件3)。
  const [celebrationVisible, setCelebrationVisible] = useState(false)

  // T197: 「打った手の評価値」の時系列記録(折れ線グラフ・評価バー用)。
  // `moveHistory`と同じ順序・長さで対応する(パスは記録しない)。
  // 人間の手(`handleMove`→`evaluateHumanMove`)・CPUの手(CPU着手effect)の
  // 双方が非同期に解決するため、配列への追記は「push」ではなく`ply`(=着手時点の
  // `moveHistory.length`)をキーにした上書き(upsert)で行う。これにより、
  // 人間の着手の評価取得(`evaluateHumanMove`)がCPUの応手より後に解決しても
  // 順序が壊れない(人間の着手時に即座にプレースホルダーを積んでおくため)。
  const [moveEvalHistory, setMoveEvalHistory] = useState<readonly PlayedMoveEval[]>([])

  // T138要件6: 定石トレース表示(オセロクエスト風)。`displayGame`が定石DBの
  // いずれかのノードに一致する間、その`{names, ply}`を保持し続ける。一致しなく
  // なった(定石を外れた・最後まで指し終えた)後も、直前に一致していた情報を
  // 保持したまま`active: false`にする(離脱後も薄く表示を残す仕様)。
  const [josekiTrace, setJosekiTrace] = useState<{
    readonly names: readonly string[]
    readonly ply: number
    readonly active: boolean
  } | null>(null)

  // 盤面自由配置(T077要件4)。エディタ表示中は通常の対局盤を隠し、
  // 編集中の盤面・手番をこの2つのstateに保持する(`BoardEditor`は制御コンポーネント)。
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorBoard, setEditorBoard] = useState<BoardState>(() => initialBoard())
  const [editorSideToMove, setEditorSideToMove] = useState<Side>('black')
  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  // モードコンポーネントをまたいで使い回すことで、モード切替のたびに
  // WASM再初期化・本番パターン重みの再fetchが発生するコールドスタートを避ける。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  // 拡張定石ブック(public/opening-book.json)はコンポーネントのライフタイム中
  // 1回だけ読み込む(loadOpeningBookDb自体もモジュール内でキャッシュしている
  // ため、複数コンポーネントから呼ばれても実際のfetchは1回)。
  //
  // T151: 対局モードのCPU即着手・定石トレース・ブックcapは、定石練習・SRS・
  // 中盤練習ステージが参照する`joseki.json`(手作業の112ライン)ではなく、
  // WTHOR頻出ライン251件をEdax level16評価で悪手除外・頻度重み付けした
  // 拡張ブック`opening-book.json`を参照する(joseki.json自体は変更しない、
  // `tasks/T151-book-eval-publish.md`のオーケストレーター確定の設計判断)。
  // この`josekiDb` state自体は下のCPU着手・トレース・cap用エフェクトが
  // 共通で参照しており、fetch元を切り替えるだけで全て反映される。
  useEffect(() => {
    let cancelled = false
    loadOpeningBookDb()
      .then((db) => {
        if (!cancelled) setJosekiDb(db)
      })
      .catch((error: unknown) => {
        console.error('拡張定石ブックの読み込みに失敗しました', error)
      })
      .finally(() => {
        if (!cancelled) setJosekiDbReady(true)
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
  // `firstMoveSquareRef`はrefのため書き込みが再レンダーを起こさず、
  // 依存配列にも含める必要がない(T115、上のコメント参照)。
  useEffect(() => {
    if (firstMoveSquareRef.current === null && game.lastMove !== null) {
      firstMoveSquareRef.current = game.lastMove
    }
  }, [game])

  // CPUの手番になったら、ブックONかつ現局面に後続定石手があれば探索せず即時適用し、
  // DB外・終端・ロード失敗・ブックOFFなら従来のエンジン探索へフォールバックする。
  useEffect(() => {
    if (game.phase !== 'cpu') return
    if (openingBookEnabled && !josekiDbReady) return

    let cancelled = false
    // T140: この着手effectインスタンスが開始した時点の対局世代を閉じ込める。
    const generation = gameGenerationRef.current
    setThinking(true)

    // CPUが黒で初手を指す場合は任意の合法初手を正規化基準にできるためf5を使う。
    // 人間の初手直後でref反映前の場合は`game.lastMove`が実際の初手となる。
    const firstMove = firstMoveSquareRef.current ?? game.lastMove ?? notationToSquare('f5')
    const bookMove =
      openingBookEnabled && josekiDb
        ? selectCpuBookMove(josekiDb, game.board, game.sideToMove, firstMove)
        : null

    requestCpuMove(game, getEngine(), cpuMoveLimitForLevel(level, game.board), bookMove)
      .then(({ state: next, evalScore }) => {
        // T140: `cancelled`(effect再実行によるクリーンアップ)に加え、対局世代も
        // 照合する。undo実行中にこのCPU応手が解決した場合、世代が食い違うため
        // 適用しない(思考中のCPU応手を破棄する要件1後段の安全網)。
        if (!cancelled && gameGenerationRef.current === generation) {
          // T132: CPUの着手(書籍応手・探索応手いずれも)が実際に成立した場合のみ
          // 履歴へ追記する(`appendPlayedMove`は`lastMove`が変化していなければ
          // 何もしない)。
          const moved = next.lastMove !== null && next.lastMove !== game.lastMove
          setMoveHistory((h) => appendPlayedMove(h, game, next))
          if (moved) {
            // T197: `evalScore`(`requestCpuMove`が返す、以前は捨てていた
            // `response.score`)を`moveEvalHistory`へ記録する。定石ブック手
            // (`evalScore === null`)は探索していないため評価値なし=定石扱い
            // (T046規約、`moveEvalTimeline.ts`参照)。`h.length`をキーにした
            // 追記(人間側と同じ`upsertMoveEval`と同じ考え方)により、この
            // コールバックが人間の`evaluateHumanMove`より先に解決しても、
            // 人間の着手は`handleMove`で既に同期的にプレースホルダーを
            // 積んでいるため順序は保たれる。
            setMoveEvalHistory((h) => {
              const ply = h.length + 1
              const copy = h.slice()
              copy[h.length] = {
                ply,
                notation: squareToNotation(next.lastMove!),
                side: game.sideToMove,
                discDiff: evalScore ? evalScore.discDiff : null,
                source: evalScore ? evalScore.type : 'joseki',
                isExact: evalScore ? evalScore.type === 'exact' : false,
              }
              return copy
            })
          }
          setGame(next)
          // T134: CPUの着手はここで確定するが、盤面への反映(表示)は
          // `displaySequencerRef`に委ね、直前のアニメーション完了+間まで待たせる。
          displaySequencerRef.current?.push(next)
        }
      })
      .catch((error: unknown) => {
        console.error('CPUの着手取得に失敗しました', error)
      })
      .finally(() => {
        if (!cancelled && gameGenerationRef.current === generation) {
          setThinking(false)
        }
      })

    return () => {
      cancelled = true
    }
    // 依存する設定・DBの変更は、そのCPU手番の選択に反映する
    // (`firstMoveSquareRef`はrefなので依存配列に含めない。T115参照)。
  }, [game, level, openingBookEnabled, josekiDb, josekiDbReady])

  // `game.phase`が`'cpu'`でなくなったら「思考中」表示を必ず解除する(T115)。
  // 上のCPU着手effect自身の`.finally`によるリセットが本来のパスだが、
  // 定石応手のような即時解決パスでは、同一クリックから連鎖的に発生する
  // 他のeffect再実行(cleanupによる`cancelled`フラグ競合)でその`.finally`が
  // 握りつぶされることがあった。`game.phase`だけを見るこの安全網により、
  // 内部の競合状況によらず「思考中」表示が確実に解除される。
  useEffect(() => {
    if (game.phase !== 'cpu') setThinking(false)
  }, [game.phase])

  // T138: 候補手評価オーバーレイ(T039)を`requestAnalyzeAll`から導出する
  // (仕様3・4: マスごとのオーバーレイ表示用データ+定石ブックcap対象マス集合
  // (`lookupJosekiNode`の`bookMoves`))。常時表示(仕様5、ON/OFFの概念自体を廃止)。
  // `evaluateHumanMove`(人間の着手*後*にその1手だけを評価するもの)とは目的・
  // タイミングが異なるため状態を分けている(将来的に1回のリクエストへ統合する
  // 余地はあるが、本タスクのスコープ外・作業ログ参照)。
  //
  // T197: 評価値バー(現在の盤面評価)はこのエフェクト由来の`computeBoardEvalScore`
  // への依存を撤去し、`moveEvalHistory`(打った手の評価値の記録)から導出する
  // 「前回の相手の手の評価値」に置き換えた(下の`moveEvalBarState`参照)。この
  // エフェクト自体はオーバーレイ表示用として引き続き必要(`requestAnalyzeAll`の
  // 呼び出し回数・順序・limitは変えない)。
  //
  // `game`ではなく`displayGame`を見る(T134)。このオーバーレイは`<Board>`の
  // 各マスに重ねて描画するため、盤面がまだCPUの応手を表示していない
  // (直列化の待ち時間中の)タイミングで先に「人間の手番の合法手評価」を
  // 出してしまうと、まだ画面上に残っている前の局面のマスと数値がずれて見える。
  // `displayGame`が人間の手番に追いつくのを待つことでこれを避ける。
  //
  // CPUの手番中(`'cpu'`)・終局後(`'over'`)は取得せず、直前(人間手番時)の
  // オーバーレイだけクリアする。
  useEffect(() => {
    if (displayGame.phase !== 'human') {
      setOverlayMoves(null)
      return
    }

    let cancelled = false
    getEngine()
      .requestAnalyzeAll(displayGame.board, displayGame.sideToMove, LEVELS[level].limit)
      .then((moves) => {
        if (cancelled) return
        setOverlayMoves(moves)

        const firstMove = firstMoveSquareRef.current ?? notationToSquare('f5')
        const lookup = safeLookupJosekiNode(josekiDb, displayGame.board, displayGame.sideToMove, firstMove)
        const bookSquares = new Set<number>((lookup?.bookMoves ?? []).map((bookMove) => bookMove.move))
        setOverlayBookSquares(bookSquares)
      })
      .catch((error: unknown) => {
        console.error('候補手評価オーバーレイの取得に失敗しました', error)
      })

    return () => {
      cancelled = true
    }
    // eslint disabled equivalent: CPU思考エフェクトと同様、levelは取得開始時点の値でよい。
  }, [displayGame, level, josekiDb])

  // T138要件6: 定石トレース表示(オセロクエスト風)。`displayGame`が進むたびに
  // 定石DBへ問い合わせ、一致する間は`{names, ply}`を更新し続ける。一致しなく
  // なった(定石手順を外れた・ラインの終端まで指し終えた、いずれも同じ扱い)後も
  // `josekiTrace`自体はクリアせず、直前の一致情報を保持したまま`active: false`に
  // する(離脱後も「〜(離脱)」として薄く表示を残す仕様)。
  //
  // 初期局面(ply=0)は定石DBの全ライン(112件、`lookupJosekiNode`が返す
  // `names`参照)に一致してしまい表示が無意味になるため対象外にする(1手目が
  // 指されて`ply >= 1`になってから追跡を開始する)。
  useEffect(() => {
    const ply = countDiscs(displayGame.board, 'black') + countDiscs(displayGame.board, 'white') - 4
    if (ply <= 0) return

    const firstMove = firstMoveSquareRef.current ?? notationToSquare('f5')
    const lookup = safeLookupJosekiNode(josekiDb, displayGame.board, displayGame.sideToMove, firstMove)
    if (lookup) {
      setJosekiTrace({ names: lookup.names, ply, active: true })
    } else {
      setJosekiTrace((prev) => (prev ? { ...prev, active: false } : null))
    }
  }, [displayGame, josekiDb])

  // 対局が終了したら、Board.tsxの最後の一手の反転アニメーション
  // (FLIP_ANIMATION_MS)が終わるタイミングで勝敗演出を表示する(T067要件3)。
  // `game.phase`ではなく`displayGame.phase`を見る(T134)。CPUの最後の一手が
  // 直列化キューで表示されるまでの待ち時間中は、まだ盤面上に最後の一手の
  // アニメーションすら始まっていないため、そのタイミングを起点にする。
  // `displayGame.phase`のみを依存配列にしているのは、evalInfo/overlayMoves等の
  // 更新のたびに再スケジュールされないようにするため(それらは`displayGame.phase`と
  // 無関係に変化しうる)。
  useEffect(() => {
    if (displayGame.phase !== 'over') {
      setCelebrationVisible(false)
      return
    }
    setCelebrationVisible(false)
    const timer = window.setTimeout(() => setCelebrationVisible(true), FLIP_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [displayGame.phase])

  /** CPU定石ブックON/OFFを切り替え、`localStorage`へ永続化する(T093)。 */
  function handleToggleOpeningBook(enabled: boolean) {
    setOpeningBookEnabled(enabled)
    saveOpeningBookEnabled(localStorage, enabled)
  }

  /**
   * `ply`(=`moveHistory.length`、着手前時点)の位置にある`moveEvalHistory`の
   * 記録を上書きする(T197)。人間の着手・CPUの着手のどちらも、着手成立時点で
   * まず`ply`をキーにプレースホルダーを積み(`handleMove`・CPU着手effect参照)、
   * 実際の評価値が解決し次第この関数で上書きする。`ply`をキーにすることで、
   * 人間の評価取得(`evaluateHumanMove`、非同期)がCPUの応手より後に解決しても
   * (2つの非同期処理は独立に進行するため順序は保証されない)、書き込み先の
   * 位置がズレない。
   */
  function upsertMoveEval(ply: number, entry: PlayedMoveEval): void {
    setMoveEvalHistory((h) => {
      const next = h.slice()
      next[ply] = entry
      return next
    })
  }

  /**
   * 着手前の局面(`preBoard`/`preSide`)を対象に `requestAnalyzeAll` を呼び、
   * 評価ソース(定石/中盤/終盤)・悪手判定結果を求めて `evalInfo` に反映する。
   * 人間の着手直後にのみ呼ぶ(CPUの着手には表示不要、要件5)。
   *
   * T197: 同じ`requestAnalyzeAll`結果から得られる「打った手の評価値」
   * (`playedEval.discDiff`、新規のエンジン呼び出しは追加しない)を
   * `moveEvalHistory`(`ply`位置)へも記録する。
   */
  async function evaluateHumanMove(
    preBoard: BoardState,
    preSide: Side,
    playedSquare: number,
    firstMove: number,
    historyIndex: number,
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
      upsertMoveEval(historyIndex, {
        ply: historyIndex + 1,
        notation: playedNotation,
        side: preSide,
        discDiff: playedEval.discDiff,
        source,
        isExact: playedEval.type === 'exact',
      })
    } catch (error) {
      console.error('着手の評価取得に失敗しました', error)
    }
  }

  function handleMove(square: number) {
    if (game.phase !== 'human') return
    // T134 redo#1: `<Board>`のクリックガード(`legalMoves(board, sideToMove)`)は
    // props経由で渡す`displayGame`(表示中の局面)基準で判定される一方、この
    // 関数自身の上のガードは`game`(内部の最新局面)基準だった。CPUの応手が
    // `game`としては確定済みだが表示(`displayGame`)にまだ反映されていない
    // 直列化の待ち窓(ブック応手で最大`FLIP_ANIMATION_MS + DISPLAY_GAP_MS`
    // ≒470ms)に、「表示中の旧局面でCPU色に合法 かつ 内部の新局面で人間に
    // 合法」なマスをクリックすると、両ガードを通過してユーザーがまだ見て
    // いない局面に対する着手が確定してしまう不具合があった(redo#1、
    // `tasks/review/T134-animation-claude-review.md`指摘)。`displayGame`が
    // `game`に追いついていない(直列化キューが処理中)間はクリックを無視する
    // ことでこれを防ぐ。
    if (displayGame !== game) return

    const preBoard = game.board
    const preSide = game.sideToMove
    // まだ対局の初手が記録されていなければ、この着手自体が初手である
    // (人間が黒番で開始した場合。firstMoveSquareRef の記録用useEffectがまだ
    // 反映されていないタイミングでも、正しい定石ルックアップができるように
    // ここで直接フォールバックする)。
    const firstMove = firstMoveSquareRef.current ?? square

    // T132: `game`から直接次状態を計算する(この関数のクロージャは呼び出し時点で
    // 常に最新の`game`を指す。人間のクリックは同期処理なので、既存の`preBoard`/
    // `preSide`と同様に直接参照して問題ない)。関数型`setGame`更新の内側で
    // 履歴追記のような副作用を行うと、React 18 Strict Modeの二重呼び出しで
    // 履歴が二重に積まれる恐れがあるため、`setGame`の外で一度だけ計算する。
    const nextState = playMove(game, square)
    // T197: この着手が`moveEvalHistory`に積まれる位置(=着手前時点の
    // `moveHistory.length`)。評価値の解決(`evaluateHumanMove`)は非同期なので、
    // 先にこの位置へプレースホルダーを積んでおく(CPUの応手が先に解決しても
    // 順序がズレないようにするため、上の`upsertMoveEval`コメント参照)。
    const historyIndex = moveHistory.length
    setMoveHistory((h) => appendPlayedMove(h, game, nextState))
    setGame(nextState)
    // T134 redo#1: 上の`displayGame !== game`ガードにより、この行に到達する
    // 時点では表示は必ず追いついている(=直列化キューはアイドル中)ため、
    // このpushは常に即座に反映される(待ちが発生するのはCPUの応手のpushのみ)。
    displaySequencerRef.current?.push(nextState)
    upsertMoveEval(historyIndex, {
      ply: historyIndex + 1,
      notation: squareToNotation(square),
      side: preSide,
      discDiff: null,
      source: 'midgame',
      isExact: false,
    })
    void evaluateHumanMove(preBoard, preSide, square, firstMove, historyIndex)
  }

  /**
   * 新しい対局に切り替える直前の共通リセット処理(表示中の直前対局の情報をクリアする)。
   * `startNewGame`/`startVsHumanGame`/`startFromEditor`(対局開始の3経路すべて)が
   * この関数を経由するため、`setStarted(true)`もここでまとめて行う(T136要件2:
   * 開始ボタンのいずれを押してもセットアップカードを隠し盤面エリアへ切り替える)。
   */
  function prepareNewGame() {
    setStarted(true)
    setThinking(false)
    firstMoveSquareRef.current = null
    setEvalInfo(null)
    setEditorOpen(false)
    setMoveHistory([])
    setMoveEvalHistory([])
    // T138: 前の対局のオーバーレイ・評価値バー・定石トレースを持ち越さない
    // (人間が白番でCPUが初手を指す対局では、人間の手番になるまで候補手評価
    // エフェクトが発火せず、リセットしないと前の対局の値が一瞬残って見えてしまう)。
    setOverlayMoves(null)
    setOverlayBookSquares(new Set())
    setJosekiTrace(null)
  }

  function startNewGame(choice: Side | 'random') {
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    prepareNewGame()
    setStandardStart(true)
    const next = createGame(humanSide)
    setGame(next)
    // T134: 新規対局開始は、前の対局の表示待ちキュー・タイマーを一切引き継がず
    // 即座に初期局面を表示する(`reset`。`push`だと前対局の残り待ち時間の
    // 影響を受けてしまう)。
    displaySequencerRef.current?.reset(next)
  }

  /** 2人対戦モード(T077要件1)で、標準の初期局面から開始する。 */
  function startVsHumanGame() {
    prepareNewGame()
    setStandardStart(true)
    const next = createGame('black', { vsHuman: true })
    setGame(next)
    displaySequencerRef.current?.reset(next)
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
    // T132要件4: エディタで組み立てた局面が(結果的に)標準初期局面・黒番と
    // 一致する場合のみ「振り返る」ボタンを有効にする。
    setStandardStart(isStandardStartPosition(editorBoard, editorSideToMove))
    if (choice === 'vsHuman') {
      const next = createGameFromPosition(editorBoard, editorSideToMove, 'black', { vsHuman: true })
      setGame(next)
      displaySequencerRef.current?.reset(next)
      return
    }
    const humanSide = choice === 'random' ? pickRandomSide() : choice
    const next = createGameFromPosition(editorBoard, editorSideToMove, humanSide)
    setGame(next)
    displaySequencerRef.current?.reset(next)
  }

  /**
   * 投了(T136要件2: 対局中の最小コントロール)。CPU対戦中(`!game.vsHuman`)に、
   * 現在の盤面・最後の着手はそのまま据え置いて即座に終局扱いにし、勝敗は
   * 相手(CPU)側の勝ちとして確定する。2人対戦モード(`vsHuman`、「あなた」という
   * 単一視点が無い)・既に終局済みのときは何もしない(呼び出し側のボタンも
   * その条件でのみ表示する)。`gameLoop.ts`に新しい遷移APIは追加せず、既存の
   * `GameState`の形のまま`phase`/`result`だけを書き換える(エンジン・探索には
   * 一切触れない)。
   */
  function resignGame() {
    if (game.vsHuman || game.phase === 'over') return
    const next: GameState = { ...game, phase: 'over', result: opposite(game.humanSide), passMessage: null }
    setGame(next)
    displaySequencerRef.current?.reset(next)
  }

  /**
   * 「1手戻る」(T140、研究用)。`moveHistory`(実際に打たれた着手の記法列、T132)を
   * 正とし、`computeUndoLength`で「戻す」目標の着手数を求めたうえで、標準初期
   * 局面から履歴prefixを`replayMoves`でリプレイして`GameState`を再構築する
   * (パス・終局判定は`playMove`が内部で自動的に再現する)。
   *
   * CPU対戦は自分(human側)の直前の手の直前まで(CPUの応手も含めて)戻り、
   * CPUが思考中でも押せて自分の直前の手のみ取り消す(要件1、
   * `computeUndoLength`のコメント参照)。2人対戦は1ply戻す。履歴が空・非標準
   * 開始局面(呼び出し側のボタン非表示条件)では呼ばれない想定だが、
   * 空履歴からの呼び出しは何もしない(念のための防御)。
   *
   * `gameGenerationRef`をインクリメントし、進行中のCPU着手effect(思考中の
   * 応手)がこの後に解決してもその世代のずれで結果を適用しないようにする
   * (上のCPU着手effectの世代照合参照)。`displaySequencerRef.reset`で
   * T134の表示直列化キューの残骸(保留中のタイマー・push待ちの値)も
   * 破棄し、新しい局面を即座に表示へ反映する。
   */
  function undoMove() {
    if (moveHistory.length === 0) return
    gameGenerationRef.current += 1

    const keep = computeUndoLength(moveHistory, game.humanSide, game.vsHuman)
    const truncated = moveHistory.slice(0, keep)
    const next = replayMoves(game.humanSide, game.vsHuman, truncated)

    setMoveHistory(truncated)
    setMoveEvalHistory((h) => h.slice(0, keep))
    setGame(next)
    displaySequencerRef.current?.reset(next)
    setThinking(false)
    setEvalInfo(null)
    // T148: 初期局面(ply=0)までの全戻しでは`josekiTrace`のuseEffectがply<=0を
    // 対象外にして早期returnするため、undo前の表示が残留してしまう。ここで
    // 明示的にクリアする(ply>=1に戻る場合はuseEffectが再計算するため不要)。
    if (truncated.length === 0) setJosekiTrace(null)
    // その対局で実際に指された初手(T115、`firstMoveSquareRef`参照)を
    // truncate後の履歴に合わせて再計算する。履歴が空に戻った場合は
    // 「まだ初手が指されていない」状態に戻す。
    firstMoveSquareRef.current = truncated.length > 0 ? notationToSquare(truncated[0]) : null
  }

  /**
   * 「新規対局」(T136要件2: 対局中の最小コントロール)。現在の対局そのものは
   * 変更せず、セットアップカードを再表示するだけ(実際に新しい対局を始めるのは
   * ユーザーがセットアップカードの開始ボタンを押した時点、`prepareNewGame`
   * 経由)。
   */
  function returnToSetup() {
    setStarted(false)
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

  // T134: スコア表示は「実際に見せている」盤面(`displayGame`)を基準にする
  // (`game`基準だと、CPUの応手が表示に反映される前に石数だけ先に進んでしまう)。
  const blackCount = countDiscs(displayGame.board, 'black')
  const whiteCount = countDiscs(displayGame.board, 'white')

  // T136要件1: プレイヤーバッジのラベル・手番ハイライト・思考中表示の算出。
  // 2人対戦モード(`game.vsHuman`)には「あなた」という単一視点が無いため、
  // ラベルは常に色名(黒/白)にする。手番ハイライトは「実際に見せている」
  // 局面(`displayGame`)基準(T134の既存方針と同じ理由)で、終局後はどちらも
  // ハイライトしない。「考え中...」はCPU対戦(`!game.vsHuman`)でCPU側の
  // バッジにのみ出す(2人対戦にCPUはいないため常に出さない)。
  const blackLabel = game.vsHuman ? '黒' : game.humanSide === 'black' ? 'あなた' : 'CPU'
  const whiteLabel = game.vsHuman ? '白' : game.humanSide === 'white' ? 'あなた' : 'CPU'
  const cpuSide: Side | null = game.vsHuman ? null : opposite(game.humanSide)

  // T138要件6: 定石トレース表示の文言(`josekiTrace`が無ければ何も表示しない)。
  const josekiTraceText = josekiTrace ? formatJosekiTrace(josekiTrace.names, josekiTrace.ply, !josekiTrace.active) : ''

  // T197: 評価値バー=「前回の相手の手の評価値」。CPU対戦は相手(CPU)側の直近の手、
  // 2人対戦は手番を問わない直近の手(打った側視点、色ラベル付きで表示)。
  const moveEvalBarState = game.vsHuman
    ? lastMoveEvalBarState(moveEvalHistory)
    : lastMoveEvalBarStateFor(moveEvalHistory, opposite(game.humanSide))
  // CPU対戦は相手(CPU)視点の値をあなた視点へ反転する。2人対戦は打った側視点のまま
  // (キャプションもその側の視点であることを明示する)。
  const barDisplayValue =
    moveEvalBarState.kind === 'value' ? (game.vsHuman ? moveEvalBarState.discDiff : -moveEvalBarState.discDiff) : null
  const barCaption = game.vsHuman
    ? moveEvalBarState.kind === 'none'
      ? '直前の手の評価(打った側視点、+なら打った側有利)'
      : `${sideLabel(moveEvalBarState.side)}の直前の手の評価(${sideLabel(moveEvalBarState.side)}視点、+なら${sideLabel(moveEvalBarState.side)}有利)`
    : '相手の直前の手の評価(あなた視点、+ならあなた有利)'
  // T197: 「打った手の評価値」折れ線グラフ(黒視点、定石帯0固定のT046規約)。
  const evalGraphPoints = buildEvalGraphPoints(moveEvalHistory)

  return (
    <>
      {/* T136要件2: 対局開始前はセットアップカード(開始ボタン群・CPU強さ・
          オプション)だけを表示する。開始後(`started`)はこのセクション自体を
          非表示にし、盤面エリア(バッジ+盤+最小コントロール)に主役を譲る。 */}
      {!started && (
        <>
          {/* T137追加要件3: `app.css`の`.play-setup`コメントが「詳細度の衝突を
              避けるため`.card`は併用せず直接指定する」と明記しているのに、
              このJSXだけ`.card`を併用しておりコメントと矛盾していた
              (T136 codex-review指摘・軽微2)。`.play-setup`は`.card`と同じ
              トークンを既に直接指定済みのため、`.card`を外してコメント側の
              方針に統一する(視覚差なし)。 */}
          <section class="play-setup">
            <div class="controls__row">
              <span>新規対局:</span>
              <button type="button" class="btn-primary" onClick={() => startNewGame('black')}>
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
              <label class={'opening-book-toggle'}>
                <input
                  type={'checkbox'}
                  checked={openingBookEnabled}
                  onChange={(event) => handleToggleOpeningBook((event.target as HTMLInputElement).checked)}
                />
                定石ブック
              </label>
            </div>
          </section>

          {editorOpen && (
            <section class="board-editor-panel">
              <p class="notice">盤面を自由に配置し、次の手番を選んでから開始方法を選んでください。</p>
              <BoardEditor board={editorBoard} sideToMove={editorSideToMove} onChange={handleEditorChange} />
              <div class="controls__row board-editor-panel__actions">
                <span>この局面から開始:</span>
                {/* T135 redo#1: 盤面自由配置エディタを開いている間は上の「新規対局」行
                    (黒番で開始がprimary)も同時に見えており、ここにも同格のprimaryを
                    置くと1画面に複数のprimaryが並んでしまう。この行はすべて
                    secondary(既定)のままにする。 */}
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
        </>
      )}

      {/* T133: 横置き(ランドスケープ、低height)対応の2カラム化用ラッパー。
          通常時(縦持ち)はこのdiv自体には何もスタイルを当てず、中身は従来どおり
          単純な縦積みのまま。`app.css`の横置きメディアクエリでのみ、
          プレイヤーバッジを全幅の1行目、盤(`.board-container`)を2行目の
          左カラム、それ以外(`.play-board-area__side`、状態表示・評価バー・
          最小コントロール・評価情報・振り返るボタン・勝敗演出)を2行目の
          右カラムに配置し、右カラムだけがその中で縦スクロールする
          (T136要件6、T133申し送りの解消。以前は`.play-board-area`全体に
          `overflow-y: auto`を掛けており、スクロールすると盤も一緒に画面外へ
          流れていた)。 */}
      {started && (
        <div class="play-board-area">
          {/* T136要件1: 従来の「あなたは黒番です。手番: 黒」「黒: 2 / 白: 2」という
              素テキストを、盤の直上の2バッジ(手番側ハイライト+石数+思考中表示)に
              置き換える。 */}
          {/* T138要件6: `.player-badges`に加え定石トレース表示(下記)も横置き
              2カラムレイアウトで1行目(全幅)にまとめて配置したいため、両方を
              共通のラッパーで包む(`app.css`の`.play-board-area > .play-board-area__header`
              参照。以前は`.player-badges`単独に直接grid配置していた)。 */}
          <div class="play-board-area__header">
            <div class="player-badges">
              <PlayerBadge
                side="black"
                label={blackLabel}
                count={blackCount}
                active={displayGame.phase !== 'over' && displayGame.sideToMove === 'black'}
                thinking={thinking && cpuSide === 'black'}
              />
              <PlayerBadge
                side="white"
                label={whiteLabel}
                count={whiteCount}
                active={displayGame.phase !== 'over' && displayGame.sideToMove === 'white'}
                thinking={thinking && cpuSide === 'white'}
              />
            </div>

            {/* T138要件6: 定石トレース表示(オセロクエスト風)。現在の進行がどの定石を
                どこまでたどっているかを1行で示す。ブックを離脱(または最後まで
                指し終えた)後は`formatJosekiTrace`が末尾に「(離脱)」を付けた
                文言を返す。一度も定石DBに一致していない対局では`josekiTraceText`が
                空文字列のままなので何も描画しない。 */}
            {josekiTraceText && <p class="joseki-trace">{josekiTraceText}</p>}
          </div>

          {/* T134: 手番表示は`displayGame`(実際に見せている状態)基準。`game`基準だと
              CPUの応手が盤面へ反映される前に「手番: 黒」等の文言だけ先に進んでしまい、
              盤面と文言の間で新たな不整合が生じるため。T136: 同じ情報は上の
              プレイヤーバッジで視覚的に表示するため、このテキスト自体は
              スクリーンリーダー向けに残しつつ画面上は視覚的に隠す(`.sr-only`)。 */}
          <p class="status sr-only">
            {game.vsHuman ? '2人対戦モードです。' : `あなたは${sideLabel(game.humanSide)}番です。`}
            {displayGame.phase === 'over'
              ? ' 対局終了。'
              : ` 手番: ${sideLabel(displayGame.sideToMove)}${thinking ? '(思考中...)' : ''}`}
          </p>

          {/* T134: `<Board>`には`displayGame`(実際に見せている状態)を渡す。これにより
              盤面上の合法手ヒント・クリック可否も表示中の状態を基準に判定され、
              CPUの応手がまだ画面に反映されていない間に人間の着手を先取りして
              受け付けてしまうことがない。 */}
          <div class="board-container board-with-move-eval-overlay">
            <Board
              board={displayGame.board}
              sideToMove={displayGame.sideToMove}
              lastMove={displayGame.lastMove}
              onMove={handleMove}
            />
            <MoveEvalOverlay
              allMoves={overlayMoves}
              mover={displayGame.sideToMove}
              thresholds={classifyThresholds}
              visible={true}
              bookSquares={overlayBookSquares}
            />
          </div>

          <div class="play-board-area__side">
            {displayGame.passMessage && <p class="notice">{displayGame.passMessage}</p>}

            {/* T138要件5: 常時表示(旧ON/OFFチェックは廃止)。
                T197: 表示内容を「現在の盤面評価」から「前回の相手の手の評価値」に
                変更した。まだ相手の手が無い(初手前)・定石ブック手(評価値なし)は
                数値の代わりに控えめなメッセージを出す(`moveEvalBarState`参照)。 */}
            <div class="play-eval-bar">
              <p class="play-eval-bar__caption">{barCaption}</p>
              {moveEvalBarState.kind === 'value' && <EvalBar discDiff={barDisplayValue!} />}
              {moveEvalBarState.kind === 'joseki' && <p class="play-eval-bar__note">定石</p>}
              {moveEvalBarState.kind === 'none' && <p class="play-eval-bar__note">まだ相手の手がありません</p>}
            </div>

            {/* T197: 「打った手の評価値」折れ線グラフ。手を打つたびに点が増える
                (`EvalGraph`を再利用、黒視点・定石帯0固定のT046規約)。まだ1手も
                打たれていない間は表示しない。 */}
            {moveHistory.length > 0 && (
              <div class="play-eval-graph">
                <EvalGraph points={evalGraphPoints} markers={[]} />
              </div>
            )}

            {/* T136要件2: 対局中の最小コントロール。投了はCPU対戦中(2人対戦モードでは
                「あなた」という単一視点が無いため出さない)かつ未終局のときのみ表示する。
                新規対局はセットアップカードへ戻るだけで、実際の対局開始は
                セットアップカードの開始ボタンで行う(`returnToSetup`参照)。
                T140: 「1手戻る」(研究用)は標準初期局面からの対局
                (`standardStart`、盤面自由配置対局ではリプレイの前提が崩れるため
                出さない、要件3)でのみ表示する。終局後も押せる(研究用、要件1)ため
                `displayGame.phase`では出し分けない。履歴が空のときは非活性にする
                (要件1)。 */}
            <div class="play-board-area__controls">
              {!game.vsHuman && displayGame.phase !== 'over' && (
                <button type="button" onClick={resignGame}>
                  投了
                </button>
              )}
              {standardStart && (
                <button type="button" onClick={undoMove} disabled={moveHistory.length === 0}>
                  1手戻る
                </button>
              )}
              <button type="button" onClick={returnToSetup}>
                新規対局
              </button>
            </div>

            {evalInfo && (
              <section class="eval-info">
                <EvalBadge discDiff={evalInfo.discDiff} source={evalInfo.source} blunder={evalInfo.blunder} />
                {evalInfo.reason && <p class="eval-info__reason">{evalInfo.reason}</p>}
              </section>
            )}

            {/* T132: 終局後、標準初期局面からの対局かつ実際に着手が記録されている場合のみ、
                棋譜解析モードへワンタップで遷移できるボタンを出す(要件1・4)。
                T136要件2: 終局後はこのボタンと下の勝敗演出を目立たせる。 */}
            {displayGame.phase === 'over' && standardStart && moveHistory.length > 0 && (
              <div class="review-game">
                <button type="button" class="btn-primary" onClick={() => onReviewGame(movesToTranscript(moveHistory))}>
                  この対局を棋譜解析で振り返る
                </button>
              </div>
            )}

            {displayGame.phase === 'over' && celebrationVisible && displayGame.result && (
              <ResultCelebration
                kind={celebrationKindForGame(displayGame)}
                message={displayGame.result === 'draw' ? '引き分けです。' : `${sideLabel(displayGame.result)}の勝ちです。`}
              />
            )}
          </div>
        </div>
      )}

      {/* T136要件2・追加要件1: 悪手判定設定は折りたたみへ移す(`<details>`、既定で
          閉じる)。`.settings`クラスはT135の設定カード見た目(`app.css`)を
          そのまま流用する。T138要件5: 候補手評価・現在の評価値は常時表示に
          なったため、このパネルからON/OFFチェックは撤去した(悪手判定の
          閾値設定のみ残る)。 */}
      <details class="settings play-settings-panel">
        <summary class="play-settings-panel__summary">設定(悪手判定)</summary>
        <div class="play-settings-panel__body">
          <BlunderSettings onChange={setBlunderConfig} />
        </div>
      </details>
    </>
  )
}

/**
 * 棋譜解析パイプライン(T029、要件3・4・5、設計書§6.2)。
 *
 * 着手列(`GameRecord.moves`)を受け取り、以下の手順で解析する:
 * 1. `replayGame`で全局面を先頭から再生する(パスは自動処理、非合法手は
 *    `TranscriptReplayError`)。
 * 2. **終局側から**(`moves`の末尾から先頭へ向けて)1手ずつ解析する。
 *    各局面の解析は`AnalyzeEngine.requestAnalyzeAll`(≒`EngineClient`)を呼び、
 *    `ANALYZE_LIMIT`(空き22以下は完全読み、それより前はdepth18)を使う。
 *    キャッシュ(`cache.ts`)により同一局面の再解析を避ける。この段階では
 *    各手のロス(`lossDiscs`)・分類(`classifyMove`)のみを求める。
 * 3. **累積評価値(T056、`applyCumulativeEvaluation`)**: 表示用の評価値
 *    (`blackAdvantageBefore`/`blackAdvantageAfter`)は、局面ごとに独立した
 *    ヒューリスティック探索の生値ではなく、初期局面`E[0] = 0`(互角)から
 *    各手の`lossDiscs`を先頭から積み上げて計算する累積値にする
 *    (`E[i] = E[i-1] - loss[i]`(その手を打ったのが黒番)、
 *    `E[i] = E[i-1] + loss[i]`(白番))。最善手(ロス0)が続く限り評価値は
 *    変化せず、悪手を打った瞬間だけそのロス分だけ悪化する。これにより、
 *    「最善手を打っただけなのに評価値が探索ノイズで跳ねて見える」問題を防ぐ。
 *    「逆転」判定もこの累積値の符号変化を基準に行う(生の探索値の符号変化を
 *    見ていた旧実装では、最善手が続いていても逆転と誤判定することがあった)。
 *    詳細は`applyCumulativeEvaluation`のコメント参照。
 *
 * 空きマス数が大きい局面で完全読みに入って長時間ハングする事故(過去のFFO重い
 * 問題での経験)を避けるため、`ANALYZE_LIMIT.exactFromEmpties`は22に固定して
 * いる(エンジン側`engine/src/search.rs`の規約により、空き23以上の局面では
 * 完全読みは使われずdepth18の探索で打ち切られる)。
 *
 * 定石DB連携(T038): `options.josekiDb`にロード済みの`JosekiDb`が渡された場合、
 * 各局面で`lookupJosekiNode`を呼び、実際に打った手が定石DBの候補手集合に含まれて
 * いれば「定石内」とみなす。定石内の手は評価ソース(`evalSource`)を`'joseki'`、
 * 分類を`'best'`、`lossDiscs`を`0`に上書きする(序盤のヒューリスティック評価の
 * ノイズによる悪手誤判定を避けるため)。`lossDiscs`が`0`になることで、累積評価値
 * (上記3)もその区間は変化せず、T046の「定石区間は評価値0固定」と自然に整合する。
 * `josekiDb`が`null`または省略された場合(ロード失敗時のフォールバック含む)は、
 * この上書きを一切行わず従来通り`exact`/`midgame`のみで評価する。
 *
 * `evalSource`/`isExact`の判定(T059): 定石内でなければ、最善手(`best`)と
 * 実際に打った手(`played`)の**両方**が完全読み(`type === 'exact'`)の場合のみ
 * `'exact'`とする。以前は`best.type`のみを見ており、`played`がエンジン側の
 * 時間予算切れ(棋譜解析は`ANALYZE_LIMIT.timeMs`共有予算)でヒューリスティック
 * 評価にフォールバックしていても(`played.type === 'midgame'`)、`best`さえ
 * 完全読みできていれば「終盤(完全読み確定)」と誤表示していた(ユーザー報告の
 * 評価値異常のバグ調査で判明した根本原因の1つ)。
 */

import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'
import {
  applyMove,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import { lookupJosekiNode } from '../joseki/lookup.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { JosekiDb } from '../joseki/types.ts'
import { resolveMover } from '../midgame/resolveMover.ts'
import { cacheKey, getCachedAnalysis, putCachedAnalysis } from './cache.ts'
import { classifyMove, DEFAULT_CLASSIFY_THRESHOLDS } from './classifyMove.ts'
import type { AnalyzeGameProgress, ClassifyThresholds, MoveAnalysis } from './types.ts'

/**
 * 棋譜解析で使う探索条件(要件3)。空き22以下は完全読み、それより前はdepth18相当。
 *
 * `timeMs`について: 当初`{ depth: 18, exactFromEmpties: 22 }`(時間予算なし)で
 * 実装したが、実機(Playwright)検証で初期局面1手の解析だけで60秒超かかることが
 * 判明した(`engine/src/search.rs`は`time_ms`未指定だと反復深化を`depth`まで
 * 時間無制限に進めるため、開局面のような分岐が広い局面ではdepth18到達に非常に
 * 長時間かかる)。過去のFFO重い問題での完全読みハング事故と同種のリスクであり、
 * 60手全てを解析する本パイプラインでは看過できないため、`midgame/PracticeMode.tsx`の
 * `MIDGAME_ANALYZE_LIMIT`(depth16, timeMs300)と同じ「反復深化+時間予算」方式に
 * 合わせ、`timeMs: 1500`を設定した(depth18はあくまで上限であり、実際には
 * ほとんどの局面で時間予算に達した時点の探索深さの結果を使うことになる)。
 */
export const ANALYZE_LIMIT: AnalyzeLimit = { depth: 18, timeMs: 1500, exactFromEmpties: 22 }

/** キャッシュキーに含める探索条件タグ。`ANALYZE_LIMIT`を変更した場合は別キーになる。 */
const LIMIT_TAG = `d${ANALYZE_LIMIT.depth}-e${ANALYZE_LIMIT.exactFromEmpties}`

/**
 * 石差の理論上限(絶対値、単位は石)。オセロは64マスなので、どちらの手番視点でも
 * 最終石差はこれを超えない(T059)。`lossDiscs`計算の最終防御クランプに使う
 * (根本原因はエンジン側`engine/src/search.rs`の`static_eval`のクランプ欠如
 * だったが、表示層でも二重に防御する)。
 */
export const DISC_DIFF_THEORETICAL_MAX = 64

/**
 * `analyzeGame`が解析エンジンに要求する最小限のインターフェース。
 * `EngineClient`はこれを満たすため、本番ではそのまま渡せる。単体テストでは
 * 決定的なフェイクを注入できる。
 */
export interface AnalyzeEngine {
  requestAnalyzeAll(board: Board, turn: Side, limit: AnalyzeLimit): Promise<MoveEvalJson[]>
}

/** 着手列の再生中に非合法手・終局後の着手を検出した場合に投げるエラー。 */
export class TranscriptReplayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptReplayError'
  }
}

/** `replayGame`が返す1局面。 */
export interface ReplayedPosition {
  readonly board: Board
  /** この局面で実際に着手する側(パス自動処理後)。両者とも合法手が無ければ`null`。 */
  readonly mover: Side | null
}

/**
 * 着手列を先頭から再生し、初期局面を含む`moves.length + 1`個の局面を返す
 * (`positions[i]`は`moves[i]`を打つ**前**の局面、`positions[moves.length]`は最終局面)。
 * パス(手番側に合法手が無い)は`resolveMover`で自動的に処理する。
 */
export function replayGame(moves: readonly string[]): ReplayedPosition[] {
  const start = initialBoard()
  const positions: ReplayedPosition[] = [{ board: start, mover: resolveMover(start, 'black') }]

  for (let i = 0; i < moves.length; i++) {
    const cur = positions[i]!
    if (cur.mover === null) {
      throw new TranscriptReplayError(
        `${i + 1}手目 "${moves[i]}" より前に終局しています(両者とも着手不可)`,
      )
    }
    const square = notationToSquare(moves[i]!)
    if (!legalMoves(cur.board, cur.mover).includes(square)) {
      throw new TranscriptReplayError(`${i + 1}手目 "${moves[i]}" はこの局面で合法手ではありません`)
    }
    const board = applyMove(cur.board, cur.mover, square)
    const nextSide = opposite(cur.mover)
    positions.push({ board, mover: resolveMover(board, nextSide) })
  }

  return positions
}

export interface AnalyzeGameOptions {
  readonly thresholds?: ClassifyThresholds
  readonly onProgress?: (progress: AnalyzeGameProgress) => void
  /** テスト用のIndexedDBファクトリ差し替え口(省略時は実際の`indexedDB`)。 */
  readonly dbFactory?: IDBFactory
  /**
   * 定石DB(T038)。呼び出し元が`loadJosekiDb()`でロード済みのものを渡す。
   * `null`または省略時は定石照会をスキップし、従来通り全手を`exact`/`midgame`
   * 評価のまま扱う(定石DBロード失敗時のフォールバックにも使う)。
   */
  readonly josekiDb?: JosekiDb | null
}

function pickBest(moves: readonly MoveEvalJson[]): MoveEvalJson {
  return moves.reduce((a, b) => (b.discDiff > a.discDiff ? b : a))
}

/** 局面を解析する(キャッシュヒットすればエンジンを呼ばない、要件5)。 */
async function analyzePosition(
  engine: AnalyzeEngine,
  board: Board,
  side: Side,
  dbFactory: IDBFactory | undefined,
): Promise<MoveEvalJson[]> {
  const key = cacheKey(hashBoard(board, side), LIMIT_TAG)
  const cached = await getCachedAnalysis(key, dbFactory)
  if (cached && cached.length > 0) return cached

  const allMoves = await engine.requestAnalyzeAll(board, side, ANALYZE_LIMIT)
  if (allMoves.length > 0) {
    await putCachedAnalysis(key, allMoves, dbFactory)
  }
  return allMoves
}

/**
 * 着手列を解析する(要件3・4・5)。終局側(`moves`の末尾)から先頭へ向けて解析する。
 * `moves`が空の場合は空配列を返す。
 */
export async function analyzeGame(
  engine: AnalyzeEngine,
  moves: readonly string[],
  options: AnalyzeGameOptions = {},
): Promise<MoveAnalysis[]> {
  const thresholds = options.thresholds ?? DEFAULT_CLASSIFY_THRESHOLDS
  const positions = replayGame(moves)
  const total = moves.length
  if (total === 0) return []

  const josekiDb = options.josekiDb ?? null
  // 定石DAGの対称正規化(`joseki/normalize.ts`)の基準となる、この対局の実際の初手。
  // `firstMoveSquare`が確定すれば対局全体を通して使い回せる(`joseki/PracticeMode.tsx`と同じ設計)。
  const firstMoveSquare = notationToSquare(moves[0]!)

  const results: MoveAnalysis[] = new Array(total)

  for (let i = total - 1; i >= 0; i--) {
    const pos = positions[i]!
    const mover = pos.mover
    if (mover === null) {
      // `replayGame`が既に検出しているはずだが、念のための防御。
      throw new TranscriptReplayError(`${i + 1}手目より前に終局しています`)
    }

    const allMoves = await analyzePosition(engine, pos.board, mover, options.dbFactory)
    const best = pickBest(allMoves)
    const playedNotation = moves[i]!
    const played = allMoves.find((m) => m.move === playedNotation) ?? best
    // T059: `best`・`played`の両方が完全読み(`type === 'exact'`)である場合のみ
    // 「終盤(完全読み確定)」とみなす。以前は`best.type`だけを見ており、実際に
    // 打たれた手(`played`)がエンジン側の時間予算切れでヒューリスティック評価に
    // フォールバックしていても(`played.type === 'midgame'`)、`best`が完全読み
    // できていれば「確定」と誤表示していた(下記の`DISC_DIFF_THEORETICAL_MAX`
    // クランプと同じ根本原因調査(T059)で判明)。
    const bestIsExact = best.type === 'exact'
    const playedIsExact = played.type === 'exact'
    const isExact = bestIsExact && playedIsExact
    // T059: `best.discDiff - played.discDiff`にエンジン側のクランプ
    // (`engine/src/search.rs`の`static_eval`、石差の理論上限±64でクランプ)を
    // 適用してもなお、算出過程(2値の差分)で理論上限を超えるロスが理論上
    // 生じうるため、表示層でも二重に防御する(最終防御、要件1)。
    const lossDiscs = Math.min(
      DISC_DIFF_THEORETICAL_MAX,
      Math.max(0, best.discDiff - played.discDiff),
    )

    // 定石DB連携(T038): この局面が定石DBに登録されており、実際に打った手が
    // 定石ラインの候補手に含まれていれば「定石内」とみなし、悪手判定を
    // `'best'`/`lossDiscs: 0`で上書きする(要件1・2)。`josekiDb`が`null`
    // (ロード失敗またはオプション未指定)なら常にスキップし、従来通りの評価に
    // 戻る(要件3)。
    const josekiLookup = josekiDb ? lookupJosekiNode(josekiDb, pos.board, mover, firstMoveSquare) : null
    const playedSquare = notationToSquare(playedNotation)
    const inBook = josekiLookup !== null && josekiLookup.bookMoves.some((bm) => bm.move === playedSquare)

    // `blackAdvantageBefore`/`blackAdvantageAfter`/`reversal`はこの時点では
    // プレースホルダー(下記`applyCumulativeEvaluation`が先頭から順に積み上げて
    // 上書きする、T056)。
    results[i] = {
      ply: i,
      move: playedNotation,
      side: mover,
      board: pos.board,
      isExact,
      evalSource: inBook ? 'joseki' : isExact ? 'exact' : 'midgame',
      josekiNames: inBook ? josekiLookup!.names : undefined,
      bestMove: best.move,
      bestDiscDiff: best.discDiff,
      playedDiscDiff: played.discDiff,
      lossDiscs: inBook ? 0 : lossDiscs,
      classification: inBook ? 'best' : classifyMove(lossDiscs, thresholds),
      reversal: false,
      blackAdvantageBefore: 0,
      blackAdvantageAfter: 0,
    }

    options.onProgress?.({ done: total - i, total, justAnalyzedPly: i })
  }

  applyCumulativeEvaluation(results)

  return results
}

/**
 * 累積評価値(黒視点、T056)を先頭から積み上げて計算し、`results`の
 * `blackAdvantageBefore`/`blackAdvantageAfter`/`reversal`を上書きする。
 *
 * 漸化式: `E[0] = 0`(初期局面、慣例上の互角)を起点に、`i`手目(手番`side`)を
 * 打った後の評価値を次で求める(`loss[i]`は`results[i].lossDiscs`、0以上。
 * 定石内の手は`analyzeGame`側で既に`0`に上書き済み):
 * - `side`が黒なら `E[i] = E[i-1] - loss[i]`
 * - `side`が白なら `E[i] = E[i-1] + loss[i]`
 *
 * 最善手(ロス0)が続く限り`E[i] = E[i-1]`で評価値は変化しない。終盤の完全読み
 * 区間まで含めて全手にこの漸化式を適用すると、`loss`の積み上げが
 * telescoping(望遠鏡式に打ち消し合う)し、最終的な累積評価値は実際の
 * 最終石差に一致する(終盤完全読みのロス計算が正確であるため)。
 *
 * 「逆転」は`E[i-1]`と`E[i]`が厳密に符号反転した場合(正から負、または負から正)
 * にのみ立てる(`0`は特別扱いしない)。`E[0] = 0`からの最初の非0への遷移は
 * 「逆転」とはしない(T057。`0`と非0を異符号とみなす単純な`Math.sign`比較では、
 * 定石を外れた直後の最初の手が必ず「逆転」表示になってしまうため)。
 *
 * **理論上限クランプ(T064)**: `loss[i]`はT059で個別に`DISC_DIFF_THEORETICAL_MAX`
 * (64)にクランプ済みだが、累積値`E[i]`自体にはクランプが無かったため、悪手が
 * 連続する対局(初心者の対局解析という本アプリの主要ユースケース)では、各手の
 * ロスが独立したヒューリスティック探索由来の近似値であることから、真の形勢
 * 以上に評価値が積み上がり続け、理論上あり得ない範囲(石数差の理論上限±64を
 * 大きく超える値、例: -290)まで発散することがあった(T063のverifierが発見)。
 * どの局面の評価値も定義上「双方最善を尽くした場合の最終石差の予測値」であり
 * 石差は物理的に±64を超えないため、`after`を求めるたびに`±64`にクランプする。
 * `cumulative`(次の`before`)にはクランプ後の値を使うため、`before`は常に
 * `[-64, 64]`の範囲に収まっている(クランプは`after`だけで十分)。
 *
 * 通常の対局(悪手が極端に連続しないケース)では、telescoping性質により
 * 累積値はそもそも±64を超えないため、このクランプは実質的に無害(発火しない)
 * である。悪手が連続してクランプが実際に発動するケースでは、最終的な累積値が
 * 実際の最終石差と一致しなくなる可能性があるが、それはクランプ前から既に
 * 累積値が理論上あり得ない範囲に発散していた(=元々信頼できない状態だった)
 * ことの帰結であり、表示上の理論上限違反を防ぐことを優先する。
 */
function applyCumulativeEvaluation(results: MoveAnalysis[]): void {
  let cumulative = 0
  for (let i = 0; i < results.length; i++) {
    const m = results[i]!
    const before = cumulative
    const signedLoss = m.side === 'black' ? -m.lossDiscs : m.lossDiscs
    const after = Math.max(
      -DISC_DIFF_THEORETICAL_MAX,
      Math.min(DISC_DIFF_THEORETICAL_MAX, before + signedLoss),
    )
    results[i] = {
      ...m,
      blackAdvantageBefore: before,
      blackAdvantageAfter: after,
      reversal: (before > 0 && after < 0) || (before < 0 && after > 0),
    }
    cumulative = after
  }
}

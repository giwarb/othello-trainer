/**
 * 定石練習モードのSRS復習キュー可視化(T131)のための純粋関数群。
 *
 * `PracticeMode.tsx`の`startPractice`が「本日出題すべき(due)なライン」を
 * 選ぶロジックは元々コンポーネント内にインラインで書かれており、
 * 「dueのみに限定するモード(0件ならフォールバック)」を追加検証するのに
 * DOM/IndexedDB/エンジンへの依存が絡んでテストしづらかった。本モジュールは
 * それらを純粋関数として切り出し、`dueLines.test.ts`で直接検証できるようにする
 * (`practiceSession.ts`と同じ設計方針)。
 */

import { isDue, type JosekiSrsState } from './srs.ts'
import type { JosekiLine } from './types.ts'

/** due一覧のプレビュー表示で先頭何件まで名前を出すか(要件2)。 */
export const DUE_LINES_PREVIEW_LIMIT = 10

/**
 * 全ライン一覧とSRS状態一覧(`getAllSrsStates`の結果)から、本日出題すべき
 * (due)なラインだけを抽出する。未挑戦のライン(`states`に含まれない)は
 * `isDue`の仕様どおり常にdue扱いになる。
 */
export function computeDueLines(
  lines: readonly JosekiLine[],
  states: readonly JosekiSrsState[],
  now: Date = new Date(),
): JosekiLine[] {
  const stateMap = new Map(states.map((state) => [state.lineId, state]))
  return lines.filter((line) => isDue(stateMap.get(line.id), now))
}

export interface DueLinesPreview {
  /** 先頭`limit`件の定石名。 */
  readonly shown: readonly string[]
  /** `shown`に含まれない残り件数(0以上)。 */
  readonly remaining: number
}

/**
 * due一覧のうち先頭`limit`件の名前と、それ以外の残り件数を返す
 * (「定石名、最大10件+『他n本』」表示、要件2)。
 */
export function previewDueLineNames(
  lines: readonly JosekiLine[],
  limit: number = DUE_LINES_PREVIEW_LIMIT,
): DueLinesPreview {
  return {
    shown: lines.slice(0, limit).map((line) => line.name),
    remaining: Math.max(0, lines.length - limit),
  }
}

export interface SelectTargetLineResult {
  /** 選ばれた出題対象ライン。プール(`allLines`/`dueLines`)が空の場合のみ`null`。 */
  readonly target: JosekiLine | null
  /**
   * `dueOnly`指定だがdueが0件だったため、プールを`allLines`全体に
   * フォールバックしたかどうか(要件3)。`dueOnly`が偽の場合は常に`false`
   * (元々の「due優先、無ければ全体」ロジックはフォールバックとは呼ばない)。
   */
  readonly usedFallback: boolean
}

/**
 * 練習開始時に出題対象ラインを1つ選ぶ(`PracticeMode.tsx`の`startPractice`から
 * 呼ばれる)。
 *
 * - `dueOnly`が偽(従来の色選択ボタン): dueラインがあればそこから、無ければ
 *   `allLines`全体からランダムに選ぶ(既存ロジックのまま)。
 * - `dueOnly`が真(「復習を始める」ボタン、要件3): dueラインが1件以上あれば
 *   **dueラインのみ**から選ぶ。dueが0件なら`allLines`全体にフォールボックし、
 *   `usedFallback: true`を返す(呼び出し側はこれを見て「その旨表示」する)。
 *
 * `pickIndex`は乱数選択を外出ししたもの(既定は`Math.random`ベース)。
 * テストでは決定的な関数を渡すことで、選ばれるプールが`allLines`/`dueLines`の
 * どちらだったかを直接検証できる。
 */
export function selectPracticeTargetLine(
  allLines: readonly JosekiLine[],
  dueLines: readonly JosekiLine[],
  dueOnly: boolean,
  pickIndex: (poolLength: number) => number = (length) => Math.floor(Math.random() * length),
): SelectTargetLineResult {
  if (dueOnly) {
    if (dueLines.length > 0) {
      return { target: dueLines[pickIndex(dueLines.length)] ?? null, usedFallback: false }
    }
    return { target: allLines[pickIndex(allLines.length)] ?? null, usedFallback: true }
  }

  const pool = dueLines.length > 0 ? dueLines : allLines
  return { target: pool[pickIndex(pool.length)] ?? null, usedFallback: false }
}

/**
 * 色選択画面に出す「今日の復習」の見出し文言を決める(要件1・4)。
 * - due件数が1件以上: 呼び出し側が件数付きの文言(`今日の復習: n本`)を組み立てる
 *   想定なので、本関数は使わない(due件数はJSX側でそのまま表示する)。
 * - due件数が0件かつ`justCompletedReview`が真: 直前のdue限定セッションで
 *   ちょうどdueを使い切った(要件4)ので「今日の復習完了!」。
 * - それ以外(due0件・完了直後でもない): 「今日の復習はありません」。
 */
export function dueSummaryHeadline(dueCount: number, justCompletedReview: boolean): string {
  if (dueCount > 0) return `今日の復習: ${dueCount}本`
  return justCompletedReview ? '今日の復習完了!' : '今日の復習はありません'
}

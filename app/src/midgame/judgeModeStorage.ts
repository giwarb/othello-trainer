/**
 * 中盤練習モードの判定モード(`JudgeMode`)設定を`localStorage`へ保存・読み込みする(T072)。
 *
 * 従来は`judgeMode`の選択状態を永続化するコードが`app/src/midgame/`配下に一切
 * 存在せず、ページのリロードやセッション再開のたびに常に`useState`の初期値へ
 * 戻ってしまう既存バグがあった(ユーザーが「標準」に切り替えても次回また既定値に
 * 戻る)。`app/src/blunder/storage.ts`・`app/src/settings/moveEvalOverlaySettings.ts`と
 * 同じ実装パターン(`StorageLike`インターフェース経由でのアクセス、壊れた値は
 * 例外を投げずに既定値へフォールバック)を踏襲する。
 */

import type { JudgeMode } from './types.ts'

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const JUDGE_MODE_STORAGE_KEY = 'othello-trainer:midgameJudgeMode'

/**
 * 判定モードの既定値(要件1、ユーザー要望2026-07-11「中盤練習のデフォルトは
 * 厳格、最善をデフォルト」により`'strict'`。T072以前は`'standard'`だった)。
 */
export const DEFAULT_JUDGE_MODE: JudgeMode = 'strict'

const VALID_JUDGE_MODES: readonly JudgeMode[] = ['strict', 'standard', 'noReversal']

function isValidJudgeMode(value: unknown): value is JudgeMode {
  return typeof value === 'string' && (VALID_JUDGE_MODES as readonly string[]).includes(value)
}

/**
 * 保存済みの判定モードを読み込む。未保存(キーが無い)、またはJSONとして
 * 壊れている・既知の値でない場合は`DEFAULT_JUDGE_MODE`を返す(例外は投げない)。
 */
export function loadJudgeMode(storage: StorageLike): JudgeMode {
  const raw = storage.getItem(JUDGE_MODE_STORAGE_KEY)
  if (raw === null) return DEFAULT_JUDGE_MODE

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidJudgeMode(parsed) ? parsed : DEFAULT_JUDGE_MODE
  } catch {
    return DEFAULT_JUDGE_MODE
  }
}

/** 判定モードを`localStorage`へ保存する(次回起動時も`loadJudgeMode`で読み戻せる)。 */
export function saveJudgeMode(storage: StorageLike, mode: JudgeMode): void {
  storage.setItem(JUDGE_MODE_STORAGE_KEY, JSON.stringify(mode))
}

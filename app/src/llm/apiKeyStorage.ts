/**
 * T037「任意LLM解説層」のAPIキーの`localStorage`への保存・読み込み・削除。
 *
 * `blunder/storage.ts`(T019)と同じ設計方針(`getItem`/`setItem`のみの最小限
 * インターフェースを介してアクセスし、単体テストでは`Map`ベースのフェイクを注入できる)を
 * 踏襲する。削除機能(要件1)のため`removeItem`も最小限インターフェースに含める。
 *
 * # セキュリティ上の注意(タスク仕様より)
 * APIキーは必ずこの`localStorage`(または同等のクライアントサイドストレージ)にのみ保存し、
 * 本アプリのサーバー(GitHub Pagesは静的ホスティングでサーバーサイド処理が無い)には
 * 一切送信しない。この実装ではAPIキーがブラウザのJavaScript実行コンテキストに露出する
 * (BYOKの原理的な制約)。暗号化保存等の高度な対策はスコープ外(タスク仕様で明示)。
 */

/**
 * 読み込みのみ行う場合の最小限インターフェース。`CommentaryView.tsx`のように
 * 「APIキーの有無を確認するだけ」の呼び出し元は、この読み取り専用の型だけを
 * 要求すればよく、書き込み用の`setItem`/`removeItem`を実装する必要がない。
 */
export interface ApiKeyReader {
  getItem(key: string): string | null
}

/** `localStorage`のうち本モジュールが使う最小限のインターフェース(読み書き両方)。 */
export interface StorageLike extends ApiKeyReader {
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** `localStorage`に保存する際のキー。 */
export const LLM_API_KEY_STORAGE_KEY = 'othello-trainer:llmApiKey'

/**
 * 保存済みのAPIキーを読み込む。未保存(既定、キーが無い)、または空文字列が
 * 保存されている場合は`null`を返す(例外は投げない)。
 */
export function loadApiKey(storage: ApiKeyReader): string | null {
  const raw = storage.getItem(LLM_API_KEY_STORAGE_KEY)
  return raw !== null && raw.length > 0 ? raw : null
}

/** APIキーを`localStorage`へ保存する。 */
export function saveApiKey(storage: StorageLike, apiKey: string): void {
  storage.setItem(LLM_API_KEY_STORAGE_KEY, apiKey)
}

/** 保存済みのAPIキーを削除する(要件1: 設定/解除)。 */
export function clearApiKey(storage: StorageLike): void {
  storage.removeItem(LLM_API_KEY_STORAGE_KEY)
}

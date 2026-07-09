import { useState } from 'preact/hooks'
import { clearApiKey, loadApiKey, saveApiKey, type StorageLike } from './apiKeyStorage.ts'
import './LlmSettings.css'

export interface LlmSettingsProps {
  /** APIキーの状態(設定済みか否か)が変わるたびに呼ばれる(マウント直後、保存済み状態の読み込み後にも1回呼ばれる)。 */
  onChange?: (apiKey: string | null) => void
  /** 保存先。テスト用の差し替え口(省略時は `window.localStorage`)。 */
  storage?: StorageLike
}

/**
 * AI講評機能(T037、設計書§9)のAPIキー設定UI。
 *
 * 既定は未設定(OFF)。ユーザーが自分のAnthropic APIキーを入力・保存・削除できる
 * (要件1)。保存先は`localStorage`(または注入された`storage`)のみで、本アプリの
 * サーバーには一切送信しない(サーバー自体が存在しないGitHub Pages静的配信)。
 *
 * レスポンシブ対応: 375px幅程度でも崩れないよう`LlmSettings.css`で入力欄とボタンを
 * 縦積みにする。
 */
export function LlmSettings({ onChange, storage }: LlmSettingsProps) {
  const store = storage ?? window.localStorage
  const [apiKey, setApiKey] = useState<string | null>(() => loadApiKey(store))
  const [inputValue, setInputValue] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  function handleSave(): void {
    const trimmed = inputValue.trim()
    if (trimmed.length === 0) return
    saveApiKey(store, trimmed)
    setApiKey(trimmed)
    setInputValue('')
    setStatusMessage('APIキーを保存しました。')
    onChange?.(trimmed)
  }

  function handleClear(): void {
    clearApiKey(store)
    setApiKey(null)
    setStatusMessage('APIキーを削除しました。')
    onChange?.(null)
  }

  return (
    <div class="llm-settings">
      <p class="llm-settings__title">AI講評(任意、Anthropic APIキーが必要)</p>
      <p class="llm-settings__desc">
        ご自身のAnthropic Claude APIキーを登録すると、悪手分析パネルや対局まとめでAIによる自然文の講評を生成できます。
        APIキーはこのブラウザのlocalStorageにのみ保存され、Anthropicの公式APIへ直接送信されます(本アプリはGitHub
        Pagesの静的配信のみで、サーバー自体が存在しません)。未設定でも他の全機能は通常どおり利用できます。
      </p>
      <p class="llm-settings__status">現在の状態: {apiKey ? '設定済み' : '未設定'}</p>
      <div class="llm-settings__row">
        <input
          type="password"
          placeholder="sk-ant-..."
          autocomplete="off"
          value={inputValue}
          onInput={(event) => setInputValue((event.target as HTMLInputElement).value)}
        />
        <button type="button" onClick={handleSave} disabled={inputValue.trim().length === 0}>
          保存
        </button>
        {apiKey && (
          <button type="button" onClick={handleClear}>
            削除
          </button>
        )}
      </div>
      {statusMessage && <p class="notice">{statusMessage}</p>}
    </div>
  )
}

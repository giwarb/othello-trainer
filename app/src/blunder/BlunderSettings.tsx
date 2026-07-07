import { useEffect, useState } from 'preact/hooks'
import { loadBlunderConfig, saveBlunderConfig, type StorageLike } from './storage.ts'
import type { BlunderConfig, BlunderMethod } from './types.ts'
import './BlunderSettings.css'

export interface BlunderSettingsProps {
  /** 設定が変わるたびに呼ばれる(マウント直後、保存済み設定の読み込み後にも1回呼ばれる)。 */
  onChange?: (config: BlunderConfig) => void
  /** 保存先。テスト用の差し替え口(省略時は `window.localStorage`)。 */
  storage?: StorageLike
}

const METHOD_OPTIONS: readonly { value: BlunderMethod; label: string }[] = [
  { value: 'worseThanBest', label: '最善手以外は悪手とする' },
  { value: 'lossThreshold', label: '最善手との石差が一定以上なら悪手' },
  { value: 'rankThreshold', label: '順位が一定より下なら悪手' },
]

/**
 * 悪手判定の方式・閾値をユーザーが設定するUI(T019)。
 *
 * 変更のたびに `localStorage`(または注入された `storage`)へ即座に保存し、
 * 次回起動時も `loadBlunderConfig` で読み戻せるようにする。
 *
 * レスポンシブ対応: ラジオボタン群・数値入力は `flex-wrap` で折り返し、
 * 狭い画面幅(375px程度)では閾値入力欄を縦積みにする(`BlunderSettings.css` 参照)。
 */
export function BlunderSettings({ onChange, storage }: BlunderSettingsProps) {
  const store = storage ?? window.localStorage
  const [config, setConfig] = useState<BlunderConfig>(() => loadBlunderConfig(store))

  useEffect(() => {
    onChange?.(config)
    // onChangeは呼び出し側で毎レンダー新しい関数を渡しうるため、依存配列には含めない
    // (含めると設定を変更していないのに無限に発火しうる)。configが変わった時だけ通知する。
    // eslint-disable-next-line
  }, [config])

  function update(partial: Partial<BlunderConfig>): void {
    const next = { ...config, ...partial }
    setConfig(next)
    saveBlunderConfig(store, next)
  }

  return (
    <div class="blunder-settings">
      <p class="blunder-settings__title">悪手判定の設定</p>

      <div class="blunder-settings__methods" role="radiogroup" aria-label="悪手判定方式">
        {METHOD_OPTIONS.map(({ value, label }) => (
          <label class="blunder-settings__method" key={value}>
            <input
              type="radio"
              name="blunder-method"
              value={value}
              checked={config.method === value}
              onChange={() => update({ method: value })}
            />
            {label}
          </label>
        ))}
      </div>

      <div class="blunder-settings__thresholds">
        <label class="blunder-settings__threshold">
          石差の閾値(石)
          <input
            type="number"
            step="0.1"
            min="0"
            value={config.lossThreshold}
            disabled={config.method !== 'lossThreshold'}
            onInput={(event) => {
              const raw = Number((event.target as HTMLInputElement).value)
              update({ lossThreshold: Number.isFinite(raw) ? raw : config.lossThreshold })
            }}
          />
        </label>

        <label class="blunder-settings__threshold">
          順位の閾値(位)
          <input
            type="number"
            step="1"
            min="1"
            value={config.rankThreshold}
            disabled={config.method !== 'rankThreshold'}
            onInput={(event) => {
              const raw = Number((event.target as HTMLInputElement).value)
              update({ rankThreshold: Number.isFinite(raw) ? raw : config.rankThreshold })
            }}
          />
        </label>
      </div>
    </div>
  )
}

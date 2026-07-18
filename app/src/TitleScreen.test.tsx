// @vitest-environment jsdom
/**
 * T137要件4のコンポーネントテスト: ホーム画面のモードカードに進捗の実績行
 * (`ModeCardInfo.progress`)を表示する。
 *
 * データ取得(`app.tsx`側でIndexedDB/localStorageから非同期に集計する処理)は
 * このテストの対象外(`TitleScreen`はpropsで受け取った文字列をそのまま表示する
 * だけの表示コンポーネント)。ここでは「progressが与えられれば表示される」
 * 「与えられなければ(未取得・取得失敗)進捗行自体が描画されない(空状態)」の
 * 2点を検証する。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TitleScreen, type ModeCardInfo } from './TitleScreen.tsx'

describe('TitleScreen', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('progressが与えられたカードには実績行が表示される', async () => {
    const cards: ModeCardInfo[] = [
      { key: 'joseki', label: '定石練習', description: '説明', progress: '今日の復習3本' },
    ]
    await act(async () => {
      render(<TitleScreen cards={cards} onSelect={() => {}} />, container)
    })
    const progress = container.querySelector('.title-screen__card-progress')
    expect(progress).not.toBeNull()
    expect(progress?.textContent).toBe('今日の復習3本')
  })

  it('progressが無いカードには実績行が描画されない(空状態)', async () => {
    const cards: ModeCardInfo[] = [{ key: 'play', label: '対局', description: '説明' }]
    await act(async () => {
      render(<TitleScreen cards={cards} onSelect={() => {}} />, container)
    })
    expect(container.querySelector('.title-screen__card-progress')).toBeNull()
  })

  it('カードをクリックするとonSelectにkeyが渡る', async () => {
    const cards: ModeCardInfo[] = [{ key: 'midgame', label: '中盤練習', description: '説明', progress: 'クリア 5/111' }]
    let selected: string | null = null
    await act(async () => {
      render(<TitleScreen cards={cards} onSelect={(key) => (selected = key)} />, container)
    })
    const card = container.querySelector<HTMLButtonElement>('.title-screen__card')
    await act(async () => {
      card?.click()
    })
    expect(selected).toBe('midgame')
  })
})

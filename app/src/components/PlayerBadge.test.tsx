// @vitest-environment jsdom
/**
 * T136要件1のコンポーネントテスト: プレイヤーバッジ(手番ハイライト・石数表示・
 * 思考中表示)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlayerBadge } from './PlayerBadge.tsx'

describe('components/PlayerBadge', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('ラベル・石数を描画する', async () => {
    await act(async () => {
      render(<PlayerBadge side="black" label="あなた" count={12} active={false} />, container)
    })
    expect(container.textContent).toContain('あなた')
    expect(container.textContent).toContain('12')
  })

  it('activeがtrueのときだけ手番ハイライトのクラスが付く', async () => {
    await act(async () => {
      render(<PlayerBadge side="black" label="あなた" count={2} active={true} />, container)
    })
    const badge = container.querySelector('.player-badge')
    expect(badge?.classList.contains('player-badge--active')).toBe(true)
    expect(badge?.getAttribute('aria-current')).toBe('true')

    await act(async () => {
      render(<PlayerBadge side="black" label="あなた" count={2} active={false} />, container)
    })
    const badgeInactive = container.querySelector('.player-badge')
    expect(badgeInactive?.classList.contains('player-badge--active')).toBe(false)
    expect(badgeInactive?.getAttribute('aria-current')).toBeNull()
  })

  it('side("black"/"white")に応じた色クラスが付く', async () => {
    await act(async () => {
      render(<PlayerBadge side="white" label="CPU" count={2} active={false} />, container)
    })
    const badge = container.querySelector('.player-badge')
    expect(badge?.classList.contains('player-badge--white')).toBe(true)
    expect(badge?.classList.contains('player-badge--black')).toBe(false)
  })

  it('thinkingがtrueのときだけ「考え中...」を表示する', async () => {
    await act(async () => {
      render(<PlayerBadge side="white" label="CPU" count={2} active={true} thinking={true} />, container)
    })
    expect(container.textContent).toContain('考え中...')
    expect(container.querySelector('.player-badge__thinking')).not.toBeNull()

    await act(async () => {
      render(<PlayerBadge side="white" label="CPU" count={2} active={true} thinking={false} />, container)
    })
    expect(container.textContent).not.toContain('考え中...')
    expect(container.querySelector('.player-badge__thinking')).toBeNull()
  })

  it('thinking省略時は既定でfalse扱い(表示しない)', async () => {
    await act(async () => {
      render(<PlayerBadge side="black" label="あなた" count={2} active={false} />, container)
    })
    expect(container.querySelector('.player-badge__thinking')).toBeNull()
  })
})

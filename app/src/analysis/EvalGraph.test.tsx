// @vitest-environment jsdom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvalGraph, type EvalGraphPoint } from './EvalGraph.tsx'

const POINTS: readonly EvalGraphPoint[] = [
  { ply: 0, value: -2.75, isExact: false, evalSource: 'midgame' },
  { ply: 1, value: -1.84, isExact: false, evalSource: 'midgame' },
]

describe('EvalGraph', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('値フォーマッター省略時のツールチップは従来どおり整数表示する', async () => {
    await act(async () => {
      render(<EvalGraph points={POINTS} markers={[]} />, container)
    })

    const svg = container.querySelector<SVGSVGElement>('.eval-graph__svg')
    expect(svg).not.toBeNull()
    vi.spyOn(svg!, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 320 } as DOMRect)
    await act(async () => {
      svg?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 32 }))
    })

    expect(container.querySelector('.eval-graph__tooltip')?.textContent).toContain('評価値: -3石(黒視点)')
  })
})

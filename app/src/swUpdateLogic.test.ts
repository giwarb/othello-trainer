import { describe, expect, it } from 'vitest'
import { shouldNotifyUpdate } from './swUpdateLogic.ts'

describe('shouldNotifyUpdate', () => {
  it('既存のコントローラーが無い(初回インストール)場合はinstalledでも通知しない', () => {
    expect(shouldNotifyUpdate(false, 'installed')).toBe(false)
  })

  it('既存のコントローラーがある状態でinstalledになったら通知する(=更新)', () => {
    expect(shouldNotifyUpdate(true, 'installed')).toBe(true)
  })

  it('installed以外の状態では通知しない(既存コントローラーがあっても)', () => {
    expect(shouldNotifyUpdate(true, 'installing')).toBe(false)
    expect(shouldNotifyUpdate(true, 'activating')).toBe(false)
    expect(shouldNotifyUpdate(true, 'activated')).toBe(false)
    expect(shouldNotifyUpdate(true, 'redundant')).toBe(false)
    expect(shouldNotifyUpdate(true, 'parsed')).toBe(false)
  })

  it('既存コントローラーが無くinstalled以外の場合も通知しない', () => {
    expect(shouldNotifyUpdate(false, 'activated')).toBe(false)
  })
})

import { defineConfig } from 'vitest/config'

// 単体テストはロジックのみを対象とする(実際のWASM/Workerは起動しない)ため、
// 軽量な 'node' 環境で十分。詳細は tasks/T012-worker-engine.md 参照。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

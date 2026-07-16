import { defineConfig } from 'vitest/config'

// 単体テストはロジックのみを対象とする(実際のWASM/Workerは起動しない)ため、
// 軽量な 'node' 環境で十分。詳細は tasks/T012-worker-engine.md 参照。
// `.test.tsx`(コンポーネントテスト)はファイル単位で`// @vitest-environment jsdom`
// を指定して個別にjsdom環境を使う(T115、`app.playmode.test.tsx`参照)。
// デフォルト環境は変更しない(既存の`.test.ts`群は全て'node'のまま)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})

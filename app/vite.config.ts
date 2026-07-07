import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages (プロジェクトページ) 配信用。
  // 本番ビルド時のみ `/othello-trainer/` を適用し、`npm run dev` には影響させない。
  base: command === 'build' ? '/othello-trainer/' : '/',
  plugins: [preact()],
}))

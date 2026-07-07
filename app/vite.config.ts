import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages (プロジェクトページ) 配信用。
  // 本番ビルド時(`vite build`)とビルド成果物のプレビュー時(`vite preview`、
  // `isPreview === true`)にのみ `/othello-trainer/` を適用し、
  // `npm run dev` には影響させない。
  // 注意: `vite preview` に対して `command` は `'serve'` になる(`'build'`
  // にはならない)ため、`command === 'build'` だけで判定すると
  // `npm run preview` 時に `base` が `/` に戻ってしまい、`dist/index.html`
  // に焼き込まれた `/othello-trainer/...` 参照と実際の配信パスが
  // 食い違って全リクエストがSPAフォールバック(index.htmlの200応答)に
  // なってしまう(T014のPWA動作確認中に発見)。
  base: command === 'build' || isPreview ? '/othello-trainer/' : '/',
  plugins: [preact()],
}))

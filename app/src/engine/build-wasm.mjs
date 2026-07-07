#!/usr/bin/env node
// `engine/` クレート(Rust/WASMオセロエンジン)を `wasm-pack build --target web`
// でビルドし、`/app` から `import` できる `app/src/engine/pkg/` に出力する。
// `npm run dev` / `npm run build` / `npm run typecheck` の前に自動実行される
// (`package.json` の `predev`/`prebuild`/`pretypecheck` スクリプト参照)。
//
// 出力先 `app/src/engine/pkg/` はビルド成果物のため `.gitignore` 対象。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// このスクリプトの場所(app/src/engine)からの相対パスで、実行時のカレント
// ディレクトリに依存せず engine クレート/出力先を解決する。
const engineCrateDir = path.resolve(__dirname, '../../../engine');
const outDir = path.resolve(__dirname, 'pkg');

console.log(`[build-wasm] wasm-pack build ${engineCrateDir} --target web --out-dir ${outDir}`);

const result = spawnSync(
  'wasm-pack',
  ['build', engineCrateDir, '--target', 'web', '--out-dir', outDir, '--out-name', 'engine'],
  { stdio: 'inherit', shell: true },
);

if (result.error) {
  console.error('[build-wasm] failed to spawn wasm-pack:', result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

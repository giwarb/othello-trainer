#!/usr/bin/env node
// ビルドごとに `dist/sw.js` 内の `CACHE_VERSION` プレースホルダー
// (`__BUILD_VERSION__`)を、実際のビルドごとに一意な値へ書き換える。
//
// 背景: `app/public/sw.js` はViteの `publicDir` としてビルド時に無変換で
// `dist/` へコピーされるだけなので、ソース側でビルド変数を展開できない。
// そのため `npm run build`(`vite build` の後)にこのスクリプトを実行し、
// コピー後の `dist/sw.js` に対して文字列置換で値を注入する。
//
// バージョン値は「gitコミットハッシュ + ビルド時刻(ms)」。コミットハッシュに
// より通常のデプロイ(コミット単位)でのバージョン変化を保証しつつ、
// git が使えない環境(.gitが無い状態でのビルド等)ではビルド時刻のみに
// フォールバックし、同一コミットからの再ビルドでも値が変わることを保証する。
//
// 参照: tasks/T023-sw-cache-versioning-fix.md
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distSwPath = path.resolve(appRoot, 'dist/sw.js');
const PLACEHOLDER = '__BUILD_VERSION__';
// 置換対象は `const CACHE_VERSION = '__BUILD_VERSION__';` という代入行そのものに
// 限定する(単純な文字列置換だと、`app/public/sw.js` のコメント中でプレースホルダー
// 名を説明のために言及している箇所まで巻き込んで置換されてしまい、本番配信物の
// コメントが「実ビルド値そのものがプレースホルダーである」という自己矛盾した
// 意味不明な文になってしまうバグがあったため、代入行限定に修正した。
// 参照: tasks/T023-sw-cache-versioning-fix.md フィードバック)。
const ASSIGNMENT_PATTERN = new RegExp(
  `const CACHE_VERSION = '${PLACEHOLDER}';`,
);

function resolveVersion() {
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (hash) {
      return `${hash}-${Date.now()}`;
    }
  } catch {
    // git コマンドが無い/gitリポジトリ外など。タイムスタンプのみにフォールバックする。
  }
  return `${Date.now()}`;
}

function main() {
  if (!existsSync(distSwPath)) {
    console.error(`[inject-sw-version] dist/sw.js が見つかりません: ${distSwPath}`);
    process.exit(1);
  }

  const original = readFileSync(distSwPath, 'utf8');
  if (!ASSIGNMENT_PATTERN.test(original)) {
    console.error(
      `[inject-sw-version] dist/sw.js に "const CACHE_VERSION = '${PLACEHOLDER}';" という代入行が` +
        ' 見つかりません。app/public/sw.js の CACHE_VERSION 定義を確認してください。',
    );
    process.exit(1);
  }

  const version = resolveVersion();
  const updated = original.replace(
    ASSIGNMENT_PATTERN,
    `const CACHE_VERSION = '${version}';`,
  );
  writeFileSync(distSwPath, updated, 'utf8');
  console.log(`[inject-sw-version] dist/sw.js の CACHE_VERSION を "${version}" に設定しました。`);
}

main();

---
id: T010
title: /app フロントエンド雛形(Vite + Preact + TypeScript)
status: done
assignee: implementer
attempts: 0
---

# T010: /app フロントエンド雛形(Vite + Preact + TypeScript)

## 目的
GitHub Pagesで実際に遊べるオセロアプリのフロントエンド開発基盤を作る。以降のUI関連タスク(T011〜)はこの上に積み上がる。

## 背景・コンテキスト
- リポジトリルート `C:\Users\yoshi\work\othello-trainer` には現在 `/engine`(Rust/WASMエンジン、フェーズ1完了済み)のみ存在し、`/app` はまだ存在しない。
- 設計書 `othello-trainer-design.md` §2.3: UI は依存最小(Preact + TS 程度)。Canvas 1枚で盤面表示。
- 設計書 §2.13 のリポジトリ構成に従い、`/app` ディレクトリにフロントエンドを配置する。
- ビルドツールは **Vite** を使用する(Preact公式テンプレート `npm create vite@latest -- --template preact-ts` 相当。TypeScript必須)。
- このマシンには Node.js v22.13.0 / npm 11.5.1 がインストール済み(T001時点で確認済み)。

## 変更対象(新規作成)
- `app/` ディレクトリ(Vite + Preact + TypeScript プロジェクト一式: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app.tsx` 等)
- `app/.gitignore`(`node_modules/`, `dist/` 等。ルートの `.gitignore` に `node_modules/`/`dist/` が既にあれば重複不要、確認の上で判断してよい)

## 要件
1. `npm create vite@latest app -- --template preact-ts` 相当の手順(または手動でも同等の構成になれば可)で `/app` にプロジェクトを作成する。
2. `vite.config.ts` に GitHub Pages 配信を見据えた `base` 設定を入れる。**リポジトリ名は `othello-trainer`**(GitHubリモート: `https://github.com/giwarb/othello-trainer.git`)。GitHub Pagesでプロジェクトページとして配信する場合、`base: '/othello-trainer/'` が必要になる(本タスクではこの設定を入れておき、実際のデプロイ確認はT015で行う)。ただし開発時(`npm run dev`)に支障が出ないよう、`base` は本番ビルド時のみ適用される標準的な設定にすること(Viteのデフォルト挙動で問題ない)。
3. `package.json` に以下のnpmスクリプトを用意する: `dev`(開発サーバ起動)、`build`(本番ビルド、`dist/`に出力)、`preview`(ビルド結果のプレビュー)、`typecheck`(`tsc --noEmit`)。
4. TypeScriptの `strict: true` を有効にする。
5. 最低限のプレースホルダー画面(例:「オセロトレーナー」という見出しだけのページ)が表示され、`npm run build` が成功することを確認する。
6. ルートの `.gitignore` に `app/node_modules/` `app/dist/` が含まれていることを確認する(無ければ追加してよいが、これは `.gitignore` の変更なので、**この変更のみ**タスクファイルではなくソースの一部としてコミットに含めてよい。`.gitignore`はビルド設定ファイルでありオーケストレーター管理下の`tasks/`/`CLAUDE.md`ではないため、通常通りimplementerが変更・コミットする)。

## やらないこと(スコープ外)
- 盤面描画・ゲームロジック(T011)
- Web Worker・エンジン統合(T012)
- 対局モードの実装(T013)
- PWA設定(T014)
- GitHub Pagesへの実際のデプロイ設定(T015)
- スタイリング・デザインの作り込み(最低限のプレースホルダーで良い)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm install` が成功する
- [ ] `cd app && npm run build` が成功し、`app/dist/` にファイルが生成される
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm run dev` でローカル開発サーバが起動し、ブラウザでプレースホルダーページが表示できる(起動確認のみでよい。起動後はプロセスを終了してよい)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-07 implementer: `npm create vite@latest app -- --template preact-ts` で `/app` に雛形を生成。

実施内容:
- `vite.config.ts`: `defineConfig(({ command }) => ({ base: command === 'build' ? '/othello-trainer/' : '/', plugins: [preact()] }))` とし、本番ビルド時のみ `base: '/othello-trainer/'` を適用(`npm run dev` は `/` のまま影響なし)。
- `tsconfig.app.json` / `tsconfig.node.json` に `"strict": true` を追加。
- `package.json` に `"typecheck": "tsc --noEmit -p tsconfig.app.json"` を追加(プロジェクト参照構成のため対象を `tsconfig.app.json` に明示指定。ルートの `tsconfig.json` は `files: []` の参照専用構成のため)。
- `src/app.tsx` / `src/app.css` / `src/index.css` / `index.html` のタイトルを、Vite公式デモ要素(カウンターボタン・ロゴ・リンク集)から「オセロトレーナー」の見出しのみの最低限プレースホルダーに置換。未使用となったデモ用アセット(`src/assets/hero.png`, `preact.svg`, `vite.svg`, `public/icons.svg`)は削除。
- ルートの `.gitignore` は `node_modules/` `dist/` (先頭 `/` なしパターンで全階層にマッチ)を既に含んでおり `app/node_modules/` `app/dist/` は追加変更なしでカバー済みと確認(`git check-ignore -v` で確認)。ルート `.gitignore` は変更していない。`app/.gitignore` はVite生成のものをそのままコミット(root側と重複するが要件上許容)。

検証結果(すべて実行し確認):
- `cd app && npm install` → 成功(122 packages added, 0 vulnerabilities)。
- `cd app && npm run build` → 成功。`app/dist/` に `index.html` / `assets/*.js` / `assets/*.css` / `favicon.svg` が生成され、`dist/index.html` 内のアセットパスが `/othello-trainer/...` になっていることを確認。
- `cd app && npm run typecheck` → エラー0で完了。
- `cd app && npm run dev` → `http://localhost:5173/` で起動を確認。`curl` でHTMLを取得し `<title>オセロトレーナー</title>` と `<div id="app">` を含むこと、アセットパスが `/`(baseプレフィックスなし)であることを確認。確認後プロセスは終了済み。

コミット: `bf45d6e` "app: Vite+Preact+TS雛形を作成(T010)"(`app/` 配下13ファイルのみ。`tasks/`・`CLAUDE.md`・ルート`.gitignore`は含まず)。

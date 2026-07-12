---
id: T015
title: GitHub Pagesへのデプロイ設定
status: done
assignee: implementer
attempts: 0
---

# T015: GitHub Pagesへのデプロイ設定

## 目的
`/app` のビルド成果物をGitHub Pagesに自動デプロイし、実際にブラウザで遊べる公開URLを用意する。これがユーザーの依頼「GitHub Pagesで遊べる状態にする」の最終ステップ。

## 背景・コンテキスト
- 前提: T010〜T014すべて完了済み(`/app` がビルド可能で、対局モードが動作する状態)。
- GitHubリモート: `https://github.com/giwarb/othello-trainer.git`(`gh` CLIで認証済み、push可能)。
- `/app` のビルドには **Node.js(フロントエンド)と Rust/wasm-pack(エンジン)の両方**が必要(T012で `/app` のビルド時にengineクレートをwasm-packでビルドする仕組みを作った)。そのため、GitHub ActionsのCI環境にも両方をセットアップする必要がある。
- GitHub Pagesの配信方式は「Actions からのデプロイ」(`actions/deploy-pages`)を使う(gh-pagesブランチ方式ではなく、モダンなGitHub Actions配信方式を推奨)。

## 変更対象(新規作成)
- `.github/workflows/deploy-pages.yml`: mainブランチへのpush時に、Rustツールチェーン+wasm-packのセットアップ→`/app`のビルド(`npm ci && npm run build`)→ビルド成果物(`app/dist/`)をGitHub Pagesにデプロイするワークフロー

## 要件
1. ワークフローのトリガーは `push: branches: [main]`(および `workflow_dispatch` で手動実行も可能にする)。
2. ジョブ内で以下を行う:
   - `actions/checkout@v4`
   - Rustツールチェーンのセットアップ(`dtolnay/rust-toolchain@stable` 等の一般的なaction、または `rustup` を直接叩くシェルコマンドでもよい)+ `wasm32-unknown-unknown` ターゲット追加
   - `wasm-pack` のインストール(`cargo install wasm-pack` は毎回時間がかかるため、可能であれば `jetli/wasm-pack-action` のような既製actionを使うか、キャッシュを効かせる。実装者の判断で構わないが、CI実行時間が現実的な範囲(15分程度以内が目安)に収まるよう配慮すること)
   - Node.jsのセットアップ(`actions/setup-node@v4`, Node 22系)
   - `cd app && npm ci && npm run build`(T012のprebuildスクリプトにより、この中でengineのwasmビルドも走る)
   - `actions/configure-pages@v5`
   - `actions/upload-pages-artifact@v3`(`app/dist` を指定)
   - `actions/deploy-pages@v4`
3. ワークフローの `permissions` に `pages: write`, `id-token: write` を設定する。
4. `deploy` ジョブに `environment: github-pages` を設定し、`environment.url` に `steps.deployment.outputs.page_url` を設定する(GitHub Actionsの標準的なPages deployパターン)。
5. ワークフローファイルを作成・コミットした後、**実際に `git push` してGitHub Actions上でワークフローを実行し、成功することを確認する**。これは本タスクの中核的な受け入れ基準であり、単にYAMLを書くだけでは不十分。`gh workflow run` または通常のpushでトリガーし、`gh run watch`(または `gh run list` → `gh run view <id> --log`)でビルドが成功するかを確認すること。
6. GitHub Pagesの設定(リポジトリの Settings > Pages > Source を "GitHub Actions" にする)が必要な場合は `gh api` 経由で設定を確認・変更する(`gh api repos/giwarb/othello-trainer/pages` で現在の設定を確認し、未設定なら `gh api -X POST repos/giwarb/othello-trainer/pages -f build_type=workflow` 等で有効化する。GitHub CLI/APIの仕様変更で手順が異なる場合は、実装者の判断で適切な方法を取ってよい)。
7. デプロイが成功したら、公開URL(`https://giwarb.github.io/othello-trainer/`)に実際にアクセスして(WebFetchツール等で)、ページが200 OKで返り、アプリのHTMLが含まれていることを確認する。可能であれば主要なJSファイル・WASMファイルも200で取得できるか確認する。

## やらないこと(スコープ外)
- カスタムドメインの設定
- デプロイのロールバック機能
- 複数環境(staging/production)の切り分け
- E2Eテスト(Playwright等)の導入(将来検討)

## 受け入れ基準(検証コマンド)
- [ ] `.github/workflows/deploy-pages.yml` がリポジトリにコミット・push済みである
- [ ] `gh run list --workflow=deploy-pages.yml --limit 3` で直近の実行が `success` になっている
- [ ] 公開URL `https://giwarb.github.io/othello-trainer/` にアクセスすると200が返り、アプリのHTMLが取得できる

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-07 implementer:
- `.github/workflows/deploy-pages.yml` を新規作成。トリガーは `push: branches: [main]` と `workflow_dispatch`。
  - `dtolnay/rust-toolchain@stable`(`targets: wasm32-unknown-unknown`) + `actions/cache@v4`(cargoレジストリ/target)
  - `jetli/wasm-pack-action@v0.4.0` で wasm-pack をインストール(毎回ビルドせず高速)
  - `actions/setup-node@v4`(Node 22、npm cacheあり)
  - `cd app && npm ci && npm run build`(T012のprebuildでengineのwasmビルドも実行される)
  - `actions/configure-pages@v5` → `actions/upload-pages-artifact@v3`(`app/dist`) → `actions/deploy-pages@v4`
  - `permissions: pages: write, id-token: write`、`deploy` ジョブに `environment: github-pages` + `url: steps.deployment.outputs.page_url`
- ローカル環境ではこのシェルセッションのPATHにcargo/wasm-packが見つからなかった(bash/PowerShellいずれも不可)ため、ローカルでのビルド疎通確認は省略し、CI実行結果で検証した。
- GitHub Pagesの配信設定: `gh api repos/giwarb/othello-trainer/pages` は事前は404(未設定)だったため、`gh api -X POST repos/giwarb/othello-trainer/pages -f build_type=workflow` で有効化(`html_url: https://giwarb.github.io/othello-trainer/`)。
- `git add .github/workflows/deploy-pages.yml` のみをステージしてコミット(CLAUDE.md/tasks配下の他ファイルの未コミット変更には触れていない)。`git push origin main` を実行し、ローカルの14コミット(T001〜T014含む)+本タスクのコミットをまとめてpush。
- `gh run watch 28866545148` でワークフロー実行を監視し、`build`(46s)→`deploy`(9s)ともに成功。合計約1分5秒で完了(15分以内の目安を大きく下回る)。
- 検証結果:
  - `gh run list --workflow=deploy-pages.yml --limit 3` → `completed success`(run ID 28866545148)
  - `curl -s -o /dev/null -w "%{http_code}"` で以下すべて200を確認:
    - `https://giwarb.github.io/othello-trainer/`(index.html、`<div id="app">` 等アプリのHTMLを含む)
    - `assets/index-DyVlM8Rp.js`, `assets/index-BYgDSAdI.css`
    - `assets/worker-RmT7fNvr.js`(Web Worker)
    - `assets/engine_bg-DBqxsAxp.wasm`(Content-Type: application/wasm)
    - `manifest.json`
- 受け入れ基準はすべて満たしている。ワークフロー実行ログ内に「Node.js 20 is deprecated」の警告アノテーションが出ているが、実行自体には失敗しておらず対応不要と判断(将来actionsのバージョンアップ時に解消される想定)。

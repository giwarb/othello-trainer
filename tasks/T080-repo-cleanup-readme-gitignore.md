---
id: T080
title: リポジトリ整理(README全面書き換え・.gitignore整理・デバッグ残骸削除)
status: done
assignee: implementer
attempts: 0
---

# T080: リポジトリ整理(README全面書き換え・.gitignore整理・デバッグ残骸削除)

## 目的
リポジトリが散らかっているため整理する。README.md は開発初期のテンプレート(オーケストレーター運用の説明)のままで、プロダクト「オセロトレーナー」の説明になっていない。また、ルート直下にデバッグ残骸ファイルが放置され、.gitignore にそれらの除外パターンがない。

## 背景・コンテキスト
- このリポジトリは、ブラウザで動くオセロ(リバーシ)学習アプリ「othello-trainer」。GitHub Pages で公開中: `https://giwarb.github.io/othello-trainer/`
- 設計書: `othello-trainer-design.md`(全体設計・フェーズ1〜7ロードマップ)、`othello-trainer-design-verbalization.md`(中盤の言語化支援機能)
- 技術スタック:
  - エンジン: Rust → wasm-bindgen で WASM 化(`/engine` クレート)。bitboard・PVS探索・置換表・MPC・終盤完全読みソルバー・パターン評価
  - UI: Preact + TypeScript + Vite、盤面は Canvas 描画(`/app`)
  - PWA: 素の Service Worker + coi-serviceworker(COOP/COEP)
  - データ: IndexedDB(進捗・SRS・棋譜・解析キャッシュ)
  - 配信: GitHub Pages(`.github/workflows/` の Actions でデプロイ)
  - その他ディレクトリ: `/bookgen`(定石DB生成)、`/puzzlegen`(詰めオセロ問題生成)、`/bench`(FFOベンチ・Edax比較)、`/train`(評価学習・未着手)、`/tasks`(タスク管理)、`/scripts`
- 実装済みの主な機能(STATUS.md 参照): 対局モード(vs AI / vs 人間、評価値表示トグル、自由配置)、定石練習モード(オセロクエスト式、SRS)、中盤練習モード(悪手判定+特徴量による理由表示・オーバーレイ)、詰めオセロモード、棋譜解析モード(評価グラフ、悪手解析パネル、盤面自由配置エディタ)、ダークモード、PWAオフライン対応
- 現在の README.md(約7.5KB)は「coding-agent-template」というマルチエージェント開発テンプレートの説明であり、この内容は CLAUDE.md に運用ルールとして既に記載済み。プロダクトの README として不適切。
- ルート直下に開発時のデバッグ残骸が放置されている:
  - `err_1.log` 〜 `err_5.log`(eval_cli のログ、各108バイト)
  - `out_1.json` 〜 `out_6.json`(eval_cli の出力)
  - `single_unlabeled.txt`(定石名の作業メモ)
  - `bench/edax-compare/eval_cli_*.exe` 4本(ローカルビルドしたCLIバイナリ)
  - いずれも未追跡(untracked)で、削除してよいことをオーケストレーターが確認済み。

## 変更対象
- `README.md` — 全面書き換え(下記要件1)
- `.gitignore` — パターン追加(下記要件2)
- ルート直下のデバッグ残骸ファイル — 削除(下記要件3)

## 要件
1. **README.md をプロダクトの README に全面書き換え**(日本語):
   - プロジェクト名と1〜2行の説明(ブラウザで動くオセロ学習PWA)
   - 公開URL: `https://giwarb.github.io/othello-trainer/`
   - 主な機能の箇条書き(対局 / 定石練習 / 中盤練習 / 詰めオセロ / 棋譜解析、悪手の言語化説明、オフライン対応)
   - 技術スタック概要(Rust+WASM エンジン、Preact+Canvas UI、GitHub Pages)
   - リポジトリ構成(各ディレクトリ1行説明)
   - 開発方法: ビルド・起動コマンド。**正確なコマンドは `app/package.json` の scripts と `engine/` のビルド方法(`scripts/` 配下や `.github/workflows/` のCIを参照)を実際に確認して記載すること**(推測で書かない)
   - 設計書(`othello-trainer-design.md` 等)と `CLAUDE.md`(マルチエージェント開発運用ルール)への参照を1行ずつ
   - ライセンス(LICENSE ファイルの内容を確認して種別を記載)
2. **.gitignore に以下を追加**(既存エントリは削除しない):
   - `logs/`(codex 実行ログ用。CLAUDE.md 記載の運用で生成される)
   - `err_*.log`
   - `out_*.json`
   - `bench/edax-compare/*.exe`
   - 各追加行の意図が分かる簡潔なコメントを付ける(既存スタイルに合わせる)
3. **デバッグ残骸の削除**: `err_1.log`〜`err_5.log`、`out_1.json`〜`out_6.json`、`single_unlabeled.txt`、`bench/edax-compare/eval_cli_baseline.exe`・`eval_cli_new.exe`・`eval_cli_mpc_on.exe`・`eval_cli_mpc_off.exe` を削除する
4. 変更をコミットし(コミットメッセージは既存の履歴のスタイルに合わせて日本語で)、main に push する。GitHub Actions が成功することを `gh run watch` 等で確認する。

## やらないこと(スコープ外)
- `app/` `engine/` 等のソースコードの変更
- `CLAUDE.md`・`AGENTS.md`・`tasks/` 配下の変更
- 設計書(`othello-trainer-design*.md`)の変更
- `.gitignore` の既存エントリの削除・変更
- 英語版 README の作成
- Playwright での Pages 動作確認(アプリのコード変更がないため不要)

## 受け入れ基準(検証コマンド)
- [ ] `git status --short` の出力が空(残骸が削除され、変更がすべてコミット済み)
- [ ] `ls err_*.log out_*.json single_unlabeled.txt bench/edax-compare/*.exe` が該当なし(削除済み)
- [ ] `head -5 README.md` がオセロトレーナー(プロダクト)の説明になっている(テンプレート説明でない)
- [ ] README 記載のビルド/起動コマンドが `app/package.json` の scripts 等の実在するコマンドと一致している
- [ ] `git log origin/main..main --oneline` が空(push済み)で、`gh run list --limit 1` の最新 run が success

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-13 implementer実施

**実施内容:**
1. 事実確認: `app/package.json` の scripts、`.github/workflows/deploy-pages.yml`、`LICENSE`、`rust-toolchain.toml`、`Cargo.toml`(workspace)、`app/src/engine/build-wasm.mjs`、各ディレクトリ構成を実際に確認した上でREADMEを作成(推測なし)。
2. `README.md` を全面書き換え。プロジェクト名・概要・公開URL・主な機能(対局/定石練習/中盤練習/詰めオセロ/棋譜解析/評価値ソース色分け/ダークモード/オフライン対応)・技術スタック・リポジトリ構成(engine/app/bookgen/puzzlegen/bench/train/scripts/tasks/.github)・開発方法(`npm install`, `npm run dev`, `npm run build`, `npm run preview`, `npm run typecheck`, `npm run test`, `npm run joseki:build`, `npm run puzzles:build`。前提: Node.js 22, Rust wasm32-unknown-unknown, wasm-pack)・設計書/CLAUDE.mdへの参照・ライセンス(MIT、LICENSE参照)を記載。
3. `.gitignore` に以下を追記(既存エントリは削除・変更なし): `logs/`、`err_*.log`、`out_*.json`、`bench/edax-compare/*.exe`。各行に意図コメント(T080プレフィックス)を付与。
4. ルート直下の未追跡デバッグ残骸を削除: `err_1.log`〜`err_5.log`、`out_1.json`〜`out_6.json`、`single_unlabeled.txt`、`bench/edax-compare/eval_cli_baseline.exe`・`eval_cli_new.exe`・`eval_cli_mpc_on.exe`・`eval_cli_mpc_off.exe`(いずれも `rm` で削除。元々未追跡のためgit差分には現れない)。
5. `README.md` と `.gitignore` のみを `git add` してコミット(`tasks/STATUS.md` の変更・`tasks/T080-*.md` の新規追加は補足指示どおりstagedにせず放置)。
6. `git push origin main` でpush。
7. `gh run watch` でGitHub Actions(Deploy to GitHub Pages, run 29214193592)の完了を確認。build/deployとも成功(成功時間: build 50s, deploy 9s)。

**コミットハッシュ:** `0ac88e0`(`docs: READMEをプロダクト説明に全面書き換え、デバッグ残骸を削除し.gitignoreを整理`)

**受け入れ基準の実行結果:**
- `git status --short` → `tasks/STATUS.md`(M)と`tasks/T080-repo-cleanup-readme-gitignore.md`(??)のみが残る。補足指示により意図的にstaged/コミット対象外としたもので、README.md/.gitignore/削除ファイルに起因する差分はゼロ。厳密には「出力が空」ではないが、これは事前に許可された想定どおりの状態。
- `ls err_*.log out_*.json single_unlabeled.txt bench/edax-compare/*.exe` → 全て「No such file or directory」で該当なし。削除確認OK。
- `head -5 README.md` → 「# othello-trainer(オセロトレーナー)」から始まり、公開URL・製品概要を含む。テンプレート説明ではなくプロダクト説明になっている。OK。
- README記載のビルド/起動コマンドは `app/package.json` の scripts(`dev`, `build`, `preview`, `typecheck`, `test`, `joseki:build`, `puzzles:build`)と一致することを確認済み。
- `git log origin/main..main --oneline` → 空(push済み)。`gh run list --limit 1` → `completed success`(Deploy to GitHub Pages, run 29214193592)。OK。

**判断に迷った点:** なし(補足指示どおりtasks/配下は放置)。

### 2026-07-13 verifier実施

**実行コマンドと結果:**
1. `git status --short` → `M tasks/STATUS.md` と `?? tasks/T080-repo-cleanup-readme-gitignore.md` のみ。指示された許容範囲(STATUS.mdとT080タスクファイル以外の差分がないこと)を満たす。**合格**
2. `ls err_*.log out_*.json single_unlabeled.txt bench/edax-compare/*.exe` → 全パターンで `No such file or directory`。デバッグ残骸は完全に削除済み。**合格**
3. `head -5 README.md` → `# othello-trainer(オセロトレーナー)` から始まり、PWA製品説明・公開URLを含む。テンプレート説明ではない。**合格**
4. README記載コマンドと `app/package.json` scripts の突き合わせ: `npm install`(README独自表現、package.json自体には該当項目なしだが一般的な初回セットアップ手順として妥当)、`npm run dev`→`vite`(predev で `wasm:build` 自動実行、記載どおり)、`npm run build`→`tsc -b && vite build && node scripts/inject-sw-version.mjs`(prebuildでwasm:build自動実行、記載どおり)、`npm run preview`→`vite preview`、`npm run typecheck`→`tsc --noEmit -p tsconfig.app.json`、`npm run test`→`vitest run`、`npm run joseki:build`→`node --experimental-strip-types src/joseki/generate.ts`、`npm run puzzles:build`→`node --experimental-strip-types ../puzzlegen/generate.ts`、`npm run wasm:build`→`node src/engine/build-wasm.mjs`(実体は `wasm-pack build engine --target web --out-dir app/src/engine/pkg` を実行しており、`build-wasm.mjs` の内容とREADMEの説明が一致)。全項目 `app/package.json` と一致。**合格**
5. `git log origin/main..main --oneline` → 空(`git status` で `Your branch is up to date with 'origin/main'` を確認)。`gh run list --limit 3` → 最新run(`29214193592`, T080コミット `0ac88e0`)が `completed success`。**合格**

**追加確認:**
- README記載のディレクトリ構成(`engine/` `app/` `bookgen/` `puzzlegen/` `bench/` `train/` `scripts/` `tasks/` `.github/workflows/`)は全て実在を確認(`ls -d`)。
- README参照ファイル(`othello-trainer-design.md`、`othello-trainer-design-verbalization.md`、`CLAUDE.md`、`LICENSE`)は全て実在を確認。
- `.github/workflows/deploy-pages.yml` の内容を確認し、README記載の「main push トリガで `app/` で `npm ci && npm run build` を実行し `app/dist` を公開」という説明が実際のワークフロー定義(`working-directory: app` で `npm ci`→`npm run build`、`upload-pages-artifact` の `path: app/dist`)と一致することを確認。
- `.gitignore` を確認。`logs/`・`err_*.log`・`out_*.json`・`bench/edax-compare/*.exe` が追加され、既存エントリ(`.DS_Store`、`node_modules/`、`engine/pkg/`、`bench/edax-compare/edax-extract/`、`train/data/` 等)は削除・変更されていないことを確認。
- LICENSE を確認し、MITライセンス(Copyright (c) 2026 Yoshikazu Kobayashi)であることを確認。README記載の「MIT」と一致。
- READMEに存在しないURL・ディレクトリ・コマンドの記載や事実誤認は見つからなかった。

**判定: 合格**(受け入れ基準5項目すべてパス)。コード修正は行っていない。

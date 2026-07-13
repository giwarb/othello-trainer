---
id: T081
title: Codex(gpt-5.6-sol)を設計・最終レビュー担当として使うラッパースクリプトの作成
status: in_progress
assignee: implementer
attempts: 0
---

# T081: Codex(gpt-5.6-sol)を設計・最終レビュー担当として使うラッパースクリプトの作成

## 目的
現在ワーカーはすべて Claude Code サブエージェント(Sonnet)だが、**難しい設計**と**done 判定前の最終レビュー**だけは、外部の Codex CLI 上の上位モデル `gpt-5.6-sol` に委譲したい(ユーザー指示 2026-07-13)。Claude Code の外に出る連携なので、「依頼ファイル → スクリプト → レポートファイル」というファイル契約に閉じ込め、オーケストレーターがレポートファイルだけを読めば判断できる形にする。

## 背景・コンテキスト
- 既存の前例: `scripts/codex-task.ps1` / `codex-task.sh`(実装タスクを Codex に丸ごと委譲するラッパー)。本タスクはその姉妹スクリプトを作る。スタイル・引数の流儀・ログの置き方はこれに合わせること。
- Codex CLI はインストール済み(`codex-cli 0.144.1`)。オーケストレーターが疎通確認済み:
  - `codex exec -m gpt-5.6-sol -s read-only --ephemeral -o <file> "<prompt>"` が正常動作し、`-o` で最終メッセージがファイルに書かれる。
  - 主要オプション: `-m <model>`(モデル指定)、`-s read-only`(読み取り専用サンドボックス。ファイル変更を一切させない)、`-o <file>`(最終メッセージをファイル出力)、`--ephemeral`(セッションを残さない)。
- `logs/` は .gitignore 済み(T080)。レポートの出力先 `tasks/design/` `tasks/review/` は git 管理対象(コミットはオーケストレーターが行うので、スクリプト側で git 操作は不要)。
- 重要な設計判断(遵守すること): **どちらのスクリプトも `-s read-only` で実行する。** Codex にはリポジトリの調査(ファイル読み・`git diff` 等の読み取りコマンド)だけをさせ、成果物は「最終メッセージ = レポート」として `-o` で受け取る。read-only なので Codex はタスクファイルへの作業ログ追記もできないが、それで正しい(レポートファイルが成果物のすべて)。

## 変更対象
- `scripts/codex-design.ps1` — 新規(Windows 用)
- `scripts/codex-design.sh` — 新規(macOS/Linux 用、ps1 と同等機能)
- `scripts/codex-review.ps1` — 新規(Windows 用)
- `scripts/codex-review.sh` — 新規(macOS/Linux 用、ps1 と同等機能)

## 要件

### 1. `codex-design.ps1` / `codex-design.sh`(設計コンサル)
- 引数: `<設計依頼ファイル>`(必須。オーケストレーターが書く Markdown。例 `tasks/design/T085-foo-request.md`)、`-Model`(省略時 `gpt-5.6-sol`)、`-Out`(省略時は依頼ファイル名から導出: `tasks/design/<basename>-report.md`。依頼ファイルが `*-request.md` なら `-request` を `-report` に置換)。
- 動作:
  1. 依頼ファイルの存在チェック(なければ日本語エラーで exit 1)。
  2. `tasks/design/` と `logs/` を必要なら作成。
  3. プロンプトを組み立てて `codex exec -m <model> -s read-only --ephemeral -o <out> <prompt>` を実行。標準出力は `logs/codex-design-<basename>.log` に tee する(codex-task.ps1 と同様)。
  4. プロンプト内容: 「あなたはこのリポジトリの設計コンサルタント。リポジトリを自由に読んで調査してよいが、ファイルは一切変更しないこと。以下の設計依頼に対し、(a)推奨する設計とその理由 (b)検討した代替案と却下理由 (c)実装タスクへの分割案(各タスクの変更対象ファイル・依存関係・リスク) (d)未確定事項・オーケストレーターへの確認事項、を含む設計レポートを最終メッセージとして日本語で書け」+ 依頼ファイル全文。
  5. exit code は codex のものを伝播。終了後、出力ファイルが存在し空でないことをスクリプト内で確認(空なら日本語エラーで exit 1)。
- 出力ファイルパスを最後に標準出力へ 1 行で表示する(オーケストレーターが Read する対象)。

### 2. `codex-review.ps1` / `codex-review.sh`(最終レビュー)
- 引数: `<タスクファイル>`(必須。例 `tasks/T082-foo.md`)、`-Range`(git の差分範囲。省略時 `HEAD~1..HEAD`)、`-Model`(省略時 `gpt-5.6-sol`)、`-Out`(省略時 `tasks/review/<タスクファイルbasename>-codex-review.md`)。
- 動作:
  1. タスクファイルの存在チェック + `git rev-parse` 等で Range の妥当性チェック(不正なら日本語エラーで exit 1)。
  2. `tasks/review/` と `logs/` を必要なら作成。
  3. `codex exec -m <model> -s read-only --ephemeral -o <out> <prompt>` を実行。ログは `logs/codex-review-<taskname>.log` に tee。
  4. プロンプト内容: 「あなたはこのリポジトリの最終レビュアー。`git diff <Range>` と `git log <Range>` を自分で実行して差分を読み、必要に応じて周辺コードも読むこと。ファイルは一切変更しないこと。以下のタスク仕様(目的・要件・スコープ外・受け入れ基準)に照らして、(a)重大(done を止めるブロッカー) (b)中(次タスクで対応すべき) (c)軽微(記録のみ)に分類した指摘と、(d)総合判定(合格/不合格とその理由)を含むレビューレポートを最終メッセージとして日本語で書け。正しさ・回帰リスク・設計妥当性・タスク仕様との乖離を重点的に見ること」+ タスクファイル全文。
  5. exit code 伝播、出力ファイルの存在・非空チェック、出力パスの表示(設計スクリプトと同じ)。

### 3. 共通
- ps1 は既存 `codex-task.ps1` の作法(param ブロック、Write-Error、Tee-Object、`exit $LASTEXITCODE`)に合わせる。sh は `codex-task.sh` の作法に合わせる。
- プロンプトに機密情報や環境依存の絶対パスを埋め込まない(相対パスで書く)。
- 動作確認(受け入れ基準の一部):
  - design: 小さな実依頼(例:「`app/src/analysis/` の『盤面で並べる』と『盤面を自由配置』タブの着手積み上げロジック重複(T079 reviewer 指摘)を共通ヘルパーに抽出する設計案」)で実行し、レポートが生成され (a)〜(d) の構成を持つこと。
  - review: 実タスク(例 `tasks/T080-repo-cleanup-readme-gitignore.md`、Range は T080 のコミット `0ac88e0~1..0ac88e0`)で実行し、レポートが生成され (a)〜(d) の構成を持つこと。
  - 動作確認で生成されたレポート・依頼ファイルは削除せずそのまま残す(実例サンプルとして tasks/design/・tasks/review/ に置いておく。コミットはオーケストレーターが行う)。
- スクリプト 4 本をコミットし(`scripts:` プレフィックス、`(T081)` を含む日本語メッセージ)、main に push する。GitHub Actions の成功を確認する。**コミットに含めるのは `scripts/` 配下の 4 ファイルのみ**(動作確認で生成した `tasks/design/` `tasks/review/` 配下のファイルはコミットしない=オーケストレーター担当)。

## やらないこと(スコープ外)
- CLAUDE.md の更新(オーケストレーターが行う)
- 既存 `scripts/codex-task.ps1` / `codex-task.sh` の変更
- `app/` `engine/` 等ソースコードの変更
- Codex 側の設定ファイル(`~/.codex/config.toml`)の変更
- Playwright での Pages 動作確認(アプリのコード変更がないため不要)

## 受け入れ基準(検証コマンド)
- [ ] `./scripts/codex-design.ps1 tasks/design/<動作確認用依頼ファイル>` が exit 0 で完了し、`tasks/design/*-report.md` が生成され、(a)推奨設計 (b)代替案 (c)タスク分割案 (d)確認事項 の要素を含む日本語レポートになっている
- [ ] `./scripts/codex-review.ps1 tasks/T080-repo-cleanup-readme-gitignore.md -Range 0ac88e0~1..0ac88e0` が exit 0 で完了し、`tasks/review/T080-*-codex-review.md` が生成され、重大/中/軽微の分類と総合判定を含む日本語レポートになっている
- [ ] 存在しない依頼ファイル/不正な Range を渡すと exit 1 + 日本語エラーになる
- [ ] 実行中・実行後に `git status` 上でリポジトリのファイルが変更されていない(read-only サンドボックスの確認。新規生成されるのはレポート・ログのみ)
- [ ] `logs/codex-design-*.log` / `logs/codex-review-*.log` が生成されている(gitignore 済みで git status に出ない)
- [ ] スクリプト 4 本のコミットが push 済み(`git log origin/main..main --oneline` が空)で、直近の GitHub Actions run が success
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていない(tasks/design/・tasks/review/ 配下の動作確認レポートは例外として残してよい=オーケストレーターがコミットする)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

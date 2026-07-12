---
id: T001
title: Rust ワークスペース初期化 + wasm-bindgen 疎通確認
status: done
assignee: implementer
attempts: 0
---

# T001: Rust ワークスペース初期化 + wasm-bindgen 疎通確認

## 目的
オセロエンジン(Rust → WASM)の開発基盤を作る。以後のすべてのエンジンタスク(T002〜)はこの上に積み上がるため、最初に確実な土台を作る。

## 背景・コンテキスト
- リポジトリルート: `C:\Users\yoshi\work\othello-trainer`(現在 git 未初期化・ソースコード無し。設計書 `othello-trainer-design.md` のみ存在)
- 設計書 §2.13 のリポジトリ構成に従い、`/engine` に Rust クレートを置く。
- 設計書 §2.3: エンジンは Rust + wasm-bindgen で `wasm32-unknown-unknown` ターゲットにビルドする。将来的に SIMD128 有効ビルドも行うが、本タスクではまず素朴なビルドが通ることを確認すれば良い。
- このマシン(Windows 11, PowerShell)は事前調査済み: Node.js v22.13.0 / npm 11.5.1 / Git 2.39 / Python 3.11.5 はインストール済みだが、**Rust(rustc/cargo/rustup)と wasm-pack は未インストール**。まずこれらをインストールする必要がある。
  - Rust: `winget install Rustlang.Rustup`(またはインストーラ https://rustup.rs 相当)でインストール後、**新しい PowerShell セッションを開くか `refreshenv` 相当で PATH を再読み込みしないと `cargo`/`rustc` が認識されない場合がある**。同一セッション内で反映されない場合は `$env:PATH` に `%USERPROFILE%\.cargo\bin` を追加するか、新しいシェルを起動して続行すること。
  - `rustup target add wasm32-unknown-unknown` でターゲット追加。
  - `cargo install wasm-pack` で wasm-pack をインストール(初回はコンパイルに数分かかる)。
- git リポジトリは未初期化。本タスクで `git init` し、最初のコミットを作成してよい(このプロジェクトはこれから育てていくため)。`.gitignore` は既にルートに存在するので流用する。

## 変更対象(新規作成)
- `engine/Cargo.toml` — クレート定義。crate-type は `["cdylib", "rlib"]`(cdylib: wasm用、rlib: 将来ネイティブベンチ/テスト用)
- `engine/src/lib.rs` — wasm-bindgen のエントリポイント。疎通確認用に `#[wasm_bindgen] pub fn ping() -> String { "pong".into() }` を用意
- `engine/Cargo.lock`(自動生成)
- ルート `Cargo.toml` — workspace 定義(members = ["engine"])。将来 `/bench` 等も同一 workspace に追加できるようにする
- `rust-toolchain.toml`(任意。stable チャンネル固定を推奨)
- `.github/workflows/` は本タスクの対象外(スコープ外を参照)

## 要件
1. Rust ツールチェーンが無い場合は https://rustup.rs (winget: `winget install Rustlang.Rustup`)相当の手順でインストールし、`rustup target add wasm32-unknown-unknown` を実行してターゲットを追加する。
2. `wasm-pack` が無い場合は `cargo install wasm-pack` でインストールする。
3. `engine` クレートを作成し、`wasm-bindgen` 依存を追加する(バージョンは crates.io の直近安定版を使用してよい)。
4. `wasm-pack build --target web` (または `--target bundler`。後続の `/app` 側の bundler 選定は T00x で行うため、本タスクでは `web` ターゲットで疎通確認できればよい)が **エラーなく完了**すること。
5. ビルド成果物(`pkg/` ディレクトリ)が `engine/pkg/` に生成されることを確認する。`pkg/` は `.gitignore` に追加してコミット対象から除外する(ビルド成果物のため)。
6. `cargo test` を `engine` クレートに対して実行し、パスする最小のテスト(例: `ping()` が `"pong"` を返すことを確認するテスト)を1つ以上含める。
7. git 未初期化なので `git init` し、`.gitignore` を確認の上、生成物一式を最初のコミットとして記録する(コミットメッセージは日本語で簡潔に)。

## やらないこと(スコープ外)
- ビットボード・探索・評価関数などエンジンのロジック実装(T002以降で行う)
- `/app` フロントエンドのセットアップ(別タスク)
- CI(GitHub Actions)の設定
- SIMD128 有効化やマルチスレッド(Lazy SMP)対応
- `/train` `/bookgen` `/puzzlegen` ディレクトリの作成

## 受け入れ基準(検証コマンド)
- [ ] `rustc --version` および `cargo --version` が正常に出力される
- [ ] `rustup target list --installed` に `wasm32-unknown-unknown` が含まれる
- [ ] `wasm-pack --version` が正常に出力される
- [ ] リポジトリルートで `cargo build -p engine --target wasm32-unknown-unknown` が成功する(exit code 0)
- [ ] `cd engine && wasm-pack build --target web` が成功し、`engine/pkg/` に `.wasm` と `.js`(グルーコード)が生成される
- [ ] `cargo test -p engine` が全件パスする
- [ ] `git log --oneline` に最初のコミットが存在する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-07 06:30 implementer:

**実施内容**
- Rust ツールチェーン未インストールだったため `winget install Rustlang.Rustup` でインストール。同一 PowerShell セッションでは PATH が反映されなかったため `$env:PATH` に `$env:USERPROFILE\.cargo\bin` を追加して対処。
- `rustup target add wasm32-unknown-unknown` でターゲット追加。
- `cargo install wasm-pack` 実行時、MSVC リンカ (`link.exe`) が見つからずビルド失敗(`getrandom`/`libc` 等のビルドスクリプルがコンパイルエラー)。原因は Visual Studio Build Tools (C++ ワークロード) 未インストールだったため。`winget install Microsoft.VisualStudio.2022.BuildTools` (`--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`) でインストールし、`vcvars64.bat` で環境変数を読み込んでから再実行し成功(wasm-pack 0.15.0)。
- ルート `Cargo.toml`(workspace, members=["engine"])、`rust-toolchain.toml`(stable + wasm32-unknown-unknown)を新規作成。
- `engine/Cargo.toml`(crate-type = ["cdylib", "rlib"]、wasm-bindgen 依存)、`engine/src/lib.rs`(`#[wasm_bindgen] pub fn ping() -> String { "pong".into() }` と `ping()` が `"pong"` を返すことを確認する `#[test]` を追加)を新規作成。
- `.gitignore` に `engine/pkg/`(wasm-pack ビルド成果物)を追記。
- git は既に初期化済み(過去のテンプレート由来のコミット履歴あり)だったため `git init` は不要と判断し、スキップした。本タスクのスコープ内ファイル(`.gitignore`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `engine/Cargo.toml`, `engine/src/lib.rs`)のみを `git add` し、コミット(`77b2fbf engine: Rust ワークスペースを初期化し wasm-bindgen 疎通確認を追加`)。`CLAUDE.md` / `tasks/STATUS.md` / 他タスクファイル / `.claude/scheduled_tasks.lock` はスコープ外のためコミットに含めていない。
- 備考: workspace 構成のため `Cargo.lock` はリポジトリルートに1つだけ生成される(`engine/Cargo.lock` は生成されない)。タスク記載の「`engine/Cargo.lock`」はワークスペースルートの `Cargo.lock` に相当するものとして扱った。

**検証コマンドと結果(すべて exit code 0 / パス)**
- `rustc --version` → `rustc 1.96.1 (31fca3adb 2026-06-26)`
- `cargo --version` → `cargo 1.96.1 (356927216 2026-06-26)`
- `rustup target list --installed` → `wasm32-unknown-unknown` / `x86_64-pc-windows-msvc` を含む
- `wasm-pack --version` → `wasm-pack 0.15.0`
- `cargo build -p engine --target wasm32-unknown-unknown` → 成功 (exit code 0)
- `cd engine; wasm-pack build --target web` → 成功、`engine/pkg/` に `engine_bg.wasm` と `engine.js`(グルーコード)等が生成された
- `cargo test -p engine` → `test tests::ping_returns_pong ... ok`、`test result: ok. 1 passed; 0 failed`
- `git log --oneline` → 最新コミット `77b2fbf` が存在することを確認

受け入れ基準はすべて満たしていることを確認済み。

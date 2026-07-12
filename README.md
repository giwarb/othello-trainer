# othello-trainer(オセロトレーナー)

ブラウザで動くオセロ(リバーシ)学習用 PWA です。対局だけでなく、定石・中盤・終盤(詰めオセロ)・棋譜解析の各モードで、悪手をなぜ悪手なのか言語化して示すことを目指しています。

公開URL: https://giwarb.github.io/othello-trainer/

## 主な機能

- **対局モード** — vs AI / 2人対戦、評価値表示のオン・オフ切り替え、盤面自由配置からの対局開始
- **定石練習モード** — オセロクエスト式(相手が重み付きランダムで定石内を進行し、外れたら終了)。定石DB(`bookgen/`)+ SRS(間隔反復)で反復練習
- **中盤練習モード** — 候補手オーバーレイと悪手判定、特徴量層による「なぜ悪手か」の言語化説明
- **詰めオセロモード** — 終盤の完全読み問題を出題・採点
- **棋譜解析モード** — 評価値グラフ、悪手解析パネル、盤面自由配置エディタによる任意局面からの解析
- 評価値のソース(序盤=定石DB / 中盤=ヒューリスティック探索 / 終盤=完全読み)を色分け表示
- ダークモード対応、PWAとしてオフラインでも動作(Service Worker + IndexedDB)

## 技術スタック

- **エンジン**: Rust → `wasm-bindgen`/`wasm-pack` で `wasm32-unknown-unknown` に WASM 化(`engine/`)。bitboard・PVS探索・置換表(Zobrist)・MPC・終盤完全読みソルバー・パターン評価
- **UI**: Preact + TypeScript + Vite。盤面は Canvas 1枚描画(`app/`)
- **PWA**: 素の Service Worker(Workbox不使用)+ coi-serviceworker(COOP/COEP注入)
- **データ**: IndexedDB(進捗・SRS・棋譜・解析キャッシュ)+ Cache Storage(アプリ本体・定石DB等)
- **配信**: GitHub Pages(`.github/workflows/deploy-pages.yml` の GitHub Actions でビルド・デプロイ)

## リポジトリ構成

```
.
├── engine/     # Rust製オセロエンジン(bitboard・PVS探索・置換表・MPC・終盤完全読みソルバー・パターン評価)
├── app/        # Preact + TypeScript + Vite製UI(エンジンをWASMとして読み込む本体アプリ)
├── bookgen/    # 定石DB生成用の調査データ・スクリプト
├── puzzlegen/  # 詰めオセロ問題生成スクリプト
├── bench/      # FFO終盤ベンチマーク・Edax(強豪オセロAI)との評価値比較検証
├── train/      # 評価関数学習パイプライン(WTHOR棋譜ベース。実験段階)
├── scripts/    # Codex CLI へのタスク委譲スクリプト
├── tasks/      # タスク仕様書・進捗ボード(STATUS.md)。CLAUDE.md の運用ルールに基づく開発記録
└── .github/workflows/  # GitHub Pages デプロイ用 CI(deploy-pages.yml)
```

## 開発方法

前提: Node.js 22、Rust(`wasm32-unknown-unknown` ターゲット。`rust-toolchain.toml` で指定済み)、[wasm-pack](https://rustwasm.github.io/wasm-pack/)

```sh
cd app
npm install

# 開発サーバ起動(WASMエンジンのビルドを自動実行してから vite dev を起動)
npm run dev

# 本番ビルド(WASMビルド → tsc → vite build → SWバージョン注入)
npm run build

# プレビュー(ビルド成果物の配信確認)
npm run preview

# 型チェック / テスト
npm run typecheck
npm run test

# データ生成(定石DB / 詰めオセロ問題)
npm run joseki:build
npm run puzzles:build
```

WASMエンジン単体のビルドは `npm run wasm:build`(`app/src/engine/build-wasm.mjs`)で、`wasm-pack build engine --target web --out-dir app/src/engine/pkg` を実行します。GitHub Pages へのデプロイは main ブランチへの push をトリガに `.github/workflows/deploy-pages.yml` が `app/` で `npm ci && npm run build` を実行し、`app/dist` を公開します。

## 設計書・運用ルール

- 全体設計・フェーズ1〜7ロードマップ: [`othello-trainer-design.md`](./othello-trainer-design.md)
- 中盤の言語化支援機能の設計: [`othello-trainer-design-verbalization.md`](./othello-trainer-design-verbalization.md)
- マルチエージェント開発の運用ルール(オーケストレーター/ワーカー分担): [`CLAUDE.md`](./CLAUDE.md)

## ライセンス

MIT(詳細は [`LICENSE`](./LICENSE) を参照)

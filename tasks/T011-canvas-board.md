---
id: T011
title: Canvas盤面描画・ゲーム状態管理(UIコンポーネント)
status: done
assignee: implementer
attempts: 0
---

# T011: Canvas盤面描画・ゲーム状態管理(UIコンポーネント)

## 目的
オセロ盤をCanvasで描画し、クリックで着手できるUIコンポーネントと、盤面状態を管理する純粋なロジック(エンジン非依存)を実装する。T012(Worker/エンジン統合)とは独立して実装できる。

## 背景・コンテキスト
- 前提: T010(`/app` Vite+Preact+TS雛形)完了済み。
- 設計書 `othello-trainer-design.md` §2.3: 盤面はCanvas 1枚で描画。石・合法手ヒント・最終手マーク・アニメーションをレイヤ描画。
- **本タスクではエンジン(WASM/Worker)を呼び出さない**。盤面状態管理とレンダリングだけを実装し、「合法手の判定」はTypeScript側で素朴に実装する(オセロのルール自体は単純: 8方向を辿って相手石を挟めるか判定するだけ。`engine/src/bitboard.rs` と同じルールだが、ここではTS側で独立実装してよい。将来的にWorker経由でエンジンに合法手判定させる形に置き換えても良いが、本タスクでは自己完結したロジックにする)。
- マス番号と `a1`〜`h8` 記法の対応は、エンジン側(`engine/src/bitboard.rs`)の規約(`index = rank0*8 + file`, a=0..h=7、a1が0)に合わせておくこと(将来Workerと連携する際に変換ロジックを共通化しやすくするため)。

## 変更対象(新規作成)
- `app/src/game/othello.ts`(または `app/src/game/board.ts`): 盤面状態(`black: bigint, white: bigint` または `Uint8Array(64)` 等、実装しやすい形でよい)、合法手判定、着手適用、パス判定、終局判定を行う純粋関数群
- `app/src/components/Board.tsx`(または `.tsx` 相当): Canvas描画コンポーネント。盤面状態を受け取り描画し、クリックイベントで着手マスをコールバックで通知する
- `app/src/game/othello.test.ts`: 上記ロジックの単体テスト(Vitest等、T010でセットアップされたプロジェクトに合わせて追加してよい。テストランナーが無ければ `vitest` を追加してよい)

## 要件
1. 盤面状態の型・初期化関数(標準開始局面: 中央4マスに黒白2つずつ)を実装する。
2. `legalMoves(board, side): number[]`(合法手のマス番号配列)を実装する。
3. `applyMove(board, side, move): Board`(着手後の新しい盤面。裏返る石を正しく計算)を実装する。
4. `hasLegalMove`/`isTerminal`/`countDiscs` に相当する関数を実装する。
5. `Board` コンポーネント(Canvas):
   - 8x8のマス目、緑背景、黒/白の石を円で描画
   - 現在の手番の合法手をハイライト表示(薄い色の点など)
   - 直前の着手マスに印を付ける(オプション。最低限「着手可能」表示ができればよい)
   - マスクリック時に `onMove(square: number)` のようなコールバックを呼ぶ(実際にその手が合法かどうかの判定は呼び出し側/このコンポーネント内で行い、非合法手のクリックは無視する)
   - レスポンシブ(親要素の幅に応じてCanvasサイズが決まる程度でよい。極端な作り込みは不要)
6. 単体テストで以下を検証する:
   - 初期局面の合法手が標準オセロの4手(d3, c4, f5, e6相当)と一致すること
   - 簡単な着手を適用した後の盤面が期待通りであること(石が正しく裏返ること)
   - パス・終局判定が正しく動くこと(境界的な人工局面で確認)

## やらないこと(スコープ外)
- Worker/WASMエンジンとの通信(T012)
- 対局モードのゲームループ(手番管理、CPU思考、ゲーム開始/リセットUI)(T013)
- PWA・オフライン対応(T014)
- デプロイ設定(T015)
- 評価バー・棋譜解析・言語化トレーニングなどの高度なUI(将来タスク)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test`(または `npx vitest run` 等、実際に追加したテストランナーのコマンド)で本タスクの単体テストが全件パスする
- [ ] `cd app && npm run build` が成功する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-07 implementer:
  - `app/src/game/othello.ts` を新規作成。`Board { black: bigint, white: bigint }` でビットボードを表現し、
    `engine/src/bitboard.rs` と同じマス番号規約(`square = rank0*8 + file`, a1=0, h8=63)に合わせた。
    `initialBoard` / `legalMoves` / `applyMove` / `hasLegalMove` / `isTerminal` / `countDiscs` / `countEmpty` /
    `cellAt` / `opposite` / `createBoard`(テスト用ヘルパー) / `notationToSquare` / `squareToNotation` を実装。
    合法手判定・着手適用のロジックはRust版と同じ方向別シフト法をBigIntで再実装(TS側で完全に独立実装、
    エンジン非依存)。
  - `app/src/game/othello.test.ts` を新規作成(Vitest)。初期局面の黒合法手(d3,c4,f5,e6)・白合法手
    (c5,d6,e3,f4)の検証、着手適用による石の裏返り(単方向・複数方向・複数連続石)の検証、
    人工局面でのパス判定(片方のみ合法手あり)・終局判定(両者合法手なし/盤面満杯)を含む15件のテストを追加。
  - `app/src/components/Board.tsx`(+ `Board.css`)を新規作成。Canvas 1枚で8x8盤・緑背景・グリッド線・
    黒白の石・現在の手番の合法手ヒント(薄い点)・直前手マーク(`lastMove` prop、任意)を描画。
    クリック時は盤面座標→マス番号に変換し、`legalMoves` で合法手かどうかを判定してから
    `onMove(square)` を呼ぶ(非合法手クリックは無視)。`ResizeObserver` で親コンテナ幅に追従してCanvasを
    リサイズする(レスポンシブ)。Worker/WASMエンジンは一切呼び出していない(スコープ外)。
  - 検証: `cd app && npx tsc --noEmit -p tsconfig.app.json` はエラー0。`cd app && npx vitest run` は
    3ファイル25件全パス(本タスクの15件 + T012側の既存10件)。`cd app && npx tsc -b && npx vite build` も成功。
  - **注意(スコープ外の環境問題)**: `npm run typecheck` / `npm run build` をpackage.jsonの通り実行すると、
    T012が追加した `pretypecheck` / `prebuild` フック(`node src/engine/build-wasm.mjs` → `wasm-pack build`)が、
    この環境に `wasm-pack` コマンドが存在しないため失敗する(`app/src/engine/pkg/` 配下には既存のビルド
    成果物があり、TS側からの参照自体は問題ない)。これは本タスク(`app/src/game/`, `app/src/components/`)の
    変更とは無関係で、T012(Worker/エンジン統合)側のツールチェーン前提(`wasm-pack` のインストール)に
    起因する。上記の通り、フックを経由しない直接コマンド(`tsc --noEmit`, `tsc -b`, `vite build`,
    `vitest run`)ではいずれも本タスクの成果物に起因するエラーは0件。
  - コミット対象は `app/src/game/`, `app/src/components/` のみ(`app/package.json` 等、T012が既に追加済みの
    Vitest導入・wasm関連スクリプトには一切触れていない)。

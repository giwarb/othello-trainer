---
id: T054
title: エンジンWorkerをモード切替をまたいで共有し「評価値が最初に出ない」問題を解消
status: todo
assignee: implementer
attempts: 0
---

# T054: エンジンWorkerをモード切替をまたいで共有し「評価値が最初に出ない」問題を解消

## 目的

ユーザー報告: 「評価値の表示が最初にできなかったり、終局近くで消えたり、いろいろと不安定」。調査の結果、2つの独立した根本原因が判明した。本タスクはそのうち「最初に表示できない」問題に対応する(「終局近くで消える」問題は別タスクT055で対応)。

原因: 各モード(対局・定石練習・中盤練習・詰めオセロ)が、マウント時に`new EngineClient()`(=新規Web Worker)を生成し、アンマウント時に`terminate()`で破棄している。新しいWorkerは`init()`→`new Engine()`→`loadPatternWeights`(`pattern_v2.bin`、約2.7MBのfetch+WASMパース)を毎回1から実行する必要があり、モードを切り替えるたびにこのコールドスタート(数百ms〜数秒)が発生する。この間に評価値取得(`requestAnalyzeAll`等)を呼んでも応答が遅れ、ユーザーには「評価値が出ない」ように見える。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- `app/src/engine/worker.ts`: Web Worker側のエントリポイント。`ensureEngineReady()`が`init()`(wasm-bindgen初期化)→`new Engine()`→`pattern_v2.bin`のfetch+`engine.load_pattern_weights(bytes)`を行う(T045)。
- `app/src/engine/client.ts`: メインスレッド側の`EngineClient`クラス。Workerを生成し、リクエストID方式でメッセージのやり取りを行う(並行リクエストを独立管理できる設計、既存)。
- 各モードでの現状の使用パターン(調査済み): `app/src/app.tsx`(対局モード)、`app/src/joseki/PracticeMode.tsx`(定石練習)、`app/src/midgame/PracticeMode.tsx`(中盤練習)、`app/src/tsume/PlayMode.tsx`(詰めオセロ)が、それぞれ独自に`engineRef`を持ち、マウント時に`new EngineClient()`、アンマウント時のuseEffectクリーンアップで`terminate()`を呼んでいる。`app/src/app.tsx`のトップレベルで`mode==='play' && <PlayMode/>`のような排他的条件レンダリングによりモード間で完全にアンマウント/マウントが起きるため、モードタブを切り替えるたびに新しいWorkerが生成される。
- 棋譜解析モード(`app/src/analysis/AnalysisMode.tsx`/`BlunderPanel.tsx`)も同様のパターンを使っている可能性があるので確認すること。

## 変更対象

- エンジンクライアントの生成・破棄を、各モードコンポーネントの責務から切り離し、**アプリ全体で1つのインスタンスを共有する**設計に変更する。具体的な実現方法は実装時に判断してよいが、例えば以下のような方式が考えられる:
  - `app/src/engine/`配下に、アプリのトップレベル(`app.tsx`のルートコンポーネント、または専用のProviderコンポーネント)で1度だけ`EngineClient`を生成し、Preactのcontext等で各モードコンポーネントに配布する。
  - 各モードコンポーネント(`app.tsx`, `joseki/PracticeMode.tsx`, `midgame/PracticeMode.tsx`, `tsume/PlayMode.tsx`, `analysis/AnalysisMode.tsx`等)は、自前で`new EngineClient()`・`terminate()`を呼ぶのをやめ、共有インスタンスを使うように変更する。
- アプリ終了時(ページ全体のアンマウント)にのみWorkerを破棄すればよい(通常はブラウザタブを閉じるまで破棄不要でも構わない)。

## 要件

1. モードタブを何度切り替えても、`pattern_v2.bin`の再fetch・WASM再初期化が発生しないこと(初回ロード時の1回のみで済むこと)。
2. モード切替後、直ちに(コールドスタート待ちなしで)評価値・盤面オーバーレイの取得が行えること。
3. 既存の各モードの機能(対局・定石練習・中盤練習・詰めオセロ・棋譜解析)が、共有インスタンス化後も従来通り正常に動作すること(リクエストの混線が起きないこと。既存のリクエストID方式がモード間共有でも正しく機能することを確認する)。
4. 既存のテストが壊れないこと。テストのモック方式(`FakeWorker`等)がモード横断の共有インスタンス化に対応できているか確認し、必要なら更新する。
5. 新規テスト: モード切替を模したシナリオ(例: 定石練習→中盤練習→対局、のように複数モードを行き来する)で、Workerが再生成されない(生成回数が1回のみ)ことを検証するテストを追加する。

## やらないこと(スコープ外)

- 「終局近くで消える」問題(パス処理の非同期タイミング、終局判定のばらつき)は別タスク(T055)で対応する。本タスクでは着手しない。
- パターン評価モデル自体・重みファイルの変更は行わない。
- Service Workerのキャッシュ戦略自体の変更は行わない(fetch自体はキャッシュされていても、WASM初期化・重みパースのコストは別途かかるため、本タスクの対応で解消する)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする(新規テスト含む)。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、対局→定石練習→中盤練習→詰めオセロ→棋譜解析、と複数回モードを切り替え、2回目以降の切り替えで評価値・盤面オーバーレイが即座に(コールドスタート待ちなしで)表示されることを確認する。ブラウザの開発者ツールのネットワークタブで`pattern_v2.bin`のリクエストが初回の1回のみであることを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-10 implementer: 実装完了。
  - 新規: `app/src/engine/sharedClient.ts`。`joseki/lookup.ts`の`loadJosekiDb`(モジュール内キャッシュ)と同じパターンで、`getSharedEngineClient()`(未生成なら`EngineClient`を1つだけ生成しキャッシュ、以降は同じインスタンスを返す)・`terminateSharedEngineClient()`(アプリ全体終了時用、破棄してキャッシュクリア)・`resetSharedEngineClientForTest()`(テスト専用)を実装。
  - 各モードコンポーネントから「独自に`engineRef`(`useRef`)を持ち、マウント時に`new EngineClient()`、アンマウント時のuseEffectクリーンアップで`terminate()`を呼ぶ」パターンを削除し、`getEngine()`ヘルパー(既存の呼び出し箇所はそのまま維持)の中身を`getSharedEngineClient()`の呼び出しに置き換えた。対象ファイル: `app/src/app.tsx`(対局モード)、`app/src/joseki/PracticeMode.tsx`(定石練習)、`app/src/midgame/PracticeMode.tsx`(中盤練習)、`app/src/tsume/PlayMode.tsx`(詰めオセロ)、`app/src/analysis/AnalysisMode.tsx`(棋譜解析)。加えて、タスク仕様には明記されていなかったが同一パターンを持つ`app/src/verbalize/GlossaryPage.tsx`・`app/src/verbalize/PracticeMode.tsx`・`app/src/verbalize/TwoChoiceDrill.tsx`(言語化トレーニングモードのサブタブ、`VerbalizeMode.tsx`から排他条件レンダリングされる)も同様に修正した(モード切替問題の対象として実質的に同じ状況だったため)。`app/src/analysis/BlunderPanel.tsx`はProps経由で`EngineClient`を受け取るだけで自前生成していなかったため変更不要と確認済み。
  - 各ファイルで`engineRef`削除に伴い不要になった`useRef`のimportも削除(全ファイルで`useRef`はengineRef専用だったため)。`EngineClient`のimportは型のみの利用になったため`import type`に変更。
  - 既存のリクエストID方式(`EngineClient`内の`nextRequestId`/`pending` Map)はクライアント単位でカプセル化されており、共有インスタンス化してもモード間で混線しない(どのモードから呼んでも同じインスタンス内でIDが単調増加し、レスポンスは`id`で対応付けられる)ことをコードレビューと新規テストの両方で確認した。
  - 新規テスト: `app/src/engine/sharedClient.test.ts`(既存`engine/client.test.ts`と同じ`FakeWorker`パターン)。「モード切替を模したシナリオ」として、複数の呼び出し元(定石練習→中盤練習→対局→詰めオセロ→棋譜解析を模した5回の`getSharedEngineClient()`呼び出し)がWorkerファクトリを1回しか起動しないこと、キャッシュ済みの場合は別のファクトリを渡しても無視されること、異なる「モード」からの同時リクエストがリクエストIDで正しく解決されること(送信順と逆の応答が届いても正しく解決)、`terminateSharedEngineClient()`で破棄後は次回呼び出しで新規生成されること、の4テストを追加。
  - 本タスクの範囲外の「終局近くで消える」問題(T055)には着手していない。
  - 検証:
    - `npm test`(app/): 53ファイル/446テスト全件パス(新規4テスト含む)。
    - `npm run typecheck`: エラーなし。
    - `npm run build`: 成功(`dist/`生成、`inject-sw-version.mjs`も正常終了)。
    - 実機確認(`npm run dev`、Playwright CLIで自動操作): `http://localhost:5175/`に対し、対局→定石練習→中盤練習→詰めオセロ→棋譜解析→言語化トレーニングを2周(計12回)切り替え、ネットワークログで`pattern_v2.bin`のリクエストが初回の1回のみであることを確認(2回目以降のfetchは発生せず)。加えて機能スモークテスト(対局モードで黒番開始→着手→評価バッジ表示、定石練習の色選択画面、中盤練習・詰めオセロのボタン群表示、棋譜解析のtextarea表示)を自動操作し、console/pageエラーが0件であることを確認。
    - 本番デプロイ確認: 下記参照。

- 2026-07-10 implementer: 本番デプロイ・確認。
  - コミット `aecaa34`("app: エンジンWorkerをアプリ全体で共有し評価値のコールドスタートを解消(T054)")を`main`にpush。
  - GitHub Actions「Deploy to GitHub Pages」ワークフロー(run ID 29071895506)を`gh run watch`で監視、`build`(51s)・`deploy`(10s)ともに成功を確認。
  - `https://giwarb.github.io/othello-trainer/`に対し、Playwright CLI(`node`スクリプト、`playwright`パッケージを利用)で以下を自動確認:
    1. `pattern_v2.bin`のネットワークリクエストを監視しつつ、対局→定石練習→中盤練習→詰めオセロ→棋譜解析→言語化トレーニングのタブを2周(計12回)切り替え。`pattern_v2.bin`リクエストは初回の1回のみ(以後0回)であることを確認(要件1・受け入れ基準3項目目)。
    2. 対局モードで黒番開始→盤面クリックで着手→`evalInfo`セクション(評価バッジ)が表示されることを確認。定石練習・中盤練習・詰めオセロ・棋譜解析の各モードで、切替直後にボタン・入力欄等の基本UIが正常表示されること、console/pageエラーが0件であることを確認(要件2・3)。
  - ローカル(`npm run dev`、`http://localhost:5175/`)でも同様のPlaywrightスクリプトで同じ結果(pattern_v2.bin 1回のみ、エラー0件)を先に確認済み。
  - 以上により受け入れ基準4項目すべて達成。

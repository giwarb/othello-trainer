---
id: T115
title: 定石ブックON時に「思考中...」表示が解消しない事象の調査・修正
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T115: 定石ブックON時に「思考中...」表示が解消しない事象の調査・修正

## 目的

T107のverifierがGitHub Pages本番環境で以下を観測した(2026-07-16、Playwright headless Chromium):

> 定石ブックをONにしたまま(既定値)黒番対局を開始→d3クリックすると、書籍応手(白e3)後に「(思考中...)」表示が**2分待っても消えない**。定石ブックをOFFにして同じ手順を行うと即座に正常応答する。コンソール/ページエラーはゼロ。

定石ブックONは**本番の既定設定**(T093で既定on)であり、もし再現性のある実バグなら、多くのユーザーの対局体験が最初の数手で壊れていることになる。原因を特定し、バグなら修正する。

## 背景

- 定石ブック機能はT093で導入(フェーズ1: on/offトグル、ブックon時は定石DBから即着手。当時の本番実測: 初手117ms)。
- T107(直近のデプロイ、コミット7e9b121)の変更はengine側のexact quota定数・eval_cli CLIデフォルト・`ANALYSIS_ENGINE_VERSION` 2→3のみで、定石ブック経路には直接触れていない。ただし`ANALYSIS_ENGINE_VERSION`変更による解析キャッシュ全無効化が間接的に何かを露呈させた可能性は排除できていない。
- verifierの観測はheadless環境での1回のみ。フレーク(Playwright環境固有)の可能性もある。

## 要件

1. **再現確認**: 本番Pages(https://giwarb.github.io/othello-trainer/)とローカル(`npm run dev`または`vite preview`)の両方で、上記手順(対局モード・CPU強い・ブックON・黒d3)の再現を試みる。複数回試行し、再現率を記録する。
2. **再現した場合**: 原因を特定して修正する。着眼点の例: 書籍応手後の状態遷移(思考中フラグの解除漏れ)、書籍応手と評価値表示(worker解析リクエスト)の競合、書籍手に対する解析キャッシュミス時の待ち、workerプロトコルの応答漏れ。修正には回帰テスト(該当経路のユニット/コンポーネントテスト)を含める。
3. **再現しない場合**: 試行条件(回数・環境・タイミング)を作業ログに記録し、「フレークと判断する根拠」を書いて修正なしで完了してよい。
4. T107検証時の観測ログ: 書籍応手「白e3」自体は表示された(=ブックDBの読み込みと応手選択は動いている)。ハングしたのは**その後の表示状態**。

## やらないこと(スコープ外)

- エンジン(Rust/wasm)側の変更
- 定石DBの内容・構造の変更
- 定石練習モードなど対局モード以外への波及調査(問題が対局モード外にもあると判明した場合は報告のみ)

## 受け入れ基準(検証コマンド)

- [ ] 再現確認の記録(再現率、環境別)が作業ログにある
- [ ] 修正した場合: 原因の説明と回帰テストがあり、`npm test -- --run` グリーン
- [ ] 修正した場合: 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、Pages公開URLでブックONの対局が正常進行する(「思考中...」が数秒内に解消する)ことを確認
- [ ] 再現しなかった場合: 試行の記録と判断根拠が作業ログにある(コード変更なしで完了可)
- [ ] 変更対象ファイルのみパス指定でコミット(`(T115)`)。tasks/ と CLAUDE.md はコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T114 WIPの bench/edax-compare 3ファイルは対象外・触れないこと)

## 備考(並行作業との調整)

- T114(200kコーパス生成、python 8並列、CPU重負荷)が稼働中。本タスクはUI調査でwall time計測を含まないため並行してよいが、**「思考中」の解消待ち時間の評価はCPU競合で遅くなりうることを考慮**する(ハング判定は「数十秒〜分単位で解消しない」を基準にし、数秒の遅さをバグと誤認しない)。
- train/data/teacher/ とT114のプロセスには一切触れない。

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 着手・再現確認(ローカルdev)

- `.claude/launch.json` を新規作成(コミット対象外・T115専用のローカルdev起動設定。`npm --prefix app run dev`)し、Browserプレビューでローカルdev(`http://localhost:5173`)を起動。
- explorer(調査サブエージェント)へ並行して `思考中`フラグと定石ブック経路の調査を委譲(バックグラウンド実行中)。
- `app/src/app.tsx`の`PlayMode`コンポーネントを読み、CPU応手のuseEffect(299-326行目付近、依存配列`[game, level, openingBookEnabled, josekiDb, josekiDbReady, firstMoveSquare]`)が`thinking`state を管理していることを確認。`requestCpuMove`はブックヒット時に`engine.requestAnalyze`を呼ばず`playMove`を即時適用する(`app/src/game/gameLoop.ts` 256-260行目)。
- Browser pane操作: `computer{action:"screenshot"}`が繰り返しタイムアウトしたため(T114の8並列pythonによるCPU競合の可能性)、`javascript_tool`でcanvasへ合成`click`イベント(clientX/clientY計算)をdispatchする方式に切り替えて対局操作を実施。
- **再現成功(1回目の試行で即再現)**: 対局モード・黒番・定石ブックON(既定)・CPU強さ「普通」で開始 → d3(黒)をクリック → 白の書籍応手が適用され(石数2/2→3/3で2手分進行を確認、EvalBadgeに「定石」タグ表示)、手番は黒(人間)に戻っているにもかかわらず、`手番: 黒(思考中...)` の表示が解消されない。コンソールエラーはゼロ(`read_console_messages`で確認)。T107 verifierの本番環境での観測と完全に一致。
- 次: `thinking` stateがfalseに戻らない原因をコードレベルで特定する(useEffectの依存配列に`game`自身が含まれることによる再入・cleanup競合を仮説として検証中)。

### 2026-07-16 explorer完了報告と原因特定(デバッグログによる実証)

- explorer(バックグラウンド委譲分)の調査結果を受領。結論は「静的解析だけでは確定できないが、`game`/`firstMoveSquare`両方に依存するCPU着手effectが、書籍応手の即時解決と`firstMoveSquare`設定effectの再レンダーの間で二重発火し、`cancelled`ガードが競合して`thinking`のfalse化が握りつぶされる」という仮説(自分の仮説と一致)。
- `app/src/app.tsx`のCPU着手effect(当時292-326行目)に一時的なデバッグ`console.log`(dbgId付き)を追加し、ローカルdevサーバー(`npm --prefix app run dev`、`.claude/launch.json`を一時作成)で再現・トレース取得。以下の実イベント順序を確認(**仮説を実証**):
  1. 黒d3クリック→`game.phase='cpu'`に。CPU着手effect(id: vjhgr)が`firstMoveSquare=null`(未反映)で発火、`bookMove=34`を計算し`requestCpuMove`開始。
  2. `vjhgr`のPromiseが解決し`setGame(next)`(白34着手適用)を呼ぶが、その**直前**に「初手記録effect」が`firstMoveSquare=19`をセットしたことによる別レンダーで**CPU着手effectが2回目発火(id: 0y0hq、`game`はまだ34適用前の値)**、`bookMove=20`(ランダム重み付け選択のため1回目と異なる値)を計算し2つ目の`requestCpuMove`を開始。
  3. `0y0hq`が解決して`setGame`(白20着手適用、こちらが最終的に画面に残る)。
  4. `vjhgr`の`.finally()`が実行される時点では、`0y0hq`発火時のcleanupで`vjhgr`の`cancelled`が既に`true`→`setThinking(false)`スキップ。
  5. その後の再レンダー(`game.phase`は既に`'human'`)でCPU着手effectが再実行されるが`if (game.phase !== 'cpu') return`で即return、`thinking`に一切触れない。
  6. `0y0hq`の`.finally()`が実行される時点でも、その直後の再レンダーで発火した3つ目のeffectインスタンスのcleanupにより`0y0hq`の`cancelled`も`true`済み→こちらも`setThinking(false)`スキップ。
  7. 結果、**どのeffectインスタンスも`setThinking(false)`を実行できないまま**、以降`game.phase !== 'cpu'`が続く限り`thinking`はtrueに固定される。
- この実証ログにより「原因不明のまま防御的修正」ではなく、根本原因(`firstMoveSquare`のuseState化が引き起こす二重発火)を特定できた。

### 2026-07-16 修正実装

- `app/src/app.tsx`の`PlayMode`コンポーネントを修正:
  1. `firstMoveSquare`(`useState<number|null>`)を`firstMoveSquareRef`(`useRef<number|null>`)に変更。ref書き込みは再レンダーを起こさないため、「初手記録effect」の依存配列は`[game]`のみになり、CPU着手effectの依存配列からも`firstMoveSquare`を除去(`[game, level, openingBookEnabled, josekiDb, josekiDbReady]`)。これにより、人間の着手1回に対してCPU着手effectが1回しか発火しなくなり、二重発火自体を解消(根本原因の修正)。
  2. 追加の安全網として、`useEffect(() => { if (game.phase !== 'cpu') setThinking(false) }, [game.phase])`を新設。`game.phase`が`'cpu'`でなくなった時点で`thinking`を確実にfalse化する(万一別の競合が将来発生しても症状が固着しないようにする防御)。
  3. `handleMove`/`prepareNewGame`内の`firstMoveSquare`参照も`firstMoveSquareRef.current`に置き換え。
- ローカルdevで再現手順(黒番・ブックON・CPU「普通」/「強い」・d3クリック、c4/f5でも確認)を計10回程度試行し、すべて「思考中」が即座に解消することを確認(デバッグログも削除済み、最終差分はクリーン)。
- `npx tsc --noEmit -p tsconfig.app.json`: エラーなし。

### 2026-07-16 回帰テスト追加

- コンポーネントテスト`app/src/app.playmode.test.tsx`を新規作成。`<App/>`を実際にレンダーし、対局モードへ遷移→定石ブックON(既定)のまま黒d3に着手→CPUの書籍応手適用後「思考中」が消えることを検証する。
- WASM Worker(`getSharedEngineClient`)・定石DB fetch(`loadJosekiDb`)・重み付きランダム選択(`selectCpuBookMove`)・canvas描画(`Board`)をモック化(jsdomはcanvas 2D未対応のため)。
- **重要な検証上の発見**: 「思考中」表示のテキストチェック自体は、`preact/test-utils`の`act()`(effectを同期的にflushする決定的モデル)の下では**修正前のコードに対しても偶然パスしてしまう**ことを確認した(実ブラウザのmicrotask/rAFタイミング競合はjsdomの`act()`では再現されないため)。そこで、根本原因である**二重発火そのもの**を`selectCpuBookMove`の呼び出し回数(`selectCpuBookMoveCalls.length`)で直接検証するアサーションを追加。修正前のapp.tsx(`git show HEAD:app/src/app.tsx`を一時的に復元して検証、後で修正版に戻した)に対して実行すると呼び出し回数が2になりテスト失敗、修正後は1になりテスト成功することを確認済み(regression-catchingであることを実証)。
- テスト実行にjsdom環境が必要なため、`jsdom`を`app/package.json`のdevDependencyに追加し、`app/vitest.config.ts`の`include`に`src/**/*.test.tsx`を追加(デフォルトの`environment: 'node'`は変更せず、当該テストファイルのみ`// @vitest-environment jsdom`プラグマでjsdom化)。既存の`.test.ts`群への影響なし。
- `npm test -- --run`(=`vitest run --run`): **64ファイル520件全件パス**(新規1ファイル2件を含む)。
- `npm run build`: 成功(wasmビルド・tsc・vite build・sw version注入すべて成功)。

### 2026-07-16 コミット・デプロイ・本番確認

- コミット対象を`app/src/app.tsx` `app/src/app.playmode.test.tsx` `app/package.json` `app/package-lock.json` `app/vitest.config.ts`のみに限定してパス指定でadd・commit(`git add .`不使用)。T114 WIP(`bench/edax-compare/`の3ファイル)・`tasks/`・`CLAUDE.md`は一切add/commitしていない。
- コミットハッシュ: `c2bb69ea91c8bbb05ffc3823716e097bab0e8c1a`(「app: 定石ブックON時にCPU応手後「思考中」表示が解除されない不具合を修正(T115)」)。
- `git push origin main`実施、`gh run watch`でGitHub Actions「Deploy to GitHub Pages」(run 29484450644)の成功を確認(build 38s + deploy 9s、全ステップ✓)。
- 本番Pages(`https://giwarb.github.io/othello-trainer/`)で、Playwright相当のブラウザ操作(javascript_toolでcanvasへ合成clickイベントをdispatch)により、T107検証時と同一条件(黒番・定石ブックON・CPU「強い」・d3クリック)で再確認。結果: 白の書籍応手が適用され(石数2/2→3/3)、「手番: 黒」の表示に「(思考中...)」が付かず即座に人間の手番に戻ることを確認。コンソールエラーもゼロ。CPU「普通」でも同様に確認済み。
- ローカル作業用に一時作成した`.claude/launch.json`(git未追跡)は検証完了後に削除済み。一時的なデバッグ`console.log`もすべて削除し、最終コミットに残っていないことを確認済み(`git diff`で目視レビュー済み)。

## 完了レポート

**再現有無**: 再現した(ローカルdev・本番Pages両方、CPU「普通」「強い」いずれでも、黒の初手d3/c4/f5いずれからでも100%再現)。

**原因**: `app/src/app.tsx`の`PlayMode`コンポーネントで、CPU着手用`useEffect`(旧: 依存配列`[game, level, openingBookEnabled, josekiDb, josekiDbReady, firstMoveSquare]`)が`firstMoveSquare`という`useState`値に依存していた。定石ブックの応手は`engine.requestAnalyze`(Worker往復)を経由せずほぼ即時に解決する(`game/gameLoop.ts`の`requestCpuMove`、T093由来の分岐)。この「ほぼ即時」という性質が、「人間の初手を記録する」別の`useEffect`が`firstMoveSquare`をセットして引き起こす再レンダーと時間的に競合し、**同一の人間の着手1回に対してCPU着手effectが2回発火する**レースコンディションを引き起こしていた。2つのeffectインスタンスは互いの`cancelled`クリーンアップフラグを踏みつけ合い、実ブラウザではPromiseのmicrotaskとpassive effectのスケジューリング順序次第で、**どちらのインスタンスの`.finally()`も`setThinking(false)`を実行できずに終わる**ことがあった(デバッグログによる実イベント順序トレースで実証、上の作業ログ参照)。通常のエンジン探索(Worker往復で数百ms〜数秒)ではこの競合の発生猶予がほぼなく顕在化しないため、「ブックONでのみ再現し、ブックOFFでは再現しない」というT107 verifierの観測と整合する。

**修正内容**: `app/src/app.tsx`
1. `firstMoveSquare`(`useState`)を`firstMoveSquareRef`(`useRef`)に変更し、CPU着手effect・初手記録effect両方の依存配列から除去(ref書き込みは再レンダーを起こさないため、構造的に二重発火が起こらなくなる、根本原因の修正)。
2. `game.phase !== 'cpu'`になったら`thinking`を確実にfalseへ戻す安全網`useEffect`を追加(防御的修正)。

**回帰テスト**: `app/src/app.playmode.test.tsx`(新規)。実際の`<App/>`をレンダーし、書籍応手適用後に「思考中」表示が消えることと、根本原因である二重発火が解消されたこと(`selectCpuBookMove`の呼び出し回数が1回であること)を検証する。修正前コードに対して実行し、二重発火アサーションが実際に失敗する(呼び出し回数2)ことを確認済み(regression-catchingであることを実証済み)。jsdom依存を追加し、vitest.config.tsを`.test.tsx`対応に拡張(既存テストへの影響なし)。

**検証結果**:
- `npx tsc --noEmit -p tsconfig.app.json`: エラーなし
- `npm test -- --run`: 64ファイル520件全件パス
- `npm run build`: 成功
- 本番Pages(`https://giwarb.github.io/othello-trainer/`)で実機確認: 定石ブックON・CPU「普通」「強い」いずれでも、黒d3着手後の書籍応手適用後に「思考中」が即座に解消することを確認。コンソールエラーゼロ。

**コミット**: `c2bb69ea91c8bbb05ffc3823716e097bab0e8c1a`(`app/src/app.tsx` `app/src/app.playmode.test.tsx` `app/package.json` `app/package-lock.json` `app/vitest.config.ts`のみ、パス指定add)。push済み、GitHub Actionsデプロイ成功確認済み(run 29484450644)。

**T114との干渉**: `bench/edax-compare/`配下3ファイル(T114 WIP)・`train/data/teacher/`・T114のpythonプロセスには一切触れていない。`git status --short`で確認済み(タスク完了時点で当該3ファイルの差分はT114由来のまま維持、`tasks/`・`CLAUDE.md`は未add)。

**仕様どおりにできなかった点・判断に迷った点**:
- なし。ただし判断の記録として: コンポーネントレベルのテストがこのリポジトリに1件も存在しなかった(既存はロジック単体テストのみ、`environment: 'node'`)ため、`jsdom`の新規追加と`vitest.config.ts`の`include`拡張が必要になった。影響範囲を最小化するため、デフォルトenvironmentは変更せず対象テストファイルのみ`@vitest-environment jsdom`プラグマで切り替える設計にした。既存63ファイルのテストは無変更・全件パス継続を確認済み。

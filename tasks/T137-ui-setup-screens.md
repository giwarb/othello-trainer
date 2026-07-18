---
id: T137
title: UX強化3: 設定・一覧・ホーム画面の磨き込み(CTA強調・進捗の見える化)
status: redo # 代替レビュー中3件の仕上げ(シリーズ最終弾のため持ち越さず修正)
attempts: 1
assignee: implementer(Sonnet)
attempts: 0
---

# T137: 設定・一覧・ホームの磨き

## 背景(オーケストレーターの実機UXレビュー 2026-07-18)

1. **中盤練習の設定画面**: fieldset枠のラジオ3グループが縦積みで威圧感があり、主アクション「開始」が最小サイズの灰色ボタンで埋没。苦手パターンの空状態が素テキスト1行で寂しい。
2. **詰めオセロの設定画面**: 「難易度1〜5」が同一見た目の灰色ボタン5連。各難易度の説明(空きマス数帯)もクリア進捗も無く、選ぶ手がかりがない。
3. **ステージ一覧**: 灰色一色の長大グリッド。クリア済みの色分けはあるが未挑戦だと全部同じで達成感の演出がない。
4. **ホーム**: カードは綺麗だが静的。進捗(定石の今日の復習n本・詰めデイリー・クリア数)が一切出ず、「今日なにをやるか」の導線がない。

## 要件

1. **中盤練習設定**: ラジオ3グループを選択式チップ(セグメントコントロール風)またはコンパクトなカードに刷新し、**「開始」をプライマリボタンで最下部に大きく固定**。苦手パターンは記録があれば上位3件をカード表示(T129)、空状態は「失敗するとここに苦手が貯まります」等の説明文+アイコン。
2. **詰めオセロ設定**: 難易度ボタンを「難易度n(空きm〜kマス)+クリア x/y」のカードに刷新(クリア数は既存stageProgressから集計)。デイリー・ランダム・ステージ一覧はプライマリ/セカンダリの区別を付ける。
3. **ステージ一覧**: クリア済みセルに達成色(緑系)+チェック/★を付けて達成感を出す。ヘッダに「クリア x/182」のサマリバー(進捗バー)を追加。中盤練習側は判定モード別★の既存仕様を維持したまま同様に。
4. **ホームに進捗サマリ**: 各モードカードに小さな実績行を追加 — 定石「今日の復習n本」(dueLines.ts再利用)、詰め「クリアx/182・今日の1問」、中盤「クリアx/111」。データ取得は既存のlocalStorage/IndexedDB読み出しの再利用のみ(新規スキーマ不要)。取得失敗時は表示しない(ホームの表示を壊さない)。
5. 全画面、縦375px・横置きの両対応。T135のデザイントークンを使う(独自色を増やさない)。

## 追加要件(T136検収の申し送り、tasks/review/T136-ui-play-claude-review.md)

1. (中)`--board-label-band: 1.35em`をrem基準に変更(フレームとオーバーレイが別要素でemを解決するため、将来のfont-size指定で無警告にズレるリスクの解消)。
2. (軽微)ヘッダ高40pxのマジックナンバーが7ファイルに散在 → CSS変数(例: `--app-header-height`)に集約。
3. (軽微)`class="play-setup card"`とCSSコメント(「.card併用せず」方針)の矛盾を解消(どちらかに統一)。
4. (軽微)2人対戦モードで投了ボタンが非表示であることの専用テスト1件追加(verifier指摘)。
5. (軽微)中盤練習・詰めオセロで削除したSR向け手番テキストの代替(PlayerBadgeにaria-label等)を検討・実装。

## やらないこと(スコープ外)

- 新しい学習機能の追加(表示の磨きのみ)/verbalize旧モードの復活/IndexedDB・localStorageスキーマ変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] 中盤設定・詰め設定・グリッド・ホームの各変更にコンポーネントテスト(進捗集計の表示・空状態・進捗バーの値)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] ビフォー/アフターのスクショ(375x812、4画面)を撮り作業ログに記録
- [ ] mainへpush→Actions成功→Pages実機で4画面+横置きの非退行を確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T137)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

### redo#1(2026-07-18、代替レビュー中3件+軽微1件。tasks/review/T137-ui-setup-claude-review.md。シリーズ最終弾のため持ち越さずここで仕上げる)

1. (中1)チップのキーボードフォーカスリングが不可視(sr-only側にリングが描かれる)→ `:has(input:focus-visible)`等でlabel側に可視リングを付ける+キーボード操作の確認。
2. (中2)ホームの実績行が初回取得のみで、モードでクリアしてホームに戻っても数値が古い → モード復帰時(mode変化でhomeに戻ったとき)に再取得する。テスト1件(クリア→ホーム復帰→数値更新)。
3. (中3)PlayerBadgeのaria-labelがrole=genericのdivに付与されARIA仕様上prohibited(SRで無視されうる、T136申し送り5の意図未達)→ `role="group"`付与または`.sr-only`スパン方式へ変更。既存テストを実態に追従。
4. (軽微)「クリアx/y」表記のスペース有無をホーム/設定/一覧で統一する。

最小差分・`npx vitest run`全パス・push→Actions成功→本番で中2の再現確認(モードでクリア→ホームの数値更新)まで。コミットは`(T137)`。

## 作業ログ(担当エージェントが追記)

### 2026-07-18 implementer(Sonnet)実装完了

**方針・スコープの確認**

- 追加要件1〜5(T136 codex-review申し送り)を先に着手し、その後要件1〜4(設定・一覧・ホーム磨き込み)を実装した。
- チップ化はネイティブ`<input type="radio">`を`.sr-only`で視覚的に隠し、`<label>`をチップ風に見せる方式を採用(既存のquerySelectorベースのテスト・アクセシビリティを壊さないため)。アクティブ状態はJS側で判定した`--active`修飾クラスで表現(復習フィルタボタンの既存パターンを踏襲)。
- 難易度nの「空きm〜kマス」は固定の対応表が無い(生成時のパーセンタイル分割のみ)ため、実際にロード済みの問題プールからその場で最小〜最大を求める方式にした(`tsume/difficultyStats.ts`)。
- ホームの実績行はIndexedDB/localStorageの取得を3モード独立にtry/catchし、失敗時はその行だけ非表示にする設計(要件4)。新規スキーマは追加していない(既存のdueLines/stageProgress/dailyPuzzleをそのまま再利用)。

**変更ファイル**

- 追加要件1: `app/src/index.css`(`--board-label-band`をem→rem化)
- 追加要件2: `app/src/index.css`(`--app-header-height: 40px`新設)+ `app/src/app.css`・`app/src/analysis/AnalysisMode.css`・`app/src/joseki/PracticeMode.css`・`app/src/midgame/PracticeMode.css`・`app/src/tsume/PlayMode.css`の`calc(100dvh - 40px)`(計8箇所)をトークン参照に置換
- 追加要件3: `app/src/app.tsx`(`class="play-setup card"` → `class="play-setup"`)
- 追加要件4: `app/src/app.playmode.stateSeparation.test.tsx`に「2人対戦モードでは投了ボタンが表示されない」専用テストを追加
- 追加要件5: `app/src/components/PlayerBadge.tsx`にaria-label(誰・何番・石数・手番・考え中を要約)を追加、`app/src/components/PlayerBadge.test.tsx`にテスト追加
- 要件1(中盤設定): `app/src/midgame/PracticeMode.tsx`(3fieldsetをチップ化、苦手パターン空状態をアイコン+説明文化、「開始」を大きなプライマリCTAに、「ステージ一覧」をセカンダリリンク風に)+ `app/src/midgame/PracticeMode.css`
- 要件2(詰め設定): `app/src/tsume/PlayMode.tsx`(難易度ボタン→カード化)+ 新規`app/src/tsume/difficultyStats.ts`(空きマス数帯+クリア数の集計、純粋関数)・`app/src/tsume/difficultyStats.test.ts` + `app/src/tsume/PlayMode.css`
- 要件3(ステージ一覧): `app/src/midgame/PracticeMode.tsx`・`app/src/tsume/PlayMode.tsx`(「クリア x/N」サマリ+進捗バーを追加、クリア済みセルの達成色を強化)+ 両CSS
- 要件4(ホーム進捗): 新規`app/src/home/modeProgress.ts`(文言組み立ての純粋関数)・`app/src/home/modeProgress.test.ts` + `app/src/TitleScreen.tsx`・`app/src/TitleScreen.css`(`ModeCardInfo.progress`追加)・`app/src/TitleScreen.test.tsx` + `app/src/app.tsx`(3モード分の非同期取得effect)
- 新規コンポーネントテスト: `app/src/midgame/PracticeMode.settingsUx.test.tsx`・`app/src/tsume/PlayMode.settingsUx.test.tsx`・`app/src/app.home.progress.test.tsx`
- 既存テスト更新: `app/src/midgame/PracticeMode.patternStats.test.tsx`(空状態アサーションを新文言に更新。default judgeModeが`'strict'`である点は`PracticeMode.settingsUx.test.tsx`側で対応)

**検証**

- `npx vitest run`: 95ファイル/754件 全パス
- `npx tsc --noEmit -p app/tsconfig.app.json`: エラーなし
- ローカル動作確認: `npx vite --port 5183`で起動し、Browser MCPで実際のjoseki.json/puzzles.json(定石111ステージ・詰め182問)を使って以下を確認:
  - ホーム: 「今日の復習112本」「クリア0/111」「クリア0/182・今日の1問未挑戦」が各カードに表示
  - 中盤設定: 苦手パターン空状態(📊アイコン+「失敗するとここに苦手パターンが貯まります」)、判定モードチップの`--active`クラス切り替え、「開始」が`btn-primary midgame-settings__start-button`(高さ56px)
  - 中盤ステージ一覧: 「クリア 0/111」サマリ+進捗バー(aria-valuenow/valuemax)
  - 詰め設定: 難易度カード5枚に「空きm〜kマス」「クリア x/y」(実データで難易度1=空き6〜9マス等)
  - 詰めステージ一覧: 「クリア 0/182」サマリ+進捗バー
  - **スクリーンショット未取得(環境制約)**: `mcp__Claude_Browser__computer(action: screenshot)`および`zoom`が本セッションでは`http://localhost:5183`・`https://example.com`いずれに対しても一貫してタイムアウトし撮影不能だった(アプリ側の不具合ではなく、このセッションのBrowser MCPツール自体の問題と判断。`get_page_text`・`read_page`・`javascript_tool`は正常に機能し、上記の内容確認は全てこれらで行った)。375x812のビフォー/アフター4画面のスクリーンショットはオーケストレーター側で別途取得・確認をお願いしたい。
- GitHub Pages実機確認: 未実施(コミット・push後にオーケストレーターまたは次のステップで実施予定。下記完了レポート参照)

**判断に迷った点**

- 詰めオセロの「今日の1問」実績: 要件4の文言例「クリアx/182・今日の1問」だけでは「今日の1問」が何を示すか曖昧だったため、「今日の1問(デイリー)を既にクリア済みかどうか」(済み/未挑戦)を表示する設計にした(定石の「今日の復習」と同様、当日のアクションを促すゲーミフィケーション要素として一貫させる意図)。

### 2026-07-18 verifier検証(対象コミット 0196d7e)

- `npx vitest run`(app/): 95ファイル/754件 全パス。
- `npx tsc --noEmit -p tsconfig.app.json`(app/直下で実行、指示文の`app/tsconfig.app.json`はリポジトリルート基準のパスではnpxが node_modules を見つけられず動作しないため、app/直下+相対パスで実行しエラー0件を確認。指示コマンドの意図と等価)。
- 追加要件1〜5をコード確認: `--board-label-band: 1.35rem`化(index.css)/`--app-header-height`トークンが11箇所(5ファイル)で参照されマジックナンバー残存なし/`play-setup`の`.card`重複解消(app.tsx、CSS側は元々.card相当を直接指定済みで視覚差なし)/2人対戦投了非表示の専用テスト(app.playmode.stateSeparation.test.tsx)/PlayerBadgeのaria-label実装+専用テスト、いずれも確認。
- 進捗集計ロジック: `tsume/difficultyStats.ts`は難易度ごとにpoolをフィルタし空きマス最小/最大とクリア数(`stageStatus`ベース、Puzzle単位1レコード)を算出。`midgame/PracticeMode.tsx`の「クリア」定義は既存の★ロジック(`stageStatus`=いずれかの判定モードでクリア済み)をそのまま流用しており判定モード別記録との整合が取れている。`home/modeProgress.ts`はマウント時に3モード独立try/catchで取得し、失敗時はconsole.errorのみでstateを更新しない(`TitleScreen.tsx`は`card.progress`が`undefined`なら行自体を描画しないため表示は壊れない)。0件時の表示は`app.home.progress.test.tsx`で実データ相当のシナリオ(クリア0件)を確認済み。ただし**取得失敗時(reject)の専用テストは無く**、コードレビューでの論理確認に留まる(try/catchの構造上は安全)。
- Playwright(chromium, viewport 375x812)で本番Pages(`https://giwarb.github.io/othello-trainer/`)を確認: ホーム進捗行(定石「今日の復習112本」/中盤「クリア0/111」/詰め「クリア0/182・今日の1問未挑戦」、対局・棋譜解析は非表示で正常)、詰め難易度カード5枚(空きマス数帯+クリア数)、中盤チップ(3グループ、`--active`修飾、開始ボタン`btn-primary`高さ56px)、苦手パターン空状態(📊アイコン+説明文)、両モードのステージ一覧サマリ+進捗バー(aria-valuenow/valuemax)を全てDOMで確認。
- GitHub Actions: 対象コミット0196d7eの`Deploy to GitHub Pages`・`Rust Tests`とも`success`。
- `git status --short`: クリーン(コミット範囲は0196d7eのみでapp/配下、bench/・train/への差分なし)。
- 判定: 合格。

### 2026-07-18 implementer(Sonnet)redo#1対応完了(コミット `3d0ea39`)

セッション中断(APIエラー・利用枠復帰待ち)を挟んだが、途中変更(9ファイル)は破棄せず引き継いで完了させた。

**対応内容(4点)**

1. **(中1)チップのキーボードフォーカスリング可視化**: `midgame/PracticeMode.css`に`.midgame-settings__option:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }`を追加。本番Pagesで実際にTabキーを押してキーボードフォーカスを移動させ、`document.activeElement`が該当inputであること・ラップするlabelの`getComputedStyle().outline`が`2px solid rgb(134, 59, 255)`(`--color-accent`)になっていることを確認済み(programmatic `.focus()`だと`:focus-visible`が発火しないため、`computer(action:"key", text:"Tab")`で実際のキーボード操作として検証した)。
2. **(中2)ホーム実績行のモード復帰時再取得**: `app.tsx`の進捗取得`useEffect`の依存配列を`[]`→`[mode]`にし、`mode !== null`なら即returnする形にして「`mode === null`(ホーム)に戻るたび再取得」を実現。`loadJosekiDb`/`loadPuzzles`はモジュール内でPromiseキャッシュ済みのため実fetchは増えない。回帰テスト`app.home.progress.test.tsx`に「モードでクリアしてホームへ戻ると実績行の数値が更新される」を追加(vitestは`localStorage`への直接書き込みでクリアを再現)。本番Pagesでも実際に詰めオセロモードへ入り、`localStorage`(`othello-trainer:tsume-stage-progress`)に実在する問題ID(`tsume-4`、`puzzles.json`から実在確認済み)のクリア記録を書き込んでから「ホーム」ボタンでリロード無しに戻り、「クリア 1/182」→「クリア 2/182」への更新をライブ確認(確認後は元の状態に戻すクリーンアップ済み)。
3. **(中3)PlayerBadgeのaria-label付与先修正**: ルート`<div>`(暗黙ロール`generic`、ARIA1.2でaria-label prohibited)に`role="group"`を付与。`PlayerBadge.test.tsx`に`role="group"`のアサーションを追加。本番Pagesの対局モードで`.player-badge`の`role`/`aria-label`属性を直接確認し、両方とも意図どおり付与されていることを確認。
4. **(軽微)「クリアx/y」表記統一**: `home/modeProgress.ts`の`formatMidgameProgress`/`formatTsumeProgress`を「クリア」と数値の間にスペースを入れる形に統一(ステージ一覧サマリ・詰め難易度カードの表記に合わせた)。`modeProgress.test.ts`・`app.home.progress.test.tsx`・`TitleScreen.tsx`/`.css`/`.test.tsx`のコメント・サンプル文字列も追従。

**変更ファイル(10件、コミット`3d0ea39`)**: `app/src/TitleScreen.css`・`.tsx`・`.test.tsx`、`app/src/app.tsx`、`app/src/app.home.progress.test.tsx`、`app/src/components/PlayerBadge.tsx`・`.test.tsx`、`app/src/home/modeProgress.ts`・`.test.ts`、`app/src/midgame/PracticeMode.css`。

**検証**

- `npx vitest run`(app/): 95ファイル/755件 全パス(redo#1回帰テスト1件追加分)。
- `npx tsc --noEmit -p tsconfig.app.json`: エラーなし。
- mainへpush → GitHub Actions「Deploy to GitHub Pages」`success`(run 29639178955)。
- 本番Pages実機確認(上記1〜3参照。375x812縦持ち基準、キーボード操作含む): 全4点の修正が意図どおり反映されていることを確認。コンソールエラーなし。
- `git status --short`: `tasks/T137-ui-setup-screens.md`のみ残存(作業ログ追記分、オーケストレーター担当のためコミットしない)。それ以外の差分・未追跡なし。

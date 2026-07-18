---
id: T135
title: UX強化1: コンパクトヘッダとデザイン言語の統一(共通シェル)
status: redo # オーケストレーターのビジュアルQAによる差し戻し(デザイン階層)
attempts: 1
assignee: implementer(Sonnet)
attempts: 0
---

# T135: 共通シェル刷新

## 背景(オーケストレーターの実機UXレビュー 2026-07-18、スクショ検分に基づく)

ユーザー指示「全体的なUIもアプリとしての完成度が低い。動線から何までいまいち。UXにこだわって」。オーケストレーターが本番を375x812で全モード巡回した結果、**最大の問題は全画面共通のヘッダ**と**デザイン言語の不統一**:

1. 全画面で「オセロトレーナー」の巨大見出し(約90px)+2行折返しのナビピルが**画面上部の約370px(45%)を常時占有**。プレイ中も消えず、盤が下に押し出され、盤+情報が1画面に収まらない。
2. ホーム画面だけ紫グラデ+カードで整っているのに、各モードは**素のHTML部品**(灰色のデフォルト`<button>`、fieldset風の枠、中央寄せテキスト羅列)で、アプリというよりHTMLフォーム。紫のアクセントカラーがナビ以外で使われていない。

## 要件

1. **コンパクト・スティッキーヘッダ**: 全モード共通のヘッダを1行(高さ48〜56px)に刷新。左にアプリ名(小さく。プレイ中は現在モード名を優先表示でもよい)、ナビは**横スクロール可能な1行タブ**(現在地はっきり、折返し禁止)。`position: sticky`で上部固定。巨大見出し`<h1>`は**ホーム画面のみ**に残す。
2. **デザイントークンの定義と適用**: ホームの既存デザイン言語(紫アクセント、角丸カード、余白)を正とし、CSS変数(`--color-accent`等は既存があるはず。なければ定義)+共通クラスに整理:
   - **プライマリボタン**(紫背景・白字・角丸): 各画面の主アクション(開始/解析開始/復習を始める等)に適用
   - **セカンダリボタン**(白背景・枠線・アクセント文字): その他のアクション
   - **カード**(白背景・角丸・薄い影): 設定グループ・情報ブロック
   - 素の`<button>`デフォルト見た目を全画面から排除する
3. **タップターゲット**: ボタン高さ最小44px、間隔8px以上(モバイル基準)。
4. **適用範囲**: 全5モード+ホーム。この段階では**レイアウト構造の大改造はしない**(それはT136/T137)。ヘッダ差し替え+ボタン/カードのスタイル統一のみ。
5. 縦375px・横置き(T133導入の520px以下2カラム)の両方で崩れないこと(T133の成果を壊さない)。

## 追加要件(T133代替レビュー中指摘、tasks/review/T133-landscape-claude-review.md)

- `.board-container`への横置きグローバル上書き(`margin:0`等)がスコープ外画面(言語化・BlunderPanel等)に波及し、横置きで盤が左寄せになる。セレクタをスコープ付きに直す(対象画面のルートクラス配下に限定)。

## やらないこと(スコープ外)

- プレイ画面のレイアウト再構成(T136)/設定・一覧画面の情報再設計(T137)/下部タブバー化(今回は上部1行タブ。要望があれば別途)
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] ヘッダが全モードで1行スティッキー(375x812でヘッダ+ナビの占有が90px以下)になり、ホーム以外に巨大h1が無い
- [ ] 全画面から素のHTMLボタン見た目が消えている(主要アクション=プライマリ紫)ことを、**ビフォー/アフターのスクショ**(Playwright、375x812、全5モード+ホーム)を撮って作業ログに保存パスを記録
- [ ] `npx vitest run` 全パス(既存テストのセレクタ変更が必要なら追従)、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機で全モードのヘッダ・ボタンの新スタイルと横置き(844x390)の非退行を確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T135)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

### redo#1(2026-07-18、オーケストレーターが本番スクショでビジュアルQA。機能不具合ではなくデザイン階層の差し戻し)

1. **ヘッダのモード名二重表示を解消**: 現状「[ホーム] 対局(テキストラベル) [対局(紫アクティブタブ)] [定石練習]…」とモード名が2回出ている。テキストラベルを削除し、タブのアクティブ状態だけで現在地を示す(スペースも節約される)。
2. **プライマリボタンの規律**: 「1画面にプライマリは原則1個(最大2個)」を適用する。同格の選択肢グループは全てセカンダリにする。具体的な割当:
   - 対局: 「黒番で開始」のみprimary、他の開始4種はsecondary
   - 詰めオセロ: 「今日の1問(デイリー)」のみprimary。難易度1〜5とランダム・ステージ一覧はsecondary
   - 定石練習: 「復習を始める」primary(due>0時)。黒番/白番/ランダム開始はsecondary
   - 中盤練習「開始」・棋譜解析「解析開始」は現状どおりprimary(これは正しい)
3. 修正後、アフタースクショ(375x812、対局・詰め設定・定石・ヘッダ拡大)を撮り直して作業ログに記録。他の受け入れ基準(テスト・Pages確認)も再実行。最小差分でよい(コミットは`(T135)`)。

## 作業ログ(担当エージェントが追記)

- 2026-07-18 implementer(Sonnet)着手。`git pull --rebase`実行(既にorigin/mainと同期済み、T134まで反映確認)。
- 調査: `app/src/app.tsx`(共通シェル・`<h1>`+`.mode-nav`)、`app/src/app.css`・`index.css`(既存デザイントークン`--color-accent`等はT061で定義済みと確認)、`TitleScreen.tsx/.css`(ホームの正デザイン)、各モード(joseki/midgame/tsume/analysis)のTSX/CSSを確認。素の`<button>`(クラス無し)が全モードに多数存在することを確認。
- 追加要件の原因特定: `app.css`の横置きメディアクエリ内`.board-container`セレクタが素のクラスセレクタでスコープされておらず、`BlunderPanel.tsx`の`.blunder-panel__board`等スコープ外の盤にも`width`/`margin:0`が波及することを確認(`.clear-blunder-compare__board.board-container`は詳細度0,2,0で元々セーフだった)。
- 実装方針決定: 個別クラスへの`.card`併用はCSSインポート順依存の詳細度衝突リスクがあるため避け、(1) `index.css`にボタン共通ベース(`button{}`グローバル既定=セカンダリボタン相当、最小44px)+`.btn-primary`/`.btn-secondary`/`.card`の3ユーティリティクラスを定義、(2) 各画面の主アクションのみJSXに`.btn-primary`を明示追加、(3) 既存の設定グループ枠(`.settings`/`.analysis-settings`/`.midgame-settings__group`/`.tsume-settings__group`/`.joseki-due-summary`/`.midgame-pattern-stats`/`.tsume-stats-summary`)は各CSSファイル側でカードのトークンを直接指定(クラス併用ではなくルール自体を更新、詳細度衝突を回避)。
- グローバル`button{min-height:44px}`が既存の小型ボタン(テーブル内インライン操作・盤面自由配置エディタの8x8グリッドセル)を壊す懸念を洗い出し、`analysis/AnalysisMode.css`の`.analysis-result__movelist-blunder-button`と`components/BoardEditor.css`の`.board-editor__cell`に`min-height`の明示解除を追加。
- `app.tsx`: `<h1>オセロトレーナー</h1>`+旧`.mode-nav`(ホームボタン込み2行折返し)を撤去し、`<header class="app-header">`(ホームボタン+現在モード名+横スクロール1行タブ)を`<main>`の兄弟要素として新設。`app.css`に`.app-header`(`position:sticky;top:0`)・`.app-header__home`・`.app-header__title`・更新版`.mode-nav`/`.mode-nav__tab`を実装。
- `app.css`: 横置きメディアクエリの`.board-container`グローバル上書きを、各モードCSSの`> .board-container`直接子スコープと同じ6セレクタ(`.play-board-area`/`.joseki-practice`/`.midgame-practice`/`.tsume-practice`/`.tsume-result`/`.analysis-result__board-area`)に限定し、追加要件を解消。死んだ`main > h1`非表示ルールも削除(h1自体が既にホームのみのため)。
- 各モードのプライマリCTA(黒番/白番/ランダム/2人対戦で開始、復習を始める、開始、難易度N、ランダムに出題、今日の1問、解析開始、この局面から開始、もう一度/ここからやり直す/次のステージへ/次の問題、この対局を棋譜解析で振り返る 等)に`.btn-primary`を付与。設定に戻る/ステージ一覧/やめる/キャンセル/いいえ等は既定(セカンダリ相当)のまま。
- 検証: `npx tsc --noEmit -p app/tsconfig.app.json` エラー無し。`npx vitest run` 87ファイル/723件全パス(既存テストのセレクタ変更は不要だった、`.mode-nav__tab`クラス名は維持)。
- スクショ取得: `git stash`で一時的にbefore状態に戻し(タスク配下ファイルは巻き込まないよう`-- app/`指定)、`npx vite`(ローカル、ポート5183)+Playwright(`npx -p playwright node`、375x812)でホーム+全5モードのbefore/afterを撮影後`git stash pop`で復元。保存先(いずれもscratchpad、リポジトリ外):
  - before: `C:\Users\yoshi\AppData\Local\Temp\claude\C--Users-yoshi-work-othello-trainer\a74684b6-fe54-4c81-a1d7-c94ce1ef4945\scratchpad\t135\before-00-home.png` / `before-play.png` / `before-joseki.png` / `before-midgame.png` / `before-tsume.png` / `before-analysis.png`
  - after: 同ディレクトリの `after-00-home.png` / `after-play.png` / `after-joseki.png` / `after-midgame.png` / `after-tsume.png` / `after-analysis.png`
  - Playwright実測: `.app-header`高さ53px、タブ/ホームボタン全て44px(受け入れ基準の90px以下・44px最小を実測でも確認)。
  - 追加要件の修正確認: 同ディレクトリ`verify-scoping.js`で844x390時の`getComputedStyle`を直接検証し、`.analysis-result__board-area > .board-container`はスコープ内上書き(width≈187px・margin:0)が効く一方、`.blunder-panel__board.board-container`(スコープ外)はスコープ外のまま(margin auto centered、幅も基準の`.board-container`既定に戻る)ことを確認。
- コミット: `b42370b`(`app: 共通シェルを1行スティッキーヘッダ化しデザイントークンを全画面に適用(T135)`、`app/src/`配下12ファイルのみ、`tasks/`は含めず)。※コミット本文に軽微なタイプミス(「左カラム本体」の意図箇所に「左カラムbomb本体」という余分な単語が混入)あり、コード自体には影響なし。
- push→GitHub Actions確認: `gh run watch 29633874121`で`Deploy to GitHub Pages`が成功(buildジョブ57s・deployジョブ11s、いずれも✓)したことを確認。
- 本番Pages実機確認: `https://giwarb.github.io/othello-trainer/` に対しPlaywrightで375x812(ホーム+全5モード)・844x390(対局モード、横置き非退行)を撮影。ローカルafter版と同一の見た目(コンパクトヘッダ・紫プライマリボタン・カード・T133横置き2カラムの維持)を確認。保存先(同ディレクトリ): `prod-00-home.png` / `prod-play.png` / `prod-joseki.png` / `prod-midgame.png` / `prod-tsume.png` / `prod-analysis.png` / `prod-landscape-play.png`(参考: ローカル横置き確認用に`landscape-play.png`等も同ディレクトリに保存済み)。
- `git status --short`最終確認: `app/src/`配下12ファイルのコミット済み差分のみで、未追跡・未コミットの残差分なし(タスク完了時点でクリーン)。

### redo#1対応(2026-07-18 implementer(Sonnet))

- フィードバック2点に対応(最小差分):
  1. **ヘッダ二重表示解消**: `app.tsx`から`<span class="app-header__title">{MODE_LABEL[mode]}</span>`を削除し、現在地はタブのアクティブ状態のみで示すようにした。`app.css`の`.app-header__title`ルール(通常・375px以下・横置きの3箇所)も未使用になったため削除。
  2. **プライマリボタンの規律(1画面原則1個・最大2個)**: フィードバック指定どおり変更。
     - 対局(`app.tsx`): 新規対局行は「黒番で開始」のみ`.btn-primary`、他4種(白番/ランダム/2人対戦/盤面自由配置)はsecondaryへ。あわせて盤面自由配置エディタパネルの開始ボタン群(黒番/白番/ランダム/2人対戦)も、開いている間は上の「黒番で開始」と同時に見えてしまうため全てsecondaryに揃えた(フィードバックの明示対象ではないが同じ規律を一貫適用、コメントで理由を明記)。
     - 詰めオセロ(`tsume/PlayMode.tsx`): 「今日の1問(デイリー)」のみ`.btn-primary`。難易度1〜5・ランダムに出題・ステージ一覧はsecondaryへ。
     - 定石練習(`joseki/PracticeMode.tsx`): 「復習を始める」は`dueLines.length > 0`のときのみ`.btn-primary`を条件付与(0件時はフォールバック出題に過ぎないためsecondary)。黒番/白番/ランダム開始はsecondaryへ。
     - 中盤練習「開始」・棋譜解析「解析開始」は変更なし(フィードバックで「現状どおりで正しい」と明記)。
  - 各結果画面(もう一度/次のステージへ/次の問題等)はフィードバックの明示対象外かつ最大2個以内に収まっているため変更していない。
- 検証: `npx tsc --noEmit -p app/tsconfig.app.json` エラー無し。`npx vitest run` 87ファイル/723件全パス。
- スクショ再取得: `npx vite`(ローカル、ポート5184)+Playwright(`npx -p playwright node`)で撮影。保存先(scratchpad、いずれも同ディレクトリ`...\scratchpad\t135\`):
  - ヘッダ拡大(二重表示解消の確認): `redo1-header-play.png` 他4モード分(`redo1-header-joseki.png`/`redo1-header-midgame.png`/`redo1-header-tsume.png`/`redo1-header-analysis.png`)
  - 全画面(375x812): `redo1-00-home.png` / `redo1-play.png` / `redo1-joseki.png` / `redo1-midgame.png` / `redo1-tsume.png` / `redo1-analysis.png`
  - 盤面自由配置エディタ状態(primary重複が無いことの確認): `redo1-play-editor.png`(目視確認: 画面内でprimaryは「黒番で開始」1つのみ)
- コミット: `d6637bd`(`app: T135 redo#1 ビジュアルQA差し戻し対応(ヘッダ二重表示解消・primary規律)(T135)`、`app/src/app.css` `app.tsx` `joseki/PracticeMode.tsx` `tsume/PlayMode.tsx` の4ファイルのみ)。
- push→Actions確認: `gh run watch 29634213698`で`Deploy to GitHub Pages`成功(build 55s・deploy 9s)。
- 本番Pages実機確認: `https://giwarb.github.io/othello-trainer/` で375x812(対局・詰め・定石)・ヘッダ拡大・844x390横置き(対局)を撮影し、ローカル修正後と同一の見た目(二重表示解消・primary1個のみ・横置き非退行)を確認。保存先: `prod-redo1-play.png` / `prod-redo1-header.png` / `prod-redo1-tsume.png` / `prod-redo1-joseki.png` / `prod-redo1-landscape-play.png`。
- `git status --short`最終確認: クリーン(タスクファイル自体の差分のみ、コミットはオーケストレーター担当のため未コミットのまま)。

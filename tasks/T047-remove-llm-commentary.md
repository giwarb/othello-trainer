---
id: T047
title: LLMによるAI講評/AI感想戦機能(T037)を削除する
status: todo
assignee: implementer
attempts: 0
---

# T047: LLMによるAI講評/AI感想戦機能(T037)を削除する

## 目的

ユーザー判断により、T037で実装した任意LLM解説層(BYOK、Anthropic Claude APIによる「AI講評」「AI感想戦」)機能は不要と決定。関連コードをクリーンに削除する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- T037で実装されたLLM解説層は`app/src/llm/`ディレクトリに集約されている: `buildStructuredInput.ts`(+テスト)、`client.ts`(+テスト)、`CommentaryView.tsx`、`apiKeyStorage.ts`(+テスト、APIキーのlocalStorage保存)、`LlmSettings.tsx`・`LlmSettings.css`、`prompt.ts`、`types.ts`。
- この機能は棋譜解析モードの2箇所から使われている(`app/src/analysis/BlunderPanel.tsx`46-48行目、`app/src/analysis/AnalysisMode.tsx`22-25行目)。それぞれ`buildStructuredInput`/`buildGameSummaryInput`、`CommentaryView`、`prompt.ts`由来の定数、`LlmSettings`をimportして使っている。
- APIキーは`apiKeyStorage.ts`経由でlocalStorageに保存されている想定(IndexedDBではない)。IndexedDBのスキーマ変更(バージョンアップ)は不要なはず(要確認)。

## 変更対象

- `app/src/llm/`ディレクトリ全体(`buildStructuredInput.ts`・`.test.ts`、`client.ts`・`.test.ts`、`CommentaryView.tsx`、`apiKeyStorage.ts`・`.test.ts`、`LlmSettings.tsx`・`.css`、`prompt.ts`、`types.ts`)を削除する。
- `app/src/analysis/BlunderPanel.tsx` — `llm/`からのimport(46-48行目)と、それらを使っているUI・ロジック(AI講評ボタン・`CommentaryView`表示等)を削除する。
- `app/src/analysis/AnalysisMode.tsx` — `llm/`からのimport(22-25行目)と、それらを使っているUI・ロジック(「AI感想戦」セクション、`LlmSettings`設定UI等)を削除する。
- 上記2ファイルの削除に伴い不要になったstate・関数・CSSクラスがあれば併せて削除する。
- `app/src/analysis/`配下、`app/src/llm/`を参照する他のテストファイルがあれば更新・削除する。

## 要件

1. `app/src/llm/`ディレクトリおよびその参照が完全に削除され、`grep`等で`from '../llm/`のようなimportがどこにも残らないこと。
2. 棋譜解析モードのUIから「AI講評」「AI感想戦」関連のボタン・表示・設定画面が消えること。
3. 削除によってビルドエラー・型エラーが発生しないこと。
4. 既存の他機能(棋譜解析のムーブリスト・評価グラフ・悪手分析パネル本体等)に影響が無いこと。
5. `npm test`が全件パスすること(削除対象のテストファイルは削除、他のテストは影響を受けないこと)。

## やらないこと(スコープ外)

- IndexedDBのバージョンダウン・マイグレーションは行わない(APIキーがlocalStorage保存であることを確認できれば不要。もしIndexedDBに何か保存していた場合は、ストアを残したまま参照だけ削除する形でよい(データの完全消去までは不要)。
- 棋譜解析モードの他の機能(ムーブリスト・評価グラフ・悪手分析パネル)への機能追加・変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] `grep -r "llm/" app/src`(または同等の検索)で`app/src/llm/`への参照が残っていないことを確認する。
- [ ] 実機確認: 棋譜解析モードでAI講評・AI感想戦関連のUIが表示されないこと、他の機能(ムーブリスト・グラフ・悪手分析)が正常に動作することを`npm run dev`で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-10 implementer:
  - 事前確認: `grep -r "from '\.\./llm" app/src`等で参照元が`BlunderPanel.tsx`・`AnalysisMode.tsx`の2ファイルのみであることを確認(llm/内のテストファイル自身からの相互参照を除く)。`apiKeyStorage.ts`はlocalStorageのみ使用(IndexedDB不使用)であることを確認、IndexedDBマイグレーションは不要と判断。`BlunderPanel.css`にLLM専用CSSクラスが無いことも確認。
  - `app/src/llm/`ディレクトリ全体(12ファイル)を削除: `types.ts`, `buildStructuredInput.ts`, `buildStructuredInput.test.ts`, `prompt.ts`, `LlmSettings.css`, `LlmSettings.tsx`, `CommentaryView.css`, `CommentaryView.tsx`, `apiKeyStorage.ts`, `apiKeyStorage.test.ts`, `client.ts`, `client.test.ts`。
  - `app/src/analysis/BlunderPanel.tsx`: `llm/`からのimport3行を削除。「AI講評(任意)」の`<section>`ブロック全体(`CommentaryView`呼び出し含む)を削除。`attribution`・`refutation`・`comparePv`・`motifs`・`whyBad`は他セクション(評価内訳・反証層・なぜ悪いか等)で引き続き使用されているためそのまま維持。
  - `app/src/analysis/AnalysisMode.tsx`: `llm/`からのimport4行を削除。入力フェーズの`<LlmSettings />`呼び出しを削除。結果表示フェーズの「AI感想戦(任意)」`<section>`ブロック全体を削除。
  - `app/src/analysis/AnalysisMode.css`: 不要になった`.analysis-result__game-summary`・`.analysis-result__game-summary h3`のCSSルールを削除。
  - 検証: `grep -rn "llm/" app/src`および`CommentaryView|LlmSettings|buildStructuredInput|buildGameSummaryInput|buildCommentaryUserMessage|buildGameSummaryUserMessage|COMMENTARY_SYSTEM_PROMPT|GAME_SUMMARY_SYSTEM_PROMPT`の再grepで、いずれも0件(該当ファイルなし)であることを確認。
  - `cd app && npm test` → `Test Files 51 passed (51)` / `Tests 439 passed (439)`(全件パス)。
  - `cd app && npm run build` → `tsc -b`(型チェック)含め成功。`dist/`一式生成を確認。
  - 実機確認(ローカル、Playwright): `npm run dev`でdevサーバー起動(port 5183)後、Playwright(`playwright` npmパッケージ経由の自作スクリプト、実行後削除)で棋譜解析モードを開き、有効な棋譜(`othello.ts`のロジックで生成した20手のランダム合法手列)を入力して解析完了まで確認。
    - ページ全体・入力フェーズ・結果フェーズいずれにも「AI講評」「AI感想戦」の文字列が存在しないことを確認(`includes`で全てfalse)。
    - 結果フェーズでムーブリスト(`ムーブリスト`テキスト・`.analysis-result__movelist`テーブル)、評価グラフ(svg/canvas要素2件)が正常表示されることを確認。
    - ムーブリストの悪手マーカーボタンから悪手分析パネル(`.blunder-panel`)を開き、「比較PV」「なぜ悪いか」等の既存セクションが表示されること、「AI講評」が表示されないことを確認。
    - コンソールエラー・ページエラーは0件。
    - 確認後、devサーバープロセスは`taskkill`で終了済み。一時スクリプト(`app/check_llm_removed.mjs`・`app/gen_transcript.mjs`)も削除済み。
  - コミット・push: 変更対象ファイル(`app/src/analysis/{AnalysisMode.tsx,AnalysisMode.css,BlunderPanel.tsx}`・`app/src/llm/`削除・本タスクファイル)のみをステージしてコミット(他タスクの未コミット変更やCLAUDE.mdは対象外としてステージ除外)。コミットハッシュ・push結果・GitHub Actions Run URL・本番確認結果は次の追記で更新する。

---
id: T037
title: 言語化支援 任意LLM解説層(BYOK、構造化データのみを入力とする文章化)
status: in_progress
assignee: implementer
attempts: 0
---

# T037: 言語化支援 任意LLM解説層(BYOK、構造化データのみを入力とする文章化)

## 目的
`othello-trainer-design-verbalization.md` §9「任意LLM解説層」を実装する。これは言語化支援レイヤー(フェーズ6.5、T031〜T036)の最後のタスクである。ユーザーが自分のAPIキーを設定した場合のみ、悪手分析パネル・棋譜解析の結果を自然文の講評として生成できるようにする。既定はOFFで、未設定のユーザーには一切影響しない。

## 背景・コンテキスト
- 前提: T031(特徴量層・評価内訳分解層)・T032(モチーフ検出タグ)・T033(反証層)・T029/T030(比較PV)完了・コミット済み。これらの出力(構造化データ)がLLMへの入力になる。
- 設計書§9「任意LLM解説層」(正確に引用):
  - 「既定OFF・オフライン不要。ユーザー自身のAPIキーを設定画面で登録(BYOK)。GitHub Pagesからブラウザ直接呼び出し。」
  - 「**入力は生の局面ではなく、§1〜4の構造化出力**(特徴差分・寄与分解・回収点・タグ・PV)。LLMの役割は事実生成ではなく**文章化のみ**に限定し、プロンプトで『与えられた分析事実以外を述べない』と拘束。→ ハルシネーションで盤面と矛盾する解説が出る事故を構造的に防ぐ。」
  - 「出力例: 悪手1つにつき3〜4文の講評、または1局まとめの感想戦テキスト。」
  - 「未設定ユーザーには影響ゼロ(テンプレート説明が常に既定)。」
  - 構造化入力の例(設計書§10より正確に引用):
    ```jsonc
    {
      "features": { "mobilityDiff": [-1, +2], "openness": [6, 1], ... },
      "attribution": [ { "group": "corner", "delta": -4.1 }, ... ],
      "refutation": { "pv": [...], "criticalPly": 7, "criticalMotif": "corner_capture" },
      "tags": { "played": ["full_flip", "wall"], "best": ["uchiwari", "pull"] }
    }
    ```
- **本タスクでの設計方針**:
  - LLMプロバイダは1つに絞ってよい(実装者判断。Anthropic Claude APIを推奨するが、他の広く使われるプロバイダでもよい)。将来複数プロバイダに対応する拡張性を持たせる必要はない(過剰設計を避ける)。
  - APIキーは**必ずブラウザのlocalStorage(または同等のクライアントサイドストレージ)にのみ保存し、本アプリのサーバー(GitHub Pagesは静的ホスティングでサーバーサイド処理が無いこと自体がこの点を担保する)には一切送信しないこと**。LLMプロバイダの公式APIエンドポイントへ、ブラウザから直接HTTPリクエストを送る設計にすること。
  - **セキュリティ上の注意**: この実装ではAPIキーがブラウザのJavaScript実行コンテキストに露出する(BYOKの原理的な制約であり、設計書もこれを前提にしている)。リポジトリに実際のAPIキーやテスト用の実キーを絶対にコミットしないこと。単体テスト・実機確認では、実際のAPIキーを使う場合は一時的なものを使い、コミット前に確認すること。
  - LLM APIがブラウザからの直接呼び出し(CORS)をサポートしているか、実装前に確認すること(プロバイダによっては専用のヘッダー指定が必要な場合がある)。サポートしていない場合、その旨を作業ログに記載し、実装可能な代替手段(例: 別のプロバイダを選ぶ)を検討すること。**プロキシサーバーの新規構築(本プロジェクトはGitHub Pages静的配信のみが前提)はスコープ外とする**。

## 変更対象(新規作成/変更)
- `app/src/llm/types.ts`(新規): LLM解説機能の型定義(APIキー設定、構造化入力データ、生成結果)
- `app/src/llm/buildStructuredInput.ts`(新規): T031(特徴量・評価内訳分解)・T032(モチーフ)・T033(反証層)・比較PV(T030)の出力から、LLMへの構造化入力データを組み立てる純粋関数
- `app/src/llm/prompt.ts`(新規): プロンプトテンプレート(「与えられた分析事実以外を述べない」という拘束を含む)
- `app/src/llm/client.ts`(新規): LLM APIをブラウザから直接呼び出すクライアント(fetch、エラーハンドリング含む)
- `app/src/llm/apiKeyStorage.ts`(新規): APIキーのlocalStorage保存・読み込み(既存の`blunder/storage.ts`等のパターンを参考にしてよい)
- `app/src/llm/LlmSettings.tsx` + `.css`(新規): APIキー設定画面(設定/解除ができる。既定OFF)
- `app/src/llm/CommentaryView.tsx` + `.css`(新規): 生成された講評の表示コンポーネント(ローディング状態・エラー時のフォールバック表示含む)
- `app/src/analysis/BlunderPanel.tsx`(既存、拡張): 「AI講評を生成」ボタン(APIキー未設定時は非表示または設定画面への導線)
- `app/src/analysis/AnalysisMode.tsx`(既存、拡張): 1局まとめの感想戦テキスト生成機能(任意)
- テストファイル一式

## 要件
1. **APIキー設定**: 設定画面でAPIキーを入力・保存・削除できる。既定は未設定(OFF)。
2. **構造化入力の組み立て**: T031の評価内訳分解・T032のモチーフ検出・T033の反証層(回収点)・比較PVの情報を、設計書の例に準じたJSON構造にまとめる関数を実装する。
3. **プロンプト設計**: 「与えられた分析事実(構造化データ)以外を述べない」という拘束を明確にプロンプトに含める。盤面の生画像・生の着手列以外の情報(座標そのもの等)をどこまで渡すかは実装者判断でよいが、**LLMが構造化データに無い事実を作り出さないよう拘束することが最重要**。
4. **API呼び出し**: ユーザーのAPIキーを使い、ブラウザから直接LLM APIを呼び出す。ネットワークエラー・APIエラー(無効なキー・レート制限等)を適切にハンドリングし、失敗時はエラーメッセージを表示する(アプリ全体がクラッシュしないこと)。
5. **表示**: 悪手1つにつき3〜4文程度の講評を`BlunderPanel`に表示する。1局まとめの感想戦テキスト(`AnalysisMode`側)は実装者判断で対応してよい(必須ではないが、設計書に明記されているため実装を推奨)。
6. **未設定時の影響ゼロ**: APIキーが未設定の場合、既存のテンプレート説明(T030〜T036で実装済みの`whyBad`テキスト・モチーフタグ・反証層等)がそのまま表示され、LLM関連のUI要素は最小限(設定への導線のみ)にとどめる。既存機能に一切影響しないこと。
7. **レスポンシブ**: 375px幅で崩れないこと。
8. 単体テストで以下を検証する:
   - `buildStructuredInput`が、T031〜T033の出力から正しい構造化データを組み立てること
   - APIキーの保存・読み込みが正しく動作すること(実際のAPIキーではなくダミー文字列でテストする)
   - API呼び出しのエラーハンドリング(モックしたfetch失敗時等)が適切にフォールバックすること
9. 実機確認: 実際にブラウザでLLM解説機能を試す。**実際のAPIキーを使った実機確認を行う場合、料金が発生する可能性があることに注意し、最小限の呼び出し回数にとどめること**。APIキー未設定時に既存機能へ影響が無いこと、375px幅でも崩れないことは必ず確認する。実際のAPIキーでの生成確認が困難な場合(キーが用意できない等)は、モックしたAPI応答での動作確認でよい(その場合は理由を作業ログに明記すること)。

## やらないこと(スコープ外)
- 複数LLMプロバイダへの対応(1プロバイダに絞ってよい)
- プロキシサーバーの構築(GitHub Pages静的配信の前提を維持する)
- APIキーの暗号化保存等の高度なセキュリティ対策(localStorage保存で十分。BYOKの原理的な制約であることを踏まえる)
- 生成結果のキャッシュ・永続化(毎回生成でよい。必要と判断すれば実装してもよいが必須ではない)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、選定したLLMプロバイダとその理由、APIキー保存方式、プロンプト設計、実機確認結果(実キーでの確認可否とその理由)が記載されている
- [ ] リポジトリに実際のAPIキーがコミットされていないことを`git log`・`git diff`で確認する
- [ ] **(2026-07-08運用ルール)** 変更をmainにコミット・push・GitHub Actionsデプロイ成功を確認し、`playwright`で本番Pages URL上でAPIキー未設定時の動作(既存機能に影響が無いこと)を確認する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-09 implementer:

### 実装内容

- `app/src/llm/types.ts`(新規): `StructuredCommentaryInput`(1手の講評用)・`StructuredGameSummaryInput`(1局まとめ用)等の型定義。
- `app/src/llm/buildStructuredInput.ts`(新規): T031(`attribution.ts`)・T032(`motifs.ts`)・T033(`refutation.ts`)・比較PV(`comparePv.ts`)の出力から、上記の構造化データを組み立てる純粋関数(`buildStructuredInput`/`buildMoveFacts`/`buildGameSummaryInput`)。エンジン呼び出しは行わない。`attribution`/`refutation`/`comparePv`が未取得(`null`)の場合はフィールドを省略せず明示的に`null`のまま渡す(存在しない情報をLLMに捏造させないため)。
- `app/src/llm/prompt.ts`(新規): `COMMENTARY_SYSTEM_PROMPT`(1手講評用)・`GAME_SUMMARY_SYSTEM_PROMPT`(1局まとめ用)システムプロンプト。「与えられた分析事実(JSON)以外を述べない」「JSONの数値・タグ・手順の言い換えに徹する」ことを明示的に拘束。ユーザーメッセージは構造化データをそのままJSON文字列として埋め込む(`buildCommentaryUserMessage`/`buildGameSummaryUserMessage`)。
- `app/src/llm/client.ts`(新規): `requestCommentary`。Anthropic Messages API(`https://api.anthropic.com/v1/messages`)をブラウザから直接fetchする。ネットワークエラー・非2xx応答(401/403/429/5xx/その他)・応答形式異常のいずれも`CommentaryRequestError`にラップして投げ、呼び出し側でキャッチしてフォールバック表示する設計(アプリ全体はクラッシュしない)。
- `app/src/llm/apiKeyStorage.ts`(新規): `loadApiKey`/`saveApiKey`/`clearApiKey`。`blunder/storage.ts`(T019)と同じ`StorageLike`最小限インターフェースのパターンを踏襲(テスト用フェイクを注入可能)。読み取りのみ必要な呼び出し元向けに`ApiKeyReader`(`getItem`のみ)も分離。
- `app/src/llm/LlmSettings.tsx`+`.css`(新規): APIキー設定/削除UI。既定は未設定(OFF)。`AnalysisMode.tsx`の入力フェーズ(閾値設定の下)に配置。
- `app/src/llm/CommentaryView.tsx`+`.css`(新規): 生成された講評の表示コンポーネント。APIキー未設定時はAPI呼び出しを一切行わず、設定への導線テキストのみを表示する(要件6)。ローディング状態・エラー時のフォールバック表示・再試行ボタンを持つ。
- `app/src/analysis/BlunderPanel.tsx`(拡張): 「なぜ悪いか」セクションの後に「AI講評(任意)」セクションを追加。`buildStructuredInput`で構造化データを組み立て`CommentaryView`に渡すのみで、既存のUI・ロジックには一切手を加えていない。
- `app/src/analysis/AnalysisMode.tsx`/`.css`(拡張): 入力フェーズに`<LlmSettings />`を追加。解析結果フェーズ(評価グラフの直後)に「AI感想戦(任意)」セクションを追加し、`buildGameSummaryInput`(悪手・疑問手・逆転悪手のみ抜粋、既定上限12件)+`GAME_SUMMARY_SYSTEM_PROMPT`で1局まとめの感想戦テキスト生成に対応(要件5、任意項目だが実装した)。

### プロバイダ選定: Anthropic Claude API

タスク仕様の推奨に従いAnthropicを採用。理由:
1. Anthropic Messages APIは`anthropic-dangerous-direct-browser-access: true`ヘッダーを付与することでブラウザのJavaScriptから直接fetchできる(CORS対応済み、公式にサポートされたBYOKユースケード)。実装前に`claude-api`スキル経由でドキュメントを確認し、さらにWeb検索(Simon Willisonの記事等、複数の一次情報)でヘッダー名・挙動を裏取りした。これにより、本タスクでスコープ外とされているプロキシサーバーの新規構築が不要になる。
2. モデルは`claude-sonnet-5`を採用(`app/src/llm/client.ts`の`COMMENTARY_MODEL`)。悪手1つにつき3〜4文、1局まとめでも5〜8文程度の短い日本語文章生成であり最高性能モデルは不要と判断し、コストと日本語文章品質のバランスを優先した(実装者判断、タスク仕様「1プロバイダに絞ってよい」の範囲内)。

### APIキー保存方式

`window.localStorage`のみ(`app/src/llm/apiKeyStorage.ts`、キー`othello-trainer:llmApiKey`)。暗号化等の高度な対策はスコープ外(タスク仕様で明示)。設定・削除は`LlmSettings.tsx`から行う。

### プロンプト設計

システムプロンプト(`prompt.ts`)で「分析事実(JSON)に書かれていない情報を新たに作り出さない」「数値・タグ・手順の言い換えに徹する」ことを明示的に拘束し、ユーザーメッセージには`buildStructuredInput.ts`が組み立てた構造化データをそのままJSON文字列として埋め込む(生の盤面画像・座標そのものは渡さない設計)。これによりLLMの役割を「文章化のみ」に限定している。

### 検証結果

- `cd app && npm run typecheck` (実体は`npx tsc --noEmit -p tsconfig.app.json`。wasm-packがこの実行環境のPATHに無く`npm run wasm:build`が失敗するため、既存のwasmビルド成果物(`app/src/engine/pkg/`、事前に生成済み)を使って直接`tsc`を実行した): **エラー0**。
- `cd app && npm test` (実体は`npx vitest run`): **52ファイル438件全件パス**(既存テストの回帰なし)。本タスクで追加したテストは`app/src/llm/buildStructuredInput.test.ts`(9件: `buildMoveFacts`が生局面情報を含まないこと、attribution/refutation/comparePvが揃っている場合とnullの場合それぞれの組み立て、`buildGameSummaryInput`の抽出・件数上限)・`app/src/llm/apiKeyStorage.test.ts`(5件: 保存・読込・削除の往復、空文字列は未設定扱い、ダミーAPIキー文字列を使用)・`app/src/llm/client.test.ts`(6件: 正常系のリクエストヘッダー/ボディ検証、APIキー未設定時はfetch自体を呼ばない、ネットワークエラー・401・429・応答形式異常それぞれのエラーハンドリング。いずれもダミーのfetch実装(`fetchImpl`差し替え)によるモックで、実際のAPIキーは一切使用していない)。
- `cd app && npm run build` (実体は`npx tsc -b && npx vite build && node scripts/inject-sw-version.mjs`。同様の理由でwasm再ビルドをスキップ): **成功**(`dist/`一式生成、`sw.js`のCACHE_VERSION注入も確認)。
- リポジトリに実際のAPIキーがコミットされていないことを`git status`/`git diff`で確認済み(テスト・Playwright確認では全て`sk-ant-dummy-...`等のダミー文字列のみ使用)。

### 実機確認(APIキー未設定時、ローカル`vite preview`+Playwright)

`npx vite preview`(base path `/othello-trainer/`)+Playwright(chromium)で以下を確認(スクリプトは確認後に削除済み、リポジトリには残していない):
- 「棋譜解析」タブの入力画面に「AI講評(任意、Anthropic APIキーが必要)」設定UIが表示され、既定で「現在の状態: 未設定」であること。
- 短い棋譜(`f5d6c3d3c4`)を解析すると、悪手マーカーが4件検出され、解析結果画面の「AI感想戦(任意)」・悪手分析パネルの「AI講評(任意)」のいずれも、APIキー未設定時は設定への導線テキストのみを表示し、API呼び出しを一切行わないこと。
- 悪手分析パネルの他セクション(「なぜ悪いか」「反証層: 回収点」等、T030〜T033で実装済みの既存機能)がAI講評セクション追加後も従来どおり表示されること。
- ページ読み込み〜解析〜悪手分析パネル表示の一連の操作でブラウザコンソールエラーが0件であること。
これにより、要件6(APIキー未設定時に既存機能へ影響が無いこと)を実機で確認した。

### 実機確認(APIキー設定時、モックしたAPI応答)

**実際のAnthropic APIキーは用意できなかった(このセッションに実キーが渡されていない)ため、タスク仕様の許容に従いモックしたAPI応答での動作確認を行った。**
Playwrightの`page.route()`で`https://api.anthropic.com/v1/messages`へのリクエストをインターセプトし、ダミーAPIキー(`sk-ant-dummy-...`、実キーではない)を`localStorage`に注入した上で:
- 正常応答(200、`content: [{type: "text", text: "..."}]`)をモックし、「AI感想戦を生成」「AI講評を生成」いずれのボタンでも、モックしたテキストがそのまま画面に表示されることを確認。この際、実際に送信されたリクエストヘッダーに`anthropic-dangerous-direct-browser-access: true`・`anthropic-version: 2023-06-01`・`x-api-key`が正しく含まれていることを確認(ブラウザから直接Anthropic公式エンドポイントへ送っていること、本アプリのサーバーを経由していないことの裏付け)。
- 401(認証エラー)応答をモックし、「AI講評を生成」ボタン押下後に「APIキーが無効です。設定画面でAPIキーを確認してください。」というエラーメッセージが表示され、アプリがクラッシュしないことを確認。
- 375px幅のビューポートで、入力画面(AI講評設定含む)・悪手分析パネル(エラー表示含む)のいずれも横スクロールが発生しないことを確認(要件7: レスポンシブ)。

### 本番デプロイ・確認

変更をコミット(`1ae8c8d`)し`git push`でmainブランチへpush、`gh run watch 29003366116 --exit-status`でGitHub ActionsのPagesデプロイ完了(成功)を確認した。その上でPlaywright(chromium)で本番URL(`https://giwarb.github.io/othello-trainer/`)にアクセスし、以下を確認した(確認用スクリプトは確認後に削除、リポジトリには残していない):

- 「棋譜解析」タブの入力画面に「AI講評(任意、Anthropic APIキーが必要)」設定UIが表示され、既定で「現在の状態: 未設定」であること。
- 短い棋譜(`f5d6c3d3c4`)を解析すると悪手マーカーが4件検出され、「AI感想戦(任意)」・悪手分析パネルの「AI講評(任意)」いずれもAPIキー未設定時は設定への導線テキストのみを表示すること。
- ページ読み込み〜解析〜悪手分析パネル表示の一連の操作でブラウザコンソールエラーが0件であること。

以上により、要件6(APIキー未設定時に既存機能へ影響が無いこと)を本番のGitHub Pages環境で確認した。

---
id: T038
title: 棋譜解析モードへの定石DB連携(定石内の手を悪手誤判定から除外)
status: todo
assignee: implementer
attempts: 0
---

# T038: 棋譜解析モードへの定石DB連携(定石内の手を悪手誤判定から除外)

## 目的

ユーザー報告: 棋譜解析モードで「酉定石」等の既知の定石ラインを解析すると、定石内の手であっても評価ソースが常に「中盤(探索)」表示になり、序盤のヒューリスティック評価のノイズによってほぼ毎手「逆転」「??悪手」「?疑問手」と誤判定される。これは棋譜解析モード(`analyzeGame.ts`)が定石DB(`joseki/db.ts`)を一切参照していないために起きる(バグではなく機能未実装によるUX上の欠陥、オーケストレーターによる調査確認済み)。定石練習モードでは既に定石DB連携が実装されているため、同じ仕組みを棋譜解析モードにも適用し、定石ラインに乗っている間は評価ソースを「定石」にし、悪手判定・逆転判定の対象から除外する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- 定石DB: `public/joseki.json`(ビルド成果物、`bookgen/`で生成)。`app/src/joseki/lookup.ts`の`loadJosekiDb(fetchImpl?, basePath?): Promise<JosekiDb>`でfetchし、モジュール内でPromiseキャッシュされる(初回のみfetch)。
- 定石ノード照会: `app/src/joseki/lookup.ts`の`lookupJosekiNode(db, board, sideToMove, firstMoveSquare): JosekiLookupResult | null`。
  - `board`は現在の盤面(ビットボード表現、既存の`Board`型)、`sideToMove`はその局面の手番(`'black' | 'white'`)、`firstMoveSquare`はこの対局の最初の一手が打たれたマス(定石DAGの対称正規化に必要)。
  - 戻り値`JosekiLookupResult`は`bookMoves: readonly JosekiBookMoveView[]`(`{move, weight}`、実座標。この局面から定石として許容される次の一手集合)と`node.isLeaf`・`node.names`(この局面が属する定石ライン名の配列)を持つ。
  - 内部で8対称正規化(`app/src/joseki/normalize.ts`の`normalizeBoard`)を行うため、呼び出し側は生の`board`と実際の初手座標をそのまま渡せばよい(正規化を意識する必要はない)。
- 定石練習モードでの実装パターン: `app/src/joseki/PracticeMode.tsx`(166-188行目付近で相手番の候補手取得、224・251行目付近で`advance`/`handleHumanClick`内から`lookupJosekiNode`を呼んでいる)。`firstMoveSquare`は「対局の最初の一手が打たれた時点で確定し、以降使い回す」設計。棋譜解析モードでは対局全体の棋譜が既に確定しているので、`notationToSquare(moves[0])`で一意に求められる。
- 棋譜解析の本体: `app/src/analysis/analyzeGame.ts`。`analyzeGame(engine, moves, options)`が入力(着手列)を`replayGame`で全局面再生し、終局側から`i = total-1..0`のループで各手を`analyzePosition`(キャッシュ付き探索)経由で評価、`classifyMove(lossDiscs, thresholds)`(`app/src/analysis/classifyMove.ts`)で悪手分類し、`MoveAnalysis`(`app/src/analysis/types.ts`)の配列を返す。定石照会を入れるのはこのループ内、`lossDiscs`確定後(179行目付近)が自然。
- 評価ソースの型は`app/src/blunder/types.ts`に`export type EvalSource = 'joseki' | 'exact' | 'midgame'`として**既に定義済み**。`app/src/*/EvalBadge.tsx`の`SOURCE_LABEL`にも`joseki: '定石'`のラベルが**既に用意済み**(表示ロジックは変更不要)。
- 現状`MoveAnalysis`(`app/src/analysis/types.ts:37-63`)には`isExact: boolean`のみがあり、定石かどうかを表すフィールドが無い。呼び出し側(`app/src/analysis/AnalysisMode.tsx:435`、`app/src/analysis/BlunderPanel.tsx:484,488`)は`source={m.isExact ? 'exact' : 'midgame'}`とハードコードしている。
- IndexedDBの解析結果キャッシュ(`app/src/analysis/cache.ts`)は`positionHash + limitTag`をキーにエンジンの生の全合法手評価のみを保持しており、定石情報は含まない。定石判定はキャッシュとは独立に`analyzeGame`実行時に毎回`lookupJosekiNode`で行うため、**このキャッシュのスキーマ変更・`db/appDb.ts`のIndexedDBバージョン変更は不要**。

## 変更対象

- `app/src/analysis/types.ts` — `MoveAnalysis`に`evalSource: EvalSource`(`app/src/blunder/types.ts`の`EvalSource`型を再利用、import追加)を新設。既存の`isExact`フィールドは削除せずそのまま残す(他の消費箇所への影響を避けるため)。`evalSource`の値は「定石内の手なら`'joseki'`、そうでなく`isExact`が真なら`'exact'`、それ以外は`'midgame'`」という優先順位で決定する。
- `app/src/analysis/analyzeGame.ts` — 関数シグネチャに定石DBを受け取るオプション(例: `josekiDb: JosekiDb | null`)を追加。呼び出し元がロード済みの`JosekiDb`を渡さない場合(`null`)は、従来通りの挙動(全手`midgame`/`exact`のまま、定石照会をスキップ)にフォールバックする。ループ内で各手について`lookupJosekiNode(josekiDb, 着手前の盤面, mover, firstMoveSquare)`を呼び、返り値の`bookMoves`に実際に打たれた手が含まれていれば「定石内の手」と判定する。`firstMoveSquare`は`moves[0]`から一度だけ算出しループ全体で使い回す。
- `app/src/analysis/analyzeGame.ts` — 「定石内の手」と判定された場合、`classification`を`'best'`固定、`lossDiscs`を`0`固定、`reversal`を`false`固定、`evalSource`を`'joseki'`にする(既存の`classifyMove`・逆転判定ロジック自体は変更しない。定石ヒット時はその結果を上書きする形にする)。定石名(`node.names`)を`MoveAnalysis`に持たせたい場合は`josekiNames?: readonly string[]`のような任意フィールドを追加してよい(UI側で「定石(酉)」のような表示に使う想定。必須ではないので実装が煩雑になる場合は省略してよい)。
- `app/src/analysis/AnalysisMode.tsx` — `loadJosekiDb()`(`app/src/joseki/lookup.ts`)を対局読み込み時にawaitし、`analyzeGame`の呼び出しに渡す。435行目付近の`source={m.isExact ? 'exact' : 'midgame'}`を`source={m.evalSource}`に置き換える。
- `app/src/analysis/BlunderPanel.tsx` — 484・488行目付近の同様の`source`指定を`m.evalSource`ベースに置き換える(こちらは悪手一覧パネルなので、定石内の手はそもそも悪手として一覧に出てこなくなる想定。既存の`node.evalType`由来の別ロジック(114行目付近、フリー分岐探索用)は本タスクのスコープ外なので変更しない)。

## 要件

1. 定石ライン内にある手(定石DBの`bookMoves`に実際の着手が含まれる手)は、棋譜解析結果で評価ソード「定石」として表示され、悪手・疑問手・逆転のいずれの誤判定タグも付かないこと。
2. 定石を外れた手(その局面で`lookupJosekiNode`が`null`を返す、または返り値の`bookMoves`に実手が含まれない)以降は、従来通りヒューリスティック探索/完全読みによる評価・悪手判定が行われること(定石を外れた時点から通常の評価に戻る)。
3. 定石DBのロードに失敗した場合(fetch失敗等)、棋譜解析全体がエラーで止まらず、従来通り全手を`midgame`/`exact`評価する動作にフォールバックすること。
4. 既存の完全読み(`exact`)判定・スコア自体には影響を与えないこと(定石内であっても実際のエンジン評価値自体は変更・非表示にする必要はない。ソースラベルと悪手分類・逆転判定のみを上書きする)。
5. 既存のテスト(`analyzeGame`関連のユニットテストがあれば)が壊れないこと。定石DB連携についての新規テストケース(定石内の手が`evalSource: 'joseki'`かつ悪手判定されないこと、定石を外れた後は通常評価に戻ること、定石DBロード失敗時のフォールバック)を追加すること。

## やらないこと(スコープ外)

- `classifyMove.ts`自体のロジック変更(閾値・ロス計算式)は行わない。定石内の手は`analyzeGame.ts`側で分類結果を上書きするだけにとどめる。
- 定石練習モード(`app/src/joseki/PracticeMode.tsx`)側の変更は行わない。
- IndexedDBキャッシュ(`cache.ts`)・`db/appDb.ts`のバージョン変更は行わない(定石情報をキャッシュに含める必要はない)。
- 評価関数自体(`engine/eval.rs`)の精度向上・WTHOR学習(フェーズ3)は本タスクのスコープ外。序盤ヒューリスティック評価のノイズそのものを減らす対応ではなく、あくまで「定石内は定石DBの判定を優先する」UI上の切り分けである。
- 定石を外れた直後の手に対する特別な緩和措置(閾値の一時的な緩和等)は行わない。定石を外れたら即座に通常の悪手判定に戻ってよい。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(または既存のテストコマンド、`app/`配下)が全件パスする。
- [ ] 追加した定石連携のユニットテストが、定石内の手で`evalSource: 'joseki'`かつ`classification: 'best'`・`reversal: false`になることを検証し、パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `bookgen/joseki-research.json`に収録済みの定石ライン(例: 酉定石)の棋譜を棋譜解析モードに入力し、定石ラインに乗っている手が「定石」ソース表示になり悪手・逆転タグが付かないこと、定石を外れた以降の手は従来通り評価・悪手判定されることをブラウザ(`npm run dev`またはビルド後のプレビュー)で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`(またはPlaywright MCP/スクリプト)で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記の実機確認と同じ内容を再現・確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-09 implementer: 実装完了。
  - `app/src/analysis/types.ts`: `MoveAnalysis`に`evalSource: EvalSource`(`../blunder/types.ts`の型を再利用)と任意フィールド`josekiNames?: readonly string[]`を追加。既存の`isExact`は変更せず維持。
  - `app/src/analysis/analyzeGame.ts`: `AnalyzeGameOptions`に`josekiDb?: JosekiDb | null`を追加。ループ内で`moves[0]`から`firstMoveSquare`を一度だけ算出し、各局面で`josekiDb`が渡されていれば`lookupJosekiNode`を呼び、実際に打った手が`bookMoves`に含まれるかを判定。定石内なら`evalSource:'joseki'`・`classification:'best'`・`lossDiscs:0`・`reversal:false`・`josekiNames`(該当ライン名)に上書きする。`josekiDb`が`null`/未指定なら従来通り(`isExact`に応じ`'exact'`/`'midgame'`)。
  - `app/src/analysis/AnalysisMode.tsx`: `loadJosekiDb()`をマウント時にuseEffectでロードし(失敗時はconsole.errorのみ、`josekiDb`は`null`のまま=フォールバック)、`analyzeGame`呼び出しに`josekiDb`を渡す。ムーブリストの`EvalBadge`の`source`を`m.isExact ? 'exact' : 'midgame'`から`m.evalSource`に置き換え。
  - `app/src/analysis/BlunderPanel.tsx`: 悪手分析パネル内の2箇所の`EvalBadge`の`source`を`moveAnalysis.evalSource`に置き換え(114行目付近の`node.evalType`由来の別ロジックはスコープ外につき変更なし)。
  - `app/src/analysis/analyzeGame.test.ts`: 単一ラインの最小定石DB(`buildJosekiDb`で`f5→d6`の2手を登録)を使い、(1)定石内2手が`evalSource:'joseki'`・`classification:'best'`・`reversal:false`・`lossDiscs:0`になり、スコア自体(`bestDiscDiff`/`playedDiscDiff`)は変更されないこと、(2)1手目(f5)は定石内・2手目(f6、bookMovesはd6のみのため定石外)は`evalSource:'midgame'`で通常の悪手判定(`blunder`)に戻ること、(3)`josekiDb: null`明示時は定石照会をスキップしフォールバックすることを検証する3ケースを追加。
  - `app/src/llm/buildStructuredInput.test.ts`: `MoveAnalysis`の新規必須フィールド`evalSource`をテスト用フィクスチャ`makeMoveAnalysis`に追加(`'midgame'`)。既存アサーションは変更なし。
- 受け入れ基準の実行結果:
  - `npx vitest run`(`app/`配下): 52ファイル・441件全件パス(新規3件含む)。
  - `npm run build`(`app/`配下): 成功(`tsc -b && vite build`、`dist/`生成、`inject-sw-version`も正常完了)。
  - 実機確認(`vite preview`、ローカル): Playwright(`chromium`)で棋譜解析モードに「酉定石」13手(`bookgen/joseki-research.json`)+「酉フック14-a3型」の14・15手目(`a3`,`g3`、いずれもDB収録済みのため定石内が継続)+定石DBに存在しない16手目(`e6`)、計16手を入力して解析。結果: 1〜15手目は評価ソース「定石」・分類◎・逆転タグなし・ロス±0.0で表示され、16手目(`e6`)のみ評価ソースが「中盤(探索)」に戻り、通常のロス計算・逆転判定(このケースでは自然に逆転扱いとなった)が行われることを確認。コンソールエラーなし。
  - 一時検証スクリプト`app/t038-legal.mjs`・`app/t038-verify.mjs`・`app/t038-prod-verify.mjs`(Playwrightでの手動E2E確認用)は確認後に削除済み(過去タスクT035〜T037と同様、リポジトリにはPlaywright E2Eテストの正式な仕組み(`playwright.config`等)が存在せず、手動検証スクリプトはコミット対象外とする慣例に合わせた)。
- 2026-07-09 implementer: mainへコミット・push・本番デプロイ・本番確認まで完了。
  - コミット`4ff20a4`(「app: 棋譜解析モードに定石DB連携を追加、定石内の手を悪手誤判定から除外(T038)」)で`app/src/analysis/{types.ts,analyzeGame.ts,analyzeGame.test.ts,AnalysisMode.tsx,BlunderPanel.tsx}`・`app/src/llm/buildStructuredInput.test.ts`・`tasks/T038-analysis-joseki-integration.md`のみをコミット(`CLAUDE.md`・他タスクファイルの変更はオーケストレーター管理分のため含めず)。`git push origin main`成功(`ed6bde8..4ff20a4`)。
  - GitHub Actions「Deploy to GitHub Pages」(run 29007795888)を`gh run watch`で監視、build・deployとも成功(約1分)。
  - 本番URL(`https://giwarb.github.io/othello-trainer/`)でPlaywright(`chromium`、headless)により、ローカル確認と同一の16手(酉定石13手+酉フック14-a3型の14・15手目+定石外16手目`e6`)を棋譜解析モードで解析。結果はローカルと完全に一致: 1〜15手目は評価ソース「定石」・分類◎・逆転タグなし・ロス±0.0、16手目(`e6`)のみ評価ソースが「中盤(探索)」に戻り通常の逆転判定(自然に逆転扱い)が行われた。コンソールエラーなし。
  - 以上により受け入れ基準(`npm test`全件パス・新規定石連携テストパス・`npm run build`成功・実機確認・本番push/デプロイ/Playwright確認)を全て満たした。仕様上曖昧だった点・判断が必要だった点はなし。

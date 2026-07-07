---
id: T019
title: 共通UI: 評価バッジ(ソース色分け)+ 悪手判定設定
status: todo
assignee: implementer
attempts: 0
---

# T019: 共通UI: 評価バッジ(ソース色分け)+ 悪手判定設定

## 目的
ユーザー要望「どのモードでも、今打った手の評価をすぐに出す。評価ソース(定石/中盤/終盤)を色分けする。悪手判定の閾値をユーザーが調整できるようにし、悪手なら理由を表示する」の共通基盤UIを構築する。今後実装する定石練習・中盤練習・詰めオセロ・棋譜解析のすべてのモードで再利用する。本タスクでは、既存の対局モード(T013)に組み込んで動作を実証する(理由表示の詳細な言語化はT018以降の別タスクで拡張するため、本タスクでは簡易的な理由表示にとどめる)。

## 背景・コンテキスト
- 前提: T013(対局モード)・T017(定石DB、`app/public/joseki.json`)・T018(複数候補手一括評価API、`EngineClient.requestAnalyzeAll`)完了・コミット済み。
- 評価ソースの判定ロジック:
  1. 現局面が定石DB(T017の`JosekiDb`)に登録されている(かつ`isLeaf`でない、まだ定石が続いている)場合 → **「定石」**(色: 例えば青系)
  2. それ以外で、T018の`allMoves`応答の`score.type`が`"exact"`(完全読み)の場合 → **「終盤(完全読み)」**(色: 緑系)
  3. それ以外(`score.type`が`"midgame"`) → **「中盤(探索)」**(色: 黄系)
- 悪手判定の3方式(ユーザー要望より):
  (a) 「最善以外」: 打った手が全合法手中の最善手でなければ悪手
  (b) 「差分n以上」: 打った手の評価値が最善手の評価値よりn(石差、ユーザー設定可能な数値)以上低ければ悪手
  (c) 「順位n位より下」: 全合法手を評価値でソートしたときの順位が、ユーザー指定のn位より下なら悪手
- レスポンシブデザイン必須(ユーザー明示指定)。スマートフォン幅(375px程度)からデスクトップ幅まで、崩れずに表示できること。

## 変更対象(新規作成/変更)
- `app/src/components/EvalBadge.tsx` + `.css`: 評価値・評価ソース(色分け)を表示するコンポーネント
- `app/src/blunder/types.ts`: `BlunderConfig`(判定方式・閾値)、`EvalSource`(`"joseki" | "exact" | "midgame"`)等の型定義
- `app/src/blunder/isBlunder.ts`: 3方式の悪手判定を行う純粋関数 `isBlunder(moves: MoveEvalJson[], playedMove: string, config: BlunderConfig): { blunder: boolean; lossDiscs: number; rank: number; bestMove: string }`
- `app/src/blunder/BlunderSettings.tsx` + `.css`: 判定方式・閾値をユーザーが設定できるUI(設定は`localStorage`に保存し、次回起動時も保持する)
- `app/src/joseki/lookup.ts`(または既存`app/src/joseki/`配下に追加): 現局面が定石DB内にあるか判定するヘルパー関数(T017の正規化ロジックを使い、盤面を正規化してハッシュ化し、`JosekiDb`のノードを検索する。`isLeaf`かどうか、`bookMoves`に含まれる候補も返す)
- `app/src/app.tsx`: 対局モードに評価バッジを組み込む(人間が着手した直後に、着手前の局面で`requestAnalyzeAll`を呼び、評価ソース・悪手判定結果を`EvalBadge`で表示する)
- テストファイル一式

## 要件
1. `EvalBadge`: 評価値(石差、例: `+2.4`)とソースラベル(「定石」/「中盤」/「終盤」)を、ソースごとに異なる色で表示する。レスポンシブ(狭い画面でも折り返し・省略されず読める大きさ・レイアウトになること)。
2. `isBlunder`: 3方式それぞれを実装し、判定結果に加えて「最善手からの石差ロス」「順位」「最善手の記法」も返す(悪手時の理由表示に使うため)。
3. `BlunderSettings`: ラジオボタン等で3方式から選択、数値入力で閾値n(方式(b)(c)用)を設定できるUIを実装する。`localStorage`への保存・読み込みを実装する。既定値は「差分1.0以上」程度の妥当な値にする。
4. 定石DBルックアップ: `app/public/joseki.json`をfetchして読み込み(初回のみ、以降キャッシュ)、T017の`normalize.ts`のロジックで現局面を正規化し、`JosekiDb`のノードを検索する関数を実装する。
5. 対局モードへの統合: 人間が着手した直後に、その着手前の局面で`requestAnalyzeAll`を呼び出し、評価ソース判定・悪手判定を行い、`EvalBadge`と(悪手なら)簡易的な理由テキスト(例: 「最善手 f5(+3.2)に対し、あなたの手 g4 は+0.8(ロス2.4石、順位3位)でした」程度でよい。詳細な言語化機能は別タスク)を画面に表示する。CPU番の手には表示不要(人間の着手のみでよい)。
6. 単体テストで以下を検証する:
   - `isBlunder`の3方式それぞれが、人工的な`MoveEvalJson[]`データに対して正しく判定すること(最善手を打った場合はどの方式でも悪手にならない、僅差の手・大きく劣る手で方式ごとに判定が変わるケースを含む)
   - 定石DBルックアップが、既知の定石ライン(例:「虎」の1手目`f5`)を正しく検出すること、定石に無い局面では`null`(またはそれに相当する値)を返すこと
   - `BlunderSettings`の設定保存・読み込みが正しく動作すること(localStorageのモック等)
7. 実機確認: 実際にブラウザで対局モードを動作させ、着手ごとに評価バッジが表示され、悪手を打った際に理由テキストが表示されることを確認し、作業ログに記載する。**レスポンシブ確認として、ブラウザの幅を狭くした状態(375px程度)でもレイアウトが崩れないことを確認する**(Playwrightのビューポート指定等で確認可能)。

## やらないこと(スコープ外)
- 特徴量層・評価内訳分解層などの高度な言語化(`othello-trainer-design-verbalization.md`の内容。将来タスク)
- 定石練習モード・中盤練習モード・詰めオセロ・棋譜解析モードそのものの実装(次タスク以降)
- 評価バーのグラフ表示(棋譜解析モードで実装予定)
- IndexedDBへの設定永続化(localStorageで十分。IndexedDBは棋譜・進捗データ用に別途後続タスクで使う)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、実際にブラウザで評価バッジ・悪手理由表示・レスポンシブ確認(狭い画面幅)の結果が記載されている

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-08 implementer: 要件どおり実装完了。

**実装したファイル:**
- `app/src/blunder/types.ts`: `EvalSource`/`BlunderMethod`/`BlunderConfig`/`DEFAULT_BLUNDER_CONFIG`/`BlunderJudgement`
- `app/src/blunder/isBlunder.ts` + `isBlunder.test.ts`: 3方式(worseThanBest/lossThreshold/rankThreshold)の悪手判定純粋関数。順位は同点同順位(標準的な競技順位付け)。
- `app/src/blunder/storage.ts` + `storage.test.ts`: `BlunderConfig`の`localStorage`保存・読み込み(`StorageLike`インターフェース経由でテスト時はフェイクに差し替え可能)。壊れたJSON・不正な形は既定値にフォールバック。
- `app/src/blunder/BlunderSettings.tsx` + `.css`: ラジオボタン(3方式)+数値入力(閾値2種、非選択中の方式の入力は`disabled`)。変更のたびに即座に保存。
- `app/src/joseki/lookup.ts` + `lookup.test.ts`: `lookupJosekiNode(db, board, sideToMove, firstMoveSquare)` で現局面の定石DB登録有無・`isLeaf`・逆正規化済み`bookMoves`を返す。`loadJosekiDb()` で`public/joseki.json`をfetch+キャッシュ(初回のみfetch)。
  - 設計判断: 定石DBは「初手をf5とみなす」正規化(T017)がされているため、対局中の任意の局面を引くには**その対局で実際に指された初手**が必要。`app.tsx`側で`game.lastMove`を監視し、対局最初の着手(人間・CPUどちらが先手でも)を`firstMoveSquare`として記録して`lookupJosekiNode`に渡す設計にした。
- `app/src/components/EvalBadge.tsx` + `.css`: 評価値(`+2.4`等)+ソースラベル(定石=青/終盤(完全読み)=緑/中盤(探索)=黄)+悪手マークのバッジ。
- `app/src/app.tsx`: 対局モードに統合。人間が着手した直後、着手前の局面で`requestAnalyzeAll`を呼び、`isBlunder`+`lookupJosekiNode`で評価ソース・悪手判定を行い`EvalBadge`と(悪手なら)理由テキストを表示。CPU番の手には表示しない(人間の着手時のみ`evaluateHumanMove`を呼ぶ)。`BlunderSettings`を常設パネルとして表示し、変更を`blunderConfig`状態に反映。

**検証コマンド結果:**
- `cd app && npm run typecheck` → エラー0(wasm:build含め成功)
- `cd app && npm test` → 10 test files / 86 tests 全件パス(既存76件+本タスク新規10件の回帰なし)
- `cd app && npm run build` → 成功(`tsc -b && vite build`、dist生成確認)

**実機確認(Playwright、headless chromiumで`npm run dev`起動し操作):**
- 黒番で開始 → 盤面表示、初手候補(d3/c4/f5/e6)を検出できることを確認。
- f5(定石の初手)を着手 → 評価バッジ`+0.0 定石`(`eval-badge--joseki`、青系)が表示されることを確認。
- CPU応答後、人間の2手目を着手 → バッジが`中盤(探索)`(黄系)に切り替わることを確認(定石を外れた局面の判定が正しく動作)。
- 明らかな悪手(コーナー隣接のb7)を着手 → バッジに`悪手`マーク(赤)が付き、理由テキスト
  「最善手 d3(-0.4)に対し、あなたの手 b7 は-40.3(ロス39.9石、順位5位)でした」
  が表示されることを確認(要件5の例文フォーマットと一致)。
- `BlunderSettings`: ラジオボタン3件・数値入力2件を確認、「最善手以外は悪手とする」に切り替え→ページリロード後も選択が保持される(`localStorage`永続化)ことを確認。
- レスポンシブ確認: ビューポート375×800pxでスクリーンショットを撮影し、`document.documentElement.scrollWidth === clientWidth`(横スクロールなし)、盤面・評価バッジ・設定パネルいずれも`getBoundingClientRect().right <= innerWidth`(画面幅からはみ出さない)ことを確認。設定パネルの閾値入力欄はメディアクエリにより縦積みに切り替わり、崩れなし。
- ブラウザコンソールエラー: 0件(通常幅・375px幅とも)。
- スクリーンショットは検証用スクラッチパッド(`scratchpad/pw/shots/`)に保存(リポジトリには含めていない)。

**セルフチェック:** `git status`で確認したところ、`tasks/`配下(本ファイルのみ)と`app/src/`配下の新規・変更ファイルのみで、想定外のファイル変更なし。オーケストレーター運用ルールの「例外」は適用していない(すべてタスクファイルに基づく通常の実装作業)。

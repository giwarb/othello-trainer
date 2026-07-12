---
id: T028
title: 詰めオセロプレイモード本体(出題UI+完全読み判定+成績記録+デイリー)
status: done
assignee: implementer
attempts: 0
---

# T028: 詰めオセロプレイモード本体(出題UI+完全読み判定+成績記録+デイリー)

## 目的
設計書 `othello-trainer-design.md` §5「詰めオセロ」のうち§5.3「プレイ仕様」を実装する。T027で生成した問題データを使い、実際に詰めオセロを解くプレイモードをアプリに追加する。

## 背景・コンテキスト
- 前提: T027(`app/public/puzzles.json`、`app/src/tsume/types.ts`)完了・コミット済み。T012(Worker+WASMエンジン統合)・T018(`requestAnalyzeAll`)・共通UIパターン(T019のEvalBadge、T020/T021のPracticeMode構成)を再利用する。
- 設計書§5.3「プレイ仕様」:
  - 着手 → 即時完全読みで最善維持か判定。相手応手は「最も粘る手」(プレイヤーの得を最小化)。
  - 失敗時: 全合法手の結果一覧(+6 / +2 / −4 …)を盤上オーバーレイ表示。
  - 成績: 正答率・平均時間・タグ別弱点を記録し、弱点タグを優先出題。
- ナビゲーションは既存の`app.tsx`のタブ構成(対局/定石練習/中盤練習)に「詰めオセロ」を追加する4タブ構成に拡張する。

## 変更対象(新規作成/変更)
- `app/src/tsume/PlayMode.tsx` + `.css`: 出題→着手→判定→(失敗時)全合法手結果オーバーレイ→次の問題、の画面
- `app/src/tsume/judgePuzzleMove.ts`: プレイヤーの着手が最善結果を維持するか判定する純粋関数(`requestAnalyzeAll`の完全読み結果を使う)
- `app/src/tsume/stats.ts` + IndexedDBストア(既存`app/src/db/appDb.ts`にストア追加): 正答率・平均時間・タグ別正答率の記録・読み出し
- `app/src/tsume/dailyPuzzle.ts`: T027の日付シード選択ロジックを使い、今日のデイリー問題を選ぶ
- `app/src/app.tsx`: ナビゲーションに「詰めオセロ」タブを追加(4タブ構成)
- テストファイル一式

## 要件
1. **出題画面**: 難易度選択(5段階、またはランダム/デイリー)→問題呈示(設計書の2形式: 「黒番、最善で+N」/「勝てるか?」)。
2. **着手判定**: プレイヤーが着手するたびに、`requestAnalyzeAll`(空きマス数が少ないため`exactFromEmpties`を問題の空き数以下に設定し完全読みを使う)で全合法手を評価し、`judgePuzzleMove`で「最善結果を維持しているか」を判定する。
3. **相手応手**: 「最も粘る手」(プレイヤーの得を最小化する手、= 相手にとっての最善手)を完全読みで選び自動着手する。
4. **失敗時UI**: 全合法手の結果一覧(石差)を盤上または一覧でオーバーレイ表示する。
5. **成績記録**: 正答率・平均時間(問題呈示から正誤確定までの秒数)・タグ別正答率をIndexedDBに記録する。次回出題時、弱点タグ(正答率が低いタグ)を優先的に出題する簡易ロジックを実装する(完全な最適化は不要、簡易な重み付けでよい)。
6. **デイリー問題**: 「今日の1問」を選べるUIを用意する。
7. **ナビゲーション拡張**: 4タブ構成にする。既存3モードの動作を壊さないこと。
8. **レスポンシブ**: 375px幅で崩れないこと。
9. 単体テストで`judgePuzzleMove`・`stats.ts`・`dailyPuzzle.ts`を検証する。
10. 実機確認: 実際にブラウザで詰めオセロモードを開始し、(a)問題が出題されること、(b)正解手を打つと正解と表示されること、(c)不正解の手を打つと全合法手結果オーバーレイが表示されること、(d)成績が記録され次回出題に反映されること、(e)デイリー問題が選べること、(f)375px幅でも崩れないこと、を確認し作業ログに記載する。

## やらないこと(スコープ外)
- 手筋タグの高度な分析(T027の簡易版タグをそのまま使う)
- 出題プールの高度な弱点優先ロジック(簡易な重み付けで十分)
- 棋譜解析モードとの連携(次タスク以降)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに実機確認結果が記載されている
- [ ] **(2026-07-08運用ルール)** 変更をmainにコミット・push・GitHub Actionsデプロイ成功を確認し、`playwright`で本番Pages URL上での動作を確認する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-09 implementer: T027の成果物(`app/src/tsume/types.ts`・`daily.ts`・`obf.ts`・`app/public/puzzles.json`)を読み込んで正確な型・関数シグネチャを確認したうえで実装した。

**新規作成**:
- `app/src/tsume/judgePuzzleMove.ts`(+test): 着手前局面の`requestAnalyzeAll`結果(`MoveEvalJson[]`)とプレイヤーの着手から「最善結果を維持しているか」を判定する純粋関数。`midgame/judgeMidgameMove.ts`と同じ`discDiff`(手番側視点・以後最適進行込み)の規約に基づき、打った手のdiscDiffが全合法手中の最大値と一致するか(浮動小数点誤差許容)で判定する。
- `app/src/tsume/dailyPuzzle.ts`(+test): T027の`daily.ts`(`dailyPuzzle`/`hashDateString`)をそのまま再利用する薄いラッパー。`todaysDateString`でローカル日付から`"YYYY-MM-DD"`文字列を作り、`todaysPuzzle(pool, now?)`で今日の1問を決定的に選ぶ。`daily.ts`自体は変更していない。
- `app/src/tsume/loadPuzzles.ts`(+test): `public/puzzles.json`をfetchして`PuzzleFile`として読み込む。`joseki/lookup.ts`の`loadJosekiDb`と同じ「初回のみfetch、以降キャッシュ」方針。
- `app/src/tsume/stats.ts`(+test): 挑戦記録(`PuzzleAttemptRecord`: puzzleId・correct・elapsedMs・tags・createdAt)をIndexedDB(`db/appDb.ts`に追加した`tsumeAttempts`ストア、`APP_DB_VERSION`を2→3に一元的に更新)に保存・読込する`recordAttempt`/`getAllAttempts`、全体正答率・平均時間を集計する`computeOverallStats`、タグ別正答率を集計する`computeTagAccuracy`、弱点タグ(正答率が低いタグ)を含む問題ほど選ばれやすくする簡易な重み付き抽選`pickWeightedPuzzle`/`puzzleWeight`(重み`= 2 - タグの平均正答率`。タグなし問題は基準重み`1`、未挑戦タグは正答率100%扱いで重み`1`)を実装。
- `app/src/tsume/PlayMode.tsx`+`.css`: 出題(難易度5段階/ランダム/デイリー)→着手→判定→(不正解時)全合法手結果一覧オーバーレイ→次の問題、の画面。プレイヤーは常に出題局面の手番側(`puzzle.sideToMove`)を担当し、着手のたび`requestAnalyzeAll`(`exactFromEmpties: puzzle.empties`で、空きマス数は単調減少するためセッション全体で完全読みが保証される。`engine/src/search.rs`の「空きマス数<=exactFromEmpties なら直ちに完全読み」規約に基づく)→`judgePuzzleMove`で判定する。相手(エンジン)は「着手前局面の評価値最大の手」(=相手にとっての最善手=プレイヤーの得を最小化する「最も粘る手」)を自動着手する。盤面が終局(`isTerminal`)に達するまで一度も悪手を打たなければクリア、最初に最善結果を維持できなかった時点で即座に失敗とし全合法手の結果一覧(石差)をテーブル表示する。1問ごとに正誤・経過時間・タグをIndexedDBへ記録し、設定画面に正答率・平均時間・タグ別正答率を表示する。正解を打つたびに`✓ 正解(最善を維持しています)`という一時的なフィードバックも表示する(要件10(b)を明確に満たすため追加)。

**変更**:
- `app/src/db/appDb.ts`: `TSUME_ATTEMPTS_STORE`(`tsumeAttempts`、keyPath `id`)を追加、`APP_DB_VERSION`を2→3に更新。既存の`josekiSRS`・`midgamePool`ストアには影響なし(`db/appDb.test.ts`の既存回帰テストは`APP_DB_VERSION`定数参照のため無修正で通過)。
- `app/src/app.tsx`: `AppMode`に`'tsume'`を追加し4タブ構成に拡張(`PlayMode as TsumePlayMode`としてimport、既存の対局用`PlayMode`との名前衝突を回避)。既存3モードのコード・動作は変更していない。

**検証結果**:
- `npm run typecheck`: エラー0で通過。
- `npm test`: 234件全件パス(既存233件+本タスクで追加した新規テスト、回帰なし)。うち`judgePuzzleMove.test.ts`(5件)・`dailyPuzzle.test.ts`(6件)・`stats.test.ts`(15件)・`loadPuzzles.test.ts`(3件)が本タスクの新規テスト。
- `npm run build`: 成功。`dist/puzzles.json`が正しく含まれることを確認。
- 実機確認(Playwright、`npm run build && npm run preview`のVite previewサーバに対して実施。`npm install --no-save playwright`で一時導入・Chromiumは既存ローカルインストール済み。検証スクリプトは確認後削除、package.json/package-lock.jsonへの変更なし):
  - (a) 「詰めオセロ」タブ→「ランダムに出題」で問題(例:「黒番、最善で+32.0(この局面、勝てるか?)」)が出題されることを確認。
  - (b) デイリー問題(`puzzles.json`+日付シードから本テストスクリプト側で`correctMoves[0]`を独自算出)を実際にクリックし、盤面に`✓ 正解(最善を維持しています)`のフィードバックが表示され、不正解画面には遷移しないことを確認(`tsume-306`、`correctMoves=["b1"]`)。
  - (c) 別セッションでランダム出題→(推測で)不正解手をクリックしたところ、不正解画面に遷移し、全合法手の結果一覧テーブル(8行、石差付き)が表示されることを確認。
  - (d) 設定画面に戻ると成績サマリ(「これまでの正答率: 0%(0/1問) / 平均時間: 7.5秒」等)とタグ別正答率が表示され、直前の挑戦結果が反映されていることを確認。
  - (e) 「今日の1問(デイリー)」ボタンで問題が出題されることを確認(2回のセッションで同一問題が選ばれる決定性は`dailyPuzzle.test.ts`で別途検証済み)。
  - (f) ビューポート375x700で設定画面・プレイ画面(盤面含む)いずれも`document.documentElement.scrollWidth`が376px以内に収まり、横はみ出しがないことを確認。
  - 既存「対局」「定石練習」「中盤練習」タブが引き続き正常表示されること、コンソールエラーが発生していないことも確認。
  - 検証スクリプト実行結果: 1本目11項目全OK、2本目(要件10(b)専用)1項目OK。
- 本番デプロイ確認: コミット`feb9a79`を`git push`し、`gh run watch 28983255529 --exit-status`でGitHub Actionsの`build`→`deploy`ジョブが両方成功したことを確認した。その後、上記と同内容のPlaywrightスクリプトを本番URL(`https://giwarb.github.io/othello-trainer/`)に対して再実行し、以下の通り全項目OKを確認した(検証スクリプトは確認後削除、コミット対象外):
  - 1本目(要件10(a)(c)(d)(e)(f)+既存モード回帰、10項目): 出題(白番、最善で+22.0)、不正解画面遷移+全合法手結果一覧(9行)、成績サマリ反映、デイリー問題出題、375px幅での設定画面・プレイ画面双方の非崩壊、既存「対局」「中盤練習」タブの動作、コンソールエラー0件、を全てOKで確認(`TOTAL: 10, OK: 10, NG: 0`)。
  - 2本目(要件10(b)専用): 本番の`puzzles.json`+日付シードから独自算出した本日のデイリー問題(`tsume-306`、`correctMoves=["b1"]`)の正解手を実際にクリックし、`✓ 正解(最善を維持しています)`のフィードバックが表示され不正解画面に遷移しないことを確認(`OK`)。
- 以上によりtypecheck・test・build・単体テスト・実機確認(ローカル+本番Pages)の受け入れ基準を全て満たしたことを確認した。

---

## 検証ログ(2026-07-09 verifier)

**判定: 合格**

実行したコマンドと結果:
1. `cd app && npm run typecheck`(事前に`export PATH="$HOME/.cargo/bin:$PATH"`でwasm-pack解決): エラー0で通過。
2. `cd app && npm test -- --run`: 31ファイル・234件全件パス(実装者報告と一致)。
3. `cd app && npm run build`: 成功。`dist/puzzles.json`が実際に出力されていることを確認。
4. `git log` / `gh run list`: コミット`feb9a79`(実装)・`52c9463`(作業ログ追記)がともに`origin/main`にpush済みであることを確認。両コミットに対応する「Deploy to GitHub Pages」ワークフロー(run 28983255529・28983353504)がいずれも`completed success`であることを`gh run list`で確認。

**重点確認: `APP_DB_VERSION` 2→3マイグレーションの安全性**
- `app/src/db/appDb.ts`を読み、`upgrade()`が`objectStoreNames.contains()`チェック付きの追加専用ロジック(既存ストアの削除・再作成を一切行わない)であることを確認。
- `fake-indexeddb`を使い、「v2の状態(josekiSRSに1件、midgamePoolに1件のデータを書き込み済み)のDBを、`appDb.ts`のupgrade()ロジックを忠実に再現したコード(APP_DB_VERSION=3)で開く」という実際のマイグレーションシナリオを検証スクリプト(`/tmp`上、リポジトリ非改変・検証後削除)で再現した。結果: v2で書き込んだ`josekiSRS`・`midgamePool`のレコードが1件も欠落・変化せず読み出せ、かつ新設の`tsumeAttempts`ストアが追加されて書き込み可能であることを確認(`RESULT: josekiSRS preserved = true, midgamePool preserved = true, tsumeAttempts store created = true, tsumeAttempts writable = true` / `PASS`)。
- `npx vitest run src/joseki/db.test.ts src/midgame/pool.test.ts src/db/appDb.test.ts`: 3ファイル19件全件パス。`joseki/db.ts`・`midgame/pool.ts`が`APP_DB_VERSION`変更後も正常動作することを裏付けた。

**`judgePuzzleMove.ts`のdiscDiff符号規約確認**
- `app/src/tsume/judgePuzzleMove.ts`と`app/src/midgame/judgeMidgameMove.ts`を比較読解。両者とも「`MoveEvalJson.discDiff`は手番側視点・以後最適進行込みの最終石差」という同一規約に基づき、`best = allMoves`中の最大値、`lossDiscs = best.discDiff - played.discDiff`(0未満はクランプ)、`correct = lossDiscs <= EPSILON`という一貫したロジックであることを確認。符号の反転や取り違えは見当たらない。`judgePuzzleMove.test.ts`(5件)のテストケース(最善手/非最善手/同点複数最善/空配列/手不整合)も規約通りの期待値になっている。

**Playwrightによる本番Pages実機確認(verifier自身が独立に再現)**
本番URL `https://giwarb.github.io/othello-trainer/` に対し、`app/node_modules/playwright`を用いて以下を確認(実装者の主張を鵜呑みにせず、verifier自身のスクリプトで再実行):
- 4タブ(対局/定石練習/中盤練習/詰めオセロ)がナビゲーションに表示され、詰めオセロタブへの遷移・出題(例:「白番、最善で+40.0(この局面、勝てるか?)」)が正常動作。
- **不正解パスの再現**: ランダム出題→適当なマスをクリックしたところ不正解となり、全合法手の結果一覧テーブル(6行、`b6 +46.0` / `h7 +34.0` / ... / `f1 +32.0`(実際に打った手))が正しく表示されることを確認。
- **正解パスの再現**: 本番の`puzzles.json`(`https://giwarb.github.io/othello-trainer/puzzles.json`、182問)と`daily.ts`のFNV-1aハッシュロジックを独立に再実装して本日(2026-07-09)のデイリー問題を算出したところ`tsume-306`(`correctMoves: ["b1"]`, `bestDiscDiff: 2`)となり、これは実装者が作業ログに記載した値と一致した。「今日の1問(デイリー)」ボタンで実際にこの問題を呼び出し、`b1`に対応する盤面座標(`notationToSquare`の規約: file=1,rank=0)をクリックしたところ、`✓ 正解(最善を維持しています)`のフィードバックが表示され不正解画面には遷移しないことを確認。
- 既存3モード(対局/定石練習/中盤練習)のタブがいずれも正常表示され、コンソールエラーは0件。
- 375px幅ビューポートで設定画面・プレイ画面いずれも`document.documentElement.scrollWidth`が375pxに収まり、横スクロール(はみ出し)が発生しないことを確認。

検証に使用した一時スクリプトはすべて`/tmp`上で作成・実行後に削除しており、リポジトリ内のファイル(`tasks/`配下・本作業ログを除く)は一切変更していない。

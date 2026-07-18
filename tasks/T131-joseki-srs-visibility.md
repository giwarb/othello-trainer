---
id: T131
title: 定石練習: SRS復習キューの見える化(今日の復習n本)
status: done # verifier/代替レビュー両合格(2026-07-18)
assignee: implementer(Sonnet)
attempts: 0
---

# T131: SRS復習の見える化

## 目的

定石練習のSRS(`app/src/joseki/srs.ts`、SM-2簡略版)は実装済みだが、ユーザーからは**完全に不可視**(調査確定: `PracticeMode.tsx:338-353`の`startPractice`がdueライン群からランダムに選ぶだけで、件数もリストも表示されない)。「今日何を復習すべきか」を見せて、SRSを学習体験として機能させる。

## 要件

1. 定石練習の開始画面に「**今日の復習: n本**」表示を追加(`isDue()`で判定したdueライン数。0本なら「今日の復習はありません」)。
2. due一覧の簡易リスト(定石名、最大10件+「他n本」)を折りたたみ等で見られるようにする。
3. 「復習を始める」ボタン: dueラインだけから出題する練習を開始(既存`startPractice`のdue優先ロジックを流用し、**dueのみに限定するモード**を追加。dueが0なら通常出題にフォールバックし、その旨表示)。
4. 復習完了の体験: due出題をこなしてdueが0になったら「今日の復習完了!」の表示(★実績の流儀に合わせた軽い達成感でよい)。
5. レスポンシブ(375px)で崩れないこと。SRSのスケジューリング計算(`srs.ts`)自体は変更しない。

## やらないこと(スコープ外)

- SRSアルゴリズムの変更・IndexedDBスキーマ変更 / 他モードの変更 / 通知機能
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] due件数・一覧・due限定出題・0件フォールバックのテスト(jsdom/ユニット)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機で「今日の復習」表示と復習開始を確認(375px込み。dueを作るためlocalStorage/IndexedDBの操作が必要なら手順を作業ログに記録)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T131)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18 implementer(Sonnet): 実装完了。
  - due判定・出題対象選択の純粋ロジックを新規 `app/src/joseki/dueLines.ts` に切り出した(`computeDueLines`/`previewDueLineNames`/`selectPracticeTargetLine`/`dueSummaryHeadline`)。`PracticeMode.tsx`の`startPractice`内にインラインだった「due優先・無ければ全体」ロジックをこれに置き換え、加えて`dueOnly`オプション(due限定・0件ならallLinesへフォールバック)を追加。
  - `PracticeMode.tsx`: 色選択画面に「今日の復習: n本」(0本時は状況により「今日の復習はありません」/「今日の復習完了!」)、due一覧のdetails(最大10件+「他n本」)、「復習を始める」ボタン(due限定出題、ランダム色)を追加。`PracticeState`に`reviewFallback`を追加し、due限定セッションが0件フォールバックした場合は`playing`画面に「本日の復習はないため、通常の出題です。」を表示。due限定セッションを完走してdueが0になったことを検知するため`dueOnlySessionActiveRef`(ref)と`justCompletedReview`(state)を追加、colorSelect画面に戻るたびにdueを再計算するeffectを追加。
  - `PracticeMode.css`: `.joseki-due-summary`関連のスタイルを追加、375px向けの`@media (max-width: 400px)`にpadding/font-size調整を追加。
  - テスト: `dueLines.test.ts`(純粋関数の単体テスト、due判定・プレビュー切り詰め・due限定選択と0件フォールバック・見出し文言の分岐を網羅)、`PracticeMode.dueVisibility.test.tsx`(fake-indexeddb/autoで実IndexedDBを使い、1手で完結する合成定石ラインを用いてUI結線を統合テスト。シナリオ1: 未挑戦→「今日の復習: 1本」表示→復習開始→1手でクリア→「もう一度」で戻ると「今日の復習完了!」。シナリオ2: 事前にdueDateを2099年に設定した状態をIndexedDBへ書き込み→「今日の復習はありません」表示→「復習を始める」クリックでフォールバック通知が出ることを確認)。
  - 検証コマンド: `npx vitest run`(77 files / 661 tests 全パス、うち joseki 配下 12 files / 88 tests)、`npx tsc --noEmit -p app/tsconfig.app.json`(joseki関連のエラーなし。`app/src/midgame/PracticeMode.tsx`に既存の未使用変数エラー6件があるが、これは並行作業中のT129の変更によるものでT131のスコープ外)。
  - コミット: `ea757f8`(`app/src/joseki/{PracticeMode.tsx,PracticeMode.css,dueLines.ts,dueLines.test.ts,PracticeMode.dueVisibility.test.tsx}` のみ、`git add`はファイルパス明示)。`git push origin main`実行時点でリモートは進んでいなかった(fast-forward、rebase不要)。
  - デプロイ確認: GitHub Actions「Deploy to GitHub Pages」(run 29628230446)成功。本番Pages(`https://giwarb.github.io/othello-trainer/`)で「定石練習」→ Service Workerの更新通知が出ていたため「今すぐ更新」を適用 → 色選択画面に「今日の復習: 112本」「復習対象のラインを見る(112件)」(開くと先頭10件+「他102本」)「復習を始める」ボタンを実機で確認。「復習を始める」クリックでdue限定の練習が開始されること(黒番・盤面表示)を確認。375px(375x812)にリサイズしても`document.documentElement.scrollWidth`が`clientWidth`と同じ(横スクロールなし)で表示崩れが無いことを確認。
  - 注記: 0件フォールバック通知(「本日の復習はないため、通常の出題です。」)と復習完了バナー(「今日の復習完了!」)は、本番DB(112ラインの多くが未挑戦=常時due)の状態を人為的に0件へ持っていくのがPages実機では非現実的なため、`PracticeMode.dueVisibility.test.tsx`の実IndexedDB統合テスト(シナリオ1・2)で実コードパスを通して確認済み。本番実機ではdue件数・一覧・復習開始ボタンの表示と動作(due>0の経路)のみ確認した。
  - Browser MCPの`computer{action:"screenshot"}`が本セッション環境でタイムアウトし続けたため、視覚確認は`get_page_text`/`javascript_tool`によるDOM・テキスト検証で代替した(操作自体はコンソールJS実行で行い、実装コードは変更していない)。

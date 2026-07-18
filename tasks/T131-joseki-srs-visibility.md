---
id: T131
title: 定石練習: SRS復習キューの見える化(今日の復習n本)
status: in_progress # todo | in_progress | review | redo | done | blocked
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

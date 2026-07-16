# 最終レビューレポート — T117

## (a) 重大（done を止めるブロッカー）

### 1. localStorageへの記録がIndexedDB処理の後に遅延され、結果確定直後のリロードで記録を失う

[PlayMode.tsx](C:/Users/yoshi/work/othello-trainer/app/src/tsume/PlayMode.tsx:261) の `saveAttempt` は、先に `recordAttempt` と `getAllAttempts` を `await` し、その完了後に初めて `recordStageAttempt` を呼び出しています。

一方、[PlayMode.tsx](C:/Users/yoshi/work/othello-trainer/app/src/tsume/PlayMode.tsx:293) の `finishClear` / `finishFail` は、結果画面へ遷移してから `saveAttempt` を待ちます。このため以下の競合が成立します。

1. クリアまたは失敗が確定する。
2. 結果画面が即座に表示される。
3. IndexedDBへの保存・全件再読込が進行する。
4. ユーザーがすぐに一覧へ戻る、またはページをリロードする。
5. リロードによって実行中の処理が打ち切られ、localStorageへ結果が書かれない。

IndexedDBが遅い、ハングする、ページを即座に閉じる、といった場合にも同じ欠落が起きます。また、保存される日時も挑戦確定時刻ではなくIndexedDB処理完了後の時刻になります。

これは要件3の「出題経路を問わず挑戦結果を記録」と、受け入れ基準の「ページをリロードしても記録が残っている」を通常操作で破れるためブロッカーです。同期的なlocalStorage更新は、結果画面を表示する前、または少なくとも最初の `await` より前に行う必要があります。

## (b) 中（次タスクで対応すべき）

### 1. 破損値の検証がスキーマの意味的制約を満たしていない

[stageProgress.ts](C:/Users/yoshi/work/othello-trainer/app/src/tsume/stageProgress.ts:58) の `isValidEntry` は、回数について有限な数値であることしか検証していません。そのため、負数や小数の `clearCount` / `failCount` が有効値として読み込まれます。また、日時フィールドは任意の文字列を許容します。

例えば次の値は現在の実装では有効扱いになります。

```json
{
  "tsume-1": {
    "firstClearedAt": "not-a-date",
    "lastClearedAt": null,
    "clearCount": -1,
    "failCount": 0.5,
    "lastAttemptAt": "",
    "lastResult": "clear"
  }
}
```

これは「ISO文字列・数値」という保存スキーマおよび「壊れた値は既定値フォールバック」という要件に対して不十分です。少なくとも回数を非負整数、日時を有効なISO日時として検証し、そのテストを追加するのが妥当です。

## (c) 軽微（記録のみ）

### 1. CSSに追加された日本語コメントが文字化けしている

[PlayMode.css](C:/Users/yoshi/work/othello-trainer/app/src/tsume/PlayMode.css:179) 以降の追加コメントが `ã‚¹ãƒ†...` のような文字化け状態です。実行時の表示や動作には影響しませんが、AGENTS.mdのUTF-8運用規律に反し、保守性を下げています。

### 2. ステージ一覧のUI統合テストがない

`stageProgress` の単体テストは、更新、往復、JSON破損、状態導出、未知IDを含む15件があり、要件6の主要部分は満たしています。一方、ステージセルのクリック、結果画面から一覧へ戻った際のマーク反映、全出題経路からの記録を自動検証するテストはありません。

公開環境での手動確認記録はありますが、今回指摘した保存タイミングの競合を防ぐ回帰テストも含め、今後はUIまたは関数境界のテストが望まれます。

## 検証結果

- `git log 9a57e04..a93abf2`: 対象コミットは `a93abf2` の1件。
- `git diff 9a57e04..a93abf2`: 変更は指定された4ファイルのみ。
- `puzzles.json`: 182問、ID重複なし。
- `git diff --check`: 問題なし。
- `npx tsc --noEmit`: 成功。
- `npm test -- --run`: レビュー環境のプロセス起動制限による `spawn EPERM` でVitest自体を開始できず、独立再実行はできませんでした。コード上のテスト失敗ではありません。
- 現在の作業ツリーにはT114由来として説明された `bench/edax-compare/` の変更・未追跡ファイルがありますが、レビュー対象コミットには含まれていません。

## (d) 総合判定

**不合格**

ステージ一覧、既存導線の維持、3状態表示、Puzzle.id単位の保存スキーマ、次ステージへの遷移、ID変更リスクのコメント、単体テストは概ね仕様に沿っています。

しかし、localStorage更新をIndexedDBの非同期処理後に置いたことで、結果画面表示直後のリロードや離脱により記録が欠落します。永続化は本タスクの中心要件であり、受け入れ基準のリロード保持を直接破るため、修正後の再レビューが必要です。
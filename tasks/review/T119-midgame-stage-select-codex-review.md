# T119 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### 1. ステージ順が仕様の「定石DBの定義順」になっていない

[stagePool.ts](C:/Users/yoshi/work/othello-trainer/app/src/midgame/stagePool.ts:94) は終端局面を局面ハッシュの辞書順でソートしています。

タスク仕様は「決定的な順序（定石DBの定義順）」を要求しており、`JosekiDb.lines` に保持されたライン定義順で列挙すべきです。さらに [stagePool.test.ts](C:/Users/yoshi/work/othello-trainer/app/src/midgame/stagePool.test.ts:50) はラインを逆順にしても番号順が変わらないことを検証しており、仕様と逆の挙動をテストで固定しています。

この結果、表示用ステージ番号が定石DBの定義順と対応せず、要件1を満たしません。

また、[stagePool.ts](C:/Users/yoshi/work/othello-trainer/app/src/midgame/stagePool.ts:103) はステージの出典名として `JosekiNode.names` 全体を使用しています。しかし `names` は「その局面を経由する全ライン名」であり、「その局面を終端とするライン名」ではありません。

実データを調べると、111個の `isLeaf` ノードのうち29個は `bookMoves` が残る短いラインの終端兼長いラインの通過点です。例えば最初の該当ノードには、実際の終端ライン以外を含む約80件の名前が入っています。UIの「他N件」は重複終端の出典数ではなく、単にその局面を通過するライン数を表示することになります。

`JosekiDb.lines` を定義順に走査して各ラインの終端ハッシュを求め、

- 最初に現れた終端の順序をステージ順にする
- 同じ終端ハッシュは重複除去する
- `josekiNames` にはその局面で実際に終了するライン名だけを蓄積する

という実装に直す必要があります。

## (b) 中（次タスクで対応すべき）

### 1. 終盤判定中に画面を離れても、古いセッションが進捗を記録できる

[PracticeMode.tsx](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:392) の完全読みは非同期ですが、セッションIDやキャンセル判定がありません。完全読み中も「やめる」ボタンは利用でき、[backToSettings](C:/Users/yoshi/work/othello-trainer/app/src/midgame/PracticeMode.tsx:813) も進行中の判定を無効化しません。

そのため、判定中に設定画面へ戻った後でも古い `checkEnd` が完了すると、

- 退出済みステージのclear/failを記録する
- `phase`を再び結果画面へ変更する
- 別画面へ移った後に★を付与する

可能性があります。ステージ進捗記録の追加によって、既存の非同期遷移問題が永続データの誤更新にも波及しています。

セッション世代IDまたはキャンセル用refを用意し、`await` 後に同じセッションがまだ有効な場合だけ結果確定・記録する必要があります。

### 2. 破損進捗の相関検証が不完全

[stageProgress.ts](C:/Users/yoshi/work/othello-trainer/app/src/midgame/stageProgress.ts:118) は、`clearCount > 0` のとき `firstClearedAt` と `lastClearedAt` が「両方null」の場合だけ不正とします。

しかしスキーマ上、クリア済みなら両方の日時が必要です。片方だけnullのデータも破損データですが、現在は有効として読み込まれます。破損フォールバック要件に合わせ、`clearCount > 0` なら両方非nullを要求するべきです。

## (c) 軽微（記録のみ）

### 1. `parseStageKey` の例外仕様と実装が一致しない

[stagePool.ts](C:/Users/yoshi/work/othello-trainer/app/src/midgame/stagePool.ts:61) は不正キーに対して `RangeError` を投げると記述されていますが、`abc_def_black` のように形式だけ合い、16進数部分が不正な値では `BigInt()` 由来の `SyntaxError` になります。

現在は信頼済みDBのキーだけを渡すため実害は限定的ですが、16進数形式・64bit範囲・黒白ビット重複も明示的に検証すると堅牢です。

## 検証結果

- `git log 8d15eb4..398db33`: 対象コミットは `398db33` の1件。
- `git diff 8d15eb4..398db33`: 申告どおり中盤練習関連6ファイルの変更。
- `npx tsc --noEmit`: 成功、エラーなし。
- `npm test -- --run`: このレビュー環境では Vite設定読み込み時の子プロセス起動がサンドボックスに拒否され、`spawn EPERM` で開始できませんでした。テスト失敗ではなく実行環境制約ですが、こちらでは589件の完走を独立確認できていません。
- `git status --short`: T119由来の残差はありません。表示された変更・未追跡ファイルは申告された `bench/edax-compare` 配下のT114 WIPのみです。
- ファイル変更は行っていません。

## (d) 総合判定

**不合格**

進捗保存、判定モード別★、ステージUI、ランダム練習導線の維持など大部分は実装されています。しかし、問題集の中核要件である「定石DBの定義順」がハッシュ辞書順へ置き換えられており、出典定石名にも終端ではないラインが混入しています。

ステージ番号と出典情報の生成方式そのものが要件1と一致しないため、現状のままdoneにはできません。加えて、退出後の非同期判定による進捗誤記録も修正が必要です。
調査の結果、重複は主に [AnalysisMode.tsx](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:178) 内に集中しています。ファイル変更・コマンドによる検証は行っていません。

## (a) 推奨する設計

`app/src/analysis/useMoveSequence.ts` を新設し、「開始局面から着手を積み上げるUI状態」をカスタムフックとして抽出する設計を推奨します。

想定するインターフェースは次のようなものです。

```ts
interface MoveSequenceState {
  readonly moves: readonly string[]
  readonly positions: readonly ReplayedPosition[] | null
  readonly current: ReplayedPosition | null
  readonly error: string | null
  readonly append: (square: number) => void
  readonly undo: () => void
  readonly reset: () => void
}

function useMoveSequence(
  start?: StartPosition,
  enabled?: boolean,
): MoveSequenceState
```

利用側は概ね次の形になります。

```ts
const manualSequence = useMoveSequence()
const customSequence = useMoveSequence(customStart ?? undefined, customStart !== null)
```

### 特定した重複

両タブには以下の同型処理があります。

- 独立した着手配列のstate
  - `manualMoves`
  - `customMoves`
- `replayGame()`を呼び、例外を表示用文字列に変換する処理
  - [AnalysisMode.tsx:247](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:247)
  - [AnalysisMode.tsx:258](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:258)
- 最終局面を取得し、終局していなければ着手を追加する処理
  - [AnalysisMode.tsx:303](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:303)
  - [AnalysisMode.tsx:336](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:336)
- 1手戻す処理
- 全着手をリセットする処理
- 最終局面の導出
  - [AnalysisMode.tsx:364](C:/Users/yoshi/work/othello-trainer/app/src/analysis/AnalysisMode.tsx:364)

盤面再構築そのものは既に [analyzeGame.ts:134](C:/Users/yoshi/work/othello-trainer/app/src/analysis/analyzeGame.ts:134) の `replayGame()`へ共通化されています。したがって、新ヘルパーがオセロの着手適用を再実装してはいけません。抽出対象は、`replayGame()`の呼び出しと着手配列のUI向け管理です。

### 推奨理由

- 標準初期局面とカスタム開始局面の差を`start`引数だけにできる。
- パス、非合法手、終局判定は引き続き`replayGame()`が唯一の実装になる。
- `AnalysisMode.tsx`から、例外処理・現在局面導出・append/undo/resetが消える。
- 将来、別の開始局面を使う入力方式を追加しても同じフックを再利用できる。
- `customStart`未確定時は`enabled=false`として表現でき、現在の「未確定なら再生しない」という差異も保持できる。

フック内部で`positions`を導出する際は、まず単純な同期計算のままで十分です。最大でも通常の対局手数程度であり、最適化の必要性が確認されてから`useMemo`を検討すべきです。

また、`append()`は現在と同じく`current.mover === null`なら何もしない仕様とします。合法手判定は`Board`と次回の`replayGame()`に任せ、フック内に別の合法手判定を増やさないのが安全です。

## (b) 代替案と却下理由

### 純粋関数だけを抽出する

例えば以下を`moveSequence.ts`へ置く案です。

- `replayMovesSafely(moves, start)`
- `appendMove(moves, square)`
- `undoMove(moves)`

テストしやすい一方、`useState`、現在局面の取得、append/undo/resetのハンドラーは両タブに残ります。今回指摘された重複を部分的にしか解消しないため、第一候補にはしません。

ただし、フック単体テストのためにDOM系テスト依存を追加したくない場合は、フック内部の導出処理だけを純粋関数として分離する折衷案は妥当です。

### `AnalysisMode.tsx`内のローカル関数にまとめる

変更量は小さくなりますが、コンポーネント固有のstate setterを引数に渡す不自然な関数になりやすく、再利用性もテスト容易性も低い設計です。ファイル自体も既に多くの責務を持つため却下します。

### 両タブ共通の表示コンポーネントを作る

盤面、手番表示、「1手戻す」「リセット」「解析開始」まで共通コンポーネント化する案です。UIの重複も減りますが、自由配置タブには以下の固有処理があります。

- 開始局面確定前の`BoardEditor`
- 「開始局面を編集し直す」
- `customStart`を解析へ渡す処理

条件分岐や追加ボタン用propsが増え、今回対象の「着手積み上げロジック」よりスコープが広くなります。まずロジックだけを抽出し、UI共通化は別の重複として扱う方が安全です。

### `replayGame()`自体を新モジュールへ移動する

`replayGame()`は解析処理でも使用され、既にカスタム開始局面、パス、非合法手を扱う共通ドメイン関数です。問題はその実装場所ではなく、`AnalysisMode`側の同型な状態管理です。移動はimport変更と回帰リスクを増やすだけなので不要です。

### `useReducer`で高度な状態機械にする

開始局面編集、確定、積み上げ、解析中まで一つのreducerに統合できますが、今回の重複解消には過剰です。標準入力と自由配置入力のライフサイクル差まで密結合になるため却下します。

## (c) 実装タスクへの分割案

### タスク1: 着手積み上げフックの追加

変更対象:

- 新規 `app/src/analysis/useMoveSequence.ts`
- 必要なら新規 `app/src/analysis/moveSequence.test.ts`

内容:

- 着手配列の保持
- `replayGame()`による全局面再構築
- 最終局面の導出
- エラー文字列化
- `append`、`undo`、`reset`
- 任意の`StartPosition`
- 未有効状態の表現

依存関係:

- なし
- 既存の`replayGame`、`ReplayedPosition`、`StartPosition`に依存

リスク:

- `start`のオブジェクト同一性を契機に自動リセットすると、親の再レンダーで意図せず着手が消える可能性がある。
- したがって、開始局面変更時のリセットは暗黙のeffectではなく、親から明示的に`reset()`する方が安全。
- Preactフックを直接テストする環境がない。現在のVitest設定はNode環境かつ`*.test.ts`のみなので、純粋ロジックを分けない場合はフックの直接テストが難しい。

### タスク2: `AnalysisMode`の移行

変更対象:

- `app/src/analysis/AnalysisMode.tsx`

内容:

- `manualMoves`、`customMoves`と各ハンドラーをフック呼び出しへ置換
- `manualReplay`、`customReplay`、`manualBoard`、`customBoard`の重複した導出を削除
- 解析開始時には各フックの`moves`を渡す
- `confirmCustomStart()`と`editCustomStart()`で必要な明示的リセットを行う
- 表示文言、ボタンの活性条件、解析開始条件は変更しない

依存関係:

- タスク1完了後

リスク:

- `customStart`確定と`reset()`が同一イベント内で行われるため、更新順序に依存した実装にしないこと。
- 標準タブと自由配置タブで着手履歴が独立したまま保たれることを確認する必要がある。
- タブ切替だけでは履歴を消さないという現在の挙動を維持する必要がある。

### タスク3: 回帰テスト・動作確認

変更対象:

- `app/src/analysis/moveSequence.test.ts`
- 必要に応じて既存 [analyzeGame.test.ts](C:/Users/yoshi/work/othello-trainer/app/src/analysis/analyzeGame.test.ts:85)

依存関係:

- タスク1、2完了後

確認項目:

- 標準初期局面から着手を追加できる。
- カスタム開始局面から着手を追加できる。
- 1手戻す、リセットが両入力で同じ結果になる。
- パスを含む局面で次の実着手者が正しい。
- 終局後のappendが無視される。
- 非合法な着手列のエラーが従来どおり表示可能な文字列になる。
- 自由配置の編集へ戻ると積み上げた着手が破棄される。
- 両タブの履歴が混ざらない。
- `npm test`、型チェック、ビルドが成功する。

リスク:

- 現行のテスト構成ではコンポーネント操作テストがありません。フックをDOMなしで十分に試験できない場合、純粋な状態遷移関数をフックから分離する必要があります。

実装規模が小さいため、実際のタスク化ではタスク1と2を一つのimplementerタスク、タスク3をtesterタスクとしてもよいでしょう。

## (d) 未確定事項・確認事項

1. 「共通ヘルパー」にカスタムフックを含めてよいか  
   純粋関数のみを期待している場合は、フックではなく`moveSequence.ts`の純粋ロジックへ寄せる必要があります。

2. UI重複も今回の対象にするか  
   盤面表示と操作ボタンにも重複がありますが、今回の目的が着手積み上げロジックなら対象外を推奨します。

3. テスト依存を追加してよいか  
   フックを直接テストするためのPreact向けレンダリング環境は現状確認できません。新規依存を増やさず、純粋関数の単体テストと既存の`replayGame`テストで担保する方針を推奨します。

4. `replayGame()`のエラーを通常状態として保持する必要があるか  
   UIからは合法手しか渡らない想定なので、本来は防御的処理です。互換性維持のため今回は残す設計ですが、エラー表示を共通フックの公開APIに含めるかは確認事項です。

結論として、ドメイン上の再生処理は既に`replayGame()`へ一本化されています。T081で抽出すべきなのは再生アルゴリズムではなく、その周囲にある「着手配列・現在局面・エラー・追加・undo・reset」のUI状態管理です。
# 最終レビュー: T129(苦手パターン統計)+ T131(定石SRS復習の見える化)

- レビュー日: 2026-07-18
- レビュアー: Claude(Fable 5、コードレビュー担当)
- 対象コミット:
  - T129: `8931951`(app: 中盤練習に苦手パターン統計を追加)
  - T131: `ea757f8`(app: 定石練習にSRS復習キューの見える化を追加)
- 照合タスク: `tasks/T129-weakness-pattern-stats.md` / `tasks/T131-joseki-srs-visibility.md`
- レビュー方法: 両コミットの `git show` 差分 + 周辺コード(現行 `PracticeMode.tsx`(midgame/joseki)、`srs.ts`)の読解。作業ツリーに並行タスクの差分が混在しうるため差分ベースで確認(レビュー時点では `app/src/midgame` `app/src/joseki` に未コミット差分なし)。
- 検証実行: `npx vitest run`(両タスクの関連5テストファイルに限定)→ **5 files / 66 tests 全パス**(タスクの許可範囲内。typecheck・wasmビルド・benchは指示どおり未実行)。

## 総合判定

| タスク | 判定 | 重大 | 中 | 軽微 |
|---|---|---|---|---|
| T129 | **合格(done可)** | 0 | 0 | 3 |
| T131 | **合格(done可)** | 0 | 0 | 4 |

---

## T129: 苦手パターン統計(8931951)

### 観点(1) 記録タイミング(T117/T119教訓)— 問題なし

- 記録経路は `handlePlayerMove` のゲート経路のみ: `Promise.all(requestFeatureSet×2)` の await 直後に `sessionGenerationRef.current !== generation` の世代ガード(PracticeMode.tsx:756)→ 以降 `detectClearBlunderPatterns` / `detectAllClearBlunderPatterns` / `handleModeFailure` 呼び出しまで**awaitを挟まない同期実行**。`handleModeFailure` の先頭(636-637行)で `recordStageAttemptNow` と並んで `recordPatternFailuresNow` が最初のawait(`requestAnalyze`、645行)より前に同期実行される。T117教訓どおり。
- **ゲート合格時**(`patterns === null`): `applyMoveAndContinue` へ抜けるため記録されない(768行のコメントで明示)。テストで localStorage が null のまま残ることを確認済み。
- **離脱時**: 世代ガードが `handleModeFailure` 呼び出し自体を止めるため書かれない。コンポーネントテストに「featureSet応答を保留→『やめる』で離脱→応答解決→記録されない」の実挙動シナリオがあり、ガードを実際に通している(恒真でない)。
- フォールバック経路(featureSet取得失敗、785行)と bestMove無し経路(789行)は `allDetectedPatternIds` が既定 `[]` で記録なし。検出を実行していない経路なので仕様(「検出された全パターンID」)と整合。情報として付記: この2経路の失敗は統計に一切乗らない(仕様どおりだが、統計が「ゲート検出済み失敗」のみのカウントであることは今後のT130等で前提にすること)。

### 観点(2) detectClearBlunderPatterns リファクタの挙動不変 — 問題なし

- 変更前: 9検出器の配列を `filter(≠null)` → 0件でnull → `[...detected].sort(severity降順).slice(0,2)`。
- 変更後: 配列構築+filterを `detectAllClearBlunderPatterns` に切り出しただけで、null判定・コピーしてのsort・sliceの後段は**文字どおり不変**。検出器の列挙順も同一、`Array.prototype.sort` は安定なので同severity時の順序も従来と一致。既存テスト(表示上限・severity順のテスト含む)が無修正でパスしていることとも整合。

### 観点(3) localStorageスキーマのバリデーション — 問題なし

- `stageProgress.ts`(T117/T119)と同じ流儀: 壊れたJSON→try/catchで `{}`、配列・null・型違反エントリ→ `{}`、日時は `toISOString()` 厳密形式regex+往復一致、failCountは非負整数チェック。いずれもユニットテストで負例込みに固定されている。
- `recordPatternFailuresNow` / `handleResetPatternStats` は setItem の例外(quota等)も try/catch している。

### 観点(4) ラベル単一ソース化 — 問題なし

- `CLEAR_BLUNDER_PATTERN_LABELS` は `clearBlunder.ts` のみに定義。`Readonly<Record<ClearBlunderPatternId, string>>` 型なので9パターンの網羅性が型で強制される。`CLEAR_BLUNDER_PATTERN_IDS` もそこから導出。`patternStats.ts` はIDのみ扱いラベル文字列を持たず、UI(PracticeMode.tsx)はLABELSを参照。grepでラベル文字列の出現箇所を確認: 定義(clearBlunder.ts)とテストのアサーションのみで、**二重定義なし**。

### 軽微(3件、done妨げず)

1. **同一入力に対する検出器の二重実行**: 失敗経路で `detectClearBlunderPatterns(input)`(内部で全件検出)と `detectAllClearBlunderPatterns(input)` を続けて呼ぶため、9検出器が2回走る(PracticeMode.tsx:765,773)。純粋関数・軽量計算で実害はないが、`detectAll` の結果を1回取ってから表示用に切り詰める形にすれば1回で済む。
2. **バリデーションが全捨て方式**: `isValidStats` は1エントリでも不正(未知IDを含む)なら統計全体を `{}` に落とす。将来パターンIDを追加→旧バージョンに戻る、のケースで全統計が消える。stageProgress踏襲の設計判断として許容範囲だが、部分salvage(不正エントリのみ除去)の方が親切。
3. **マルチタブのlost update**: read-modify-writeなので2タブ同時失敗でカウントが1つ落ちうる。既存の記録系(stageProgress)と同水準であり実用上問題なし。

---

## T131: SRS復習の見える化(ea757f8)

### 観点(5) dueLines切り出しと startPractice の挙動不変 — 問題なし

- 変更前のインラインロジック: dueあり→dueから、なければ全体からランダム。変更後の `selectPracticeTargetLine(all, due, dueOnly=false)` は `pool = dueLines.length > 0 ? dueLines : allLines` で**同一**。`target = selected.target ?? target`(事前の全体ランダム初期値へのフォールバック)・catch時のランダム続行も従来どおり。追加された副作用は `setDueLines` / ref更新 / `setJustCompletedReview(false)` のみで出題選択に影響しない。
- `dueOnly=true` はdueありならdue限定、0件なら全体+`usedFallback: true`。ユニットテストが `pickIndex` 注入で「どちらのプールから選ばれたか」を直接検証しており実質的。

### 観点(6) 完了バナーの判定ロジック — 問題なし

- バナー(「今日の復習完了!」)の条件は「colorSelect復帰時のeffectで `dueOnlySessionActiveRef.current && due.length === 0`」。refが真になるのは `startPractice` で `dueOnly && !selected.usedFallback` のときのみ。よって:
  - **reviewFallbackセッション**(due0でフォールバック): ref=false → 完走してもバナーは出ない。
  - **通常出題**(色ボタン、dueOnly=false): ref=false → 出ない。
  - 偽陽性の余地: refが真になるのはstartPractice時点でdue>0だった場合のみで、セッション中にSRS書き込みが起きるのはゲームオーバー時の `recordSrsResults` だけなので、「完走せずにdueが0になる」経路がなく偽陽性はない。
- 統合テスト(fake-indexeddbで実 `db.ts`/`srs.ts` を通す)がシナリオ1で「復習開始→1手クリア→もう一度→完了バナー」、シナリオ2で「due0→フォールバック通知」を実コードパスで確認しており、モックで判定自体を偽装していない。

### 観点(7) colorSelect復帰時のdue再計算effectの依存配列・レース — 概ね問題なし(軽微1件)

- 依存配列 `[josekiDb, phase]` は発火条件(DB読み込み完了・colorSelect復帰)として正しい。`refreshDueLines` / refはレンダー毎に安定な参照/同一refで、依存漏れによる実害はない(eslint-disableで抑制)。cleanupの `cancelled` フラグで、離脱後にバナー判定・ref更新が走ることは防いでいる。
- **軽微(レース)**: effectの非同期処理(`getAllSrsStates`待ち)が未解決のまま「復習を始める」を押すと、`startPractice` が ref=true を立てた直後〜phase変更commitによるcleanup実行前の狭い窓で、旧effectの継続が `cancelled` チェックを通過し `dueOnlySessionActiveRef.current = false` に戻す可能性がある。結果は「完走後にバナーが出ない」だけ(偽陽性方向には倒れない: effect側のdueも同じDBから読むためref=trueならdue>0)。窓は極小・影響は演出のみなので軽微。ref消去をeffect側でなくstartPractice側に一元化すれば消せる。

### 軽微(観点7の1件を含め4件)

1. (上記レース)effect継続による `dueOnlySessionActiveRef` の巻き戻しで完了バナーが出ないことが理論上ありうる。
2. `refreshDueLines` の `setDueLines` は `cancelled` チェックの外にあるため、phase遷移後・アンマウント後にstaleな `setDueLines` が走りうる(Preactでは実害なし、colorSelect復帰時に再計算されるため表示上も自己修復する)。
3. ドキュメント齟齬: `dueSummaryHeadline` のdocコメントに「due件数が1件以上: …本関数は使わない」とあるが、実際はdue>0でも本関数が `今日の復習: n本` を返しJSXがそれを表示している(コードは正しく、コメントが実装と不一致)。同関数近くのコメントに「フォールボック」のtypoもある。
4. effect内の `// eslint-disable-next-line` がルール名指定なしの全抑制になっている(`react-hooks/exhaustive-deps` 等の意図したルールに限定すべき)。

---

## 観点(8) テストの実質(両タスク共通)— 恒真性なし

- T129: 記録テストは実UI操作(スタブBoardクリック)→実 `patternStats.ts` → 実localStorageの縦貫。核心の「表示2件・記録3件」は検出結果を直接固定せず、featureSet応答の値から実検出器を通して導いている。世代ガードテストは応答保留→離脱→解決の順序を実際に作っている。負例(合格時null・離脱後null・確認前は未消去)も揃う。
- T131: `dueLines.test.ts` は `pickIndex` 注入でプール選択を決定的に検証。統合テストは fake-indexeddb 経由で `recordSrsResults` → due再計算 → バナーという実データフローを通す。文言アサーションも肯定・否定両方向。
- いずれも「モックの戻り値をそのままassert」型の恒真テストは見当たらない。レビュー時に対象5ファイルを実行し66件全パスを確認。

## 結論

- **T129: 合格**。重点観点(1)〜(4)すべて満たす。指摘は軽微3件のみ(申し送りで可)。
- **T131: 合格**。重点観点(5)〜(7)すべて満たす。指摘は軽微4件のみ(うちレース1件はT130/後続で `dueOnlySessionActiveRef` の消去タイミングを見直す際に併せて解消推奨)。

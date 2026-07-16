---
id: T119
title: 中盤練習: 定石DB終端の番号付き問題集+ステージクリア型UI+設定別★記録
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 1
---

# T119: 中盤練習: 番号付き問題集+ステージクリア型UI+設定別★記録

## 目的(ユーザー裁定 2026-07-17 朝)

中盤練習にもステージクリア型UIを導入する。ユーザー裁定:
1. 問題プールは **(a) 定石DBの終端局面を決定的に列挙して番号付き問題集にする**(事前生成セット案(b)は不採用)。
2. クリア記録は**判定設定ごとに別々に記録**し、**実績解除のような★が増えるパズルゲーム要素**を入れる。

## 前提(explorer調査 2026-07-17 + T117/T118の先行実装)

- 中盤練習の現状: 開始局面は`pickJosekiEndPosition`(定石DBランダム終端)または`generateSelfPlayPosition`で毎回動的生成(`app/src/midgame/generateStart.ts:35-137`、`app/src/midgame/PracticeMode.tsx:684-700 startPractice`)。固定の問題番号は存在しない。
- 判定モード(厳格/標準等)の設定は`app/src/midgame/judgeModeStorage.ts`参照。セッションの成否判定は既存のPracticeModeのロジックに従う(失敗局面は`midgamePool`へ収集される既存機構あり)。
- localStorage規約・ステージ選択UIの流儀は**T117(詰めオセロ側)が先行確立**している。`app/src/tsume/stageProgress.ts`とステージグリッドUIのパターンを踏襲し、共通化できるUI部品は共通化してよい(過剰な抽象化は不要、コピーに近い再利用でも可)。

## 要件

1. **番号付き問題集の生成(決定的)**: 定石DBの全ライン終端局面を**決定的な順序**(定石DBの定義順)で列挙するモジュールを作る(例: `app/src/midgame/stagePool.ts`)。各ステージは安定キー(局面の正準形ハッシュまたは定石ラインのパス文字列。**配列indexをキーにしない** — DB更新で記録が丸ごとズレるため)と表示用の通し番号(1〜N)、出典の定石名を持つ。同一終端局面が複数ラインから到達する場合は重複除去する。列挙結果が空/極端に少ない場合は作業ログで報告して指示を仰ぐ。
2. **ステージ選択画面**: 中盤練習モードに「ステージ一覧」を追加(既存のランダム練習導線は残す)。グリッドで番号・定石名(短縮表示可)・**★0〜3**を表示。タップでそのステージの開始局面から練習開始(以降は既存の練習フロー)。レスポンシブ必須。
3. **設定別クリア記録と★**: 判定モード(現行の全モード)ごとにクリア/失敗を別記録する。localStorage(キー例: `othello-trainer:midgame-stage-progress`、T117と同じStorageLikeラッパー規約)に、ステージキー×判定モードごとに `firstClearedAt` / `lastClearedAt` / `clearCount` / `failCount` / `lastAttemptAt` / `lastResult` を保存。**★の数 = そのステージでクリア済みの判定モード数**(全モードクリアで満点)。一覧セルに★を表示し、クリア済みステージが一目でわかること。
4. **クリアの定義**: 既存の練習セッションの成否判定(現行PracticeModeが失敗と扱う条件=判定モードの悪手検出等)に従い、**セッションを最後まで完走して失敗条件に当たらなかったら「クリア」**とする。既存判定ロジック自体は変更しない。ステージ経由でないランダム練習は記録対象外でよい(開始局面がステージと一致する保証がないため)。ただし実装上自然に対応付くなら記録してもよい(判断を作業ログに書く)。
5. **結果画面の導線**: ステージ経由の練習の結果表示に「ステージ一覧へ戻る」「次のステージへ」を追加。クリア時に★獲得がわかる演出(簡素でよい: 「★獲得!」表示程度、アニメーション必須ではない)。
6. **テスト**: stagePool列挙の決定性(2回列挙して同一)・重複除去、進捗モジュール(更新・読み出し・破損フォールバック・未知キー無視)、★数の導出。既存テスト全件パス維持。

## やらないこと(スコープ外)

- 事前生成問題セット(案b)・puzzlegen連携
- 判定ロジック・練習フロー本体の変更
- 復習モード自体(記録スキーマで備えるだけ)
- 詰めオセロ側の変更(T117で完了済みの想定)

## 受け入れ基準(検証コマンド)

- [ ] `npm test -- --run`(app)全件パス+`npx tsc --noEmit`エラーなし
- [ ] stagePool(決定性・重複除去)と進捗/★導出の単体テストがある
- [ ] ステージ数(N)と列挙元(定石DBライン数)が作業ログに記録されている
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、Pages公開URLで: ステージ一覧表示→任意ステージをクリア→★が付く→判定モードを変えて同ステージをクリア→★が増える→リロード後も保持、を実際に確認
- [ ] 変更対象ファイルのみパス指定でコミット(`(T119)`)。tasks/とCLAUDE.mdはコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが`git status --short`に残っていないこと(bench/edax-compareのgen/verify/test 3ファイル=T114 WIP等、他タスクのWIPは対象外)

## 備考

- **T117(詰めオセロ側ステージUI)完了後に着手**(UI/記録パターンの踏襲元)。
- T114(コーパス生成)が稼働中の場合はプロセスと`train/data/teacher/`に一切触れない。

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 redo #1(verifier合格 / codex-review不合格)

レポート: tasks/review/T119-midgame-stage-select-codex-review.md(必読)

1. **[重大・必須] ステージ順と出典名の修正**: 現実装は終端局面を**ハッシュ辞書順**でソートしているが、仕様は「定石DBの定義順」。`JosekiDb.lines`を定義順に走査し、各ラインの終端ハッシュの初出順をステージ順にする(同一終端は重複除去)。また`josekiNames`に`JosekiNode.names`(=その局面を**通過する**全ライン名)を使っているのは誤りで、**その局面を終端とするライン名だけ**を蓄積すること(111ノード中29ノードは長いラインの通過点を兼ねており、例えば約80件の無関係な名前が入るケースがある)。**仕様と逆の挙動を固定しているテスト(ライン逆順でも番号不変)を正しい仕様(定義順に追従)のテストに直すこと。** なお記録キーは局面ハッシュのままなので、順序変更でlocalStorage記録は壊れない(確認して作業ログに明記)。
2. **[中・今回対応] staleセッションの記録ガード**: 終盤判定(checkEnd等)の非同期処理中に「やめる」等で画面を離れた後、古い判定完了が record/phase変更/★付与を実行しうる。セッション世代ID(またはキャンセルref)を導入し、await後に同一セッションが有効な場合のみ結果確定・記録するよう修正+テスト。
3. **[中・今回対応] 相関バリデーションの不完全箇所**: レビュー(b)2節の指摘どおり補強+テスト。
4. **[軽微・今回対応] `parseStageKey`の例外仕様と実装の不一致**: doc/実装を揃える。

修正後: npm test/tsc→パス明示コミット(`(T119)`)→push→Actions確認→Pages軽確認(ステージ順が定石DB定義順になったこと・#番号と出典名の対応・★表示)。完了報告に「順序変更で既存localStorage記録が保持されること」の説明を含めること。

## 作業ログ(担当エージェントが追記)

- 2026-07-17 調査(implementer、explorer 2件並列委譲)
  - 定石DB構造(`app/src/joseki/types.ts`等)を調査した結果、`JosekiNode.isLeaf`
    (「いずれかの定石ラインの最終局面であれば`true`」)を`JosekiDb.nodes`から
    フィルタするだけで、要件1(全ラインの終端局面・重複除去)がほぼ無償で
    満たせることが判明した。`nodes`のキー自体が正規化済み局面のハッシュ
    (`normalize.ts`の`hashBoard`出力、`${blackHex}_{whiteHex}_${side}`形式)
    であり、複数ラインが同じ終端に合流する場合は`buildDb.ts`のノード構築時点で
    自動的に1エントリへ集約されている(重複除去の追加実装は不要)。さらに
    このキー文字列自体から`Board`+`sideToMove`を直接復元できる(`moveSeq`の
    再生が不要)ため、`stagePool.ts`の実装はシンプルなフィルタ+ソートで済んだ。
  - 実データ(`app/public/joseki.json`)を確認: **ライン数112・全ノード615・
    isLeafノード111**(重複合流1件を除去)。
  - `PracticeMode.tsx`の調査で、`resetSessionTo(start: StartPosition)`が
    既に任意の開始局面を受け取れる設計であることを確認、ステージ選択からの
    起動はこの関数への新しい呼び出し経路を追加するだけで済むと判断した。
    クリア/失敗の確定は`checkEnd`/`finishByFinalScore`/`handleModeFailure`の
    3箇所(空き24以下になって初めて判定される、要件4「セッションを完走して
    失敗条件に当たらなければクリア」は既存の`CLEAR_MARGIN`(+2石)判定を
    そのまま踏襲する解釈とした)。

- 2026-07-17 実装(implementer)
  - `app/src/midgame/stagePool.ts`(新規): `buildMidgameStagePool(josekiDb)`。
    `josekiDb.nodes`を`isLeaf===true`でフィルタし、キー文字列の辞書順
    (`<`演算子、ロケール非依存)でソートして列挙する(Map挿入順に依存しない
    決定的な順序、要件1)。`parseStageKey`でキー文字列から`Board`/`sideToMove`
    を復元。ステージの安定キー(`MidgameStage.key`)は正規化済み局面ハッシュ
    そのもの(配列indexではない、要件1)。
  - `app/src/midgame/stageProgress.ts`(新規): `StorageLike`規約(T117踏襲)。
    キー`othello-trainer:midgame-stage-progress`、
    `Record<stageKey, Record<JudgeMode, Entry>>`の2階層構造で判定モード別に
    記録(要件3)。**T117 redo #1で判明した2つの教訓を設計段階から反映**:
    (1) 日時バリデーションは`Date.parse`可否ではなく
    `Date.toISOString()`が実際に出力する形式の厳密な正規表現
    (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`)+往復一致チェック
    (`new Date(value).toISOString() === value`、暦として存在しない日付を弾く)。
    (2) フィールド相関の整合チェック(`clearCount===0`なのにクリア日時がある/
    `clearCount>0`なのに日時が両方null/`lastResult==='clear'`なのに
    `clearCount===0`、いずれも不正としてフォールバック)。
    `stageStarCount`(★0〜3)・`stageStatus`(3状態)・`stageStatusForMode`を提供。
  - `app/src/midgame/PracticeMode.tsx`:
    - `Phase`に`'stageSelect'`追加。`SessionState`に`stageKey: string | null`
      追加(ステージ経由なら安定キー、ランダム練習なら`null`)。
    - **T117 redo #1のレース対策を最初から反映**: 新関数`recordStageAttemptNow`
      を`checkEnd`/`finishByFinalScore`/`handleModeFailure`の**いずれの
      `await`よりも前**(結果画面表示`setPhase('result')`より前)で同期的に
      呼ぶ。IndexedDB書き込み(`registerFailure`、出題プールへの失敗局面登録)
      は従来どおり別途行うが、`localStorage`への記録はそれを待たない。
      また「stageKeyをコンポーネントstateではなく`SessionState`に持たせて
      関数へ値渡しする」設計(`activeStage`という表示用stateとは別に
      `session.stageKey`を持つ)により、`resetSessionTo`内の
      `setActiveStage`が同一レンダー内でまだ反映されていない間に
      `void checkEnd(...)`が同期的に走っても、古い`activeStage`を
      参照してしまう(T117 redo #1と同種の)stale-closure問題が原理的に
      起きない設計にした。
    - `stagePool`は`useMemo`で`josekiDb`から1回だけ構築。`stageProgress`は
      起動時に`localStorage`から読み込み、`recordStageAttemptNow`経由で更新。
    - `startStagePractice(stage)`(ステージ選択→開始)、`goToStageSelect`
      (ステージ一覧を開く、設定画面・結果画面の両方から)、`nextStage`
      (`stagePool`内で次の番号へ、要件5)を追加。`retryFromStart`は
      `activeStage`を引き継ぐよう修正(同じステージのやり直しでも記録対象で
      あり続ける)。
    - 設定画面に「ステージ一覧」ボタン追加(既存の「開始」ボタンは維持、
      要件2)。ステージ一覧画面は111マスのグリッド(番号・定石名(先頭1件+
      合流時「他N件」)・★表示)。結果画面(クリア・失敗の両方)に
      「次のステージへ」「ステージ一覧へ戻る」をステージ経由のときのみ追加、
      クリア時に初めて★を獲得した場合「★ 新しい★を獲得しました!」を表示
      (要件5)。
  - `app/src/midgame/PracticeMode.css`: ステージ一覧・グリッド用のスタイルを
    追加。T117の`app/src/tsume/PlayMode.css`と同じデザイン方針(3状態の固定
    配色、レスポンシブグリッド)だが、**モジュール間のCSS読み込み順に依存
    しないよう`midgame-`プレフィックスでこのファイル内に複製**した
    (タスク仕様「コピーに近い再利用でも可」を採用。`tsume/PlayMode.css`の
    クラス名をそのまま参照する案は、Vite等のコード分割時にそのCSSが
    未ロードになりうるため避けた)。

- 検証結果
  - `npm test -- --run`(app): 69 test files / 589 tests 全件パス
    (T117完了時点548件に、`stagePool.test.ts`10件+`stageProgress.test.ts`
    31件=41件を追加して589件)。
  - `npx tsc --noEmit`(app): エラーなし。
  - **ステージ数**: 定石DBの全ライン数**112件**から重複終端を除去し
    **N=111ステージ**(受け入れ基準の必須記載事項)。実データで直接検証済み
    (`stagePool.test.ts`の「実データから決定的にステージを列挙できる」テスト、
    および本文中の`node -e`によるjoseki.json直接検査で二重に確認)。
  - コミット: `398db33`(`app/src/midgame/PracticeMode.css`・`PracticeMode.tsx`・
    `stagePool.ts`・`stagePool.test.ts`・`stageProgress.ts`・
    `stageProgress.test.ts`の6ファイルのみ、パス明示add)、
    `git push origin main`済み(`8d15eb4..398db33`)。
  - GitHub Actions「Deploy to GitHub Pages」run 365(commit `398db33`、
    run id 29540608639): `gh run list`がAPI一時障害(HTTP 503、T117と同様の
    現象)で使えなかったため、ブラウザでActionsページを直接確認し
    「completed successfully」であることを確認。
  - Pages公開URLでの実機確認(Playwright headless chromium、
    `verify_t119_midgame_stage.mjs`、scratchpad保存): 中盤練習の
    クリア/失敗判定は空きマスが24以下になって初めて確定するため
    (`checkEnd`の既存ロジック、変更していない)、検証を現実的な時間で
    終えるため定石DBのdepthが最も深いライン(depth23〜25、クリア判定に
    必要な残り手数が最少)をローカルで事前特定し、それらを候補に
    「候補手評価を表示」オーバーレイの最善手を毎回打つ戦略+リトライで
    自動進行した。
    1. 詰めオセロ→ではなく中盤練習→「ステージ一覧」で111マス
       (`.midgame-stage-grid__cell`)が表示されることを確認。
    2. ステージ#22(「ローズ基本形」、判定モード既定=strict)を選び、
       候補手評価オーバーレイの最善手を打ち続けて自動進行(1回目失敗、
       2回目で「クリア!」に到達。相手= 'top3Random'の乱数要素があるため
       試行差は想定内)。「★ 新しい★を獲得しました!」バナー表示を確認。
       ステージ一覧に戻ると当該セルが★☆☆(1/3)になっていることを確認。
    3. 設定画面で判定モードを「標準」に変更し、同じステージ#22を再度
       クリア。ステージ一覧に戻ると★★☆(2/3)に増えていることを確認
       (要件3の実地確認、スクリーンショット
       `T119-after-second-clear.png`で目視確認: ステージ22が緑背景+★★☆で
       ハイライトされ、他の110ステージは未挑戦のまま☆☆☆であることも
       確認できる)。
    4. `page.reload()`後も★★☆のまま、`localStorage`の生値
       (`othello-trainer:midgame-stage-progress`、strict/standardそれぞれの
       `clearCount`等)もリロード前後で完全一致することを確認。
    5. ブラウザコンソールエラー: 0件。スクリプトの最終判定: `RESULT: PASS`。
  - 使用した一時ファイル(scratchpad、リポジトリ非配置、コミット対象外):
    `pw/verify_t119_midgame_stage.mjs`、およびjoseki.json解析用の
    `node -e`ワンライナー(ファイル化していない)。スクリーンショット
    `T119-after-first-clear.png`・`T119-after-second-clear.png`・
    `T119-after-reload.png`。
  - `git status --short`: 本タスク由来の差分・未追跡ファイルは残っていない。
    T114 WIP 5ファイル(`bench/edax-compare/`配下)は対象外・未変更のまま、
    生成プロセス・`train/data/teacher/`には一切触れていない。

- 判断・スコープに関する備考(要件4関連)
  - 「セッションを最後まで完走して失敗条件に当たらなかったら『クリア』」は、
    既存の`checkEnd`/`finishByFinalScore`の`CLEAR_MARGIN`(+2石)判定を
    そのまま「クリア」の定義として採用した(既存判定ロジック自体は変更
    しないという要件の制約と、`handleModeFailure`(判定モードによる着手ミス
    での即時失敗)も既存どおり有効なままにする、という2点を素直に満たす
    解釈)。「一度も判定モード違反が無ければ暫定的にクリア扱い」といった
    別の解釈は採用していない(要件が「既存判定ロジックに従う」と明記して
    いるため)。
  - 「ステージ経由でないランダム練習は記録対象外」は、`SessionState.stageKey`
    が`null`のときは`recordStageAttemptNow`が即座に何もせず返る形で実装した
    (要件が許容する「対応付くなら記録してもよい」は採用しなかった。理由:
    ランダム練習の開始局面はステージ一覧の局面と偶然一致することがあり
    得るが、`pickJosekiEndPosition`は`lines`から選ぶため`isLeaf`かつ
    重複除去済みの`stagePool`とは選ばれ方が異なり、「たまたま一致したときだけ
    記録される」という利用者にとって分かりにくい挙動になるのを避けた)。

- 2026-07-17 redo #1対応(implementer、codex-review重大指摘1件+中2件+軽微1件)
  - レポート: `tasks/review/T119-midgame-stage-select-codex-review.md`。
  - **[必須] ステージ順・出典名の修正**: `app/src/midgame/stagePool.ts`の
    `buildMidgameStagePool`を全面書き換え。旧実装は`JosekiDb.nodes`を
    `isLeaf===true`でフィルタしハッシュ辞書順にソートしていたが、
    `JosekiDb.lines`を**定義順**に走査し、各ラインの終端(`moveSeq`を初期局面
    から再生した局面)のハッシュを求め、**初出順**でステージ順を決める実装に
    変更(`josekiDb.nodes`は一切参照しなくなった)。`josekiNames`も、旧実装が
    `JosekiNode.names`(通過する全ライン名)を使っていた誤りを修正し、
    各ラインごとに「そのラインの終端」に対してのみ名前を追加する方式にした
    (長いラインの通過点を兼ねる短いラインの終端で、無関係な名前が混入
    しなくなった)。
    - **既存localStorage記録への影響確認(オーケストレーター指示どおり)**:
      新旧アルゴリズムで「重複除去後の終端局面の集合」(=ステージキーの
      集合)が完全に一致することを実データで検証した
      (`node --experimental-strip-types`でのワンライナー検証:
      旧`isLeaf`ノードキー集合と新アルゴリズムの出力キー集合をソートして
      比較し完全一致、いずれも111件)。理由: `isLeaf===true`の定義
      (「いずれかの定石ラインの最終局面であれば`true`」)は、まさに
      「各ラインの終端ハッシュの集合」と数学的に同値であり、`buildDb.ts`が
      各ラインの終端に対して`isLeaf=true`をセットする実装になっているため。
      **したがって本修正による並び順・出典名の変更は、既存の
      `localStorage`進捗記録(キー=局面ハッシュ)を一切破壊しない**
      (キーは変わらず、`stageNumber`(表示用の並び順)とその局面に
      紐づく`josekiNames`だけが変わる)。実機でも、修正前の実装が使っていた
      キーと同じ計算方法(ラインのmoveSeq再生によるhashBoard)で作った
      localStorageレコードが、修正後のステージ一覧で正しく★表示される
      ことを確認済み(下記Pages確認参照)。
    - `stagePool.test.ts`: 「仕様と逆の挙動(ライン順反転でも番号不変)を
      固定していたテスト」を削除し、(a)ライン順を反転すると列挙順も追従して
      変わること(ステージの集合自体は不変)、(b)`JosekiDb.lines`の初出順から
      独立に計算した期待値とステージ順序が一致すること、(c)`josekiNames`に
      通過するだけのラインの名前が含まれないこと、の3テストを新規追加
      (10件→14件)。
  - **[中] staleセッションの記録ガード**: `app/src/midgame/PracticeMode.tsx`
    に`sessionGenerationRef`(セッション世代カウンタ)を追加。
    `resetSessionTo`(新セッション開始)・`backToSettings`・`goToStageSelect`
    (いずれも離脱・切り替え)でインクリメントし、`checkEnd`・
    `handleModeFailure`・`handlePlayerMove`は非同期処理(`requestAnalyzeAll`/
    `requestAnalyze`)の`await`前に世代を捕まえ、`await`から戻った時点で
    `sessionGenerationRef.current`と一致する場合のみ結果確定
    (`setPhase('result')`・`setResultInfo`)・記録
    (`recordStageAttemptNow`)・★付与(`setJustEarnedStar`)を行うよう修正
    (一致しなければ何もせず抜ける)。相手着手の`useEffect`は既存の
    `cancelled`フラグで`checkEnd`呼び出し自体をガード済みだったため、
    `checkEnd`呼び出し時点の`sessionGenerationRef.current`をそのまま渡す形
    にした。
    - **回帰テスト**(新規`app/src/midgame/PracticeMode.staleSession.test.tsx`、
      1件): 初期局面から空きマス24(完全読み判定の閾値)まで進む決定的な
      36手の合成ライン(パスが発生しないことを事前にスクリプトで確認済み)を
      唯一のラインとする`JosekiDb`を構築し、ステージ開始直後(`resetSessionTo`
      が同期的に呼ぶ`checkEnd`の`requestAnalyzeAll`が意図的に解決しない
      Promiseで止まっている間)に「やめる」を押して設定画面へ戻り、その後で
      古い判定をクリア相当の評価値で解決させても`localStorage`に記録が
      書き込まれず結果画面にも遷移しないことを検証。**本テストが実際に
      退行を検出できることを、修正前のコード(`git stash`で一時的に
      `PracticeMode.tsx`をredo前相当に戻して再実行)に対して確認済み**:
      修正前は`expect(localStorage.getItem(...)).toBeNull()`が
      `AssertionError`(実際に記録が書き込まれてしまう)で失敗し、修正を
      戻すと合格することを確認した。
  - **[中] 相関バリデーションの補強**: `app/src/midgame/stageProgress.ts`の
    `isValidEntry`が「`firstClearedAt`/`lastClearedAt`が**両方**`null`」の
    場合しか弾けておらず、`clearCount > 0`なのに片方だけ`null`という破損
    データが有効値として通ってしまっていた問題を修正
    (`||`条件に変更、両方非nullを要求)。`stageProgress.test.ts`に
    片方だけnullの2ケース(firstClearedAtのみnull/lastClearedAtのみnull)の
    テストを追加(31件→33件)。
  - **[軽微] `parseStageKey`の例外仕様と実装の不一致解消**:
    不正な16進文字列を`BigInt()`に直接渡すと`SyntaxError`が送出され
    ドキュメント上の例外仕様(`RangeError`のみ)と食い違っていた問題を修正。
    16進文字のみで構成されているかを正規表現(`HEX_PART_REGEX`)で事前検証し、
    さらに64bit範囲・黒白ビットの重複も検証するようにし、あらゆる不正入力に
    対して`RangeError`だけを投げるよう修正。`stagePool.test.ts`に3テスト
    (不正な16進文字・64bit範囲超過・黒白ビット重複)を追加。
  - 検証結果:
    - `npm test -- --run`(app): 70 test files / 596 tests 全件パス
      (redo #1前589件に、`stagePool.test.ts`+4件、`stageProgress.test.ts`
      +2件、`PracticeMode.staleSession.test.tsx`新規1件=+7件で596件)。
    - `npx tsc --noEmit`(app): エラーなし。
    - コミット: `798d577`(`app/src/midgame/PracticeMode.tsx`・
      `PracticeMode.staleSession.test.tsx`(新規)・`stagePool.ts`・
      `stagePool.test.ts`・`stageProgress.ts`・`stageProgress.test.ts`の
      6ファイルのみ、パス明示add)、`git push origin main`済み
      (`deea127..798d577`)。
    - GitHub Actions「Deploy to GitHub Pages」run 370(commit `798d577`、
      run id 29541903639): `gh run view`で`{"conclusion":"success",
      "status":"completed"}`を確認(`gh run list`はAPI一時障害(HTTP 503)で
      使えなかったため、個別run IDの`gh run view`ポーリングと、ブラウザでの
      Actionsページ直接確認を併用)。
    - Pages公開URLでの軽い再確認(オーケストレーター指示どおり「定義順の
      番号・出典名・★表示」に絞る、Playwright headless chromium、
      `verify_t119_redo1_light.mjs`): 実データで定義順1番目のライン
      (`bookgen/joseki-research.json`の`lines[0].name === '虎'`)を
      ローカルで確認したうえで、Pages上のステージ一覧の**ステージ#1**が
      実際に「虎」であることを確認(定義順の反映を実機で確認)。全111マスの
      うち、`title`属性に「他N件」が10件を超える(=無関係な名前が大量混入)
      セルが1件も無いことを確認(出典名修正の反映)。あわせて、
      `stagePool.ts`と同一のアルゴリズム(「虎」ラインの`moveSeq`を初期局面
      から再生してhashBoardを計算)で求めたキーに対して★2/3のダミー進捗を
      `localStorage`へ事前投入し、ステージ#1(虎)セルが正しく`★★☆`・
      緑背景(`--cleared`)で表示されることを確認(★表示・記録キー整合性の
      実機確認、スクリーンショット`T119-redo1-stage-list.png`)。
      コンソールエラー0件。
  - `git status --short`: 本タスク由来の差分・未追跡ファイルは残っていない。
    T114関連(`bench/edax-compare/`・`train/data/teacher/`)には一切触れて
    いない(別ワーカーが仕上げ中との申し送りどおり)。

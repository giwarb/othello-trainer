---
id: T036
title: 言語化支援 用語集 + 概念レッスン + 概念別弱点統計ダッシュボード
status: in_progress
assignee: implementer
attempts: 0
---

# T036: 言語化支援 用語集 + 概念レッスン + 概念別弱点統計ダッシュボード

## 目的
`othello-trainer-design-verbalization.md` §7「用語集」・§8「概念別弱点統計」を実装する。T032(モチーフ検出タグ)・T035(言語化トレーニングモード、理由タグ・二択比較ドリル)で構築した基盤の上に、用語の説明ページと、ユーザーの弱点概念を可視化するダッシュボードを追加する。

## 背景・コンテキスト
- 前提: T032(`app/src/analysis/motifs.ts`、`MOTIF_CATALOG`)・T035(`app/src/verbalize/reasonTags.ts`、`app/src/verbalize/attemptsStore.ts`、`TwoChoiceDrill.tsx`)完了・コミット済み。
- 設計書§7「用語集」(引用): 全タグ・全用語に対し、1ページの用語集を提供。各項目は「定義3行+インタラクティブな最小例局面2つ+反例1つ」から構成。説明文・タグ・オーバーレイのどこからでも1タップで到達可能。加えて「開放度」「偶数理論」など**12テーマの概念レッスン**を設定。各レッスンは「説明1画面 + 二択ドリル10問(§6.2)」で構成。教材局面はユーザー自身の棋譜から優先的に採用。
- 設計書§8「概念別弱点統計」(引用): データ構造 `conceptStat { tag → { attempts, correct, reasonCorrect, lastSeen, due } }`。集計源は「悪手分析・中盤練習・言語化トレーニングの全結果」。ダッシュボードで「あなたの負けの42%は壁絡み。開放度の理由正答率55%」のような表示、弱い概念の局面を優先出題、棋譜解析の悪手一覧を概念別にグルーピング表示。
- **本タスクでのスコープ縮小(必ず理解してから着手すること)**:
  1. 設計書の「12テーマ」は具体的なテーマ名の列挙が無い(「開放度」「偶数理論」は例示のみ)。**本タスクでは、T032の`MOTIF_CATALOG`(15種)+T035の評価内訳分解ベースタグ(3種、計18種)をそのまま用語集の項目・概念レッスンのテーマとして使う**(無理に「12」という数に合わせる必要はない。実装者が全項目を対象にするか、代表的なサブセットに絞るかは判断してよいが、判断根拠を作業ログに記載すること)。
  2. 「概念別弱点統計」の集計源について、**T035の`verbalizeAttempts`(理由タグ付きの挑戦記録)は必ずデータソースとして使うこと**。中盤練習(T021)・棋譜解析の悪手分析(T029/T030)は、現状タグ情報を永続化する仕組みを持たない(中盤練習の失敗記録にモチーフタグが付与されていない、悪手分析パネルの表示は都度計算でIndexedDBに保存されない)。これらのモードからも統計に反映させることは望ましいが、**現状の記録の仕組みを大きく改修する必要がある場合は無理をせず、`verbalizeAttempts`のみを集計源とする実装でよい**(判断根拠を作業ログに記載すること)。余力があれば、中盤練習・棋譜解析の結果にもタグ付けして記録するよう拡張してもよい。
  3. 「レーダーチャート」等の高度な可視化ライブラリの新規導入は不要。既存のプロジェクト方針(軽量な自作SVG/CSS表示、T031の`AttributionWaterfall`のような棒グラフ等)を踏襲し、シンプルな一覧・棒グラフ形式で表示すればよい。
  4. 「教材局面はユーザー自身の棋譜から優先的に採用」は、実装が複雑になる場合、既存の出題プール(`midgame/pool.ts`)・詰めオセロプールからの一般的な出題で代替してよい。

## 変更対象(新規作成/変更)
- `app/src/verbalize/glossary.ts`(新規): 用語集データ(T032の`MOTIF_CATALOG`・T035の評価内訳分解ベースタグを基に、各項目の定義文・例局面・反例局面を構築する)
- `app/src/verbalize/GlossaryPage.tsx` + `.css`(新規): 用語集の一覧・詳細表示画面
- `app/src/verbalize/ConceptLesson.tsx` + `.css`(新規): 概念レッスン画面(説明1画面+二択ドリル、T035の`TwoChoiceDrill`を特定タグに絞り込んで再利用)
- `app/src/verbalize/conceptStats.ts`(新規): `verbalizeAttempts`(T035)から`conceptStat`(タグ別の挑戦数・正答数・理由正答数・最終挑戦日等)を集計する純粋関数
- `app/src/verbalize/StatsDashboard.tsx` + `.css`(新規): 概念別弱点統計ダッシュボード(タグ別の正答率・理由正答率を一覧・棒グラフで表示)
- `app/src/analysis/BlunderPanel.tsx`(既存、拡張): モチーフタグバッジから用語集への1タップ導線を追加
- `app/src/verbalize/VerbalizeMode.tsx`(既存、拡張): 用語集・統計ダッシュボードへのタブ/導線を追加
- テストファイル一式

## 要件
1. **用語集**: T032のモチーフ15種+T035の評価内訳分解ベースタグ3種、計18項目について、それぞれ定義文(2〜3行程度)・最小例局面2つ・反例局面1つを用意する。例局面・反例局面は、既存の出題プール等から該当する特徴を持つ局面を検索して採用する(T032/T031のロジックで機械的に判定できる)、または人工的に構築してもよい。
2. **1タップ導線**: `BlunderPanel`のモチーフバッジ、`verbalize`モードの理由タグ選択UI、盤面オーバーレイ(T032)から、該当する用語の用語集詳細ページへ1タップで遷移できるようにする。
3. **概念レッスン**: 用語集の項目(全部でなくてよい、実装者判断で代表的な項目から着手してよい)について、説明画面+その概念に絞り込んだ二択ドリル10問を提供する。
4. **概念別弱点統計の集計**: `verbalizeAttempts`(T035)から、タグごとの挑戦数・正答数(手の正誤)・理由正答数・最終挑戦日を集計する。
5. **ダッシュボード表示**: 集計結果を、タグ別の正答率・理由正答率が一目でわかる形式(一覧表・棒グラフ等)で表示する。設計書が例示する「あなたの負けの42%は壁絡み」のような、目立つ弱点を強調するサマリー文言も含めることが望ましい。
6. **出題バイアスへの反映**: T035の出題選択ロジック(`pickProblem.ts`)に、弱点タグ(正答率・理由正答率が低いタグ)を優先する重み付けを追加する(T027の`pickWeightedPuzzle`のパターンを参考にしてよい)。
7. **レスポンシブ**: 375px幅で崩れないこと。
8. 単体テストで以下を検証する:
   - `conceptStats.ts`の集計ロジックが、人工的な`verbalizeAttempts`データに対して正しい`conceptStat`を計算すること
   - 出題バイアスの重み付けロジックが正しく動作すること
9. 実機確認: 実際にブラウザで用語集ページ・概念レッスン・統計ダッシュボードを開き、(a)用語集の項目が表示され詳細ページに遷移できること、(b)`BlunderPanel`のモチーフバッジから用語集へ1タップで遷移できること、(c)概念レッスンが開始できること、(d)言語化トレーニングを何度か行った後、統計ダッシュボードに正答率が反映されること、(e)375px幅でも崩れないこと、を確認し作業ログに記載する。

## やらないこと(スコープ外)
- 中盤練習・棋譜解析の結果を概念統計に含めるための大規模な改修(要件4の許容どおり、`verbalizeAttempts`のみで実装してよい。ただし余力があれば拡張してもよい)
- レーダーチャート等の高度な可視化ライブラリの導入
- 「12テーマ」という数への厳密な準拠(実装者判断でよい)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、用語集の項目数・概念レッスンの実装範囲・集計源のスコープ判断・実機確認結果が記載されている
- [ ] **(2026-07-08運用ルール)** 変更をmainにコミット・push・GitHub Actionsデプロイ成功を確認し、`playwright`で本番Pages URL上での動作を確認する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-09 implementer: 要件1〜9を実装した。実装内容とスコープ判断は以下の通り。

### 実装したファイル
- 新規: `app/src/verbalize/glossary.ts`(用語集データ、18項目)+ `glossary.test.ts`
- 新規: `app/src/verbalize/glossaryExamples.ts`(例局面/反例局面の動的検索)+ `glossaryExamples.test.ts`
- 新規: `app/src/verbalize/GlossaryEntryDetail.tsx`+`.css`(用語集1項目の詳細表示、共通コンポーネント)
- 新規: `app/src/verbalize/GlossaryPopover.tsx`+`.css`(1タップ導線用の軽量オーバーレイ)
- 新規: `app/src/verbalize/GlossaryPage.tsx`+`.css`(用語集一覧+詳細+レッスン起動の画面遷移)
- 新規: `app/src/verbalize/ConceptLesson.tsx`+`.css`(概念レッスン: 説明画面+二択ドリル10問)
- 新規: `app/src/verbalize/conceptStats.ts`+`conceptStats.test.ts`(概念別弱点統計の集計)
- 新規: `app/src/verbalize/StatsDashboard.tsx`+`.css`(弱点統計ダッシュボード)
- 変更: `app/src/verbalize/pickProblem.ts`(`weightedRandomIndex`追加、`deserializeBoard`をexport化)+ `pickProblem.test.ts`
- 変更: `app/src/verbalize/TwoChoiceDrill.tsx`(`buildDrillProblem`をexport化し`options`(`requiredTagId`/`conceptStats`)に対応、`DrillProblem`/`DrillEngine`型をexport、`TagPicker`への`onInfo`配線、`GlossaryPopover`表示)
- 変更: `app/src/verbalize/TagPicker.tsx`(`onInfo`prop追加、タグ横に用語集への「?」ボタン)
- 変更: `app/src/verbalize/PracticeMode.css`(`.verbalize-tags__info`スタイル追加)
- 変更: `app/src/verbalize/VerbalizeMode.tsx`(サブタブに「用語集」「弱点統計」を追加)
- 変更: `app/src/analysis/BlunderPanel.tsx`/`.css`(モチーフバッジをボタン化し`GlossaryPopover`を1タップ表示)

### スコープ判断
1. **用語集の項目数**: T032の`MOTIF_CATALOG`15種+T035の`ATTRIBUTION_TAG_ID`3種=**全18項目**を実装した(要件1の「全部でなくてよい」はスコープ縮小2の概念レッスンにのみ適用され、要件1自体は18項目を明示的に要求しているため、削減しなかった)。定義文は`analysis/motifs.ts`の各`detect*`関数のJSDoc・`reasonTags.ts`の説明・`attribution.ts`の`TERM_LABELS`など、既存の検証済み記述を平易化しただけで新規の判定基準は作っていない。
2. **例局面・反例局面**: 静的な54局面(18項目×3)の手作り構築は行わなかった。理由: 各`detect*`関数がtrueを返すか静的に検証する手段が無く(判定にはWASMエンジンが返す`FeatureSet`が必要)、誤った例を用語集に載せるリスクが高いため。代わりに`glossaryExamples.ts`が実行時に出題プール(`midgame/pool.ts`)から実際の検出ロジック(`detectMotifs`/`buildAttribution`)で例局面・反例局面を検索する方式にした(タスク仕様が明示する「既存の出題プールから該当する特徴を持つ局面を検索して採用する」方式)。走査件数・1局面あたりの合法手数に上限を設け(`MAX_ENTRIES_SCAN=12`等)、`requestAnalyzeAll`には`timeMs: 300`を設定してハングを防止した。
3. **概念別弱点統計の集計源**: `verbalizeAttempts`のみを集計源とした(タスク仕様で明示的に許容)。中盤練習・棋譜解析の悪手分析はタグ情報を永続化する仕組みが無く、追加するにはIndexedDBスキーマ・記録経路の改修が必要でスコープを超えるため見送った。`VerbalizeAttemptRecord`が`matchedTags`(どのタグが実際に根拠と一致したか)まで保存していないため、タグ別の正誤は「1回の挑戦で選んだ全タグに、その挑戦全体の正誤(`caseKind`から導出)を均等に反映する」近似で集計している(`conceptStats.ts`冒頭コメント参照)。
4. **可視化**: レーダーチャート等は導入せず、`AttributionWaterfall.tsx`(T031)と同じ横棒(バー)形式を`StatsDashboard.tsx`で踏襲した。
5. **出題バイアス(要件6)**: `pickProblem.ts`に`weightedRandomIndex`(T027の`pickWeightedPuzzle`と同じアルゴリズムの汎用版)を追加した。ただしプールエントリ(`MidgamePoolEntry`)自体はタグ情報を持たない(タグは探索後に判明する)ため、重み付けは`TwoChoiceDrill.buildDrillProblem`が候補を複数(最大3件)集めた後の最終選択ステップに適用した(`conceptWeight`で弱点タグに関連する候補ほど選ばれやすくする)。エンジン呼び出し回数の上限(`MAX_SELECTION_ATTEMPTS=6`)は変更していない。
6. **概念レッスン(要件3)**: `TwoChoiceDrill.buildDrillProblem`に`requiredTagId`オプションを追加し、`ConceptLesson.tsx`から直接再利用した(「TwoChoiceDrillを特定タグに絞り込んで再利用する」を文字通り実装)。対象タグに絞り込む探索は`MAX_CONCEPT_SELECTION_ATTEMPTS=15`回で打ち切り、見つからなければハングせず「見つかりませんでした」を表示する。18項目全てが同じ汎用メカニズムでレッスン対象になる(サブセットに絞る必要はなかった)。
7. **1タップ導線(要件2)**: `BlunderPanel`のモチーフバッジ(要件9(b)で検証必須)と、`TwoChoiceDrill`の理由タグ選択UI(`TagPicker`の「?」ボタン)の2経路を実装した。盤面オーバーレイ(T032のフロンティア石/確定石/種石/危険なX・C打ちマストグル)は、そのラベル自体が18項目の用語集タグと1:1対応しないため対象外とした(実装者判断)。`PracticeMode.tsx`(出題フロー)の`TagPicker`には`onInfo`を配線していない(`TagPicker`自体は後方互換、`onInfo`未指定なら何も変わらない)。

### 検証結果
- `npm run typecheck`: エラー0(`wasm-pack`をPATHに追加した状態でのフル実行、`pretypecheck`込み)。
- `npm test`: 49ファイル / 422件全件パス(既存テストの回帰なし、本タスクで追加したテストは`glossary.test.ts`(6件)・`glossaryExamples.test.ts`(7件)・`conceptStats.test.ts`(16件)・`pickProblem.test.ts`追加分(6件)の計35件)。
- `npm run build`: 成功(`tsc -b && vite build && inject-sw-version`)。
- 実機確認(`vite preview` + Playwright、375px幅含む、要件9):
  - (a) 用語集: 18項目が一覧表示され、「中割り」をタップして詳細(定義文+出題プールから検索した例局面)に遷移できることを確認。
  - (b) `BlunderPanel`モチーフバッジ→用語集1タップ導線: ランダム生成した22手の棋譜を棋譜解析モードで解析し、悪手候補の手をクリックして`BlunderPanel`を開くと「壁作り(悪い手)」バッジが表示され、クリックすると`GlossaryPopover`が「壁作り」の用語集詳細を表示することを確認。閉じるボタンでポップオーバーが閉じることも確認。
  - (c) 概念レッスン: 出題プールにIndexedDB経由で複数局面を投入した状態で「壁作り」の概念レッスンを開始し、実際に二択の問題(選択肢2つ)が表示されることを確認。プールが乏しい場合(1局面のみ)は`MAX_CONCEPT_SELECTION_ATTEMPTS`到達後にハングせず「見つかりませんでした」の案内が出ることも確認(フォールバック経路)。
  - (d) 統計ダッシュボード: IndexedDBに`verbalizeAttempts`を3件(「中割り」タグ、正答1/誤答2)+1件(「モビリティ」タグ、正答)投入した状態で「弱点統計」タブを開くと、「最も弱い概念は『中割り』です(理由正答率33%、3回中)」というサマリー文言と、タグ別の手の正答率/理由正答率バーが正しく表示されることを確認。
  - (e) 375px幅: 用語集一覧・用語集詳細・概念レッスン・弱点統計ダッシュボードのいずれも`document.documentElement.scrollWidth <= clientWidth`(横スクロール発生なし)であることをPlaywrightで確認。
  - 検証に使ったPlaywrightスクリプト・生成した一時棋譜/局面データは検証専用の一時ファイルであり、コミット対象には含めていない(リポジトリには残していない)。

### 本番デプロイ確認
- コミット`012fa4a`を`git push origin main`でpush。GitHub Actions「Deploy to GitHub Pages」(run 29001833111)を`gh run watch`で待機し、`build`・`deploy`両ジョブとも成功したことを確認(所要時間: build 34秒、deploy 10秒)。
- 本番URL(`https://giwarb.github.io/othello-trainer/`)に対しPlaywrightで実機確認を実施(デプロイ完了直後、`last-modified`ヘッダがデプロイ時刻と一致することを確認した上で実施)。ローカル`vite preview`検証と同じ手順(IndexedDBへのプール局面・`verbalizeAttempts`シード込み)を再実施し、以下を確認:
  - (a) 用語集項目数18件、「壁作り」詳細ページへの遷移。
  - (b) 22手の棋譜を棋譜解析モードで解析し、`BlunderPanel`の「壁作り(悪い手)」バッジをクリック→`GlossaryPopover`が「壁作り」の詳細を表示。
  - (c) 「壁作り」の概念レッスンを開始し、実際に二択の問題(選択肢2つ)が表示された(`QUESTION_SHOWN options=2`)。
  - (d) シードした`verbalizeAttempts`から「最も弱い概念は『中割り』です(理由正答率33%、3回中)」のサマリー文言とタグ別バーが正しく表示された。
  - (e) 375px幅で用語集一覧・用語集詳細・弱点統計ダッシュボードいずれも横スクロールが発生しない(`scrollWidth <= clientWidth`)ことを確認。
- 以上により、本番Pages環境でT036の全機能(要件9の(a)〜(e))が正常動作することを確認した。

---
id: T195
title: 中盤練習: 悪手直後の「2手先」2盤面比較フィードバック
status: done
assignee: implementer
attempts: 0
---

# T195: 中盤練習: 悪手直後の「2手先」2盤面比較フィードバック

## 目的(ユーザー依頼 2026-07-23)

中盤練習で悪手を打った**その場で**(ステージの3手を打ち切る前に)、
- **左**: 実際に打った手 + それへの相手の最善応手を進めた盤面
- **右**: 打つべきだった最善手 + それへの相手の最善応手を進めた盤面
を並べ、**なぜ最善手が良いかをシンプルな言葉で**説明する。第一の比較指標は「その2手が進んだ後の自分の番での着手可能数」とし、**両盤面に自分の各合法手の評価値を表示**する(着手可能数が増えても悪手だらけなら意味がないため)。既存の言語化(寄与の滝グラフ等)への「着手可能数の寄与ってなんやねん」という不満が起点なので、**数値の羅列ではなく盤面で見せる**ことが本質。

## 背景・コンテキスト(explorer調査済み 2026-07-23。着手時に現物と突き合わせること)

- 中盤練習: `app/src/midgame/PracticeMode.tsx`(903行)。1ステージ=プレイヤー3手×相手3応手(`ROUNDS_PER_STAGE=3`)。相手は常に最善手(`pickOpponentMove(allMoves,'best')`固定)。探索設定は `MIDGAME_ANALYZE_LIMIT = {depth:16, timeMs:1000, exactFromEmpties:24}`(表示・判定・応手すべて同一設定、`getAnalyzedMoves`キャッシュ一元化 — この一元化は壊さない)。
- 悪手検出の現状: `handlePlayerMove`(`PracticeMode.tsx:474`)で `loss = best.discDiff - played.discDiff` を計算し `MoveOutcome` に蓄積、その場では表示せず結果画面で最悪手のみ `ClearBlunderCompare`(1手先の2盤面比較、`ClearBlunderCompare.tsx`)を表示。閾値は1石(`clearBlunder.ts`、1石未満は計算スキップ)。
- 盤面部品: `Board`(Canvas)+`MoveEvalOverlay`(合法手の評価値を8x8グリッドで重ねる、`components/MoveEvalOverlay.tsx`)+`BoardOverlay`(強調マス)。小型盤2枚並べのCSS前例は `.clear-blunder-compare__board-col`(`PracticeMode.css:369-457`、375px以下縦積み)。**BoardOverlayとMoveEvalOverlayを同一盤面に同時に重ねる前例はない**(z-index・ラベル帯オフセットに注意、`Board.tsx:53-62`)。
- 全合法手評価: `EngineClient.requestAnalyzeAll(board, turn, limit): Promise<MoveEvalJson[]>`(`client.ts:114-135`、`MoveEvalJson={move,score,discDiff,type}`、discDiffは**手番視点**)。
- 手番解決: 相手応手後にパスが起きうるため `resolveMover`(`midgame/resolveMover.ts:26`)を使う既存規約。
- 平易メッセージの前例: `clearBlunder.ts` の日本語文(「この手の後、相手は5か所に打てます。最善手なら2か所でした。」)。この文体を踏襲する。

## 要件

1. **即時フィードバック**: `handlePlayerMove` で loss ≥ 1石(既存閾値定数を使う)を検出したら、相手の自動応手を保留して比較モーダル(またはインライン差し替え画面)を表示する。「続ける」で閉じたら通常どおり相手が応手しステージ続行(左盤面の応手=実際に打たれる手になる。相手は'best'固定なので一致する)。
2. **2系列の計算**(新規Worker呼び出し、`MIDGAME_ANALYZE_LIMIT`使用):
   - 系列A(実際の手): `boardAfterPlayed` → `requestAnalyzeAll`で相手最善応手を特定 → 適用(`resolveMover`でパス解決) → その局面で`requestAnalyzeAll` → 自分の合法手評価一覧。
   - 系列B(最善手): 同様に `boardAfterBest` から。
   - 2系列は`Promise.all`で並列化してよい(系列内は逐次依存)。計算中はローディング表示(合計約2秒見込み)。
3. **表示(新コンポーネント、例 `TwoPlyCompare.tsx`)**:
   - 左右に小型`Board`。各盤面に (a) 打った手/最善手と相手応手の強調(`BoardOverlay`または最終手マーカー) (b) `MoveEvalOverlay`で自分の各合法手の評価値、を同時表示。
   - 各盤面の上か下に「あなた: X → 相手: Y → **打てる場所: N か所**」のヘッダ。
   - 説明文(平易な日本語、clearBlunder.ts文体): 主文=「この手だと次にあなたは N か所に打てます(いちばん良い手で {A})。最善手なら M か所(いちばん良い手で {B})でした。」のように**着手可能数**と**その中の最善評価値**を対で述べる。加えて損失(この手は最善より約L石損)を1行。既存の`detectClearBlunderPatterns`が検出された場合は補足行として最大2件併記してよい(廃止はしない)。
   - レスポンシブ(375px以下で縦積み、既存CSSパターン踏襲)。
4. **エッジケース**(挙動を実装しテストで固定):
   - 相手が応手できない(パス)→ `resolveMover`で自分の番のまま進め、「相手はパス」と明記して自分の合法手評価を表示。
   - 2手進める前に終局 → 盤面+「終局: 石差±S」を表示(合法手オーバーレイなし)。
   - 自分の次の番が0か所(パス)→「打てる場所: 0 か所(パス)」と表示。
5. **結果画面の置き換え**: 結果画面の最悪手表示(現行`ClearBlunderCompare`)も新コンポーネントに置き換える(1手先版は削除してよいが、`clearBlunderPatterns`の検出・`patternStats`への記録は現状のまま維持)。
6. 既存の一元化設計(表示・判定・応手が同一`getAnalyzedMoves`を参照)を壊さない。新規呼び出しは比較用の4回のみ(結果はモーダル内でキャッシュし、同じ手の再表示で再計算しない)。

## やらないこと(スコープ外)

- 棋譜解析モードへの適用(T196で実施。ただし新コンポーネントはT196から再利用できるよう、PracticeMode固有のstateに依存しない純粋なprops設計にすること)
- 評価値グラフ・有利不利表示の変更(T197)
- エンジン側(Rust)の変更
- 言語化支援の既存モジュール(attribution/whyBad等)の削除(棋譜解析側はT196で扱う)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npm test` 全件パス(既存テスト回帰なし)。新規テスト: (a) 比較計算ロジック(2系列の相手最善特定→適用→合法手数、パス/終局エッジ含む)の単体テスト (b) メッセージ生成の単体テスト (c) 悪手時にモーダルが出て「続ける」で相手が応手するコンポーネントテスト(jsdom前例: T115/T117)。
- [ ] `npm run build`(型チェック込み)成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URL(https://giwarb.github.io/othello-trainer/)の中盤練習で**わざと悪手を打ち**、2盤面比較(合法手評価値オーバーレイ・着手可能数・説明文)が表示され「続ける」でステージ続行できることを実機確認(スクリーンショット相当の確認記録を作業ログへ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-23 実装完了(implementer)

**調査・設計判断**
- `MoveEvalOverlay`/`BoardOverlay`/`Board`(`lastMove`組み込みマーカー)・`ClearBlunderCompare.tsx`(旧1手先対比)・`clearBlunder.ts`・`resolveMover.ts`・`PracticeMode.tsx`の既存実装を精読。
- **BoardOverlayとMoveEvalOverlayの同時重ねは採用しなかった**: タスク仕様が「強調(BoardOverlayまたは最終手マーカー)」と選択肢を与えていたため、後者(`Board`組み込みの`lastMove`赤リング)を採用。理由は`TwoPlyCompare.tsx`のdocコメントに記載: `Board`+`MoveEvalOverlay`の組み合わせは既存プレイ画面(`.board-with-move-eval-overlay`)に前例があるのに対し、`BoardOverlay`+`MoveEvalOverlay`の同時重ねは前例が無くz-index検証コストが増えるため。1手目(打った手/最善手)の位置はヘッダ文言で明記し、リングは直近の手(相手応手、相手パス時は自分の手)にのみ付与する。
- 2手先の解決規則は「相手が応手できない場合パス」「(応手/パス後に)自分に合法手が無ければ`selfPass`」「いずれかの段階で双方合法手なしなら`ended`」の3分岐+通常`ok`の計4種として`twoPlyCompare.ts`にモジュールdocを添えて実装(エッジケース3種を要件どおりカバー)。
- 局面フィクスチャ(相手パス/自分パス/2種類の真の終局)は`scratchpad`で`npx tsx`により`game/othello.ts`を直接実行して構成・検証済み(`resolveMover.test.ts`の`buildIsolatedPocketsBoard`と同じ「独立した孤立領域」構成手法。自分パス用は3つの孤立領域+ブロッカー2箇所で構成)。
- 結果画面の最悪手表示条件を、旧「`clearBlunderPatterns`検出時のみ」から「損失`PATTERN_DETECTION_LOSS_THRESHOLD`(1石)以上」に変更(即時フィードバックと同じ閾値に統一。パターン検出・記録自体は変更していない、要件5どおり)。

**変更・追加ファイル**
- 新規: `app/src/midgame/twoPlyCompare.ts`(純粋計算: 2手先分岐計算・ヘッダ/主文/損失文言の生成)、`app/src/midgame/twoPlyCompare.test.ts`(単体テスト10件: 通常/相手パス/自分パス/終局2種/並列計算/メッセージ生成)。
- 新規: `app/src/midgame/TwoPlyCompare.tsx`(純粋props表示コンポーネント、T196向けにPracticeMode固有stateへ非依存)、`app/src/midgame/TwoPlyCompare.css`(独立スタイル、ランドスケープ盤サイズ調整含む)、`app/src/midgame/TwoPlyCompare.test.tsx`(コンポーネントテスト5件: 通常表示/続けるボタン有無/自分パス時オーバーレイ無し/終局時オーバーレイ無し/補足パターン表示)。
- 変更: `app/src/midgame/PracticeMode.tsx`(`handlePlayerMove`に悪手保留分岐追加、`pendingCompare`/`worstMoveCompare`state・`loadTwoPlyCompare`/`handleContinueAfterCompare`関数追加、プレイ画面・結果画面のJSXを`TwoPlyCompare`使用に置き換え)。
- 変更: `app/src/midgame/PracticeMode.css`(`.clear-blunder-compare*`削除、`.midgame-practice__blunder-compare`等追加、ランドスケープメディアクエリを`.two-ply-compare`向けに書き換え)。
- 変更: `app/src/midgame/PracticeMode.flow.test.tsx`(悪手直後に保留→「続ける」クリック→継続、のフローに合わせてテスト更新)。
- 変更: `app/src/app.css`(コメント内の`ClearBlunderCompare`参照を`TwoPlyCompare`に更新、挙動変更なし)。
- 削除: `app/src/midgame/ClearBlunderCompare.tsx`・`ClearBlunderCompare.test.tsx`(`TwoPlyCompare`に統合・置き換え)。

**受け入れ基準の実行結果**
- `cd app && npx vitest run` → 全99ファイル845件パス(`src/midgame`のみでも16ファイル149件パス)。
- `cd app && npm run build`(`tsc -b && vite build`ほか) → 成功。
- コミット `e9984a3`(`main`へpush済み、`git push origin main` 6a3492f..e9984a3)。ワーカー(自分)がタスク変更対象ファイルのみパス明示`git add`してコミット(`tasks/`・`CLAUDE.md`は含めていない)。
- GitHub Actions「Deploy to GitHub Pages」(run 29956664974)→ `build`・`deploy`ジョブとも成功(`gh run watch`で完走を確認)。
- 実機確認(Playwright MCPのBrowserツール、`https://giwarb.github.io/othello-trainer/`): 中盤練習ステージ1でわざと悪手(-10、最善+2との差12石)を打つと、「1/3手」の位置で相手の自動応手が保留され、「最善ではありません(最善より約12石損)」見出し+「実際に打った手」(あなた: g5 → 相手: e3 → 打てる場所: 6 か所、合法手評価オーバーレイ)/「最善手」(あなた: f4 → 相手: f6 → 打てる場所: 7 か所、合法手評価オーバーレイ)の2盤面+主文「この手だと次にあなたは6か所に打てます(いちばん良い手で-12)。最善手なら7か所(いちばん良い手で+1)でした。」+損失文「この手は最善手より約12石損しています。」+「続ける」ボタンを確認。「続ける」クリックで相手が応手し通常のプレイ画面(オーバーレイ付き)に戻ることを確認。ローカル(`npm run dev`)でも同一シナリオを先に確認済み(結果画面の最悪手表示も同じ`TwoPlyCompare`で表示されることを含む)。
- `git status --short` はタスク由来の差分・未追跡ファイルなし(コミット後クリーン)。

**仕様どおりにできなかった点・判断に迷った点**
- なし(スコープ外のBoardOverlay併用は不採用、代替の「最終手マーカー」案は仕様が明示的に許容していた選択肢)。

### 2026-07-23 verifier独立検証(判定: 合格)

対象コミット `e9984a3`(検証時点でHEADは `ecd9792` だが、これは`tasks/`のみの差分でapp/配下に変更なし。実質同一内容を検証)。

1. `cd app && npx vitest run` → 全99ファイル845件パス。新規テスト個別実行でも確認: `twoPlyCompare.test.ts`10件・`TwoPlyCompare.test.tsx`5件・`PracticeMode.flow.test.tsx`3件、いずれもパス。
2. **検知力の抜き取り確認**: `twoPlyCompare.ts`の`computeTwoPlyBranch`内、相手最善応手の特定(`const best = bestOf(opponentMoves)`)を一時的に「最悪応手を選ぶ」実装(`opponentMoves.reduce((a,b)=>(b.discDiff<a.discDiff?b:a))`)に書き換えて`twoPlyCompare.test.ts`を再実行 → 想定どおり2件が検知して失敗(「通常ケース」で応手が`f4`期待に対し`d6`、「自分パス」で`kind`が`selfPass`期待に対し`ok`)。直後に元のコードへ復元し、`git diff app/src/midgame/twoPlyCompare.ts`が空(完全復元)であることを確認したうえで再実行し15件全パスに戻ることを確認。
3. `cd app && npm run build`(`tsc -b && vite build`+wasm検証スクリプト+SW版数注入)→ 成功。
4. `git show e9984a3 --stat` → 変更11ファイルはすべて`app/src/`配下(`app.css`/`ClearBlunderCompare.*`削除/`PracticeMode.css`/`PracticeMode.tsx`/`TwoPlyCompare.css`/`TwoPlyCompare.tsx`/`twoPlyCompare.test.ts`/`twoPlyCompare.ts`/`PracticeMode.flow.test.tsx`)。`tasks/`・`engine/`の混入なし。
5. コード読解による要件突合:
   (a) 閾値: `PracticeMode.tsx`の既存定数`PATTERN_DETECTION_LOSS_THRESHOLD = 1`(旧T129由来)をそのまま`handlePlayerMove`(L545, L598)・結果画面`worstMoveCompareInfo`(L753)双方のゲート条件に再利用。新規定数の追加なし。
   (b) 悪手時のゲート: `handlePlayerMove`は`!isBest && lossDiscs >= PATTERN_DETECTION_LOSS_THRESHOLD`のとき`setSession`を呼ばず`setPendingCompare(...)`のみ実行(L598-616)。`session`が着手前のまま変わらないため相手自動応手`useEffect`(`session.sideToMove !== humanSide`条件)は発火せず、`handleContinueAfterCompare`(L654-662)が呼ばれて初めて`setSession(pending.nextSession)`される設計を確認。実機操作でも保留→続けるの動作を確認(下記6)。
   (c) `getAnalyzedMoves`一元化: 表示・判定・応手は従来どおり`getAnalyzedMoves`(L265-273、局面+手番でキャッシュ)経由のまま変更なし。比較専用に`requestAnalyzeAllForCompare`(L284-286、キャッシュなしで`getEngine().requestAnalyzeAll`を直接呼ぶ別関数)を新設し、`loadTwoPlyCompare`→`computeTwoPlyCompare`→系列ごとに`computeTwoPlyBranch`が最大2回ずつ呼ぶ設計(最大合計4回)。既存キャッシュへの混入なし。
   (d) `patternStats`記録: `handlePlayerMove`内の`recordPatternFailuresNow(allDetectedPatternIds)`(L563)呼び出しは即時フィードバック導入後も変更されておらず、`clearBlunderPatterns`の検出・記録経路は温存されていることを確認。結果画面側も`worst.clearBlunderPatterns`をそのまま`TwoPlyCompare`の`patterns`propに渡すのみで検出・記録ロジックの二重化なし。
   (e) `resolveMover`使用: `twoPlyCompare.ts`が`resolveMover`を直接import(L41)し、規則1・3の終局判定に使用(L107, L139)。`PracticeMode.tsx`側も`resolveNextSideOrFallback`(`resolveMover`をラップ、`resolveMover.ts:48-50`)を着手適用後・比較後続行の両方で使用(L584, L671等)。
6. **GitHub Pages実機確認(Playwright、`chromium.launch()`ヘッドレス、`https://giwarb.github.io/othello-trainer/`)**: `gh run list`で`e9984a3`のデプロイ実行(29956664974/29956665006)がいずれも`conclusion: success`であることを確認したうえで本番URLへ直接アクセスして検証(HEADは`ecd9792`だが差分はtasks/のみのため公開内容は同一)。
   - シナリオA(悪手): 中盤練習ステージ1で合法手評価オーバーレイの最小値(-10、g5)を選んでクリック → 見出し「最善ではありません(最善より約12石損)」、盤面ヘッダ「あなた: g5 → 相手: e3 → 打てる場所: 6 か所」/「あなた: f4 → 相手: f6 → 打てる場所: 7 か所」、主文「この手だと次にあなたは6か所に打てます(いちばん良い手で-12)。最善手なら7か所(いちばん良い手で+1)でした。」、損失文「この手は最善手より約12石損しています。」、両盤面に合法手評価オーバーレイ(計13マス)を確認。実装者の報告値と完全一致。スクリーンショット保全(セッションscratchpad内`t195-compare.png`)。
   - 「続ける」クリック→`.two-ply-compare`がDOMから消え、保留していた相手応手(e3、赤リング)が適用された通常プレイ画面に戻ることを確認(スクリーンショット`t195-after-continue.png`)。
   - シナリオB(最善手): 新規セッションでオーバーレイ最大値(0、b4相当)をクリック→4秒待っても`.two-ply-compare`が出現しないこと(悪手でない手では比較が出ない)、その後相手が自動応手し通常どおりステージが続行すること(評価バー+1、相手応手に赤リング)を確認(スクリーンショット`t195-bestmove-noncompare.png`)。
   - コンソールエラー・pageerrorともに0件。
7. `git status --short` → クリーン(検証中に生成した一時ファイルはリポジトリ外のセッションscratchpadに保存し、リポジトリには残していない)。

**総合判定**: 合格。受け入れ基準4項目すべて満たし、追加確認(検知力抜き取り・要件突合・実機2シナリオ)もすべて期待どおり。指摘事項なし。

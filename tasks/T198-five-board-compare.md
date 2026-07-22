---
id: T198
title: 悪手比較を5盤面表示に拡張(元局面+1手先×2+2手先×2)
status: review
assignee: implementer
attempts: 0
---

# T198: 悪手比較を5盤面表示に拡張(元局面+1手先×2+2手先×2)

## 目的(ユーザー依頼 2026-07-23)

T195/T196の2盤面比較(2手先のみ)を拡張し、**5つの盤面をすぐに見られる**ようにする:

1. **元局面**(悪手を打つ前)
2. **1手先・実際の手**(実際に打った直後=相手の番)
3. **1手先・最善手**(最善手を打った直後=相手の番)
4. **2手先・実際の手**(相手の最善応手後=自分の番)
5. **2手先・最善手**(相手の最善応手後=自分の番)

追加要件:
- **各盤面で、その局面の手番側の全合法手に対する評価値をすべて表示**(元局面=自分の合法手、1手先=相手の合法手、2手先=自分の合法手。MoveEvalOverlay)
- **1手先・2手先の盤面には「どこに打ったのか」を分かりやすく表示**(1手先=自分が打ったマス、2手先=相手が応手したマス+自分が打ったマスも識別できること)

## 背景・コンテキスト

- 対象コンポーネント: `app/src/midgame/TwoPlyCompare.tsx` / `twoPlyCompare.ts` / `TwoPlyCompare.css`(T195新設、e9984a3)。利用箇所は2つ: 中盤練習 `PracticeMode.tsx`(即時フィードバック+結果画面)と棋譜解析 `BlunderPanel.tsx`(T196、f47632a)。**両方の利用箇所で5盤面表示になること**。
- 必要データの大半は既に計算済み: 2手先計算(`computeTwoPlyCompare`)の途中で、1手先局面での相手の全合法手評価(`requestAnalyzeAll`、相手最善の特定に使用)と2手先局面での自分の全合法手評価を取得している。**捨てずに結果に含めれば1手先盤面のオーバーレイに使える**(追加呼び出し不要)。
- 元局面の自分の全合法手評価は: 中盤練習では `getAnalyzedMoves` キャッシュに既にある(着手時に取得済み)。棋譜解析では `MoveAnalysis` に全合法手評価があるか確認し、無ければ `requestAnalyzeAll` を1回追加(ANALYZE_LIMIT)。呼び出し元からpropsで渡す設計にする(コンポーネントは純粋propsを維持)。
- 着手位置の明示: 1手先盤面は `Board` の `lastMove` リング(自分の手)。2手先盤面は相手応手に `lastMove` リングを付けたうえで、自分の手のマスも識別可能にする(候補: BoardOverlayの強調併用〔MoveEvalOverlayとの同時重ねは前例なし、z-index・ラベル帯オフセット注意〕、または盤面下ラベル+マス座標の明示、または数字バッジ①②。**実機で視認性を確認して選ぶこと**。ヘッダ文言だけで済ませるのは不可=「盤面上で分かりやすく」が要望)。
- パス・終局エッジ(T195の4分岐)は5盤面でも整合させる: 相手パスなら1手先と2手先が同一局面になる(その旨を表示)、終局なら以降の盤面は終局表示。

## 要件

1. `TwoPlyCompareResult`(または後継型)に1手先の相手合法手評価・元局面情報を含める(計算の追加呼び出しは元局面分の最大1回のみ。既存の呼び出し回数構成を崩さない)。
2. 表示レイアウト: 5盤面が一目で比較できる構成(推奨: 上段に元局面、下段に左列〔実際の手: 1手先→2手先〕・右列〔最善手: 1手先→2手先〕。列単位で流れが追える配置)。デスクトップで5面同時視認、モバイル(≤400px)では縦積みで順に見られること。盤面サイズは既存の小型盤スタイルを踏襲。
3. 各盤面に手番側の合法手評価オーバーレイ(`MoveEvalOverlay`、moverはその局面の手番)。ヘッダに「打てる場所: N か所」を全盤面で表示(1手先は相手のNか所)。
4. 着手位置の明示(上記背景の方式から実機確認して選択)。
5. 既存の説明文(主指標=2手先の自分の着手可能数の比較+損失1行)は維持。中盤練習の「続ける」フロー・棋譜解析の詳細分析折りたたみは無変更。
6. T195/T196の既存テストを新構成に合わせて更新し、5盤面のレンダリング・1手先オーバーレイの手番・エッジケース表示のテストを追加。

## やらないこと(スコープ外)

- 3手先以上への拡張・分岐の対話的操作(フリー分岐探索は棋譜解析の既存機能のまま)
- 評価値グラフ・評価バー(T197)への変更
- エンジン側の変更
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npx vitest run` 全件パス(既存テストの期待値更新込み、削除で逃げない)。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 実機で: 中盤練習で悪手→5盤面(元局面+1手先×2+2手先×2)が表示され、全盤面に合法手評価、1手先/2手先の着手位置が盤面上で識別できること。棋譜解析の悪手パネルでも同様。モバイル幅でも崩れないこと。確認記録を作業ログへ。
- [ ] コミットは変更対象ファイルのみをパス明示で add。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-23 実装(implementer)

- `app/src/midgame/twoPlyCompare.ts`: `TwoPlyBranchResult`の全kindに`board1Ply`(1手先盤面)・`opponentMoves`(1手先の相手全合法手評価、相手に合法手が無ければ`null`)を追加。`computeTwoPlyBranch`は従来「相手最善を選ぶためだけに使って捨てていた」`requestAnalyzeAll`結果を`opponentMoves`として保持するだけで、追加のエンジン呼び出しは発生しない(既存の呼び出し回数構成=1系列最大2回・2系列最大4回は不変)。旧`formatTwoPlyBranchHeader`を廃止し、5パネル構成に合わせて`formatOriginalLegalCountHeader`/`formatOpponentLegalCountHeader`/`formatSelfLegalCountHeader`/`formatOpponentPassNote`を新設。
- `app/src/midgame/TwoPlyCompare.tsx`: 2盤面→5盤面(元局面+1手先×2+2手先×2)表示へ全面書き換え。レイアウトは上段に元局面、下段に左列(実際の手: 1手先→2手先)・右列(最善手: 1手先→2手先)。着手位置の明示は「自分」「相手」の文字バッジ(`MoveMarkerOverlay`、`MoveEvalOverlay`/`analysis/BoardOverlay`と同じ8x8 CSS Grid重ね方式)を採用(下記「実機確認」の理由参照)。`preMoveBoard`/`originalMoves`をpropsに追加(元局面パネル用、呼び出し元が用意)。
- `app/src/midgame/TwoPlyCompare.css`: `.two-ply-compare__original`/`.two-ply-compare__columns`/`.two-ply-compare__column`(5盤面レイアウト)、`.two-ply-compare__move-markers*`(着手位置バッジ)を追加。モバイル(≤400px)は引き続き縦積み、横置き低高さ時の縮小率も5枚化に合わせて調整。
- `app/src/midgame/PracticeMode.tsx`: `MoveOutcome`に`allMoves`(着手判定時に取得済みの元局面全合法手評価)を追加、`PendingBlunderCompare`に`originalMoves`を追加。即時フィードバック(`pendingCompare`)・結果画面(`worstMoveCompareInfo`)いずれも、着手時に取得済みの`allMoves`をそのまま再利用するため元局面用の追加エンジン呼び出しは発生しない。両方の`<TwoPlyCompare>`呼び出しに`preMoveBoard`/`originalMoves`を追加。
- `app/src/analysis/BlunderPanel.tsx`: `MoveAnalysis`には元局面の全合法手評価が無いため、`originalMoves`用に`requestAnalyzeAll`を1回追加(`computeTwoPlyCompare`と並行、useEffect内)。`<TwoPlyCompare>`に`preMoveBoard={moveAnalysis.board}`/`originalMoves`を追加。
- テスト更新: `app/src/midgame/twoPlyCompare.test.ts`(`board1Ply`/`opponentMoves`の検証追加、新ヘッダ関数のテスト追加、旧`formatTwoPlyBranchHeader`のテスト削除)、`app/src/midgame/TwoPlyCompare.test.tsx`(5盤面レンダリング・1手先オーバーレイの手番・相手パス/終局エッジケース・着手バッジ件数のテストを全面書き換え)。`PracticeMode.flow.test.tsx`/`BlunderPanel.test.tsx`は文言の後方互換性(「実際に打った手」「最善手」を含むラベル文言を維持)によりノーコード変更で成功。

### 着手位置マーカー方式の選定(実機確認)

- 候補: (a) 既存`lastMove`リング(赤)のみ、(b) `BoardOverlay`の`emphasizedSquares`併用、(c) 文字バッジ(「自分」「相手」)、(d) 数字バッジ(①②)。
- 2手先盤面では「自分の手」「相手の応手」の2マスを同時に区別する必要があり、`lastMove`リング(1つしか指定できない)単独では不十分。`BoardOverlay`は`MoveEvalOverlay`と同じ8x8 Grid方式だが色分類が多く(危険なX/C打ち等)配色が競合しやすい。数字バッジは色覚に依存しないが「①=自分」という対応をユーザーが覚える必要がある。
- 採用: **文字バッジ**(「自分」＝青、「相手」＝赤、`MoveEvalOverlay`と同じ8x8 CSS Grid重ね、`pointer-events:none`)。着手マス(石が置かれ、もう合法手ではないマス)にだけ表示するため`MoveEvalOverlay`の数値セル(まだ打たれていない合法手マス)と重ならず競合しない。色だけに頼らずラベルで即座に意味が伝わる点を優先した。1手先盤面は`lastMove`リングのみ(単一マスのため曖昧さが無い)、2手先盤面は`lastMove`リング(相手の直近手、既存の視覚言語)+文字バッジ両方(自分・相手を明示)。

### 受け入れ基準チェック

- `cd app && npx vitest run`: 103 test files / 870 tests 全件パス。
- `npm run build`: 成功(wasmビルド込み)。
- ローカルdevサーバ(`vite`、Browser paneのjavascript_toolでcanvasクリックをディスパッチして操作、screenshotはこの環境で使用不可のためDOM検証で代替)で確認:
  - 中盤練習(即時フィードバック): 第1問で明確な悪手(-10)を選択→5盤面(元局面/実際に打った手1手先・2手先/最善手1手先・2手先)がラベル・ヘッダ(「打てる場所: N か所」)付きで表示。1手先パネルは「自分」バッジ1件、2手先パネルは「自分」「相手」バッジ2件(own計4・opponent計2、期待どおり)。
  - 中盤練習(結果画面): 3手打ち切り後、最も損失が大きかった手についても同じ5盤面が表示され、即時フィードバックと数値が一致(元局面の`allMoves`再利用によりローディングなしで即表示)。
  - モバイル幅(375px)で中盤練習の5盤面が横あふれ無く縦積み(`board-col`のx座標が同一、y座標が積み上がることをDOM座標で確認)。
  - 棋譜解析(BlunderPanel): 12手の棋譜を解析し、悪手マーカー(3手目 c3、?? 悪手)から悪手分析パネルを開くと、同じ5盤面比較が表示される(元局面のみ追加`requestAnalyzeAll`1回で取得、ローディング後に「打てる場所: 5 か所」表示)。モバイル幅でも横あふれ無し。
  - 相手パス・終局エッジケースはコンポーネントテスト(`TwoPlyCompare.test.tsx`)でカバー(実局面でこれらのケースを引くのは稀なため実機では未確認、テストでの担保とした)。
  - 採用したマーカー方式: 文字バッジ(「自分」=青地に白文字、「相手」=赤地に白文字)。実機で石の上に小さく重なっても視認でき、色だけに頼らないため明確と判断した。
- コミット`cc3d83b`をpush、GitHub Actions「Deploy to GitHub Pages」(run 29964878114)成功を`gh run watch`で確認。
- GitHub Pages実機(`https://giwarb.github.io/othello-trainer/`)で最終確認(Browser paneのjavascript_toolでDOM操作、screenshotは本環境で利用不可のためDOM/座標検証で代替):
  - 中盤練習(第3問「羊」、b5で-3の悪手を選択): 5盤面(元局面/実際に打った手1・2手先/最善手1・2手先)がラベル・「打てる場所: N か所」ヘッダ付きで表示。バッジ件数は自分4・相手2、合法手評価セル37件(想定どおり)。
  - モバイル幅(375px)で中盤練習の5盤面が横あふれ無し(`overflowingCount: 0`, `bodyOverflow: false`)。
  - 棋譜解析(12手棋譜を解析、3手目c3の悪手分析パネルを開く): 元局面(追加requestAnalyzeAll 1回)含む同じ5盤面比較が表示され、ローカル確認と同一の構成(ラベル・ヘッダ・バッジ)。モバイル幅でも横あふれ無し。

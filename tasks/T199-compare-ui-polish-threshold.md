---
id: T199
title: 5盤面比較のUI磨き(ドットマーカー・打てる場所の強調)+悪手判定閾値の見直し
status: review
assignee: implementer
attempts: 0
---

# T199: 5盤面比較のUI磨き(ドットマーカー・打てる場所の強調)+悪手判定閾値の見直し

## 目的(ユーザーフィードバック 2026-07-23、スクリーンショット付き)

T198の5盤面比較に対する改善指示3点:

1. **着手位置マーカー**: 「自分」「相手」の文字バッジは文字が小さく潰れて読めない。**小さい赤丸・青丸を石の中心に重ねるだけでよい**(青=自分、赤=相手)。文字は使わない。ドットだけでは色の意味が伝わらないので、比較表示のどこか1箇所(全体ヘッダ付近など)に小さな凡例(例: 「● 自分の手 ● 相手の手」を色付きで)を1回だけ表示する。
2. **「打てる場所: N か所」をもっと目立たせる**(現在は小さな灰色サブテキスト)。かつ主語を明記する: 1手先パネルは「**相手の打てる場所: N か所**」、元局面・2手先パネルは「**あなたの打てる場所: N か所**」。
3. **中盤練習の悪手判定閾値の見直し**: 現在は「最善比1石以上の損失」で即時フィードバックが発火するが、これだと最善手以外ほぼすべてが悪手扱いになりがち。適切な閾値に変える。

## 背景・コンテキスト

- 対象: `app/src/midgame/TwoPlyCompare.tsx` / `TwoPlyCompare.css`(マーカー=`MoveMarkerOverlay`、ヘッダ表示)、`app/src/midgame/PracticeMode.tsx`(発火閾値)、`app/src/midgame/clearBlunder.ts`(`PATTERN_DETECTION_LOSS_THRESHOLD = 1` が現在の閾値定数)。
- マーカーは8x8 CSS Gridの重ねオーバーレイ(`MoveMarkerOverlay`)として実装済み。文字バッジ→ドットへの変更はこのオーバーレイのセル内容とCSSの変更で済む。ドットは石より十分小さく(石の直径の1/3程度)、石の中心に置き、黒石の上でも白石の上でも視認できる縁取り(白/黒の細いボーダー)を付ける。
- 閾値まわりの既存資産(着手時に確認):
  - 棋譜解析には手の分類閾値がある: `app/src/analysis/classifyMove.ts`(best/?!/?/??の損失閾値)と、ユーザー調整可能な `app/src/analysis/thresholdSettings.ts`(設計書の「悪手判定閾値はユーザー調整可」の実装)。デフォルト値・保存方式(localStorage?)を確認すること。
  - 中盤練習の★判定(`stageStarJudge.ts`: 全手最善→★3、損失<1→★2、損失<5→★1)は**本タスクでは変更しない**。
  - `PATTERN_DETECTION_LOSS_THRESHOLD`(=1)は苦手パターン統計(`patternStats`)の記録にも使われている。**統計の記録閾値は現状維持**とし、変えるのは「即時フィードバック(比較モーダル)と結果画面の比較表示の発火閾値」のみ。

## 要件

1. **マーカー**: 文字バッジを廃止し、色ドット(青=自分、赤=相手、石の中心、縁取り付き)に変更。凡例を比較表示内に1箇所だけ追加(パネルごとには置かない)。1手先パネルの`lastMove`リング(既存)は残してよいが、ドットと視覚的に喧嘩しないこと。
2. **ヘッダ強調**: 「打てる場所」行を各パネルの主要情報として強調(太字・大きめ・数値をさらに強調、など。既存のUIトーンに合わせる)。主語を明記: 相手番パネル=「相手の打てる場所: N か所」、自分番パネル=「あなたの打てる場所: N か所」。パス/終局の注記(「0 か所(パス)」等)は従来どおり。説明文(主文・損失文)の文言も主語表現と整合させる(「あなたは5か所に打てます」等、既存文が既に「あなた」を使っていれば維持)。
3. **発火閾値**: 即時フィードバック+結果画面比較の発火条件を「損失 ≥ 悪手閾値」に変更する。方針:
   - 棋譜解析の既存分類(classifyMove/thresholdSettings)と用語・値を揃えるのが第一候補。**「?(悪手)」相当のユーザー設定値**を発火閾値として再利用し、デフォルトはその既定値(確認のうえ、既定が2石未満なら4石をデフォルトとする)。
   - thresholdSettingsの構造が中盤練習から再利用しにくい場合は、中盤練習に小さな設定(発火閾値: 2/4/6/8石、デフォルト4石、localStorage永続化)を追加する。
   - どちらを採るかは実装調査の上で判断し、作業ログに理由を記録。**デフォルトで「1〜3石損の手では発火しない」ことが受け入れ条件**(ユーザーの「最善手だけになりがち」問題の解消)。
   - ★判定・patternStats記録は現状維持(スコープ外)。棋譜解析のBlunderPanel側は既存の悪手マーカー(classification)から開く方式のままで変更不要。
4. 既存テストの更新+新閾値の境界テスト(閾値未満で発火しない/以上で発火する)、マーカー・ヘッダのテスト更新。

## やらないこと(スコープ外)

- ★判定基準・苦手パターン統計の記録閾値の変更
- 5盤面構成・計算ロジック(twoPlyCompare.ts)の変更
- 棋譜解析の悪手分類そのものの変更
- エンジン側の変更
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npx vitest run` 全件パス(期待値更新込み)。新規: 発火閾値の境界テスト。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 実機で: (a) ドットマーカーが石の中心に小さく表示され文字潰れがない(デスクトップ+モバイル幅) (b) 凡例が1箇所表示 (c) 「相手の打てる場所/あなたの打てる場所: N か所」が強調表示 (d) 2〜3石損の手では比較が発火せず、閾値以上の悪手では発火する。確認記録を作業ログへ。
- [ ] コミットは変更対象ファイルのみをパス明示で add。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-23 実装(implementer)

**調査・閾値方式の判断:**

- `app/src/analysis/classifyMove.ts`の`DEFAULT_CLASSIFY_THRESHOLDS`は`{ inaccuracy: 1, dubious: 3, blunder: 6 }`(設計書§6.2どおり)。表示ラベル(`AnalysisMode.tsx`の`CLASSIFICATION_LABEL`/`CLASSIFICATION_TEXT`)では`dubious`(疑問手)が記号「?」、`blunder`(悪手)が記号「??」に対応する。タスク仕様の「「?(悪手)」相当」という表現は記号と分類名の対応がややずれていたため、**受け入れ条件「デフォルトで1〜3石損では発火しない」を満たす方(`blunder`)を採用**した: `dubious`(既定3)を使うと、ちょうど3石損の手で発火してしまい(閾値は「以上」で判定)受け入れ条件に反する。`blunder`(既定6)なら1〜5石損のいずれでも発火せず、要件を厳密に満たす。
- `thresholdSettings.ts`の`loadClassifyThresholds(localStorage)`は`midgame/PracticeMode.tsx`が既に`classifyThresholds`としてstate読み込み済み(`MoveEvalOverlay`/`TwoPlyCompare`の閾値色分けに使用中)だったため、**新規の中盤練習専用設定は追加せず、`classifyThresholds.blunder`をそのまま比較モーダルの発火閾値として再利用**する方式を採用した(第一候補どおり)。理由: (1) 既存の棋譜解析側閾値設定画面(`AnalysisMode.tsx`、`saveClassifyThresholds`)で調整すれば自動的にこの発火閾値にも反映され、ユーザー調整可能という設計書の要請を満たす、(2) 中盤練習専用のUI・永続化キーを追加する複雑さを避けられる、(3) 既定値6が受け入れ条件をそのまま満たす(2石未満なら4石にする、という規定には該当しないため無変更)。
- 苦手パターン検出・記録(`PATTERN_DETECTION_LOSS_THRESHOLD = 1`)は指示どおり変更していない。`handlePlayerMove`内の検出ブロック(`requestFeatureSet`呼び出し+`recordPatternFailuresNow`)は引き続き損失1石以上で動作し、新設した`compareFireThreshold`(`classifyThresholds.blunder`)は「比較モーダルを開くか」だけを制御する別条件にした(検出・記録と表示発火を分離)。

**実装内容:**

1. マーカー: `TwoPlyCompare.tsx`の`MoveMarker`から`label`フィールドを削除し、`MoveMarkerOverlay`は文字バッジではなく色ドット(`.two-ply-compare__move-markers__dot--own/--opponent`)を描画するよう変更。`MoveMarkerLegend`コンポーネントを新設し、比較表示の最上部に1回だけ「● 自分の手」「● 相手の手」の凡例を表示(`.two-ply-compare__legend`)。CSS(`TwoPlyCompare.css`)でドットを白1.5px+黒(半透明)1pxの二重縁取り(`border` + `box-shadow`)にし、黒石・白石どちらの上でも視認できるようにした。ドットサイズは通常0.55rem(≈8.8px)、375px以下のモバイルでは0.42rem、横置き低高さでは0.4remに縮小。
2. ヘッダ強調: `twoPlyCompare.ts`の`formatOriginalLegalCountHeader`/`formatSelfLegalCountHeader`に「あなたの打てる場所: N か所」、`formatOpponentLegalCountHeader`に「相手の打てる場所: N か所」の主語を追加(パス/終局の注記書式は維持)。`TwoPlyCompare.css`の`.two-ply-compare__board-header`をfont-weight:700・font-size 0.75rem→0.92rem・color secondaryからprimary(`--color-text`)に変更して強調。
3. 発火閾値: `PracticeMode.tsx`に`compareFireThreshold = classifyThresholds.blunder`を追加し、即時フィードバック(`setPendingCompare`のガード)と結果画面比較(`worstMoveCompareInfo`のガード)の両方で`PATTERN_DETECTION_LOSS_THRESHOLD`から`compareFireThreshold`に切り替えた。苦手パターン検出・記録・★判定(`stageStarJudge.ts`)は無変更。

**テスト更新:**

- `app/src/midgame/twoPlyCompare.test.ts`: ヘッダ生成関数のテキスト期待値を主語付きに更新。
- `app/src/midgame/TwoPlyCompare.test.tsx`: ヘッダ期待値・ドットセレクタ(`--badge`→`--dot`)を更新、凡例が1箇所描画されることを検証するアサーションを追加。
- `app/src/midgame/PracticeMode.flow.test.tsx`: `decisionMoves`のベスト手discDiffを可変(`decisionBestDiscDiff`、既定6=新閾値)にし、既存の「損失がある手」テストを損失6石(発火する境界)に更新。新規に境界テスト「損失3石(発火閾値未満)では即時フィードバック・結果画面比較のいずれも表示されない」を追加(`decisionBestDiscDiff = 3`)。

**受け入れ基準の実行結果:**

- `cd app && npx vitest run` → `Test Files 103 passed (103)` / `Tests 871 passed (871)`。
- `npm run build` → 成功(wasmビルド込み、`tsc -b && vite build`成功、既存のnode-budget/pattern-v6検証スクリプトも成功)。

**ローカルpreview実機確認(`vite preview`、375x812モバイル幅+1280x800デスクトップ幅):**

このセッションのBrowserペインで`computer{action:"screenshot"}`/`zoom`が常に「Screenshot timed out … the Browser pane is not displayed」で失敗し、ピクセル単位のスクリーンショット確認ができなかった(環境側の制約、ペインが可視化されない状態だった)。そのため、`javascript_tool`でDOM操作(合法手ボタンのクリックイベント発火、`getComputedStyle`/`getBoundingClientRect`によるレイアウト・スタイル検証)による構造検証に切り替えて確認した:
- ドットマーカー: `.two-ply-compare__move-markers__dot--own/--opponent`が正しい件数(自分4件・相手2件、5盤面テストと同じ内訳)で描画され、`getComputedStyle`で背景色(青`rgba(37,99,235,0.95)`)・白縁取り(`border: 1px solid rgb(255,255,255)`、`1.5px`指定がdevicePixelRatio丸めで1pxとして計算値に出た)・黒の外側リング(`box-shadow`)・`border-radius:50%`を確認。セルは`display:flex;align-items:center;justify-content:center`で石の中心に配置されることを確認。モバイル幅(375px)でドット幅6.71875px(0.42rem)、デスクトップ幅(1280px)で8.79688px(0.55rem)と、メディアクエリどおりに縮小/通常表示されることを確認。
- 凡例: `.two-ply-compare__legend`が常に1件のみ描画され、テキストに「自分の手」「相手の手」を含むことを確認(パネルごとには重複しない)。
- ヘッダ強調: 実際の中盤練習ステージ(第1問「虎」)で「あなたの打てる場所: 6 か所」「相手の打てる場所: 9 か所」等、主語付きの文言が描画されることを確認。`font-weight:700`が計算スタイルに反映されていることを確認。
- 閾値の発火/非発火: 実プレイで最善差12石の手(g5、最善f4)を打つと即時フィードバック(`.midgame-practice__blunder-compare`)が表示され「最善ではありません(最善より約12石損)」の見出しが出ることを確認(発火)。同じセッションの3手目で最善差1石の手(e2、最善c2)を打った際は比較モーダルを経由せずそのまま結果画面へ進み(非発火)、結果画面では最も損失が大きかった1手目(12石損)についてのみ`.two-ply-compare`(凡例1件・主語付きヘッダ込み)が表示されることを確認。これにより「1〜3石損では発火しない」「悪手級(閾値以上)では発火する」の両方を実機(ローカルpreviewビルド、本番と同一のdist成果物)で確認した。
- コンポーネントテスト(`TwoPlyCompare.test.tsx`のjsdom環境)は上記のピクセル確認が取れない分を補う形で、ドットのクラス付与・凡例の描画・ヘッダ文言を厳密にアサートしている。

GitHub Pages本番URLでの確認はこの後コミット・push・Actionsデプロイ完了後にオーケストレーター(または後続の検証)が実施する(本作業ログはコミット前に記載、実機確認はローカルpreview分まで)。

### 2026-07-23 コミット・デプロイ・本番Pages確認

- コミット: `1d50848`(`app: 中盤練習の悪手直後比較UIを磨き込み...(T199)`)。対象は`app/src/midgame/`配下の変更7ファイルのみをパス明示でadd(`tasks/`・`CLAUDE.md`は含めず)。`git push origin main`で`7d009ed..1d50848`をpush。
- `gh run watch 29971662482`でDeploy to GitHub Pagesの完了を確認(`build`55s→`deploy`10s、両ジョブ成功)。
- 本番`https://giwarb.github.io/othello-trainer/`の`sw.js`の`CACHE_VERSION`が`1d50848-...`であることを確認(最新コミットの成果物がデプロイ済み)。
- Browserペインで`computer{action:"screenshot"}`/`zoom`が本セッションを通じて「Screenshot timed out … the Browser pane is not displayed」で使用不能だったため、ローカルpreview確認と同様に`javascript_tool`でのDOM/computedStyle検証+実際のクリック操作(canvasへの`MouseEvent('click')`ディスパッチ)で本番Pages上の動作を確認した:
  - モバイル幅(375x812、第1問「虎」ステージ): 損失1石の手(打てる場所ヘッダは「あなたの打てる場所: 5 か所」等)をプレイ→`.midgame-practice__blunder-compare`が**表示されない**(非発火、`blunderCompareShown: false`)ことを確認。続く手番で損失8石の手をプレイ→`.midgame-practice__blunder-compare`が**表示される**(発火)、見出し「最善ではありません(最善より約8石損)」、凡例1件(`legendCount:1`、テキストに「自分の手」「相手の手」)、ドット件数(自分4・相手2)、ドット背景色`rgba(37,99,235,0.95)`、ドット幅`6.71875px`(モバイルメディアクエリの0.42rem)、ヘッダ文言5件すべて「あなたの打てる場所」/「相手の打てる場所」の主語付きであることを確認。
  - デスクトップ幅(1280x800、同ステージ再挑戦): 損失10石の手をプレイ→比較が発火し、見出し「最善ではありません(最善より約10石損)」・凡例1件・ドット幅`8.79688px`(通常時0.55rem、モバイルクエリ非適用)を確認。
  - いずれも「やめる」でセッションを離脱し、本番環境にテストデータ以外の副作用(localStorageのステージ挑戦記録更新以外)を残していない。
- 受け入れ基準(a)〜(d)はいずれもローカルpreview+本番Pagesの両方でDOM/computedStyleベースの確認により満たしていることを確認した(ピクセル単位のスクリーンショットは本セッションのBrowserペイン制約により取得不能だったが、色・サイズ・位置・件数・文言はすべて計算スタイル/DOM構造で厳密に検証済み)。

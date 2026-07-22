---
id: T196
title: 棋譜解析: 悪手解析をシンプルな2盤面比較UIへ刷新
status: done
assignee: implementer
attempts: 0
---

# T196: 棋譜解析: 悪手解析をシンプルな2盤面比較UIへ刷新

## 目的(ユーザー依頼 2026-07-23)

棋譜解析モードの悪手解析(`BlunderPanel`)は情報量が多く「正直よくわからない。着手可能数の寄与ってなんやねん」というユーザー評価。T195で作った**2手先2盤面比較**(実際の手+相手最善 vs 最善手+相手最善、着手可能数+合法手評価値オーバーレイ+平易な説明文)を既定表示にし、既存の難解なセクションは折りたたみに退避する。

## 背景・コンテキスト(explorer調査済み。着手時に現物と突き合わせること)

- 現状の `BlunderPanel.tsx`(`app/src/analysis/`): ①比較PV(テキスト手順、comparePv.ts)②評価内訳waterfall(`AttributionWaterfall`=「着手可能数の寄与」等の抽象棒グラフ)③反証層(`RefutationView`)④なぜ悪いか(whyBad.tsの文章羅列)⑤フリー分岐探索(Board+MoveEvalOverlay)⑥練習送り、の縦積み。盤面は着手前局面1枚のみで、実際の手/最善手を進めた盤面は無い。
- `MoveAnalysis`型(`analysis/types.ts:42-90`)に `board`(着手前)・`move`・`bestMove` が既にある。エンジンは `engine: EngineClient` をpropsで受領済み(`BlunderPanel.tsx:78`)。探索設定は棋譜解析側の `ANALYZE_LIMIT`(`analysis/analyzeGame.ts`)を使う(中盤練習の`MIDGAME_ANALYZE_LIMIT`とは別定数。値の整合を確認して使うこと)。
- T195で新設した2盤面比較コンポーネント(`TwoPlyCompare.tsx`等、純粋props設計)を再利用する。**本タスクはT195完了後に着手**(コンポーネントと計算ロジックを共有)。

## 要件

1. `BlunderPanel` の既定表示を再構成する:
   - **最上部**: T195の2盤面比較(2系列の計算はパネル表示時に`requestAnalyzeAll`×4、`ANALYZE_LIMIT`使用、ローディング表示、パネル内キャッシュ)。損失の1行要約(「この手は最善より約L石損」)を添える。
   - **残す(そのまま)**: フリー分岐探索、練習へ送る。
   - **折りたたみへ退避**: 比較PV・評価内訳waterfall・反証層・whyBad文章を「詳細分析(上級者向け)」アコーディオン(既定で閉)にまとめる。**削除はしない**(実装済み資産の温存)。
2. エッジケース(パス応手・終局)はT195と同じ挙動・同じコンポーネントで処理。
3. 悪手モーダルを開く→比較が表示される→閉じる、の一連でリグレッションがないこと(既存のムーブリスト・悪手マーカー・練習送りの動作を維持)。

## やらないこと(スコープ外)

- attribution/whyBad/comparePv/RefutationView のロジック変更・削除(退避のみ)
- 悪手判定閾値・解析パイプライン(analyzeGame)の変更
- エンジン側の変更、評価値グラフ(T197)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npm test` 全件パス(既存テスト回帰なし。BlunderPanel関連テストの期待値は新構成に合わせて更新可、ただし退避セクションの動作テストは維持)。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLの棋譜解析で実際に対局→解析→悪手を開き、2盤面比較が既定表示され、詳細分析が折りたたみから開けることを実機確認(確認記録を作業ログへ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-23 implementer: 実装完了。
  - 変更ファイル: `app/src/analysis/BlunderPanel.tsx`(T195の`TwoPlyCompare`/`computeTwoPlyCompare`を再利用する「2手先比較」セクションを最上部に追加、探索は`ANALYZE_LIMIT`で`requestAnalyzeAll`を2系列×最大2回=最大4回呼び出し、`classifyThresholds`宣言を先頭寄りに移動。比較PV・評価内訳waterfall・反証層・whyBad文章は`<details class="blunder-panel__advanced">`(既定`open`なし)へロジック無変更のまま退避。フリー分岐探索・練習送りは既存位置のまま維持)/`app/src/analysis/BlunderPanel.css`(`.blunder-panel__advanced`関連スタイル追加)/`app/src/analysis/BlunderPanel.test.tsx`(新規、BlunderPanel単体のコンポーネントテストがこれまで存在しなかったため新設。既定表示に2手先比較+損失1行が出ること、詳細分析detailsが既定で閉じていること、開くと比較PV/評価内訳/反証層/なぜ悪いかが描画されること、フリー分岐探索・練習送りが常に見えることを検証)。
  - 設計判断(仕様が「最上部」「残す」「退避」の3バケットのみを明示し「着手前の局面」セクションの扱いを明記していなかったため、実装者判断): 2手先比較をヘッダー直後の文字どおりの最上部に置き、「着手前の局面」(モチーフ・盤面オーバーレイ)セクションはその次にそのまま残置(退避リストに名指しされていないため)。ハイライト連動(評価内訳/whyBadホバー→着手前局面ボードへの反映)は`<details>`の開閉状態と無関係にstateで動くため機能に影響なし。
  - 受け入れ基準の実行結果:
    - `cd app && npm test` → 100 files / 847 tests 全件パス(新規BlunderPanel.test.tsx 2件含む)。
    - `npm run build` → 成功(wasmビルド含め正常終了)。
    - コミット `f47632a`(パス明示add: `BlunderPanel.css` `BlunderPanel.tsx` `BlunderPanel.test.tsx`のみ。並行作業中のT197由来の未追跡ファイル`app/src/components/moveEvalTimeline.ts`等は対象外のまま放置)。`git push origin main`成功(4a88159..f47632a)。
    - GitHub Actions: `Deploy to GitHub Pages`(run 29958288015)が`build`→`deploy`とも成功。
    - 実機確認(`https://giwarb.github.io/othello-trainer/`、Playwright系ブラウザツール): 棋譜解析モードで盤面手入力(f5 d6 c3 d3 c4 f4 e3 b4 e6 f3、10手)→解析実行→ムーブリストの8手目(白 b4、??悪手)をクリック→BlunderPanelが開き、最上部に「2手先比較」(実際に打った手/最善手の2盤面+主文+「この手は最善手より約11石損しています。」)が既定表示されることを確認。「詳細分析(上級者向け)」の`<summary>`をクリックすると比較PV・評価内訳・反証層・なぜ悪いかが展開表示されることを確認(削除されていない)。フリー分岐探索・練習送りは折りたたみの外に常時表示。コンソールエラー無し。
    - `git status --short`: タスク由来の差分・未追跡ファイルは残っていない(上記コミット済み。残る差分はすべてT197由来で対象外)。
  - 仕様が曖昧だった点: 上記「着手前の局面」セクションの配置(退避対象か残置か)。低リスクな表示順の判断のため作業は継続し、この報告で明記した。問題があればオーケストレーターの指示で再配置可能。

- 2026-07-23 verifier: 対象コミット `f47632a` を独立検証。判定: **合格**。
  - `git show f47632a --stat` → `app/src/analysis/{BlunderPanel.css,BlunderPanel.test.tsx,BlunderPanel.tsx}` の3ファイルのみ(tasks/混入なし)。
  - `cd app && npx vitest run src/analysis` → 14 files / 151 tests 全件パス。
  - `cd app && npx vitest run`(全体) → 初回実行時、T197ワーカーが並行して`app/src/app.tsx`等を作業中(未コミット)で`app.playmode.evalDisplay.test.tsx`が2件失敗(コメントに`T197`明記・app.tsx差分あり・analysis配下は無変更を確認しT197起因と判定、T196由来ではないと切り分け)。その後T197がコミット(`871aecd`)されたのを確認し再実行 → 102 files / 861 tests 全件パス(退行なし)。`BlunderPanel.test.tsx`単体も2/2パス。
  - コード読解:(a) `git show f47632a`のdiffで比較PV・評価内訳waterfall・反証層・whyBadの各`<section>`は`<details class="blunder-panel__advanced">`(既定open属性なし=閉)へ包まれるのみで、内部JSX・ロジックは無変更(移動のみ)と確認。(b) `TwoPlyCompare`は`requestAnalyzeAllForCompare`経由で`engine.requestAnalyzeAll(board, side, ANALYZE_LIMIT)`(`./analyzeGame.ts`からimport)を使用、`useEffect`の空depsで1回だけ計算し`useState`にキャッシュ(パネル内再計算なし)を確認。(c) `フリー分岐探索`・`練習送り`の各`<section>`は`</details>`(BlunderPanel.tsx:774)より後(776行目・822行目)にあり折りたたみ外と確認。
  - GitHub Actions: `Deploy to GitHub Pages`(run 29958288015)・`Rust Tests`(run 29958288126)ともコミット`f47632a`で成功済みを`gh run list`で確認。
  - Pages実機確認(playwrightで`https://giwarb.github.io/othello-trainer/`に接続、npxキャッシュのplaywrightパッケージを直接requireして操作): 棋譜解析で報告と同一棋譜(`f5 d6 c3 d3 c4 f4 e3 b4 e6 f3`)をテキスト入力→解析開始→ムーブリストの8手目行の「?? 悪手」ボタンをクリックしBlunderPanelを開き、最上部「2手先比較」が既定表示で「この手は最善手より約11石損しています。」を含む説明文とともに表示されること、`document.querySelector('details.blunder-panel__advanced').open === false`(既定閉)であること、`summary`クリックで`open === true`に変わり比較PV/評価内訳/反証層/なぜ悪いかの各セクション本文が展開表示されること、「フリー分岐探索」「練習送り」が折りたたみの外(展開前から本文に出現)にあることをスクリーンショット・DOM評価の両方で確認。コンソールエラーなし。
  - `git status --short`(検証終了時点): クリーン(T197は検証中に`871aecd`としてコミット済みで、T196由来・出所不明の残骸なし)。
  - 結論: 受け入れ基準4項目すべて満たす。設計判断(「着手前の局面」残置)は仕様の3バケットに明記のない部分の合理的解釈であり問題視しない。

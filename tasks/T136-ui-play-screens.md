---
id: T136
title: UX強化2: プレイ画面の盤中心レイアウト(プレイヤーバッジ・盤ノイズ削減・対局中コントロール整理)
status: done # verifier/代替レビュー両合格+オーケストレーターのビジュアルQA合格(2026-07-18)
assignee: implementer(Sonnet)
attempts: 0
---

# T136: プレイ画面の主役化

## 背景(オーケストレーターの実機UXレビュー 2026-07-18)

プレイ中の画面が「見出しテキスト→チェックボックス→盤→ボタン」の素朴な縦積みで、対局の状況が読み取りにくい:

1. **手番・スコア表示が貧弱**: 「あなたは黒番です。手番: 黒」「黒: 2 / 白: 2」という素テキストのみ。どちらが自分か・今どちらの番か・石数差が一目で分からない。
2. **対局モードは開始オプションが対局中も常設**(5つの開始ボタン+CPU強さ+チェックボックス+悪手判定設定パネルが盤の上下に露出)。対局中の主役は盤なのに、セットアップUIが同居している。
3. **盤面のノイズ**: 座標(1-8/a-h)が各セル内左上に白字で埋め込まれ石と重なって見づらい。合法手ヒントが小さい薄緑ドットで視認性が低い。
4. 詰めオセロのお題「白番、最善で+44(この局面、勝てるか?)」が盤から離れた上部に浮いており、プレイ中の文脈(残り空きマス・難易度)とまとまっていない。

## 要件

1. **プレイヤーバッジ**(対局・中盤練習・詰めオセロ共通コンポーネント): 盤の直上に「黒●(あなた) 石数」「白○(CPU/相手) 石数」の2バッジを置き、**手番側をアクセント色でハイライト**。思考中はバッジ内にスピナー/「考え中…」を出す(既存の思考中表示を統合)。
2. **対局モードの状態分離**: 対局開始前=セットアップカード(開始ボタン群・CPU強さ・オプション)を表示、**対局開始後=盤+バッジ+最小コントロール(投了/新規対局)のみ**にし、悪手判定設定・表示オプションは折りたたみ(「設定」開閉)へ。終局後は結果+「この対局を振り返る」(T132)を目立たせる。
3. **盤の描画改善**(Canvas、`app/src/components/Board.tsx`): 座標ラベルをセル内埋め込みから**盤の外周(上端a-h・左端1-8の細い帯)**へ移動。合法手ヒントドットを大きく(セル幅の約1/4)・コントラスト改善。最後に打たれた手のマーカー(小さい赤点等)が無ければ追加、あれば視認性確認のみ。石の描画に軽い縁取り/影を付けて立体感(過度な装飾は不要)。
4. **詰めオセロのお題カード化**: 「難易度4・空き11マス・白番」「目標: 最善で+44」を盤直上の1カードにまとめる。「やめる」に加えて「次の問題」導線を結果画面に(あれば維持・目立たせる)。
5. 縦375px・横置き520px以下(T133の2カラム)の両方で成立すること。描画変更はFFO/エンジンに一切影響しない(見た目のみ)。
6. **T133申し送りの解消**: 横置き2カラムで内容過多時に「右カラムのみ縦スクロール」(盤は固定)を実現する(現状はコンテナ全体スクロールで盤ごと流れる。tasks/review/T133-landscape-claude-review.md 中(1))。

## 追加要件(T135代替レビュー中4件+軽微、tasks/review/T135-ui-shell-claude-review.md)

1. グローバル`button{min-height:44px}`の打ち消し漏れ4系統を修正(各`min-height:0`等1行): `.verbalize-tags__info`(「?」丸ボタンが縦長楕円に崩れ)・`.motif-badge--button`・`.attribution-waterfall__label--button`・`.blunder-panel__branch-node`。あわせてレビュー軽微指摘の「フィルタチップ・用語集ピルの44px化が意図した見た目か」をスクショで確認し、不自然なら同様に調整。
2. 横置き`max-height:100dvh`がヘッダ高(40px)を未考慮 → `calc(100dvh - ヘッダ高)`化を検討・適用。
3. 未使用の`.btn-secondary`クラスは削除するか実使用に置き換える(デッドコード解消)。

## やらないこと(スコープ外)

- アニメーションの変更(T134で対応済みのはず)/評価バー・解析ロジックの変更/エンジン変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] プレイヤーバッジのコンポーネントテスト(手番ハイライト切替・石数表示・思考中表示)
- [ ] 対局モードの状態分離テスト(開始前=セットアップ表示/開始後=非表示・折りたたみ動作/終局後=結果表示)
- [ ] Board描画変更の既存テスト全パス(描画API実引数のテストがある場合は追従。T066教訓: 視覚効果は描画実引数で直接検証)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] ビフォー/アフターのスクショ(375x812と844x390、対局中・中盤練習中・詰め中の3画面)を撮り作業ログに記録
- [ ] mainへpush→Actions成功→Pages実機で対局(ブックon)を数手・詰め1問・中盤1問プレイして確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T136)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-18 implementer(Sonnet)実装・検証完了

**実装内容**:
1. `app/src/components/PlayerBadge.tsx`/`.css`/`.test.tsx` を新設。対局・中盤練習・詰めオセロ共通の手番ハイライト+石数+思考中表示バッジ。
2. `app/src/app.tsx`(対局モード): `started` stateで開始前(セットアップカード)/対局中/終局後を分離。対局中は盤+バッジ+最小コントロール(投了/新規対局)のみ表示。投了は`resignGame`で`GameState.phase='over'`・`result=opposite(humanSide)`を直接設定(gameLoop.tsのAPI追加なし、エンジン非依存)。悪手判定設定・表示オプションは`<details class="settings play-settings-panel">`(既定で閉じる)へ移動。旧`.status`/`.score`のテキストは`.sr-only`化して維持(既存テスト・スクリーンリーダー互換)。
3. `app/src/components/Board.tsx`/`.css`: 座標ラベルをcanvas内描画から盤外周のDOM帯(`.othello-board-frame`、2x2 grid)へ移動。合法手ヒントドット拡大(radius cell*0.12→0.22)+縁取り、石に放射グラデーション+縁取りで立体感、最終手マーカーをわずかに拡大+中心塗り追加。オーバーレイ(`MoveEvalOverlay.css`/`analysis/BoardOverlay.css`)は新設の`--board-label-band`(index.css)で`inset`をオフセットし、canvasの実ピクセル範囲との整合を維持。
4. `app/src/midgame/PracticeMode.tsx`/`.css`・`app/src/tsume/PlayMode.tsx`/`.css`: PlayerBadge統合。詰めオセロは「○番、最善で+N(勝てるか?)」+「難易度/空きマス」を`.tsume-prompt-card`にまとめてお題カード化。
5. 横置き2カラムを「右カラムのみスクロール」構造に変更(`.play-board-area__side`/`.midgame-practice__side`/`.tsume-practice__side`という単一div化、board-containerとは別グリッドセル)。dvhの`max-height`/`height`をヘッダ高40px差し引きの`calc(100dvh - 40px)`に統一。
6. T135代替レビュー指摘: `.verbalize-tags__info`/`.motif-badge--button`/`.attribution-waterfall__label--button`/`.blunder-panel__branch-node`に`min-height: 0`を追加。未使用`.btn-secondary`を削除。フィルタチップ(`.tsume-stage-select__filter-button`等)は実機測定(60.75x44px、通常のピル形状)を確認し「意図した見た目」と判断、変更なし。

**実機検証で発見・修正したバグ2件**(ビジュアルスクショが撮れなかったため、`javascript_tool`によるDOM/computedStyle実測で発見):
- **CSS Gridブロウアウト**: `.othello-board-frame`の`grid-template-columns: var(--board-label-band) 1fr`が、canvas要素(replaced element、width/height属性を実内容サイズとして持つ)の存在により列を縮小できず、横置きでコンテナ幅が縮んでもcanvasが縮まない不具合。`minmax(0, 1fr)`に修正(`Board.css`)。
- **align-items継承漏れ**: `.midgame-practice`/`.tsume-practice`の縦持ち用ベーススタイル`align-items: center`(flex)が横置きのgridコンテキストにも適用され、右カラム(`__side`)が2行目トラックいっぱいにstretchせず中央の短い箱になる不具合。横置きmedia query内で`align-items: stretch`を明示指定して修正。

**スクショについて(制約)**: この環境のBrowser paneでは`computer{action:"screenshot"}`/`zoom`が一貫してタイムアウトし(タブ新規作成・別ポート・別URLいずれでも再現、コンソールエラーなし、`get_page_text`/DOM操作は正常)、画像スクショを保存できなかった。代替として`javascript_tool`による`getBoundingClientRect()`/`getComputedStyle()`実測で、対局・中盤練習・詰めオセロの375x812(縦)・844x390(横)双方の主要screen(セットアップ前後・対局中・終局後・お題カード・landscape 2カラム)を検証し、上記2件のレイアウトバグを実際に検出・修正した。オーケストレーターの視覚QA時にBrowser paneのスクショが問題なく取得できるようであれば、そちらを正としてほしい。

**受け入れ基準の実行結果**:
- プレイヤーバッジのコンポーネントテスト: `app/src/components/PlayerBadge.test.tsx`(5件)全パス。
- 対局モードの状態分離テスト: `app/src/app.playmode.stateSeparation.test.tsx`(3件、開始前セットアップ表示/開始後非表示・設定折りたたみ既定閉/投了→終局演出→新規対局でセットアップ復帰)全パス。
- Board描画変更の既存テスト: Board.tsx単体の描画テストは元々無し(他テストは全て`vi.mock('./components/Board.tsx', ...)`でスタブ化されており非依存)。既存テストのうち`app.playmode.test.tsx`1件・`app.playmode.animationSequencing.test.tsx`2件が「開始ボタンを押さず直接盤操作」の前提だったため、T136の状態分離(要件2)に合わせて「黒番で開始」クリックを追加(挙動自体は変えず、新UIフローに追従)。
- `npx vitest run`: 89ファイル731件 全パス(実行: `cd app && npx vitest run`)。
- `npx tsc --noEmit -p tsconfig.app.json`: エラーなし。
- スクショ: 上記「制約」参照(画像保存はできず、JS実測ログを本作業ログに記載)。
- mainへpush→Actions: コミット`d532ae3`をpush。`gh run watch`で以下2ワークフロー両方`success`を確認:
  - Rust Tests (29636199033): 2m23s, success
  - Deploy to GitHub Pages (29636199048): build 51s + deploy 8s, success
  - Pages実機確認(`https://giwarb.github.io/othello-trainer/`、`javascript_tool`でクリック操作): 対局モード(定石ブックON既定、黒番で開始→d3相当クリック→CPU書籍応手→中盤探索応手まで確認、EvalBadge「+8 中盤(探索)」表示)/詰めオセロ(難易度1開始→お題カード表示確認→最善手を連打→「正解!」結果画面到達)/中盤練習(開始→最善手クリック→石数更新・相手応手確認)の3画面すべて実際に操作して動作確認済み。
- コミット: `git add`でapp/配下22ファイルのみ明示指定、`tasks/`は含めず。コミットハッシュ `d532ae3`。
- `git status --short`: コミット後クリーン(タスク由来の差分・未追跡なし)。

**判断に迷った点(オーケストレーター確認推奨)**:
- 「投了」は新規実装(`gameLoop.ts`のAPI変更なし、`app.tsx`側で`GameState`を直接書き換えるだけ)。要求仕様には「投了」という語のみで挙動の詳細指定が無かったため、「即座に相手(CPU)の勝ちとして終局」という最もシンプルな解釈で実装した。2人対戦モード(`vsHuman`)では「あなた」という単一視点が無いため投了ボタン自体を出していない。
- 中盤練習・詰めオセロの「あなたは黒番です。手番:黒(...)」テキストはバッジに統合し、素テキスト自体は削除した(対局モードと異なりテストが依存していなかったため`.sr-only`化ではなく削除。判定中/相手考慮中の一時的な状態表示は残している)。アクセシビリティ上の代替テキストが対局モードより弱い可能性があり、気になる場合は後続タスクで`.sr-only`化を検討されたい。

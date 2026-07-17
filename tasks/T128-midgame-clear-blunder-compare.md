---
id: T128
title: 中盤練習: 1手先の盤面対比による「明確な悪手」判定と平易な言語化
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T128: 1手先対比の明確悪手判定+平易な言語化

## 目的(ユーザー指示 2026-07-18 朝)

中盤練習の学習価値の核心は「自分が打った直後(相手番)の形が、自分にとって良い形かを言語化できること」。現状は (a)悪手側の1手先しかタグ化せず最善手側との対比がない、(b)悪手判定が評価値差のみで、言語化できない微差でも不合格になる、(c)表示に専門用語が多い。これを次の方針で作り替える:

1. **悪手を打った後の盤面と、最善手を打った後の盤面(どちらも相手番)を並べて表示**する。
2. **見た目上明らかな悪化パターンが検出できたときだけ言語化**する(相手の着手可能数の差、X打ちをさせられる、など。既存モチーフ検出とリンク)。
3. **深読みしないと説明できない差のときは、悪手と判定しない(合格扱いにする)**(ユーザー裁定: 「最善手と悪手の差が言語化できないこともある。その時は悪手と判定しなくてもよい」)。
4. 専門用語を平易な日本語に置き換える(用語集ポップアップは残してよい)。

## 前提知識(調査済みの現状、探索不要)

- 中盤練習: `app/src/midgame/PracticeMode.tsx`。悪手判定は `handlePlayerMove`(759-801行付近)→`judgeMidgameMove`。不合格時 `handleModeFailure`(680-742行付近)が実際の手PVと最善手PVを `requestAnalyze`(depth:16, timeMs:1000, exactFromEmpties:24)で取得し、`loadFailExplanation`(610-666行付近)が非同期で説明を構築。
- 特徴量: `requestFeatureSet`(着手前局面+着手 → **着手直後・相手番の局面**の12特徴量。engine/src/explain.rs::compute_features、Workerコマンド実装済み)。**最善手側にも同じ呼び出しをすれば対比が取れる**(エンジン変更は不要のはず)。
- モチーフ: `app/src/analysis/motifs.ts`(15種実装済み、盤面ハイライトは `BoardOverlay.tsx`+`motifHighlightSquares`)。
- 既存の失敗画面(1163-1296行付近)には「なぜ悪いか」(whyBad.ts)・モチーフタグ・評価内訳waterfall(attribution.ts、PV末端比較)・回収点(refutation.ts)がある。**waterfallと回収点は本番評価(パターン評価v3)ではなく実質未使用の旧3項ヒューリスティック(engine/src/eval.rs)で計算されており、数値の信頼性に構造的問題がある(T127調査で確定)。**
- ステージ記録: 判定設定ごとに別記録+★実績(T119、`app/src/midgame/stageProgress.ts`)。stale-session防止の`sessionGenerationRef`(T119)と「localStorage書き込みはawaitより前に同期で」(T117)の教訓に従うこと。

## 要件

### 1. 対比特徴の計算と「明確な悪化パターン」検出モジュール(新規 `app/src/midgame/clearBlunder.ts` 等)

入力: 着手前局面、実際の手、最善手(judgeが最善手を知っている前提。無ければ`requestAnalyze`結果のbestMove)。`requestFeatureSet`を両方の手について呼び、1手先(相手番)の特徴量セット2つを得る。以下の**明確パターン検出器**を実装(それぞれ独立の関数+閾値は名前付き定数):

| パターンID | 判定(afterPlayed vs afterBest) | 平易な言語化テンプレ例 |
|---|---|---|
| opponent-mobility | 相手の合法手数の差 ≥ 3 | 「この手の後、相手は{n}か所に打てます。最善手なら{m}か所でした」 |
| corner-gift | afterPlayedでは相手の合法手に隅が含まれ、afterBestでは含まれない | 「この手だと相手に隅({座標})を取られます。最善手なら取られませんでした」 |
| x-c-danger | 実際の手が空き隅に隣接するX/C打ちで、最善手はそうでない(既存モチーフ`motifs.ts`のX/C検出を再利用) | 「隅がまだ空いているのに、その斜め隣(X)に打つと隅を取られやすくなります」 |
| wall-frontier | フロンティア石(外側に露出した自石)の増加差 ≥ 4 | 「この手は自分の石を外側にさらします(壁)。相手から攻めやすい形です」 |
| stable-loss | 確定石(もうひっくり返らない石)の差 ≥ 2 | 「最善手なら確定石(絶対に取られない石)が{k}個増えていました」 |

- 検出器は既存の12特徴量・15モチーフの範囲で実装する(新たな深読み・エンジン変更をしない)。閾値は上表を初期値とし、定数にコメントで根拠を書く。
- 1件も検出されなければ `null`(=明確な説明不能)を返す。複数検出時は影響の大きい順に最大2件を返す。

### 2. 悪手判定のゲート(明確なときだけ不合格)

- `judgeMidgameMove`の評価値ベース判定で不合格になった場合でも、**上記検出器が1件も明確パターンを返さなければ合格扱い**にする(ステージ進行・★記録も合格として扱う)。この分岐は中盤練習のみ(棋譜解析BlunderPanel・詰めオセロは変更しない)。
- 実装上の注意: 現在は判定→失敗画面→説明を非同期構築、の順。ゲートのため**判定確定の前に**両手の`requestFeatureSet`を待つ必要がある(静的特徴で軽量、体感遅延はほぼ無いはず)。`sessionGenerationRef`世代ガードを通し、記録書き込みは同期で行う(T117/T119教訓)。
- 評価値判定が合格の場合は従来どおり(検出器は走らせない)。

### 3. 失敗画面の作り替え(中盤練習のみ)

- **盤面2枚の横並び表示**: 「あなたの手のあと」「最善手のあと」(どちらも相手番の盤面)。モバイルでは縦積み(レスポンシブ必須)。各盤面に該当パターンのハイライト(相手の合法手マス・問題のX/Cマス・隅など)を重ねる。
- その下に検出パターンの**平易な言語化文(最大2件)**を表示。専門用語は使わない(モビリティ→「打てる場所の数」、フロンティア→「外側にさらした石」等)。用語集ポップアップへのリンクは残してよい。
- **旧waterfall(評価内訳)と回収点表示は中盤練習の失敗画面から撤去**する(根拠の評価関数が本番と別物のため誤解を生む。モチーフタグ表示は言語化文と重複しない範囲で残してよい/整理してよい)。棋譜解析(BlunderPanel)側は本タスクでは触らない。
- 正解(合格)時の表示は本タスクでは変更しない。

### 4. 用語の平易化

- 新規表示文はすべて平易な日本語で書く。既存の中盤練習失敗画面に残す要素(モチーフタグ名等)のうち、カタカナ専門用語のラベルは平易な言い換えに更新してよい(用語集のキーとの対応は維持)。

## やらないこと(スコープ外)

- 評価内訳waterfallの本番評価(パターン評価)ベースへの刷新(将来タスク)
- 概念別弱点統計の復活・失敗タグの永続化(次タスク候補)
- 棋譜解析(BlunderPanel)・詰めオセロ・言語化モードの変更
- エンジン(Rust/WASM)の変更・再ビルド(既存Workerコマンドのみ使う)
- **教師コーパス生成関連(bench/edax-compare/・train/)には一切触れない(生成走行中)**

## 受け入れ基準

- [ ] 検出器5種それぞれに陽性・陰性のユニットテストがある(合成盤面)
- [ ] ゲートのテスト: 評価値では不合格だが明確パターンなし → 合格扱いになり、ステージ記録も合格として書かれる
- [ ] 失敗画面のコンポーネントテスト(jsdom): 盤面2枚+言語化文が描画される/明確パターン2件が上限
- [ ] `npm test` 全件パス(app配下)
- [ ] 変更をmainにpush、GitHub Actionsのデプロイ成功を確認し、Playwrightで本番Pages(https://giwarb.github.io/othello-trainer/)の中盤練習を操作して、(a)明確な悪手(例: 序盤ステージで意図的にX打ち)で盤面2枚対比+平易な言語化が表示されること、(b)コンソールエラーが無いことを確認(再現手順が確立できない場合は、その旨と代替確認(ローカルpreviewでの同確認)を作業ログに明記)
- [ ] モバイル幅(375px)で盤面2枚が縦積みになりレイアウト崩れがないこと(Playwrightのviewport切替で確認)
- [ ] コミットは変更対象ファイルのみパス明示(`app:`、`(T128)`)。`git add .`禁止、`tasks/`はコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-18 実装完了(implementer)

- **調査**: `PracticeMode.tsx`(旧`handleModeFailure`/`loadFailExplanation`)、`engine/src/explain.rs`(`FeatureSet`の各フィールド意味)、`analysis/motifs.ts`(`detectXUchi`/`detectCUchi`/`frontierSquares`等の既存検出器)、`analysis/whyBad.ts`(`analyzeWhyBad`/`computeStableSquares`)、`components/Board.tsx`、`analysis/BoardOverlay.tsx`を読み、既存資産の再利用範囲を確定。
- **実装1**: `app/src/midgame/clearBlunder.ts`を新規作成。5種の検出器(`detectOpponentMobility`/`detectCornerGift`/`detectXCDanger`/`detectWallFrontier`/`detectStableLoss`)を`motifs.ts`と同じ「入力から自分で派生値を計算する独立関数」方針で実装し、`detectClearBlunderPatterns`で統合(severity降順・最大2件)。深読み・エンジン呼び出しの追加は行わず、`legalMoves`/`applyMove`(1手先の局面生成のみ)と既存の`FeatureSet`/モチーフ検出器の範囲に限定。
- **実装2**: `app/src/midgame/clearBlunder.test.ts`を新規作成。各検出器の陽性・陰性、統合関数のnull/複数検出時のsort+2件上限を検証。局面フィクスチャはscratchpad同然の一時ファイル(`app/src/midgame/_scratch_proto*.ts`、`node --experimental-strip-types`で都度実行→削除)で事前に数値を実機確認してから組み込んだ(手計算のビット演算ミスを避けるため)。作業途中でオーケストレーターから「未追跡の一時ファイルが残っている」と指摘を受け、都度削除する運用に修正した(以後は生成→検証→即削除を1コマンドにまとめて対応)。
- **実装3**: `app/src/midgame/ClearBlunderCompare.tsx`を新規作成(「あなたの手のあと」「最善手のあと」盤面2枚+検出パターンの言語化文、`BoardOverlay`の`emphasizedSquares`でハイライト)。`PracticeMode.css`に対応レイアウト(横並び+375px相当でのメディアクエリ縦積み)を追加。
- **実装4**: `app/src/midgame/PracticeMode.tsx`を改修。
  - `handlePlayerMove`に要件2のゲートを追加: `judgeMidgameMove`が不合格でも、両手(実際の手・最善手)の`requestFeatureSet`を待って`detectClearBlunderPatterns`にかけ、`null`(明確パターン0件)なら`applyMoveAndContinue`(新設ヘルパー、正解時と共通化)で合格扱いにする。特徴量取得自体が失敗した場合は従来どおり評価値のみで不合格にフォールバック。
  - `handleModeFailure`に`clearBlunderPatterns`引数を追加し、`resultInfo`に格納。旧`loadFailExplanation`(特徴量取得→モチーフ検出→評価内訳waterfall→回収点の非同期読み込み)を全廃し、失敗画面から「なぜ悪いか」「モチーフ検出タグ」「評価内訳waterfall」「回収点」を撤去、`ClearBlunderCompare`に置き換えた(タスク仕様どおり、waterfall・回収点は本番評価と別物の旧3項ヒューリスティック由来のため)。
  - `sessionGenerationRef`世代ガードはゲートの`requestFeatureSet`待機後にも適用し、離脱後の古い結果確定を防止(T119教訓を踏襲)。
- **実装5**: `app/src/midgame/PracticeMode.clearBlunderGate.test.tsx`(ゲート統合テスト)・`app/src/midgame/ClearBlunderCompare.test.tsx`(失敗画面コンポーネントテスト)を新規作成。

### 受け入れ基準の実行結果

- [x] 検出器5種それぞれに陽性・陰性のユニットテスト → `clearBlunder.test.ts`(14件、全パス)
- [x] ゲートのテスト: 評価値では不合格だが明確パターンなし→合格扱い、ステージ記録も合格として扱う → `PracticeMode.clearBlunderGate.test.tsx`(1件、パス。`requestFeatureSet`が実際の手・最善手の両方で呼ばれたことをスパイで確認し、`.midgame-result--fail`に遷移しないこと・`localStorage`のステージ記録に`failCount`が書き込まれないことを確認)
- [x] 失敗画面のコンポーネントテスト(jsdom) → `ClearBlunderCompare.test.tsx`(2件、パス。盤面2枚+言語化文の描画、2件検出時に2件とも表示されることを確認。「2件が上限」自体は`clearBlunder.test.ts`側の統合関数テストで検証)
- [x] `npm test` 全件パス → `npx vitest run`: `Test Files 73 passed / Tests 613 passed`
- [x] mainへpush、GitHub Actionsデプロイ成功、本番Pagesで動作確認 → コミット`23253db`をpush、`gh run watch`でDeploy to GitHub Pages成功(`build`/`deploy`とも成功)を確認。Playwright的操作(Claude Browserツール)で `https://giwarb.github.io/othello-trainer/` の中盤練習(判定モード=標準、開始局面ソース=定石終端からランダム)を開始し、候補手評価オーバーレイからX打ちマス(g7、隅h8が空いた状態)を意図的にクリック→失敗画面に「あなたの手のあと」「最善手のあと」の盤面2枚+「隅がまだ空いているのに、その斜め隣(X)に打つと隅を取られやすくなります。」の平易な言語化文が表示されることを確認。旧モチーフタグ・評価内訳waterfall・回収点の文言が画面テキストに存在しないことも確認。コンソールエラー無し(`read_console_messages(onlyErrors:true)`が空)。
  - 補足: `computer{action:"screenshot"}`がこの環境で継続的にタイムアウトしたため、盤面クリックは`javascript_tool`でcanvasへ`MouseEvent`をディスパッチする代替手段で行った(挙動はBoard.tsxの`handleClick`がそのまま処理するため実クリックと等価)。取得できたスクリーンショット画像は無いが、`get_page_text`によるDOM内容確認で表示内容を直接確認済み。
- [x] モバイル幅(375px)で盤面2枚が縦積み、レイアウト崩れなし → 本番Pagesの上記失敗画面で`resize_window(375x812)`後、`javascript_tool`で`.clear-blunder-compare__board-col`のBoundingClientRectを取得し、2枚が同じ`left`/`width`(335px、縦に積み上がるレイアウト)で異なる`top`(横並びでなく縦積み)であること、`document.documentElement.scrollWidth === window.innerWidth === 375`(横スクロール発生なし)であることを確認。
- [x] コミットは変更対象ファイルのみパス明示、`git add .`不使用、`tasks/`はコミットしない → コミット`23253db`(`app: 中盤練習の悪手判定を1手先対比の明確悪化パターンに刷新(T128)`)。`git add app/src/midgame/PracticeMode.css app/src/midgame/PracticeMode.tsx app/src/midgame/ClearBlunderCompare.tsx app/src/midgame/ClearBlunderCompare.test.tsx app/src/midgame/PracticeMode.clearBlunderGate.test.tsx app/src/midgame/clearBlunder.ts app/src/midgame/clearBlunder.test.ts`で個別指定。
- [x] タスク完了時点で当該タスク由来の差分・未追跡が残っていない → `git status --short`確認済み(下記参照、`_scratch_proto*.ts`等の一時ファイルは全て削除済み)。

### 注意事項・申し送り

- **`npm run typecheck`は`pretypecheck`フックで`wasm:build`(`cargo build --release`相当)を走らせてしまうことに実装中盤で気付いた**(1回だけ実行してしまった。Rustソースは一切変更していないため出力は従来と同一のはずだが、教師コーパス生成中はRustのreleaseビルドを避ける方針に反する)。以後は`npx tsc --noEmit -p tsconfig.app.json`(フックを経由しない直接呼び出し)に切り替えて対応した。`npm test`/`npx vitest run`は`pretest`フックが無いため問題ない。**他タスクでも`npm run typecheck`/`npm run build`/`npm run dev`は教師コーパス生成中は避け、`npx tsc`等の直接呼び出しを使うよう申し送る。**
- 旧`.midgame-result__board`・`.midgame-highlight-overlay`(正解手マス強調)・`.midgame-result__explanation`・`.motif-badge--active`のCSSは未使用になったため`PracticeMode.css`から削除した。
- 棋譜解析(`BlunderPanel.tsx`)側は本タスクでは一切変更していない(旧waterfall・回収点表示・モチーフタグ表示はそのまま残っている、意図どおりスコープ外)。

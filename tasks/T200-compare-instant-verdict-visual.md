---
id: T200
title: 悪手比較の即時「悪手です」表示+ローディング+全体ビジュアル改善
status: review
assignee: implementer
attempts: 2
---

# T200: 悪手比較の即時「悪手です」表示+ローディング+全体ビジュアル改善

## 目的(ユーザーフィードバック 2026-07-23)

1. **即時フィードバックの体感改善**: 悪手を打ったとき、比較の計算(約2秒)が終わるまで画面に反応がなく「何が起きた?」となる。**悪手と判定した瞬間に「悪手です」を表示**し、その下に「解説を生成中…」というローディング表示を出す。計算が終わったら5盤面+説明に差し替える。
2. **見た目の全面改善**: 「変なセンタリングがある」「とにかく見た目をよくして」。5盤面比較のレイアウト・整列・視覚階層を磨き込む。

## 背景・コンテキスト

- 対象: `app/src/midgame/TwoPlyCompare.tsx` / `TwoPlyCompare.css`、`app/src/midgame/PracticeMode.tsx`(即時フィードバックの表示フロー)、`app/src/analysis/BlunderPanel.tsx`(棋譜解析側のローディングとレイアウト)。T199(1d50848)適用後のコードが前提。
- 現状の即時フィードバック(T195/T199): `handlePlayerMove`で悪手検出→`loadTwoPlyCompare`(requestAnalyzeAll×4、約2秒)→完了後に比較表示、の流れ。ローディング中の表示が無い/弱いため無反応に見える(実装を確認し、モーダル/パネル自体を即時に出す構造へ変える)。
- ユーザーのスクリーンショットで確認された見た目の問題: 上段の元局面盤面が中央からズレて見える(周辺列とのグリッド不整合)、パネル見出し・説明文・凡例の階層が弱い、全体がのっぺりして区切りが分かりにくい。

## 要件

1. **即時表示フロー(中盤練習)**: 悪手検出の同期タイミングで即座に比較パネル(モーダル)を表示する。その時点で出せる情報は出す:
   - 見出し「**悪手です**(最善より約L石損)」— L(損失)は検出時点で確定済みなので即表示。
   - 本文エリアは「解説を生成中…」+スピナー(既存のローディング表現があれば踏襲)。
   - 計算完了で5盤面+説明文に差し替え(レイアウトシフトを抑えるため、生成中のプレースホルダー高さを確保するなど配慮)。
   - 「続ける」ボタンは生成中でも押せてよい(押したら比較をスキップして続行)。
2. **棋譜解析側**: BlunderPanelの2手先比較のローディングも同様の「解説を生成中…」表現に統一(損失1行は即表示できるはず)。
3. **ビジュアル改善**(既存のアプリ全体のトーンから逸脱しない範囲で):
   - 5盤面のグリッド整列: 上段の元局面は**正確に中央**(または左右列と揃う位置)に。下段2列は等幅・等間隔で、列見出し(「実際に打った手」/「最善手」)を列単位で明確に(例: 列ヘッダをカード上部に固定し、実際=警告系/最善=成功系のアクセントカラーで区別)。
   - 各パネルをカード化(背景・角丸・影 or 枠線)して区切りを明確に。凡例・説明文の位置と余白を整理。
   - 見出し階層: 「悪手です」バナー(警告色) > 列見出し > 打てる場所(強調済み) > 盤面。
   - センタリング・余白の乱れを排除(狭幅・広幅の両方で確認)。
   - モバイル(≤400px)は縦積みのまま、カード化・階層は維持。
4. 既存機能(閾値発火・ドットマーカー・凡例・「続ける」・詳細分析折りたたみ)の挙動は不変。テストは表示フロー変更(即時表示→生成中→完成)に合わせて更新+「悪手検出直後にモーダルと『悪手です』が出る(計算完了前)」のテストを追加。

## やらないこと(スコープ外)

- 計算自体の高速化・エンジン変更(ローディングの見せ方のみ)
- 5盤面の構成・データ内容の変更
- 発火閾値・判定ロジックの変更(T199のまま)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npx vitest run` 全件パス。新規: 悪手検出直後(計算完了前)に「悪手です」+生成中表示が出るテスト。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 実機で: (a) 悪手を打った瞬間に「悪手です」+「解説を生成中…」が表示され、完了後に5盤面へ差し替わる (b) 元局面が中央に整列し、列がカード化されて区別できる (c) 棋譜解析側も同様 (d) モバイル幅で崩れなし。スクリーンショット相当の確認記録を作業ログへ。
- [ ] コミットは変更対象ファイルのみをパス明示で add。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

### redo #1(2026-07-23、代替レビューの重大指摘)

**重大(必須修正): 生成中に「続ける」を押した後、次の一手クリックが一時的に無反応になる(`analyzing`フラグの固着)。**

- 機構: `handlePlayerMove`は冒頭で`setAnalyzing(true)`し`finally`で解除するが、T200の並び替え後も**パターン検出の`await Promise.all(requestFeatureSet×2)`が同じtryブロック内に残っている**ため、`pendingCompare`即時表示→ユーザーが生成中に「続ける」→盤面に戻る、の後もこのawaitが解決するまで`analyzing=true`のまま。次の一手クリックは`if (... || analyzing) return`(冒頭ガード)で**黙って無視**される。悪手時に素早く「続ける」を押すという本タスクが推奨する操作そのもので再現する。「無反応の解消」というタスク目的と正反対の新しい無反応ウィンドウ。
- 推奨修正: `pendingCompare`の初回セット直後に`setAnalyzing(false)`して`handlePlayerMove`を抜け、パターン検出・比較計算は完全に切り離した非同期処理として走らせる(結果は既存どおり関数型更新+世代ガードで差し替え)。または`analyzing`単一フラグをやめ、一手固有のトークン/generationで再入防止する。どちらでも、**「生成中に『続ける』→即座に次の一手が打てる」ことを保証**すること。
- **再発防止テスト必須**: 生成中(遅延モック)に「続ける」をクリック→直後に次の一手を打つ→その手が正常に反映される(無視されない)、を検証するテストを追加(現行テストは「続けるボタンが存在する」までしか見ておらず本件を検知できない)。

**軽微(同時に対応してよい)**:
1. `PracticeMode.css`横置きメディアクエリ内の死んだセレクタ`.midgame-result:has(.two-ply-compare) .two-ply-compare__boards`(T198由来、存在しないクラス参照)を削除。
2. (任意)中間状態テストの実タイマー依存(branchDelayMs=400/60ms待ち)はflaky懸念があるため、余力があれば決定的な制御(resolveを手動保持する方式)へ。

修正後: テスト全件パス・build・push・Actions成功・Pages実機確認(**生成中に「続ける」→即次の一手、のシナリオを必ず実機で確認**)まで実施し、作業ログに追記して報告すること。

### redo #2(2026-07-23、再レビューの重大指摘)

**重大(必須修正): redo#1の切り離しにより、2手連続悪手で古い手の非同期結果が新しい手のpendingCompareに混入し、セッション状態が巻き戻される新レース。**

- 機構: `sessionGenerationRef`は**ステージ挑戦単位**(startStagePractice/goToStageSelectでのみ増加、「続ける」では増えない)なので、同一ステージ内のN手目とN+1手目は同じgeneration。redo#1でanalyzingロックが外れた結果、「N手目悪手→生成中に続ける→相手応手→N+1手目も悪手」の時点で、**N手目の未解決のdetectPatterns/loadTwoPlyCompareがN+1手目のpendingCompareに世代ガードを素通りしてマージされる**。特にdetectPatternsのクロージャが持つN手目用`nextSession`が注入され、N+1手目のパネルで「続ける」を押すと`setSession`で**N手目直後の状態に巻き戻る**(N+1手目の着手がmoveOutcomes・盤面から消え、★判定・localStorage永続化まで誤りうる)。redo#1以前はanalyzingロックがこの並行状態自体を防いでいた。
- 修正方針: `pendingCompare`ごとに**一意なトークン**(生成のたびにインクリメントするref値、またはpendingCompareオブジェクト参照そのもの)を持たせ、`loadTwoPlyCompare`/`detectPatternsForPendingCompare`の結果マージ条件を「`prev`が自分のトークンと一致する場合のみ」に変更する(generationガードはステージ離脱用として残してよい)。`recordPatternFailuresNow`(統計記録)は現在どおり各手のクロージャデータで無条件実行を維持(表示だけ破棄)。
- **再発防止テスト必須**: 「1手目悪手(検出を遅延モックで未解決に保つ)→生成中に続ける→相手応手→2手目も悪手→1手目の検出が解決→2手目のパネルに1手目のデータが混入しないこと(パネルの損失表示が2手目の値のまま/続けるで2手目の着手が保持され`3/3手`へ進む)」を検証するテストを追加。
- 参考: 現行の新規テストは2手目が悪手にならない盤面(neutralMoves)を使っておりこの経路を通らない。連続悪手を作るには決定局面のモック(decisionMoves相当)を2手分用意する。

修正後の完了条件はredo#1と同じ(テスト全件・build・push・Actions・Pages実機〔可能なら連続悪手シナリオも実機確認〕・作業ログ・報告)。

## 作業ログ(担当エージェントが追記)

### 2026-07-23 implementer

- **調査**: `TwoPlyCompare.tsx`/`.css`、`PracticeMode.tsx`/`.css`、`BlunderPanel.tsx`/`.css`、関連テストを確認。GitHub Pages本番(T199適用後)をPlaywrightで操作し、悪手を実際に打って現状の見た目("最善ではありません(最善より約X石損)"+プレーンテキストの"比較を計算しています…"、ローディング表示が弱い)と、5盤面レイアウトのDOM座標(`page.evaluate`でboundingRect計測)を確認した。数式上は各要素とも同じcenterXに揃っていたが、コンテナに`max-width`が無く`main`のフル幅(デスクトップで1216px)に対して260px幅のカラム群がぽつんと浮く配置になっており、これが「変なセンタリング」に見える主因と判断した。
- **実装(即時表示、要件1・2)**:
  - `TwoPlyCompare.tsx`に`TwoPlyCompareLoading`(スピナー+「解説を生成中…」)をexportし、`PracticeMode.tsx`・`BlunderPanel.tsx`の両方から共通利用する形に統一。
  - `PracticeMode.tsx`の`handlePlayerMove`: 悪手判定(`lossDiscs`/`isBest`)が確定した直後、明確な悪化パターン検出(`requestFeatureSet`×2)・2手先比較計算(`loadTwoPlyCompare`)の完了を待たずに`setPendingCompare`するよう並び替えた(`patterns`/`compare`とも`null`から開始し、それぞれ完了時に関数型更新で差し替え)。バナー文言を仕様どおり「悪手です(最善より約L石損)」に変更。ローディング中も「続ける」ボタン(`handleContinueAfterCompare`呼び出し)を表示し、生成中でも押せるようにした。
  - `BlunderPanel.tsx`: 「2手先比較」セクションで`moveAnalysis.lossDiscs`から即時に損失1行(`formatTwoPlyCompareLossMessage`)を表示し、`TwoPlyCompareLoading`を差し込んだ。
- **実装(ビジュアル改善、要件3)**:
  - `TwoPlyCompare.css`: ルート`.two-ply-compare`に`max-width: var(--board-size-lg)`(640px)+`margin:0 auto`を追加してコンテナ幅を適正化。5枚全ての`.two-ply-compare__board-col`をカード化(背景・枠線・角丸・影)。列見出し(`.two-ply-compare__column-heading`、TSX側で追加)を「実際に打った手」=警告色チップ・「最善手」=成功色チップで色分け(`color-mix()`でライト/ダーク両対応)。ローディング用スピナー(`.two-ply-compare__spinner`、`PlayerBadge.css`と同じborder方式)を追加。モバイル(≤400px)・横置きの既存メディアクエリにもカード padding調整を追加。
  - `PracticeMode.css`: `.midgame-practice__blunder-heading`をバナー風(警告色チップ+太字+大きめ文字)に強化。
- **テスト**: `PracticeMode.flow.test.tsx`に「悪手検出直後(比較計算の完了前)に『悪手です』バナーと生成中表示が出て、完了後に5盤面へ差し替わる」テストを追加(`branchDelayMs`スイッチで2手先比較用`requestAnalyzeAll`だけを遅延させ、判定用の初回呼び出しは即時のままにすることで中間状態を再現)。`BlunderPanel.test.tsx`にも同様のテスト(`makeDelayedFakeEngine`)を追加。
- **検証コマンド**:
  - `cd app && npx tsc -b` → エラーなし。
  - `cd app && npx vitest run` → 103ファイル / 873件 全件パス(新規2件含む)。
  - `cd app && npm run build` → 成功(wasm再ビルド込み)。
- **実機確認(3状態×デスクトップ/モバイル)**: `npm run preview`のローカルビルドとPlaywright(chromium、`node`スクリプトをscratchpadに作成)で、(a)中盤練習: 悪手を打った瞬間に「悪手です」バナー+「解説を生成中…」が出て(`.two-ply-compare`未描画を確認)、数秒後に5盤面へ差し替わる (b)元局面パネルが列カード群の中央に整列し、各パネルがカード化・列見出しで色分けされている (c)棋譜解析(BlunderPanel、`盤面で並べる`タブで実局面を入力→解析→悪手クリック)でも同じローディング表現(損失1行+スピナー)が即時に出て5盤面に差し替わる (d)モバイル幅(390px)で崩れ・横スクロールなし、をそれぞれスクリーンショットで確認(スクリーンショットはscratchpadに保存、リポジトリには含めない)。「続ける」を生成中に押すと比較をスキップしてただちに次の手番へ進むことも確認。
  - コミット後、`git push origin main` → GitHub Actions「Deploy to GitHub Pages」成功(`gh run watch`で確認、run 29973696413)を確認した上で、本番URL(`https://giwarb.github.io/othello-trainer/`)に対して同じPlaywright検証(中盤練習のローディング→5盤面差し替え、デスクトップ/モバイル、「続ける」の生成中クリック)を再実行し、全て期待どおりであることを確認した。
- **コミット**: `a723dec`(`app: 悪手比較の即時表示+ローディング+見た目全面改善(T200)`)。変更対象8ファイルのみをパス指定でadd。
- **仕様どおりにできなかった点・判断に迷った点**: なし。ただし気づいた点として、`PracticeMode.css`の横置き(landscape、`orientation:landscape and max-height:520px`)メディアクエリ内に`.midgame-result:has(.two-ply-compare) .two-ply-compare__boards`という、T198で構造が`.two-ply-compare__original`/`.two-ply-compare__columns`に変わって以降マッチしなくなっている(存在しないクラス名を参照した)死んだセレクタが残っていた。本タスクのスコープ外(構成変更ではなく、T198由来の既存の取りこぼし)のため修正していない。スマホ横置きの結果画面レイアウトに影響しうるため、別タスクでの確認・修正を推奨する。

### 2026-07-23 implementer(redo #1対応)

- **原因確認**: レビュー指摘どおり、`handlePlayerMove`の悪手分岐で`setPendingCompare`直後に`return`しておらず、同じtryブロック内に明確な悪化パターン検出(`await Promise.all(requestFeatureSet×2)`)が残っていた。この結果、悪手検出→即時パネル表示は達成できていたが、`analyzing`(冒頭ガードで次の一手クリックを弾く唯一の条件)がこのawaitの解決(パターン検出が終わるまで)固着し、生成中に「続ける」を押して盤面へ戻っても次の一手が黙って無視される新たな無反応ウィンドウが生じていた。
- **修正**: `PracticeMode.tsx`に`detectPatternsForPendingCompare`(新規、`loadTwoPlyCompare`の直後に定義)を追加し、パターン検出ロジック(検出条件・`requestFeatureSet`×2・`detectClearBlunderPatterns`・`recordPatternFailuresNow`・世代ガード)を丸ごと移設。悪手分岐では`setPendingCompare`(初回)→`loadTwoPlyCompare`(`void`起動)→`detectPatternsForPendingCompare`(`void`起動)→即座に`return`という構成に変更し、`handlePlayerMove`自体の`finally`が(パターン検出・比較計算の完了を待たず)ただちに走って`analyzing`を解除するようにした。結果反映は既存どおり`setPendingCompare`の関数型更新(世代ガード付き)で行う。非悪手パス(`isBlunder`が偽)のロジックは変更していない(元のまま`await`して`setSession`する)。
- **修正の効果を手動で実証**: 一時的に`void detectPatternsForPendingCompare(...)`+`return`を`await detectPatternsForPendingCompare(...)`(旧・バグの構造)に書き換え、新規追加した再発防止テストがその状態で実際に失敗する(`expected '1/3手' to contain '2/3手'`)ことを確認したうえで、元の修正済みコードに復元(`diff`でバイト単位一致を確認)した。
- **再発防止テスト追加**(`PracticeMode.flow.test.tsx`): 新たに`featureDelayMs`スイッチ(`requestFeatureSet`応答を遅延、既定0)を導入。テスト「T200 redo#1(重大指摘の再発防止): 生成中に『続ける』を押した直後でも、次の一手がanalyzingフラグの固着で無視されない」を追加し、`featureDelayMs=1500`の状態で悪手→生成中に「続ける」→相手の自動応手を待つ→ただちに次の一手→「2/3手」に反映されることを確認する(パターン検出のPromiseがまだ未解決の間に検証している)。
- **軽微指摘への対応**:
  1. `PracticeMode.css`の死んだセレクタ`.midgame-result:has(.two-ply-compare) .two-ply-compare__boards`を削除。周辺コメントも実態に合わせて更新(存在しないクラス名への言及を除去)。
  2. 既存の中間状態テスト(`branchDelayMs`方式)の決定的制御化は見送った(任意項目、今回は重大指摘の確実な解消と再発防止テストを優先。実タイマー方式自体は今回の全テスト実行(3回、後述)で安定してパスしており、直ちに手を入れる必要性は低いと判断)。
- **検証コマンド**:
  - `cd app && npx tsc -b` → エラーなし(テスト内`FeatureSetResponseMessage`の型不整合を1件修正して解消)。
  - `cd app && npx vitest run` → 103ファイル / 874件 全件パス(新規1件含む、既存の5件は変更なし)。
  - `cd app && npm run build` → 成功。
- **コミット**: `6a792e2`(`app: T200 redo#1対応 — 生成中「続ける」後のanalyzing固着を解消(T200)`)。変更対象3ファイル(`PracticeMode.tsx`/`.css`/`.flow.test.tsx`)のみパス指定でadd。
- **push・Actions**: `git push origin main` → GitHub Actions「Deploy to GitHub Pages」成功(`gh run watch`、run 29974703215)。
- **Pages実機確認(必須シナリオ)**: 本番URLに対してPlaywright(chromium)で、(1)悪手を打つ→生成中(比較未描画)のうちに「続ける」を押す→相手の自動応手を待つ→ただちに次の一手を打つ→「2/3手」に反映されることを確認(スクリーンショット`pages-redo1-after-second-move.png`、2手目がたまたま別の悪手だったため新たな「悪手です」パネルが正常に開いていることも確認できた=`analyzing`が固着せずhandlePlayerMoveが正常に再入できている証跡)。あわせて前回確認済みの3状態(即時バナー→生成中→5盤面差し替え)・デスクトップ/モバイル・BlunderPanel側も崩れていないことを再確認した。
- **仕様どおりにできなかった点・判断に迷った点**: なし。

### 2026-07-23 implementer(redo #2対応)

- **原因確認**: レビュー指摘どおり、`sessionGenerationRef`はステージ挑戦単位(`startStagePractice`/`goToStageSelect`でのみ増加)でしか変わらないため、同一ステージ内で連続して悪手を打つとN手目・N+1手目の`pendingCompare`が同じ`generation`を共有する。redo#1で`detectPatternsForPendingCompare`/`loadTwoPlyCompare`を`handlePlayerMove`から切り離した結果、「N手目悪手→生成中に続ける→相手応手→N+1手目も悪手」の状況でN手目の未解決の非同期結果が、N+1手目の`pendingCompare`表示中に解決すると、`generation`一致判定だけでは区別できず素通りしてマージされてしまい、特に`detectPatternsForPendingCompare`が持つN手目単独の`nextSession`(N+1手目の着手を含まない)でN+1手目の`pendingCompare`を上書きしてしまう(「続ける」でN手目直後まで巻き戻る)ことを確認した。
- **修正**: `PendingBlunderCompare`に`token`フィールド(この`pendingCompare`インスタンス固有の一意な値)を追加。新規`pendingCompareTokenRef`(単調増加のref)から`handlePlayerMove`の悪手分岐で発行し、`setPendingCompare`(初回)に含める。`loadTwoPlyCompare`のコールバック・`detectPatternsForPendingCompare`の最終`setPendingCompare`双方の結果マージ条件を「`prev.generation === generation`」から「`prev.generation === generation && prev.token === token`」に変更した(`generation`ガードはステージ離脱用として残した、フィードバックの修正方針どおり)。`recordPatternFailuresNow`(統計記録)の実行条件・タイミングは一切変更していない(従来どおり各手のクロージャデータで無条件実行、表示だけを`token`不一致で破棄する)。
- **修正の効果を手動で実証**: 一時的に両箇所の`&& prev.token === token`を`sed`で除去し(=redo#2のバグを再現)、新規追加した再発防止テストがその状態で実際に失敗する(`expected '1/3手' to contain '2/3手'`、フィードバック記載の症状そのもの)ことを確認したうえで、バックアップから元の修正済みコードに復元(`diff`でバイト単位一致を確認)した。
- **再発防止テスト追加**(`PracticeMode.flow.test.tsx`): 「決定局面2」(`DECISION_BOARD_2`/`DECISION_SIDE_2`)を、決定局面1で1手目の悪手`g6`を打った直後の局面から、プロダクションコードと同じ`pickOpponentMove(neutralMoves, 'best')`・`resolveNextSideOrFallback`を使って決定的にシミュレートして構築(`Array.sort`の安定性により相手の応手が一意に定まることを利用)。2手目用の決定局面として、1手目とは異なる損失値(10石、1手目は6石)を持つ`decisionMoves2`モックを追加し、パネルの取り違えを検知しやすくした。テスト「T200 redo#2(重大指摘の再発防止): 連続悪手でN手目の未解決な非同期結果がN+1手目のpendingCompareに混入しない」を追加し、(a)1手目悪手→生成中に続ける→相手応手→2手目も悪手→2手目のパネルが`2/3手`・損失10石を表示 (b)1手目の`requestFeatureSet`(`featureDelayMs`=1500msで遅延)が解決する時間まで待っても、2手目のパネルが`2/3手`・損失10石のまま(混入していない)ことを確認 (c)続けるで2手目の着手が保持されたまま3手目まで完走し、結果画面の損失一覧に1手目(g6、ロス6石)・2手目(`DECISION_BAD_MOVE_2`、ロス10石)の両方が正しく記録されていることを確認する。
- **検証コマンド**:
  - `cd app && npx tsc -b` → エラーなし。
  - `cd app && npx vitest run` → 103ファイル / 875件 全件パス(新規1件含む)。
  - `cd app && npm run build` → 成功。
- **コミット**: `87bc492`(`app: T200 redo#2対応 — 連続悪手でのpendingCompare誤マージを解消(T200)`)。変更対象2ファイル(`PracticeMode.tsx`/`.flow.test.tsx`)のみパス指定でadd。無関係な変更は含めていない(フィードバックの「修正は指摘された機構の解消に絞り、無関係な変更を混ぜないこと」の指示どおり)。
- **push・Actions**: `git push origin main` → GitHub Actions「Deploy to GitHub Pages」成功(`gh run watch`、run 29975626583)。
- **Pages実機確認(連続悪手シナリオ)**: 本番URLに対してPlaywright(chromium)で、3手とも「評価値が最も低い手」を選んで打ち、悪手パネルが出るたびに(生成中でも)ただちに「続ける」を押す、という連続悪手に近い操作を行った。各手クリック直後の`.midgame-practice__round`表示が`1/3手`→`2/3手`→`3/3手`と単調に前進し(巻き戻りなし)、最終的に結果画面の損失一覧に3手すべて(g5/b2/c2、各ロス12・23・8石)が欠落・重複なく記録されていることを確認した(スクリーンショット`pages-redo2-final-longwait.png`)。本番engineは実行時間を制御できないため、ユニットテストのように狙った通りの正確なレース窓を実機で再現することはできないが、連続悪手操作でセッション状態が壊れないことは実機でも確認できた。
- **仕様どおりにできなかった点・判断に迷った点**: なし。修正はフィードバックで指摘された機構(`token`によるpendingCompareマージガード)の追加に絞り、無関係なリファクタリングは行っていない。

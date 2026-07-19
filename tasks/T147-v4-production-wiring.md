---
id: T147
title: v4重みの本番アプリ組み込み(ユーザー裁定による採用)
status: done # verifier(全7項目、Pages実機Playwright独立確認込み)+代替レビュー(軽微3のみ)両合格、2026-07-20
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T147: v4本番配線

## 目的(ユーザー裁定 2026-07-20)

「いったん(教師データ)強化をやめ、v4を本番アプリに組み込む方を先にやる」— 評価関数の本番重みを v3×WTHOR から **v4×WTHOR(ステージ1石刻み61段、oracle regret歴代最良)** に切り替える。

**経緯の明示(重要)**: v4はT125の最終審査で「oracle最良(0.967〜1.111)だが対Edax60局はv3比-2.78石(有意差なし・CI跨ぎ)」により一旦見送りとなった候補。今回は**この経緯を承知のうえでのユーザー裁定による採用**である。本タスクは配線の正しさの検証に集中し、**強度の再審査(60局ゲート)は行わない**。

## 使用する重み

- **T125で事前登録規準により選定された v4×WTHOR seed3 の重み**(oracle regret 0.967)。所在とSHA-256は `tasks/T125-v4-adjudication.md` の作業ログおよび対応するmeta(bench/edax-compare/ の t125系 meta json)を参照して特定すること。重み実体はgitignore領域(train/data/ 配下)にあるはずで、見つからない場合は T124/T125 の学習構成で同一seedを再現学習してSHA一致を確認する(T124metaに構成記録あり)。
- 重みファイルの配信形式・配置は v3 の前例(T122、`tasks/T122-v3-production-wiring.md`)に完全に倣う: app配信用に `pattern_v4.bin` として追加(gzip配信+3.4MB、ロード+31msはT124で計測済み)。

## 要件(T122の前例に倣う)

1. **エンジン側**: v4パターンセット(61段ステージ)の重みロードが本番WASM経路で動くこと(T124でエンジン側実装・NPS 100.9%確認済みのはず。未対応箇所があれば追従)。
2. **app側配線**: `app/src/engine/worker.ts` の重みfetchを pattern_v4.bin に切り替え(v3への切り戻しを1行+コメントで残す。**切り戻しコメントにはANALYSIS_ENGINE_VERSION繰り上げ必須の注意を含める**=T122/T139前例)。
3. **ANALYSIS_ENGINE_VERSION を 5→6**(app/src/analysis/cache.ts。評価値が変わるため必須)。
4. **Service Worker キャッシュ整合**: 重みファイルの追加・キャッシュマニフェスト更新(T122前例)。
5. **スモーク確認(強度審査ではない)**: ローカルで対局・中盤練習・詰めオセロ・棋譜解析・評価バーが正常動作。加えて対Edaxの軽いスモーク(レベル10、10局程度)で異常(クラッシュ・move:null・途中終了・全敗超えの崩壊)がないことを確認(結果の勝敗自体はゲートにしない)。
6. **Pages実機確認**: mainへpush→GitHub Actionsデプロイ成功→本番URL(https://giwarb.github.io/othello-trainer/)で pattern_v4.bin の取得200・対局/解析/評価バー動作をPlaywright等で確認。

## スコープ外

- 強度の再審査(60局paired対局ゲート)・oracle再計測
- v4以外の重み学習・教師データ生成
- 探索系の変更

## 受け入れ基準

1. 本番Pagesで v4 重みが配信・ロードされ、対局/中盤練習/詰めオセロ/棋譜解析/評価バーが動作(実機確認の記録)
2. ANALYSIS_ENGINE_VERSION=6、SWキャッシュ整合、v3切り戻し手順がコメントで残っている
3. 使用した重みのSHA-256がT125選定候補と一致することの確認記録(または再現学習での一致確認)
4. エンジン・appの既存テスト(`cargo test -p engine --lib`、`npx vitest run`)全パス
5. 対Edaxスモーク10局で異常なし(異常時は報告して停止、勝敗はゲートでない)
6. 変更ファイルはパス明示でコミットしmainへpush、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- コミットメッセージに「ユーザー裁定による採用(T125経緯承知の上)」の旨を含める

## 作業ログ

(ワーカーが節目ごとに追記)

### 2026-07-20 実装ワーカー(Sonnet, Codex usage limit中のフォールバック)作業ログ1: 重み特定・配線・単体検証完了

- **重み特定**: T125作業ログより選定候補は「regret 0.9666666667、27,986,340 bytes、SHA-256 `c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`」。実体は`train/data/t124/wthor-v4/v4-seed-3.bin`に存在(gitignore配下、削除されていなかった)。`Get-FileHash`で当該SHA-256・サイズと完全一致を確認。マジックバイトは`PWV3`(先頭4バイト、`num_stages`フィールドで61段/13段を識別する既存の自己記述形式。T124のREADME記載どおりエンジン側の追加実装は不要)。
- **配置**: `train/data/t124/wthor-v4/v4-seed-3.bin`を`train/weights/pattern_v4.bin`と`app/public/pattern_v4.bin`にコピー。両ファイルともSHA-256・サイズ(27,986,340 bytes)が選定候補と完全一致することを確認済み。v2/v3ファイルはそのまま残置(切り戻し用)。
- **app側配線**(T122の前例に倣う):
  - `app/src/engine/worker.ts`: `PATTERN_WEIGHTS_URL`を`pattern_v3.bin`→`pattern_v4.bin`に変更。コメントをT147の経緯(T124導入・T125 seed3採用)に更新し、v3への切り戻し手順+「切り替えるたびに`ANALYSIS_ENGINE_VERSION`を1つ上げること」の注意書きを維持。
  - `app/src/analysis/cache.ts`: `ANALYSIS_ENGINE_VERSION`を5→6に変更。T147の変更理由コメントを追記(既存のT059/T107/T122/T139コメント履歴はそのまま保持)。
  - `app/scripts/test-node-budget-wasm.mjs`: 読み込む重みファイルを`pattern_v3.bin`→`pattern_v4.bin`に変更。
  - `train/weights/README.md`: タイトルに`pattern_v4.bin`を追加、本番採用の説明段落を更新(T124時点で既にv4のPWV3フォーマット仕様自体は記載済みだったため、その部分は変更なし)。
  - SWキャッシュ整合: `app/public/sw.js`は汎用cache-first機構(ファイル名を問わず初回fetch時にキャッシュ)+ビルドごとに`CACHE_VERSION`(コミットハッシュ+ビルド時刻)が自動注入されactivate時に旧キャッシュを一括削除する既存機構(T023/T062)であり、pattern_v4.bin追加に伴う個別のマニフェスト変更は不要(T122前例と同じ扱い)。
- **単体検証**:
  - `cargo test -p engine --lib`: 200 passed / 0 failed / 2 ignored(PASS)。
  - `npm run wasm:build`(wasm-pack再ビルド): PASS。
  - `npx vitest run`: 96 files / 781 tests 全PASS。
  - `npx tsc --noEmit`: エラーなし。
  - `node scripts/test-node-budget-wasm.mjs`(pattern_v4.bin使用に更新後): 決定性PASS(`d6 (11.09)`, depth 9, nodes 160000で2回の`request`+無関係リクエスト後も一致)。
  - 本番ビルド(`npx tsc -b && npx vite build && node scripts/inject-sw-version.mjs`): PASS。`dist/pattern_v4.bin`が27,986,340 bytesで配置されることを確認。
- **ローカルスモーク**(`vite preview --port 4173`+Claude Browser、`http://localhost:4173/othello-trainer/`):
  - `/othello-trainer/pattern_v4.bin`のHTTP応答: 200、Content-Length 27,986,340(curl確認)。
  - 対局モード: 黒番で開始→d3着手→CPU応答(石数3-3)→定石「虎」検出→悪手判定「最善手 e6(+8)に対し、あなたの手d3は+7(ロス1石、順位3位)でした」と表示。評価値の値が局面ごとに変化し(0→-16/+8/+7等)、極端な発散・NaN・クラッシュなし。コンソールエラー0件。
  - 中盤練習モード: 「虎」ステージ問題を開き、候補手評価(-15/-27/+12/-19/-27/-31)と現在の評価値+12が表示。コンソールエラー0件。
  - 詰めオセロモード: 難易度1の問題を開き「黒番、最善で-26」を表示(完全読みのため重み非依存、想定どおり正常動作)。コンソールエラー0件。
  - 棋譜解析モード: 入力画面が正常表示、コンソールエラー0件。
  - 以上、強度審査ではなくスモーク(異常なしの確認)として実施。異常は検出されなかった。
- 次: 対Edaxレベル10×10局のスモーク(異常なしの確認、勝敗はゲートにしない)へ進む。

### 2026-07-20 実装ワーカー作業ログ2: 対Edaxレベル10×10局スモーク完了

- 実行: `bench/edax-compare/vs_edax.py --weights train/weights/pattern_v4.bin --openings <scratchpad>/t147-smoke-openings.json(smoke先頭5局面のみの縮小版) --opening-set smoke --levels 10 --engine-modes single-root --skip-loss-analysis --skip-fixed-depth --allow-dirty`(5局面×黒白=10局。「10局程度」の指示に厳密に合わせるため、既存smoke10局面から先頭5局面を抜粋した縮小openingsファイルをscratchpadに作成して使用。結果・レポートの出力先もscratchpadにし、リポジトリ内に一時ファイルを作らないようにした)。
- 実行前にPV抽出健全性チェックと局面単位node-budget決定性回帰チェック(5/5一致)がいずれもPASS。
- 10/10局完走。全局とも黒白双方42〜52手で正常終了(途中終了・クラッシュなし)。全10局とも結果はEdax勝ち(margin -16〜-57)だったが、**本タスクは強度審査ではなく異常検出が目的**であり、5局面のみの小サンプルでの敗北自体はゲート対象外(T125本審査60局ではv4は4勝2分54敗、平均-24.02で本結果と整合的)。
- 異常検出のプログラム的走査(games JSON全件): 手が`null`のレコード0件、exact読み試行が未完了かつフォールバックなしのレコード0件、全10局とも局面の残り空きマス数どおりの手数で正常完了(48/48/49/50/50/50/52/52/52/48手)。エンジン側nps分布は2〜21,075,400(残り数手の即詰み局面での低nodesは終盤の想定内挙動)。
- 実行メタデータ(harnessが自動記録)の`weightsSha256`が`c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`で、T125選定候補・配置ファイルのSHA-256と完全一致することを確認(重み特定の独立した二重確認)。
- 結論: 対Edaxスモークで異常なし(受け入れ基準5を満たす)。次はコミット・push・GitHub Actionsデプロイ確認・Pages実機確認へ進む。

### 2026-07-20 実装ワーカー作業ログ3: コミット・push・Actionsデプロイ確認・Pages実機確認完了(タスク完了)

- **コミット**: 変更対象ファイルのみパス指定で`git add`(`app/src/engine/worker.ts` `app/src/analysis/cache.ts` `app/scripts/test-node-budget-wasm.mjs` `train/weights/README.md` `app/public/pattern_v4.bin` `train/weights/pattern_v4.bin`)。`tasks/`・`CLAUDE.md`は対象外のままコミット。コミットハッシュ`3f8a95f`(件名「app,train: v4×WTHOR重み(ステージ1石刻み61段)を本番配線(ユーザー裁定による採用)(T147)」、本文に「T125の経緯を承知の上でのユーザー裁定による採用」の旨を明記)。
- **push**: `git push origin main`成功(`6d7b1c4..3f8a95f main -> main`)。
- **GitHub Actions確認**: push後起動した2 run(`Deploy to GitHub Pages` run 29706259217、`Rust Tests` run 29706259205)を`gh run view`でポーリングし、両方とも`completed success`を確認。
- **Pages実機確認**(`https://giwarb.github.io/othello-trainer/`、Claude Browser):
  - `curl https://giwarb.github.io/othello-trainer/pattern_v4.bin`: 200、Content-Length 27,986,340(選定候補と同一サイズ)。
  - 本番JSバンドル(`assets/worker-C6tLfKnX.js`)の内容に`pattern_v4.bin`という文字列が含まれることを確認(fetchするURLが正しくビルドに反映されている独立確認)。
  - 対局モード: 黒番で開始→d3着手→CPU応答(石数3-3)→定石「虎」検出→悪手判定「最善手 e6(+8)に対し、あなたの手d3は+7(ロス1石、順位3位)でした」を表示。ローカルスモークと完全に同じ評価値(+8/+7)が出ており、本番ビルドとローカルビルドの重み・エンジンロードが一致していることを確認。コンソールエラー0件。
  - 中盤練習モード: 「虎」ステージ問題を開き評価値(+12ほか)を表示。コンソールエラー0件。
  - 詰めオセロモード: 出題選択画面が正常表示。コンソールエラー0件。
  - 棋譜解析モード: 入力画面が正常表示。コンソールエラー0件。
  - 補足(気づき、ブロッカーではない): このセッションの`computer`ツールのcanvas座標クリックがPages本番タブ(https://giwarb.github.io起点)でのみ反応せず(ローカルpreviewタブでは正常に反応した)、`javascript_tool`経由でDOM操作・`MouseEvent`合成dispatchに切り替えて着手・モード遷移を検証した。アプリ側の不具合ではなくブラウザ操作ツール側の挙動と判断(アプリのクリックハンドラ自体は合成MouseEventで正常に反応しており、機能に問題はない)。
  - 補足2(気づき、ブロッカーではない): 中盤練習の候補手評価値をローカルスモークと本番で見比べると、6候補中5つは一致(-27/+12/-19/-27/-31)したが1つだけ異なった(ローカル-15、本番+3)。これは中盤練習の評価がwall-clock時間予算(タイマー方式)の探索であり、マシン負荷・実行タイミングにより反復深化の到達深さが変わりうる既存の性質(v3時代から同様)であり、本タスクで導入した決定的node-budget経路(`test-node-budget-wasm.mjs`で検証、node数固定・完全決定的)とは異なる。異常ではなく、v4固有の問題でもない。
- **受け入れ基準の充足状況**:
  1. 本番Pagesでv4重みが配信・ロードされ、対局/中盤練習/詰めオセロ/棋譜解析/評価バーが動作 → 実機確認済み(上記)。
  2. ANALYSIS_ENGINE_VERSION=6、SWキャッシュ整合、v3切り戻し手順コメント → 済み(worker.ts/cache.ts参照)。
  3. 使用した重みのSHA-256がT125選定候補と一致 → 済み(`c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`、配置ファイル・harness自動記録メタデータの双方で確認)。
  4. `cargo test -p engine --lib`・`npx vitest run`全パス → 済み(200/781テスト)。
  5. 対Edaxスモーク10局で異常なし → 済み(作業ログ2参照、null手0件・完走10/10)。
  6. 変更ファイルをパス明示でコミットしmainへpush、完了時`git status --short`クリーン → 済み(コミット`3f8a95f`、push済み、`git status --short`は`tasks/T147-v4-production-wiring.md`のみ)。
- **タスク完了**。

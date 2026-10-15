---
id: T201
title: 中盤練習の★判定を決定的にする(allMoves解析のノード予算化)
status: review
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T201: 中盤練習の★判定を決定的にする(allMoves解析のノード予算化)

## 目的
中盤練習で **同じ問題に同じ手順を打っても、試行ごとに正解(★1以上)/失敗(★0)が変わる** バグを直す。判定に使う評価値を、マシン速度・CPU負荷に依存しない決定的な値にする。

## 背景・コンテキスト
### ユーザー報告(2026-10-15)
中盤練習の問題86番で g6 → f2 → h5 と打ったら正解、リトライして同じ g6 → f2 → h5 を打ったら失敗になった。

### 調査結果(explorer、node+wasm で実測済み)
- 問題86 = `app/src/midgame/stagePool.ts` `buildMidgameStagePool` の86番、定石「沈没船」終端局面、黒番。手順 `f5 f6 e6 f4 e3 c5 c4 d7 c6 e2 f3 d3 c3 d2`。合法手 d1 e1 f1 f2 g4 g5 g6 f7 g7 e8(最善 f2 ≈ -2.75、g6 ≈ -3.51)。g6/f2/h5 は3手とも黒(ユーザー)の手で、AI応手は最善手(実測 g5 → c2 → d6)。
- 判定は `app/src/midgame/stageStarJudge.ts` `computeStageStars`: 3往復後に「損失 = 開始評価 − 終了評価」で★を決める(全手最善で★3、損失<1で★2、<5で★1、それ以外★0=失敗)。開始評価=ステージ開始局面の最善手評価(`PracticeMode.tsx` `handlePlayerMove` で `startEvalRef.current = best.discDiff`)、終了評価=3往復後局面の最善手評価(`checkSessionEnd` → `finalizeSession`)。
- 評価値はいずれも `PracticeMode.tsx` の `MIDGAME_ANALYZE_LIMIT = {depth:16, timeMs:1000, exactFromEmpties:24}` による `requestAnalyzeAll`(Worker → `engine/src/protocol.rs` allMoves分岐 → `engine/src/search.rs` `search_all_moves_with_eval_core_restricted` 付近)で計算される。
- **根本原因**: allMoves 経路は 1000ms を合法手数で均等割り(`fair_share_time_ms`)し、反復深化を **時間切れで打ち切る**。到達深さがPC速度・負荷で変わり評価値が数石ぶれる。allMoves 分岐は `maxNodes` を無視している(`protocol.rs` ~257行)。TTは手ごとにclearされ持ち越されない(TT・状態リセット漏れ・キャッシュ汚染・視点混同・T200のpendingCompareはいずれも無関係と確認済み)。
- 実測: 通常負荷で start=-2.75 / end=-6.21(損失3.46→★1)だが、CPU負荷下では start=-0.09 / end=-6.69〜-8.9(損失6.6以上→8回中8回★0)。負荷なしでも個別局面の評価が回ごとに数石動いた。
- 参考スクリプト(リポジトリ外、読み取りのみ可): `C:\Users\yoshi\AppData\Local\Temp\claude\C--Users-yoshi-work-othello-trainer\e746d242-ce2e-4676-8ae1-5764f7120efd\scratchpad\run2.mjs`(wasm を node で読み込み pattern_v6 で同手順を再現するもの)。
- プロジェクト方針: 解析・判定の **決定性(同一局面→同一結果)は必須要件**、実測時間/NPSを探索制御に使わない(T085以来の方針)。対局CPUは「固定ノード予算+wall保険」方式が既存の前例。

## 変更対象
- `engine/src/protocol.rs` — allMoves(analyzeAll)分岐で `maxNodes` を受け付け、全合法手探索の打ち切りに使う。
- `engine/src/search.rs` — `search_all_moves_with_eval_core_restricted`(および必要な下位関数)にノード予算による決定的打ち切りを追加(例: 総ノード予算を合法手数で均等割りし、各手の反復深化を「ノード予算内で完了した最深の反復」の値で確定。時間は保険としてのみ使う)。設計の細部は実装者判断でよいが、**同一入力なら timeMs 保険が発火しない限りビット同一の結果** になること。
- `app/src/midgame/PracticeMode.tsx` — `MIDGAME_ANALYZE_LIMIT` をノード予算方式に変更(`maxNodes` を指定、`timeMs` は十分大きい保険値に)。予算値は、通常PCで1回の analyzeAll が現行(約1秒)と同程度以下に収まるよう、実測して決めること(根拠を作業ログに記録)。
- 必要に応じて Worker/型定義(`app/src/` 内の requestAnalyzeAll の limit 型、protocol の TS 型)。
- テスト: engine 側(cargo test)と app 側(vitest)に回帰テストを追加。

## 要件
1. allMoves 解析で `maxNodes` を指定した場合、結果(各手の評価値・最善手)が **時間や負荷に依存せず決定的** になる。同一局面を2回(間に別局面の解析を挟んでも)解析して完全一致すること。
2. `maxNodes` を指定しない既存呼び出し(棋譜解析・評価バー等)の挙動は変えない。全 `requestAnalyzeAll` / allMoves 呼び出し元を洗い出し、既に `maxNodes` を渡している呼び出し元があれば作業ログに列挙し、挙動変化の有無を明記する。挙動が変わる呼び出し元があり解析キャッシュ(IndexedDB、`ANALYSIS_ENGINE_VERSION`)に影響するなら、バージョンを繰り上げる。
3. 中盤練習の開始評価・終了評価・各手の損失表示は、すべてノード予算方式の決定的な解析を使う。
4. **回帰テスト(必須)**:
   - engine: allMoves に maxNodes を指定し、timeMs を極小(例: 1ms 相当だが保険として無効化される設計なら不要)/大きい値で変えても、また2回連続で呼んでも結果が一致することを検証するテスト。既存の決定性テスト(`protocol.rs` 955行付近)を参考に拡張してよい。
   - app or 統合: 問題86の局面(上記手順)から g6 → (AI最善応手) → f2 → (応手) → h5 → (応手) を、ノード予算付き limit で2回通しで実行し、開始評価・終了評価・★が2回とも一致することを確認するテスト(wasm を node で読むテストが既存構成で困難なら、engine の Rust テストで同等の局面列を再現する形でもよい)。
5. wasm を再ビルドし、app が新しいエンジンを使うようにする(このリポジトリでの wasm 成果物の扱い=コミット対象か CI ビルドかを確認し、それに従う)。
6. 作業ログに: 採用した打ち切り設計、選んだノード予算値と実測時間(通常時)、問題86での start/end/★ の値(2回分)を記録する。
7. **(2026-10-15 ユーザー追加要件)結果画面の「最善手(正解)」表示もぶれないこと。** ユーザーは問題86の結果画面で「g6 が最善手」と表示されたのを見ている(通常負荷の実測では f2 ≈ -2.75 が最善、g6 ≈ -3.51 であり、時間打ち切りの揺れで最善手が入れ替わったと推定)。結果画面・悪手比較(worstMoveCompare 等)・各手の損失/最善判定・★3判定(全手最善)など、**中盤練習で「最善手/正解」を表示・判定するすべての経路** を洗い出し、要件1と同じ決定的なノード予算方式の解析を使うこと。さらに、同一局面については **プレイ中の判定に使った解析結果と結果画面の表示が食い違わない** こと(同一 limit で解析するか、プレイ中の解析結果を再利用する)。洗い出した経路の一覧と、それぞれの対応を作業ログに記録する。回帰テストとして、問題86の開始局面の最善手がノード予算付き解析で2回とも同一手になること、結果画面用の最善手と判定用の最善手が一致することを検証する。

## やらないこと(スコープ外)
- ★判定の閾値(1石/5石)や判定式そのものの変更。
- 対局CPU経路・評価バー・棋譜解析の探索設定の変更(要件2の範囲の確認のみ)。
- 評価関数・MPC・TT・探索アルゴリズム本体(枝刈り等)の変更。
- 悪手比較UI(T195〜T200)の変更。
- STATUS.md・tasks/ 配下のコミット(作業ログ追記のみ行う)。

## 受け入れ基準(検証コマンド)
- [ ] `cargo test` を engine クレートで実行し全件パス(新規の決定性テストを含む)。
- [ ] `cd app && npx vitest run` が全件パス(新規テストを含む)。
- [ ] `cd app && npm run typecheck`(存在しなければ `npx tsc --noEmit`)がエラー0。
- [ ] `cd app && npm run build` が成功。
- [ ] 問題86で g6/f2/h5 手順を2回実行したときの start/end/★ が一致することをテストまたは記録で示す。
- [ ] 要件7: 中盤練習で最善手/正解を表示・判定する全経路が決定的解析を使い、結果画面の最善手が判定用の最善手と一致する(テスト+作業ログの経路一覧で示す)。Pages 実機でも問題86の結果画面の最善手表示が2回とも同一であることを確認する。
- [ ] (オーケストレーターがコミット・push後、verifier が実施)GitHub Actions のデプロイ成功、`https://giwarb.github.io/othello-trainer/` の中盤練習で問題86を g6/f2/h5 で2回解き、★が同一になることを Playwright で確認。
- [ ] タスク完了時点で、当該タスク由来の差分以外の未追跡ファイル(一時ファイル・デバッグ出力)が `git status --short` に残っていないこと(Codex はコミット不可のため、変更対象ファイルの差分は残ってよい。完了報告に変更ファイル一覧を書くこと)。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-10-15 20:26 implementer: Codex

- `allMoves + maxNodes` を受理し、総ノード予算を合法手数で固定均等割り(商を全手、余りをマス番号順の先頭から1ずつ配分)する経路を追加した。各手は従来どおり手ごとに空のローカルTTから開始し、着手後局面を既存のノード制限付き反復深化で探索して、予算内で完了した最深反復の値を採用する。`timeMs` も固定均等割りするが、ノード予算より十分大きい壁時計保険としてのみ機能する。`maxNodes` 未指定時は従来の残り時間動的再配分経路をそのまま通す。
- 中盤練習の共通設定を `{ depth: 16, timeMs: 10000, maxNodes: 1500000, exactFromEmpties: 24 }` に変更した。`getAnalyzedMoves` と2手先比較用コールバックが同じ定数を使うため、開始評価・終了評価・各手損失・相手応手・表示はすべて同じノード予算方式になった。
- 予算選定実測(WASM release、pattern_v6、問題86、通常時): 150万ノードで analyzeAll 7回の平均/最大は1回目 849.5/888.2ms、2回目 785.3/925.1ms(現行目安の約1秒以下)。問題86 `g6/f2/h5` は2回とも応手 `g5/c2/h6`、start=-0.09、end=-4.29、各手loss=3.42/0/2.92、★1で完全一致した。
- Rust統合回帰はテスト時間短縮のため24万ノードを使い、問題86を開始手順から組み立てて2回通し実行(間に初期局面解析を挿入)。両回とも応手 `g5/c2/d6`、start=4.58、end=-5.34、★0で完全一致した。別テストで同一allMovesを連続実行・別局面を挟んだ再実行・`timeMs=10000/20000`変更のすべてについてmoves/PV/score完全一致も確認した。
- `requestAnalyzeAll` / allMoves 呼び出し元を全件確認: `app.tsx`、`analysis/analyzeGame.ts`、`analysis/BlunderPanel.tsx`、`analysis/sendToPractice.ts`、`joseki/PracticeMode.tsx`、`midgame/PracticeMode.tsx`(注入先`midgame/twoPlyCompare.ts`を含む)、`tsume/PlayMode.tsx`、`verbalize/PracticeMode.tsx`、`verbalize/TwoChoiceDrill.tsx`、`verbalize/glossaryExamples.ts`、および共通入口`engine/client.ts`。着手前にallMovesへ`maxNodes`を渡していた呼び出し元は0件(`app.tsx`の既存`maxNodes`はCPU着手のsingle-root `requestAnalyze`専用)。今回挙動が変わるのは中盤練習だけで、IndexedDB解析キャッシュを使う棋譜解析は`maxNodes`未指定のままなので `ANALYSIS_ENGINE_VERSION` は8から変更していない。
- WASM成果物は `app/src/engine/pkg` がgitignore対象で、CI/`npm run build`が毎回再生成する構成を確認。`npm run wasm:build`、`npm run typecheck`、`npm run build`内で新エンジンを再ビルド済み(コミット対象成果物なし)。
- 検証: `cd engine && cargo test` = 259 passed / 0 failed / 2 ignored、`cargo test -p engine --release --test ffo_bench` = fast 1 passed / heavy 1 ignored、`cd app && npx vitest run` はサンドボックスがViteの`net use`と既定fork workerを`spawn EPERM`で拒否したため、同じ全スイートを一時preload＋`--pool=threads --maxWorkers=1`で実行して103 files / 876 tests passed、`npm run typecheck`成功、`npm run build`成功(WASM node-budget決定性検査・pattern_v6検査を含む)。`git diff --check`成功。一時preload・wasm-packキャッシュ・誤相対出力は削除済み。
- コミット: 未実施(`.git`書き込み禁止のため、オーケストレーターが代行)。

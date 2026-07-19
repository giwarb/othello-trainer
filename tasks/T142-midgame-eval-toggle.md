---
id: T142
title: 中盤練習: 評価値表示の切り替え復活(既定ON)+全モードのトグル監査
status: in_progress
assignee: implementer(Sonnet)
attempts: 0
---

# T142: 評価値表示トグルの復活

## 目的(ユーザー報告 2026-07-19 午前)

「評価値表示モードの切り替えが中盤練習などでできなくなっていました。」T141の全面改訂で中盤練習から表示ON/OFFチェックを撤去したため。ユーザーの前指示「評価値が常に出ているように」(既定ON)と、今回の「切り替えたい」を両立する。

## 仕様

1. **中盤練習**: プレイ画面に「候補手評価を表示」トグルを復活する。**既定はON**(前指示どおり常に出ている)。OFFにすると盤上の候補手評価オーバーレイを隠す(答えを見ずに腕試しできる)。**評価バー(盤面評価)は常時表示のまま**(トグル対象外)。設定は従来のlocalStorage(`moveEvalOverlaySettings`の中盤用キーが残っていれば再利用、無ければ同様式で)に永続化。トグルの置き場所はプレイ画面の盤の下(「やめる」付近)の小さなチェックまたはチップ(T135トークン)。
2. **★判定・相手応手はトグルと無関係**に従来どおり動くこと(表示だけの切り替え。analyzeAllは判定に必要なので裏では走り続ける)。
3. **全モードのトグル監査**: 詰めオセロ・定石練習・棋譜解析の「候補手評価を表示」系トグルが現HEADで正常動作するか確認し、壊れていれば修正(T138/T141の共有部品変更の影響チェック)。対局モードは常時表示のまま(T138仕様、変更しない)。
4. レスポンシブ・横置き両対応。

## やらないこと(スコープ外)

- 対局モードへのトグル復活(T138でユーザー指示により常時化済み)/★判定ロジックの変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`/`npm run dev`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`・`npx vite`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [x] 中盤練習のトグルテスト: 既定ON/OFF切替でオーバーレイ非表示・評価バーは表示継続/OFFでも★判定と相手応手が正常/永続化(リロード後保持)
- [x] 他モードのトグル動作確認(テストまたは実機確認を作業ログに記録)
- [x] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [x] mainへpush→Actions成功→本番Pagesで中盤練習のトグルON/OFF動作を確認(375x812)
- [x] 変更対象のみパス明示コミット(`app:`、`(T142)`)。`tasks/`はコミットしない
- [x] 当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-19 実装着手。`git pull --rebase`実行(既に最新、e4515c3)。
- `app/src/settings/moveEvalOverlaySettings.ts`: 中盤練習専用のキー
  `MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY`(`othello-trainer:midgameMoveEvalOverlay`)・
  既定値`DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED = true`・
  `loadMidgameMoveEvalOverlayEnabled`/`saveMidgameMoveEvalOverlayEnabled`を追加。
  既存の対局モード等が使う共有キー(`MOVE_EVAL_OVERLAY_STORAGE_KEY`、既定false)とは
  別キー・別既定値にした(既存3モードの挙動に影響を与えないため)。
  対応するテストを`moveEvalOverlaySettings.test.ts`に追加(往復・独立キー確認・
  壊れたJSON/非真偽値のフォールバック)。
- `app/src/midgame/PracticeMode.tsx`: `moveEvalOverlayEnabled` stateを追加(初期値は
  上記loadから)、`MoveEvalOverlay`の`visible={true}`固定を`visible={moveEvalOverlayEnabled}`
  へ変更、`handleToggleMoveEvalOverlay`を追加、プレイ画面の評価バー下・「やめる」上に
  `.move-eval-overlay-toggle`ラベル(joseki/tsume/analysisと同一CSS・同一パターン)で
  チェックボックスを配置。評価バー(`evalBarValue`・`EvalBar`)はこのstateと無関係のまま
  常時表示を維持。`overlayMoves`取得(`getAnalyzedMoves`経由、★判定が依存するキャッシュ)も
  トグルと無関係に従来どおり動作させている(表示だけの切り替え)。
- 新規テスト`app/src/midgame/PracticeMode.evalToggle.test.tsx`を追加: 既定ONでの
  オーバーレイ表示・チェックボックス初期状態、OFF切替でオーバーレイ非表示+評価バー
  表示継続、OFFでも3往復完走・★判定・stageProgress記録が正常動作、OFF設定の
  localStorage永続化(アンマウント→再マウントでも保持)を検証。
- `npx tsc --noEmit -p tsconfig.app.json`(app/配下で実行): エラーなし。
- `npx vitest run`(app/配下): 96 test files / 781 tests 全パス(新規4件含む)。
- コミット`af7d3fb`(`app: 中盤練習に「候補手評価を表示」トグルを復活(既定ON)(T142)`、対象4ファイルのみパス明示)。
  `git push origin main`実行、`gh run watch`でDeploy to GitHub Pages(29667282575)成功を確認
  (build 58s + deploy 10s、両ジョブ✓)。
- **本番Pages実機確認(375x812、Browser MCP)**:
  - 初回ロード時にService Worker更新通知(「新しいバージョンがあります」)が出ていたため
    「今すぐ更新」をクリックしてから検証(更新通知を閉じるだけだと旧キャッシュのまま検証してしまう
    落とし穴があったので記録しておく)。
  - **中盤練習**: 第2問「猫」を開始 → チェックボックス初期状態ON・盤上に候補手評価オーバーレイ
    (`.move-eval-overlay`)表示・評価バー(`.midgame-eval-bar-panel`)表示を確認。チェックを外すと
    オーバーレイのみ消え評価バーは表示継続、`localStorage['othello-trainer:midgameMoveEvalOverlay']`が
    `'false'`で永続化されることを確認。OFF状態のまま(途中でON/OFFを行き来しつつ)3手を打ち切り、
    結果画面で「クリア! ★☆☆」と1〜3手目の評価・ロス表示が正しく出ることを確認(★判定・相手応手が
    表示トグルと無関係に正常動作)。
  - **他モード監査(いずれも現HEADで正常動作、修正不要)**:
    - 定石練習: 黒番で開始 → `.move-eval-overlay-toggle`あり、OFFにするとオーバーレイ消滅を確認。
    - 詰めオセロ: ランダム出題 → トグルあり(既定OFF、共有キー)、ONにするとオーバーレイ出現を確認。
    - 棋譜解析(BlunderPanel「フリー分岐探索」): テキスト入力で解析すると悪手判定ボタンが出た
      手をクリックしてBlunderPanelを開き、トグルの存在・OFFでオーバーレイ消滅を確認
      (最初に投入した`f5d6c3d3c4`は全手が定石一致で悪手行が無くBlunderPanelを開けなかったため、
      ブラウザ内で自前のOthelloシミュレータをJS即興実装し合法性を保証したうえで意図的に
      X打ち(角付近の悪手)を混ぜた16手の棋譜`d3c5d6e3f4f6c4e7g7d2b5h8f2g5d1b6`を生成・投入して
      悪手判定行を作った)。
  - 対局モードへのトグル追加は行っていない(スコープ外、T138仕様どおり常時表示のまま)。
- `git status --short`: `tasks/T142-midgame-eval-toggle.md`のみ残存(タスクファイルはオーケストレーター
  がコミットする運用のため、ワーカーはコミットしていない)。それ以外のスコープ外差分・未追跡なし。


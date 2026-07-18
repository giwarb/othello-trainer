---
id: T140
title: 対局: 1手戻る(undo)機能(研究用)
status: in_progress
assignee: implementer(Sonnet)
attempts: 0
---

# T140: 対局の1手戻る

## 目的(ユーザー指示 2026-07-19 朝)

「対局では研究もしたいので、1手戻るの機能もつけてほしい。」評価値常時表示(T138)と組み合わせ、任意の局面まで戻して打ち直せるようにする。

## 仕様

1. 対局モードに**「1手戻る」ボタン**(投了・新規対局の並び、セカンダリ)。
   - CPU対戦: 押すと**自分の直前の手の直前まで**戻る(CPUの応手+自分の手の2plyを取り消し、自分の手番に戻る)。CPUが思考中でも押せて、その場合は自分の直前の手のみ取り消し(思考中のCPU応手は破棄)。
   - 2人対戦: 1ply戻す。
   - 終局後も押せる(研究用)。履歴が空なら非活性。
2. **実装方針**: `moveHistory`(T132、`app/src/game/gameHistory.ts`)を正とし、undo時は「初期局面から履歴prefixをリプレイして`GameState`を再構築」する(パスは既存のリプレイ規約で自動再現)。`displaySequencerRef.reset(next)`で表示を即時同期(T134のキュー残骸を破棄)。**CPU着手effectの世代ガード**: 進行中の`requestCpuMove`結果がundo後に適用されないよう、対局世代ID(ref)を導入しundoでインクリメント、effect解決時に照合(T115/T119の教訓に従い、新規effectは増やさず既存構造への加算で)。
3. 盤面自由配置(非標準初期局面)の対局ではボタンを出さない(T132の`standardStart`と同じ条件。リプレイが初期局面前提のため)。
4. undo後、評価値表示・定石トレース(T138)・「振り返る」導線が巻き戻った状態と整合すること(moveHistory truncateにより自動で整合するはず。トレースの「(離脱)」状態も再計算)。
5. 悪手判定(悪手時のフィードバック表示があれば)や評価バーはundo後の局面で通常どおり動く。

## やらないこと(スコープ外)

- 進む(redo)/分岐ツリー表示(将来候補) / 中盤練習・詰めオセロへのundo(T141が別途)
- bench/・train/への変更(生成走行中)。`npm run typecheck`/`npm run dev`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`と`npx vite`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] コンポーネントテスト: CPU戦で2手進めundo→1手目直後の自分の手番に戻る/思考中undo→CPU応手が適用されない(世代ガード)/2人対戦は1ply/履歴空で非活性/終局後undo可/非標準開始で非表示
- [ ] undo後にmoveHistory・定石トレース・評価表示が整合するテスト(振り返る棋譜がundo後の履歴と一致)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→本番Pagesで: CPU対局を数手→1手戻る→打ち直し→思考中に戻る、の一連を確認(375x812・844x390)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T140)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

# T134 最終レビュー: 石返しアニメーション直列化(コミット b155747)

- レビュー担当: Claude(独立コンテキスト、read-only + 本レポートのみ)
- 対象: `git show b155747`(app/src/app.tsx、app/src/components/Board.tsx、app/src/game/displayQueue.ts 新規、テスト4ファイル)
- 照合: `tasks/T134-animation-sequencing.md`(作業ログ含む)
- 検証実行: `npx vitest run`(displayQueue.test.ts / animationSequencing.test.tsx / T115・T132・T133回帰の計5ファイル)→ **12件全パス**

## 総合判定: 合格(条件付き)

重大(ブロッカー)指摘なし。ただし観点1で **中レベルの実在バグ1件**(表示ラグ中の「見えない盤面への着手」が実際に成立しうる)を確認した。クラッシュ・状態破壊・ハングはなく、発生には複数条件の重なりが必要で、多くの場合は無害(無視)または本人の意図どおりの手になるため redo 級とはしないが、**ガード1行程度の追修正タスクを強く推奨**する(修正案は下記)。

---

## 観点1: 表示ラグ中の入力整合(最重要)—【中】見えない盤面への着手が成立しうる

### 判定の仕組み(事実関係)

- Board側クリックガード(`Board.tsx` `handleClick`): `legalMoves(board, sideToMove)` — **displayGame基準**(表示中の旧局面 × 表示中の手番)。
- `handleMove`側ガード(`app.tsx` 590行): `if (game.phase !== 'human') return` と `playMove(game, square)` — **game基準**(内部の最新局面)。
- つまり2つのゲートが**別の局面**を見ており、その不一致をすり抜けるクリックが存在する。

### 危険窓と具体的な挙動

CPU対局: 人間が着手 → displayGameは即時反映(post-human、表示手番=CPU色)→ CPUの応手が**表示反映前に確定**すると(定石ブック応手は即時なので窓は最大 FLIP+GAP≒470ms フル)、`game.phase==='human'`(post-CPU)なのに盤は1手前、という窓が開く。この間のクリックは:

1. **旧局面でCPU色に合法 ∧ 新局面(未表示)で人間に合法** のマス → 両ゲートを通過し、`playMove(game, square)` が**ユーザーがまだ見ていない局面に対して着手を確定**する(誤着手。対局モードに待ったは無いので取り返しがつかない)。オセロでは隣接局面で両者の合法手が重なることは珍しくなく、連打・先打ちで現実に踏み得る。
2. 旧局面でCPU色に合法だが新局面で人間に非合法 → `playMove`は同一stateを返す仕様(gameLoop.ts 231-239行)のため**無害(無視)**。ただし同一stateが `displaySequencerRef.push` に重複投入され(表示上はdiff無しで無害だがタイムラインが470ms延びる)、`evaluateHumanMove` が無駄な `requestAnalyzeAll` を1回走らせる(playedEval不一致で早期return、誤表示なし)。
3. 旧局面でCPU色に非合法 → Boardゲートで弾かれ完全に無視。

CPUの探索が470msより遅い場合(中盤の通常探索)は、表示が先に追いつくため窓は開かない。**実質的な発生源は定石ブック即時応手と高速探索応手**。

- **クラッシュ経路は無い**(playMoveの非合法no-op、appendPlayedMoveのlastMove不変no-op、Preactの同値setStateで確認)。
- **2人対戦モード**: `game.phase` は常に `'human'` のため handleMove ガードが実質無効。連打時(前の手の表示反映前に次のタップ)に同型の「1手先の局面への着手」が起きる。ただしこの場合、通過条件が「表示中の手番(=正しい次の打ち手)にとって合法」なので、**確定するのは打ち手・マスとも本人の意図どおりの手**であることが多く、実害は「返る石が予想と違う」程度に留まる。人間連打(CPU対局で自分の手番でないのに連打)は経路1〜3のいずれかに落ちる。

### 修正案(1〜2行)

`handleMove` 冒頭のガードを displayGame も見るように強化する:
```ts
if (game.phase !== 'human') return
if (displayGame !== game) return  // 表示が追いつくまで入力を受け付けない(T134)
```
参照比較で十分(displayGameはgameのスナップショットをそのまま流すため)。これでCPU対局・2人対戦の両方で「見えている局面=着手対象の局面」が保証される。なお handleMove のコメント「アイドルでない場合(理論上は起こらない想定、Board側の合法手ガードで…クリックできるはず)」(608-611行)は**前提が誤り**(Boardガードは表示手番の合法性しか見ておらず、表示が追いついたことは保証しない)なので、修正時にコメントも直すこと。

## 観点2: T115レースの非再導入 — 合格

- **新規の `useEffect([game])` は追加されていない**。変更は既存effect2つの依存を `game`→`displayGame` に付け替えたのみ(候補手オーバーレイ、終局演出)。CPU着手effect(依存 `[game, level, openingBookEnabled, josekiDb, josekiDbReady]`)と「思考中」safety-net(`[game.phase]`)は無変更で、`displayGame` 更新による再レンダーではこれらのeffectは再発火しない(依存にdisplayGameを含まない)。sequencerの `push`/`reset` はすべて `setGame` 呼び出し箇所への併記で、effectのcleanup競合の構造に触れていない。設計方針どおり。
- 思考中とdisplayGameの整合: 手番表示は `displayGame.sideToMove` 基準に変更済みのため「手番: 黒なのに盤は白の手前」は起きない。唯一の瞬間差は「CPU応手がgame確定済み・表示未反映の間、『手番: 白』が思考中サフィックス無しで最大470ms出る」だが、盤面(白の手前の局面)とは整合しており矛盾表示ではない(軽微・許容)。逆方向(思考中がdisplayGameより先に立つ)は、クリックハンドラ内で `setGame`/`push`(アイドル即時反映)が同一レンダーにバッチされるため起きない。
- ブック即時応手のハングなしは新規統合テスト(animationSequencing.test.tsx)が「思考中解除+手番:黒復帰」まで検証しており、T115回帰テスト含め全パスを実測確認した。

## 観点3: displayQueueの正しさ — ほぼ合格(軽微1件)

- **reset/push混在**: 新規対局系3関数はすべて `reset`(キュー・タイマー破棄+即時反映)。対局中に新規対局を開始した場合、in-flight のCPU promiseは既存の `cancelled` ガードが `push` ごと抑止する(pushは `if (!cancelled)` 内)ため、旧対局の状態が新対局の表示に混入する経路は無い。resetがクールダウンを張らないのも妥当(初期局面はdiffBoards非単発でアニメ無し即描画のため、直後のCPU初手pushが即時反映されて問題ない)。
- キューの純粋ロジック(アイドル即時/クールダウン待ち/3連pushの直列/reset)は単体テスト5件で決定的に検証済み。
- **【軽微】アンマウント時のクリーンアップが無い**: PlayModeアンマウント(モード切替)時に保留中のクールダウンタイマーを clear するeffectが無く、最大470ms後に unmounted コンポーネントの `setDisplayGame` が発火する。Preactでは親DOMを失ったコンポーネントの再レンダーはno-opでクラッシュ・警告は出ず、タイマー連鎖もキュー長で有限に止まるため実害は無いが、衛生上は `useEffect(() => () => sequencer破棄, [])`(sequencerに `dispose()` を追加)が望ましい。申し送りで可。

## 観点4: game基準に残した判断(evaluateHumanMove/評価バー/moveHistory)— 許容【軽微】

- **評価値バー(`evalBarValue`、`[game,...]`依存)**: CPU応手確定と同時に更新されるため、**盤面表示より最大470ms先行して動く**(事実)。盤上座標との対応が無い数値表示であり、旧実装でも探索完了と同時に動いていたこと、遅延させると今度は「自分の着手への評価が遅れて見える」別の違和感が出ることから、redo級ではなく許容範囲と判定。気になるなら将来 displayGame 依存へ寄せる選択肢がある旨のみ申し送り。
- `evaluateHumanMove`(自分の着手のスナップショット評価)・`moveHistory`(棋譜の正確性が最優先)・思考中フラグをgame基準に残したのは妥当。「振り返る」ボタンは表示条件が `displayGame.phase==='over'` にゲートされているため、履歴が先行していても露出しない。
- 終局演出は `displayGame.phase` 起点+FLIP_ANIMATION_MS 待ちで、最終手のアニメ完了後に出る設計が保たれている。

## 指摘一覧

| # | 区分 | 内容 |
|---|---|---|
| 1 | **中** | 表示ラグ窓(ブック応手時 最大約470ms)での「見えない盤面への着手」: Boardガード(displayGame基準)とhandleMoveガード(game基準)の局面不一致により、条件が重なると未表示局面への着手が確定する。2人対戦連打でも同型。修正案: handleMoveに `displayGame !== game` ガード追加+誤コメント修正(上記詳細) |
| 2 | 軽微 | sequencerのアンマウント時タイマークリーンアップ無し(Preactではno-opで実害なし) |
| 3 | 軽微 | 評価値バーが盤面表示より最大470ms先行(意図的設計判断、許容) |
| 4 | 軽微 | ラグ窓中の非合法クリックで同一stateの重複push(表示470ms延伸)+無駄なrequestAnalyzeAll 1回 |
| 5 | 軽微 | CPU応手確定〜表示反映の間「手番: 白」が思考中表示なしで出る/合法手ヒントがCPU側の手で出続ける(いずれも表示盤面とは整合、従来挙動の窓拡大) |
| 6 | 軽微 | handleMoveのコメント「理論上は起こらない想定」が事実と不一致(#1の根拠。#1修正時に併せて直す) |

## 判定

**合格(done可)。ただし指摘#1は実在バグのため、軽量な追修正タスク(handleMoveガード1〜2行+コメント修正+ラグ窓クリックの回帰テスト1件)の起票を推奨する。** #2〜#6はSTATUS.md申し送りで足りる。

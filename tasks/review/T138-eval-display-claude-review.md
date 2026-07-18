# T138 最終レビュー(評価値表示の新仕様+定石トレース、コミット 21ff0b4)

- レビュアー: Claude(Fable 5、codex-review代替)
- 対象: `21ff0b4`(app: 評価値表示を「損失」から「評価値+定石ブックcap」へ作り替え、定石トレース表示を追加)
- 照合: `tasks/T138-eval-display-semantics.md`(ユーザー仕様1〜6+作業ログの設計判断a〜c)
- 実行した検証: 差分と周辺コード(`app.tsx` / `moveEvalOverlayLogic.ts` / `MoveEvalOverlay.tsx` / `traceDisplay.ts` / `joseki/lookup.ts` / `joseki/buildDb.ts` / 各モードのオーバーレイ利用箇所)の読査、
  `npx vitest run src/components/moveEvalOverlayLogic.test.ts src/joseki/traceDisplay.test.ts src/app.playmode.evalDisplay.test.tsx` → 3ファイル27件全パス。

## 総合判定: 合格(重大指摘なし。中2件は申し送り推奨)

---

## 観点1: ブックcapの意味論(仕様2〜4)

**正しく実装されている。** `applyBookCap` は (a) `bookSquares`空なら同一参照を素通し(仕様4)、(b) 非空ならブック手=無条件0(元がマイナスでも0。仕様3「ブック手は0表示」の字義どおり)、(c) 非ブック手は `Math.min(0, evalScore)`(プラス→0丸め、マイナス→そのまま)。「ブック手が存在する間、表示はすべて0以下」という不変条件が成立する。`computeBoardEvalScore` は `bookSquares`非空→0、空→合法手`discDiff`の最大値、`allMoves`が null/空→null。ユニットテストが全分岐を網羅している。

**[中-2] 仕様2の「ブック内」判定と仕様3の「合法手にブック手あり」判定が単一条件に統合されている(leaf局面でのズレ)。**
実装は両方を「`bookSquares`(=現局面ノードの`bookMoves`を逆正規化した集合)が非空か」で判定する。`buildDb.ts` を確認したところ、定石ラインの終端ノード(leaf)は他ラインが通過しない限り `bookMoves: []` で登録される。したがって **leaf局面では lookup はヒットする(=「現在の進行はブック内」、トレースも「(離脱)」なしのアクティブ表示)のに、capは外れて盤面評価・候補手評価とも素の値が出る**。仕様2の字義(「ブック内にある間は盤面評価0」)とはこの1局面分だけズレる。ただし、ここで盤面だけ0にすると仕様1(盤面=合法手評価の最大値)と矛盾するため、仕様1・4側に寄せた実装は解釈として合理的。事実指摘としては「トレースが『定石内』を示す画面で評価値が非0になる1手分の混在」が起きる点のみ。ユーザー裁定で現状容認か、leaf局面もcap対象にするかを申し送り推奨(挙動変更は1行: lookup非nullなら盤面0)。

なお「現局面がブック外だが合法手の先にブック手がある」ケースは構造上存在しない(bookMovesは現局面ノート由来のため、lookup null ⇔ bookSquares空)。CPU応手選択(`selectCpuBookMove`)と同じDB・同じ正規化(`opForFirstMove`+`denormalizeSquare`)を使っており整合する。

## 観点2: 評価バー統合の副作用

- **(a) CPU思考中の値保持(設計判断c)**: `displayGame.phase !== 'human'` のとき `overlayMoves` のみクリアし `evalBarValue` を保持する。保持される値は「人間の手番開始時の局面評価」であり、人間の着手後〜CPU応手表示までの間、**1手分古い値**が出る(人間が悪手を打った直後もバーは打つ前の評価のまま)。キャプションは視点固定(「黒視点/あなた視点、+なら有利」)で手番に依存しないため、符号の誤読は起きない。「消える」より「残す」を選んだトレードオフとして妥当。**軽微(事実指摘のみ)**。
- **(b) 終局時の実石差表示**: `'over'` 分岐で `countDiscs` の生の石差(空きマスの勝者加算なし)を `perspectiveSide` 変換して表示。旧コードと同一ロジックで、基準が `game`→`displayGame` に変わった分、最終手のアニメーション完了を待ってから確定表示になる(改善方向)。**維持されている**。
- **(c) perspectiveSide変換**: `perspectiveSide = vsHuman ? 'black' : humanSide`、`value = sideToMove === perspectiveSide ? boardScore : -boardScore`。`analyzeAll` の `discDiff` はmover視点なので変換は正しい。作業ログの実機確認(白の+22→黒視点-22)とも一致。**問題なし**。
- 競合対策: エフェクト再実行時の `cancelled` ガードで古い応答の反映は防止されている。`overlayBookSquares` が `'cpu'`/`'over'` でクリアされないが、オーバーレイ自体が null で非描画のため実害なし(軽微未満)。

## 観点3: 定石トレース

- **firstMoveSquareRef依存**: ref記録エフェクト(`app.tsx:492`、`game`監視)はトレースエフェクト(`app.tsx:631`、`displayGame`監視)より宣言順が先で、`game` は `displayGame` より先行して更新されるため、`ply >= 1` でトレースが動く時点では ref は必ず設定済み。`?? notationToSquare('f5')` フォールバックが実際に効くのは初期局面相当のみで、初期局面は4変換の不動点なので安全。盤面エディタ由来の非標準初手は `safeLookupJosekiNode` が例外を握りつぶす。**整合している**。
- **パス時のply(石数-4)**: plyは「置かれた石の数」=パスを除く着手数になる。lookup自体は局面ハッシュベースなので判定は狂わず、ズレるのは「N手目」ラベルのみ。ブック収載の序盤進行でパスは実質発生しないため実害なし。**軽微(事実指摘)**。
- **leaf到達と離脱の同一表示(設計判断a)**: 定石ラインを最後まで完走した場合も、次の一手で lookup が外れた時点で「(離脱)」表示になる。「外れた」の含意があるため、完走ユーザーには誤解の余地がある(観点1の中-2のとおり、leaf局面自体はアクティブ表示なので、「完走→(離脱)」への遷移は1手遅れて起きる)。区別するなら lookup ヒット時に `isLeaf` を保存すれば「(完)」等を出せる。**軽微(改善提案)**。
- `ply <= 0` ガードと `prepareNewGame` での `josekiTrace` リセットにより、前対局の持ち越し・初期局面の全112ライン一致表示は正しく回避されている。

## 観点4: 性能(常時表示化)

- 旧挙動: オーバーレイ既定OFF(`DEFAULT_MOVE_EVAL_OVERLAY_ENABLED = false`)・評価バーも既定OFFで、既定ユーザーは人間手番の analyzeAll も requestAnalyze も走らなかった。新挙動では**人間手番(2人対戦は毎手)ごとに `LEVELS[level].limit` の analyzeAll が必ず走る**。
- コスト評価: 使われるlimitはそのレベル自身のもの(弱=depth4/exact8でごく軽い、普通=depth8、強=depth12/exact16)。「弱設定でもstrong相当のlimitで走る」ことは**ない**(strongのlimitはstrong選択時のみ)。ただし strong の `limit` は `cpuLimit` と違い maxNodes/timeMs の上限が無く、空き16以下では毎手番・全合法手のルート直接exactが走る(旧オーバーレイON時と同コスト。空き16のexactは高速なので実用上許容範囲)。
- エンジン競合: Workerは単一・リクエスト直列で**中断(abort)機構は無い**(`cancelled` は結果を捨てるだけ)。人間が即着手すると、実行中の analyzeAll の後ろに CPU 着手探索が並ぶため、CPUの応答が最大で analyzeAll 1回分遅れる。また `evaluateHumanMove`(悪手判定)が着手時に**同一局面・同一limitの analyzeAll をもう1回**発行する構造だが、共有TTによりほぼ即時に返るはず。既定ONは仕様5(ユーザー指示)の帰結であり、**許容と判断。強設定のモバイル体感は申し送りで観測推奨(軽微)**。
- 細部: エフェクト依存に `josekiDb` が含まれるため、DBロード完了時に analyzeAll が1回再発行される+ロード完了前の初手表示は一瞬cap未適用(素の±ノイズ値)になり得る。自動的に0表示へ修正されるため**軽微**。

## 観点5: 他モードへの波及

- `settings/moveEvalOverlaySettings.ts` / `evalBarSettings.ts` は残置され、定石練習・中盤練習・詰めオセロ・棋譜解析(BlunderPanel)の各トグルと `openingBookSettings.ts` の `StorageLike` 再利用は無傷。**トグル機構の破壊なし**。
- **[中-1] 共有コンポーネント `MoveEvalOverlay` の表示意味論変更が、スコープ外4モードに波及している。** `CellEval.lossDiscs`→`evalScore`、`formatLoss`(±0/-N のロス表示)→`formatEvalScore`(+N/-N のmover視点評価値)への変更はコンポーネント本体で行われているため、`joseki/PracticeMode` / `midgame/PracticeMode` / `tsume/PlayMode` / `analysis/BlunderPanel` のオーバーレイ数値も「ロス」から「評価値」に変わった(capは`bookSquares`既定空集合のため適用されず、その点は正しい)。タスクの「やらないこと」に「定石練習モード・解析モードの表示変更」と明記されており、**宣言なきスコープ逸脱**。機能破壊ではなく色分類・トグル・判定ロジック(`judgeMove`/`judgeMidgameMove`/`isBlunder` はいずれも独自にロスを計算しており無影響)は保たれるが、各モードの周辺文言(「ロスN石でした」等)はロス基準のまま残っており、オーバーレイ数値との語彙の不一致が生じる。表示の統一として容認するか、他モードをロス表示に戻すかのユーザー/オーケストレーター裁定を申し送り推奨。

## その他(軽微)

- ブック内では数値が全手0でも色分類はcap前の生ロスで付く(設計判断b)。「0なのに色が悪手」という見え方はするが、分類を保つ判断は合理的。事実指摘のみ。
- `formatEvalScore` の `Math.round` はJS仕様どおり負の .5 で0方向(-1.5→-1、+1.5→+2)。厳密な四捨五入対称ではないが表示上無視できる。
- 統合テスト(`app.playmode.evalDisplay.test.tsx`)は2人対戦でチェック撤去・cap・トレース離脱・バー=最大値一致を検証しており、受け入れ基準の主要分岐を実質カバーしている。

## 指摘まとめ

| 区分 | 件名 | 対応 |
|---|---|---|
| 重大 | なし | — |
| 中-1 | 共有MoveEvalOverlay変更によるスコープ外4モードの数値意味論変更(ロス→評価値) | 申し送り(容認 or 追タスクで裁定) |
| 中-2 | leaf局面で「ブック内(トレース表示)なのにcap外」となる仕様2の解釈ズレ | 申し送り(容認 or leafもcap対象化) |
| 軽微 | CPU思考中のバー1手遅れ保持(判断c)/leaf完走も「(離脱)」(判断a)/ply=石数-4のパス非考慮/DBロード前の一瞬の素値表示+再発行1回/強設定の常時analyzeAll負荷とCPU応答直列遅延/負の.5丸め非対称 | 記録のみ |

以上より、ユーザー仕様1〜6は対局モードにおいて正しく実装されており(仕様2のleaf解釈のみ裁定余地)、重大な欠陥は見つからなかった。**合格**。
